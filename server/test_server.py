#!/usr/bin/env python3
"""Sobe o servidor de verdade numa porta livre e fala com ele por HTTP.

    .venv/bin/python test_server.py        (Mac/Linux)
    .venv\\Scripts\\python test_server.py   (Windows)

Carrega o modelo Whisper padrão, então leva alguns segundos. Os testes de
transcrição pulam sozinhos quando o Whisper não está instalado.
"""
import io
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
TOKEN = "teste-escuta"
sys.path.insert(0, HERE)
import server  # noqa: E402  (só para saber o motor; o servidor testado roda em outro processo)

HAS_WHISPER = server.whisper_engine() is not None


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def silence_wav(seconds=1.0, rate=16000):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(b"\0\0" * int(rate * seconds))
    return buf.getvalue()


def speech_audio():
    """Fala de verdade pelo `say` do Mac, ou None fora do Mac."""
    if not shutil.which("say"):
        return None
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "fala.aiff")
        text = "Oi, a reunião de amanhã mudou para as dez e meia. " * 8
        if subprocess.run(["say", "-v", "Luciana", "-o", path, text], capture_output=True).returncode:
            return None
        with open(path, "rb") as fh:
            return fh.read()


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = free_port()
        env = {**os.environ, "ESCUTA_PORT": str(cls.port), "ESCUTA_TOKEN": TOKEN, "PYTHONUNBUFFERED": "1"}
        env.pop("ESCUTA_LOG", None)
        cls.proc = subprocess.Popen(
            [sys.executable, os.path.join(HERE, "server.py")],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        cls.log = []
        cls.listening = threading.Event()
        cls.preloaded = threading.Event()

        def read():
            for line in cls.proc.stdout:
                cls.log.append(line)
                if "ouvindo em" in line:
                    cls.listening.set()
                if "pronto em" in line or "não pré-carregado" in line:
                    cls.preloaded.set()
            cls.listening.set()
            cls.preloaded.set()

        threading.Thread(target=read, daemon=True).start()
        if not cls.listening.wait(30) or cls.proc.poll() is not None:
            cls.tearDownClass()
            raise RuntimeError("servidor não subiu:\n" + "".join(cls.log))

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        try:
            cls.proc.wait(10)
        except subprocess.TimeoutExpired:
            cls.proc.kill()

    def request(self, path, body=None, headers=None, token=TOKEN):
        headers = dict(headers or {})
        if token:
            headers["X-Escuta-Token"] = token
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=body, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=300) as res:
                return res.status, res.headers.get("Content-Type", ""), res.read().decode()
        except urllib.error.HTTPError as err:
            with err:
                return err.code, err.headers.get("Content-Type", ""), err.read().decode()

    def test_health(self):
        status, _, body = self.request("/health")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["whisper"], HAS_WHISPER)

    def test_token_required(self):
        status, _, body = self.request("/health", token=None)
        self.assertEqual(status, 403)
        self.assertEqual(json.loads(body)["code"], "bad_token")

    def test_web_origin_rejected(self):
        status, _, _ = self.request("/health", headers={"Origin": "https://example.com"})
        self.assertEqual(status, 403)

    @unittest.skipUnless(HAS_WHISPER, "Whisper não instalado")
    def test_transcribe_after_preload(self):
        # Regressão: no mlx 0.30+ o modelo pré-carregado numa thread falhava em
        # outra com "There is no Stream(gpu, N)", e todo pedido voltava 500.
        self.assertTrue(self.preloaded.wait(300), "preload não terminou")
        status, _, body = self.request("/transcribe?language=pt", silence_wav())
        self.assertEqual(status, 200, body)
        self.assertIn("text", json.loads(body))

    @unittest.skipUnless(HAS_WHISPER, "Whisper não instalado")
    def test_stream_silence(self):
        status, ctype, body = self.request("/transcribe?language=pt&stream=1", silence_wav())
        self.assertEqual(status, 200, body)
        self.assertIn("ndjson", ctype)
        last = json.loads(body.strip().splitlines()[-1])
        self.assertTrue(last.get("done"), body)

    @unittest.skipUnless(HAS_WHISPER, "Whisper não instalado")
    def test_stream_speech(self):
        audio = speech_audio()
        if audio is None:
            self.skipTest("sem `say` para gerar fala")
        status, _, body = self.request("/transcribe?language=pt&stream=1", audio)
        self.assertEqual(status, 200, body)
        lines = [json.loads(line) for line in body.strip().splitlines()]
        segments = [line["segment"] for line in lines if "segment" in line]
        final = lines[-1]
        self.assertTrue(final.get("done"), body)
        self.assertGreater(len(segments), 1, "o texto deveria chegar em mais de um trecho")
        self.assertIn("reunião", final["text"].lower())
        self.assertGreater(final["duration"], 20)
        self.assertEqual("".join(segments).split(), final["text"].split())

    @unittest.skipUnless(HAS_WHISPER, "Whisper não instalado")
    def test_empty_body(self):
        status, _, body = self.request("/transcribe?stream=1", b"")
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["code"], "empty_body")


if __name__ == "__main__":
    unittest.main(verbosity=2)
