// Vista master: dashboard de progreso por vendedor / zona + import + alta manual.

import { sb, fetchAll } from "./supabase.js";
import { clear, toast, openModal, confirmDialog, fmtMoney } from "./ui.js";
import { parseFile, importRows, parseForBackfill } from "./import.js";
import { exportConciliation } from "./export.js";
import { openClientDetail } from "./vendor.js";
import { getProfile } from "./auth.js";

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
  { key: "reference",  label: "Referencia",     type: "string", filterable: true, value: (c) => c.reference || "—" },
  { key: "name",       label: "Cliente",        type: "string", filterable: true, value: (c) => c.name || "" },
  { key: "vendor",     label: "Vendedor",       type: "string", filterable: true, value: (c, ctx) => ctx.vendorLabel(c) },
  { key: "method",     label: "Método de pago", type: "string", filterable: true, value: (c) => c.payment_method || "—" },
  { key: "amount",     label: "Monto Proyecto", type: "number", filterable: true, value: (c) => Number(c.amount || 0) },
  { key: "enganche",   label: "Enganche",       type: "number", filterable: true, value: (c) => Number(c.enganche || 0) },
  { key: "anticipo",   label: "Anticipo",       type: "number", filterable: true, value: (c) => Number(c.anticipo || 0) },
  { key: "conciliado", label: "Conciliado",     type: "number", filterable: true, value: (c, ctx) => Number(ctx.reportFor(c)?.total_amount || 0) },
  { key: "status",     label: "Estado",         type: "string", filterable: true, value: (c, ctx) => ctx.statusLabel(c) },
  { key: "notes",      label: "Notas",          type: "string", filterable: true, value: (c) => c.notes || "" },
  { key: "inherited",  label: "Heredado de",    type: "string", filterable: true, value: (c) => c.inherited_from || "" },
];

const FILTERABLE_COLS = CLIENT_COLS.filter((c) => c.filterable);

export async function renderMaster() {
  // selected sí se resetea (ids podrían quedar stale tras refetch).
  // Filtros, búsqueda y sort PERSISTEN entre re-renders para que el master
  // pueda auditar sin perder contexto cuando se actualizan datos.
  selected = new Set();
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

  const auditBtn = document.createElement("button");
  auditBtn.className = "ghost";
  auditBtn.textContent = "Auditar duplicados";
  auditBtn.onclick = () => auditDuplicatesFlow(refresh);

  const backfillBtn = document.createElement("button");
  backfillBtn.className = "ghost";
  backfillBtn.textContent = "Backfill origen";
  backfillBtn.title = "Sube los CSV originales para poblar el campo 'Heredado de' por matcheo. NO crea clientes.";
  backfillBtn.onclick = () => backfillInheritedFlow(refresh);

  const backupBtn = document.createElement("button");
  backupBtn.className = "ghost";
  backupBtn.textContent = "Backup";
  backupBtn.title = "Descarga un JSON con todos los clientes y reportes actuales.";
  backupBtn.onclick = () => backupFlow();

  const spacer = document.createElement("div");
  spacer.className = "spacer";

  const wipeBtn = document.createElement("button");
  wipeBtn.className = "danger";
  wipeBtn.textContent = "Vaciar lista";
  wipeBtn.onclick = () => bulkDeleteFlow(refresh);

  bar.append(importBtn, addBtn, exportXlsxBtn, exportCsvBtn, auditBtn, backfillBtn, backupBtn, spacer, wipeBtn);
  return bar;
}

async function loadAll() {
  // clients y payments_report pueden tener miles de filas; paginamos para
  // no quedarnos cortos en el límite default del PostgREST.
  const [vendorsRes, clients, reports] = await Promise.all([
    sb.from("profiles").select("id, email, full_name, zone, role").eq("role", "vendor"),
    fetchAll(() => sb.from("clients").select("id, name, zone, vendor_id, payment_month, payment_method, amount, enganche, anticipo, notes, due_date, reference, is_active, status, enganche_form, enganche_date, anticipo_form, anticipo_date, medidor_bidi, inherited_from")),
    fetchAll(() => sb.from("payments_report").select("client_id, vendor_id, months_paid, total_amount, installments, updated_at")),
  ]);

  if (vendorsRes.error) { toast(vendorsRes.error.message, "error"); throw vendorsRes.error; }

  // Auto-flag: MSI sin filas capturadas → status="Revisar".
  // Solo aplica si el status actual está vacío o es no-terminal (Pendiente
  // / Parcial). Status terminales (Activo, Conciliado, Cancelado, Duplicado,
  // Revisar) se respetan tal cual.
  await autoFlagMSIRevisar(clients, reports);

  return {
    vendors: vendorsRes.data || [],
    clients,
    reports,
  };
}

async function autoFlagMSIRevisar(clients, reports) {
  const reportByClient = new Map(reports.map((r) => [r.client_id, r]));
  const overridable = new Set([null, undefined, "", "Pendiente", "Parcial"]);
  const toFlag = clients.filter((c) => {
    if (c.payment_method !== "MSI") return false;
    if (!overridable.has(c.status)) return false;
    const r = reportByClient.get(c.id);
    const installments = Array.isArray(r?.installments) ? r.installments : [];
    return installments.length === 0;
  });
  if (!toFlag.length) return;
  const ids = toFlag.map((c) => c.id);
  const { error } = await sb.from("clients").update({ status: "Revisar" }).in("id", ids);
  if (error) {
    console.warn("autoFlagMSIRevisar:", error.message);
    return;
  }
  for (const c of toFlag) c.status = "Revisar";
}

