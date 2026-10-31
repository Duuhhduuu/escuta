// Injetado na aba da reunião (chrome.scripting, quando a pessoa começa a gravar). Desenha um
// painel flutuante no lado direito, como o do Tactiq, que é só uma moldura para live.html: a
// transcrição, as notas e os botões moram lá dentro. Este arquivo cuida da casca: posição,
// minimizar, fechar. Rodá-lo de novo numa aba que já tem o painel só o traz de volta.
//
// Nada de innerHTML nem de atributo style: o Google Meet (e outras páginas do Google) exige
// Trusted Types e CSP de estilo restrita, e uma atribuição dessas faria o painel não aparecer.
(() => {
  const KEY = "__escutaDock";
  if (window[KEY]) {
    window[KEY].show();
    return;
  }

  const CSS = `
    :host { all: initial; }
    .panel {
      position: fixed; right: 12px; bottom: 12px; width: 340px; height: min(calc(100vh - 24px), 640px); max-width: calc(100vw - 24px);
      z-index: 2147483647; border-radius: 14px; overflow: hidden;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5), 0 0 0 1px #2a3354;
      background: #161d32;
    }
    .panel iframe { display: block; width: 100%; height: 100%; border: 0; color-scheme: normal; }
    /* A alça cobre o cabeçalho, menos os botões da direita (minimizar, abrir à parte, fechar). */
    .grip { position: absolute; top: 0; left: 0; z-index: 1; width: calc(100% - 136px); height: 56px; cursor: grab; touch-action: none; }
    .grip:active { cursor: grabbing; }
    .grip:focus-visible { outline: 2px solid #f6f4ef; outline-offset: -2px; border-radius: 14px 0 0 0; }
    .pill {
      position: fixed; right: 16px; bottom: 96px; z-index: 2147483647; width: 52px; height: 52px; box-sizing: border-box;
      display: none; align-items: center; justify-content: center; padding: 0; border-radius: 50%;
      background: #161d32; color: #ffc53d; border: 1px solid #2a3354; cursor: pointer; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
    }
    /* Gravando: em vez de um ponto vermelho, as barras de voz do próprio símbolo se mexem e o cursor pisca. */
    @keyframes blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
    @keyframes eq { 0%, 100% { transform: scaleY(0.5); } 50% { transform: scaleY(1.2); } }
    @keyframes breathe { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
    /* Onda lenta (2 s): cada barra um passo atrás da anterior, em intervalos iguais. */
    .pill .bar { transform-box: fill-box; transform-origin: center; animation: eq 2s ease-in-out infinite; }
    .pill path:nth-child(3) { animation-delay: -0.25s; }
    .pill path:nth-child(4) { animation-delay: -0.5s; }
    .pill path:nth-child(5) { animation-delay: -0.75s; }
    .pill .cur { animation: blink 1s steps(1) infinite; }
    @media (prefers-reduced-motion: reduce) { .pill .bar { animation: breathe 2.6s ease-in-out infinite; } }
    .pill:hover { filter: brightness(1.1); }
    .pill:focus-visible { outline: 3px solid #f6f4ef; outline-offset: 2px; }
    .pill svg { width: 30px; height: 30px; }
    .pill .bar { stroke: #0e1424; }
    .pill .cur { stroke: #3347ff; }
    @media (prefers-color-scheme: light) {
      .pill { background: #fff; color: #0e1424; border-color: #dad6cb; }
      .pill .bar { stroke: #fff; } .pill .cur { stroke: #ffc53d; }
    }
    .minimized .panel { display: none; }
    .minimized .pill { display: flex; }
    @media (prefers-reduced-motion: no-preference) { .panel { animation: in 160ms ease-out; } }
    @keyframes in { from { opacity: 0; transform: translateX(16px); } }
  `;

  const host = document.createElement("div");
  host.setAttribute("data-escuta", "dock");
  // Shadow root fechado: nem o CSS da reunião muda o painel, nem o painel muda a reunião.
  const root = host.attachShadow({ mode: "closed" });

  // Folha de estilo construída por código: não passa pela CSP de estilo da página, ao contrário de um <style>.
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    root.adoptedStyleSheets = [sheet];
  } catch {
    const style = document.createElement("style");
    style.textContent = CSS;
    root.append(style);
  }

  // Símbolo do Escuta: balão âmbar, barras de voz e o cursor azul.
  const SVG = "http://www.w3.org/2000/svg";
  const icon = document.createElementNS(SVG, "svg");
  icon.setAttribute("viewBox", "0 0 64 64");
  icon.setAttribute("aria-hidden", "true");
  const shape = (tag, attrs) => {
    const el = document.createElementNS(SVG, tag);
    for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
    return el;
  };
  icon.append(shape("path", { d: "M20 4H44A16 16 0 0 1 60 20V36A16 16 0 0 1 44 52H30C22 52 14 57 6 60C5 54 4 48 4 40V20A16 16 0 0 1 20 4Z", fill: "currentColor", stroke: "currentColor", "stroke-width": 2, "stroke-linejoin": "round" }));
  for (const d of ["M14.5 24V32", "M23 19V37", "M31.5 15V41", "M40 21V35"]) icon.append(shape("path", { d, class: "bar", fill: "none", "stroke-width": 5, "stroke-linecap": "round" }));
  icon.append(shape("path", { d: "M49 20V36", class: "cur", fill: "none", "stroke-width": 5, "stroke-linecap": "round" }));

  const wrap = document.createElement("div");
  wrap.className = "wrap";
  const panel = document.createElement("div");
  panel.className = "panel";
  const pill = document.createElement("button");
  pill.className = "pill";
  pill.type = "button";
  pill.title = "Abrir a transcrição ao vivo";
  pill.setAttribute("aria-label", "Abrir a transcrição ao vivo");
  pill.append(icon);

  const frame = document.createElement("iframe");
  frame.title = "Escuta · transcrição ao vivo";
  frame.allow = "clipboard-write"; // o botão Copiar, de dentro da moldura
  frame.src = chrome.runtime.getURL("live.html?dock=1");
  // Arrastar pelo cabeçalho: o painel às vezes tampa o que a pessoa precisa ver na reunião. A alça fica na
  // casca, e não dentro da moldura, porque só assim o arrasto continua quando o ponteiro passa por cima dela.
  const grip = document.createElement("div");
  grip.className = "grip";
  grip.tabIndex = 0;
  grip.title = "Arraste para mover. Duplo clique volta ao canto.";
  grip.setAttribute("role", "button");
  grip.setAttribute("aria-label", "Mover o painel: setas movem, Enter volta ao canto");
  panel.append(frame, grip);
  wrap.append(panel, pill);
  root.append(wrap);

  const POS_KEY = "dockPos"; // { x, y }: o canto do painel como fração da janela, para valer em qualquer tamanho
  const keep = (promise) => promise?.catch?.(() => {});

  function place(x, y) {
    const left = Math.min(Math.max(0, x), Math.max(0, innerWidth - panel.offsetWidth));
    const top = Math.min(Math.max(0, y), Math.max(0, innerHeight - panel.offsetHeight));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  }

  const moved = () => panel.style.left !== "";

  function save() {
    const r = panel.getBoundingClientRect();
    keep(chrome.storage.local.set({ [POS_KEY]: { x: r.left / innerWidth, y: r.top / innerHeight } }));
  }

  function home() {
    for (const side of ["left", "top", "right", "bottom"]) panel.style.removeProperty(side);
    keep(chrome.storage.local.remove(POS_KEY));
  }

  let drag = null;
  grip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const r = panel.getBoundingClientRect();
    drag = { dx: event.clientX - r.left, dy: event.clientY - r.top };
    grip.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  grip.addEventListener("pointermove", (event) => {
    if (drag) place(event.clientX - drag.dx, event.clientY - drag.dy);
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    save();
  };
  grip.addEventListener("pointerup", endDrag);
  grip.addEventListener("pointercancel", endDrag);
  grip.addEventListener("dblclick", home);
  grip.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 80 : 20;
    const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (event.key === "Enter") home();
    else if (move) {
      const r = panel.getBoundingClientRect();
      place(r.left + move[0], r.top + move[1]);
      save();
    } else return;
    event.preventDefault();
  });
  // Janela menor que antes: o painel não pode ficar para fora.
  window.addEventListener("resize", () => {
    if (!moved()) return;
    const r = panel.getBoundingClientRect();
    place(r.left, r.top);
  });

  const api = {
    show() {
      wrap.classList.remove("minimized");
      // Só reanexa se a página tiver removido o painel: mover um iframe no DOM recarrega o que há dentro.
      if (!host.isConnected) document.documentElement.append(host);
    },
    minimize() {
      wrap.classList.add("minimized");
    },
    close() {
      window.removeEventListener("message", onMessage);
      host.remove();
      delete window[KEY];
    },
  };

  // A moldura (live.js) pede por postMessage; só vale o que vem dela mesma.
  function onMessage(event) {
    if (event.source !== frame.contentWindow || event.data?.escuta !== "dock") return;
    if (event.data.action === "minimize") api.minimize();
    else if (event.data.action === "close") api.close();
  }
  window.addEventListener("message", onMessage);
  pill.addEventListener("click", api.show);

  window[KEY] = api;
  api.show();
  // A posição da última vez, se a pessoa tinha movido o painel.
  try {
    keep(
      chrome.storage.local.get(POS_KEY).then((saved) => {
        const pos = saved?.[POS_KEY];
        if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) place(pos.x * innerWidth, pos.y * innerHeight);
      }),
    );
  } catch {
    // sem armazenamento, o painel abre no canto de sempre
  }
})();
