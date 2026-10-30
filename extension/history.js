// Página de pesquisa: lê o que o content.js salva em chrome.storage.local
// ("t:<data-id>" para mensagens de voz) e o que meetings.js salva ("m:<id>" para
// reuniões), e filtra tudo aqui mesmo, sem servidor.
const STORE_PREFIX = "t:";
const MEETING_PREFIX = "m:";
const SHOW_MAX = 200; // mais que isso a página fica pesada e ninguém rola até o fim

const $ = (id) => document.getElementById(id);
let voice = []; // mensagens de voz: [{ id, text, summary, chat, who, duration, at }]
let meetings = []; // reuniões: [{ id, title, minutes, segments, status, ... }]
let templates = []; // [{ id, name }] para "Refazer ata"; vem do servidor, pode ficar vazio

async function load() {
  const all = await chrome.storage.local.get(null);
  voice = [];
  meetings = [];
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(STORE_PREFIX) && value?.text != null) voice.push({ id: key.slice(STORE_PREFIX.length), ...value });
    else if (key.startsWith(MEETING_PREFIX) && value?.kind === "meeting") meetings.push(value);
  }
  const newest = (a, b) => (b.at || 0) - (a.at || 0);
  voice.sort(newest);
  meetings.sort(newest);
  fillChats();
  render();
}

function fillChats() {
  const select = $("chat");
  const current = select.value;
  const chats = [...new Set(voice.map((e) => e.chat).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));
  select.replaceChildren(
    new Option("Todas as conversas", ""),
    ...chats.map((name) => new Option(name, name)),
    ...(voice.some((e) => !e.chat) ? [new Option("Sem conversa (salvas antes)", "\u0000")] : []),
  );
  select.value = [...select.options].some((o) => o.value === current) ? current : "";
}

// ---- busca sem acento e sem maiúscula ---------------------------------------

const fold = (s) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

// Versão "dobrada" do texto e, para cada caractere dela, a posição no original.
// É o que deixa achar "reuniao" em "Reunião" e destacar o trecho certo.
function folded(text) {
  let out = "";
  const map = [];
  for (let i = 0; i < text.length; i++) {
    const f = fold(text[i]);
    for (let k = 0; k < f.length; k++) map.push(i);
    out += f;
  }
  map.push(text.length);
  return { out, map };
}

function ranges(text, terms) {
  if (!terms.length || !text) return [];
  const { out, map } = folded(text);
  const found = [];
  for (const term of terms) {
    for (let at = out.indexOf(term); at >= 0; at = out.indexOf(term, at + term.length)) {
      found.push([map[at], map[at + term.length - 1] + 1]);
    }
  }
  // Junta trechos que se sobrepõem, senão o destaque sai picado.
  found.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of found) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}

function highlighted(text, terms) {
  const frag = document.createDocumentFragment();
  let pos = 0;
  for (const [start, end] of ranges(text, terms)) {
    frag.append(text.slice(pos, start), Object.assign(document.createElement("mark"), { textContent: text.slice(start, end) }));
    pos = end;
  }
  frag.append(text.slice(pos));
  return frag;
}

function matches(entry, terms) {
  const hay = fold([entry.text, entry.summary, entry.chat, entry.who].filter(Boolean).join("\n"));
  return terms.every((t) => hay.includes(t));
}

const WHO = { voce: "Você", outros: "Participantes" };

const transcriptLines = (m) =>
  (m.segments || []).filter((s) => s.text).map((s) => ({ at: stamp(s.start), who: s.speaker || WHO[s.who] || s.who, text: s.text }));

function meetingMatches(m, terms) {
  const hay = fold(
    [m.title, m.minutes, m.notes, templateName(m.template), ...(m.segments || []).map((s) => s.text)].filter(Boolean).join("\n"),
  );
  return terms.every((t) => hay.includes(t));
}

// ---- formatação -------------------------------------------------------------------

