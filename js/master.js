// Vista master: dashboard de progreso por vendedor / zona + import + alta manual.

import { sb } from "./supabase.js";
import { clear, toast, openModal, confirmDialog, fmtMoney } from "./ui.js";
import { parseFile, importRows } from "./import.js";
import { exportConciliation } from "./export.js";

const ZONES = [
  "Monterrey","Saltillo","Chihuahua","MTY Foraneo","FORANEO","COMERCIAL MTY",
];
// Catálogo normalizado:
// - MSI colapsa todos los "X Meses Sin Intereses" / "X MSI".
// - Mejoravit colapsa "Contado * Mejoravit", "mejoravit y contado", etc.
// - Mejoravit-MSI colapsa "Anticipo Mejoravit-MSI", "Anticipo Mejoravit 24 MSI", "mejoravit y msi".
const METHODS = [
  "Contado Riguroso-Direc",
  "Contado Parcial-Direc",
  "MSI",
  "Mejoravit",
  "Mejoravit-MSI",
  "FIDE",
  "FIDE-DIRECTO",
  "Financiamiento",
];

// Construye opciones para un select de un catalogo cerrado, agregando el
// valor actual si quedo fuera del catalogo (para no romper datos legacy).
function catalogOptions(catalog, currentValue) {
  const opts = [{ value: "", label: "—" }, ...catalog.map((v) => ({ value: v, label: v }))];
  if (currentValue && !catalog.includes(currentValue)) {
    opts.push({ value: currentValue, label: currentValue });
  }
  return opts;
}

let selected = new Set();
let clientSearch = "";
// Per-column allowlists. null/undefined = sin filtro (todos pasan).
// Set vacío = nada pasa. Set con valores = solo esos.
let columnFilters = {};
let clientSort = { col: null, dir: 1 };
let vendorSort = { col: null, dir: 1 };

// Columnas de la tabla "Clientes": metadata para sort + filter.
// `type` controla la dirección inicial al hacer click (numérico = desc).
// `filterable` decide si el header lleva botón ▾.
const CLIENT_COLS = [
  { key: "name",       label: "Cliente",        type: "string", filterable: false, value: (c) => c.name || "" },
  { key: "vendor",     label: "Vendedor",       type: "string", filterable: true,  value: (c, ctx) => ctx.vendorLabel(c) },
  { key: "method",     label: "Método de pago", type: "string", filterable: true,  value: (c) => c.payment_method || "—" },
  { key: "amount",     label: "Monto",          type: "number", filterable: false, value: (c) => Number(c.amount || 0) },
  { key: "conciliado", label: "Conciliado",     type: "number", filterable: false, value: (c, ctx) => Number(ctx.reportFor(c)?.total_amount || 0) },
  { key: "status",     label: "Estado",         type: "string", filterable: true,  value: (c, ctx) => ctx.statusLabel(c) },
  { key: "active",     label: "Activo",         type: "string", filterable: true,  value: (c) => c.is_active ? "Activo" : "—" },
  { key: "notes",      label: "Notas",          type: "string", filterable: false, value: (c) => c.notes || "" },
];

const FILTERABLE_COLS = CLIENT_COLS.filter((c) => c.filterable);

export async function renderMaster() {
  selected = new Set();
  clientSearch = "";
  columnFilters = {};
  clientSort = { col: null, dir: 1 };
  vendorSort = { col: null, dir: 1 };
  const root = document.getElementById("view-master");
  clear(root);

  const h = document.createElement("h1");
  h.textContent = "Dashboard maestro";
  root.appendChild(h);

  root.appendChild(buildToolbar(() => renderMaster()));

  const summary = document.createElement("div");
  summary.className = "summary";
  root.appendChild(summary);

  const byVendorTitle = document.createElement("h2");
  byVendorTitle.textContent = "Por vendedor";
  root.appendChild(byVendorTitle);
  const byVendorWrap = document.createElement("div");
  byVendorWrap.className = "table-wrap";
  root.appendChild(byVendorWrap);

  const byZoneTitle = document.createElement("h2");
  byZoneTitle.textContent = "Por zona";
  root.appendChild(byZoneTitle);
  const byZoneWrap = document.createElement("div");
  byZoneWrap.className = "table-wrap";
  root.appendChild(byZoneWrap);

  const detailTitle = document.createElement("h2");
  detailTitle.textContent = "Clientes";
  root.appendChild(detailTitle);
  const detailWrap = document.createElement("div");
  detailWrap.className = "table-wrap";
  root.appendChild(detailWrap);

  const { vendors, clients, reports } = await loadAll();
  paintTopSummary(summary, clients, reports);
  paintByVendor(byVendorWrap, vendors, clients, reports);
  paintByZone(byZoneWrap, clients, reports);
  paintDetail(detailWrap, vendors, clients, reports, () => renderMaster());
}

