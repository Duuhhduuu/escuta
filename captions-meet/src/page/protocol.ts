// Leitura e escrita do protobuf que o Meet usa nos canais de legenda.
//
// Não há schema público: os números de campo abaixo foram obtidos observando o tráfego (ver docs/analise-tactiq.md, seção 5).
// Se o Google mudar algum número, a fala deixa de ser reconhecida sem erro visível; por isso cada função devolve um
// motivo de descarte (`reason`), para o gancho poder contar e avisar.

const textDecoder = new TextDecoder();

/** Um campo cru de uma mensagem protobuf: número, tipo de fio e valor. */
export interface Field {
  field: number;
  wire: number;
  /** Para varint (tipo 0), 64 bits (1) e 32 bits (5). */
  num?: bigint;
  /** Para blocos com tamanho (tipo 2): texto, bytes ou mensagem aninhada. */
  bytes?: Uint8Array;
}

/** Lê um varint a partir de `pos`. Devolve o valor e a próxima posição, ou null se o dado acabar no meio. */
function readVarint(buf: Uint8Array, pos: number): { value: bigint; next: number } | null {
  let value = 0n;
  let shift = 0n;
  for (let i = pos; i < buf.length && shift < 70n; i++) {
    const byte = buf[i]!;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: i + 1 };
    shift += 7n;
  }
  return null;
}

/** Separa os campos de uma mensagem. Devolve null se o dado não for um protobuf válido (tipo de fio desconhecido, corte no meio). */
export function readFields(buf: Uint8Array): Field[] | null {
  const fields: Field[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    if (!tag) return null;
    pos = tag.next;
    const field = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (field === 0) return null;
    if (wire === 0) {
      const v = readVarint(buf, pos);
      if (!v) return null;
      pos = v.next;
      fields.push({ field, wire, num: v.value });
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      if (pos + size > buf.length) return null;
      let value = 0n;
      for (let i = size - 1; i >= 0; i--) value = (value << 8n) | BigInt(buf[pos + i]!);
      pos += size;
      fields.push({ field, wire, num: value });
    } else if (wire === 2) {
      const len = readVarint(buf, pos);
      if (!len) return null;
      const size = Number(len.value);
      const start = len.next;
      if (size < 0 || start + size > buf.length) return null;
      fields.push({ field, wire, bytes: buf.subarray(start, start + size) });
      pos = start + size;
    } else {
      return null; // grupos (3 e 4) e outros tipos não aparecem nesse protocolo
    }
  }
  return fields;
}

const first = (fields: Field[], n: number) => fields.find((f) => f.field === n);
const str = (f: Field | undefined) => (f?.bytes ? textDecoder.decode(f.bytes) : undefined);

// ---- legendas v2 ------------------------------------------------------------------------------

export interface Caption {
  /** Id da fala (int64 em texto, para não perder precisão). */
  utteranceId: string;
  /** Sobe a cada revisão do texto da mesma fala. */
  version: number;
  deviceId: string;
  text: string;
  lang: string;
}

export type Decoded = { kind: "caption"; caption: Caption } | { kind: "control" } | { kind: "rejected"; reason: string };

/**
 * Pacote do canal `captions_v2`:
 *   Pacote { 1: Fala }   Fala { 1: id (int64), 2: versão (int64), 3: Legenda }   Legenda { 3: texto, 4: idioma, 6: aparelho }
 */
export function decodeCaptionsV2(buf: Uint8Array): Decoded {
  const packet = readFields(buf);
  if (!packet) return { kind: "rejected", reason: "pacote-invalido" };
  const utteranceBytes = first(packet, 1)?.bytes;
  if (!utteranceBytes) return { kind: "rejected", reason: "sem-fala" };
  const utterance = readFields(utteranceBytes);
  if (!utterance) return { kind: "rejected", reason: "fala-invalida" };
  const id = first(utterance, 1)?.num;
  if (id === undefined) return { kind: "rejected", reason: "sem-id" };
  const captionBytes = first(utterance, 3)?.bytes;
  const caption = captionBytes && readFields(captionBytes);
  if (!caption) return { kind: "rejected", reason: "sem-legenda" };
  const deviceId = str(first(caption, 6));
  if (!deviceId) return { kind: "rejected", reason: "sem-aparelho" };
  return {
    kind: "caption",
    caption: {
      utteranceId: id.toString(),
      version: Number(first(utterance, 2)?.num ?? 0n),
      deviceId,
      text: str(first(caption, 3)) ?? "",
      lang: str(first(caption, 4)) ?? "",
    },
  };
}

