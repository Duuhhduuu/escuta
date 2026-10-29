// Reuniões, lado do service worker: manda o gravador (recorder.js, num documento
// offscreen) começar e parar, envia o áudio ao servidor, pede a ata e guarda tudo em
// chrome.storage.local como "m:<id>". Usa send/call/fail/withKeepAlive do background.js,
// que é carregado antes deste arquivo.
const MEETING_PREFIX = "m:";
const REC_KEY = "rec"; // gravação em andamento; storage.session sobrevive ao service worker dormir
const LIVE_KEY = "live"; // texto ao vivo da gravação em andamento: { id, lines, error, lag }
const NOTES_KEY = "notes"; // o que a pessoa anota no painel: { id, text }
const LIVE_LINES_MAX = 5000;

const canRecord = () => Boolean(chrome.offscreen && chrome.tabCapture);

const getRec = async () => (await chrome.storage.session.get(REC_KEY))[REC_KEY] || null;
const setRec = (rec) => (rec ? chrome.storage.session.set({ [REC_KEY]: rec }) : chrome.storage.session.remove(REC_KEY));

const getMeeting = async (id) => (await chrome.storage.local.get(MEETING_PREFIX + id))[MEETING_PREFIX + id] || null;
const saveMeeting = (entry) => chrome.storage.local.set({ [MEETING_PREFIX + entry.id]: entry });

async function patchMeeting(id, patch) {
  const current = await getMeeting(id);
  if (!current) return null; // apagada enquanto processava
  const next = { ...current, ...patch };
  await saveMeeting(next);
  return next;
}

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

// ---- documento offscreen ------------------------------------------------------

async function ensureOffscreen() {
  const open = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (open.length) return;
  await chrome.offscreen.createDocument({
    url: "recorder.html",
    reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
    justification: "Gravar o áudio da reunião e manter o som da aba tocando enquanto grava.",
  });
}

const closeOffscreen = () => chrome.offscreen.closeDocument().catch(() => {});

const toOffscreen = (message) =>
  chrome.runtime.sendMessage({ target: "offscreen", ...message }).catch((err) => ({ ok: false, message: String(err?.message || err) }));

// ---- registro --------------------------------------------------------------------------

// As últimas etapas da gravação ficam em storage.session e o popup as mostra. Sem isso, quando
// algo não aparece, ninguém sabe em que passo parou (nem eu, olhando de fora).
const LOG_KEY = "reclog";
const LOG_MAX = 40;
let logChain = Promise.resolve();

function logRec(line) {
  console.log("[escuta]", line);
  logChain = logChain
    .then(async () => {
      const current = (await chrome.storage.session.get(LOG_KEY))[LOG_KEY] || [];
      await chrome.storage.session.set({ [LOG_KEY]: [...current, { at: Date.now(), line }].slice(-LOG_MAX) });
    })
    .catch(() => {});
  return logChain;
}

// ---- painel dentro da aba da reunião ----------------------------------------------------

// dock.js desenha o painel flutuante na página. Só funciona numa aba que a pessoa acabou de
// invocar (activeTab). Devolve { ok } ou { ok: false, error } com o motivo.
async function openDock(tabId) {
  if (!chrome.scripting || tabId == null) return { ok: false, error: "sem aba para o painel" };
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["dock.js"] });
    return { ok: true };
  } catch (err) {
    const error = String(err?.message || err);
    console.warn("[escuta] não consegui abrir o painel na aba:", error);
    return { ok: false, error };
  }
}

// Alternativa quando a página não aceita o painel: uma janela ao lado, colada na borda direita da
// janela do navegador. Aberta aqui (e não no popup, que já fechou a esta altura).
async function openLiveWindow(tabId) {
  try {
    const url = chrome.runtime.getURL("live.html");
    const [existing] = await chrome.tabs.query({ url }).catch(() => []);
    if (existing) {
      await chrome.windows.update(existing.windowId, { focused: true });
      return true;
    }
    const size = { width: 400, height: 720 };
    const place = {};
    try {
      const tab = await chrome.tabs.get(tabId);
      const win = await chrome.windows.get(tab.windowId);
      place.left = Math.max(0, (win.left ?? 0) + (win.width ?? 1280) - size.width - 12);
      place.top = (win.top ?? 0) + 40;
      size.height = Math.min(780, Math.max(480, (win.height ?? 800) - 80));
    } catch {
      // sem a posição da janela, o navegador escolhe
    }
    await chrome.windows.create({ url, type: "popup", ...size, ...place });
    return true;
  } catch (err) {
    console.warn("[escuta] não consegui abrir a janela ao vivo:", err.message || err);
    return false;
  }
}