// Un cliente cuenta como "completado/reportado" si:
//   - Tiene algo conciliado (total_amount > 0), O
//   - El asesor le puso un status terminal: Activo, Conciliado, Cancelado
//     o Duplicado. Esos cierran el caso aunque no haya pagos capturados.
const COMPLETED_STATUSES = new Set(["Activo", "Conciliado", "Cancelado", "Duplicado"]);
function isCompleted(client, conciliado) {
  if ((conciliado || 0) > 0) return true;
  return COMPLETED_STATUSES.has(client.status || "");
}

function paintTopSummary(container, clients, reports) {
  const total = clients.length;
  const conciliadoByClient = new Map(reports.map((r) => [r.client_id, Number(r.total_amount || 0)]));
  const reported = clients.filter((c) => isCompleted(c, conciliadoByClient.get(c.id))).length;
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
  const conciliadoByClient = new Map(reports.map((r) => [r.client_id, Number(r.total_amount || 0)]));
  const amountByVendor = new Map();
  for (const r of reports) {
    amountByVendor.set(r.vendor_id, (amountByVendor.get(r.vendor_id) || 0) + Number(r.total_amount || 0));
  }

  const rows = vendors.map((v) => {
    const own = clients.filter((c) => c.vendor_id === v.id);
    const ownReported = own.filter((c) => isCompleted(c, conciliadoByClient.get(c.id))).length;
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
  const amountByClient = new Map(reports.map((r) => [r.client_id, Number(r.total_amount || 0)]));

  const groups = new Map();
  for (const c of clients) {
    const key = c.zone || "Sin zona";
    if (!groups.has(key)) groups.set(key, { assigned: 0, reported: 0, amount: 0 });
    const g = groups.get(key);
    g.assigned += 1;
    if (isCompleted(c, amountByClient.get(c.id))) g.reported += 1;
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
      labelSpan.className = "th-label";
      labelSpan.textContent = col.label;
      th.appendChild(labelSpan);
    }
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
    paintSortIndicators();
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

      // Referencia (antes del nombre).
      const tdRef = document.createElement("td");
      tdRef.textContent = c.reference || "—";
      if (!c.reference) tdRef.className = "muted";
      tr.appendChild(tdRef);

      // Cliente: link clickeable que abre el modal en modo vista por defecto.
      const tdName = document.createElement("td");
      const link = document.createElement("a");
      link.href = "#";
      link.className = "row-link";
      link.textContent = c.name;
      link.onclick = (ev) => {
        ev.preventDefault();
        openClientDetail(c, r, getProfile(), refresh, "view");
      };
      tdName.appendChild(link);
      tr.appendChild(tdName);

      const fixedHtml = `
        <td class="${vendorClass}">${escapeHtml(vendorName)}</td>
        <td>${escapeHtml(c.payment_method || "—")}</td>
        <td>${c.amount != null ? fmtMoney(c.amount) : "—"}</td>
        <td>${Number(c.enganche || 0) > 0 ? fmtMoney(c.enganche) : "—"}</td>
        <td>${Number(c.anticipo || 0) > 0 ? fmtMoney(c.anticipo) : "—"}</td>
        <td>${fmtMoney(conciliado)}</td>
        <td><span class="badge ${status.cls}">${status.label}</span></td>`;
      const tmpl = document.createElement("template");
      tmpl.innerHTML = fixedHtml.trim();
      while (tmpl.content.firstChild) tr.appendChild(tmpl.content.firstChild);

      // Notas: celda con truncado a 1 línea + botón "Ver" si el texto se
      // pasa. Mantiene la fila compacta sin importar el largo de la nota.
      tr.appendChild(buildNotesCell(c.notes || ""));

      // Heredado de: vendedor original cuando el cliente fue transferido.
      const tdInh = document.createElement("td");
      if (c.inherited_from) {
        tdInh.textContent = c.inherited_from;
        tdInh.className = "origin-inherited";
      } else {
        tdInh.textContent = "—";
        tdInh.className = "muted";
      }
      tr.appendChild(tdInh);

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

  const isNumeric = col.type === "number";
  const values = [...new Set(clients.map((c) => col.value(c, ctx)))]
    .sort((a, b) => isNumeric
      ? (Number(a) || 0) - (Number(b) || 0)
      : String(a).localeCompare(String(b)));

  const current = columnFilters[col.key];
  const selected = new Set(current || values);

  const pop = document.createElement("div");
  pop.className = "filter-popover";

  // Acciones de orden (estilo Google Sheets) — al hacer click, ordenan la
  // tabla por esta columna y cierran el popover.
  const sortHead = document.createElement("div");
  sortHead.className = "popover-sort";
  const sortAsc = document.createElement("button");
  sortAsc.type = "button";
  sortAsc.className = "popover-link";
  sortAsc.innerHTML = isNumeric
    ? `<span class="popover-link-icon">↑</span> Ordenar de menor a mayor`
    : `<span class="popover-link-icon">↑</span> Ordenar A → Z`;
  sortAsc.onclick = () => {
    clientSort.col = col.key;
    clientSort.dir = 1;
    pop.remove();
    onChange();
  };
  const sortDesc = document.createElement("button");
  sortDesc.type = "button";
  sortDesc.className = "popover-link";
  sortDesc.innerHTML = isNumeric
    ? `<span class="popover-link-icon">↓</span> Ordenar de mayor a menor`
    : `<span class="popover-link-icon">↓</span> Ordenar Z → A`;
  sortDesc.onclick = () => {
    clientSort.col = col.key;
    clientSort.dir = -1;
    pop.remove();
    onChange();
  };
  sortHead.append(sortAsc, sortDesc);
  pop.appendChild(sortHead);

  // Toolbar: links "Seleccionar todo · Borrar" + contador
  const toolbar = document.createElement("div");
  toolbar.className = "popover-toolbar";
  const selAll = document.createElement("a");
  selAll.href = "#";
  selAll.className = "popover-link-text";
  selAll.textContent = "Seleccionar todo";
  selAll.onclick = (ev) => { ev.preventDefault(); for (const v of values) selected.add(v); renderList(); };
  const dot = document.createElement("span");
  dot.className = "muted";
  dot.textContent = " · ";
  const clearAll = document.createElement("a");
  clearAll.href = "#";
  clearAll.className = "popover-link-text";
  clearAll.textContent = "Borrar";
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
  search.type = "search";
  search.className = "popover-search";
  search.placeholder = "Buscar valor…";
  searchWrap.append(searchIcon, search);
  pop.appendChild(searchWrap);

  // Lista de valores
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
        if (cb.checked) selected.add(val);
        else selected.delete(val);
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

  // Footer: cancelar / aplicar
  const footer = document.createElement("div");
  footer.className = "popover-footer";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "ghost";
  cancelBtn.textContent = "Cancelar";
  cancelBtn.onclick = () => { pop.remove(); };
  const applyBtn = document.createElement("button");
  applyBtn.type = "button";
  applyBtn.textContent = "Aceptar";
  applyBtn.onclick = () => {
    if (selected.size === values.length) {
      delete columnFilters[col.key];
    } else {
      columnFilters[col.key] = selected;
    }
    pop.remove();
    onChange();
  };
  footer.append(cancelBtn, applyBtn);
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
      { name: "reference", label: "Referencia", type: "text", value: client.reference || "" },
      {
        name: "vendor_id", label: "Vendedor", type: "select", value: client.vendor_id || "",
        options: vendors.map((v) => ({ value: v.id, label: v.full_name || v.email })),
      },
      {
        name: "payment_method", label: "Método de pago", type: "select", value: client.payment_method || "",
        options: catalogOptions(METHODS, client.payment_method),
      },
      { name: "amount",   label: "Monto Proyecto ($)",              type: "number", value: client.amount   ?? "" },
      { name: "enganche", label: "Enganche ($)",     type: "number", value: client.enganche ?? "" },
      { name: "anticipo", label: "Anticipo ($) — opc",     type: "number", value: client.anticipo ?? "" },
    ],
  });
  if (!data) return;

  const update = {
    name: data.name,
    reference: data.reference?.trim() || null,
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

// Descarga un JSON con todos los clientes y reportes actuales.
// Útil para tener un snapshot antes de operaciones masivas (import,
// vaciar lista, audit) y poder revertir manualmente desde SQL Editor
// si algo sale mal.
async function backupFlow() {
  let clients, reports;
  try {
    clients = await fetchAll(() => sb.from("clients").select("*"));
    reports = await fetchAll(() => sb.from("payments_report").select("*"));
  } catch (e) { toast(e.message || String(e), "error"); return; }

  const data = {
    version: 1,
    exported_at: new Date().toISOString(),
    clients,
    payments_report: reports,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const a = document.createElement("a");
  a.href = url;
  a.download = `backup_${ts}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Backup descargado: ${clients.length} clientes + ${reports.length} reportes.`, "success");
}

// Auditor de duplicados: lista clientes que comparten reference / nombre+monto / nombre.
async function auditDuplicatesFlow(refresh) {
  let clients;
  let reports;
  try {
    clients = await fetchAll(() => sb.from("clients")
      .select("id, name, reference, amount, vendor_id, notes, status, enganche, enganche_form, enganche_date, anticipo, anticipo_form, anticipo_date, dup_ok"));
    reports = await fetchAll(() => sb.from("payments_report").select("client_id, total_amount, installments"));
  } catch (e) { toast(e.message || String(e), "error"); return; }

  const { data: vendors, error: vErr } = await sb.from("profiles")
    .select("id, email, full_name").eq("role", "vendor");
  if (vErr) { toast(vErr.message, "error"); return; }
  const vendorById = new Map((vendors || []).map((v) => [v.id, v]));
  const reportByClient = new Map(reports.map((r) => [r.client_id, r]));

  // Score y flags por cliente para identificar quién tiene info capturada.
  for (const c of clients) {
    const r = reportByClient.get(c.id);
    const conciliado = Number(r?.total_amount || 0);
    const installments = Array.isArray(r?.installments) ? r.installments.length : 0;
    const engOk = !!(c.enganche && c.enganche_form && c.enganche_form !== "N/A" && c.enganche_date);
    const antOk = !!(c.anticipo && c.anticipo_form && c.anticipo_form !== "N/A" && c.anticipo_date);
    c._report = r || null;
    c._data = {
      notes: !!c.notes,
      status: !!c.status,
      conciliado,
      installments,
      engOk,
      antOk,
    };
    c._score =
      (c._data.notes        ? 1 : 0) +
      (c._data.status       ? 1 : 0) +
      (c._data.conciliado>0 ? 2 : 0) +
      (c._data.installments ? 1 : 0) +
      (c._data.engOk        ? 1 : 0) +
      (c._data.antOk        ? 1 : 0);
  }

  // 1) Por reference.
  const byRef = new Map();
  for (const c of clients) {
    if (!c.reference) continue;
    if (!byRef.has(c.reference)) byRef.set(c.reference, []);
    byRef.get(c.reference).push(c);
  }
  // Grupos donde TODOS los clientes están marcados como OK ya no se reportan
  // (el master los confirmó como duplicados intencionales / multi-proyecto).
  const someNotOk = (arr) => arr.some((c) => !c.dup_ok);
  const dupRef = [...byRef.entries()].filter(([, arr]) => arr.length > 1 && someNotOk(arr));

  // 2) Por nombre + monto idénticos.
  const byNM = new Map();
  for (const c of clients) {
    const k = `${c.name}|${Number(c.amount || 0).toFixed(2)}`;
    if (!byNM.has(k)) byNM.set(k, []);
    byNM.get(k).push(c);
  }
  const dupNM = [...byNM.entries()].filter(([, arr]) => arr.length > 1 && someNotOk(arr));

  // 3) Por nombre. Excluye multi-proyecto legítimos.
  const byName = new Map();
  for (const c of clients) {
    if (!byName.has(c.name)) byName.set(c.name, []);
    byName.get(c.name).push(c);
  }
  const dupName = [...byName.entries()].filter(([, arr]) => {
    if (arr.length <= 1) return false;
    if (!someNotOk(arr)) return false;
    const refs = arr.map((c) => c.reference).filter(Boolean);
    const distinct = new Set(refs);
    const allDistinctRefs = refs.length === arr.length && distinct.size === arr.length;
    return !allDistinctRefs;
  });

  showAuditModal({ dupRef, dupNM, dupName, vendorById, refresh });
}

function showAuditModal({ dupRef, dupNM, dupName, vendorById, refresh }) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  const modal = document.createElement("div");
  modal.className = "modal audit-modal";

  const h = document.createElement("h2");
  h.textContent = "Auditoría de duplicados";
  modal.appendChild(h);

  const note = document.createElement("p");
  note.className = "muted";
  note.style.margin = "0";
  note.textContent = 'Cada cliente lleva badges con la info capturada. La fila con más datos se marca como "Conservar". Selecciona los que quieras eliminar y usa "Eliminar selección" abajo.';
  modal.appendChild(note);

  // Estado compartido de selección entre todas las secciones.
  const selected = new Set();
  // checkboxRefs[id] = { cb, li, group }
  const rowRefs = new Map();

  // Toolbar superior
  const toolbar = document.createElement("div");
  toolbar.className = "audit-toolbar";
  const selNoData = document.createElement("button");
  selNoData.type = "button";
  selNoData.className = "ghost";
  selNoData.textContent = "Marcar todos los sin datos";
  selNoData.onclick = () => {
    for (const [, arr] of [...dupRef, ...dupNM, ...dupName]) {
      for (const c of arr) {
        if (c._score === 0) {
          selected.add(c.id);
          const ref = rowRefs.get(c.id);
          if (ref) ref.cb.checked = true;
        }
      }
    }
    repaintFooter();
  };
  const selClear = document.createElement("button");
  selClear.type = "button";
  selClear.className = "ghost";
  selClear.textContent = "Limpiar selección";
  selClear.onclick = () => {
    selected.clear();
    for (const ref of rowRefs.values()) ref.cb.checked = false;
    repaintFooter();
  };
  toolbar.append(selNoData, selClear);
  modal.appendChild(toolbar);

  // Secciones
  function renderSection(title, hint, groups) {
    const sect = buildAuditSection(title, hint, groups, vendorById, selected, rowRefs, repaintFooter);
    modal.appendChild(sect);
  }
  renderSection(
    `Por referencia compartida (${dupRef.length} grupos)`,
    "🔴 Duplicado real — un mismo reference no debería estar en dos clientes.",
    dupRef,
  );
  renderSection(
    `Por nombre + monto idénticos (${dupNM.length} grupos)`,
    "🟡 Muy probable duplicado — mismo nombre y mismo monto.",
    dupNM,
  );
  renderSection(
    `Por nombre solo, no multi-proyecto (${dupName.length} grupos)`,
    "🟠 Mismo nombre con references parciales o repetidos. Revisar caso por caso.",
    dupName,
  );

  // Footer sticky con bulk delete + cerrar.
  const footer = document.createElement("div");
  footer.className = "audit-footer";
  const counter = document.createElement("span");
  counter.className = "muted";
  const bulkDel = document.createElement("button");
  bulkDel.type = "button";
  bulkDel.className = "danger";
  bulkDel.textContent = "Eliminar selección";
  bulkDel.onclick = async () => {
    if (selected.size === 0) return;
    if (!confirm(`¿Eliminar ${selected.size} cliente(s)? Esta acción es permanente.`)) return;
    const ids = [...selected];
    const { error } = await sb.from("clients").delete().in("id", ids);
    if (error) { toast(error.message, "error"); return; }
    toast(`${ids.length} eliminado(s).`, "success");
    for (const id of ids) {
      const ref = rowRefs.get(id);
      if (ref) {
        ref.li.remove();
        if (ref.list.children.length <= 1) ref.group.remove();
        rowRefs.delete(id);
      }
    }
    selected.clear();
    repaintFooter();
  };
  // Marcar como Duplicado: en lugar de borrar, cambia status="Duplicado"
  // a la selección. Útil cuando el master quiere conservar el cliente
  // pero dejar visible que es un duplicado.
  const bulkDup = document.createElement("button");
  bulkDup.type = "button";
  bulkDup.className = "ghost";
  bulkDup.textContent = "Marcar como Duplicado";
  bulkDup.onclick = async () => {
    if (selected.size === 0) return;
    if (!confirm(`¿Marcar ${selected.size} cliente(s) con status "Duplicado"?`)) return;
    const ids = [...selected];
    const { error } = await sb.from("clients")
      .update({ status: "Duplicado", dup_ok: true })
      .in("id", ids);
    if (error) { toast(error.message, "error"); return; }
    toast(`${ids.length} marcado(s) como Duplicado.`, "success");
    for (const id of ids) {
      const ref = rowRefs.get(id);
      if (ref) {
        ref.li.remove();
        if (ref.list.children.length <= 1) ref.group.remove();
        rowRefs.delete(id);
      }
    }
    selected.clear();
    repaintFooter();
  };

  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Cerrar";
  close.onclick = () => { backdrop.remove(); refresh(); };
  footer.append(counter, bulkDup, bulkDel, close);
  modal.appendChild(footer);

  function repaintFooter() {
    counter.textContent = selected.size === 0
      ? "0 seleccionados"
      : `${selected.size} seleccionado(s)`;
    bulkDel.disabled = selected.size === 0;
    bulkDup.disabled = selected.size === 0;
  }
  repaintFooter();

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  backdrop.addEventListener("click", (ev) => {
    if (ev.target === backdrop) { backdrop.remove(); refresh(); }
  });
}