function stamp(seconds) {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${m}:${s}` : `${m}:${s}`;
}

const fmtDuration = (s) => {
  if (!Number.isFinite(s)) return "";
  const total = Math.round(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h ? `${h}h${String(m).padStart(2, "0")}` : `${m}:${String(total % 60).padStart(2, "0")}`;
};

const fmtDate = (ms) =>
  ms ? new Date(ms).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "";

const templateName = (id) => templates.find((t) => t.id === id)?.name || id || "";

const el = (tag, cls, text) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text != null ? { textContent: text } : {});

function button(label, onClick, cls) {
  const b = el("button", cls, label);
  b.type = "button";
  b.addEventListener("click", () => onClick(b));
  return b;
}

// Apagar pede um segundo clique e desarma sozinho em 3 s.
function eraseButton(onConfirm) {
  return button("Apagar", (b) => {
    if (b.dataset.armed) return onConfirm();
    b.dataset.armed = "1";
    b.textContent = "Apagar mesmo?";
    b.classList.add("danger");
    setTimeout(() => {
      delete b.dataset.armed;
      b.textContent = "Apagar";
      b.classList.remove("danger");
    }, 3000);
  });
}

async function copyTo(b, text, label) {
  try {
    await navigator.clipboard.writeText(text);
    b.textContent = "Copiado ✓";
  } catch {
    b.textContent = "Não copiou";
  }
  setTimeout(() => (b.textContent = label), 1500);
}

// ---- Markdown mínimo --------------------------------------------------------------
// Só o que as atas usam: títulos, listas, tabelas, negrito, itálico e código. Tudo vira
// nós de texto (nunca innerHTML), então o que o modelo escrever não executa nada.

function inline(parent, text, terms) {
  const clean = text.replace(/<br\s*\/?>/gi, "; ");
  for (const piece of clean.split(/(\*\*[^*]+\*\*|`[^`]+`|_[^_\s][^_]*_)/)) {
    if (!piece) continue;
    if (piece.startsWith("**") && piece.endsWith("**") && piece.length > 4) {
      const strong = el("strong");
      strong.append(highlighted(piece.slice(2, -2), terms));
      parent.append(strong);
    } else if (piece.startsWith("`") && piece.endsWith("`") && piece.length > 2) {
      parent.append(el("code", null, piece.slice(1, -1)));
    } else if (piece.startsWith("_") && piece.endsWith("_") && piece.length > 2) {
      const em = el("em");
      em.append(highlighted(piece.slice(1, -1), terms));
      parent.append(em);
    } else {
      parent.append(highlighted(piece, terms));
    }
  }
}

const tableCells = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

const isRule = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

function markdown(source, terms) {
  const root = el("div", "md");
  const lines = source.replace(/\r/g, "").split("\n");
  let list = null;
  let para = null;

  const close = () => {
    list = null;
    para = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      close();
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      close();
      const h = el(`h${Math.min(heading[1].length + 1, 5)}`);
      inline(h, heading[2], terms);
      root.append(h);
      continue;
    }

    if (line.trim().startsWith("|") && i + 1 < lines.length && isRule(lines[i + 1])) {
      close();
      const table = el("table");
      const thead = el("thead");
      const head = el("tr");
      for (const cell of tableCells(line)) {
        const th = el("th");
        inline(th, cell.replace(/\*\*/g, ""), terms);
        head.append(th);
      }
      thead.append(head);
      table.append(thead);
      const body = el("tbody");
      for (i += 2; i < lines.length && lines[i].trim().startsWith("|"); i++) {
        const row = el("tr");
        for (const cell of tableCells(lines[i])) {
          const td = el("td");
          inline(td, cell, terms);
          row.append(td);
        }
        body.append(row);
      }
      i--;
      table.append(body);
      const wrap = el("div", "table-wrap");
      wrap.append(table);
      root.append(wrap);
      continue;
    }

    const item = line.match(/^\s*([-*•]|\d+[.)])\s+(.*)$/);
    if (item) {
      para = null;
      const ordered = /\d/.test(item[1]);
      if (!list || list.tagName !== (ordered ? "OL" : "UL")) {
        list = el(ordered ? "ol" : "ul");
        root.append(list);
      }
      const li = el("li");
      inline(li, item[2], terms);
      list.append(li);
      continue;
    }

    list = null;
    if (!para) {
      para = el("p");
      root.append(para);
    } else {
      para.append(" ");
    }
    inline(para, line.trim(), terms);
  }
  return root;
}

