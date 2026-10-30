#!/usr/bin/env python3
"""Local server for the Escuta extension.

POST /transcribe   raw audio body  -> {"text", "language", "duration"}   (Whisper)
     ?stream=1                     -> NDJSON, one {"segment"} per chunk, then {"done", ...}
POST /summarize    {"text", ...}   -> {"summary"}            (Ollama or Gemini)
POST /live         PCM 16 kHz mono -> {"segments"}   (janela curta, para a transcrição ao vivo)
POST /meeting      stereo audio    -> NDJSON, {"stage"} e no fim {"done", "segments"}
                                      (esquerda = você, direita = os outros)
POST /minutes      {"segments" ou "transcript", "template", "goal"} -> {"minutes"}   (ata em Markdown)
POST /ask          {"question", "segments", "minutes", "history"} -> {"answer"}   (pergunta sobre uma reunião)
GET  /templates                    -> modelos de ata
GET  /health                       -> engine status

Transcription runs on mlx-whisper (Apple Silicon) or faster-whisper (Windows,
Linux, CPU/CUDA), whichever is installed. Binds to 127.0.0.1 only and rejects
browser requests that do not come from an extension.
"""
import importlib.util
import json
import os
import re
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)  # `import meeting` tem que achar o vizinho mesmo com o servidor iniciado de outra pasta
import meeting  # noqa: E402

# pythonw.exe (Windows) não tem console; o launchd (Mac) pede ESCUTA_LOG=1. Nos dois o log vai para disco.
if sys.stdout is None or os.environ.get("ESCUTA_LOG") == "1":
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
MAX_LIVE = 8 * 1024 * 1024  # uma janela de 15 s a 16 kHz em 16 bits tem 480 KB; isto é folga
MAX_MEETING = 400 * 1024 * 1024  # ~64 kbps estéreo dá uns 30 MB por hora; isso cobre reunião de várias horas
SILENT_RMS = 1e-4  # canal sem nada (microfone negado): nem passa pelo Whisper, que inventaria texto
BATCH_SIZE = int(os.environ.get("ESCUTA_BATCH", "16"))  # VRAM vs speed; 16 fits comfortably in 8 GB
# Até aqui (segundos) o áudio vai no modo sequencial: num recado real de 1:18 foi o
# único que pegou uma pergunta de 1 s no começo, e custa só uns 2 s a mais. O lote
# fica para os longos, onde ele é 4x mais rápido. 0 desliga.
SEQUENTIAL_S = float(os.environ.get("ESCUTA_SEQUENCIAL", "90"))

# mlx repo names are not uniform, so they are listed instead of built from the model name.
MLX_REPOS = {
    "large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
    "large-v3-turbo-q4": "mlx-community/whisper-large-v3-turbo-q4",
    "small": "mlx-community/whisper-small-mlx",
    "large-v3": "mlx-community/whisper-large-v3-mlx",
}

SETUP_HINT = "Rode setup.bat (Windows) ou ./setup.sh (Mac/Linux) na pasta server."

# One Whisper job at a time, always on the same thread: the model is big and shares
# the GPU, and mlx 0.30+ ties its streams to the thread that created them. A model
# loaded on one thread fails on another with "There is no Stream(gpu, N)".
whisper_worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="whisper")
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


MLX_LINE = re.compile(r"^\[[\d:.]+ --> [\d:.]+\] (.*)$", re.S)


def transcribe_mlx(path, model, language, on_segment=None, collect=None):
    import mlx_whisper

    # mlx-whisper só devolve o texto no fim. Com verbose=True ele imprime cada
    # trecho assim que decodifica, então um print próprio no módulo dele vira o
    # aviso de progresso. Se o formato mudar numa versão nova, só o texto parcial
    # some; o resultado final continua vindo.
    module = sys.modules["mlx_whisper.transcribe"]
    if on_segment:
        def hook(*args, **_):
            match = MLX_LINE.match(" ".join(map(str, args)))
            if match and match.group(1).strip():
                on_segment(match.group(1))

        module.print = hook
    try:
        result = mlx_whisper.transcribe(
            path,
            path_or_hf_repo=MLX_REPOS.get(model, model),
            language=language,
            # Cada trecho decodifica sozinho. Evita o efeito bola de neve em que um
            # trecho ruim arrasta os seguintes, que é lento e ainda inventa texto.
            # É o mesmo que o caminho em lote do faster-whisper já faz no Windows.
            condition_on_previous_text=False,
            verbose=True if on_segment else None,
        )
    finally:
        module.__dict__.pop("print", None)
    segments = result.get("segments") or []
    if collect is not None:
        collect.extend({"start": round(s["start"], 2), "end": round(s["end"], 2), "text": s["text"]} for s in segments)
    duration = segments[-1]["end"] if segments else 0.0
    return result["text"].strip(), result.get("language"), duration


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