function buildAuditSection(title, hint, groups, vendorById, selected, rowRefs, repaintFooter) {
  const details = document.createElement("details");
  details.className = "audit-section";
  if (groups.length > 0) details.open = true;

  const summary = document.createElement("summary");
  summary.textContent = title;
  details.appendChild(summary);

  if (!groups.length) {
    const ok = document.createElement("p");
    ok.className = "muted";
    ok.style.margin = "6px 0";
    ok.textContent = "✅ Sin coincidencias.";
    details.appendChild(ok);
    return details;
  }

  const hintEl = document.createElement("p");
  hintEl.className = "muted";
  hintEl.style.margin = "4px 0 8px";
  hintEl.textContent = hint;
  details.appendChild(hintEl);

  for (const [key, arr] of groups) {
    const group = document.createElement("div");
    group.className = "audit-group";
    const head = document.createElement("div");
    head.className = "audit-group-head";
    const headText = document.createElement("span");
    headText.innerHTML = `<strong>${escapeHtml(key)}</strong> · ${arr.length} clientes`;
    head.appendChild(headText);

    // Botón "Marcar grupo OK": flagea todos los clientes con dup_ok=true
    // para que no vuelvan a aparecer en la auditoría.
    const okBtn = document.createElement("button");
    okBtn.type = "button";
    okBtn.className = "ghost audit-ok-btn";
    okBtn.textContent = "Marcar como OK";
    okBtn.title = "Confirma que estos clientes no son duplicados (multi-proyecto válido). El grupo desaparecerá del auditor.";
    okBtn.onclick = async () => {
      const ids = arr.map((c) => c.id);
      const { error } = await sb.from("clients").update({ dup_ok: true }).in("id", ids);
      if (error) { toast(error.message, "error"); return; }
      for (const id of ids) {
        const ref = rowRefs.get(id);
        if (ref) rowRefs.delete(id);
      }
      group.remove();
      toast(`Grupo marcado como OK (${ids.length} clientes).`, "success");
    };
    head.appendChild(okBtn);

    group.appendChild(head);

    const list = document.createElement("ul");
    list.className = "audit-group-list";

    // Ordena por score desc; el de mayor score se sugiere "conservar".
    const sorted = arr.slice().sort((a, b) => b._score - a._score);
    const maxScore = sorted[0]._score;

    for (const c of sorted) {
      const li = document.createElement("li");
      if (maxScore > 0 && c._score === maxScore) li.classList.add("audit-row-keep");

      // Checkbox
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "audit-cb";
      cb.checked = selected.has(c.id);
      cb.onchange = () => {
        if (cb.checked) selected.add(c.id);
        else selected.delete(c.id);
        repaintFooter();
      };

      // Texto principal — el nombre es link, abre el detalle del cliente
      // en modo vista para revisarlo a fondo sin cerrar el auditor.
      const v = vendorById.get(c.vendor_id);
      const vendorName = v ? (v.full_name || v.email) : "—";
      const monto = c.amount != null ? fmtMoney(c.amount) : "—";
      const main = document.createElement("span");
      main.className = "audit-row-main";
      if (c.reference) {
        const refSpan = document.createElement("span");
        refSpan.className = "muted";
        refSpan.textContent = `[${c.reference}] `;
        main.appendChild(refSpan);
      }
      const nameLink = document.createElement("a");
      nameLink.href = "#";
      nameLink.className = "row-link";
      nameLink.textContent = c.name;
      nameLink.title = "Ver detalle completo del cliente";
      nameLink.onclick = (ev) => {
        ev.preventDefault();
        openClientDetail(c, c._report, getProfile(), () => {}, "view");
      };
      main.appendChild(nameLink);
      main.appendChild(document.createTextNode(` · ${vendorName} · ${monto}`));

      // Badges
      const badges = buildAuditBadges(c, maxScore > 0 && c._score === maxScore);

      // Eliminar individual
      const del = document.createElement("button");
      del.type = "button";
      del.className = "icon-danger";
      del.textContent = "Eliminar";
      del.onclick = async () => {
        if (!confirm(`¿Eliminar ${c.name}? Esta acción es permanente.`)) return;
        const { error } = await sb.from("clients").delete().eq("id", c.id);
        if (error) { toast(error.message, "error"); return; }
        toast("Eliminado.", "success");
        selected.delete(c.id);
        rowRefs.delete(c.id);
        li.remove();
        if (list.children.length <= 1) group.remove();
        repaintFooter();
      };

      li.append(cb, main, badges, del);
      list.appendChild(li);
      rowRefs.set(c.id, { cb, li, list, group });
    }
    group.appendChild(list);
    details.appendChild(group);
  }

  return details;
}