function buildToolbar(refresh) {
  const bar = document.createElement("div");
  bar.className = "toolbar";

  const importBtn = document.createElement("button");
  importBtn.textContent = "Importar lista";
  importBtn.onclick = () => triggerImport(refresh);

  const addBtn = document.createElement("button");
  addBtn.className = "ghost";
  addBtn.textContent = "Agregar cliente";
  addBtn.onclick = () => addClientFlow(refresh);

  const exportXlsxBtn = document.createElement("button");
  exportXlsxBtn.className = "ghost";
  exportXlsxBtn.textContent = "Exportar Excel";
  exportXlsxBtn.onclick = () => exportConciliation("xlsx");

  const exportCsvBtn = document.createElement("button");
  exportCsvBtn.className = "ghost";
  exportCsvBtn.textContent = "Exportar CSV";
  exportCsvBtn.onclick = () => exportConciliation("csv");

  const spacer = document.createElement("div");
  spacer.className = "spacer";

  const wipeBtn = document.createElement("button");
  wipeBtn.className = "danger";
  wipeBtn.textContent = "Vaciar lista";
  wipeBtn.onclick = () => bulkDeleteFlow(refresh);

  bar.append(importBtn, addBtn, exportXlsxBtn, exportCsvBtn, spacer, wipeBtn);
  return bar;
}

async function loadAll() {
  const [vendorsRes, clientsRes, reportsRes] = await Promise.all([
    sb.from("profiles").select("id, email, full_name, zone, role").eq("role", "vendor"),
    sb.from("clients").select("id, name, zone, vendor_id, payment_month, payment_method, amount, enganche, anticipo, notes, due_date, reference, is_active"),
    sb.from("payments_report").select("client_id, vendor_id, months_paid, total_amount, updated_at"),
  ]);

  for (const r of [vendorsRes, clientsRes, reportsRes]) {
    if (r.error) { toast(r.error.message, "error"); throw r.error; }
  }

  return {
    vendors: vendorsRes.data || [],
    clients: clientsRes.data || [],
    reports: reportsRes.data || [],
  };
}

function paintTopSummary(container, clients, reports) {
  const total = clients.length;
  // "Reportados" debe coincidir con el badge de la tabla: solo cuenta
  // clientes con conciliado > 0. Sin esto, una fila residual en
  // payments_report (de pruebas viejas) infla el conteo.
  const conciliadoByClient = new Map(reports.map((r) => [r.client_id, Number(r.total_amount || 0)]));
  const reported = clients.filter((c) => (conciliadoByClient.get(c.id) || 0) > 0).length;
  const pct = total ? Math.round((reported / total) * 100) : 0;
  const totalAmount = reports.reduce((s, r) => s + Number(r.total_amount || 0), 0);

  clear(container);
  container.append(
    stat("Clientes totales", total),
    stat("Reportados", `${reported} / ${total}`),
    stat("% conciliado", `${pct}%`),
    stat("Monto total", fmtMoney(totalAmount)),
  );
}

function stat(label, value) {
  const el = document.createElement("div"); el.className = "stat";
  const l = document.createElement("div"); l.className = "label"; l.textContent = label;
  const v = document.createElement("div"); v.className = "value"; v.textContent = value;
  el.append(l, v);
  return el;
}

