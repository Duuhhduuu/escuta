// Exportação da transcrição de uma sala em texto simples e em Markdown.
import type { Entry, Room } from "./content/store.ts";

export type Format = "txt" | "md";

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const dateOf = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Nome de quem falou: o do canal de participantes; sem ele, o final do id do aparelho. */
export const speakerName = (room: Room, deviceId: string): string => room.names[deviceId] ?? `Participante ${deviceId.split("/").pop()?.slice(0, 6) ?? "?"}`;

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
/** Uma fala parcial que sobrou porque o Meet trocou o id da fala no meio: o mesmo aparelho, poucos segundos depois, repete o texto e continua. */
const LEFTOVER_WINDOW_MS = 15_000;

export const orderedEntries = (room: Room): Entry[] => {
  const sorted = Object.values(room.entries)
    .filter((e) => e.text.trim())
    .sort((a, b) => a.firstAt - b.firstAt || a.key.localeCompare(b.key));
  const normalized = sorted.map((e) => norm(e.text));
  return sorted.filter((a, i) => {
    const na = normalized[i]!;
    for (let j = i + 1; j < sorted.length && sorted[j]!.firstAt - a.firstAt <= LEFTOVER_WINDOW_MS; j++) {
      const b = sorted[j]!;
      if (b.deviceId === a.deviceId && b.key !== a.key && normalized[j]!.length >= na.length && normalized[j]!.startsWith(na)) return false;
    }
    return true;
  });
};

export function formatTranscript(room: Room, format: Format): string {
  const lines = orderedEntries(room).map((e) => ({ time: clock(e.firstAt), who: speakerName(room, e.deviceId), text: e.text.trim() }));
  if (format === "txt") return lines.map((l) => `[${l.time}] ${l.who}: ${l.text}`).join("\n") + (lines.length ? "\n" : "");
  const head = `# Transcrição da sala ${room.code}\n\nData: ${dateOf(room.startedAt)} · ${lines.length} falas\n\n---\n\n`;
  return head + lines.map((l) => `**[${l.time}] ${l.who}:** ${l.text}`).join("\n\n") + (lines.length ? "\n" : "");
}

export const exportFileName = (room: Room, format: Format): string => `${dateOf(room.startedAt)} ${room.code}.${format}`;
