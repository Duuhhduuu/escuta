// Janela "ao vivo": fica ao lado da reunião e mostra o texto conforme as pessoas falam.
// O gravador manda as falas para o service worker, que as guarda em chrome.storage.session
// ("live"); aqui é só ler e acompanhar as mudanças.
const $ = (id) => document.getElementById(id);
const WHO = { voce: "Você", outros: "Participantes" };
const STAGES = {
  upload: "Enviando a gravação…",
  decode: "Preparando o áudio…",
  voce: "Transcrevendo a sua voz…",
  outros: "Transcrevendo os participantes…",
  merge: "Juntando as falas…",
  minutes: "Escrevendo a ata…",
};
let heard = []; // nomes lidos das legendas do Meet: [{ name, t }], t em ms
const ECHO_SECONDS = 4;
const ECHO_SIMILARITY = 0.7;

// ?dock=1: esta página é a moldura do painel que o dock.js põe dentro da aba da reunião.
// Sem isso é a janela solta, que serve de alternativa quando a página não aceita o painel.
const dock = new URLSearchParams(location.search).has("dock");
document.body.classList.toggle("dock", dock);
$("tools").hidden = !dock;
const askPage = (action) => parent.postMessage({ escuta: "dock", action }, "*");

let rec = null;
let live = { id: null, lines: [], error: null, lag: false };
let meeting = null;
let notes = { id: null, text: "" };
let goal = { id: null, text: "" };
let seen = 0; // quantas falas já estavam na tela, para saber se chegou coisa nova
let stick = true; // acompanhando o fim; sobe para reler e a janela para de puxar

const fold = (s) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const words = (s) => new Set(fold(s).replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean));

// Parecido o bastante para ser a mesma frase vista por dois caminhos (palavras em comum / total).
function similar(a, b) {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return false;
  let common = 0;
  for (const w of x) if (y.has(w)) common++;
  return common / new Set([...x, ...y]).size >= ECHO_SIMILARITY;
}

// Sem fones o microfone repete o que saiu no alto-falante: a fala "sua" que coincide no tempo
// e no texto com a de um participante é eco, não você.
function withoutEcho(lines) {
  const others = lines.filter((l) => l.who === "outros");
  return lines
    .filter((l) => l.who !== "voce" || !others.some((o) => Math.abs(o.start - l.start) <= ECHO_SECONDS && similar(o.text, l.text)))
    .sort((a, b) => a.start - b.start || (a.who < b.who ? -1 : 1));
}

