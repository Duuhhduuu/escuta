// Tema claro/escuro: segue o do sistema até a pessoa escolher no botão; a escolha vale para o popup e para o histórico.
(() => {
  const KEY = "escutaTheme";
  const root = document.documentElement;
  const read = () => {
    try {
      const v = localStorage.getItem(KEY);
      return v === "light" || v === "dark" ? v : "";
    } catch {
      return "";
    }
  };
  const apply = (v) => (v ? (root.dataset.theme = v) : delete root.dataset.theme);
  apply(read()); // já no <head>, antes de a página aparecer: sem piscar o tema errado

  const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;
  const current = () => read() || (systemDark() ? "dark" : "light");

  const NS = "http://www.w3.org/2000/svg";
  const icon = (paths) => {
    const svg = document.createElementNS(NS, "svg");
    for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: 16, height: 16, fill: "none", stroke: "currentColor", "stroke-width": 1.9, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
    for (const d of paths) {
      const path = document.createElementNS(NS, "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    return svg;
  };
  const SUN = ["M16.5 12a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0", "M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"];
  const MOON = ["M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"];

  window.addEventListener("DOMContentLoaded", () => {
    const host = document.querySelector(".brand") || document.querySelector("header");
    if (!host) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "theme-toggle";
    const paint = () => {
      const dark = current() === "dark";
      button.replaceChildren(icon(dark ? SUN : MOON)); // mostra para onde vai: sol no escuro, lua no claro
      const label = dark ? "Mudar para o tema claro" : "Mudar para o tema escuro";
      button.setAttribute("aria-label", label);
      button.title = label;
    };
    button.addEventListener("click", () => {
      const next = current() === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(KEY, next);
      } catch {}
      apply(next);
      paint();
    });
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", paint);
    paint();
    host.append(button);
  });
})();
