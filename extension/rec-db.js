// Pedaços da gravação de reunião, no IndexedDB da extensão. O gravador (recorder.js)
// grava um pedaço a cada 10 s e o service worker junta tudo na hora de enviar.
// Assim, uma reunião de uma hora não vive na memória, e se o navegador cair ou o
// servidor estiver desligado na hora de parar, o áudio continua aqui para tentar de novo.
const RecDB = (() => {
  const open = () =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open("escuta-rec", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("chunks", { keyPath: ["rec", "i"] });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

  // Roda fn(store) numa transação e devolve o resultado do pedido que fn devolver.
  async function run(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("chunks", mode);
      const request = fn(tx.objectStore("chunks"));
      tx.oncomplete = () => {
        db.close();
        resolve(request?.result);
      };
      tx.onerror = tx.onabort = () => {
        db.close();
        reject(tx.error);
      };
    });
  }

  const range = (rec) => IDBKeyRange.bound([rec, 0], [rec, Infinity]);

  return {
    add: (rec, i, blob) => run("readwrite", (store) => store.put({ rec, i, blob })),
    async blob(rec, type) {
      const chunks = await run("readonly", (store) => store.getAll(range(rec)));
      return new Blob(chunks.map((c) => c.blob), { type });
    },
    drop: (rec) => run("readwrite", (store) => store.delete(range(rec))),
    // Ids de gravações que ainda têm pedaços guardados.
    async ids() {
      const keys = await run("readonly", (store) => store.getAllKeys());
      return [...new Set(keys.map(([rec]) => rec))];
    },
  };
})();