# O lote sem marcação de tempo às vezes desiste no começo de um pedaço de 30 s e
# devolve uma palavra para 20 s de fala: num áudio real, 56-78 s viraram "Monotur.".
# Com marcação de tempo e o VAD menos rígido o texto volta inteiro, quase no mesmo tempo.
BATCH_VAD = {"threshold": 0.35, "min_silence_duration_ms": 500, "speech_pad_ms": 400}


def gave_up(segments):
    """Trecho longo com quase nenhum texto: fala normal fica perto de 0,06 s por caractere."""
    return any(
        seg.end - seg.start >= 8 and (seg.end - seg.start) / max(len(seg.text.strip()), 1) > 0.5
        for seg in segments
    )


def run_faster(loaded, path, language, on_segment=None, collect=None):
    from faster_whisper import decode_audio

    engine, batched = loaded
    # Decodifica uma vez só: a duração escolhe o modo, e os dois aceitam o array pronto.
    # Reunião já chega decodificada (um canal por vez); mensagem de voz chega como arquivo.
    audio = decode_audio(path) if isinstance(path, str) else path
    if batched and len(audio) / 16000 > SEQUENTIAL_S:
        segments, info = engine.transcribe(
            audio,
            language=language,
            batch_size=BATCH_SIZE,
            without_timestamps=False,
            vad_parameters=BATCH_VAD,
        )
        # O lote só entrega quando o lote inteiro termina (16 pedaços de 30 s), então
        # segurar os trechos para conferir antes de mandar não atrasa o texto parcial.
        segments = list(segments)
        if gave_up(segments):
            print("[escuta] lote perdeu um trecho; refazendo no modo sequencial.", flush=True)
            segments, info = engine.model.transcribe(
                audio, language=language, vad_filter=True, condition_on_previous_text=False
            )
    else:
        # Áudio curto, ou faster-whisper antigo sem lote: sequencial, trecho a trecho.
        whisper = engine.model if batched else engine
        segments, info = whisper.transcribe(audio, language=language, vad_filter=True)
    # The generator must be drained here: that is where the GPU work actually happens.
    parts = []
    for seg in segments:
        parts.append(seg.text)
        if collect is not None:
            collect.append({"start": round(seg.start, 2), "end": round(seg.end, 2), "text": seg.text})
        if on_segment and seg.text.strip():
            on_segment(seg.text)
    return "".join(parts).strip(), info.language, info.duration


def transcribe_faster(path, model, language, on_segment=None, collect=None):
    global _cuda_broken
    for suffix in ("-q4", "-4bit", "-8bit", "-fp16"):  # quantizações que só existem no mlx
        model = model.removesuffix(suffix)
    forced, device, compute = faster_device()
    try:
        return run_faster(load_faster(model, device, compute), path, language, on_segment, collect)
    except ConnectionError:
        raise  # o cliente fechou o streaming; não é defeito da CUDA
    except Exception as exc:
        # A CUDA driver can be visible while cuBLAS/cuDNN are missing, and that only
        # surfaces once the model computes. Redo it on the CPU instead of failing.
        if device != "cuda" or forced:
            raise
        print(f"[escuta] CUDA falhou ({exc}); refazendo na CPU.", flush=True)
        _cuda_broken = True
        _faster_models.clear()
        if collect is not None:
            collect.clear()
        return run_faster(load_faster(model, "cpu", "int8"), path, language, on_segment, collect)


