// Popup: lista as salas guardadas e exporta ou apaga cada uma. Sem rede; tudo vem do armazenamento local.
import { exportFileName, formatTranscript, orderedEntries, type Format } from "./export.ts";
import type { Room } from "./content/store.ts";

const list = document.getElementById("rooms")!;
const empty = document.getElementById("empty")!;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const when = (ms: number) => new Date(ms).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });

function card(room: Room): HTMLElement {
  const count = orderedEntries(room).length;
  const box = el("article", "room");
  const head = el("div", "room-head");
  head.append(el("b", "room-code", room.code), el("span", "room-when", when(room.updatedAt)));
  const people = Object.keys(room.names).length;
  box.append(head, el("p", "room-count", `${count} ${count === 1 ? "fala" : "falas"} · ${people} ${people === 1 ? "participante" : "participantes"}`));
  if (room.status && !count) box.append(el("p", "room-status", `Estado: ${room.status}`));

  const actions = el("div", "actions");
  for (const format of ["md", "txt"] as Format[]) {
    const b = el("button", "", format === "md" ? "Exportar .md" : "Exportar .txt");
    b.type = "button";
    b.disabled = !count;
    b.addEventListener("click", () => download(exportFileName(room, format), formatTranscript(room, format), format === "md" ? "text/markdown" : "text/plain"));
    actions.append(b);
  }
  const erase = el("button", "danger", "Apagar");
  erase.type = "button";
  erase.addEventListener("click", async () => {
    if (!erase.dataset.armed) {
      erase.dataset.armed = "1";
      erase.textContent = "Apagar mesmo?";
      setTimeout(() => {
        delete erase.dataset.armed;
        erase.textContent = "Apagar";
      }, 3000);
      return;
    }
    await chrome.storage.local.remove(`sala:${room.code}`);
  });
  actions.append(erase);
  box.append(actions);
  return box;
}

async function render() {
  const all = await chrome.storage.local.get(null);
  const rooms = Object.entries(all)
    .filter(([key]) => key.startsWith("sala:"))
    .map(([, value]) => value as Room)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  list.replaceChildren(...rooms.map(card));
  empty.hidden = rooms.length > 0;
}

chrome.storage.onChanged.addListener(() => void render());
void render();