// ---- cartões ----------------------------------------------------------------------

function card(entry, terms) {
  const item = el("article", "item");

  const meta = el("div", "meta");
  if (entry.chat) meta.append(el("span", "chat", entry.chat));
  if (entry.who && entry.who !== entry.chat) meta.append(el("span", null, entry.who));
  for (const bit of [fmtDate(entry.at), fmtDuration(entry.duration)]) if (bit) meta.append(el("span", null, bit));
  item.append(meta);

  const text = el("p", "text");
  text.append(highlighted(entry.text || "Nenhuma fala reconhecida.", terms));
  item.append(text);

  if (entry.summary) {
    const sum = el("div", "summary");
    const p = el("p", "text");
    p.append(highlighted(entry.summary, terms));
    sum.append(el("div", "label", "Resumo"), p);
    item.append(sum);
  }

  const bar = el("div", "actions");
  if ((entry.text || "").length > 420) {
    text.classList.add("clamp");
    bar.append(
      button("Ver tudo", (b) => {
        b.textContent = text.classList.toggle("clamp") ? "Ver tudo" : "Mostrar menos";
      }),
    );
  }
  bar.append(
    button("Copiar", (b) => copyTo(b, entry.summary ? `${entry.text}\n\nResumo: ${entry.summary}` : entry.text, "Copiar")),
    eraseButton(() => chrome.storage.local.remove(STORE_PREFIX + entry.id)), // onChanged recarrega a lista
  );
  item.append(bar);
  return item;
}

const STAGES = {
  upload: "Enviando a gravação…",
  decode: "Preparando o áudio…",
  voce: "Transcrevendo a sua voz…",
  outros: "Transcrevendo os participantes…",
  merge: "Juntando as falas…",
  minutes: "Escrevendo a ata…",
};

const meetingMarkdown = (m) =>
  `${m.minutes || `# ${m.title}`}\n\n---\n\n${m.notes ? `## Notas\n\n${m.notes}\n\n---\n\n` : ""}## Transcrição\n\n${transcriptLines(m)
    .map((l) => `**[${l.at}] ${l.who}:** ${l.text}`)
    .join("\n\n")}\n`;

function download(name, content) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const fileName = (m) =>
  `${new Date(m.at).toISOString().slice(0, 10)} ${m.title}`.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 90) + ".md";

const send = (message) => chrome.runtime.sendMessage(message).catch(() => null);

// Assunto da reunião: o título que a ata ganhou; sem ata ainda, o nome da aba.
const subject = (m) => (m.minutes?.match(/^#\s+(.+)$/m)?.[1] || m.title || "Reunião").replace(/[*_`#]/g, "").trim();

const dayParts = (ms) => {
  const d = new Date(ms);
  return {
    // "qui 29 out": curto, para caber na coluna da lista.
    day: [d.toLocaleDateString("pt-BR", { weekday: "short" }), d.getDate(), d.toLocaleDateString("pt-BR", { month: "short" })]
      .join(" ")
      .replace(/\./g, ""),
    time: d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
  };
};

const longDate = (ms) =>
  new Date(ms).toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

