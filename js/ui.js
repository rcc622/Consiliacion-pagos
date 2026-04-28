// Helpers de UI: vistas, toasts, modales.

const VIEWS = ["loading", "login", "vendor", "master"];

export function showView(name) {
  for (const v of VIEWS) {
    const el = document.getElementById(`view-${v}`);
    if (el) el.hidden = v !== name;
  }
  const topbar = document.getElementById("topbar");
  if (topbar) topbar.hidden = name === "login" || name === "loading";
}

export function setUserLabel(text) {
  const el = document.getElementById("user-label");
  if (el) el.textContent = text || "";
}

export function toast(message, kind = "info", ms = 3500) {
  const stack = document.getElementById("toast-stack");
  if (!stack) return;
  const node = document.createElement("div");
  node.className = `toast ${kind}`;
  node.textContent = message;
  stack.appendChild(node);
  setTimeout(() => node.remove(), ms);
}

// Modal genérico. fields: [{name, label, type, required, value}]
// Devuelve Promise<Object|null>.
export function openModal({ title, fields = [], submitLabel = "Guardar" }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";

    const modal = document.createElement("div");
    modal.className = "modal";

    const h = document.createElement("h2");
    h.textContent = title;
    modal.appendChild(h);

    const form = document.createElement("form");
    for (const f of fields) {
      const lbl = document.createElement("label");
      lbl.textContent = f.label;
      const input = document.createElement(f.type === "select" ? "select" : "input");
      input.name = f.name;
      if (f.type === "select") {
        for (const opt of f.options || []) {
          const o = document.createElement("option");
          o.value = opt.value;
          o.textContent = opt.label;
          input.appendChild(o);
        }
      } else {
        input.type = f.type || "text";
      }
      if (f.required) input.required = true;
      if (f.value != null) input.value = f.value;
      lbl.appendChild(input);
      form.appendChild(lbl);
    }

    const actions = document.createElement("div");
    actions.className = "actions";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "ghost";
    cancel.textContent = "Cancelar";
    cancel.onclick = () => { backdrop.remove(); resolve(null); };

    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = submitLabel;

    actions.append(cancel, submit);
    form.appendChild(actions);
    modal.appendChild(form);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    form.onsubmit = (ev) => {
      ev.preventDefault();
      const data = {};
      for (const f of fields) data[f.name] = form.elements[f.name].value;
      backdrop.remove();
      resolve(data);
    };

    backdrop.addEventListener("click", (ev) => {
      if (ev.target === backdrop) { backdrop.remove(); resolve(null); }
    });
  });
}

// Crea una tabla a partir de columnas y filas. columns: [{key, label, render?}]
export function buildTable(columns, rows) {
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  for (const c of columns) {
    const th = document.createElement("th");
    th.textContent = c.label;
    trh.appendChild(th);
  }
  thead.appendChild(trh);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const c of columns) {
      const td = document.createElement("td");
      const value = c.render ? c.render(row) : row[c.key];
      if (value instanceof Node) td.appendChild(value);
      else td.textContent = value ?? "";
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

export function fmtMoney(n) {
  if (n == null || n === "") return "—";
  const num = Number(n);
  if (Number.isNaN(num)) return "—";
  return num.toLocaleString("es-MX", { style: "currency", currency: "MXN" });
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}