function paintByVendor(container, vendors, clients, reports) {
  clear(container);
  const reportedIds = new Set(reports.filter((r) => Number(r.total_amount) > 0).map((r) => r.client_id));
  const amountByVendor = new Map();
  for (const r of reports) {
    amountByVendor.set(r.vendor_id, (amountByVendor.get(r.vendor_id) || 0) + Number(r.total_amount || 0));
  }

  const rows = vendors.map((v) => {
    const own = clients.filter((c) => c.vendor_id === v.id);
    const ownReported = own.filter((c) => reportedIds.has(c.id)).length;
    const pct = own.length ? Math.round((ownReported / own.length) * 100) : 0;
    return {
      name: v.full_name || v.email,
      zone: v.zone || "—",
      assigned: own.length,
      reported: ownReported,
      pct,
      amount: amountByVendor.get(v.id) || 0,
    };
  });

  const cols = [
    { key: "name",     label: "Vendedor",   type: "string" },
    { key: "zone",     label: "Zona",       type: "string" },
    { key: "assigned", label: "Asignados",  type: "number" },
    { key: "reported", label: "Reportados", type: "number" },
    { key: "pct",      label: "%",          type: "number" },
    { key: "amount",   label: "Monto",      type: "number" },
  ];

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  for (const c of cols) {
    const th = document.createElement("th");
    th.className = "sortable";
    th.dataset.col = c.key;
    th.dataset.label = c.label;
    th.onclick = () => {
      if (vendorSort.col === c.key) vendorSort.dir = -vendorSort.dir;
      else { vendorSort.col = c.key; vendorSort.dir = c.type === "string" ? 1 : -1; }
      paintHeader();
      paintBody();
    };
    trh.appendChild(th);
  }
  thead.appendChild(trh);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  table.appendChild(tbody);
  container.appendChild(table);

  function paintHeader() {
    for (const th of thead.querySelectorAll("th[data-col]")) {
      const k = th.dataset.col;
      const arrow = vendorSort.col === k ? (vendorSort.dir === 1 ? " ▲" : " ▼") : "";
      th.textContent = th.dataset.label + arrow;
    }
  }

  function sortedRows() {
    if (!vendorSort.col) return rows;
    const col = cols.find((c) => c.key === vendorSort.col);
    const dir = vendorSort.dir;
    return [...rows].sort((a, b) => {
      const av = a[col.key]; const bv = b[col.key];
      if (col.type === "string") return String(av).localeCompare(String(bv)) * dir;
      return ((Number(av) || 0) - (Number(bv) || 0)) * dir;
    });
  }

  function paintBody() {
    clear(tbody);
    for (const r of sortedRows()) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(r.name)}</td>
        <td>${escapeHtml(r.zone)}</td>
        <td>${r.assigned}</td>
        <td>${r.reported}</td>
        <td>${r.pct}%</td>
        <td>${fmtMoney(r.amount)}</td>`;
      tbody.appendChild(tr);
    }
  }

  paintHeader();
  paintBody();
}

function paintByZone(container, clients, reports) {
  clear(container);
  const reportedIds = new Set(reports.filter((r) => Number(r.total_amount) > 0).map((r) => r.client_id));
  const amountByClient = new Map(reports.map((r) => [r.client_id, Number(r.total_amount || 0)]));

  const groups = new Map();
  for (const c of clients) {
    const key = c.zone || "Sin zona";
    if (!groups.has(key)) groups.set(key, { assigned: 0, reported: 0, amount: 0 });
    const g = groups.get(key);
    g.assigned += 1;
    if (reportedIds.has(c.id)) g.reported += 1;
    g.amount += amountByClient.get(c.id) || 0;
  }

  const table = document.createElement("table");
  table.innerHTML = `
    <thead><tr>
      <th>Zona</th><th>Asignados</th><th>Reportados</th><th>%</th><th>Monto</th>
    </tr></thead>`;
  const tbody = document.createElement("tbody");
  for (const [zone, g] of [...groups.entries()].sort()) {
    const pct = g.assigned ? Math.round((g.reported / g.assigned) * 100) : 0;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(zone)}</td>
      <td>${g.assigned}</td>
      <td>${g.reported}</td>
      <td>${pct}%</td>
      <td>${fmtMoney(g.amount)}</td>`;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

function paintDetail(container, vendors, clients, reports, refresh) {
  clear(container);
  const vendorById = new Map(vendors.map((v) => [v.id, v]));
  const reportByClient = new Map(reports.map((r) => [r.client_id, r]));

  // Contexto compartido: lo usan los extractores de CLIENT_COLS.
  const filterCtx = {
    vendorLabel: (c) => {
      const v = vendorById.get(c.vendor_id);
      return v ? (v.full_name || v.email) : "—";
    },
    statusLabel: (c) => {
      const r = reportByClient.get(c.id);
      const conciliado = Number(r?.total_amount || 0);
      return clientStatus(c, conciliado).label;
    },
    reportFor: (c) => reportByClient.get(c.id),
  };

  // Barra superior: solo el buscador libre. Los filtros por valor viven
  // en cada header como popover.
  const filterBar = buildClientSearchBar(() => repaintBody());
  container.appendChild(filterBar);

  // Barra de seleccion (solo se muestra cuando hay >=1 marcado)
  const selBar = document.createElement("div");
  selBar.className = "selection-bar";
  selBar.hidden = true;
  container.appendChild(selBar);

  const tableEl = document.createElement("table");
  tableEl.className = "filterable";
  const thead = document.createElement("thead");
  const trh = document.createElement("tr");

  // Checkbox col
  const thCheck = document.createElement("th");
  thCheck.className = "check-col";
  thCheck.innerHTML = `<input type="checkbox" data-role="select-all" />`;
  trh.appendChild(thCheck);

  // Cada columna sortable / filtrable
  for (const col of CLIENT_COLS) {
    const th = document.createElement("th");
    th.dataset.col = col.key;

    if (col.filterable) {
      th.appendChild(buildFilterableHeader(col, clients, filterCtx, () => repaintBody()));
    } else {
      const labelSpan = document.createElement("span");
      labelSpan.className = "th-label sortable-only";
      labelSpan.textContent = col.label;
      th.appendChild(labelSpan);
    }

    th.classList.add("sortable");
    th.addEventListener("click", (ev) => {
      // No disparar sort si el click vino del botón ▾ del filtro.
      if (ev.target.closest(".th-filter-btn")) return;
      onClickSort(col);
    });
    trh.appendChild(th);
  }

  // Acciones col (sin sort)
  const thActions = document.createElement("th");
  trh.appendChild(thActions);

  thead.appendChild(trh);
  tableEl.appendChild(thead);
  const tbody = document.createElement("tbody");
  tableEl.appendChild(tbody);
  container.appendChild(tableEl);

  function onClickSort(col) {
    if (clientSort.col === col.key) {
      clientSort.dir = -clientSort.dir;
    } else {
      clientSort.col = col.key;
      clientSort.dir = col.type === "number" ? -1 : 1;
    }
    paintSortIndicators();
    repaintBody();
  }

  function paintSortIndicators() {
    for (const col of CLIENT_COLS) {
      const th = thead.querySelector(`th[data-col="${col.key}"]`);
      if (!th) continue;
      const labelSpan = th.querySelector(".th-label");
      const arrow = clientSort.col === col.key ? (clientSort.dir === 1 ? " ▲" : " ▼") : "";
      if (labelSpan) labelSpan.textContent = col.label + arrow;
    }
  }
  paintSortIndicators();

  let rowChecks = [];

  function repaintSelBar() {
    clear(selBar);
    if (selected.size === 0) { selBar.hidden = true; return; }
    selBar.hidden = false;

    const label = document.createElement("span");
    label.className = "muted";
    label.textContent = `${selected.size} seleccionado${selected.size === 1 ? "" : "s"}`;

    const reassignBtn = document.createElement("button");
    reassignBtn.textContent = "Reasignar vendedor";
    reassignBtn.onclick = () => reassignFlow([...selected], vendors, refresh);

    const editBtn = document.createElement("button");
    editBtn.className = "ghost";
    editBtn.textContent = "Editar selección";
    editBtn.onclick = () => bulkEditSelectedFlow([...selected], vendors, refresh);

    const delBtn = document.createElement("button");
    delBtn.className = "danger";
    delBtn.textContent = "Eliminar selección";
    delBtn.onclick = () => bulkDeleteSelectedFlow([...selected], refresh);

    selBar.append(label, reassignBtn, editBtn, delBtn);
  }

  function repaintBody() {
    const filtered = applyClientFilters(clients, filterCtx);
    const sorted = applyClientSort(filtered, filterCtx);
    clear(tbody);
    rowChecks = [];

    for (const c of sorted) {
      const v = vendorById.get(c.vendor_id);
      const r = reportByClient.get(c.id);
      const tr = document.createElement("tr");

      // Celda checkbox
      const tdCheck = document.createElement("td");
      tdCheck.className = "check-col";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = selected.has(c.id);
      cb.onchange = () => {
        if (cb.checked) selected.add(c.id);
        else selected.delete(c.id);
        repaintSelBar();
      };
      rowChecks.push(cb);
      tdCheck.appendChild(cb);
      tr.appendChild(tdCheck);

      const conciliado = Number(r?.total_amount || 0);
      const status = clientStatus(c, conciliado);
      const vendorName = v ? (v.full_name || v.email) : "—";
      const vendorClass = isAsesorPlaceholder(v) ? "vendor-asesor" : "";
      const fixedHtml = `
        <td>${escapeHtml(c.name)}</td>
        <td class="${vendorClass}">${escapeHtml(vendorName)}</td>
        <td>${escapeHtml(c.payment_method || "—")}</td>
        <td>${c.amount != null ? fmtMoney(c.amount) : "—"}</td>
        <td>${fmtMoney(conciliado)}</td>
        <td><span class="badge ${status.cls}">${status.label}</span></td>
        <td>${c.is_active ? '<span class="badge ok">Activo</span>' : "—"}</td>
        <td class="notes-cell">${c.notes ? escapeHtml(c.notes) : "—"}</td>`;
      const tmpl = document.createElement("template");
      tmpl.innerHTML = fixedHtml.trim();
      while (tmpl.content.firstChild) tr.appendChild(tmpl.content.firstChild);

      const tdActions = document.createElement("td");
      tdActions.style.whiteSpace = "nowrap";

      const editBtn = document.createElement("button");
      editBtn.className = "ghost icon-btn";
      editBtn.title = "Editar cliente";
      editBtn.textContent = "✏️";
      editBtn.onclick = () => editClientFlow(c, vendors, refresh);

      const reassignBtn = document.createElement("button");
      reassignBtn.className = "ghost icon-btn";
      reassignBtn.title = "Reasignar vendedor";
      reassignBtn.textContent = "↩";
      reassignBtn.onclick = () => reassignFlow([c.id], vendors, refresh);

      const delBtn = document.createElement("button");
      delBtn.className = "icon-danger";
      delBtn.textContent = "Eliminar";
      delBtn.onclick = () => deleteClientFlow(c, refresh);

      tdActions.append(editBtn, reassignBtn, delBtn);
      tr.appendChild(tdActions);

      tbody.appendChild(tr);
    }

    // El "seleccionar todo" sólo aplica al subset filtrado.
    const selectAll = tableEl.querySelector('input[data-role="select-all"]');
    if (selectAll) {
      selectAll.checked = false;
      selectAll.onchange = () => {
        for (const cb of rowChecks) cb.checked = selectAll.checked;
        if (selectAll.checked) for (const c of filtered) selected.add(c.id);
        else for (const c of filtered) selected.delete(c.id);
        repaintSelBar();
      };
    }
  }

  repaintBody();
  repaintSelBar();
}

function buildClientSearchBar(onChange) {
  const bar = document.createElement("div");
  bar.className = "filter-bar";

  const wrap = document.createElement("div");
  wrap.className = "search-input";
  const icon = document.createElement("span");
  icon.className = "search-icon";
  icon.textContent = "🔍";
  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "Buscar cliente por nombre…";
  input.value = clientSearch;
  input.oninput = () => { clientSearch = input.value; onChange(); };
  wrap.append(icon, input);
  bar.appendChild(wrap);

  return bar;
}

// Construye el header de una columna filtrable: label + botón ▾ que abre
// un popover con checkboxes de los valores únicos de esa columna.
function buildFilterableHeader(col, clients, ctx, onChange) {
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
    openColumnFilterPopover(btn, col, clients, ctx, () => {
      paintActive();
      onChange();
    });
  };
  wrap.appendChild(btn);

  function paintActive() {
    const active = columnFilters[col.key] != null;
    btn.classList.toggle("active", active);
  }
  paintActive();

  return wrap;
}