function buildAuditBadges(c, isKeepCandidate) {
  const wrap = document.createElement("span");
  wrap.className = "audit-badges";

  if (isKeepCandidate) {
    const star = document.createElement("span");
    star.className = "audit-badge keep";
    star.textContent = "★ Conservar";
    star.title = "Tiene la mayor cantidad de datos capturados en este grupo";
    wrap.appendChild(star);
  }

  const d = c._data;
  if (!c._score) {
    const b = document.createElement("span");
    b.className = "audit-badge dim";
    b.textContent = "Sin datos";
    wrap.appendChild(b);
    return wrap;
  }

  if (d.conciliado > 0) {
    const b = document.createElement("span");
    b.className = "audit-badge ok";
    b.textContent = `💰 ${fmtMoney(d.conciliado)}`;
    b.title = `Conciliado: ${fmtMoney(d.conciliado)}`;
    wrap.appendChild(b);
  }
  if (d.installments > 0) {
    const b = document.createElement("span");
    b.className = "audit-badge ok";
    b.textContent = `${d.installments} pago(s)`;
    wrap.appendChild(b);
  }
  if (d.engOk) {
    const b = document.createElement("span");
    b.className = "audit-badge partial";
    b.textContent = "Eng ✓";
    b.title = "Enganche capturado con fecha y forma";
    wrap.appendChild(b);
  }
  if (d.antOk) {
    const b = document.createElement("span");
    b.className = "audit-badge partial";
    b.textContent = "Ant ✓";
    b.title = "Anticipo capturado con fecha y forma";
    wrap.appendChild(b);
  }
  if (d.notes) {
    const b = document.createElement("span");
    b.className = "audit-badge partial";
    b.textContent = "📝";
    b.title = "Tiene notas";
    wrap.appendChild(b);
  }
  if (d.status) {
    const b = document.createElement("span");
    b.className = "audit-badge partial";
    b.textContent = "🏷️";
    b.title = "Estatus manual";
    wrap.appendChild(b);
  }

  return wrap;
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

  let totals = { inserted: 0, updated: 0, skipped: 0, errors: [] };
  for (const file of params.files) {
    try {
      const rows = await parseFile(file);
      if (!rows.length) {
        toast(`${file.name}: sin filas válidas.`, "error", 4000);
        continue;
      }
      const res = await importRows(rows, params.defaults);
      totals.inserted += res.inserted || 0;
      totals.updated  += res.updated  || 0;
      totals.skipped  += res.skipped  || 0;
      if (res.errors?.length) {
        for (const e of res.errors) totals.errors.push({ ...e, file: file.name });
      }
    } catch (e) {
      toast(`${file.name}: ${e.message || e}`, "error", 5000);
    }
  }

  const parts = [];
  if (params.files.length > 1) parts.push(`${params.files.length} archivos`);
  if (totals.inserted) parts.push(`Insertados: ${totals.inserted}`);
  if (totals.updated)  parts.push(`Actualizados: ${totals.updated}`);
  if (totals.skipped)  parts.push(`Omitidos (suma 0): ${totals.skipped}`);
  if (totals.errors.length) parts.push(`Errores: ${totals.errors.length}`);
  toast(parts.join(" · ") || "Sin cambios.", totals.errors.length ? "info" : "success");
  for (const e of totals.errors.slice(0, 5)) {
    const who = e.row.cliente || e.row.contacto || e.row.name || "(sin nombre)";
    toast(`${e.file ? e.file + " · " : ""}${who} → ${e.reason}`, "error", 5000);
  }
  refresh();
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
    fileLabel.textContent = "Archivo(s) CSV / Excel";
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".csv,.xlsx,.xls";
    fileInput.multiple = true;
    fileInput.required = true;
    fileLabel.appendChild(fileInput);
    form.appendChild(fileLabel);

    const fileHint = document.createElement("small");
    fileHint.className = "muted";
    fileHint.textContent = "Puedes seleccionar varios archivos a la vez (Ctrl/Cmd + click).";
    form.appendChild(fileHint);

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
      const files = Array.from(fileInput.files || []);
      if (!files.length) return;
      backdrop.remove();
      resolve({
        files,
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
      { name: "reference", label: "Referencia", type: "text" },
      {
        name: "vendor_id", label: "Vendedor", type: "select",
        options: vendors.map((v) => ({ value: v.id, label: v.full_name || v.email })),
      },
      {
        name: "payment_method", label: "Método de pago", type: "select",
        options: catalogOptions(METHODS, ""),
      },
      { name: "amount",   label: "Monto Proyecto ($)",          type: "number" },
      { name: "enganche", label: "Enganche ($)", type: "number" },
      { name: "anticipo", label: "Anticipo ($) — opc", type: "number" },
    ],
  });
  if (!data) return;

  const { error: insErr } = await sb.from("clients").insert({
    name: data.name,
    reference: data.reference?.trim() || null,
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

// Celda de notas con truncado a 3 líneas + "ver más" debajo cuando aplica.
function buildNotesCell(notes) {
  const td = document.createElement("td");
  td.className = "notes-cell";
  if (!notes) {
    td.textContent = "—";
    return td;
  }
  const text = document.createElement("div");
  text.className = "notes-text";
  text.textContent = notes;
  td.appendChild(text);
  // Heurística: si hay > 80 chars probablemente ocupa más de 3 líneas
  // a 280px de ancho. Mostramos toggle.
  if (notes.length > 80) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "notes-toggle";
    toggle.textContent = "ver más";
    toggle.onclick = (ev) => {
      ev.stopPropagation();
      const expanded = td.classList.toggle("expanded");
      toggle.textContent = expanded ? "ver menos" : "ver más";
    };
    td.appendChild(toggle);
  }
  return td;
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

// El status manual del asesor (clients.status) gana sobre el derivado.
// === Backfill de inherited_from desde CSV ==================================
//
// IMPORTANTE: este flujo NO inserta ni borra clientes. Solo lee los CSV
// originales, matchea cada fila contra los clientes existentes en BD
// (por referencia → fallback nombre+monto) y actualiza inherited_from si
// está vacío. Si ya tiene valor, se omite (regla de Samuel: no sobreescribir).
async function backfillInheritedFlow(refresh) {
  const files = await pickBackfillFiles();
  if (!files || !files.length) return;

  let parsed = [];
  for (const f of files) {
    try {
      const rows = await parseForBackfill(f);
      for (const r of rows) parsed.push({ ...r, _source: f.name });
    } catch (e) {
      toast(`Error leyendo ${f.name}: ${e.message}`, "error");
      return;
    }
  }
  if (!parsed.length) { toast("Los archivos no tienen filas válidas.", "error"); return; }

  // Snapshot de clientes para matchear. Trae los campos justos.
  const clients = await fetchAll(() => sb.from("clients")
    .select("id, name, reference, amount, inherited_from, vendor_id"));

  // Índices: por referencia (primario) y por nombre+monto (fallback).
  const byRef = new Map();
  const byNameAmt = new Map();
  const byName = new Map();
  for (const c of clients) {
    if (c.reference) byRef.set(c.reference.trim(), c);
    const nk = normalizeName(c.name);
    if (nk) {
      const amtKey = `${nk}|${roundAmt(c.amount)}`;
      if (!byNameAmt.has(amtKey)) byNameAmt.set(amtKey, c);
      // byName solo guarda si es único; si hay >1 con mismo nombre, no se usa.
      if (byName.has(nk)) byName.set(nk, null);
      else byName.set(nk, c);
    }
  }

  // Plan: por cliente, qué vendedor le toca. Si dos filas matchean al
  // mismo cliente con vendedores distintos, lo marcamos como conflicto y
  // dejamos el primero.
  const plan = new Map(); // client.id -> { client, vendor, sources:[fileName] }
  const noMatch = [];
  const skippedAlready = [];
  const conflicts = [];
  let withoutVendorCol = 0;

  for (const r of parsed) {
    const vendor = (r.vendedor || "").trim();
    if (!vendor) { withoutVendorCol++; continue; }
    let match = null;
    if (r.referencia) match = byRef.get(r.referencia.trim()) || null;
    if (!match) {
      const nk = normalizeName(r.contacto);
      if (nk) {
        const k = `${nk}|${roundAmt(r.monto)}`;
        match = byNameAmt.get(k) || null;
        if (!match && byName.get(nk)) match = byName.get(nk);
      }
    }
    if (!match) { noMatch.push({ ...r }); continue; }
    if (match.inherited_from && match.inherited_from.trim()) {
      skippedAlready.push({ client: match, vendor, current: match.inherited_from, source: r._source });
      continue;
    }
    const existing = plan.get(match.id);
    if (!existing) {
      plan.set(match.id, { client: match, vendor, sources: [r._source] });
    } else if (existing.vendor !== vendor) {
      conflicts.push({ client: match, first: existing.vendor, second: vendor, source: r._source });
    } else {
      existing.sources.push(r._source);
    }
  }

  const toApply = Array.from(plan.values());
  const confirmed = await confirmBackfillPreview({
    matched: toApply,
    skippedAlready,
    conflicts,
    noMatch,
    withoutVendorCol,
    totalRows: parsed.length,
  });
  if (!confirmed) return;

  // Agrupa por nombre de vendedor → un UPDATE in(...) por grupo.
  const byVendor = new Map();
  for (const p of toApply) {
    if (!byVendor.has(p.vendor)) byVendor.set(p.vendor, []);
    byVendor.get(p.vendor).push(p.client.id);
  }
  let updated = 0;
  const errors = [];
  for (const [vendor, ids] of byVendor) {
    // Batchear in() en chunks de 500 ids para no romper la URL.
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const { error, count } = await sb.from("clients")
        .update({ inherited_from: vendor }, { count: "exact" })
        .in("id", chunk);
      if (error) errors.push(`${vendor}: ${error.message}`);
      else updated += count ?? chunk.length;
    }
  }

  if (errors.length) {
    toast(`Backfill con errores: ${errors[0]}`, "error");
  } else {
    toast(`Backfill listo: ${updated} clientes actualizados.`, "success");
  }
  refresh();
}

function normalizeName(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().trim().replace(/\s+/g, " ");
}
function roundAmt(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "x";
  return Math.round(v * 100) / 100;
}

function pickBackfillFiles() {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const modal = document.createElement("div");
    modal.className = "modal";
    const h = document.createElement("h2");
    h.textContent = "Backfill de origen (heredado de)";
    modal.appendChild(h);
    const note = document.createElement("p");
    note.className = "muted";
    note.style.margin = "0";
    note.innerHTML = "Sube los CSV originales. Se buscará la columna <strong>Vendedor</strong> y se poblará <em>Heredado de</em> en los clientes que matcheen. <strong>No se crean ni borran clientes.</strong>";
    modal.appendChild(note);

    const form = document.createElement("form");
    const fileLabel = document.createElement("label");
    fileLabel.textContent = "Archivos CSV / Excel";
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".csv,.xlsx,.xls";
    fileInput.multiple = true;
    fileInput.required = true;
    fileLabel.appendChild(fileInput);
    form.appendChild(fileLabel);

    const actions = document.createElement("div");
    actions.className = "actions";
    const cancel = document.createElement("button");
    cancel.type = "button"; cancel.className = "ghost"; cancel.textContent = "Cancelar";
    cancel.onclick = () => { backdrop.remove(); resolve(null); };
    const submit = document.createElement("button");
    submit.type = "submit"; submit.textContent = "Analizar";
    actions.append(cancel, submit);
    form.appendChild(actions);
    modal.appendChild(form);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    form.onsubmit = (ev) => {
      ev.preventDefault();
      const files = Array.from(fileInput.files || []);
      backdrop.remove();
      resolve(files);
    };
    backdrop.addEventListener("click", (ev) => {
      if (ev.target === backdrop) { backdrop.remove(); resolve(null); }
    });
  });
}

