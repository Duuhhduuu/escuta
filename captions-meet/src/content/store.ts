// Guarda as falas de uma sala no armazenamento local do navegador. Tudo fica na máquina: sem rede, sem conta.
import type { Msg } from "../page/dedupe.ts";

export interface Entry {
  key: string;
  deviceId: string;
  text: string;
  version: number;
  lang: string;
  /** Quando a fala apareceu pela primeira vez: é o horário que vai para a exportação. */
  firstAt: number;
  updatedAt: number;
}

export interface Room {
  code: string;
  startedAt: number;
  updatedAt: number;
  entries: Record<string, Entry>;
  /** id do aparelho -> nome do participante. Resolvido só na exportação, porque o nome pode chegar depois da fala. */
  names: Record<string, string>;
  /** Último estado do gancho (aberto, falhou, ...), para o popup mostrar por que não vem nada. */
  status?: string;
}

export interface KeyValue {
  get(key: string): Promise<Room | undefined>;
  set(key: string, room: Room): Promise<void>;
}

export const roomKey = (code: string) => `sala:${code}`;

export class RoomStore {
  room: Room;
  private dirty = false;

  constructor(
    code: string,
    private readonly storage: KeyValue,
    private readonly now: () => number = Date.now,
  ) {
    const t = now();
    this.room = { code, startedAt: t, updatedAt: t, entries: {}, names: {} };
  }

  /** Retoma o que já estava salvo desta sala (recarregar a página não apaga a transcrição). */
  async load(): Promise<void> {
    const saved = await this.storage.get(roomKey(this.room.code));
    if (!saved) return;
    // O que chegou enquanto carregava vale por cima do que estava salvo (a regra de versão decide).
    const fresh = this.room;
    this.room = { ...saved, status: fresh.status ?? saved.status };
    this.addMessages(Object.values(fresh.entries).map((e) => ({ key: e.key, deviceId: e.deviceId, text: e.text, version: e.version, lang: e.lang, at: e.firstAt })));
    this.addNames(fresh.names);
  }

  addMessages(messages: Msg[]): void {
    const t = this.now();
    for (const m of messages) {
      const current = this.room.entries[m.key];
      if (current && m.version < current.version) continue; // versão mais velha: ignora (parcial nunca sobrescreve final)
      if (current && current.version === m.version && current.text === m.text) continue;
      this.room.entries[m.key] = {
        key: m.key,
        deviceId: m.deviceId,
        text: m.text,
        version: m.version,
        lang: m.lang,
        firstAt: current?.firstAt ?? m.at,
        updatedAt: t,
      };
      this.dirty = true;
      this.room.updatedAt = t;
    }
  }

  addNames(names: Record<string, string>): void {
    for (const [id, name] of Object.entries(names)) {
      if (this.room.names[id] !== name) {
        this.room.names[id] = name;
        this.dirty = true;
      }
    }
  }

  setStatus(status: string): void {
    if (this.room.status === status) return;
    this.room.status = status;
    this.dirty = true;
  }

  /** Grava se mudou algo desde a última vez. */
  async save(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    await this.storage.set(roomKey(this.room.code), this.room);
  }
}
