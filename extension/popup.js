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
let curRec = null;
const recElapsed = (r) => (r.paused ? r.pausedAt : Date.now()) - r.startedAt - (r.pausedMs || 0);
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
    curRec = rec;
    recStart = rec.startedAt;
    $("rec-title").textContent = rec.title;
    const where =
      rec.live === false || rec.dock === undefined
        ? ""
        : rec.dock
          ? " Painel ao vivo no lado direito da página."
          : rec.window
            ? ` O painel não abriu nesta página (${rec.dockError || "motivo desconhecido"}); abri uma janela ao lado.`
            : ` Não consegui abrir o painel (${rec.dockError || "motivo desconhecido"}). Use "Abrir a transcrição ao vivo".`;
    $("rec-mic").textContent =
      (rec.mic
        ? "Gravando o áudio da aba e o seu microfone."
        : "Gravando só o áudio da aba (sem o seu microfone). Para incluir a sua voz, permita o microfone e grave de novo.") + where;
    $("rec-live-open").hidden = !rec.live;
    showRec("rec-live");
  } else {
    showRec("rec-idle");
  }

  const log = await chrome.runtime.sendMessage({ type: "rec-log" }).catch(() => null);
  const lines = log?.data?.lines || [];
  $("rec-logbox").hidden = !lines.length;
  $("rec-log").textContent = lines.map((l) => `${new Date(l.at).toLocaleTimeString("pt-BR")}  ${l.line}`).join("\n");

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

  // Grava na hora. O microfone é um extra: sem permissão, grava só o áudio da aba.
  const mic = await navigator.permissions.query({ name: "microphone" }).catch(() => null);
  const micGranted = mic?.state === "granted";

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch (err) {
    return showRecError(`Não consegui capturar esta aba: ${err.message || err}`);
  }
  $("rec-start").disabled = true;
  const res = await chrome.runtime.sendMessage({ type: "rec-start", streamId, tabId: tab.id, title: tab.title, template: $("template").value, mic: micGranted, goal: $("goal").value.trim() });
  $("rec-start").disabled = false;
  if (!res?.ok) return showRecError(res?.message || "Não consegui começar a gravar.");
  // O painel entra na própria aba da reunião; se a página não deixar, cai para uma janela solta.
  refreshRec();
});

$("rec-live-open").addEventListener("click", async () => {
  const state = await chrome.runtime.sendMessage({ type: "rec-state" }).catch(() => null);
  const tabId = state?.data?.rec?.tabId;
  await chrome.runtime.sendMessage({ type: "dock-open", tabId }).catch(() => null); // painel na aba, ou janela se não der
  window.close();
});

chrome.storage.sync.get({ live: true }).then(({ live }) => ($("live").checked = live));
$("live").addEventListener("change", () => chrome.storage.sync.set({ live: $("live").checked }));
chrome.storage.sync.get({ autoMeet: false }).then(({ autoMeet }) => ($("autoMeet").checked = autoMeet));
$("autoMeet").addEventListener("change", () => chrome.storage.sync.set({ autoMeet: $("autoMeet").checked }));

$("rec-stop").addEventListener("click", async () => {
  // Parar tem janela para desfazer; o segundo clique cancela.
  await chrome.runtime.sendMessage({ type: curRec?.stopAt ? "rec-stop-cancel" : "rec-stop-soon" });
  await refreshRec();
});

$("rec-pause").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: curRec?.paused ? "rec-resume" : "rec-pause" });
  await refreshRec();
});

let discardArmed = 0;
$("rec-discard").addEventListener("click", async () => {
  if (!discardArmed) {
    // Apagar é irreversível: pede um segundo clique, como o Apagar das transcrições.
    $("rec-discard").textContent = "Clique de novo para descartar de vez";
    discardArmed = setTimeout(() => {
      discardArmed = 0;
      $("rec-discard").textContent = "Descartar esta gravação";
    }, 4000);
    return;
  }
  clearTimeout(discardArmed);
  discardArmed = 0;
  $("rec-discard").textContent = "Descartar esta gravação";
  await chrome.runtime.sendMessage({ type: "rec-discard" });
  await refreshRec();
});

$("rec-log-copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("rec-log").textContent);
    $("rec-log-copy").textContent = "Copiado ✓";
  } catch {
    $("rec-log-copy").textContent = "Não copiou";
  }
  setTimeout(() => ($("rec-log-copy").textContent = "Copiar"), 1500);
});

$("rec-open").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL(`history.html${latestId ? `#m:${latestId}` : ""}`) });
  window.close();
});

setInterval(() => {
  if ($("rec-live").hidden || !curRec) return;
  $("rec-clock").textContent = fmtClock(recElapsed(curRec));
  const left = curRec.stopAt ? Math.max(0, Math.ceil((curRec.stopAt - Date.now()) / 1000)) : 0;
  $("rec-stop").textContent = curRec.stopAt ? `Desfazer (${left})` : "Parar e gerar a ata";
  $("rec-pause").textContent = curRec.paused ? "Retomar" : "Pausar";
  $("rec-pause").hidden = Boolean(curRec.stopAt);
  if (curRec.stopAt && left === 0) chrome.runtime.sendMessage({ type: "rec-stop" }).catch(() => {});
}, 500);
setInterval(refreshRec, 2000);

loadSettings();
checkHealth();
checkPage();
refreshRec();
loadTemplates();

// Microfone opcional: só mostra o convite enquanto ainda não foi liberado.
navigator.permissions
  .query({ name: "microphone" })
  .then((status) => {
    const sync = () => ($("mic-allow").hidden = status.state === "granted");
    sync();
    status.addEventListener("change", sync);
  })
  .catch(() => {});
$("mic-allow").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("mic.html") });
  window.close();
});
