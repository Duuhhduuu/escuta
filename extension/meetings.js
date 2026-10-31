// Reuniões, lado do service worker: manda o gravador (recorder.js, num documento
// offscreen) começar e parar, envia o áudio ao servidor, pede a ata e guarda tudo em
// chrome.storage.local como "m:<id>". Usa send/call/fail/withKeepAlive do background.js,
// que é carregado antes deste arquivo.
const MEETING_PREFIX = "m:";
const REC_KEY = "rec"; // gravação em andamento; storage.session sobrevive ao service worker dormir
const LIVE_KEY = "live"; // texto ao vivo da gravação em andamento: { id, lines, error, lag }
const NOTES_KEY = "notes"; // o que a pessoa anota no painel: { id, text }
const SELF_KEY = "selfname"; // o seu nome, lido do quadro da chamada: { id, name }
const SPEAKERS_KEY = "speakers"; // quem falou na chamada, lido das legendas do Meet: { id, events: [{ name, t }] }
const GOAL_KEY = "goal"; // objetivo da reunião, escrito antes ou durante: { id, text }
const LIVE_LINES_MAX = 5000;
const LIVE_SAVED_MAX = 20_000; // falas guardadas na reunião enquanto grava (horas de conversa)

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

// A extensão não usa selo no ícone: o painel e as telas dizem o estado. Limpa o que uma versão antiga deixou.
chrome.action.setBadgeText({ text: "" });

// ---- documento offscreen ------------------------------------------------------

