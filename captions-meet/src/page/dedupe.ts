// Deduplicação das falas: o Meet reenvia a mesma fala várias vezes, com o texto crescendo (versão maior), e às vezes
// com um id diferente. Duas regras:
//   1. mesmo id: só vale a versão MAIOR OU IGUAL à que já temos (a parcial vira final, nunca o contrário);
//   2. ids diferentes com o mesmo aparelho, versão e texto em até 700 ms: é a mesma fala, passa a valer o primeiro id.
// As mensagens saem em lotes, para o consumidor receber um evento a cada ~500 ms e não um por pacote.

export interface Msg {
  /** `idDaFala/aparelho`, estável para a mesma fala. */
  key: string;
  deviceId: string;
  text: string;
  version: number;
  lang: string;
  /** Quando foi recebida (ms desde 1970). */
  at: number;
}

const SIGNATURE_WINDOW_MS = 700;
const ALIAS_TTL_MS = 30_000;
const MAX_ENTRIES = 512;

interface Dated<T> {
  value: T;
  at: number;
}

/** Remove o que passou do prazo e, se ainda passar do limite, as entradas mais antigas. */
function prune<T>(map: Map<string, Dated<T>>, now: number, ttl: number): void {
  for (const [k, v] of map) if (now - v.at > ttl) map.delete(k);
  if (map.size <= MAX_ENTRIES) return;
  const oldest = [...map.entries()].sort((a, b) => a[1].at - b[1].at);
  for (const [k] of oldest.slice(0, map.size - MAX_ENTRIES)) map.delete(k);
}

export class Deduper {
  private signatures = new Map<string, Dated<string>>(); // aparelho|versão|texto -> chave da fala
  private aliases = new Map<string, Dated<string>>(); // chave repetida -> chave original
  private buffer = new Map<string, Msg>();

  constructor(private readonly flush: (batch: Msg[]) => void) {}

  push(incoming: Msg): void {
    const now = incoming.at;
    let msg = incoming;

    const alias = this.aliases.get(msg.key);
    if (alias && now - alias.at <= ALIAS_TTL_MS) {
      alias.at = now;
      msg = { ...msg, key: alias.value };
    } else {
      const signature = `${msg.deviceId}|${msg.version}|${msg.text}`;
      const seen = this.signatures.get(signature);
      if (seen && now - seen.at <= SIGNATURE_WINDOW_MS) {
        if (seen.value !== msg.key) {
          this.aliases.set(msg.key, { value: seen.value, at: now });
          msg = { ...msg, key: seen.value };
        }
      } else {
        this.signatures.set(signature, { value: msg.key, at: now });
      }
      prune(this.signatures, now, SIGNATURE_WINDOW_MS);
      prune(this.aliases, now, ALIAS_TTL_MS);
    }

    const current = this.buffer.get(msg.key);
    if (!current || msg.version >= current.version) this.buffer.set(msg.key, msg);
  }

  /** Entrega o lote acumulado (se houver). Chamado a cada 500 ms pelo gancho. */
  tick(): void {
    if (!this.buffer.size) return;
    const batch = [...this.buffer.values()];
    this.buffer.clear();
    this.flush(batch);
  }
}
