// Filtros + sort + buscador tipo Excel/Sheets, compartidos entre master y
// vendor. El caller pasa su propio `state` (un objeto plano mutable) para que
// los filtros persistan entre re-renders. Cols son la lista de columnas
// filtrables con metadata { key, label, type, value(client, ctx) }.

import { clear, fmtMoney } from "./ui.js";

// Crea un objeto de estado fresco. Los callers lo guardan en module scope
// para que sobreviva entre renders.
export function createFilterState() {
  return {
    search: "",
    sort: { col: null, dir: 1 },
    columnFilters: {}, // key -> Set de valores permitidos
  };
}

export function buildSearchBar(state, onChange, placeholder = "Buscar cliente por nombre…") {
  const bar = document.createElement("div");
  bar.className = "filter-bar";

  const wrap = document.createElement("div");
  wrap.className = "search-input";
  const icon = document.createElement("span");
  icon.className = "search-icon";
  icon.textContent = "🔍";
  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = placeholder;
  input.value = state.search;
  input.oninput = () => { state.search = input.value; onChange(); };
  wrap.append(icon, input);
  bar.appendChild(wrap);
  return bar;
}

// Header con label + botón ▾ que abre el popover de filtro/sort.
export function buildFilterableHeader(col, clients, ctx, state, onChange) {
  const wrap = document.createElement("div");
  wrap.className = "th-filterable";

  const lbl = document.createElement("span");
  lbl.className = "th-label";
  lbl.textContent = col.label;
  wrap.appendChild(lbl);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "th-filter-btn";
  btn.title = "Filtrar";
  btn.textContent = "▾";
  btn.onclick = (ev) => {
    ev.stopPropagation();
    openColumnFilterPopover(btn, col, clients, ctx, state, () => {
      paintActive();
      onChange();
    });
  };
  wrap.appendChild(btn);

  function paintActive() {
    btn.classList.toggle("active", state.columnFilters[col.key] != null);
  }
  paintActive();
  return wrap;
}