// Painel na aba; se não der, janela solta. Sempre aparece alguma coisa.
async function showLive(tabId) {
  const docked = await openDock(tabId);
  if (docked.ok) return { dock: true, window: false, dockError: null };
  const opened = await openLiveWindow(tabId);
  return { dock: false, window: opened, dockError: docked.error };
}

// ---- gravar ---------------------------------------------------------------------

async function startMeeting({ streamId, tabId, title, template, mic }) {
  if (!canRecord()) return fail("unsupported", "Gravar reunião só funciona no Chrome e no Brave.");
  if (await getRec()) return fail("busy", "Já existe uma gravação em andamento.");

  await chrome.storage.session.remove(LOG_KEY); // o registro é sempre o da última gravação
  logRec(`pedido para gravar a aba ${tabId} ("${String(title || "").slice(0, 60)}")`);
  const id = crypto.randomUUID();
  const settings = await getSettings();
  // O gravador não tem chrome.storage; o que ele precisa para falar com o servidor vai junto.
  const live =
    settings.live === false
      ? null
      : { base: BASE, language: settings.language, model: await resolveModel(settings.whisperModel), token: await getToken() };
  await chrome.storage.session.remove([LIVE_KEY, NOTES_KEY]); // texto e notas da reunião anterior
  try {
    await ensureOffscreen();
  } catch (err) {
    logRec(`gravador: não preparou (${err.message || err})`);
    return fail("offscreen", `Não consegui preparar o gravador: ${err.message || err}`);
  }
  const res = await toOffscreen({ type: "start", streamId, recId: id, live, mic });
  if (!res?.ok) {
    await closeOffscreen();
    logRec(`gravador: recusou a captura (${res?.name || ""} ${res?.message || "sem resposta"})`);
    return fail("capture", res?.message || "Não consegui capturar o áudio desta aba.");
  }

  await setRec({
    state: "recording",
    id,
    tabId,
    title: (title || "Reunião").slice(0, 120),
    template: template || "reuniao",
    startedAt: Date.now(),
    mic: res.mic,
    micError: res.micError || null,
    live: settings.live !== false, // pedido pela pessoa; se o captador subiu, quem diz é liveReady
    language: settings.language,
  });
  setBadge("REC", "#b42318");
  logRec(
    `gravando: ${res.mic ? "microfone ok" : `sem microfone (${res.micError || "?"})`}; ` +
      (settings.live === false ? "ao vivo desligado" : res.live ? "áudio ao vivo ok" : `áudio ao vivo indisponível (${res.liveError || "?"})`),
  );

  // O painel abre sempre que a pessoa pediu o ao vivo, mesmo que o captador de áudio não tenha
  // subido: ele mostra o motivo e as notas continuam servindo.
  let panel = { dock: false, window: false, dockError: null };
  if (settings.live !== false) {
    if (res.liveError) await updateLive((cur) => ({ ...cur, id, error: `Texto ao vivo indisponível: ${res.liveError}` }));
    panel = await showLive(tabId);
    await setRec({ ...(await getRec()), ...panel });
    logRec(
      panel.dock
        ? "painel: aberto dentro da aba"
        : panel.window
          ? `painel: a página recusou (${panel.dockError}); abri uma janela ao lado`
          : `painel: não abriu (${panel.dockError})`,
    );
  }
  return {
    ok: true,
    data: { id, mic: res.mic, micError: res.micError || null, live: settings.live !== false, liveReady: Boolean(res.live), ...panel },
  };
}

