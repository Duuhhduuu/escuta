// Teste ponta a ponta no Chrome de verdade: carrega a extensão sem empacotar, serve uma página "meet.google.com/abc-defg-hij"
// que monta uma conexão WebRTC real entre dois lados (o lado A faz o papel do servidor do Meet) e confere que:
//  - a extensão abre captions_v2 sozinha,
//  - as falas chegam, a versão maior vence e o nome do participante é aprendido,
//  - o ACK volta para o "servidor",
//  - tudo é gravado em chrome.storage.local pela sala.
// Uso:  npm run build && npm run test:e2e
// Precisa de um Chromium que aceite --load-extension (o Chrome de marca não aceita): o do Playwright serve. Defina CHROMIUM
// com o caminho do executável, ou ele procura a pasta ms-playwright. Precisa também do `openssl` (certificado de teste).
const { spawn, execFileSync } = require("child_process"); const https = require("https"); const fs = require("fs"); const os = require("os"); const path = require("path");
const EXT = path.resolve(__dirname, "..");
const CHROMIUM = process.env.CHROMIUM || (() => {
  const root = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".cache"), "ms-playwright");
  const dir = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => d.startsWith("chromium-")).sort().pop() : null;
  if (!dir) throw new Error("Chromium não encontrado: defina CHROMIUM=caminho/do/chrome");
  return path.join(root, dir, "chrome-win64", "chrome.exe");
})();
// O Meet está na lista HSTS do Chrome: para servir a sala falsa é preciso https, com certificado autoassinado.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "legendas-e2e-"));
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(TMP, "k.pem"), "-out", path.join(TMP, "c.pem"), "-days", "2", "-subj", "/CN=meet.google.com"], { stdio: "ignore", env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
const PAGE = `<!doctype html><meta charset=utf-8><title>Meet falso</title><script>
const enc = new TextEncoder();
const varint = (v) => { v = BigInt(v); const o = []; while (v >= 0x80n) { o.push(Number((v & 0x7fn) | 0x80n)); v >>= 7n; } o.push(Number(v)); return o; };
const tag = (f, w) => varint((f << 3) | w);
const num = (f, v) => [...tag(f, 0), ...varint(v)];
const len = (f, b) => [...tag(f, 2), ...varint(b.length), ...b];
const str = (f, s) => len(f, [...enc.encode(s)]);
const DEV = "spaces/AbC123/devices/dev-1";
const fala = (id, version, texto) => new Uint8Array(len(1, [...num(1, id), ...num(2, version), ...len(3, [...str(3, texto), ...str(4, "pt-BR"), ...str(6, DEV)])]));
window.__log = { acks: [], opened: [] };
(async () => {
  const A = new RTCPeerConnection(), B = new RTCPeerConnection();   // os dois passam pelo gancho, como no Meet
  A.onicecandidate = (e) => e.candidate && B.addIceCandidate(e.candidate);
  B.onicecandidate = (e) => e.candidate && A.addIceCandidate(e.candidate);
  const collections = A.createDataChannel("collections");            // o servidor abre "collections"; B é a conexão principal
  A.addEventListener("datachannel", (ev) => {                        // canais que a EXTENSÃO abriu em B chegam aqui
    window.__log.opened.push(ev.channel.label + "#" + ev.channel.id);
    ev.channel.binaryType = "arraybuffer";
    ev.channel.onmessage = (m) => window.__log.acks.push(Array.from(new Uint8Array(m.data)));
    if (ev.channel.label === "captions_v2") window.__v2 = ev.channel;
  });
  await A.setLocalDescription(await A.createOffer()); await B.setRemoteDescription(A.localDescription);
  await B.setLocalDescription(await B.createAnswer()); await A.setRemoteDescription(B.localDescription);
  await new Promise((r) => { const t = setInterval(() => window.__v2 && collections.readyState === "open" && (clearInterval(t), r()), 50); });
  window.__ready = true;
  window.__send = {
    nomes: () => collections.send(new Uint8Array(len(2, len(1, [...str(1, DEV), ...str(2, "Maria Souza")])))),
    fala: (id, v, t) => window.__v2.send(fala(id, v, t)),
  };
})();
</script>`;
(async () => {
  const server = https.createServer({ key: fs.readFileSync(path.join(TMP, "k.pem")), cert: fs.readFileSync(path.join(TMP, "c.pem")) }, (q, r) => { r.setHeader("content-type", "text/html; charset=utf-8"); r.end(PAGE); }).listen(0);
  const sp = server.address().port, port = 9300 + Math.floor(Math.random() * 90);
  const chrome = spawn(CHROMIUM, ["--headless=new", "--remote-debugging-port=" + port, "--load-extension=" + EXT, "--disable-extensions-except=" + EXT, "--host-resolver-rules=MAP meet.google.com 127.0.0.1", "--ignore-certificate-errors", "--disable-features=DisableLoadExtensionCommandLineSwitch", "--user-data-dir=" + path.join(TMP, "profile"), "about:blank"], { stdio: "ignore" });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(3000);
  const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = {}; const contexts = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend[d.id]) pend[d.id](d); if (d.method === "Runtime.executionContextCreated") contexts.push(d.params.context); };
  const call = (method, params = {}) => new Promise((r) => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (e, contextId) => { const r = await call("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true, ...(contextId ? { contextId } : {}) }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result.result.value; };
  await call("Runtime.enable"); await call("Page.enable");
  await call("Page.navigate", { url: `https://meet.google.com:${sp}/abc-defg-hij` });
  let ok = true; const check = (nome, cond, extra = "") => { ok = ok && cond; console.log((cond ? "OK   " : "FALHA"), nome, extra); };
  for (let i = 0; i < 80 && !(await ev("window.__ready === true").catch(() => false)); i++) await sleep(100);
  console.log("url:", await ev("location.href"), "| titulo:", await ev("document.title"), "| __log:", await ev("typeof window.__log"));
  console.log("hook:", await ev("String(window.__escutaLegendas)"), "| contextos:", JSON.stringify(contexts.map((c) => c.name + "@" + c.origin)), "| pcs:", await ev("RTCPeerConnection.toString().slice(0,60)"));
  check("chamada de teste montada", await ev("window.__ready === true"));
  console.log("canais abertos pela extensão:", JSON.stringify(await ev("window.__log.opened")));
  check("a extensão abriu captions_v2 e captions sozinha", await ev("window.__log.opened.some(x=>x.startsWith('captions_v2#')) && window.__log.opened.some(x=>x.startsWith('captions#'))"));
  await ev("window.__send.nomes(); window.__send.fala(7, 1, 'bom'); 1"); await sleep(150);
  await ev("window.__send.fala(7, 3, 'bom dia a todos'); window.__send.fala(7, 2, 'bom dia'); window.__send.fala(8, 1, 'Fechado.'); 1");
  await sleep(2800); // lote de 500 ms + gravação a cada 2 s
  check("o servidor recebeu os ACKs das falas", (await ev("window.__log.acks.length")) >= 3, "(" + (await ev("window.__log.acks.length")) + ")");
  const extCtx = contexts.find((c) => c.name === "Escuta Legendas (Meet)" || /chrome-extension:/.test(c.origin));
  check("content script ativo na página", !!extCtx);
  const room = await ev("chrome.storage.local.get('sala:abc-defg-hij').then(r => r['sala:abc-defg-hij'])", extCtx.id);
  console.log("sala gravada:", JSON.stringify(room && { code: room.code, status: room.status, names: room.names, falas: Object.values(room.entries).map((e) => [e.version, e.text]) }));
  check("sala gravada pelo código", room && room.code === "abc-defg-hij");
  const falas = room ? Object.values(room.entries).map((e) => e.text).sort() : [];
  check("duas falas: a versão maior venceu e a atrasada não sobrescreveu", JSON.stringify(falas) === JSON.stringify(["Fechado.", "bom dia a todos"]));
  check("nome do participante aprendido", room && room.names["spaces/AbC123/devices/dev-1"] === "Maria Souza");
  check("estado do gancho registrado", room && /aberto|procurando/.test(room.status || ""));
  // popup: lista a sala com a contagem e deixa exportar
  const extId = extCtx.origin.replace("chrome-extension://", "");
  await call("Page.navigate", { url: `chrome-extension://${extId}/popup.html` }); await sleep(1200);
  const popup = await ev("JSON.stringify({texto: document.getElementById('rooms').innerText, botoes: [...document.querySelectorAll('.room button')].map(b => b.textContent + (b.disabled ? ' (desligado)' : ''))})");
  console.log("popup:", popup);
  const pp = JSON.parse(popup);
  check("popup mostra a sala, 2 falas e 1 participante", /abc-defg-hij/.test(pp.texto) && /2 falas · 1 participante/.test(pp.texto));
  check("botões Exportar .md, .txt e Apagar ligados", JSON.stringify(pp.botoes) === JSON.stringify(["Exportar .md", "Exportar .txt", "Apagar"]));
  console.log(ok ? "\nTUDO OK" : "\nHÁ FALHAS");
  chrome.kill(); server.close(); process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("FALHOU", e.message); process.exit(1); });
