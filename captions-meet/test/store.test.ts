import { test } from "node:test";
import assert from "node:assert/strict";
import { RoomStore, roomKey, type KeyValue, type Room } from "../src/content/store.ts";
import { exportFileName, formatTranscript } from "../src/export.ts";
import { roomFromPath } from "../src/shared.ts";
import type { Msg } from "../src/page/dedupe.ts";

const memory = () => {
  const data = new Map<string, Room>();
  const storage: KeyValue = { get: async (k) => structuredClone(data.get(k)), set: async (k, v) => void data.set(k, structuredClone(v)) };
  return { data, storage };
};
const msg = (over: Partial<Msg>): Msg => ({ key: "1/d", deviceId: "spaces/s/devices/d", text: "oi", version: 1, lang: "pt", at: 1000, ...over });

test("a parcial vira final, o horário fica o da primeira vez e a versão velha é ignorada", async () => {
  const { data, storage } = memory();
  const store = new RoomStore("abc-defg-hij", storage, () => 5000);
  store.addMessages([msg({ version: 1, text: "bom", at: 1000 })]);
  store.addMessages([msg({ version: 3, text: "bom dia a todos", at: 4000 })]);
  store.addMessages([msg({ version: 2, text: "bom dia", at: 4500 })]);
  await store.save();
  const saved = data.get(roomKey("abc-defg-hij"))!;
  const entry = saved.entries["1/d"]!;
  assert.equal(entry.text, "bom dia a todos");
  assert.equal(entry.firstAt, 1000);
});

test("recarregar a página retoma a sala e o que chegou durante o carregamento vale por cima", async () => {
  const { data, storage } = memory();
  const first = new RoomStore("abc-defg-hij", storage, () => 1);
  first.addMessages([msg({ key: "1/d", version: 2, text: "antes" }), msg({ key: "2/d", version: 1, text: "outra" })]);
  first.addNames({ "spaces/s/devices/d": "Ana" });
  await first.save();

  const second = new RoomStore("abc-defg-hij", storage, () => 2);
  second.addMessages([msg({ key: "1/d", version: 1, text: "velha demais" }), msg({ key: "3/d", version: 1, text: "nova" })]);
  await second.load();
  assert.equal(second.room.entries["1/d"]!.text, "antes"); // a versão salva (2) vence a recém-chegada (1)
  assert.equal(second.room.entries["3/d"]!.text, "nova");
  assert.equal(second.room.names["spaces/s/devices/d"], "Ana");
  assert.equal(Object.keys(data.get(roomKey("abc-defg-hij"))!.entries).length, 2); // nada gravado até chamar save
});

test("save só grava quando mudou", async () => {
  let writes = 0;
  const store = new RoomStore("abc-defg-hij", { get: async () => undefined, set: async () => void writes++ }, () => 1);
  await store.save();
  store.setStatus("aberto");
  await store.save();
  await store.save();
  assert.equal(writes, 1);
});

test("exportação: ordem por horário, nome pelo mapa e formatos txt e md", () => {
  const room: Room = {
    code: "abc-defg-hij",
    startedAt: new Date(2026, 10, 9, 10, 0, 0).getTime(),
    updatedAt: 0,
    names: { "spaces/s/devices/a": "Ana" },
    entries: {
      b: { key: "b", deviceId: "spaces/s/devices/zzzzzzzz", text: "  Fechado.  ", version: 1, lang: "", firstAt: new Date(2026, 10, 9, 10, 0, 7).getTime(), updatedAt: 0 },
      a: { key: "a", deviceId: "spaces/s/devices/a", text: "Vamos começar.", version: 1, lang: "", firstAt: new Date(2026, 10, 9, 10, 0, 3).getTime(), updatedAt: 0 },
      v: { key: "v", deviceId: "spaces/s/devices/a", text: "   ", version: 1, lang: "", firstAt: 0, updatedAt: 0 },
    },
  };
  assert.equal(formatTranscript(room, "txt"), "[10:00:03] Ana: Vamos começar.\n[10:00:07] Participante zzzzzz: Fechado.\n");
  const md = formatTranscript(room, "md");
  assert.ok(md.startsWith("# Transcrição da sala abc-defg-hij"));
  assert.ok(md.includes("**[10:00:03] Ana:** Vamos começar.\n\n**[10:00:07] Participante zzzzzz:** Fechado."));
  assert.equal(exportFileName(room, "md"), "2026-11-09 abc-defg-hij.md");
});

test("código da sala vem do caminho, com ou sem /meet/", () => {
  assert.equal(roomFromPath("/abc-defg-hij"), "abc-defg-hij");
  assert.equal(roomFromPath("/meet/abc-defg-hij"), "abc-defg-hij");
  assert.equal(roomFromPath("/landing"), null);
  assert.equal(roomFromPath("/new"), null);
});