function openColumnFilterPopover(anchor, col, clients, ctx, onChange) {
  // Cerrar otros popovers abiertos
  document.querySelectorAll(".filter-popover").forEach((p) => p.remove());

  const values = [...new Set(clients.map((c) => col.value(c, ctx)))]
    .sort((a, b) => String(a).localeCompare(String(b)));

  const current = columnFilters[col.key];
  const selected = new Set(current || values);

  const pop = document.createElement("div");
  pop.className = "filter-popover";

  // Header: search dentro del popover
  const search = document.createElement("input");
  search.type = "search";
  search.className = "popover-search";
  search.placeholder = "Buscar valor…";
  pop.appendChild(search);

  // "Seleccionar todo" toggle
  const allRow = document.createElement("label");
  allRow.className = "popover-row popover-all";
  const allCb = document.createElement("input");
  allCb.type = "checkbox";
  allCb.checked = selected.size === values.length;
  const allLabel = document.createElement("span");
  allLabel.textContent = "Seleccionar todo";
  allRow.append(allCb, allLabel);
  pop.appendChild(allRow);

  // Lista de valores
  const list = document.createElement("div");
  list.className = "popover-list";
  pop.appendChild(list);

  function renderList() {
    clear(list);
    const q = search.value.trim().toLowerCase();
    const visible = q ? values.filter((v) => String(v).toLowerCase().includes(q)) : values;
    for (const val of visible) {
      const row = document.createElement("label");
      row.className = "popover-row";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = selected.has(val);
      cb.onchange = () => {
        if (cb.checked) selected.add(val);
        else selected.delete(val);
        allCb.checked = selected.size === values.length;
      };
      const txt = document.createElement("span");
      txt.textContent = val;
      row.append(cb, txt);
      list.appendChild(row);
    }
    if (!visible.length) {
      const empty = document.createElement("div");
      empty.className = "popover-empty muted";
      empty.textContent = "Sin coincidencias";
      list.appendChild(empty);
    }
  }
  renderList();
  search.oninput = renderList;

  allCb.onchange = () => {
    if (allCb.checked) for (const v of values) selected.add(v);
    else selected.clear();
    renderList();
  };

  // Footer: aplicar / limpiar
  const footer = document.createElement("div");
  footer.className = "popover-footer";
  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "ghost";
  clearBtn.textContent = "Limpiar";
  clearBtn.onclick = () => {
    columnFilters[col.key] = null;
    delete columnFilters[col.key];
    pop.remove();
    onChange();
  };
  const applyBtn = document.createElement("button");
  applyBtn.type = "button";
  applyBtn.textContent = "Aplicar";
  applyBtn.onclick = () => {
    if (selected.size === values.length) {
      delete columnFilters[col.key];
    } else {
      columnFilters[col.key] = selected;
    }
    pop.remove();
    onChange();
  };
  footer.append(clearBtn, applyBtn);
  pop.appendChild(footer);

  // Posicionar bajo el botón
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

function applyClientFilters(clients, ctx) {
  const q = clientSearch.trim().toLowerCase();
  return clients.filter((c) => {
    if (q && !String(c.name || "").toLowerCase().includes(q)) return false;
    for (const col of FILTERABLE_COLS) {
      const allowed = columnFilters[col.key];
      if (!allowed) continue;
      const v = col.value(c, ctx);
      if (!allowed.has(v)) return false;
    }
    return true;
  });
}

function applyClientSort(clients, ctx) {
  if (!clientSort.col) return clients;
  const col = CLIENT_COLS.find((c) => c.key === clientSort.col);
  if (!col) return clients;
  const dir = clientSort.dir;
  return [...clients].sort((a, b) => {
    const av = col.value(a, ctx);
    const bv = col.value(b, ctx);
    if (col.type === "number") return ((Number(av) || 0) - (Number(bv) || 0)) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
}

async function editClientFlow(client, vendors, refresh) {
  const data = await openModal({
    title: "Editar cliente",
    submitLabel: "Guardar",
    fields: [
      { name: "name", label: "Nombre del cliente", type: "text", required: true, value: client.name || "" },
      {
        name: "vendor_id", label: "Vendedor", type: "select", value: client.vendor_id || "",
        options: vendors.map((v) => ({ value: v.id, label: v.full_name || v.email })),
      },
      {
        name: "payment_method", label: "Método de pago", type: "select", value: client.payment_method || "",
        options: catalogOptions(METHODS, client.payment_method),
      },
      { name: "amount",   label: "Monto ($)",              type: "number", value: client.amount   ?? "" },
      { name: "enganche", label: "Enganche ($) — opc",     type: "number", value: client.enganche ?? "" },
      { name: "anticipo", label: "Anticipo ($) — opc",     type: "number", value: client.anticipo ?? "" },
    ],
  });
  if (!data) return;

  const update = {
    name: data.name,
    vendor_id: data.vendor_id,
    payment_method: data.payment_method || null,
    amount:   data.amount   === "" ? null : Number(data.amount),
    enganche: data.enganche === "" ? null : Number(data.enganche),
    anticipo: data.anticipo === "" ? null : Number(data.anticipo),
  };

  const { error } = await sb.from("clients").update(update).eq("id", client.id);
  if (error) { toast(error.message, "error"); return; }
  toast("Cliente actualizado.", "success");
  refresh();
}

function bulkEditSelectedFlow(ids, vendors, refresh) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";

    const modal = document.createElement("div");
    modal.className = "modal";

    const h = document.createElement("h2");
    h.textContent = `Editar ${ids.length} cliente${ids.length === 1 ? "" : "s"} en bloque`;
    modal.appendChild(h);

    const note = document.createElement("p");
    note.className = "muted";
    note.style.margin = "0";
    note.textContent = "Marca solo los campos que quieres cambiar. Los demás quedan igual.";
    modal.appendChild(note);

    const form = document.createElement("form");

    const zoneRow = makeOptionalField({
      label: "Zona", type: "select",
      options: ZONES.map((z) => ({ value: z, label: z })),
    });
    const vendorRow = makeOptionalField({
      label: "Vendedor asignado", type: "select",
      options: vendors.map((v) => ({ value: v.id, label: v.full_name || v.email })),
    });
    const methodRow = makeOptionalField({
      label: "Método de pago", type: "select",
      options: METHODS.map((m) => ({ value: m, label: m })),
    });

    form.append(zoneRow.wrapper, vendorRow.wrapper, methodRow.wrapper);

    const actions = document.createElement("div");
    actions.className = "actions";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "ghost";
    cancel.textContent = "Cancelar";
    cancel.onclick = () => { backdrop.remove(); resolve(); };

    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Aplicar cambios";

    actions.append(cancel, submit);
    form.appendChild(actions);
    modal.appendChild(form);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const update = {};
      if (zoneRow.checkbox.checked)   update.zone           = zoneRow.input.value || null;
      if (vendorRow.checkbox.checked) update.vendor_id      = vendorRow.input.value;
      if (methodRow.checkbox.checked) update.payment_method = methodRow.input.value || null;

      if (Object.keys(update).length === 0) {
        toast("No marcaste ningún campo para cambiar.", "info");
        return;
      }

      backdrop.remove();
      const { error } = await sb.from("clients").update(update).in("id", ids);
      if (error) { toast(error.message, "error"); resolve(); return; }
      toast(`${ids.length} cliente${ids.length === 1 ? "" : "s"} actualizado${ids.length === 1 ? "" : "s"}.`, "success");
      refresh();
      resolve();
    };

    backdrop.addEventListener("click", (ev) => {
      if (ev.target === backdrop) { backdrop.remove(); resolve(); }
    });
  });
}