let stopping = false;

async function stopMeeting() {
  const rec = await getRec();
  if (!rec || stopping) return fail("idle", "Nenhuma gravação em andamento.");
  stopping = true;
  try {
    const res = await toOffscreen({ type: "stop" });
    logRec(res?.ok ? `parou: ${Math.round(res.duration)} s gravados, ${res.chunks} pedaços` : `parou com aviso: ${res?.message}`);
    await closeOffscreen();
    const written = (await chrome.storage.session.get(NOTES_KEY))[NOTES_KEY];
    const notes = written?.id === rec.id ? String(written.text || "").trim() : "";
    // Mesmo que o gravador não responda, o que já foi salvo em disco ainda dá uma reunião.
    await saveMeeting({
      id: rec.id,
      kind: "meeting",
      title: rec.title,
      at: rec.startedAt,
      duration: res?.duration ?? (Date.now() - rec.startedAt) / 1000,
      template: rec.template,
      language: rec.language,
      mic: rec.mic,
      notes,
      status: "processing",
      stage: "upload",
      progress: 0,
      segments: [],
      minutes: null,
      error: res?.ok === false ? res.message : null,
    });
    await setRec(null);
  } finally {
    stopping = false;
  }
  setBadge("…", "#3347ff");
  processMeeting(rec.id).catch((err) => console.warn("[escuta] reunião:", err));
  return { ok: true, data: { id: rec.id } };
}

// ---- servidor ---------------------------------------------------------------------

async function transcribeMeeting(blob, settings, onStage) {
  const query = new URLSearchParams({ language: settings.language, model: await resolveModel(settings.whisperModel) });
  const path = `/meeting?${query}`;
  const res = await send(path, { method: "POST", body: blob }, 3 * 60 * 60_000);
  if (!(res instanceof Response)) return res;
  if (!res.ok) return parse(res);

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
        if (item.error) return fail(item.error, item.message);
        if (item.done) return { ok: true, data: item };
        if (item.stage) await onStage(item.stage, item.progress ?? null);
      }
    }
  } catch (err) {
    return fetchFailed(path, err);
  }
  return fail("error", "O servidor parou no meio da transcrição.");
}

async function writeMinutes(id, template) {
  const entry = await getMeeting(id);
  if (!entry) return fail("gone", "Reunião apagada.");
  if (!entry.segments.some((s) => s.text)) {
    await patchMeeting(id, { status: "done", stage: null, minutes: null, minutesError: "Nenhuma fala reconhecida na gravação." });
    return fail("empty", "Nenhuma fala reconhecida.");
  }
  const settings = await getSettings();
  await patchMeeting(id, { template, status: "processing", stage: "minutes", minutesError: null });
  const res = await call(
    "/minutes",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        segments: entry.segments,
        notes: entry.notes || "",
        template,
        language: settings.language,
        model: settings.ollamaModel,
      }),
    },
    15 * 60_000,
  );
  logRec(res.ok ? "ata gerada" : `ata falhou (${res.message || res.code})`);
  await patchMeeting(
    id,
    res.ok
      ? { status: "done", stage: null, minutes: res.data.minutes, minutesError: null }
      : { status: "done", stage: null, minutesError: res.message || res.code },
  );
  return res;
}

const running = new Set(); // reuniões sendo processadas agora, para "Tentar de novo" duas vezes não duplicar

async function processMeeting(id) {
  if (running.has(id)) return;
  running.add(id);
  try {
    await withKeepAlive(() => processMeetingNow(id));
  } finally {
    running.delete(id);
  }
}