def preload():
    """Pay the model load at boot, not on the first voice note."""
    engine = whisper_engine()
    if engine is None or os.environ.get("ESCUTA_PRELOAD") == "0":
        return
    try:
        start = time.monotonic()
        if engine == "faster":
            # Sem GPU a extensão pede o Small; carregar o Turbo aqui só seria
            # descartado na primeira transcrição.
            model = recommended_model()
            _, device, compute = faster_device()
            load_faster(model, device, compute)
            where = device
        else:
            import mlx_whisper
            import numpy as np

            # Um segundo de silêncio carrega o modelo e compila os kernels do Metal,
            # que senão custam ~0,3s no primeiro áudio de verdade.
            mlx_whisper.transcribe(
                np.zeros(16000, np.float32), path_or_hf_repo=MLX_REPOS[DEFAULT_WHISPER], language="pt"
            )
            where = "mlx"
        print(f"[escuta] modelo {model if engine == 'faster' else DEFAULT_WHISPER} pronto em {time.monotonic() - start:.1f}s ({where}).", flush=True)
    except Exception as exc:
        print(f"[escuta] modelo não pré-carregado ({exc}); será carregado na primeira transcrição.", flush=True)


def transcribe(audio, model, language, on_segment=None):
    """on_segment(text) recebe cada trecho assim que sai; é chamado na thread do Whisper."""
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
        run = transcribe_mlx if engine == "mlx" else transcribe_faster
        try:
            text, lang, duration = whisper_worker.submit(run, tmp.name, model, language, on_segment).result()
        except FileNotFoundError as exc:
            raise ApiError(500, "ffmpeg_missing", "ffmpeg não encontrado. Instale o ffmpeg e tente de novo.") from exc
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
    print(f"[escuta] transcrito em {time.monotonic() - start:.1f}s ({len(text)} caracteres).", flush=True)
    return {"text": text, "language": lang, "duration": round(duration or 0, 1)}


def split_channels(path):
    """(esquerda, direita) a 16 kHz, float32. Um arquivo mono vira dois canais iguais."""
    try:
        from faster_whisper import decode_audio

        return decode_audio(path, split_stereo=True)
    except ImportError:  # Mac com mlx: sem PyAV, usa o ffmpeg que o mlx-whisper já exige
        import numpy as np

        raw = subprocess.run(
            ["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-ac", "2", "-ar", "16000", "-"],
            capture_output=True,
            check=True,
        ).stdout
        both = np.frombuffer(raw, np.float32)
        return both[0::2], both[1::2]


def boost(samples):
    """Sobe o volume da voz baixa (quem fala longe do microfone, ou a voz que chega pela chamada)."""
    import numpy as np

    if not len(samples):
        return samples
    gain = meeting.speech_gain(float(np.sqrt(np.mean(np.square(samples)))), float(np.max(np.abs(samples))))
    return samples * np.float32(gain) if gain != 1.0 else samples


