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

// Numa máquina sem GPU o turbo roda a ~2x tempo real e o small a ~6x. Quem nunca
// escolheu um modelo fica com o que o servidor recomenda para o hardware dele.
let recommended = null;

async function resolveModel(chosen) {
  const saved = await chrome.storage.sync.get("whisperModel");
  if (saved.whisperModel !== undefined) return chosen;
  if (recommended === null) {
    const res = await call("/health", { method: "GET" }, 3_000);
    recommended = (res.ok && res.data.recommendedModel) || DEFAULTS.whisperModel;
  }
  return recommended;
}

// Response when the server answered, or a fail() when it could not be reached.
async function send(path, init, timeoutMs, signal) {
  const token = await getToken();
  const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
  try {
    return await fetch(BASE + path, {
      ...init,
      headers: { ...init.headers, ...(token ? { "X-Escuta-Token": token } : {}) },
      signal: AbortSignal.any(signals),
    });
  } catch (err) {
    return fetchFailed(path, err);
  }
}

function fetchFailed(path, err) {
  if (err.name === "TimeoutError") return fail("timeout", "A transcrição demorou demais.");
  if (err.name === "AbortError") return fail("aborted", "Cancelado.");
  console.warn("[escuta] fetch falhou:", path, err); // visível no console do service worker
  return fail("server_offline", "Servidor local desligado.");
}

async function parse(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return fail(body.code || "error", body.message || `Erro ${res.status}.`);
  return { ok: true, data: body };
}

async function call(path, init, timeoutMs) {
  const res = await send(path, init, timeoutMs);
  return res instanceof Response ? parse(res) : res;
}

// Streaming: o servidor manda uma linha JSON por trecho pronto e uma final.
// Servidor antigo sem ?stream=1 responde JSON comum, e isso também serve.
async function transcribeStream(msg, onSegment, signal) {
  const settings = await getSettings();
  const query = new URLSearchParams({
    language: settings.language,
    model: await resolveModel(settings.whisperModel),
    stream: "1",
  });
  const path = `/transcribe?${query}`;
  const res = await send(path, { method: "POST", body: base64ToBlob(msg.audio, msg.mime) }, 10 * 60_000, signal);
  if (!(res instanceof Response)) return res;
  if (!res.ok || !(res.headers.get("Content-Type") || "").includes("ndjson")) return parse(res);

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const item = JSON.parse(line);
        if (item.segment != null) onSegment(item.segment);
        else if (item.error) return fail(item.error, item.message);
        else if (item.done) return { ok: true, data: item };
      }
    }
  } catch (err) {
    return fetchFailed(path, err);
  }
  return fail("error", "O servidor parou no meio da transcrição.");
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
      // Reuniões: gravar, parar, estado e modelos de ata ficam em meetings.js.
      return (typeof meetingHandle === "function" && meetingHandle(msg)) || fail("unknown", "Mensagem desconhecida.");
  }
}

// Transcrição vai por porta, não por sendMessage: a porta leva os trechos
// parciais até a aba enquanto o Whisper ainda trabalha.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "transcribe") return;
  const abort = new AbortController();
  let open = true;
  const post = (payload) => {
    if (open) port.postMessage(payload);
  };
  port.onDisconnect.addListener(() => {
    open = false;
    abort.abort(); // aba fechada ou recarregada: o servidor para de gastar GPU com ela
  });
  port.onMessage.addListener(async (msg) => {
    const res = await withKeepAlive(() => transcribeStream(msg, (segment) => post({ segment }), abort.signal));
    post(res);
  });
});

// A aba do WhatsApp avisa quando acha áudio na conversa mas nenhum seletor pega:
// o "!" no ícone é o sinal de que o WhatsApp mudou o HTML de novo.
function flagTab(tabId, broken) {
  if (tabId == null) return;
  chrome.action.setBadgeText({ tabId, text: broken ? "!" : "" });
  if (broken) chrome.action.setBadgeBackgroundColor({ tabId, color: "#b42318" });
  chrome.action.setTitle({
    tabId,
    title: broken ? "Escuta: não estou reconhecendo os áudios desta conversa. Clique para ver o diagnóstico." : "Escuta",
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "selectors") {
    flagTab(sender.tab?.id, msg.broken);
    sendResponse({ ok: true });
    return false;
  }
  handle(msg).then(sendResponse);
  return true;
});

// Reuniões. O service worker do Chrome carrega os arquivos aqui; no Firefox eles já
// vêm na lista "scripts" do manifest, e importScripts não existe.
if (typeof importScripts === "function") importScripts("rec-db.js", "meetings.js");
