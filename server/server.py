#!/usr/bin/env python3
"""Local server for the Escuta extension.

POST /transcribe   raw audio body  -> {"text", "language"}   (Whisper via MLX)
POST /summarize    {"text", ...}   -> {"summary"}            (Ollama)
GET  /health                       -> engine status

Binds to 127.0.0.1 only and rejects browser requests that do not come from an
extension, so other web pages cannot reach it.
"""
import importlib.util
import json
import os
import tempfile
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HOST = "127.0.0.1"
PORT = int(os.environ.get("ESCUTA_PORT", "8765"))
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
DEFAULT_WHISPER = "mlx-community/whisper-large-v3-turbo"
DEFAULT_OLLAMA = "qwen2.5:7b"
# When GEMINI_API_KEY is set, summaries go to Gemini (cloud). Otherwise they use Ollama (local).
GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-flash-lite-latest")
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
MAX_BODY = 50 * 1024 * 1024

# One Whisper job at a time: the model is big and MLX shares the GPU.
whisper_lock = threading.Lock()

SUMMARY_PROMPT = (
    "Você resume mensagens de voz transcritas do WhatsApp. "
    "Responda em português do Brasil, em 1 a 3 frases curtas. "
    "Mantenha nomes, números, datas, horários e pedidos exatamente como ditos. "
    "Se houver algo a fazer, diga o que é. Não invente nada que não esteja no texto. "
    "Responda só com o resumo."
)


class ApiError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def whisper_available():
    return importlib.util.find_spec("mlx_whisper") is not None


def ollama_models():
    try:
        with urllib.request.urlopen(f"{OLLAMA_URL}/api/tags", timeout=1.5) as res:
            return [m["name"] for m in json.load(res).get("models", [])]
    except (urllib.error.URLError, TimeoutError, ValueError, OSError):
        return None


def transcribe(audio, model, language):
    if not whisper_available():
        raise ApiError(503, "whisper_missing", "mlx-whisper não está instalado. Rode ./setup.sh.")
    import mlx_whisper

    with tempfile.NamedTemporaryFile(suffix=".ogg") as tmp:
        tmp.write(audio)
        tmp.flush()
        with whisper_lock:
            try:
                result = mlx_whisper.transcribe(
                    tmp.name,
                    path_or_hf_repo=model,
                    language=None if language == "auto" else language,
                )
            except FileNotFoundError as exc:
                raise ApiError(500, "ffmpeg_missing", "ffmpeg não encontrado. Rode: brew install ffmpeg") from exc
    return {"text": result["text"].strip(), "language": result.get("language")}


def summarize(text, model):
    body = json.dumps(
        {
            "model": model,
            "stream": False,
            "options": {"temperature": 0.2},
            "messages": [
                {"role": "system", "content": SUMMARY_PROMPT},
                {"role": "user", "content": text},
            ],
        }
    ).encode()
    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/chat", data=body, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as res:
            return json.load(res)["message"]["content"].strip()
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise ApiError(404, "ollama_model_missing", f"Modelo {model} não baixado. Rode: ollama pull {model}") from exc
        raise ApiError(502, "ollama_error", f"Ollama respondeu {exc.code}.") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ApiError(503, "ollama_offline", "Ollama não está rodando. Abra o app Ollama.") from exc


def summarize_gemini(text):
    body = json.dumps(
        {
            "systemInstruction": {"parts": [{"text": SUMMARY_PROMPT}]},
            "contents": [{"role": "user", "parts": [{"text": text}]}],
            "generationConfig": {"temperature": 0.2},
        }
    ).encode()
    req = urllib.request.Request(
        GEMINI_URL.format(model=GEMINI_MODEL),
        data=body,
        headers={"Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            parts = json.load(res)["candidates"][0]["content"]["parts"]
            return "".join(p.get("text", "") for p in parts).strip()
    except urllib.error.HTTPError as exc:
        if exc.code in (400, 401, 403):
            raise ApiError(502, "gemini_key_invalid", "Chave do Gemini recusada. Confira GEMINI_API_KEY.") from exc
        if exc.code == 429:
            raise ApiError(429, "gemini_quota", "Limite do Gemini atingido. Tente em instantes.") from exc
        raise ApiError(502, "gemini_error", f"Gemini respondeu {exc.code}.") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ApiError(503, "gemini_offline", "Sem conexão com o Gemini.") from exc
    except (KeyError, IndexError) as exc:
        raise ApiError(502, "gemini_empty", "Gemini não devolveu resumo.") from exc


class Handler(BaseHTTPRequestHandler):
    server_version = "Escuta/1.0"

    def log_message(self, fmt, *args):
        print(f"[escuta] {self.address_string()} {fmt % args}", flush=True)

    # -- helpers ---------------------------------------------------------
    def _origin_ok(self):
        origin = self.headers.get("Origin")
        return origin is None or origin.startswith(("chrome-extension://", "moz-extension://"))

    def _send(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        origin = self.headers.get("Origin")
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            raise ApiError(400, "empty_body", "Corpo vazio.")
        if length > MAX_BODY:
            raise ApiError(413, "too_large", "Áudio maior que 50 MB.")
        return self.rfile.read(length)

    def _guard(self, fn):
        if not self._origin_ok():
            return self._send(403, {"code": "forbidden", "message": "Origem não permitida."})
        try:
            self._send(200, fn())
        except ApiError as err:
            self._send(err.status, {"code": err.code, "message": err.message})
        except Exception as exc:  # keep the server alive on unexpected failures
            self._send(500, {"code": "internal", "message": str(exc)})

    # -- routes ----------------------------------------------------------
    def do_OPTIONS(self):
        self.send_response(204)
        origin = self.headers.get("Origin")
        if origin and self._origin_ok():
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()

    def do_GET(self):
        if urlparse(self.path).path != "/health":
            return self._send(404, {"code": "not_found", "message": "Rota não existe."})

        def health():
            models = ollama_models()
            return {
                "whisper": whisper_available(),
                "ollama": models is not None,
                "ollamaModels": models or [],
                "gemini": bool(GEMINI_KEY),
            }

        self._guard(health)

    def do_POST(self):
        url = urlparse(self.path)
        if url.path == "/transcribe":
            query = parse_qs(url.query)
            model = query.get("model", [DEFAULT_WHISPER])[0]
            language = query.get("language", ["pt"])[0]
            self._guard(lambda: transcribe(self._read_body(), model, language))
        elif url.path == "/summarize":

            def run():
                try:
                    payload = json.loads(self._read_body())
                except ValueError as exc:
                    raise ApiError(400, "bad_json", "JSON inválido.") from exc
                text = (payload.get("text") or "").strip()
                if not text:
                    raise ApiError(400, "empty_text", "Nada para resumir.")
                if GEMINI_KEY:
                    return {"summary": summarize_gemini(text)}
                return {"summary": summarize(text, payload.get("model") or DEFAULT_OLLAMA)}

            self._guard(run)
        else:
            self._send(404, {"code": "not_found", "message": "Rota não existe."})


if __name__ == "__main__":
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[escuta] ouvindo em http://{HOST}:{PORT}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[escuta] encerrado", flush=True)
