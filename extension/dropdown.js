// Menu suspenso próprio, no lugar da lista nativa do <select> (que abre a lista do sistema e foge da identidade).
// O <select> continua sendo a fonte da verdade: valor, eventos "change" e leitura por .value seguem iguais.
// Atribuir select.value por código também atualiza o botão.
function dropdown(select, compact = false) {
  const NS = "http://www.w3.org/2000/svg";
  const make = (tag, cls, text) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text != null ? { textContent: text } : {});
  const wrap = make("div", `dd${compact ? " dd--compact" : ""}`);
  const trigger = make("button", "dd-trigger");
  trigger.type = "button";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  const text = make("span", "dd-text");
  const chevron = document.createElementNS(NS, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: 14, height: 14, fill: "none", stroke: "currentColor", "stroke-width": 1.9, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: "dd-chev" })) chevron.setAttribute(k, v);
  const chevronPath = document.createElementNS(NS, "path");
  chevronPath.setAttribute("d", "M6 9l6 6 6-6");
  chevron.append(chevronPath);
  trigger.append(text, chevron);
  const menu = make("ul", "dd-menu");
  menu.setAttribute("role", "listbox");
  menu.hidden = true;
  const label = select.getAttribute("aria-label") || select.closest("label")?.querySelector("span")?.firstChild?.textContent?.trim() || "";
  if (label) {
    trigger.setAttribute("aria-label", label);
    menu.setAttribute("aria-label", label);
  }

  let active = -1;
  const items = () => [...menu.children];
  const sync = () => {
    text.textContent = select.selectedOptions[0]?.textContent || "";
    menu.replaceChildren(
      ...[...select.options].map((o, i) => {
        const li = make("li", "dd-item", o.textContent);
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", String(o.selected));
        li.addEventListener("mousedown", (e) => e.preventDefault()); // não tira o foco do botão
        li.addEventListener("click", () => choose(i));
        return li;
      }),
    );
  };
  const mark = (i) => {
    active = i;
    items().forEach((li, k) => li.classList.toggle("is-active", k === i));
    items()[i]?.scrollIntoView({ block: "nearest" });
  };
  const open = () => {
    if (!menu.hidden) return;
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    mark(Math.max(0, select.selectedIndex));
  };
  const close = () => {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  };
  const choose = (i) => {
    close();
    trigger.focus();
    if (select.selectedIndex !== i) {
      select.selectedIndex = i;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    sync();
  };
  trigger.addEventListener("click", () => (menu.hidden ? open() : close()));
  trigger.addEventListener("blur", close);
  trigger.addEventListener("keydown", (e) => {
    const n = select.options.length;
    if (e.key === "Escape" && !menu.hidden) {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (menu.hidden) return open();
      mark((active + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
    } else if ((e.key === "Home" || e.key === "End") && !menu.hidden) {
      e.preventDefault();
      mark(e.key === "Home" ? 0 : n - 1);
    } else if ((e.key === "Enter" || e.key === " ") && !menu.hidden) {
      e.preventDefault();
      choose(active);
    }
  });

  select.classList.add("dd-native");
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");
  select.after(wrap);
  wrap.append(trigger, menu);
  new MutationObserver(sync).observe(select, { childList: true });
  const valueProp = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
  Object.defineProperty(select, "value", {
    get() {
      return valueProp.get.call(this);
    },
    set(v) {
      valueProp.set.call(this, v);
      sync();
    },
  });
  select.sync = sync;
  sync();
  return wrap;
}
