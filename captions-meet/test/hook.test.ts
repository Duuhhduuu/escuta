import { test } from "node:test";
import assert from "node:assert/strict";
import { installHook, type PageEvent, type Timers } from "../src/page/hook.ts";
import { readFields } from "../src/page/protocol.ts";
import { bytes, DEVICE, text, u8, v2Packet } from "./helpers.ts";

// ---- peças falsas -------------------------------------------------------------------------------

class FakeChannel extends EventTarget {
  readyState = "open";
  binaryType = "blob";
  sent: Uint8Array[] = [];
  constructor(
    public label: string,
    public init: { id?: number; ordered?: boolean; maxRetransmits?: number } = {},
  ) {
    super();
  }
  send(data: Uint8Array) {
    this.sent.push(data);
  }
  receive(data: unknown) {
    this.dispatchEvent(Object.assign(new Event("message"), { data }));
  }
}

class FakePC extends EventTarget {
  connectionState = "connected";
  created: FakeChannel[] = [];
  createDataChannel(label: string, init?: FakeChannel["init"]) {
    const channel = new FakeChannel(label, init);
    this.created.push(channel);
    return channel;
  }
  remoteOpens(channel: FakeChannel) {
    this.dispatchEvent(Object.assign(new Event("datachannel"), { channel }));
  }
}

function setup() {
  let now = 1_000_000;
  const intervals: Array<{ fn: () => void; ms: number; next: number }> = [];
  const timeouts: Array<{ fn: () => void; at: number }> = [];
  const timers: Timers = {
    now: () => now,
    setInterval: (fn, ms) => void intervals.push({ fn, ms, next: now + ms }),
    setTimeout: (fn, ms) => void timeouts.push({ fn, at: now + ms }),
  };
  const advance = (ms: number) => {
    const end = now + ms;
    while (now < end) {
      now = Math.min(end, now + 100);
      for (const i of intervals) while (i.next <= now) (i.next += i.ms), i.fn();
      for (const t of timeouts.splice(0)) (t.at <= now ? t.fn() : timeouts.push(t));
    }
  };
  const win = { RTCPeerConnection: FakePC } as unknown as Window & typeof globalThis;
  const events: PageEvent[] = [];
  installHook(win, (e) => events.push(e), timers);
  const pc = new win.RTCPeerConnection() as unknown as FakePC;
  const tick = () => new Promise((r) => setTimeout(r, 5)); // deixa os handlers assíncronos terminarem
  return { win, pc, events, advance, tick };
}
const status = (events: PageEvent[]) => events.filter((e) => e.type === "status").map((e) => (e as Extract<PageEvent, { type: "status" }>).state);

// ---- testes ----------------------------------------------------------------------------------------

test("o canal remoto collections marca a conexão e a extensão abre captions_v2 e captions", () => {
  const { pc, events } = setup();
  pc.remoteOpens(new FakeChannel("collections"));
  assert.deepEqual(pc.created.map((c) => c.label), ["captions_v2", "captions"]);
  for (const c of pc.created) {
    assert.equal(c.init.ordered, true);
    assert.equal(c.init.maxRetransmits, 10);
    assert.equal(c.binaryType, "arraybuffer");
  }
  assert.deepEqual(status(events), ["procurando"]);
});

test("fala recebida no captions_v2 vira lote com id/aparelho e é confirmada (ACK)", async () => {
  const { pc, events, advance, tick } = setup();
  pc.remoteOpens(new FakeChannel("collections"));
  const v2 = pc.created[0]!;
  v2.receive(v2Packet({ id: 41, version: 1, text: "bom" }).buffer);
  v2.receive(v2Packet({ id: 41, version: 2, text: "bom dia" }).buffer);
  await tick();
  advance(500);
  const batch = events.find((e) => e.type === "captions");
  assert.ok(batch && batch.type === "captions");
  assert.deepEqual(batch.messages.map((m) => [m.key, m.version, m.text]), [[`41/${DEVICE}`, 2, "bom dia"]]);
  assert.equal(v2.sent.length, 2); // uma confirmação por pacote
  const ref = readFields(readFields(readFields(v2.sent[1]!)![0]!.bytes!)![0]!.bytes!)!;
  assert.equal(ref.find((f) => f.field === 1)!.num, 41n);
  assert.equal(ref.find((f) => f.field === 2)!.num, 2n);
});

