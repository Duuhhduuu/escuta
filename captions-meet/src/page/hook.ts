// Gancho do WebRTC: roda no mundo da página (world MAIN) e pega as legendas que o próprio Meet entrega em canais de dados.
//
// Como funciona (detalhes em docs/analise-tactiq.md):
//  1. O construtor RTCPeerConnection é trocado por um embrulho que escuta o evento "datachannel" (canais abertos pelo
//     servidor) e, em createDataChannel, os canais que o Meet abre localmente.
//  2. O canal remoto "collections" marca a conexão principal da chamada e traz o nome de cada participante.
//  3. Nessa conexão a extensão abre, por conta própria, os canais "captions_v2" (atual) e "captions" (antigo). Ao ver os
//     canais abertos o servidor passa a mandar as legendas por eles, e cada fala recebida em captions_v2 é confirmada
//     (ACK), como o cliente do Meet faz.
//  4. Se um canal nosso fechar com a conexão ainda viva, ele é recriado.
//
// `installHook` recebe a janela e as funções de tempo por parâmetro só para poder ser testado sem navegador.

import { Deduper, type Msg } from "./dedupe.ts";
import { decodeCaptionsV2, decodeDeviceNames, decodeLegacyCaptions, encodeAck, inflateIfGzip, type Decoded } from "./protocol.ts";

export type PageEvent =
  | { type: "captions"; messages: Msg[] }
  | { type: "names"; names: Record<string, string> }
  | { type: "status"; state: "procurando" | "aberto" | "reaberto" | "falhou" | "descartado"; detail?: string };

export interface Timers {
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  setTimeout(fn: () => void, ms: number): unknown;
}

const CAPTION_LABELS = ["captions_v2", "captions"] as const;
type CaptionLabel = (typeof CAPTION_LABELS)[number];

const WATCHDOG_MS = 1000;
const FLUSH_MS = 500;
const HEALTH_CHECK_MS = 5000;
const REJECT_REPORT_MS = 30_000;
/** Por quanto tempo depois de uma fala no captions_v2 o canal antigo fica em silêncio. */
const LEGACY_MUTED_MS = 30_000;

type Win = Window & typeof globalThis;

