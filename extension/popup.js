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
  if (!res) setStatus("page", "", "abra o WhatsApp Web");
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

loadSettings();
checkHealth();
checkPage();