async function processMeetingNow(id) {
  const entry = await getMeeting(id);
  if (!entry) return;
  await patchMeeting(id, { status: "processing", stage: "upload", progress: 0, error: null });

  const blob = await RecDB.blob(id, "audio/webm");
  if (!blob.size) {
    await patchMeeting(id, { status: "failed", error: "A gravação ficou vazia." });
    setBadge("", null);
    return;
  }

  const settings = await getSettings();
  const result = await transcribeMeeting(blob, settings, (stage, progress) => patchMeeting(id, { stage, progress }));
  if (!result.ok) {
    // O áudio continua guardado: "Tentar de novo" na página de transcrições refaz daqui.
    logRec(`servidor: falhou (${result.message || result.code})`);
    await patchMeeting(id, { status: "failed", error: result.message || result.code, errorCode: result.code });
    setBadge("!", "#b42318");
    return;
  }

  await patchMeeting(id, {
    segments: result.data.segments,
    duration: result.data.duration || entry.duration,
    mic: result.data.mic,
    stage: "minutes",
    progress: 1,
  });
  logRec(`transcrição pronta: ${result.data.segments.length} trechos`);
  await RecDB.drop(id).catch(() => {}); // a transcrição já está salva; o áudio não precisa mais ficar
  await writeMinutes(id, entry.template);
  setBadge("✓", "#1a8f5a");
}

// ---- começar sozinho depois da permissão do microfone -------------------------------------------

// A primeira gravação precisa da permissão de microfone, que só dá para pedir numa aba normal. O
// popup fecha assim que essa aba abre, então a pessoa nunca via o aviso de "grave de novo" e a
// gravação simplesmente não começava. Agora o popup deixa o pedido guardado, e quando a permissão
// sai a gravação começa sozinha e a pessoa volta para a reunião.
const PENDING_KEY = "pendingRec";
const PENDING_MAX_MS = 5 * 60_000;

async function startFromPending() {
  const stored = (await chrome.storage.session.get(PENDING_KEY))[PENDING_KEY];
  await chrome.storage.session.remove(PENDING_KEY);
  if (!stored || Date.now() - stored.at > PENDING_MAX_MS) return fail("none", "Nenhuma gravação esperando.");

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: stored.tabId });
  } catch (err) {
    logRec(`captura da aba ${stored.tabId} recusada (${err.message || err})`);
    return fail("capture", `Não consegui capturar a aba da reunião (${err.message || err}). Volte a ela, clique no ícone do Escuta e grave de novo.`);
  }
  const res = await startMeeting({ streamId, tabId: stored.tabId, title: stored.title, template: stored.template });
  if (res.ok) {
    // De volta à reunião, onde o painel já abriu.
    try {
      await chrome.tabs.update(stored.tabId, { active: true });
      const tab = await chrome.tabs.get(stored.tabId);
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch {
      // a aba pode ter fechado; a gravação já está de pé
    }
  }
  return res;
}

// ---- recuperação ------------------------------------------------------------------

// Se o navegador caiu no meio de uma gravação, os pedaços ficaram no disco, sem reunião
// associada. Vira uma reunião "falhou", e Tentar de novo transcreve o que foi salvo.
async function recoverOrphans(lost = null) {
  if (!lost && (await getRec())) return;
  const known = await chrome.storage.local.get(null);

  // Um service worker novo não herda trabalho nenhum: o que ainda está "processando" foi
  // cortado (navegador fechado, extensão recarregada). Sem isso o popup ficaria para sempre
  // em "gerando a ata" e a pessoa não conseguiria gravar de novo.
  for (const entry of Object.values(known)) {
    if (entry?.kind === "meeting" && entry.status === "processing" && !running.has(entry.id)) {
      await patchMeeting(entry.id, {
        status: "failed",
        error: "O processamento foi interrompido (o navegador fechou?). Dá para tentar de novo.",
      });
    }
  }

  for (const id of await RecDB.ids()) {
    if (known[MEETING_PREFIX + id]) continue;
    await saveMeeting({
      id,
      kind: "meeting",
      title: lost?.id === id ? lost.title : "Gravação interrompida",
      at: lost?.id === id ? lost.startedAt : Date.now(),
      duration: lost?.id === id ? (Date.now() - lost.startedAt) / 1000 : null,
      template: lost?.id === id ? lost.template : "reuniao",
      language: (await getSettings()).language,
      status: "failed",
      segments: [],
      minutes: null,
      error: "A gravação foi interrompida (o navegador fechou?). O que foi salvo ainda pode ser transcrito.",
    });
  }
}