// O nome que mais apareceu nas legendas em volta da fala (a legenda chega um pouco depois da voz).
function speakerOf(line) {
  if (line.who !== "outros" || !rec || !heard.length) return null;
  const from = rec.startedAt + (line.start - 1) * 1000;
  const to = rec.startedAt + ((line.end ?? line.start) + 2.5) * 1000;
  const count = new Map();
  for (const e of heard) if (e.t >= from && e.t <= to) count.set(e.name, (count.get(e.name) || 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

function stamp(seconds) {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${m}:${s}` : `${m}:${s}`;
}

const clockText = (ms) => stamp(Math.max(0, ms) / 1000);
// Tempo gravado: o parado (pausa) não conta.
const elapsed = (r) => (r.paused ? r.pausedAt : Date.now()) - r.startedAt - (r.pausedMs || 0);

function paintFeed() {
  const lines = withoutEcho(live.lines);
  const feed = $("feed");
  feed.replaceChildren();
  if (!lines.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    const bars = document.createElement("div");
    bars.className = "bars";
    bars.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 5; i++) bars.append(document.createElement("i"));
    const text = document.createElement("p");
    text.textContent = rec
      ? rec.live
        ? "Aguardando a primeira fala…"
        : "A transcrição ao vivo está desligada nesta gravação. A ata sai quando você parar."
      : "Nada para mostrar aqui.";
    empty.append(bars, text);
    feed.append(empty);
    return;
  }
  for (const line of lines) {
    const row = document.createElement("div");
    row.className = line.who === "voce" ? "line me" : "line";
    const meta = document.createElement("div");
    meta.className = "meta";
    const at = Object.assign(document.createElement("span"), { className: "at", textContent: stamp(line.start) });
    const who = Object.assign(document.createElement("span"), { className: "who", textContent: speakerOf(line) || WHO[line.who] || line.who });
    meta.append(at, who);
    row.append(meta, Object.assign(document.createElement("p"), { className: "said", textContent: line.text }));
    feed.append(row);
  }
  // O cursor âmbar fica na última fala enquanto a gravação segue.
  const last = feed.lastElementChild?.querySelector(".said");
  if (rec && last) last.append(Object.assign(document.createElement("span"), { className: "caret", "aria-hidden": "true" }));
  const fresh = lines.length > seen;
  seen = lines.length;
  if (stick) feed.scrollTop = feed.scrollHeight;
  $("jump").hidden = stick || !fresh;
}

function paintState() {
  const title = rec?.title || meeting?.title || "Ao vivo";
  $("title").textContent = title;
  document.title = `Escuta · ${title}`;

  const dot = $("dot");
  const status = $("status");
  let note = "";
  let warn = false;

  if (rec) {
    dot.className = rec.paused ? "dot pause" : "dot rec";
    note = rec.paused ? "Gravação pausada. Nada é gravado até você retomar." : "Gravando. A transcrição aparece aqui conforme a fala.";
    if (rec.stopAt) {
      note = "A ata será gerada em instantes. Clique em Desfazer para continuar gravando.";
      warn = true;
    }
    if (rec.paused) warn = true;
    if (live.error) {
      note = `${live.error} A gravação continua e a transcrição final é feita ao parar.`;
      warn = true;
    } else if (live.lag) {
      note = "O computador está ocupado: o texto ao vivo está atrasado. Nada se perde, a versão final pega tudo.";
      warn = true;
    }
  } else if (meeting?.status === "processing") {
    dot.className = "dot busy";
    note = STAGES[meeting.stage] || "Gerando a ata…";
  } else if (meeting?.status === "done") {
    dot.className = "dot done";
    note = meeting.minutes ? "Ata pronta." : meeting.minutesError || "Pronto.";
  } else if (meeting?.status === "failed") {
    dot.className = "dot";
    note = meeting.error || "Não deu certo. Abra as transcrições para tentar de novo.";
    warn = true;
  } else {
    dot.className = "dot";
    note = "Nenhuma gravação em andamento. Comece pelo ícone do Escuta, em Reunião.";
  }
  const done = !rec && meeting?.status === "done";
  status.textContent = done || (rec && !warn) ? "" : note; // gravando sem problema: o painel fala por si
  status.classList.toggle("warn", warn);
  $("label").textContent = done ? "Gravação encerrada" : "Transcrição ao vivo";
  $("final").hidden = !done;
  $("feedwrap").hidden = done;
  $("notesbox").hidden = done;
  if (done) {
    const mins = Math.round((meeting.duration || 0) / 60);
    $("stat-dur").textContent = meeting.duration && meeting.duration < 60 ? `${Math.round(meeting.duration)} s` : `${mins} min`;
    $("stat-lines").textContent = String(meeting.segments?.length || withoutEcho(live.lines).length || 0);
  }

  $("stop").hidden = !rec;
  $("pause").hidden = !rec || Boolean(rec.stopAt);
  $("ico-pause").toggleAttribute("hidden", Boolean(rec?.paused)); // SVG não tem a propriedade .hidden
  $("ico-play").toggleAttribute("hidden", !rec?.paused);
  $("pause").title = $("pause").ariaLabel = rec?.paused ? "Retomar a gravação" : "Pausar a gravação";
  $("open").hidden = rec || !meeting || meeting.status === "processing";
  $("open").textContent = meeting?.status === "failed" ? "Abrir as transcrições" : "Abrir a ata";
  $("copy").hidden = !live.lines.length;
  paintNotes();
  tick();
}

// As notas ficam em storage.session enquanto grava e, depois de parar, na própria reunião.
function paintGoal() {
  const field = $("goal");
  field.disabled = !rec;
  if (document.activeElement === field) return; // não mexe no que a pessoa está digitando
  const text = rec ? (goal.id === rec.id ? goal.text : "") : meeting?.goal || "";
  if (field.value !== text) field.value = text;
}

let savingGoal = 0;
function saveGoal() {
  clearTimeout(savingGoal);
  if (!rec) return Promise.resolve();
  goal = { id: rec.id, text: $("goal").value.trim() };
  return chrome.storage.session.set({ goal });
}
$("goal").addEventListener("input", () => {
  clearTimeout(savingGoal);
  savingGoal = setTimeout(saveGoal, 400);
});

function paintNotes() {
  paintGoal();
  const box = $("notes");
  box.disabled = !rec;
  if (document.activeElement === box) return; // não mexe no que a pessoa está digitando
  const text = rec ? (notes.id === rec.id ? notes.text : "") : meeting?.notes || "";
  if (box.value !== text) box.value = text;
  box.placeholder = rec ? "Anote o que importa. Entra na ata." : text ? "" : "As notas da reunião aparecem aqui.";
}

let saving = 0;
function saveNotes() {
  clearTimeout(saving);
  if (!rec) return Promise.resolve();
  notes = { id: rec.id, text: $("notes").value };
  return chrome.storage.session.set({ notes });
}
$("notes").addEventListener("input", () => {
  clearTimeout(saving);
  saving = setTimeout(saveNotes, 400);
});

let stopSent = false;
function tick() {
  if (rec?.stopAt) {
    const left = Math.max(0, Math.ceil((rec.stopAt - Date.now()) / 1000));
    $("stop").textContent = `Desfazer (${left})`;
    $("stop").classList.add("undo");
    if (left === 0 && !stopSent) {
      stopSent = true;
      chrome.runtime.sendMessage({ type: "rec-stop" }).catch(() => {});
    }
  } else {
    stopSent = false;
    $("stop").textContent = "Parar e gerar a ata";
    $("stop").classList.remove("undo");
  }
  $("clock").textContent = rec ? clockText(elapsed(rec)) : meeting?.duration ? clockText(meeting.duration * 1000) : "";
}

async function read() {
  const session = await chrome.storage.session.get(["rec", "live", "notes", "goal", "speakers"]);
  heard = session.speakers?.id && session.speakers.id === session.rec?.id ? session.speakers.events || [] : [];
  goal = session.goal || { id: null, text: "" };
  rec = session.rec || null;
  live = session.live || { id: null, lines: [], error: null, lag: false };
  notes = session.notes || { id: null, text: "" };

  const wanted = rec?.id || live.id;
  const all = await chrome.storage.local.get(null);
  meeting = wanted ? all[`m:${wanted}`] || null : null;
  paintState();
  paintFeed();
}

$("stop").addEventListener("click", async () => {
  if (rec?.stopAt) {
    await chrome.runtime.sendMessage({ type: "rec-stop-cancel" }).catch(() => {}); // desfaz
    return;
  }
  await saveNotes(); // o que ainda não passou pelo atraso de 400 ms entra na ata
  await saveGoal();
  await chrome.runtime.sendMessage({ type: "rec-stop-soon" }).catch(() => {});
});

$("pause").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: rec?.paused ? "rec-resume" : "rec-pause" }).catch(() => null);
  if (res && res.ok === false) {
    // Falhou: diz o motivo em vez de não fazer nada.
    $("status").textContent = res.message || "Não consegui pausar.";
    $("status").classList.add("warn");
  }
});

$("tool-min").addEventListener("click", () => askPage("minimize"));
$("tool-close").addEventListener("click", () => askPage("close"));
$("tool-pop").addEventListener("click", async () => {
  const width = 400;
  await chrome.windows.create({
    url: chrome.runtime.getURL("live.html"),
    type: "popup",
    width,
    height: Math.min(760, screen.availHeight - 80),
    left: (screen.availLeft || 0) + screen.availWidth - width - 20,
    top: (screen.availTop || 0) + 40,
  });
  askPage("close");
});

$("open").addEventListener("click", () => {
  const id = meeting?.id;
  chrome.tabs.create({ url: chrome.runtime.getURL(`history.html${id ? `#m:${id}` : ""}`) });
});

$("copy").addEventListener("click", async () => {
  const text = withoutEcho(live.lines)
    .map((l) => `[${stamp(l.start)}] ${WHO[l.who] || l.who}: ${l.text}`)
    .join("\n");
  let said = "Copiado ✓";
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    said = "Não copiou";
  }
  $("copy").title = said;
  $("status").textContent = said;
  setTimeout(() => {
    $("copy").title = "Copiar a transcrição";
    paintState();
  }, 1500);
});

$("feed").addEventListener("scroll", () => {
  const feed = $("feed");
  stick = feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 40;
  if (stick) $("jump").hidden = true;
});

$("jump").addEventListener("click", () => {
  stick = true;
  $("feed").scrollTop = $("feed").scrollHeight;
  $("jump").hidden = true;
});

let pending = 0;
chrome.storage.onChanged.addListener((changes, area) => {
  const relevant = area === "session" ? "rec" in changes || "live" in changes || "speakers" in changes : Object.keys(changes).some((k) => k.startsWith("m:"));
  if (!relevant) return;
  cancelAnimationFrame(pending);
  pending = requestAnimationFrame(read);
});

setInterval(tick, 500);
read();
