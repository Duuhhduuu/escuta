import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeCaptionsV2, decodeDeviceNames, decodeLegacyCaptions, encodeAck, inflateIfGzip, readFields } from "../src/page/protocol.ts";
import { bytes, DEVICE, num, text, u8, v2Packet } from "./helpers.ts";

test("captions_v2: lê id, versão, texto, idioma e aparelho", () => {
  const out = decodeCaptionsV2(v2Packet({ id: 7, version: 3, text: "bom dia a todos" }));
  assert.equal(out.kind, "caption");
  if (out.kind !== "caption") return;
  assert.deepEqual(out.caption, { utteranceId: "7", version: 3, deviceId: DEVICE, text: "bom dia a todos", lang: "pt-BR" });
});

test("captions_v2: id de 64 bits não perde precisão", () => {
  const big = 9007199254740993n; // 2^53 + 1: um Number arredondaria
  const out = decodeCaptionsV2(v2Packet({ id: big, version: 1 }));
  assert.ok(out.kind === "caption" && out.caption.utteranceId === "9007199254740993");
});

test("captions_v2: acentos e emoji ficam inteiros", () => {
  const out = decodeCaptionsV2(v2Packet({ id: 1, version: 1, text: "Então, é isso — ótimo 👍" }));
  assert.ok(out.kind === "caption" && out.caption.text === "Então, é isso — ótimo 👍");
});

test("captions_v2: descarta com motivo quando falta peça ou o dado é lixo", () => {
  assert.deepEqual(decodeCaptionsV2(v2Packet({ id: 1, version: 1, device: "" })), { kind: "rejected", reason: "sem-aparelho" });
  assert.deepEqual(decodeCaptionsV2(u8([])), { kind: "rejected", reason: "sem-fala" });
  assert.equal(decodeCaptionsV2(u8([0xff, 0xff, 0xff])).kind, "rejected");
  assert.equal(decodeCaptionsV2(u8([0x0a, 0x7f, 1, 2])).kind, "rejected"); // tamanho passa do fim
});

test("captions antigo: lê a mensagem e reconhece o pacote de controle", () => {
  const message = [...text(1, DEVICE), ...num(2, 55), ...num(3, 2), ...text(6, "oi gente"), ...num(8, 70)];
  const out = decodeLegacyCaptions(u8(bytes(1, message)));
  assert.ok(out.kind === "caption" && out.caption.text === "oi gente" && out.caption.version === 2 && out.caption.utteranceId === "55");
  assert.deepEqual(decodeLegacyCaptions(u8(text(2, "x"))), { kind: "control" });
  // sem idioma: não vale (a Tactiq também exige)
  const semIdioma = [...text(1, DEVICE), ...num(2, 1), ...num(3, 1), ...text(6, "x")];
  assert.equal(decodeLegacyCaptions(u8(bytes(1, semIdioma))).kind, "rejected");
});

test("ACK: bate com Ack{1:Corpo{1:Ref{1:id,2:versão,3:1}}}", () => {
  const ack = encodeAck("123456789012345678", 4);
  const body = readFields(readFields(ack)![0]!.bytes!)!;
  const ref = readFields(body[0]!.bytes!)!;
  assert.equal(ref.find((f) => f.field === 1)!.num, 123456789012345678n);
  assert.equal(ref.find((f) => f.field === 2)!.num, 4n);
  assert.equal(ref.find((f) => f.field === 3)!.num, 1n);
});

test("nomes: acha o par aparelho/nome em qualquer nível de aninhamento", () => {
  const pair = [...text(1, DEVICE), ...text(2, "Maria Souza")];
  const nested = u8(bytes(3, bytes(1, bytes(5, pair))));
  assert.deepEqual(decodeDeviceNames(nested), [{ deviceId: DEVICE, name: "Maria Souza" }]);
  // um par onde o "nome" é outro id de aparelho não conta
  assert.deepEqual(decodeDeviceNames(u8([...text(1, DEVICE), ...text(2, DEVICE)])), []);
  assert.deepEqual(decodeDeviceNames(u8([1, 2, 3])), []);
});

test("gzip: descomprime com ou sem prefixo de 3 bytes; o resto passa direto", async () => {
  const plain = v2Packet({ id: 9, version: 1 });
  const zipped = new Uint8Array(await new Response(new Blob([plain as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
  assert.deepEqual(await inflateIfGzip(zipped), plain);
  assert.deepEqual(await inflateIfGzip(Uint8Array.from([1, 2, 3, ...zipped])), plain);
  assert.deepEqual(await inflateIfGzip(plain), plain);
});