chrome.runtime.onStartup.addListener(() => recoverOrphans().catch(() => {}));
// Também quando o service worker acorda sozinho (extensão recarregada, por exemplo).
recoverOrphans().catch(() => {});

// A aba da reunião fechou: encerra e gera a ata com o que foi gravado.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const rec = await getRec();
  if (rec?.tabId === tabId) stopMeeting();
});

// ---- texto ao vivo -------------------------------------------------------------------

// Vários trechos podem chegar quase juntos; cada um lê, soma e grava, então entram em fila.
let liveChain = Promise.resolve();

function updateLive(change) {
  liveChain = liveChain
    .then(async () => {
      const current = (await chrome.storage.session.get(LIVE_KEY))[LIVE_KEY] || { id: null, lines: [], error: null, lag: false };
      await chrome.storage.session.set({ [LIVE_KEY]: change(current) });
    })
    .catch((err) => console.warn("[escuta] ao vivo:", err));
  return liveChain;
}

async function liveText(lines) {
  const rec = await getRec();
  if (!rec?.live || !Array.isArray(lines)) return; // chegou depois de parar, ou ninguém pediu
  await updateLive((cur) => ({ ...cur, id: rec.id, lines: [...cur.lines, ...lines].slice(-LIVE_LINES_MAX) }));
}

async function liveStatus({ error, lag }) {
  const rec = await getRec();
  if (!rec?.live) return;
  await updateLive((cur) => ({ ...cur, id: rec.id, error: error === undefined ? cur.error : error, lag: lag ?? (error === null ? false : cur.lag) }));
}

// ---- mensagens ---------------------------------------------------------------------

function meetingHandle(msg) {
  switch (msg.type) {
    case "rec-state":
      return (async () => {
        let rec = await getRec();
        // "Gravando", mas o gravador não existe mais (extensão recarregada, aba do navegador
        // que o hospedava foi morta): o que ficou no disco vira uma reunião para tentar de novo.
        if (rec && canRecord() && !(await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length) {
          const lost = rec;
          await setRec(null);
          setBadge("", null);
          await recoverOrphans(lost);
          rec = null;
        }
        if (!rec) {
          const badge = await chrome.action.getBadgeText({});
          if (badge === "✓" || badge === "!") setBadge("", null); // quem abre o popup já viu
        }
        return { ok: true, data: { canRecord: canRecord(), rec } };
      })();
    case "rec-start":
      return startMeeting(msg);
    case "rec-stop":
    case "rec-ended": // o gravador avisa que a captura da aba terminou
      return stopMeeting();
    case "dock-open":
      return showLive(msg.tabId).then((panel) => ({ ok: true, data: panel }));
    case "live-text":
      return liveText(msg.lines).then(() => ({ ok: true }));
    case "live-status":
      return liveStatus(msg).then(() => ({ ok: true }));
    case "rec-pending":
      return chrome.storage.session
        .set({ [PENDING_KEY]: { at: Date.now(), tabId: msg.tabId, title: msg.title, template: msg.template } })
        .then(() => ({ ok: true }));
    case "mic-granted":
      return startFromPending();
    case "rec-log":
      return chrome.storage.session.get(LOG_KEY).then((s) => ({ ok: true, data: { lines: s[LOG_KEY] || [] } }));
    case "templates":
      return call("/templates", { method: "GET" }, 3_000);
    case "meeting-retry":
      return (async () => {
        const entry = await getMeeting(msg.id);
        if (!entry) return fail("gone", "Reunião apagada.");
        if (entry.segments?.length) {
          // O áudio já foi transcrito; só a ata falhou.
          withKeepAlive(() => writeMinutes(msg.id, entry.template)).then(() => setBadge("✓", "#1a8f5a"));
        } else {
          processMeeting(msg.id).catch((err) => console.warn("[escuta] reunião:", err));
        }
        return { ok: true, data: {} };
      })();
    case "meeting-minutes":
      return (async () => {
        withKeepAlive(() => writeMinutes(msg.id, msg.template)).catch(() => {});
        return { ok: true, data: {} };
      })();
    default:
      return null;
  }
}