// Na lista, cada reunião é uma linha só: dia, assunto e um detalhe. Clicar abre a reunião.
function meetingRow(m, terms) {
  const row = el("a", "row");
  row.href = `#m:${m.id}`;
  row.id = `m-${m.id}`;

  const when = el("span", "when");
  if (m.at) {
    const { day, time } = dayParts(m.at);
    when.append(el("b", null, day), el("i", null, time));
  }
  const what = el("span", "what");
  const title = el("b", "subject");
  title.append(highlighted(subject(m), terms));
  const bits = [fmtDuration(m.duration), templateName(m.template)].filter(Boolean).join(" · ");
  what.append(title, el("span", "sub", bits));

  const state = el("span", "state");
  if (m.status === "recording") state.append(el("span", "chip chip--live", "Ao vivo"));
  else if (m.status === "processing") state.append(el("span", "chip chip--busy", STAGES[m.stage] ? "Gerando a ata" : "Processando"));
  else if (m.status === "failed") state.append(el("span", "chip chip--bad", "Não deu certo"));
  else state.append(el("span", "chev", "›"));
  row.append(when, what, state);
  return row;
}

// O resumo do topo: o primeiro trecho da ata que é texto corrido (uma lista ou tabela não resume nada).
const GOAL_TITLE = /^objetivo da reuni/i;