function makeOptionalField({ label, type, options }) {
  const wrapper = document.createElement("div");
  wrapper.className = "optional-field";

  const head = document.createElement("label");
  head.className = "optional-head";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";

  const labelSpan = document.createElement("span");
  labelSpan.textContent = `Cambiar ${label}`;

  head.append(checkbox, labelSpan);
  wrapper.appendChild(head);

  const input = document.createElement(type === "select" ? "select" : "input");
  if (type === "select") {
    for (const opt of options || []) {
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.label;
      input.appendChild(o);
    }
  } else {
    input.type = type;
  }
  input.disabled = true;

  checkbox.onchange = () => { input.disabled = !checkbox.checked; };

  wrapper.appendChild(input);
  return { wrapper, checkbox, input };
}

async function bulkDeleteSelectedFlow(ids, refresh) {
  const ok = await confirmDialog({
    title: `Eliminar ${ids.length} cliente${ids.length === 1 ? "" : "s"}`,
    message: `¿Eliminar los ${ids.length} cliente${ids.length === 1 ? "" : "s"} seleccionado${ids.length === 1 ? "" : "s"}? También se borran sus capturas. Es permanente.`,
    confirmLabel: "Eliminar",
    danger: true,
  });
  if (!ok) return;

  const { error } = await sb.from("clients").delete().in("id", ids);
  if (error) { toast(error.message, "error"); return; }
  toast(`${ids.length} eliminado${ids.length === 1 ? "" : "s"}.`, "success");
  refresh();
}

