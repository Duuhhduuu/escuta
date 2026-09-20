#!/usr/bin/env python3
"""Local server for the Escuta extension.

POST /transcribe   raw audio body  -> {"text", "language"}   (Whisper)
POST /summarize    {"text", ...}   -> {"summary"}            (Ollama or Gemini)
GET  /health                       -> engine status

Transcription runs on mlx-whisper (Apple Silicon) or faster-whisper (Windows,
Linux, CPU/CUDA), whichever is installed. Binds to 127.0.0.1 only and rejects
browser requests that do not come from an extension.
"""
import importlib.util
import json
import os
import secrets
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))

if sys.stdout is None:  # pythonw.exe: sem console, o log vai para disco
    _log = os.path.join(HERE, "escuta.log")
    # ponytail: recomeça o arquivo em 1 MB. Rotação de verdade só se isso incomodar.
    _mode = "w" if os.path.exists(_log) and os.path.getsize(_log) > 1_000_000 else "a"
    sys.stdout = sys.stderr = open(_log, _mode, encoding="utf-8", buffering=1)


def load_env():
    """Read server/.env here so the server works however it was launched."""
    try:
        with open(os.path.join(HERE, ".env"), encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                # setdefault: a real environment variable always wins over the file.
                os.environ.setdefault(key.strip(), value.strip().strip("\"'"))
    except OSError:
        pass


load_env()

HOST = "127.0.0.1"
PORT = int(os.environ.get("ESCUTA_PORT", "8765"))
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
DEFAULT_WHISPER = "large-v3-turbo"
CPU_MODEL = "small"  # sugerido quando não há GPU; ver recommended_model()
DEFAULT_OLLAMA = "qwen2.5:7b"
# When GEMINI_API_KEY is set, summaries go to Gemini (cloud). Otherwise they use Ollama (local).
GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-flash-lite-latest")
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
# Optional shared secret. When set, every request must carry it in X-Escuta-Token,
# so other local processes cannot use the server. Same value in the popup.
TOKEN = os.environ.get("ESCUTA_TOKEN", "").strip()
MAX_BODY = 50 * 1024 * 1024
BATCH_SIZE = int(os.environ.get("ESCUTA_BATCH", "16"))  # VRAM vs speed; 16 fits comfortably in 8 GB

# mlx repo names are not uniform, so they are listed instead of built from the model name.
MLX_REPOS = {
    "large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
    "large-v3-turbo-q4": "mlx-community/whisper-large-v3-turbo-q4",
    "small": "mlx-community/whisper-small-mlx",
    "large-v3": "mlx-community/whisper-large-v3-mlx",
}

SETUP_HINT = "Rode setup.ps1 (Windows) ou ./setup.sh (Mac/Linux) na pasta server."

# One Whisper job at a time: the model is big and shares the GPU.
whisper_lock = threading.Lock()
_faster_models = {}  # (name, device, compute) -> WhisperModel, loading it costs seconds
_cuda_broken = False  # set once CUDA fails at runtime, so we stop paying for the retry

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


def installed(name):
    return importlib.util.find_spec(name) is not None


def whisper_engine():
    """Which backend this machine can use, or None when nothing is installed."""
    if installed("mlx_whisper"):
        return "mlx"
    if installed("faster_whisper"):
        return "faster"
    return None


def cuda_available():
    if _cuda_broken:
        return False
    try:
        import ctranslate2

        return ctranslate2.get_cuda_device_count() > 0
    except Exception:
        return False


def engine_label():
    engine = whisper_engine()
    if engine == "mlx":
        return "mlx-whisper"
    if engine == "faster":
        # O device real, não só o que a placa permitiria: ESCUTA_DEVICE pode forçar CPU.
        return f"faster-whisper · {'CUDA' if faster_device()[1] == 'cuda' else 'CPU'}"
    return ""


def recommended_model():
    """Sem GPU, o turbo roda a ~2x tempo real e o small a ~6x. Vale a troca."""
    if whisper_engine() == "faster" and faster_device()[1] == "cpu":
        return CPU_MODEL
    return DEFAULT_WHISPER


def canonical_model(name):
    """Accept plain names and old mlx repo ids alike: 'large-v3-turbo'."""
    name = (name or DEFAULT_WHISPER).strip()
    if name.startswith("mlx-community/whisper-"):
        name = name[len("mlx-community/whisper-") :]
    if name.endswith("-mlx"):
        name = name[: -len("-mlx")]
    return name or DEFAULT_WHISPER


def transcribe_mlx(path, model, language):
    import mlx_whisper

    result = mlx_whisper.transcribe(
        path,
        path_or_hf_repo=MLX_REPOS.get(model, model),
        language=language,
        # Cada trecho decodifica sozinho. Evita o efeito bola de neve em que um
        # trecho ruim arrasta os seguintes, que é lento e ainda inventa texto.
        # É o mesmo que o caminho em lote do faster-whisper já faz no Windows.
        condition_on_previous_text=False,
    )
    return result["text"].strip(), result.get("language")


_dll_dirs = []  # add_dll_directory undoes itself when the handle is collected: keep them alive


def add_nvidia_dll_dirs():
    """On Windows the cuBLAS/cuDNN DLLs ship inside the pip packages, not on PATH."""
    if os.name != "nt":
        return
    import pathlib
    import site

    roots = [*site.getsitepackages(), os.path.join(sys.prefix, "Lib", "site-packages")]
    found = []
    for base in dict.fromkeys(roots):
        for sub in pathlib.Path(base).glob("nvidia/*/bin"):
            found.append(str(sub))
            try:
                _dll_dirs.append(os.add_dll_directory(str(sub)))
            except OSError:
                pass
    # add_dll_directory alone does not cover libraries that ctranslate2 loads lazily
    # at compute time, so PATH gets them too. That is the one the loader always reads.
    if not found:
        print("[escuta] sem bibliotecas CUDA instaladas; a transcrição vai usar a CPU.", flush=True)
        return
    os.environ["PATH"] = os.pathsep.join([*found, os.environ.get("PATH", "")])

    import ctypes

    for dll in ("cublas64_12.dll", "cudnn64_9.dll"):
        try:
            ctypes.WinDLL(dll)
        except OSError:
            print(f"[escuta] AVISO: {dll} não carrega; a transcrição vai usar a CPU.", flush=True)
            return
    print(f"[escuta] CUDA pronto ({len(found)} pasta(s) de DLL).", flush=True)


def load_faster(model, device, compute):
    from faster_whisper import WhisperModel

    key = (model, device, compute)
    if key not in _faster_models:
        _faster_models.clear()  # ponytail: one model resident at a time, plenty for one user
        extra = {"cpu_threads": os.cpu_count() or 4} if device == "cpu" else {}
        whisper = WhisperModel(model, device=device, compute_type=compute, **extra)
        try:
            from faster_whisper import BatchedInferencePipeline

            # ~4x faster than the sequential path on a GPU, same text. Needs faster-whisper 1.1+.
            _faster_models[key] = (BatchedInferencePipeline(model=whisper), True)
        except ImportError:
            _faster_models[key] = (whisper, False)
    return _faster_models[key]


def faster_device():
    forced = os.environ.get("ESCUTA_DEVICE")
    device = forced or ("cuda" if (not _cuda_broken and cuda_available()) else "cpu")
    compute = os.environ.get("ESCUTA_COMPUTE") or ("float16" if device == "cuda" else "int8")
    return forced, device, compute


def run_faster(loaded, path, language):
    engine, batched = loaded
    if batched:
        segments, info = engine.transcribe(path, language=language, batch_size=BATCH_SIZE)
    else:
        segments, info = engine.transcribe(path, language=language, vad_filter=True)
    # The generator must be drained here: that is where the GPU work actually happens.
    return "".join(seg.text for seg in segments).strip(), info.language


def transcribe_faster(path, model, language):
    global _cuda_broken
    for suffix in ("-q4", "-4bit", "-8bit", "-fp16"):  # quantizações que só existem no mlx
        model = model.removesuffix(suffix)
    forced, device, compute = faster_device()
    try:
        return run_faster(load_faster(model, device, compute), path, language)
    except Exception as exc:
        # A CUDA driver can be visible while cuBLAS/cuDNN are missing, and that only
        # surfaces once the model computes. Redo it on the CPU instead of failing.
        if device != "cuda" or forced:
            raise
        print(f"[escuta] CUDA falhou ({exc}); refazendo na CPU.", flush=True)
        _cuda_broken = True
        _faster_models.clear()
        return run_faster(load_faster(model, "cpu", "int8"), path, language)


def preload():
    """Pay the model load at boot, not on the first voice note."""
    engine = whisper_engine()
    if engine is None or os.environ.get("ESCUTA_PRELOAD") == "0":
        return
    try:
        start = time.monotonic()
        if engine == "faster":
            _, device, compute = faster_device()
            load_faster(DEFAULT_WHISPER, device, compute)
            where = device
        else:
            import mlx.core as mx
            from mlx_whisper.transcribe import ModelHolder

            ModelHolder.get_model(MLX_REPOS[DEFAULT_WHISPER], mx.float16)
            where = "mlx"
        print(f"[escuta] modelo {DEFAULT_WHISPER} pronto em {time.monotonic() - start:.1f}s ({where}).", flush=True)
    except Exception as exc:
        print(f"[escuta] modelo não pré-carregado ({exc}); será carregado na primeira transcrição.", flush=True)


def transcribe(audio, model, language):
    engine = whisper_engine()
    if engine is None:
        raise ApiError(503, "whisper_missing", f"Whisper não está instalado. {SETUP_HINT}")
    model = canonical_model(model)
    language = None if language == "auto" else language

    start = time.monotonic()
    # delete=False + unlink: Windows cannot reopen a NamedTemporaryFile by path while it is open.
    tmp = tempfile.NamedTemporaryFile(suffix=".ogg", delete=False)
    try:
        tmp.write(audio)
        tmp.close()
        with whisper_lock:
            try:
                if engine == "mlx":
                    text, lang = transcribe_mlx(tmp.name, model, language)
                else:
                    text, lang = transcribe_faster(tmp.name, model, language)
            except FileNotFoundError as exc:
                raise ApiError(500, "ffmpeg_missing", "ffmpeg não encontrado. Instale o ffmpeg e tente de novo.") from exc
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
    print(f"[escuta] transcrito em {time.monotonic() - start:.1f}s ({len(text)} caracteres).", flush=True)
    return {"text": text, "language": lang}


def ollama_models():
    try:
        with urllib.request.urlopen(f"{OLLAMA_URL}/api/tags", timeout=1.5) as res:
            return [m["name"] for m in json.load(res).get("models", [])]
    except (urllib.error.URLError, TimeoutError, ValueError, OSError):
        return None


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
    server_version = "Escuta/1.1"

    def log_message(self, fmt, *args):
        print(f"[escuta] {self.address_string()} {fmt % args}", flush=True)

    # -- helpers ---------------------------------------------------------
    def _origin_ok(self):
        origin = self.headers.get("Origin")
        return origin is None or origin.startswith(("chrome-extension://", "moz-extension://"))

    def _token_ok(self):
        if not TOKEN:
            return True
        return secrets.compare_digest(self.headers.get("X-Escuta-Token") or "", TOKEN)

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
        if not self._token_ok():
            return self._send(403, {"code": "bad_token", "message": "Token do servidor não confere."})
        try:
            self._send(200, fn())
        except ApiError as err:
            self._send(err.status, {"code": err.code, "message": err.message})
        except ConnectionError:
            pass  # o cliente desistiu antes da resposta; não há para onde responder
        except Exception as exc:  # keep the server alive on unexpected failures
            try:
                self._send(500, {"code": "internal", "message": str(exc)})
            except ConnectionError:
                pass

    # -- routes ----------------------------------------------------------
    def do_OPTIONS(self):
        self.send_response(204)
        origin = self.headers.get("Origin")
        if origin and self._origin_ok():
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Escuta-Token")
            # Private Network Access (old name) and Local Network Access (Chrome's replacement).
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Allow-Local-Network-Access", "true")
        self.end_headers()

    def do_GET(self):
        if urlparse(self.path).path != "/health":
            return self._send(404, {"code": "not_found", "message": "Rota não existe."})

        def health():
            models = ollama_models()
            return {
                "whisper": whisper_engine() is not None,
                "whisperEngine": engine_label(),
                "recommendedModel": recommended_model(),
                "ollama": models is not None,
                "ollamaModels": models or [],
                "gemini": bool(GEMINI_KEY),
                "geminiModel": GEMINI_MODEL if GEMINI_KEY else "",
                "token": bool(TOKEN),
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


def selfcheck():
    assert canonical_model("mlx-community/whisper-large-v3-turbo") == "large-v3-turbo"
    assert canonical_model("mlx-community/whisper-small-mlx") == "small"
    assert canonical_model("mlx-community/whisper-large-v3-mlx") == "large-v3"
    assert canonical_model("large-v3-turbo") == "large-v3-turbo"
    assert canonical_model("") == DEFAULT_WHISPER
    assert canonical_model(None) == DEFAULT_WHISPER
    assert canonical_model("mlx-community/whisper-large-v3-turbo-q4") == "large-v3-turbo-q4"
    assert recommended_model() in (DEFAULT_WHISPER, CPU_MODEL)
    assert "large-v3-turbo-q4".removesuffix("-q4") == "large-v3-turbo"
    assert MLX_REPOS["small"] == "mlx-community/whisper-small-mlx"
    print("ok")


class Server(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        # Um cliente que fecha a conexão no meio é rotina (aba fechada, timeout).
        # Sem isso, cada um desses despeja um traceback inteiro no log.
        exc = sys.exception()
        if isinstance(exc, (ConnectionError, TimeoutError)):
            print(f"[escuta] cliente desconectou: {type(exc).__name__}", flush=True)
            return
        super().handle_error(request, client_address)


if __name__ == "__main__":
    add_nvidia_dll_dirs()
    if "--selfcheck" in sys.argv:
        selfcheck()
        raise SystemExit(0)
    threading.Thread(target=preload, daemon=True).start()
    httpd = Server((HOST, PORT), Handler)
    summarizer = f"gemini ({GEMINI_MODEL})" if GEMINI_KEY else "ollama"
    print(
        f"[escuta] ouvindo em http://{HOST}:{PORT} · whisper: {engine_label() or 'não instalado'}"
        f" · resumo: {summarizer} · token: {'sim' if TOKEN else 'não'}",
        flush=True,
    )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[escuta] encerrado", flush=True)
