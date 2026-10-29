// Reuniões, lado do service worker: manda o gravador (recorder.js, num documento
// offscreen) começar e parar, envia o áudio ao servidor, pede a ata e guarda tudo em
// chrome.storage.local como "m:<id>". Usa send/call/fail/withKeepAlive do background.js,
// que é carregado antes deste arquivo.
const MEETING_PREFIX = "m:";
const REC_KEY = "rec"; // gravação em andamento; storage.session sobrevive ao service worker dormir
const LIVE_KEY = "live"; // texto ao vivo da gravação em andamento: { id, lines, error, lag }
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

// ---- gravar ---------------------------------------------------------------------

async function startMeeting({ streamId, tabId, title, template }) {
  if (!canRecord()) return fail("unsupported", "Gravar reunião só funciona no Chrome e no Brave.");
  if (await getRec()) return fail("busy", "Já existe uma gravação em andamento.");

  const id = crypto.randomUUID();
  const settings = await getSettings();
  // O gravador não tem chrome.storage; o que ele precisa para falar com o servidor vai junto.
  const live =
    settings.live === false
      ? null
      : { base: BASE, language: settings.language, model: await resolveModel(settings.whisperModel), token: await getToken() };
  await chrome.storage.session.remove(LIVE_KEY); // texto ao vivo da reunião anterior
  try {
    await ensureOffscreen();
  } catch (err) {
    return fail("offscreen", `Não consegui preparar o gravador: ${err.message || err}`);
  }
  const res = await toOffscreen({ type: "start", streamId, recId: id, live });
  if (!res?.ok) {
    await closeOffscreen();
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
    live: Boolean(res.live),
    language: settings.language,
  });
  setBadge("REC", "#b42318");
  return { ok: true, data: { id, mic: res.mic, micError: res.micError || null, live: Boolean(res.live) } };
}

let stopping = false;

async function stopMeeting() {
  const rec = await getRec();
  if (!rec || stopping) return fail("idle", "Nenhuma gravação em andamento.");
  stopping = true;
  try {
    const res = await toOffscreen({ type: "stop" });
    await closeOffscreen();
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
      body: JSON.stringify({ segments: entry.segments, template, language: settings.language, model: settings.ollamaModel }),
    },
    15 * 60_000,
  );
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
  await RecDB.drop(id).catch(() => {}); // a transcrição já está salva; o áudio não precisa mais ficar
  await writeMinutes(id, entry.template);
  setBadge("✓", "#1a8f5a");
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
    case "live-text":
      return liveText(msg.lines).then(() => ({ ok: true }));
    case "live-status":
      return liveStatus(msg).then(() => ({ ok: true }));
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