test("dado em Blob também é lido (canais criados pelo Meet vêm como blob)", async () => {
  const { pc, events, advance, tick } = setup();
  pc.remoteOpens(new FakeChannel("collections"));
  pc.created[0]!.receive(new Blob([v2Packet({ id: 5, version: 1, text: "blob" }) as BlobPart]));
  await tick();
  advance(500);
  assert.ok(events.some((e) => e.type === "captions" && e.messages[0]!.text === "blob"));
});

test("canal de legenda aberto pelo Meet: só escuta, não manda ACK", async () => {
  const { pc, events, advance, tick } = setup();
  const meetOwn = new FakeChannel("captions_v2");
  pc.dispatchEvent(Object.assign(new Event("datachannel"), { channel: meetOwn })); // sem collections ainda
  meetOwn.receive(v2Packet({ id: 8, version: 1, text: "do Meet" }).buffer);
  await tick();
  advance(500);
  assert.equal(meetOwn.sent.length, 0);
  assert.ok(events.some((e) => e.type === "captions" && e.messages[0]!.text === "do Meet"));
});

test("nomes do canal collections viram evento, só quando mudam", async () => {
  const { pc, events, tick } = setup();
  const collections = new FakeChannel("collections");
  pc.remoteOpens(collections);
  const pair = u8(bytes(2, bytes(1, [...text(1, DEVICE), ...text(2, "Maria")])));
  collections.receive(pair.buffer);
  collections.receive(pair.buffer);
  await tick();
  const names = events.filter((e) => e.type === "names");
  assert.equal(names.length, 1);
  assert.deepEqual((names[0] as Extract<PageEvent, { type: "names" }>).names, { [DEVICE]: "Maria" });
});

test("pacote com campo faltando é descartado com aviso, no máximo um por motivo a cada 30 s", async () => {
  const { pc, events, advance, tick } = setup();
  pc.remoteOpens(new FakeChannel("collections"));
  const v2 = pc.created[0]!;
  for (let i = 0; i < 3; i++) v2.receive(v2Packet({ id: i, version: 1, device: "" }).buffer);
  await tick();
  assert.equal(events.filter((e) => e.type === "status" && e.state === "descartado").length, 1);
  advance(31_000);
  v2.receive(v2Packet({ id: 9, version: 1, device: "" }).buffer);
  await tick();
  assert.equal(events.filter((e) => e.type === "status" && e.state === "descartado").length, 2);
  assert.ok(!events.some((e) => e.type === "captions" && e.messages.length)); // nada de lixo no texto
});

test("canal que cai com a chamada viva é recriado; com a chamada encerrada, não", () => {
  const { pc, events, advance } = setup();
  pc.remoteOpens(new FakeChannel("collections"));
  advance(5000);
  assert.ok(status(events).includes("aberto"));
  const before = pc.created.length;
  pc.created[0]!.readyState = "closed";
  advance(1000);
  assert.equal(pc.created.length, before + 1);
  assert.equal(pc.created.at(-1)!.label, "captions_v2");
  assert.ok(status(events).includes("reaberto"));

  pc.connectionState = "closed";
  pc.created.at(-1)!.readyState = "closed";
  advance(2000);
  assert.equal(pc.created.length, before + 1);
});

test("se nenhum canal abre em 5 s, avisa que falhou", () => {
  const { pc, events, advance } = setup();
  pc.remoteOpens(new FakeChannel("collections"));
  for (const c of pc.created) c.readyState = "connecting";
  advance(5200);
  assert.ok(status(events).includes("falhou"));
});

test("o createDataChannel do Meet continua funcionando (devolve o canal e não quebra com erro nosso)", () => {
  const { pc } = setup();
  const channel = pc.createDataChannel("meet_messages");
  assert.equal(channel.label, "meet_messages");
  assert.equal(pc.created.length, 1);
});
