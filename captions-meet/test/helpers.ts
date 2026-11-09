// Montagem de pacotes protobuf para os testes (um codificador mínimo, independente do código de produção).
export function varint(value: bigint): number[] {
  const out: number[] = [];
  let v = value;
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return out;
}
const tag = (field: number, wire: number) => varint(BigInt((field << 3) | wire));
export const num = (field: number, value: bigint | number) => [...tag(field, 0), ...varint(BigInt(value))];
export const bytes = (field: number, content: number[] | Uint8Array) => [...tag(field, 2), ...varint(BigInt(content.length)), ...content];
export const text = (field: number, s: string) => bytes(field, new TextEncoder().encode(s));
export const u8 = (a: number[]) => Uint8Array.from(a);

export const DEVICE = "spaces/AbC123/devices/dev-1";

/** Pacote do captions_v2 com uma fala. */
export function v2Packet(opts: { id: bigint | number; version: number; device?: string; text?: string; lang?: string }): Uint8Array {
  const caption = [...text(3, opts.text ?? "olá"), ...text(4, opts.lang ?? "pt-BR"), ...(opts.device === "" ? [] : text(6, opts.device ?? DEVICE))];
  const utterance = [...num(1, opts.id), ...num(2, opts.version), ...bytes(3, caption)];
  return u8(bytes(1, utterance));
}
