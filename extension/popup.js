const DEFAULTS = {
  language: "pt",
  whisperModel: "mlx-community/whisper-large-v3-turbo",
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
}

async function checkHealth() {
  const res = await chrome.runtime.sendMessage({ type: "health" });
  const hint = $("hint");

  if (!res.ok) {
    setStatus("server", "bad", "desligado");
    setStatus("whisper", "bad", "—");
    setStatus("ollama", "bad", "—");
    hint.textContent = "Rode na pasta server:\n./start.sh";
    hint.hidden = false;
    return;
  }

  const { whisper, ollama, ollamaModels, gemini } = res.data;
  const summaryReady = gemini || ollama;
  setStatus("server", "ok", "ligado");
  setStatus("whisper", whisper ? "ok" : "bad", whisper ? "pronto" : "não instalado");
  if (gemini) setStatus("ollama", "ok", "usando Gemini");
  else setStatus("ollama", ollama ? "ok" : "warn", ollama ? "pronto" : "desligado");
  hint.hidden = whisper && summaryReady;
  if (!whisper) hint.textContent = "Rode na pasta server:\n./setup.sh";
  else if (!summaryReady) hint.textContent = "Abra o app Ollama ou defina GEMINI_API_KEY para gerar resumos.";

  $("models").replaceChildren(
    ...ollamaModels.map((name) => Object.assign(document.createElement("option"), { value: name })),
  );
}

$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(Object.keys(DEFAULTS).map((key) => [key, $(key).value.trim() || DEFAULTS[key]]));
  await chrome.storage.sync.set(values);
  const button = $("save");
  button.textContent = "Salvo";
  setTimeout(() => (button.textContent = "Salvar ajustes"), 1500);
});

loadSettings();
checkHealth();
