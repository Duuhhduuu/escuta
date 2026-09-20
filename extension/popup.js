const DEFAULTS = {
  language: "pt",
  whisperModel: "large-v3-turbo",
  ollamaModel: "qwen2.5:7b",
};

const $ = (id) => document.getElementById(id);

function setStatus(name, state, text) {
  $(`dot-${name}`).dataset.state = state;
  $(`txt-${name}`).textContent = text;
}

async function loadSettings() {
  const saved = await chrome.storage.sync.get(DEFAULTS);
  for (const key of Object.keys(DEFAULTS)) $(key).value = saved[key];
  $("token").value = (await chrome.storage.local.get("token")).token || "";
}

async function checkHealth() {
  const res = await chrome.runtime.sendMessage({ type: "health" });
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
  else if (recommendedModel === "small") {
    hint.textContent = "Sem GPU nesta máquina: o modelo Small é umas 2,5x mais rápido que o Turbo aqui.";
    hint.hidden = false;
  }

  $("models").replaceChildren(
    ...ollamaModels.map((name) => Object.assign(document.createElement("option"), { value: name })),
  );
}

$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(Object.keys(DEFAULTS).map((key) => [key, $(key).value.trim() || DEFAULTS[key]]));
  await chrome.storage.sync.set(values);
  await chrome.storage.local.set({ token: $("token").value.trim() });
  const button = $("save");
  button.textContent = "Salvo";
  setTimeout(() => (button.textContent = "Salvar ajustes"), 1500);
});

loadSettings();
checkHealth();
