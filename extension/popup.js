const DEFAULTS = {
  language: "pt",
  whisperModel: "large-v3-turbo",
  ollamaModel: "qwen2.5:7b",
  autoTranscribe: false,
  autoSummary: true,
};

const $ = (id) => document.getElementById(id);

function setStatus(name, state, text) {
  $(`dot-${name}`).dataset.state = state;
  $(`txt-${name}`).textContent = text;
}

async function loadSettings() {
  const saved = await chrome.storage.sync.get(DEFAULTS);
  for (const key of Object.keys(DEFAULTS)) {
    if ($(key).type === "checkbox") $(key).checked = saved[key];
    else $(key).value = saved[key];
  }
  $("token").value = (await chrome.storage.local.get("token")).token || "";
}

async function checkHealth() {
  // O service worker pode responder undefined se acabou de ser reiniciado.
  const res = (await chrome.runtime.sendMessage({ type: "health" }).catch(() => null)) || { ok: false };
  const hint = $("hint");

  if (res.code === "bad_token") {
    setStatus("server", "warn", "token errado");
    setStatus("whisper", "bad", "—");
    setStatus("ollama", "bad", "—");
    hint.textContent = "O token abaixo não confere com o ESCUTA_TOKEN do server/.env.";
    hint.hidden = false;
    return;
  }

  if (!res.ok) {
    setStatus("server", "bad", "desligado");
    setStatus("whisper", "bad", "—");
    setStatus("ollama", "bad", "—");
    hint.textContent = "Rode na pasta server:\nstart.bat (Windows) ou ./start.sh";
    hint.hidden = false;
    return;
  }

  const { whisper, whisperEngine, ollama, ollamaModels, gemini, geminiModel, recommendedModel } = res.data;
  const serverWantsToken = res.data.token;

  // Nada salvo ainda: mostra o modelo que o servidor recomenda para este hardware.
  const saved = await chrome.storage.sync.get("whisperModel");
  if (saved.whisperModel === undefined && recommendedModel) $("whisperModel").value = recommendedModel;
  const summaryReady = gemini || ollama;
  setStatus("server", "ok", "ligado");
  setStatus("whisper", whisper ? "ok" : "bad", whisper ? whisperEngine || "pronto" : "não instalado");
  if (gemini) setStatus("ollama", "ok", `Gemini · ${geminiModel}`);
  else setStatus("ollama", ollama ? "ok" : "warn", ollama ? "pronto" : "desligado");
  hint.hidden = whisper && summaryReady;
  if (!whisper) hint.textContent = "Rode na pasta server:\nsetup.bat (Windows) ou ./setup.sh";
  else if (!summaryReady) hint.textContent = "Abra o app Ollama ou defina GEMINI_API_KEY para gerar resumos.";
  else if ((await chrome.storage.local.get("token")).token && !serverWantsToken) {
    // Token preenchido aqui e nenhum no servidor: são dois lados, e sem o do
    // servidor o campo abaixo não protege nada.
    hint.textContent = "O token abaixo não está valendo: o servidor não exige nenhum. Ponha ESCUTA_TOKEN no server/.env com o mesmo valor e reinicie o servidor.";
    hint.hidden = false;
  } else if (recommendedModel === "small") {
    hint.textContent = "Sem GPU nesta máquina: o modelo Small é umas 2,5x mais rápido que o Turbo aqui.";
    hint.hidden = false;
  }

  $("models").replaceChildren(
    ...ollamaModels.map((name) => Object.assign(document.createElement("option"), { value: name })),
  );
}

async function save() {
  const values = Object.fromEntries(
    Object.keys(DEFAULTS).map((key) => [key, $(key).type === "checkbox" ? $(key).checked : $(key).value.trim() || DEFAULTS[key]]),
  );
  await chrome.storage.sync.set(values);
  await chrome.storage.local.set({ token: $("token").value.trim() });
  const button = $("save");
  button.textContent = "Salvo ✓";
  setTimeout(() => (button.textContent = "Salvar ajustes"), 1500);
}

$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await save();
  checkHealth(); // token novo: confere na hora se o servidor aceita
});
// Caixas e listas salvam sozinhas: fechar o popup sem clicar em Salvar não perde nada.
$("form").addEventListener("change", (event) => {
  if (event.target.id !== "token") save();
});

// A aba ativa é o WhatsApp? Sem permissão "tabs" não dá para ler a URL, então
// pergunta direto ao content script: se ele não responde, não é o WhatsApp.
async function askPage(type) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id == null ? null : await chrome.tabs.sendMessage(tab.id, { type });
  } catch {
    return null;
  }
}

async function checkPage() {
  const res = await askPage("page-status");
  $("page-hint").hidden = !res?.broken;
  if (!res) setStatus("page", "", "abra o WhatsApp Web (ou dê F5 nele)");
  else if (!res.chat) setStatus("page", "", "abra uma conversa");
  else if (res.broken) setStatus("page", "bad", "não acho os áudios");
  else setStatus("page", "ok", res.voice ? `${res.voice} áudio${res.voice > 1 ? "s" : ""} na tela` : "pronto");
}

$("diagnose").addEventListener("click", async () => {
  const button = $("diagnose");
  const res = await askPage("page-diagnose");
  if (!res) button.textContent = "Abra o WhatsApp Web nesta aba";
  else {
    await navigator.clipboard.writeText(JSON.stringify(res, null, 1));
    button.textContent = "Diagnóstico copiado ✓";
  }
  setTimeout(() => (button.textContent = "Copiar diagnóstico"), 2000);
});

$("search").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("history.html") });
  window.close();
});

// ---- reunião -------------------------------------------------------------------

