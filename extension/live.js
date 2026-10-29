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
const ECHO_SECONDS = 4;
const ECHO_SIMILARITY = 0.7;

let rec = null;
let live = { id: null, lines: [], error: null, lag: false };
let meeting = null;
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

function stamp(seconds) {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${m}:${s}` : `${m}:${s}`;
}

const clockText = (ms) => stamp(Math.max(0, ms) / 1000);

function paintFeed() {
  const lines = withoutEcho(live.lines);
  const feed = $("feed");
  feed.replaceChildren();
  if (!lines.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = rec
      ? rec.live
        ? "Aguardando alguém falar…"
        : "A transcrição ao vivo está desligada nesta gravação. A ata sai quando você parar."
      : "Nada para mostrar aqui.";
    feed.append(empty);
    return;
  }
  for (const line of lines) {
    const row = document.createElement("div");
    row.className = line.who === "voce" ? "line me" : "line";
    const meta = document.createElement("div");
    meta.className = "meta";
    const at = Object.assign(document.createElement("span"), { className: "at", textContent: stamp(line.start) });
    const who = Object.assign(document.createElement("span"), { className: "who", textContent: WHO[line.who] || line.who });
    meta.append(at, who);
    row.append(meta, Object.assign(document.createElement("p"), { className: "said", textContent: line.text }));
    feed.append(row);
  }
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
    dot.className = "dot rec";
    note = "Gravando. A janela acompanha a fala.";
    if (live.error) {
      note = `Sem resposta do servidor para o texto ao vivo (${live.error}). A gravação continua e a transcrição final é feita ao parar.`;
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
  status.textContent = note;
  status.classList.toggle("warn", warn);

  $("stop").hidden = !rec;
  $("open").hidden = rec || !meeting || meeting.status === "processing";
  $("open").textContent = meeting?.status === "failed" ? "Abrir as transcrições" : "Abrir a ata";
  $("copy").hidden = !live.lines.length;
  tick();
}

function tick() {
  $("clock").textContent = rec ? clockText(Date.now() - rec.startedAt) : meeting?.duration ? clockText(meeting.duration * 1000) : "";
}

async function read() {
  const session = await chrome.storage.session.get(["rec", "live"]);
  rec = session.rec || null;
  live = session.live || { id: null, lines: [], error: null, lag: false };

  const wanted = rec?.id || live.id;
  const all = await chrome.storage.local.get(null);
  meeting = wanted ? all[`m:${wanted}`] || null : null;
  paintState();
  paintFeed();
}

$("stop").addEventListener("click", async () => {
  $("stop").disabled = true;
  await chrome.runtime.sendMessage({ type: "rec-stop" }).catch(() => {});
  $("stop").disabled = false;
});

$("open").addEventListener("click", () => {
  const id = meeting?.id;
  chrome.tabs.create({ url: chrome.runtime.getURL(`history.html${id ? `#m:${id}` : ""}`) });
});

$("copy").addEventListener("click", async () => {
  const text = withoutEcho(live.lines)
    .map((l) => `[${stamp(l.start)}] ${WHO[l.who] || l.who}: ${l.text}`)
    .join("\n");
  try {
    await navigator.clipboard.writeText(text);
    $("copy").textContent = "Copiado ✓";
  } catch {
    $("copy").textContent = "Não copiou";
  }
  setTimeout(() => ($("copy").textContent = "Copiar"), 1500);
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
  const relevant = area === "session" ? "rec" in changes || "live" in changes : Object.keys(changes).some((k) => k.startsWith("m:"));
  if (!relevant) return;
  cancelAnimationFrame(pending);
  pending = requestAnimationFrame(read);
});

setInterval(tick, 500);
read();