/**
 * Pacote do canal antigo `captions`:
 *   Embrulho { 1: Mensagem, 2: texto }   (o campo 2 presente = só controle)
 *   Mensagem { 1: aparelho, 2: id (int64), 3: versão (int64), 6: texto, 8: idioma (número) }
 */
export function decodeLegacyCaptions(buf: Uint8Array): Decoded {
  const wrapper = readFields(buf);
  if (!wrapper) return { kind: "rejected", reason: "pacote-invalido" };
  if (first(wrapper, 2)) return { kind: "control" };
  const bytes = first(wrapper, 1)?.bytes;
  const message = bytes && readFields(bytes);
  if (!message) return { kind: "rejected", reason: "sem-mensagem" };
  const deviceId = str(first(message, 1));
  const id = first(message, 2)?.num;
  const version = first(message, 3)?.num;
  const langId = first(message, 8)?.num;
  if (!deviceId || id === undefined || version === undefined || langId === undefined) return { kind: "rejected", reason: "campos-faltando" };
  return { kind: "caption", caption: { utteranceId: id.toString(), version: Number(version), deviceId, text: str(first(message, 6)) ?? "", lang: `#${langId}` } };
}

// ---- confirmação (ACK) -------------------------------------------------------------------------

function varint(value: bigint): number[] {
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
const varintField = (field: number, value: bigint) => [...tag(field, 0), ...varint(value)];
const lenField = (field: number, bytes: number[]) => [...tag(field, 2), ...varint(BigInt(bytes.length)), ...bytes];

/**
 * Confirmação de uma fala recebida no `captions_v2`:
 *   Ack { 1: Corpo }   Corpo { 1: Ref }   Ref { 1: id, 2: versão, 3: 1 }
 */
export function encodeAck(utteranceId: string, version: number): Uint8Array {
  const ref = [...varintField(1, BigInt(utteranceId)), ...varintField(2, BigInt(version)), ...varintField(3, 1n)];
  return Uint8Array.from(lenField(1, lenField(1, ref)));
}

// ---- participantes -----------------------------------------------------------------------------

const DEVICE_ID = /^spaces\/[\w-]+\/devices\/[\w-]+$/;

/**
 * O canal `collections` traz, em algum nível de aninhamento, um par { 1: id do aparelho, 2: nome }. Como o caminho até ele
 * já mudou de versão para versão, em vez de seguir um caminho fixo a busca desce pelas mensagens aninhadas.
 */
export function decodeDeviceNames(buf: Uint8Array, depth = 0): Array<{ deviceId: string; name: string }> {
  const out: Array<{ deviceId: string; name: string }> = [];
  const fields = readFields(buf);
  if (!fields || depth > 6) return out;
  const id = str(first(fields, 1));
  const name = str(first(fields, 2));
  if (id && name && DEVICE_ID.test(id) && name.trim() && !DEVICE_ID.test(name)) out.push({ deviceId: id, name: name.trim() });
  for (const f of fields) if (f.bytes && f.bytes.length > 4) out.push(...decodeDeviceNames(f.bytes, depth + 1));
  return out;
}

/** Descomprime quando o pacote vem em gzip (marca 1F 8B 08, às vezes depois de 3 bytes de prefixo). */
export async function inflateIfGzip(data: Uint8Array): Promise<Uint8Array> {
  const isGzip = (b: Uint8Array) => b.length > 3 && b[0] === 0x1f && b[1] === 0x8b && b[2] === 8;
  const body = isGzip(data) ? data : isGzip(data.subarray(3)) ? data.subarray(3) : null;
  if (!body) return data;
  const stream = new Blob([body as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
