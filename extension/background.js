const BASE = "http://127.0.0.1:8765";

const DEFAULTS = {
  language: "pt",
  whisperModel: "large-v3-turbo",
  ollamaModel: "qwen2.5:7b",
};

const getSettings = () => chrome.storage.sync.get(DEFAULTS);
// Local, not sync: the token guards this machine's server, it should not follow the account around.
const getToken = async () => (await chrome.storage.local.get("token")).token || "";

const fail = (code, message) => ({ ok: false, code, message });

async function call(path, init, timeoutMs) {
  const token = await getToken();
  let res;
  try {
    res = await fetch(BASE + path, {
      ...init,
      headers: { ...init.headers, ...(token ? { "X-Escuta-Token": token } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === "TimeoutError") return fail("timeout", "A transcrição demorou demais.");
    console.warn("[escuta] fetch falhou:", path, err); // visível no console do service worker
    return fail("server_offline", "Servidor local desligado.");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return fail(body.code || "error", body.message || `Erro ${res.status}.`);
  return { ok: true, data: body };
}

function base64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

// Long jobs: a periodic extension API call stops Chrome from suspending the worker mid-request.
async function withKeepAlive(job) {
  const timer = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
  try {
    return await job();
  } finally {
    clearInterval(timer);
  }
}

async function handle(msg) {
  const settings = await getSettings();
  switch (msg.type) {
    case "transcribe": {
      const query = new URLSearchParams({ language: settings.language, model: settings.whisperModel });
      return withKeepAlive(() =>
        call(`/transcribe?${query}`, { method: "POST", body: base64ToBlob(msg.audio, msg.mime) }, 10 * 60_000),
      );
    }
    case "summarize":
      return withKeepAlive(() =>
        call(
          "/summarize",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: msg.text, model: settings.ollamaModel }),
          },
          3 * 60_000,
        ),
      );
    case "health":
      return call("/health", { method: "GET" }, 3_000);
    default:
      return fail("unknown", "Mensagem desconhecida.");
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg).then(sendResponse);
  return true;
});