async function deleteClientFlow(client, refresh) {
  const ok = await confirmDialog({
    title: "Eliminar cliente",
    message: `¿Seguro que quieres eliminar a "${client.name}"? También se borrará su captura de pagos. Esta acción es permanente.`,
    confirmLabel: "Eliminar",
    danger: true,
  });
  if (!ok) return;

  const { error } = await sb.from("clients").delete().eq("id", client.id);
  if (error) { toast(error.message, "error"); return; }
  toast("Cliente eliminado.", "success");
  refresh();
}

async function bulkDeleteFlow(refresh) {
  const data = await openModal({
    title: "Vaciar TODA la lista",
    submitLabel: "Borrar todo",
    fields: [
      {
        name: "confirm",
        label: "Esto borrará TODOS los clientes y sus reportes. Escribe BORRAR para confirmar:",
        type: "text",
        required: true,
      },
    ],
  });
  if (!data) return;
  if (data.confirm !== "BORRAR") {
    toast("Cancelado: tienes que escribir BORRAR exactamente.", "info");
    return;
  }

  const { error } = await sb.from("clients").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  if (error) { toast(error.message, "error"); return; }
  toast("Lista vaciada.", "success");
  refresh();
}

async function triggerImport(refresh) {
  const { data: vendors, error } = await sb
    .from("profiles")
    .select("id, email, full_name")
    .eq("role", "vendor")
    .order("full_name");
  if (error) { toast(error.message, "error"); return; }
  if (!vendors?.length) {
    toast("No hay vendedores registrados. Crea al menos uno antes de importar.", "error");
    return;
  }

  const params = await openImportModal(vendors);
  if (!params) return;

  try {
    const rows = await parseFile(params.file);
    if (!rows.length) { toast("El archivo no tiene filas válidas.", "error"); return; }
    const { inserted, updated, skipped, errors } = await importRows(rows, params.defaults);
    const parts = [];
    if (inserted) parts.push(`Insertados: ${inserted}`);
    if (updated)  parts.push(`Actualizados: ${updated}`);
    if (skipped)  parts.push(`Omitidos (suma 0): ${skipped}`);
    if (errors.length) parts.push(`Errores: ${errors.length}`);
    toast(parts.join(" · ") || "Sin cambios.", errors.length ? "info" : "success");
    if (errors.length) {
      for (const e of errors.slice(0, 5)) {
        toast(`${e.row.cliente || e.row.contacto || e.row.name || "(sin nombre)"} → ${e.reason}`, "error", 5000);
      }
    }
    refresh();
  } catch (e) {
    toast(`Import falló: ${e.message || e}`, "error");
  }
}