def transcribe_live(pcm, model, language, prompt):
    """Uma janela curta (PCM de 16 bits, 16 kHz, mono) vira trechos com horário relativo à janela.
    É o que alimenta a transcrição ao vivo: rápido e sem a conferência que a gravação inteira recebe."""
    engine = whisper_engine()
    if engine is None:
        raise ApiError(503, "whisper_missing", f"Whisper não está instalado. {SETUP_HINT}")
    import numpy as np

    samples = np.frombuffer(pcm[: len(pcm) // 2 * 2], dtype="<i2").astype(np.float32) / 32768.0
    if not len(samples):
        return []
    model = canonical_model(model)
    language = None if language == "auto" else language
    samples = boost(samples)
    prompt = meeting.prompt_tail(prompt) or None  # o fim da fala anterior (sem murmúrios): ajuda nomes e a pontuação a continuar

    def job():
        global _cuda_broken
        if engine == "mlx":
            import mlx_whisper

            out = mlx_whisper.transcribe(
                samples,
                path_or_hf_repo=MLX_REPOS.get(model, model),
                language=language,
                condition_on_previous_text=False,
                initial_prompt=prompt,
                temperature=0.0,
            )
            return [
                {"start": s["start"], "end": s["end"], "text": s["text"], "no_speech": s.get("no_speech_prob", 0), "logprob": s.get("avg_logprob", 0)}
                for s in out.get("segments") or []
            ]

        name = model
        for suffix in ("-q4", "-4bit", "-8bit", "-fp16"):
            name = name.removesuffix(suffix)

        def run(device, compute):
            loaded = load_faster(name, device, compute)
            whisper = loaded[0].model if loaded[1] else loaded[0]  # janela curta: o modo sequencial, sem lote
            # Prévia: sem busca em feixe nem repetição com temperatura maior, que é o que atrasa. A gravação
            # inteira, que é a que vale, continua com o decodificador completo.
            segments, _ = whisper.transcribe(
                samples,
                language=language,
                beam_size=1,
                temperature=0.0,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 500, "speech_pad_ms": 300},
                condition_on_previous_text=False,
                initial_prompt=prompt,
            )
            return [
                {"start": s.start, "end": s.end, "text": s.text, "no_speech": s.no_speech_prob, "logprob": s.avg_logprob}
                for s in segments
            ]

        forced, device, compute = faster_device()
        try:
            return run(device, compute)
        except Exception as exc:
            if device != "cuda" or forced:
                raise
            print(f"[escuta] CUDA falhou ({exc}); refazendo na CPU.", flush=True)
            _cuda_broken = True
            _faster_models.clear()
            return run("cpu", "int8")

    return meeting.clean_live(whisper_worker.submit(job).result())


def transcribe_meeting(audio, model, language, emit):
    """Transcreve cada canal sozinho e junta por horário. emit({"stage", ...}) avisa o andamento."""
    engine = whisper_engine()
    if engine is None:
        raise ApiError(503, "whisper_missing", f"Whisper não está instalado. {SETUP_HINT}")
    import numpy as np

    model = canonical_model(model)
    language = None if language == "auto" else language
    start = time.monotonic()

    tmp = tempfile.NamedTemporaryFile(suffix=".webm", delete=False)
    try:
        tmp.write(audio)
        tmp.close()
        emit({"stage": "decode"})
        try:
            channels = dict(zip((meeting.WHO_MIC, meeting.WHO_TAB), split_channels(tmp.name)))
        except FileNotFoundError as exc:
            raise ApiError(500, "ffmpeg_missing", "ffmpeg não encontrado. Instale o ffmpeg e tente de novo.") from exc
        except Exception as exc:
            raise ApiError(400, "bad_audio", f"Não consegui ler a gravação: {exc}") from exc
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass

    run = transcribe_mlx if engine == "mlx" else transcribe_faster
    found = {}
    for n, (who, samples) in enumerate(channels.items()):
        rms = float(np.sqrt(np.mean(np.square(samples)))) if len(samples) else 0.0
        if rms < SILENT_RMS:
            found[who] = []
            emit({"stage": who, "skipped": True, "progress": (n + 1) / 2})
            continue
        emit({"stage": who, "progress": n / 2})
        parts = []
        whisper_worker.submit(run, boost(samples), model, language, None, parts).result()
        found[who] = parts
    emit({"stage": "merge", "progress": 1})

    segments = meeting.merge_channels(found[meeting.WHO_MIC], found[meeting.WHO_TAB])
    for seg in segments:
        seg["text"] = seg["text"].strip()
    duration = max(len(samples) for samples in channels.values()) / 16000
    print(f"[escuta] reunião transcrita em {time.monotonic() - start:.1f}s ({duration:.0f}s de áudio, {len(segments)} trechos).", flush=True)
    return {"duration": round(duration, 1), "mic": bool(found[meeting.WHO_MIC]), "segments": segments}


def complete(system, user, model, timeout):
    """Uma chamada ao modelo de resumo que estiver configurado (Gemini ou Ollama)."""
    if GEMINI_KEY:
        out = summarize_gemini(user, system, timeout)
        if not out:
            raise ApiError(502, "empty_response", "O modelo não devolveu texto. Tente de novo.")
        return out
    return summarize(user, model or DEFAULT_OLLAMA, system, timeout)


def make_minutes(transcript, template_id, language, model, notes="", goal=""):
    template = meeting.load_templates().get(template_id)  # relê a pasta: modelo novo vale sem reiniciar
    if template is None:
        raise ApiError(404, "template_missing", f"Modelo '{template_id}' não existe.")
    # Ollama tem janela pequena; o Gemini aguenta uma reunião inteira de uma vez.
    limit = 300_000 if GEMINI_KEY else 20_000
    chunks = meeting.chunk_lines(transcript, limit)
    if len(chunks) > 1:
        print(f"[escuta] transcrição longa: anotando {len(chunks)} partes antes da ata.", flush=True)
        notes = [complete(meeting.NOTES_PROMPT, chunk, model, 300) for chunk in chunks]
        transcript = "\n\n".join(f"Anotações da parte {i}:\n{note}" for i, note in enumerate(notes, 1))
    user = f"Transcrição da reunião:\n\n{transcript}"
    if notes:
        user += f"\n\nAnotações de quem gravou, feitas durante a reunião:\n{notes}"
    return complete(meeting.minutes_prompt(template, language, bool(notes), goal), user, model, 600)


def answer_question(payload):
    question = str(payload.get("question") or "").strip()
    if not question:
        raise ApiError(400, "empty_text", "Escreva a pergunta.")
    transcript = (payload.get("transcript") or "").strip()
    if not transcript and payload.get("segments"):
        transcript = meeting.format_transcript(payload["segments"])
    minutes = str(payload.get("minutes") or "").strip()
    notes = str(payload.get("notes") or "").strip()[:20_000]
    if not (transcript or minutes):
        raise ApiError(400, "empty_text", "Esta reunião não tem texto para consultar.")
    limit = 300_000 if GEMINI_KEY else 20_000
    user = meeting.ask_message(question, transcript, minutes, notes, payload.get("history"), limit, payload.get("goal") or "")
    answer = complete(meeting.ask_prompt(payload.get("language") or "pt"), user, payload.get("model"), 180)
    return {"answer": answer.strip()}


def ollama_models():
    try:
        with urllib.request.urlopen(f"{OLLAMA_URL}/api/tags", timeout=1.5) as res:
            return [m["name"] for m in json.load(res).get("models", [])]
    except (urllib.error.URLError, TimeoutError, ValueError, OSError):
        return None


def summarize(text, model, system=SUMMARY_PROMPT, timeout=180):
    # O Ollama corta a entrada no contexto padrão (4096 tokens) sem avisar, e uma ata de
    # reunião longa passa disso fácil. ~2 caracteres por token (número gasta mais que
    # palavra), mais folga para a resposta.
    num_ctx = min(32768, max(4096, int((len(system) + len(text)) / 2) + 4096))

    def ask(think):
        payload = {
            "model": model,
            "stream": False,
            "options": {"temperature": 0.2, "num_ctx": num_ctx},
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": text},
            ],
        }
        if think is not None:
            payload["think"] = think
        req = urllib.request.Request(
            f"{OLLAMA_URL}/api/chat", data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.load(res)["message"]["content"].strip()

    try:
        # Modelos que "pensam" (gemma4, qwen3, deepseek-r1…) gastam o contexto raciocinando e,
        # num texto longo, chegam ao limite sem escrever nada: a ata saía vazia. Resumir não
        # precisa disso, e desligar deixa o trecho de 5 mil caracteres 2x mais rápido.
        try:
            out = ask(False)
        except urllib.error.HTTPError as exc:
            if exc.code != 400:
                raise
            out = ask(None)  # modelo antigo que não conhece o campo "think"
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise ApiError(404, "ollama_model_missing", f"Modelo {model} não baixado. Rode: ollama pull {model}") from exc
        raise ApiError(502, "ollama_error", f"Ollama respondeu {exc.code}.") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ApiError(503, "ollama_offline", "Ollama não está rodando. Abra o app Ollama.") from exc
    if not out:
        raise ApiError(502, "empty_response", "O modelo não devolveu texto. Tente de novo ou escolha outro modelo.")
    return out


def summarize_gemini(text, system=SUMMARY_PROMPT, timeout=60):
    body = json.dumps(
        {
            "systemInstruction": {"parts": [{"text": system}]},
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
        with urllib.request.urlopen(req, timeout=timeout) as res:
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
    server_version = "Escuta/1.2"

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

    def _read_body(self, limit=MAX_BODY):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            raise ApiError(400, "empty_body", "Corpo vazio.")
        if length > limit:
            raise ApiError(413, "too_large", f"Corpo maior que {limit // (1024 * 1024)} MB.")
        return self.rfile.read(length)

    def _allowed(self):
        if not self._origin_ok():
            self._send(403, {"code": "forbidden", "message": "Origem não permitida."})
            return False
        if not self._token_ok():
            self._send(403, {"code": "bad_token", "message": "Token do servidor não confere."})
            return False
        return True

    def _stream_transcribe(self, model, language):
        """NDJSON: uma linha {"segment"} por trecho pronto e, no fim, {"done", "text", ...}."""
        self._stream_ndjson(lambda audio, emit: transcribe(audio, model, language, lambda text: emit({"segment": text})))

    def _stream_ndjson(self, job, limit=MAX_BODY):
        """job(corpo, emit) devolve o dict final. Linhas {"stage"|"segment"}, depois {"done", ...}
        ou {"error", "message"}. Erros depois do 200 já enviado só podem ir no corpo."""
        if not self._allowed():
            return
        try:
            audio = self._read_body(limit)
        except ApiError as err:
            return self._send(err.status, {"code": err.code, "message": err.message})
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        origin = self.headers.get("Origin")
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.end_headers()  # HTTP/1.0 sem Content-Length: o corpo termina quando a conexão fecha

        def emit(payload):
            self.wfile.write((json.dumps(payload, ensure_ascii=False) + "\n").encode())
            self.wfile.flush()

        try:
            emit({"done": True, **job(audio, emit)})
        except ApiError as err:
            emit({"error": err.code, "message": err.message})
        except ConnectionError:
            pass  # a aba fechou no meio; o erro no emit já interrompeu o Whisper
        except Exception as exc:
            try:
                emit({"error": "internal", "message": str(exc)})
            except ConnectionError:
                pass

    def _guard(self, fn):
        if not self._allowed():
            return
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
        path = urlparse(self.path).path
        if path == "/templates":
            return self._guard(lambda: {"templates": meeting.public_list(meeting.load_templates())})
        if path != "/health":
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
            if query.get("stream") == ["1"]:
                self._stream_transcribe(model, language)
            else:
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
        elif url.path == "/live":
            query = parse_qs(url.query)
            model = query.get("model", [DEFAULT_WHISPER])[0]
            language = query.get("language", ["pt"])[0]
            prompt = query.get("prompt", [""])[0]
            self._guard(lambda: {"segments": transcribe_live(self._read_body(MAX_LIVE), model, language, prompt)})
        elif url.path == "/meeting":
            query = parse_qs(url.query)
            model = query.get("model", [DEFAULT_WHISPER])[0]
            language = query.get("language", ["pt"])[0]
            self._stream_ndjson(lambda audio, emit: transcribe_meeting(audio, model, language, emit), MAX_MEETING)
        elif url.path == "/minutes":

            def run_minutes():
                try:
                    payload = json.loads(self._read_body())
                except ValueError as exc:
                    raise ApiError(400, "bad_json", "JSON inválido.") from exc
                transcript = (payload.get("transcript") or "").strip()
                if not transcript and payload.get("segments"):
                    transcript = meeting.format_transcript(payload["segments"])
                if not transcript:
                    raise ApiError(400, "empty_text", "Nada para resumir.")
                notes = str(payload.get("notes") or "").strip()[:20_000]
                return {
                    "minutes": make_minutes(
                        transcript,
                        payload.get("template") or "reuniao",
                        payload.get("language") or "pt",
                        payload.get("model"),
                        notes,
                        payload.get("goal") or "",
                    )
                }

            self._guard(run_minutes)
        elif url.path == "/ask":

            def run_ask():
                try:
                    payload = json.loads(self._read_body())
                except ValueError as exc:
                    raise ApiError(400, "bad_json", "JSON inválido.") from exc
                if not isinstance(payload, dict):
                    raise ApiError(400, "bad_json", "JSON inválido.")
                return answer_question(payload)

            self._guard(run_ask)
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
    from types import SimpleNamespace as Seg

    # O caso real: 22 s viraram uma palavra. Fala normal e trecho curto passam.
    assert gave_up([Seg(start=27.3, end=56.6, text=" " + "x" * 600), Seg(start=56.6, end=78.4, text=" Monotur.")])
    assert not gave_up([Seg(start=0.0, end=27.0, text=" " + "x" * 400), Seg(start=27.0, end=28.0, text=" Lula.")])
    print("ok")


class Server(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        # Um cliente que fecha a conexão no meio é rotina (aba fechada, timeout).
        # Sem isso, cada um desses despeja um traceback inteiro no log.
        exc = sys.exc_info()[1]  # sys.exception() só existe no Python 3.11+
        if isinstance(exc, (ConnectionError, TimeoutError)):
            print(f"[escuta] cliente desconectou: {type(exc).__name__}", flush=True)
            return
        super().handle_error(request, client_address)


if __name__ == "__main__":
    add_nvidia_dll_dirs()
    if "--selfcheck" in sys.argv:
        selfcheck()
        raise SystemExit(0)
    whisper_worker.submit(preload)
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