export function installHook(win: Win, emit: (event: PageEvent) => void, timers?: Timers): void {
  const t: Timers = timers ?? {
    now: () => Date.now(),
    setInterval: (fn, ms) => win.setInterval(fn, ms),
    setTimeout: (fn, ms) => win.setTimeout(fn, ms),
  };
  const Native = win.RTCPeerConnection;
  if (!Native) return;
  const nativeCreateDataChannel = Native.prototype.createDataChannel;

  let mainConnection: RTCPeerConnection | null = null;
  const ours = new Map<CaptionLabel, RTCDataChannel>();
  const listening = new WeakSet<RTCDataChannel>();
  const knownNames: Record<string, string> = {};
  const lastReject = new Map<string, number>();
  let everOpened = false;
  let v2SeenAt = -Infinity;

  const deduper = new Deduper((messages) => emit({ type: "captions", messages }));
  t.setInterval(() => deduper.tick(), FLUSH_MS);

  const reportRejected = (reason: string) => {
    const now = t.now();
    if (now - (lastReject.get(reason) ?? -Infinity) < REJECT_REPORT_MS) return;
    lastReject.set(reason, now);
    emit({ type: "status", state: "descartado", detail: reason });
  };

  // ---- recepção -----------------------------------------------------------------------------

  const toBytes = async (data: unknown): Promise<Uint8Array | null> => {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (typeof Blob !== "undefined" && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
    return null; // texto: o Meet não manda legenda assim
  };

  const accept = (decoded: Decoded, channel: RTCDataChannel, ack: boolean, label: CaptionLabel) => {
    if (decoded.kind === "rejected") return reportRejected(decoded.reason);
    if (decoded.kind === "control") return;
    // Os dois canais podem entregar a MESMA fala (ids diferentes, versões diferentes): sem isto a transcrição saía repetida.
    // Enquanto o captions_v2 estiver entregando, o canal antigo é ignorado.
    if (label === "captions_v2") v2SeenAt = t.now();
    else if (t.now() - v2SeenAt < LEGACY_MUTED_MS) return;
    const c = decoded.caption;
    deduper.push({ key: `${c.utteranceId}/${c.deviceId}`, deviceId: c.deviceId, text: c.text, version: c.version, lang: c.lang, at: t.now() });
    if (ack) {
      try {
        channel.send(encodeAck(c.utteranceId, c.version) as unknown as ArrayBuffer);
      } catch {
        // canal fechando: o vigia recria, e o Meet reenvia a fala
      }
    }
  };

  const listenCaptions = (channel: RTCDataChannel, label: CaptionLabel, mine: boolean) => {
    if (listening.has(channel)) return;
    listening.add(channel);
    channel.addEventListener("message", async (event) => {
      const raw = await toBytes((event as MessageEvent).data);
      if (!raw) return;
      const bytes = await inflateIfGzip(raw).catch(() => raw);
      accept(label === "captions_v2" ? decodeCaptionsV2(bytes) : decodeLegacyCaptions(bytes), channel, mine && label === "captions_v2", label);
    });
  };

  const listenNames = (channel: RTCDataChannel) => {
    if (listening.has(channel)) return;
    listening.add(channel);
    channel.addEventListener("message", async (event) => {
      const raw = await toBytes((event as MessageEvent).data);
      if (!raw) return;
      const bytes = await inflateIfGzip(raw).catch(() => raw);
      const fresh: Record<string, string> = {};
      for (const { deviceId, name } of decodeDeviceNames(bytes)) {
        if (knownNames[deviceId] !== name) {
          knownNames[deviceId] = name;
          fresh[deviceId] = name;
        }
      }
      if (Object.keys(fresh).length) emit({ type: "names", names: fresh });
    });
  };

  // ---- abertura dos nossos canais ------------------------------------------------------------

  const open = (label: CaptionLabel): RTCDataChannel | null => {
    const pc = mainConnection;
    if (!pc) return null;
    try {
      // Sem "id": num canal não negociado o Chrome escolhe o id sozinho (testado em Chromium real: o id pedido é ignorado).
      const channel = nativeCreateDataChannel.call(pc, label, { ordered: true, maxRetransmits: 10 });
      channel.binaryType = "arraybuffer";
      ours.set(label, channel);
      listenCaptions(channel, label, true);
      return channel;
    } catch {
      return null;
    }
  };

  const startCaptions = () => {
    emit({ type: "status", state: "procurando" });
    for (const label of CAPTION_LABELS) if (!ours.has(label)) open(label);
    t.setTimeout(() => {
      const anyOpen = [...ours.values()].some((c) => c.readyState === "open");
      if (anyOpen) {
        everOpened = true;
        emit({ type: "status", state: "aberto" });
      } else {
        emit({ type: "status", state: "falhou", detail: "nenhum canal de legendas abriu em 5 s" });
      }
    }, HEALTH_CHECK_MS);
  };

  // Vigia: recria o canal que caiu enquanto a chamada continua.
  t.setInterval(() => {
    const pc = mainConnection;
    if (!pc) return;
    if (pc.connectionState === "closed" || pc.connectionState === "failed") {
      mainConnection = null;
      ours.clear();
      return;
    }
    for (const label of CAPTION_LABELS) {
      const channel = ours.get(label);
      if (channel && (channel.readyState === "closing" || channel.readyState === "closed") && open(label)) {
        emit({ type: "status", state: everOpened ? "reaberto" : "procurando", detail: label });
      }
    }
  }, WATCHDOG_MS);

  // ---- ganchos ------------------------------------------------------------------------------------

  const onChannel = (channel: RTCDataChannel, pc: RTCPeerConnection, origin: "local" | "remote") => {
    const label = channel.label;
    if (label === "collections" && origin === "remote") {
      listenNames(channel);
      if (mainConnection !== pc) {
        mainConnection = pc;
        ours.clear();
        startCaptions();
      }
    } else if ((CAPTION_LABELS as readonly string[]).includes(label) && !ours.has(label as CaptionLabel)) {
      // Canal de legenda aberto pelo Meet: só escuta, sem confirmar (quem responde é o cliente do Meet).
      listenCaptions(channel, label as CaptionLabel, false);
    }
  };

  Native.prototype.createDataChannel = function (this: RTCPeerConnection, ...args: Parameters<RTCPeerConnection["createDataChannel"]>) {
    const channel = nativeCreateDataChannel.apply(this, args);
    try {
      onChannel(channel, this, "local");
    } catch {
      // nunca atrapalhar o Meet
    }
    return channel;
  };

  const Hooked = function (this: unknown, ...args: ConstructorParameters<typeof RTCPeerConnection>) {
    const pc = new Native(...args);
    pc.addEventListener("datachannel", (event) => {
      try {
        onChannel((event as RTCDataChannelEvent).channel, pc, "remote");
      } catch {
        // idem
      }
    });
    return pc;
  } as unknown as typeof RTCPeerConnection;
  Hooked.prototype = Native.prototype;
  Object.setPrototypeOf(Hooked, Native);
  win.RTCPeerConnection = Hooked;
  const legacy = win as unknown as { webkitRTCPeerConnection?: unknown };
  if (legacy.webkitRTCPeerConnection) legacy.webkitRTCPeerConnection = Hooked;
}