function openImportModal(vendors) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";

    const modal = document.createElement("div");
    modal.className = "modal";

    const h = document.createElement("h2");
    h.textContent = "Importar lista de clientes";
    modal.appendChild(h);

    const note = document.createElement("p");
    note.className = "muted";
    note.style.margin = "0";
    note.textContent = "Zona y mes se leen automáticamente del archivo. Si seleccionas un vendedor aquí, se aplica a TODAS las filas; si no, se usa la columna vendedor_email del CSV.";
    modal.appendChild(note);

    const form = document.createElement("form");

    const fileLabel = document.createElement("label");
    fileLabel.textContent = "Archivo CSV / Excel";
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".csv,.xlsx,.xls";
    fileInput.required = true;
    fileLabel.appendChild(fileInput);
    form.appendChild(fileLabel);

    const vendorLabel = document.createElement("label");
    vendorLabel.textContent = "Vendedor (aplica a todos)";
    const vendorSelect = document.createElement("select");
    vendorSelect.appendChild(opt("", "— Usar columna del CSV —"));
    for (const v of vendors) {
      vendorSelect.appendChild(opt(v.id, v.full_name || v.email));
    }
    vendorLabel.appendChild(vendorSelect);
    form.appendChild(vendorLabel);

    const actions = document.createElement("div");
    actions.className = "actions";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "ghost";
    cancel.textContent = "Cancelar";
    cancel.onclick = () => { backdrop.remove(); resolve(null); };

    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Importar";

    actions.append(cancel, submit);
    form.appendChild(actions);
    modal.appendChild(form);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    form.onsubmit = (ev) => {
      ev.preventDefault();
      const file = fileInput.files?.[0];
      if (!file) return;
      backdrop.remove();
      resolve({
        file,
        defaults: { vendor_id: vendorSelect.value || null },
      });
    };

    backdrop.addEventListener("click", (ev) => {
      if (ev.target === backdrop) { backdrop.remove(); resolve(null); }
    });
  });
}

