// Página de pesquisa: lê as transcrições que o content.js salva em
// chrome.storage.local ("t:<data-id>") e filtra tudo aqui mesmo, sem servidor.
const STORE_PREFIX = "t:";
const SHOW_MAX = 200; // mais que isso a página fica pesada e ninguém rola até o fim

const $ = (id) => document.getElementById(id);
let entries = []; // [{ id, text, summary, chat, who, duration, at }]

async function load() {
  const all = await chrome.storage.local.get(null);
  entries = Object.entries(all)
    .filter(([key, value]) => key.startsWith(STORE_PREFIX) && value?.text != null)
    .map(([key, value]) => ({ id: key.slice(STORE_PREFIX.length), ...value }))
    .sort((a, b) => (b.at || 0) - (a.at || 0));
  fillChats();
  render();
}

function fillChats() {
  const select = $("chat");
  const current = select.value;
  const chats = [...new Set(entries.map((e) => e.chat).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));
  select.replaceChildren(
    new Option("Todas as conversas", ""),
    ...chats.map((name) => new Option(name, name)),
    ...(entries.some((e) => !e.chat) ? [new Option("Sem conversa (salvas antes)", "\u0000")] : []),
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

// ---- tela ---------------------------------------------------------------------

const fmtDuration = (s) => {
  if (!Number.isFinite(s)) return "";
  const total = Math.round(s);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

const fmtDate = (ms) =>
  ms ? new Date(ms).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "";

const el = (tag, cls, text) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text != null ? { textContent: text } : {});

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
  const long = (entry.text || "").length > 420;
  if (long) {
    text.classList.add("clamp");
    const more = el("button", null, "Ver tudo");
    more.type = "button";
    more.addEventListener("click", () => {
      const open = text.classList.toggle("clamp");
      more.textContent = open ? "Ver tudo" : "Mostrar menos";
    });
    bar.append(more);
  }

  const copy = el("button", null, "Copiar");
  copy.type = "button";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(entry.summary ? `${entry.text}\n\nResumo: ${entry.summary}` : entry.text);
      copy.textContent = "Copiado ✓";
    } catch {
      copy.textContent = "Não copiou";
    }
    setTimeout(() => (copy.textContent = "Copiar"), 1500);
  });

  // Mesmo combinado do WhatsApp: Apagar pede um segundo clique.
  const erase = el("button", null, "Apagar");
  erase.type = "button";
  erase.addEventListener("click", () => {
    if (erase.dataset.armed) {
      chrome.storage.local.remove(STORE_PREFIX + entry.id); // onChanged recarrega a lista
      return;
    }
    erase.dataset.armed = "1";
    erase.textContent = "Apagar mesmo?";
    erase.classList.add("danger");
    setTimeout(() => {
      delete erase.dataset.armed;
      erase.textContent = "Apagar";
      erase.classList.remove("danger");
    }, 3000);
  });

  bar.append(copy, erase);
  item.append(bar);
  return item;
}

function render() {
  const terms = fold($("q").value).split(/\s+/).filter(Boolean);
  const chat = $("chat").value;
  const hits = entries.filter(
    (e) => (!chat || (chat === "\u0000" ? !e.chat : e.chat === chat)) && matches(e, terms),
  );

  $("list").replaceChildren(...hits.slice(0, SHOW_MAX).map((e) => card(e, terms)));

  const total = entries.length;
  $("count").textContent = !total
    ? ""
    : hits.length === total
      ? `${total} transcriç${total === 1 ? "ão salva" : "ões salvas"}`
      : `${hits.length} de ${total}${hits.length > SHOW_MAX ? ` · mostrando as ${SHOW_MAX} mais recentes` : ""}`;

  const empty = $("empty");
  empty.hidden = hits.length > 0;
  empty.textContent = total
    ? "Nada encontrado. Tente outra palavra ou escolha Todas as conversas."
    : "Nenhuma transcrição salva ainda. Elas aparecem aqui depois que você transcreve um áudio no WhatsApp Web.";
}

let typing = 0;
$("q").addEventListener("input", () => {
  clearTimeout(typing);
  typing = setTimeout(render, 120);
});
$("chat").addEventListener("change", render);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && Object.keys(changes).some((k) => k.startsWith(STORE_PREFIX))) load();
});

load();