async function ensureOffscreen(source) {
  const open = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (open.length) return;
  // O Chrome fecha, depois de 30 s sem tocar som, um documento criado com AUDIO_PLAYBACK. Na aba, o
  // gravador toca o som de volta, então vale. Na chamada do Meet quem toca é a página: o gravador
  // não toca nada, e com esse motivo ele seria fechado no meio da reunião.
  const page = source === "page";
  await chrome.offscreen.createDocument({
    url: "recorder.html",
    reasons: page ? ["USER_MEDIA"] : ["USER_MEDIA", "AUDIO_PLAYBACK"],
    justification: page ? "Gravar o áudio da chamada do Meet." : "Gravar o áudio da reunião e manter o som da aba tocando enquanto grava.",
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

async function startMeeting({ streamId, tabId, title, template, mic, source, goal }) {
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
  await chrome.storage.session.remove([LIVE_KEY, NOTES_KEY, GOAL_KEY]); // texto, notas e objetivo da reunião anterior
  try {
    await ensureOffscreen(source);
  } catch (err) {
    logRec(`gravador: não preparou (${err.message || err})`);
    return fail("offscreen", `Não consegui preparar o gravador: ${err.message || err}`);
  }
  const res = await toOffscreen({ type: "start", streamId, recId: id, live, mic, source });
  if (!res?.ok) {
    await closeOffscreen();
    logRec(`gravador: recusou a captura (${res?.name || ""} ${res?.message || "sem resposta"})`);
    return fail("capture", res?.message || "Não consegui capturar o áudio desta aba.");
  }

  if (source === "page") {
    // O gravador está de pé; agora a página começa a mandar o áudio.
    try {
      await chrome.tabs.sendMessage(tabId, { type: "meet-capture", action: "start" });
    } catch (err) {
      await toOffscreen({ type: "stop" });
      await closeOffscreen();
      logRec(`página do Meet não respondeu (${err.message || err}); recarregue o Meet e tente de novo`);
      return fail("page", "A página do Meet não respondeu. Recarregue o Meet e tente de novo.");
    }
  }
  // Nomes de quem fala: só no Google Meet, que mostra o nome nas legendas.
  await chrome.storage.session.set({ [SPEAKERS_KEY]: { id, events: [] }, [SELF_KEY]: { id, name: "" } });
  const onMeet = await chrome.tabs.get(tabId).then((t) => /^https:\/\/meet\.google\.com\//.test(t.url || ""), () => false);
  if (onMeet) chrome.tabs.sendMessage(tabId, { type: "meet-speakers", action: "start" }).catch(() => {});
  const startedAt = Date.now();
  // A reunião existe desde já: o texto ao vivo vai sendo salvo nela, então nada se perde se o
  // navegador cair. A ata só é escrita no fim, a partir da transcrição completa.
  await saveMeeting({
    id,
    kind: "meeting",
    title: (title || "Reunião").slice(0, 120),
    at: startedAt,
    duration: null,
    template: template || "reuniao",
    language: settings.language,
    mic: res.mic,
    notes: "",
    goal: goal && String(goal).trim() ? String(goal).trim().slice(0, 500) : "",
    status: "recording",
    provisional: true, // o texto ainda é o ao vivo; a transcrição completa o substitui
    segments: [],
    minutes: null,
  });
  await setRec({
    state: "recording",
    source: source || "tab",
    id,
    tabId,
    title: (title || "Reunião").slice(0, 120),
    template: template || "reuniao",
    startedAt,
    mic: res.mic,
    micError: res.micError || null,
    live: settings.live !== false, // pedido pela pessoa; se o captador subiu, quem diz é liveReady
    language: settings.language,
  });
  if (goal && String(goal).trim()) await chrome.storage.session.set({ [GOAL_KEY]: { id, text: String(goal).trim().slice(0, 500) } });
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

// Parar não é imediato: há uma janela para desfazer (como "desfazer envio" do e-mail). A gravação
// continua durante ela; o painel e o popup mostram a contagem e o botão Desfazer.
const STOP_DELAY_MS = 8000;
let stopTimer = 0;

async function stopSoon() {
  const rec = await getRec();
  if (!rec) return fail("idle", "Nenhuma gravação em andamento.");
  const stopAt = Date.now() + STOP_DELAY_MS;
  await setRec({ ...rec, stopAt });
  clearTimeout(stopTimer);
  stopTimer = setTimeout(() => stopMeeting().catch(() => {}), STOP_DELAY_MS + 300);
  return { ok: true, data: { stopAt } };
}

async function stopCancel() {
  const rec = await getRec();
  clearTimeout(stopTimer);
  if (rec?.stopAt) await setRec({ ...rec, stopAt: null });
  return { ok: true, data: {} };
}

async function pauseMeeting(pause) {
  const rec = await getRec();
  if (!rec) return fail("idle", "Nenhuma gravação em andamento.");
  if (Boolean(rec.paused) === pause) return { ok: true, data: {} };
  const res = await toOffscreen({ type: pause ? "pause" : "resume" });
  if (!res?.ok) {
    logRec(`${pause ? "pausar" : "retomar"} não deu: ${res?.message || "o gravador não respondeu"}`);
    return fail("pause", res?.message || "O gravador não respondeu. Pare a gravação e comece de novo.");
  }
  const now = Date.now();
  await setRec({ ...rec, paused: pause, pausedAt: pause ? now : null, pausedMs: (rec.pausedMs || 0) + (pause ? 0 : now - rec.pausedAt) });
  logRec(pause ? "gravação pausada" : "gravação retomada");
  return { ok: true, data: {} };
}

// Gravou sem querer (ou sem querer que ficasse): joga fora, sem ata e sem deixar nada no disco.
async function discardMeeting() {
  const rec = await getRec();
  if (!rec) return fail("idle", "Nenhuma gravação em andamento.");
  clearTimeout(stopTimer);
  if (rec.source === "page") await chrome.tabs.sendMessage(rec.tabId, { type: "meet-capture", action: "stop" }).catch(() => {});
  await toOffscreen({ type: "stop" });
  await closeOffscreen();
  await RecDB.drop(rec.id).catch(() => {});
  await saveChain;
  await chrome.storage.local.remove(MEETING_PREFIX + rec.id); // a reunião criada ao começar vai junto
  await chrome.storage.session.remove([LIVE_KEY, NOTES_KEY, GOAL_KEY]);
  await setRec(null);
  logRec("gravação descartada pela pessoa");
  return { ok: true, data: {} };
}

async function stopMeeting() {
  const rec = await getRec();
  if (!rec || stopping) return fail("idle", "Nenhuma gravação em andamento.");
  stopping = true;
  clearTimeout(stopTimer);
  try {
    if (rec.source === "page") await chrome.tabs.sendMessage(rec.tabId, { type: "meet-capture", action: "stop" }).catch(() => {});
    chrome.tabs.sendMessage(rec.tabId, { type: "meet-speakers", action: "stop" }).catch(() => {});
    const res = await toOffscreen({ type: "stop" });
    logRec(res?.ok ? `parou: ${Math.round(res.duration)} s gravados, ${res.chunks} pedaços` : `parou com aviso: ${res?.message}`);
    await closeOffscreen();
    const written = (await chrome.storage.session.get(NOTES_KEY))[NOTES_KEY];
    const notes = written?.id === rec.id ? String(written.text || "").trim() : "";
    const goalWritten = (await chrome.storage.session.get(GOAL_KEY))[GOAL_KEY];
    const goal = goalWritten?.id === rec.id ? String(goalWritten.text || "").trim() : "";
    // O nome que a pessoa escreveu no popup vale mais que o lido do quadro, que pode errar.
    const typed = String((await chrome.storage.sync.get({ myName: "" })).myName || "").trim();
    const seen = (await chrome.storage.session.get(SELF_KEY))[SELF_KEY];
    const me = (typed || (seen?.id === rec.id ? seen.name : "") || "").slice(0, 80);
    const heard = (await chrome.storage.session.get(SPEAKERS_KEY))[SPEAKERS_KEY];
    // [segundo desde o início, nome]: é o que cruza com o horário de cada trecho da transcrição
    const speakers = heard?.id === rec.id ? heard.events.map((e) => [Math.round(((e.t - rec.startedAt) / 1000) * 10) / 10, e.name]) : [];
    // Mesmo que o gravador não responda, o que já foi salvo em disco ainda dá uma reunião.
    await new Promise((resolve) => setTimeout(resolve, 400)); // as últimas falas ainda estão a caminho do service worker
    await saveChain; // o último texto ao vivo chega antes de a reunião mudar de estado
    await updateLive((cur) => ({ ...cur, partial: {} })); // parou: não sobra texto provisório no painel
    const kept = await getMeeting(rec.id);
    await saveMeeting({
      ...(kept || {}),
      id: rec.id,
      kind: "meeting",
      title: rec.title,
      at: rec.startedAt,
      duration: res?.duration ?? (Date.now() - rec.startedAt) / 1000,
      template: rec.template,
      language: rec.language,
      mic: rec.mic,
      notes,
      goal,
      speakers,
      me,
      status: "processing",
      stage: "upload",
      progress: 0,
      provisional: true,
      segments: kept?.segments || [], // o texto ao vivo fica até a transcrição completa chegar
      minutes: null,
      error: res?.ok === false ? res.message : null,
    });
    await setRec(null);
  } finally {
    stopping = false;
  }
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
        goal: entry.goal || "",
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

// Dá nome aos trechos dos participantes: a legenda do Meet chega um pouco depois da voz, então olha
// uma janela em volta do trecho e fica com o nome que mais apareceu nela.
const NAME_BEFORE = 1;
const NAME_AFTER = 2.5;
function nameSpeakers(segments, speakers, me = "") {
  if (!speakers?.length && !me) return segments;
  return segments.map((seg) => {
    if (seg.who === "voce") return me ? { ...seg, speaker: me } : seg; // a sua fala leva o seu nome
    if (seg.who !== "outros" || !speakers?.length) return seg;
    const count = new Map();
    for (const [t, name] of speakers) if (t >= seg.start - NAME_BEFORE && t <= seg.end + NAME_AFTER) count.set(name, (count.get(name) || 0) + 1);
    const best = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
    return best ? { ...seg, speaker: best[0] } : seg;
  });
}

// Eco: sem fones o microfone repete o que saiu no alto-falante. A fala "sua" que coincide no tempo
// e no texto com a de um participante é eco, não você (mesma regra do painel ao vivo).
const foldText = (s) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const wordSet = (s) => new Set(foldText(s).replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean));
function sameSaid(a, b) {
  const x = wordSet(a);
  const y = wordSet(b);
  if (!x.size || !y.size) return false;
  let common = 0;
  for (const w of x) if (y.has(w)) common++;
  return common / new Set([...x, ...y]).size >= 0.7;
}
function dropEcho(segments) {
  const others = segments.filter((s) => s.who === "outros");
  return segments.filter((s) => s.who !== "voce" || !others.some((o) => Math.abs(o.start - s.start) <= 4 && sameSaid(o.text, s.text)));
}

// O texto ao vivo basta quando não perdeu nenhuma janela e tem fala: a ata sai na hora, sem refazer a transcrição.
function liveIsEnough(entry) {
  if (entry.liveLost || !entry.provisional) return false;
  const text = (entry.segments || []).map((s) => s.text || "").join(" ").trim();
  if (!text) return false;
  const seconds = entry.duration || 0;
  return seconds < 30 || text.length >= seconds * 0.2; // fala normal passa de 10 caracteres por segundo; isto só barra o quase vazio
}

async function processMeetingNow(id) {
  const entry = await getMeeting(id);
  if (!entry) return;

  if (liveIsEnough(entry)) {
    // A transcrição ao vivo já ficou pronta durante a reunião, com o nome de quem falou: vai direto para a ata.
    const segments = nameSpeakers(dropEcho(entry.segments), entry.speakers, entry.me);
    await patchMeeting(id, { status: "processing", stage: "minutes", progress: 1, error: null, provisional: false, segments });
    logRec(`ata pelo texto ao vivo (${segments.length} trechos)`);
    await writeMinutes(id, entry.template);
    await RecDB.drop(id).catch(() => {}); // sem refazer a transcrição, o áudio não precisa mais ficar
    return;
  }

  await patchMeeting(id, { status: "processing", stage: "upload", progress: 0, error: null });

  const blob = await RecDB.blob(id, "audio/webm");
  if (!blob.size) {
    await patchMeeting(id, { status: "failed", error: "A gravação ficou vazia." });
    return;
  }

  const settings = await getSettings();
  const result = await transcribeMeeting(blob, settings, (stage, progress) => patchMeeting(id, { stage, progress }));
  if (!result.ok) {
    // O áudio continua guardado: "Tentar de novo" na página de transcrições refaz daqui.
    logRec(`servidor: falhou (${result.message || result.code})`);
    await patchMeeting(id, { status: "failed", error: result.message || result.code, errorCode: result.code });
    return;
  }

  await patchMeeting(id, {
    provisional: false,
    segments: nameSpeakers(result.data.segments, entry.speakers, entry.me),
    duration: result.data.duration || entry.duration,
    mic: result.data.mic,
    stage: "minutes",
    progress: 1,
  });
  logRec(`transcrição pronta: ${result.data.segments.length} trechos`);
  await RecDB.drop(id).catch(() => {}); // a transcrição já está salva; o áudio não precisa mais ficar
  await writeMinutes(id, entry.template);
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
    if (entry?.kind === "meeting" && entry.status === "recording" && !running.has(entry.id)) {
      // Gravação cortada no meio: o texto ao vivo até ali está salvo, e o áudio, se ficou no disco, ainda dá para transcrever.
      await patchMeeting(entry.id, {
        status: "failed",
        error: "A gravação foi interrompida (o navegador fechou?). O texto até ali ficou salvo, e o que foi gravado ainda pode ser transcrito.",
      });
    }
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

// Chamada do Meet começou ou terminou (meet-hook.js, na página). Com a gravação automática ligada,
// começa e termina sozinha; sem ela, nada acontece.
async function meetCall(msg, sender) {
  const tabId = sender.tab?.id;
  if (tabId == null) return;
  const rec = await getRec();
  if (msg.state === "started") {
    if (rec || !canRecord()) return;
    const { autoMeet, template } = await chrome.storage.sync.get({ autoMeet: false, template: "reuniao" });
    if (!autoMeet) return;
    logRec(`chamada do Meet começou na aba ${tabId}: gravando sozinho`);
    const res = await startMeeting({ source: "page", tabId, title: sender.tab.title || msg.title || "Reunião do Meet", template });
    if (!res.ok) logRec(`gravação automática não começou: ${res.message}`);
  } else if (msg.state === "ended" && rec?.source === "page" && rec.tabId === tabId) {
    logRec("chamada do Meet terminou: parando e gerando a ata");
    stopMeeting();
  }
}

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

// O texto ao vivo também vai para a reunião, em fila para cada trecho ler, somar e gravar sem pisar no outro.
let saveChain = Promise.resolve();
function keepLiveLines(id, lines) {
  saveChain = saveChain
    .then(async () => {
      const m = await getMeeting(id);
      if (!m || m.status !== "recording") return; // parou no meio: a transcrição completa assume
      // Os sons (hum, tosse, ruído) aparecem no painel, mas não entram na transcrição salva nem na ata.
      const merged = [...(m.segments || []), ...lines.filter((l) => l?.text && !l.sound)].sort((a, b) => a.start - b.start).slice(-LIVE_SAVED_MAX);
      await patchMeeting(id, { segments: merged });
    })
    .catch((err) => console.warn("[escuta] salvar texto ao vivo:", err));
  return saveChain;
}

async function liveText(lines) {
  const rec = await getRec();
  if (!rec?.live || !Array.isArray(lines)) return; // chegou depois de parar, ou ninguém pediu
  await updateLive((cur) => {
    // A fala fechou: o texto provisório daquele lado sai e o ponto até onde há texto definitivo avança.
    const cut = { ...(cur.cut || {}) };
    const partial = { ...(cur.partial || {}) };
    for (const l of lines) {
      cut[l.who] = Math.max(cut[l.who] || 0, l.end);
      partial[l.who] = [];
    }
    return { ...cur, id: rec.id, lines: [...cur.lines, ...lines].slice(-LIVE_LINES_MAX), cut, partial };
  });
  await keepLiveLines(rec.id, lines);
}

// Texto provisório da frase em andamento. Fica só na sessão (para o painel); não vai para a reunião.
async function livePartial({ who, t0, lines }) {
  const rec = await getRec();
  if (!rec?.live || (who !== "voce" && who !== "outros")) return;
  await updateLive((cur) => {
    if (lines?.length && t0 < (cur.cut?.[who] || 0) - 0.2) return cur; // chegou depois de a fala fechar
    return { ...cur, id: rec.id, partial: { ...(cur.partial || {}), [who]: Array.isArray(lines) ? lines : [] } };
  });
}

async function liveStatus({ error, lag, lost }) {
  const rec = await getRec();
  if (!rec?.live) return;
  // Uma janela se perdeu: o texto ao vivo tem buraco, então no fim a transcrição completa assume.
  if (lost || lag) await patchMeeting(rec.id, { liveLost: true });
  await updateLive((cur) => ({ ...cur, id: rec.id, error: error === undefined ? cur.error : error, lag: lag ?? (error === null ? false : cur.lag) }));
}

// ---- mensagens ---------------------------------------------------------------------

// Pergunta sobre uma reunião. A conversa fica guardada na própria reunião (m.chat), então ao
// reabrir ela continua lá. O servidor recebe a ata, as notas, a transcrição e as últimas trocas.
async function addSelf({ name }) {
  const rec = await getRec();
  if (!rec || !name) return { ok: true };
  await chrome.storage.session.set({ [SELF_KEY]: { id: rec.id, name: String(name).slice(0, 80) } });
  return { ok: true };
}

async function addSpeaker({ name, t }) {
  const rec = await getRec();
  if (!rec || !name) return { ok: true };
  const held = (await chrome.storage.session.get(SPEAKERS_KEY))[SPEAKERS_KEY];
  if (held?.id !== rec.id) return { ok: true };
  if (held.events.length < 20_000) held.events.push({ name: String(name).slice(0, 80), t });
  await chrome.storage.session.set({ [SPEAKERS_KEY]: held });
  return { ok: true };
}

async function askMeeting({ id, question }) {
  const m = await getMeeting(id);
  if (!m) return fail("gone", "Reunião apagada.");
  const text = String(question || "").trim();
  if (!text) return fail("empty_text", "Escreva a pergunta.");
  const settings = await getSettings();
  const res = await withKeepAlive(() =>
    call(
      "/ask",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: text,
          segments: m.segments || [],
          minutes: m.minutes || "",
          notes: m.notes || "",
          goal: m.goal || "",
          history: (m.chat || []).slice(-12),
          language: settings.language,
          model: settings.ollamaModel,
        }),
      },
      3 * 60_000,
    ),
  );
  if (!res.ok) return res;
  const at = Date.now();
  // Relê: a reunião pode ter mudado enquanto o modelo respondia (ata refeita, outra pergunta).
  const current = await getMeeting(id);
  if (current) {
    await patchMeeting(id, {
      chat: [...(current.chat || []), { role: "user", content: text, at }, { role: "assistant", content: res.data.answer, at }],
    });
  }
  return res;
}

function meetingHandle(msg) {
  switch (msg.type) {
    case "meet-speaker":
      return addSpeaker(msg);
    case "meet-self":
      return addSelf(msg);
    case "meeting-ask":
      return askMeeting(msg);
    case "meeting-goal":
      // O objetivo pode ser escrito ou mudado depois; vale na próxima ata gerada.
      return patchMeeting(msg.id, { goal: String(msg.goal || "").trim().slice(0, 500) }).then((m) => (m ? { ok: true, data: {} } : fail("gone", "Reunião apagada.")));
    case "rec-state":
      return (async () => {
        let rec = await getRec();
        // "Gravando", mas o gravador não existe mais (extensão recarregada, aba do navegador
        // que o hospedava foi morta): o que ficou no disco vira uma reunião para tentar de novo.
        if (rec && canRecord() && !(await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length) {
          const lost = rec;
          await setRec(null);
          await recoverOrphans(lost);
          rec = null;
        }
        if (rec?.stopAt && Date.now() >= rec.stopAt && !stopping) stopMeeting().catch(() => {});
        return { ok: true, data: { canRecord: canRecord(), rec } };
      })();
    case "rec-start":
      return startMeeting(msg);
    case "rec-stop-soon":
      return stopSoon();
    case "rec-stop-cancel":
      return stopCancel();
    case "rec-pause":
      return pauseMeeting(true);
    case "rec-resume":
      return pauseMeeting(false);
    case "rec-discard":
      return discardMeeting();
    case "rec-stop":
    case "rec-ended": // o gravador avisa que a captura da aba terminou
      return stopMeeting();
    case "dock-open":
      return showLive(msg.tabId).then((panel) => ({ ok: true, data: panel }));
    case "live-text":
      return liveText(msg.lines).then(() => ({ ok: true }));
    case "live-partial":
      return livePartial(msg).then(() => ({ ok: true }));
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
        if (entry.segments?.length && !entry.provisional) {
          // O áudio já foi transcrito; só a ata falhou.
          withKeepAlive(() => writeMinutes(msg.id, entry.template)).catch(() => {});
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