const STAGES = {
  upload: "Enviando a gravação…",
  decode: "Preparando o áudio…",
  voce: "Transcrevendo a sua voz…",
  outros: "Transcrevendo os participantes…",
  merge: "Juntando as falas…",
  minutes: "Escrevendo a ata…",
};

const fmtClock = (ms) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = String(Math.floor((total % 3600) / 60)).padStart(h ? 2 : 1, "0");
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${m}:${s}` : `${m}:${s}`;
};

let recStart = 0;
let latestId = "";

// Gravando ou livre. A faixa "gerando a ata" é à parte: dá para gravar a próxima reunião
// enquanto a anterior ainda está sendo transcrita.
function showRec(which) {
  for (const id of ["rec-idle", "rec-live"]) $(id).hidden = id !== which;
}

async function latestMeeting() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([key, value]) => key.startsWith("m:") && value?.status)
    .map(([, value]) => value)
    .sort((a, b) => (b.at || 0) - (a.at || 0))[0];
}

async function refreshRec() {
  const res = await chrome.runtime.sendMessage({ type: "rec-state" }).catch(() => null);
  if (!res?.ok || !res.data.canRecord) return; // Firefox e navegadores sem gravação de aba: a seção fica escondida
  $("meeting").hidden = false;

  const rec = res.data.rec;
  if (rec?.state === "recording") {
    recStart = rec.startedAt;
    $("rec-title").textContent = rec.title;
    $("rec-mic").textContent = rec.mic
      ? "Gravando o áudio da aba e o seu microfone."
      : "Sem microfone: só o áudio da aba está sendo gravado. Se quiser a sua voz, pare, permita o microfone e grave de novo.";
    $("rec-live-open").hidden = !rec.live;
    showRec("rec-live");
  } else {
    showRec("rec-idle");
  }

  const last = await latestMeeting();
  latestId = last?.id || "";
  const processing = last?.status === "processing";
  $("rec-busy").hidden = !processing;
  if (processing) $("busy-text").textContent = STAGES[last.stage] || "Gerando a ata…";
}

async function loadTemplates() {
  const res = await chrome.runtime.sendMessage({ type: "templates" }).catch(() => null);
  const list = res?.ok ? res.data.templates : [];
  const { template } = await chrome.storage.sync.get({ template: "reuniao" });
  $("template").replaceChildren(...list.map((t) => Object.assign(new Option(t.name, t.id), { title: t.description })));
  if (list.some((t) => t.id === template)) $("template").value = template;
  $("template").addEventListener("change", () => chrome.storage.sync.set({ template: $("template").value }));
  $("rec-start").disabled = !list.length;
  if (!list.length) showRecError("O servidor não respondeu. Ligue o servidor para gravar.");
}

function showRecError(text) {
  $("rec-error").textContent = text;
  $("rec-error").hidden = !text;
}

$("rec-start").addEventListener("click", async () => {
  showRecError("");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https?:/.test(tab.url || "")) {
    return showRecError("Abra a aba da reunião, clique no ícone do Escuta nela e grave de novo.");
  }

  // A permissão de microfone não aparece no gravador invisível: pede uma vez numa aba normal.
  const mic = await navigator.permissions.query({ name: "microphone" }).catch(() => null);
  if (mic?.state === "prompt") {
    await chrome.tabs.create({ url: chrome.runtime.getURL("mic.html") });
    return showRecError("Permita o microfone na aba que abriu e clique em Gravar de novo.");
  }

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch (err) {
    return showRecError(`Não consegui capturar esta aba: ${err.message || err}`);
  }
  $("rec-start").disabled = true;
  const res = await chrome.runtime.sendMessage({ type: "rec-start", streamId, tabId: tab.id, title: tab.title, template: $("template").value });
  $("rec-start").disabled = false;
  if (!res?.ok) return showRecError(res?.message || "Não consegui começar a gravar.");
  // O painel entra na própria aba da reunião; se a página não deixar, cai para uma janela solta.
  if (res.data.live && !res.data.dock) await openLive();
  refreshRec();
});

// A janela fica ao lado da reunião, no canto direito da tela. Se já existe, só vem para a frente.
async function openLive() {
  const url = chrome.runtime.getURL("live.html");
  const [existing] = await chrome.tabs.query({ url }).catch(() => []);
  if (existing) return chrome.windows.update(existing.windowId, { focused: true });
  const width = 400;
  const height = Math.min(760, screen.availHeight - 80);
  return chrome.windows.create({
    url,
    type: "popup",
    width,
    height,
    left: (screen.availLeft || 0) + screen.availWidth - width - 20,
    top: (screen.availTop || 0) + 40,
  });
}

$("rec-live-open").addEventListener("click", async () => {
  const state = await chrome.runtime.sendMessage({ type: "rec-state" }).catch(() => null);
  const tabId = state?.data?.rec?.tabId;
  const res = tabId == null ? null : await chrome.runtime.sendMessage({ type: "dock-open", tabId }).catch(() => null);
  if (!res?.data?.dock) await openLive(); // a aba não está à mão (ou fechou): janela solta
  window.close();
});

chrome.storage.sync.get({ live: true }).then(({ live }) => ($("live").checked = live));
$("live").addEventListener("change", () => chrome.storage.sync.set({ live: $("live").checked }));

$("rec-stop").addEventListener("click", async () => {
  $("rec-stop").disabled = true;
  await chrome.runtime.sendMessage({ type: "rec-stop" });
  $("rec-stop").disabled = false;
  refreshRec();
});

$("rec-open").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL(`history.html${latestId ? `#m:${latestId}` : ""}`) });
  window.close();
});

setInterval(() => {
  if (!$("rec-live").hidden) $("rec-clock").textContent = fmtClock(Date.now() - recStart);
}, 500);
setInterval(refreshRec, 2000);

loadSettings();
checkHealth();
checkPage();
refreshRec();
loadTemplates();
