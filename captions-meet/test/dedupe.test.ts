import { test } from "node:test";
import assert from "node:assert/strict";
import { Deduper, type Msg } from "../src/page/dedupe.ts";

const msg = (over: Partial<Msg>): Msg => ({ key: "1/d", deviceId: "d", text: "oi", version: 1, lang: "pt", at: 0, ...over });
function setup() {
  const batches: Msg[][] = [];
  return { d: new Deduper((b) => batches.push(b)), batches };
}

test("a versão maior substitui a menor; a menor nunca sobrescreve a maior", () => {
  const { d, batches } = setup();
  d.push(msg({ version: 1, text: "bom" }));
  d.push(msg({ version: 3, text: "bom dia a todos" }));
  d.push(msg({ version: 2, text: "bom dia" })); // chegou atrasada
  d.tick();
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0]!.map((m) => [m.version, m.text]), [[3, "bom dia a todos"]]);
});

test("mesma versão repetida vale (a última) e conta como uma fala só", () => {
  const { d, batches } = setup();
  d.push(msg({ version: 2, text: "a", at: 0 }));
  d.push(msg({ version: 2, text: "b", at: 1000 }));
  d.tick();
  assert.equal(batches[0]!.length, 1);
});

test("ids diferentes com mesmo aparelho, versão e texto em 700 ms viram a mesma fala", () => {
  const { d, batches } = setup();
  d.push(msg({ key: "10/d", version: 2, text: "oi pessoal", at: 1000 }));
  d.push(msg({ key: "99/d", version: 2, text: "oi pessoal", at: 1300 })); // reenvio com outro id
  d.tick();
  assert.deepEqual(batches[0]!.map((m) => m.key), ["10/d"]);
  // e o próximo pacote com o id repetido continua apontando para o original (até 30 s)
  d.push(msg({ key: "99/d", version: 3, text: "oi pessoal, tudo bem?", at: 5000 }));
  d.tick();
  assert.deepEqual(batches[1]!.map((m) => [m.key, m.version]), [["10/d", 3]]);
});

test("passou de 700 ms: é outra fala, mesmo com texto igual", () => {
  const { d, batches } = setup();
  d.push(msg({ key: "10/d", version: 1, text: "sim", at: 0 }));
  d.push(msg({ key: "11/d", version: 1, text: "sim", at: 2000 }));
  d.tick();
  assert.equal(batches[0]!.length, 2);
});

test("aparelhos diferentes nunca se fundem", () => {
  const { d, batches } = setup();
  d.push(msg({ key: "1/a", deviceId: "a", text: "ok", at: 0 }));
  d.push(msg({ key: "2/b", deviceId: "b", text: "ok", at: 100 }));
  d.tick();
  assert.equal(batches[0]!.length, 2);
});

test("tick sem nada não emite, e o lote só sai uma vez", () => {
  const { d, batches } = setup();
  d.tick();
  d.push(msg({}));
  d.tick();
  d.tick();
  assert.equal(batches.length, 1);
});