function opt(value, label) {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  return o;
}

async function addClientFlow(refresh) {
  const { data: vendors, error } = await sb
    .from("profiles")
    .select("id, email, full_name")
    .eq("role", "vendor")
    .order("email");
  if (error) { toast(error.message, "error"); return; }
  if (!vendors?.length) { toast("No hay vendedores registrados.", "error"); return; }

  const data = await openModal({
    title: "Agregar cliente",
    submitLabel: "Crear",
    fields: [
      { name: "name", label: "Nombre del cliente", type: "text", required: true },
      {
        name: "vendor_id", label: "Vendedor", type: "select",
        options: vendors.map((v) => ({ value: v.id, label: v.full_name || v.email })),
      },
      {
        name: "payment_method", label: "Método de pago", type: "select",
        options: catalogOptions(METHODS, ""),
      },
      { name: "amount",   label: "Monto ($)",          type: "number" },
      { name: "enganche", label: "Enganche ($) — opc", type: "number" },
      { name: "anticipo", label: "Anticipo ($) — opc", type: "number" },
    ],
  });
  if (!data) return;

  const { error: insErr } = await sb.from("clients").insert({
    name: data.name,
    vendor_id: data.vendor_id,
    payment_method: data.payment_method || null,
    amount:   data.amount   === "" ? null : Number(data.amount),
    enganche: data.enganche === "" ? null : Number(data.enganche),
    anticipo: data.anticipo === "" ? null : Number(data.anticipo),
  });
  if (insErr) { toast(insErr.message, "error"); return; }
  toast("Cliente creado.", "success");
  refresh();
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}


// Vendedor "placeholder" (asesor / asesor comercial / similar). Se pinta en
// itálicas grises para que el master los detecte y reasigne fácil.
function isAsesorPlaceholder(vendor) {
  if (!vendor) return false;
  const name = (vendor.full_name || "").toLowerCase().trim();
  if (!name) return false;
  return /\basesor( comercial)?\b/.test(name);
}

async function reassignFlow(ids, vendors, refresh) {
  if (!ids.length) return;
  const data = await openModal({
    title: ids.length === 1 ? "Reasignar vendedor" : `Reasignar ${ids.length} clientes`,
    submitLabel: "Aplicar",
    fields: [
      {
        name: "vendor_id", label: "Vendedor", type: "select", required: true,
        options: [{ value: "", label: "—" }, ...vendors.map((v) => ({ value: v.id, label: v.full_name || v.email }))],
      },
    ],
  });
  if (!data) return;
  if (!data.vendor_id) { toast("Selecciona un vendedor.", "info"); return; }

  const { error } = await sb.from("clients").update({ vendor_id: data.vendor_id }).in("id", ids);
  if (error) { toast(error.message, "error"); return; }
  toast(`${ids.length} cliente${ids.length === 1 ? "" : "s"} reasignado${ids.length === 1 ? "" : "s"}.`, "success");
  refresh();
}

// Estado derivado del conciliado vs monto contratado.
function clientStatus(client, conciliado) {
  const monto = Number(client.amount || 0);
  if (monto > 0 && conciliado >= monto) return { cls: "ok", label: "Conciliado" };
  if (conciliado > 0) return { cls: "partial", label: "Parcial" };
  return { cls: "pending", label: "Pendiente" };
}