function openColumnFilterPopover(anchor, col, clients, ctx, state, onChange) {
  document.querySelectorAll(".filter-popover").forEach((p) => p.remove());

  const isNumeric = col.type === "number";
  const values = [...new Set(clients.map((c) => col.value(c, ctx)))]
    .sort((a, b) => isNumeric
      ? (Number(a) || 0) - (Number(b) || 0)
      : String(a).localeCompare(String(b)));

  const current = state.columnFilters[col.key];
  const selected = new Set(current || values);

  const pop = document.createElement("div");
  pop.className = "filter-popover";

  // Sort buttons
  const sortHead = document.createElement("div");
  sortHead.className = "popover-sort";
  const sortAsc = document.createElement("button");
  sortAsc.type = "button";
  sortAsc.className = "popover-link";
  sortAsc.innerHTML = isNumeric
    ? `<span class="popover-link-icon">↑</span> Ordenar de menor a mayor`
    : `<span class="popover-link-icon">↑</span> Ordenar A → Z`;
  sortAsc.onclick = () => {
    state.sort.col = col.key; state.sort.dir = 1;
    pop.remove(); onChange();
  };
  const sortDesc = document.createElement("button");
  sortDesc.type = "button";
  sortDesc.className = "popover-link";
  sortDesc.innerHTML = isNumeric
    ? `<span class="popover-link-icon">↓</span> Ordenar de mayor a menor`
    : `<span class="popover-link-icon">↓</span> Ordenar Z → A`;
  sortDesc.onclick = () => {
    state.sort.col = col.key; state.sort.dir = -1;
    pop.remove(); onChange();
  };
  sortHead.append(sortAsc, sortDesc);
  pop.appendChild(sortHead);

  // Toolbar
  const toolbar = document.createElement("div");
  toolbar.className = "popover-toolbar";
  const selAll = document.createElement("a");
  selAll.href = "#"; selAll.className = "popover-link-text"; selAll.textContent = "Seleccionar todo";
  selAll.onclick = (ev) => { ev.preventDefault(); for (const v of values) selected.add(v); renderList(); };
  const dot = document.createElement("span"); dot.className = "muted"; dot.textContent = " · ";
  const clearAll = document.createElement("a");
  clearAll.href = "#"; clearAll.className = "popover-link-text"; clearAll.textContent = "Borrar";
  clearAll.onclick = (ev) => { ev.preventDefault(); selected.clear(); renderList(); };
  const count = document.createElement("span");
  count.className = "popover-count muted";
  toolbar.append(selAll, dot, clearAll, count);
  pop.appendChild(toolbar);

  // Search
  const searchWrap = document.createElement("div");
  searchWrap.className = "popover-search-wrap";
  const searchIcon = document.createElement("span");
  searchIcon.className = "popover-search-icon";
  searchIcon.textContent = "🔍";
  const search = document.createElement("input");
  search.type = "search"; search.className = "popover-search";
  search.placeholder = "Buscar valor…";
  searchWrap.append(searchIcon, search);
  pop.appendChild(searchWrap);

  // Lista
  const list = document.createElement("div");
  list.className = "popover-list";
  pop.appendChild(list);

  function displayVal(v) {
    if (isNumeric) return v ? fmtMoney(v) : "—";
    if (v === "" || v == null) return "—";
    return String(v);
  }

  function renderList() {
    clear(list);
    const q = search.value.trim().toLowerCase();
    const visible = q ? values.filter((v) => {
      const raw = String(v).toLowerCase();
      const disp = displayVal(v).toLowerCase();
      return raw.includes(q) || disp.includes(q);
    }) : values;
    for (const val of visible) {
      const row = document.createElement("label");
      row.className = "popover-row";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = selected.has(val);
      cb.onchange = () => {
        if (cb.checked) selected.add(val); else selected.delete(val);
        renderList();
      };
      const txt = document.createElement("span");
      txt.textContent = displayVal(val);
      row.append(cb, txt);
      list.appendChild(row);
    }
    if (!visible.length) {
      const empty = document.createElement("div");
      empty.className = "popover-empty muted";
      empty.textContent = "Sin coincidencias";
      list.appendChild(empty);
    }
    count.textContent = `Mostrando ${visible.length}`;
  }
  renderList();
  search.oninput = renderList;

  // Footer
  const footer = document.createElement("div");
  footer.className = "popover-footer";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button"; cancelBtn.className = "ghost"; cancelBtn.textContent = "Cancelar";
  cancelBtn.onclick = () => { pop.remove(); };
  const applyBtn = document.createElement("button");
  applyBtn.type = "button"; applyBtn.textContent = "Aceptar";
  applyBtn.onclick = () => {
    if (selected.size === values.length) delete state.columnFilters[col.key];
    else state.columnFilters[col.key] = selected;
    pop.remove();
    onChange();
  };
  footer.append(cancelBtn, applyBtn);
  pop.appendChild(footer);

  // Posicionar
  document.body.appendChild(pop);
  const rect = anchor.getBoundingClientRect();
  pop.style.position = "absolute";
  pop.style.top  = `${rect.bottom + window.scrollY + 4}px`;
  pop.style.left = `${rect.left + window.scrollX}px`;

  // Cerrar al click fuera
  function onDocClick(ev) {
    if (!pop.contains(ev.target) && ev.target !== anchor) {
      pop.remove();
      document.removeEventListener("mousedown", onDocClick);
    }
  }
  setTimeout(() => document.addEventListener("mousedown", onDocClick), 0);

  search.focus();
}

// Aplica search + filtros de columna. cols = lista de columnas filtrables.
export function applyFilters(clients, ctx, cols, state, searchField = "name") {
  const q = state.search.trim().toLowerCase();
  return clients.filter((c) => {
    if (q && !String(c[searchField] || "").toLowerCase().includes(q)) return false;
    for (const col of cols) {
      const allowed = state.columnFilters[col.key];
      if (!allowed) continue;
      const v = col.value(c, ctx);
      if (!allowed.has(v)) return false;
    }
    return true;
  });
}

export function applySort(clients, ctx, cols, state) {
  if (!state.sort.col) return clients;
  const col = cols.find((c) => c.key === state.sort.col);
  if (!col) return clients;
  const dir = state.sort.dir;
  return [...clients].sort((a, b) => {
    const av = col.value(a, ctx);
    const bv = col.value(b, ctx);
    if (col.type === "number") return ((Number(av) || 0) - (Number(bv) || 0)) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
}

// Pinta las flechas ▲/▼ en el header activo.
export function paintSortIndicators(thead, cols, state) {
  for (const col of cols) {
    const th = thead.querySelector(`th[data-col="${col.key}"]`);
    if (!th) continue;
    const labelSpan = th.querySelector(".th-label");
    const arrow = state.sort.col === col.key ? (state.sort.dir === 1 ? " ▲" : " ▼") : "";
    if (labelSpan) labelSpan.textContent = col.label + arrow;
  }
}