function confirmBackfillPreview({ matched, skippedAlready, conflicts, noMatch, withoutVendorCol, totalRows }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const modal = document.createElement("div");
    modal.className = "modal";
    modal.style.maxWidth = "640px";

    const h = document.createElement("h2");
    h.textContent = "Resumen del backfill";
    modal.appendChild(h);

    const stats = document.createElement("ul");
    stats.style.lineHeight = "1.7";
    stats.innerHTML = `
      <li><strong>${totalRows}</strong> filas leídas en total.</li>
      <li><strong>${matched.length}</strong> clientes se van a actualizar.</li>
      <li><strong>${skippedAlready.length}</strong> ya tenían un origen — se <em>omiten</em>.</li>
      <li><strong>${conflicts.length}</strong> con conflicto (mismo cliente, distintos vendedores en los CSV) — se queda el primero.</li>
      <li><strong>${noMatch.length}</strong> filas no matchearon ningún cliente.</li>
      <li><strong>${withoutVendorCol}</strong> filas sin columna Vendedor.</li>
    `;
    modal.appendChild(stats);

    // Desglose por vendedor para que vea qué se va a aplicar.
    if (matched.length) {
      const grouped = new Map();
      for (const m of matched) grouped.set(m.vendor, (grouped.get(m.vendor) || 0) + 1);
      const breakdown = document.createElement("details");
      breakdown.style.margin = "8px 0";
      const sum = document.createElement("summary");
      sum.textContent = `Por vendedor original (${grouped.size})`;
      sum.style.cursor = "pointer";
      breakdown.appendChild(sum);
      const ul = document.createElement("ul");
      for (const [v, n] of [...grouped].sort((a,b) => b[1]-a[1])) {
        const li = document.createElement("li");
        li.textContent = `${v}: ${n}`;
        ul.appendChild(li);
      }
      breakdown.appendChild(ul);
      modal.appendChild(breakdown);
    }

    if (noMatch.length) {
      const det = document.createElement("details");
      const sum = document.createElement("summary");
      sum.textContent = `Filas sin match (${noMatch.length})`;
      sum.style.cursor = "pointer";
      det.appendChild(sum);
      const ul = document.createElement("ul");
      ul.style.maxHeight = "180px";
      ul.style.overflow = "auto";
      for (const r of noMatch.slice(0, 200)) {
        const li = document.createElement("li");
        li.textContent = `${r.contacto || "—"} · ref:${r.referencia || "—"} · vend:${r.vendedor}`;
        ul.appendChild(li);
      }
      det.appendChild(ul);
      modal.appendChild(det);
    }

    const actions = document.createElement("div");
    actions.className = "actions";
    const cancel = document.createElement("button");
    cancel.type = "button"; cancel.className = "ghost"; cancel.textContent = "Cancelar";
    cancel.onclick = () => { backdrop.remove(); resolve(false); };
    const apply = document.createElement("button");
    apply.type = "button";
    apply.textContent = `Aplicar a ${matched.length}`;
    apply.disabled = matched.length === 0;
    apply.onclick = () => { backdrop.remove(); resolve(true); };
    actions.append(cancel, apply);
    modal.appendChild(actions);

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    backdrop.addEventListener("click", (ev) => {
      if (ev.target === backdrop) { backdrop.remove(); resolve(false); }
    });
  });
}

function clientStatus(client, conciliado) {
  if (client.status) {
    switch (client.status) {
      case "Conciliado": return { cls: "ok", label: "Conciliado" };
      case "Activo":     return { cls: "ok", label: "Activo" };
      case "Parcial":    return { cls: "partial", label: "Parcial" };
      case "Pendiente":  return { cls: "pending", label: "Pendiente" };
      case "Cancelado":  return { cls: "cancelled", label: "Cancelado" };
      case "Duplicado":  return { cls: "duplicate", label: "Duplicado" };
      case "Revisar":    return { cls: "revisar", label: "REVISAR" };
      case "Corregir":   return { cls: "corregir", label: "CORREGIR" };
      default:           return { cls: "partial", label: client.status };
    }
  }
  const monto = Number(client.amount || 0);
  if (monto > 0 && conciliado >= monto) return { cls: "ok", label: "Conciliado" };
  if (conciliado > 0) return { cls: "partial", label: "Parcial" };
  return { cls: "pending", label: "Pendiente" };
}