function sectionsOf(minutes) {
  const body = (minutes || "").replace(/^#\s+.+\n+/, "");
  const parts = body.split(/^##\s+/m);
  return { pre: parts[0].trim(), list: parts.slice(1).map((s) => ({ title: s.split("\n")[0].trim(), text: s.split("\n").slice(1).join("\n").trim() })) };
}

function summaryOf(minutes) {
  const { pre, list } = sectionsOf(minutes);
  const prose = (t) => t && !/^\s*([-*•]\s|\d+[.)]\s|\|)/.test(t);
  if (prose(pre)) return pre;
  const own = list.filter((s) => !GOAL_TITLE.test(s.title)); // o objetivo tem cartão próprio
  return (own.find((s) => prose(s.text)) || own[0])?.text || "";
}

// A seção "Objetivo da reunião" da ata: o veredito (Sim, Parcialmente ou Não) e o resto do texto.
function goalOf(minutes) {
  const section = sectionsOf(minutes).list.find((s) => GOAL_TITLE.test(s.title));
  if (!section) return null;
  const m = section.text.match(/^\W*(sim|parcialmente|n[ãa]o)\b\.?\s*/i);
  const word = m ? m[1].toLowerCase().replace("nao", "não") : "";
  return { verdict: word, text: m ? section.text.slice(m[0].length) : section.text };
}

// ---- conversa sobre a reunião -------------------------------------------------------

const SUGGESTIONS = ["Quais foram as decisões?", "O que eu preciso fazer e até quando?", "Resuma em 3 linhas", "Ficou alguma dúvida em aberto?"];
const GOAL_SUGGESTION = "Alcançamos o objetivo? O que eu poderia ter feito melhor?";
const ui = { id: "", tab: "chat", draft: "", pending: null, base: 0, error: null };

function chatPane(m, terms) {
  const pane = el("div", "pane chat");
  const log = el("div", "chat-log");
  log.setAttribute("aria-live", "polite");

  const form = el("form", "chat-form");
  const input = Object.assign(el("textarea"), { rows: 1, placeholder: "Pergunte algo sobre esta reunião…", value: ui.draft });
  input.setAttribute("aria-label", "Pergunta sobre a reunião");
  const submit = el("button", "primary", "Perguntar");
  submit.type = "submit";
  form.append(input, submit);

  const bubble = (role, node) => {
    const b = el("div", `msg msg--${role}`);
    b.append(node);
    return b;
  };

  function draw() {
    const saved = m.chat || [];
    const rows = [];
    for (const turn of saved) {
      if (turn.role === "user") rows.push(bubble("user", el("p", null, turn.content)));
      else {
        const body = el("div", "md");
        body.append(markdown(turn.content, []));
        rows.push(bubble("ai", body));
      }
    }
    const waiting = ui.pending && saved.length <= ui.base;
    if (waiting) {
      rows.push(bubble("user", el("p", null, ui.pending)));
      const busy = el("p", "busy");
      busy.setAttribute("role", "status");
      busy.append(el("span", "pulse"), "Lendo a reunião…");
      rows.push(bubble("ai", busy));
    }
    if (ui.error && !waiting) {
      const err = el("div", "msg msg--ai msg--err");
      err.append(el("p", null, ui.error.message), button("Tentar de novo", () => ask(ui.error.question)));
      rows.push(err);
    }
    if (!rows.length) {
      const empty = el("div", "chat-empty");
      empty.append(el("p", null, "Pergunte o que quiser sobre esta reunião. As respostas saem só do que foi dito."));
      const chips = el("div", "chips");
      for (const q of m.goal ? [GOAL_SUGGESTION, ...SUGGESTIONS] : SUGGESTIONS) chips.append(button(q, () => ask(q), "chip-btn"));
      empty.append(chips);
      rows.push(empty);
    }
    log.replaceChildren(...rows);
    submit.disabled = Boolean(waiting);
    log.scrollTop = log.scrollHeight;
  }

  async function ask(question) {
    const text = question.trim();
    if (!text || (ui.pending && (m.chat || []).length <= ui.base)) return;
    ui.pending = text;
    ui.base = (m.chat || []).length;
    ui.error = null;
    ui.draft = input.value = "";
    draw();
    const res = await send({ type: "meeting-ask", id: m.id, question: text });
    ui.pending = null;
    if (!res?.ok) ui.error = { question: text, message: res?.message || "Não consegui responder agora." };
    draw();
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    ask(input.value);
  });
  input.addEventListener("input", () => {
    ui.draft = input.value;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  pane.append(log, form);
  draw();
  return pane;
}

// A reunião aberta: assunto e data no topo, e o conteúdo em duas abas (ata e transcrição).
function meetingDetail(m, terms) {
  const view = el("section", "detail");
  view.append(button("← Todas as reuniões", () => (location.hash = ""), "back"));

  const head = el("div", "d-head");
  head.append(el("h2", null, subject(m)));
  const when = [m.at ? longDate(m.at) : "", m.at ? dayParts(m.at).time : "", fmtDuration(m.duration), templateName(m.template)].filter(Boolean);
  head.append(el("p", "d-meta", when.join(" · ")));
  view.append(head);

  const erase = eraseButton(() => {
    chrome.storage.local.remove(MEETING_PREFIX + m.id);
    if (typeof RecDB !== "undefined") RecDB.drop(m.id).catch(() => {}); // áudio que ainda estivesse guardado
    location.hash = "";
  });

  if (m.status === "processing") {
    const busy = el("p", "busy");
    busy.setAttribute("role", "status");
    busy.append(el("span", "pulse"), STAGES[m.stage] || "Processando…");
    const bar = el("div", "progress");
    bar.append(Object.assign(el("i"), { style: `width:${Math.round((m.progress ?? 0.05) * 100)}%` }));
    view.append(busy, bar, el("p", "hint", "Reuniões longas levam alguns minutos. Pode fechar esta página; o servidor continua trabalhando."));
    return view;
  }

  if (m.status === "failed") {
    view.append(el("p", "error", m.error || "Não deu certo."));
    const bar = el("div", "actions");
    bar.append(button("Tentar de novo", () => send({ type: "meeting-retry", id: m.id }), "primary"), erase);
    view.append(bar);
    return view;
  }

  const lines = transcriptLines(m);

  // Gravando: o texto vai sendo salvo sozinho e a ata sai quando a reunião terminar.
  if (m.status === "recording") {
    const live = el("p", "busy");
    live.setAttribute("role", "status");
    live.append(el("span", "pulse"), "Gravando. A transcrição é salva sozinha e a ata sai quando a reunião terminar.");
    view.append(live);
  }

  // ---- ações
  const bar = el("div", "actions");
  if (m.minutes) bar.append(button("Copiar ata", (b) => copyTo(b, m.minutes, "Copiar ata")));
  bar.append(button("Baixar .md", () => download(fileName(m), meetingMarkdown(m))));
  if (lines.length && templates.length) {
    const pick = el("select", "pick");
    pick.setAttribute("aria-label", "Modelo da ata");
    pick.append(...templates.map((t) => new Option(t.name, t.id)));
    pick.value = templates.some((t) => t.id === m.template) ? m.template : templates[0].id;
    bar.append(pick, button(m.minutes ? "Refazer ata" : "Gerar ata", () => send({ type: "meeting-minutes", id: m.id, template: pick.value })));
  }
  bar.append(erase);
  view.append(bar);

  // ---- abas
  const ata = el("div", "pane");
  if (m.minutes) {
    // O assunto já está no topo; tira o título repetido da ata.
    const body = m.minutes.replace(/^#\s+.+\n+/, "");
    const wrap = el("div", "minutes");
    wrap.append(markdown(body, terms));
    ata.append(wrap);
  } else {
    ata.append(el("p", "error", m.minutesError || "A ata não foi gerada."));
  }
  if (m.minutes && m.minutesError) ata.append(el("p", "error", m.minutesError));
  if (m.notes) {
    const box = el("div", "notes-box");
    box.append(el("div", "label", "Suas notas"), Object.assign(el("p", "text"), { textContent: m.notes }));
    ata.append(box);
  }

  const transcript = el("div", "pane");
  transcript.hidden = true;
  const list = el("div", "transcript");
  for (const line of lines) {
    const row = el("p", "line");
    row.append(el("span", "at", line.at), el("b", line.who === "Você" ? "who who--me" : "who", line.who));
    const said = el("span", "said");
    said.append(highlighted(line.text, terms));
    row.append(said);
    list.append(row);
  }
  transcript.append(lines.length ? list : el("p", "hint", "Nenhuma fala reconhecida."));

  // O resumo já aparece no topo; as abas trazem a conversa (que abre primeiro), a ata e a transcrição.
  if (ui.id !== m.id) Object.assign(ui, { id: m.id, tab: "chat", draft: "", pending: null, base: 0, error: null });
  // Objetivo: o que a pessoa escreveu, o veredito da ata e, abaixo, o que faltou e como melhorar.
  const goalBox = el("div", "goal-card");
  const goalHead = el("div", "goal-head");
  goalHead.append(el("div", "label", "Objetivo"));
  const verdict = goalOf(m.minutes);
  if (verdict?.verdict) {
    const tone = { sim: "ok", parcialmente: "mid", "não": "bad" }[verdict.verdict];
    goalHead.append(el("span", `chip chip--${tone}`, { sim: "Alcançado", parcialmente: "Em parte", "não": "Não alcançado" }[verdict.verdict]));
  }
  const goalInput = Object.assign(el("input", "goal-input"), { type: "text", maxLength: 500, value: m.goal || "", placeholder: "Qual era o objetivo desta reunião?" });
  goalInput.setAttribute("aria-label", "Objetivo da reunião");
  goalInput.addEventListener("change", () => send({ type: "meeting-goal", id: m.id, goal: goalInput.value }));
  goalBox.append(goalHead, goalInput);
  if (verdict?.text) {
    const body = el("div", "md");
    body.append(markdown(verdict.text, terms));
    goalBox.append(body);
  } else if (!m.goal) {
    goalBox.append(el("p", "hint", "Escreva o objetivo e clique em Refazer ata: a ata diz se foi alcançado e como melhorar na próxima."));
  } else if (!verdict) {
    goalBox.append(el("p", "hint", "Clique em Refazer ata para a ata avaliar este objetivo."));
  }
  view.insertBefore(goalBox, bar);

  const summary = summaryOf(m.minutes);
  if (summary) {
    const card = el("div", "summary-card");
    const body = el("div", "md");
    body.append(markdown(summary, terms));
    card.append(el("div", "label", "Resumo"), body);
    view.insertBefore(card, bar);
  }

  const chat = chatPane(m, terms);
  const panes = { chat, ata, transcript };
  const tabs = el("div", "tabs");
  tabs.setAttribute("role", "tablist");
  const labels = { chat: "Perguntar", ata: "Ata", transcript: `Transcrição (${lines.length})` };
  const tabButtons = {};
  const select = (key) => {
    ui.tab = key;
    for (const [k, b] of Object.entries(tabButtons)) {
      b.setAttribute("aria-selected", String(k === key));
      panes[k].hidden = k !== key;
    }
  };
  for (const key of ["chat", "ata", "transcript"]) {
    const t = button(labels[key], () => select(key), "tab");
    t.setAttribute("role", "tab");
    tabButtons[key] = t;
    tabs.append(t);
  }
  view.append(tabs, chat, ata, transcript);
  select(ui.tab in panes ? ui.tab : "chat");
  return view;
}

const openMeetingId = () => (location.hash.startsWith("#m:") ? location.hash.slice(3) : "");

function render() {
  const terms = fold($("q").value).split(/\s+/).filter(Boolean);

  // history.html#m:<id> abre a reunião (o popup e a lista usam isso); sem hash, a lista.
  const opened = openMeetingId() && meetings.find((m) => m.id === openMeetingId());
  document.body.classList.toggle("detail", Boolean(opened));
  if (opened) {
    $("list").replaceChildren(meetingDetail(opened, terms));
    $("empty").hidden = true;
    window.scrollTo(0, 0);
    return;
  }

  const chat = $("chat").value;
  const kind = $("kind").value;

  const voiceHits =
    kind === "meeting"
      ? []
      : voice.filter((e) => (!chat || (chat === "\u0000" ? !e.chat : e.chat === chat)) && matches(e, terms));
  // Escolher uma conversa de WhatsApp esconde as reuniões: elas não pertencem a nenhuma.
  const meetingHits = kind === "voice" || chat ? [] : meetings.filter((m) => meetingMatches(m, terms));

  const merged = [
    ...voiceHits.map((entry) => ({ at: entry.at || 0, node: () => card(entry, terms) })),
    ...meetingHits.map((m) => ({ at: m.at || 0, node: () => meetingRow(m, terms) })),
  ].sort((a, b) => b.at - a.at);

  $("list").replaceChildren(...merged.slice(0, SHOW_MAX).map((x) => x.node()));

  const total = voice.length + meetings.length;
  const some = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  $("count").textContent = !total
    ? ""
    : merged.length === total
      ? [some(voice.length, "mensagem de voz", "mensagens de voz"), some(meetings.length, "reunião", "reuniões")].join(" · ")
      : `${merged.length} de ${total}${merged.length > SHOW_MAX ? ` · mostrando as ${SHOW_MAX} mais recentes` : ""}`;

  const empty = $("empty");
  empty.hidden = merged.length > 0;
  empty.textContent = total
    ? "Nada encontrado. Tente outra palavra ou mude os filtros."
    : "Nada salvo ainda. As transcrições aparecem aqui depois que você transcreve um áudio no WhatsApp Web ou grava uma reunião pelo ícone da extensão.";

}

window.addEventListener("hashchange", render);

let typing = 0;
$("q").addEventListener("input", () => {
  clearTimeout(typing);
  typing = setTimeout(render, 120);
});
$("chat").addEventListener("change", render);
$("kind").addEventListener("change", render);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && Object.keys(changes).some((k) => k.startsWith(STORE_PREFIX) || k.startsWith(MEETING_PREFIX))) load();
});

(async () => {
  const res = await send({ type: "templates" });
  templates = res?.ok ? res.data.templates : [];
  load();
})();
