// Content script (mundo isolado): recebe o que o gancho da página pega e grava por sala.
// A página e o content script só se falam por postMessage com a etiqueta SOURCE, conferindo janela e origem.
import { roomFromPath, SOURCE } from "../shared.ts";
import type { PageEvent } from "../page/hook.ts";
import { RoomStore, type KeyValue, type Room } from "./store.ts";

const code = roomFromPath(location.pathname);

if (code) {
  const storage: KeyValue = {
    get: async (key) => (await chrome.storage.local.get(key))[key] as Room | undefined,
    set: (key, room) => chrome.storage.local.set({ [key]: room }),
  };
  const store = new RoomStore(code, storage);
  let ready = false;
  const waiting: PageEvent[] = [];

  const apply = (event: PageEvent) => {
    if (event.type === "captions") store.addMessages(event.messages);
    else if (event.type === "names") store.addNames(event.names);
    else store.setStatus(event.detail ? `${event.state}: ${event.detail}` : event.state);
  };

  // O gancho começa a falar antes de o armazenamento terminar de carregar: guarda e aplica depois.
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const data = e.data as (PageEvent & { source?: string }) | null;
    if (!data || data.source !== SOURCE) return;
    if (ready) apply(data);
    else waiting.push(data);
  });

  store
    .load()
    .catch(() => {})
    .then(() => {
      ready = true;
      for (const event of waiting.splice(0)) apply(event);
      void store.save();
    });

  setInterval(() => void store.save().catch(() => {}), 2000);
  window.addEventListener("pagehide", () => void store.save().catch(() => {}));
}
