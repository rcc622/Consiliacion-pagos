// Vista master: dashboard de progreso por vendedor / zona + import + alta manual.

import { sb } from "./supabase.js";
import { clear, toast, openModal, confirmDialog, fmtMoney } from "./ui.js";
import { parseFile, importRows } from "./import.js";
import { exportConciliation } from "./export.js";

const MONTHS = [
  "Enero","Febrero","Marzo","Abril","Mayo","Junio",
  "Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre",
];
const ZONES = [
  "Monterrey","Saltillo","Chihuahua","MTY Foraneo","FORANEO","COMERCIAL MTY",
];
const METHODS = [
  "Contado Riguroso-Direc",
  "Contado Riguroso-Mejoravit",
  "Contado Parcial-Direc",
  "Contado Parcial-Mejoravit",
  "Anticipo Mejoravit-MSI",
  "Anticipo Mejoravit 24 MSI",
  "FIDE",
  "FIDE-DIRECTO",
  "Financiamiento",
  "3 Meses Sin Intereses",
  "6 Meses Sin Intereses",
  "10 Meses Sin Intereses",
  "12 Meses Sin Intereses",
  "18 Meses Sin Intereses",
  "24 Meses Sin Intereses",
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

export async function renderMaster() {
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
    sb.from("clients").select("id, name, zone, vendor_id, payment_month, payment_method, amount, enganche, anticipo"),
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
  const reportedIds = new Set(reports.map((r) => r.client_id));
  const reported = clients.filter((c) => reportedIds.has(c.id)).length;
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
  const reportedIds = new Set(reports.map((r) => r.client_id));
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

  const table = document.createElement("table");
  table.innerHTML = `
    <thead><tr>
      <th>Vendedor</th><th>Zona</th><th>Asignados</th>
      <th>Reportados</th><th>%</th><th>Monto</th>
    </tr></thead>`;
  const tbody = document.createElement("tbody");
  for (const r of rows) {
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
  table.appendChild(tbody);
  container.appendChild(table);
}

function paintByZone(container, clients, reports) {
  clear(container);
  const reportedIds = new Set(reports.map((r) => r.client_id));
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

  // Barra de seleccion (solo se muestra cuando hay >=1 marcado)
  const selBar = document.createElement("div");
  selBar.className = "selection-bar";
  selBar.hidden = true;
  container.appendChild(selBar);

  const tableEl = document.createElement("table");
  tableEl.innerHTML = `
    <thead><tr>
      <th class="check-col"><input type="checkbox" data-role="select-all" /></th>
      <th>Cliente</th><th>Mes</th><th>Zona</th><th>Vendedor</th>
      <th>Método de pago</th><th>Monto</th>
      <th>Enganche</th><th>Anticipo</th><th>Diferido / mes</th>
      <th># Mens. reportadas</th><th>Monto reportado</th><th>Estado</th>
      <th></th>
    </tr></thead>`;
  const tbody = document.createElement("tbody");
  const rowChecks = [];

  function repaintSelBar() {
    clear(selBar);
    if (selected.size === 0) { selBar.hidden = true; return; }
    selBar.hidden = false;

    const label = document.createElement("span");
    label.className = "muted";
    label.textContent = `${selected.size} seleccionado${selected.size === 1 ? "" : "s"}`;

    const editBtn = document.createElement("button");
    editBtn.textContent = "Editar selección";
    editBtn.onclick = () => bulkEditSelectedFlow([...selected], vendors, refresh);

    const delBtn = document.createElement("button");
    delBtn.className = "danger";
    delBtn.textContent = "Eliminar selección";
    delBtn.onclick = () => bulkDeleteSelectedFlow([...selected], refresh);

    selBar.append(label, editBtn, delBtn);
  }

  for (const c of clients) {
    const v = vendorById.get(c.vendor_id);
    const r = reportByClient.get(c.id);
    const reported = r && (r.months_paid != null || r.total_amount != null);
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

    // Resto de columnas
    const dif = deferredMonthly(c);
    const fixedHtml = `
      <td>${escapeHtml(c.name)}</td>
      <td>${escapeHtml(c.payment_month || "—")}</td>
      <td>${escapeHtml(c.zone || "—")}</td>
      <td>${escapeHtml(v ? (v.full_name || v.email) : "—")}</td>
      <td>${escapeHtml(c.payment_method || "—")}</td>
      <td>${c.amount != null ? fmtMoney(c.amount) : "—"}</td>
      <td>${fmtMoneyOrNA(c.enganche)}</td>
      <td>${fmtMoneyOrNA(c.anticipo)}</td>
      <td>${dif == null ? "N/A" : fmtMoney(dif)}</td>
      <td>${r?.months_paid ?? "—"}</td>
      <td>${r?.total_amount != null ? fmtMoney(r.total_amount) : "—"}</td>
      <td><span class="badge ${reported ? "ok" : "pending"}">${reported ? "Reportado" : "Pendiente"}</span></td>`;
    const tmpl = document.createElement("template");
    tmpl.innerHTML = fixedHtml.trim();
    while (tmpl.content.firstChild) tr.appendChild(tmpl.content.firstChild);

    // Celda acciones (lapiz + eliminar)
    const tdActions = document.createElement("td");
    tdActions.style.whiteSpace = "nowrap";

    const editBtn = document.createElement("button");
    editBtn.className = "ghost icon-btn";
    editBtn.title = "Editar cliente";
    editBtn.textContent = "✏️";
    editBtn.onclick = () => editClientFlow(c, vendors, refresh);

    const delBtn = document.createElement("button");
    delBtn.className = "icon-danger";
    delBtn.textContent = "Eliminar";
    delBtn.onclick = () => deleteClientFlow(c, refresh);

    tdActions.append(editBtn, delBtn);
    tr.appendChild(tdActions);

    tbody.appendChild(tr);
  }
  tableEl.appendChild(tbody);
  container.appendChild(tableEl);

  // Wire del "seleccionar todo" del header
  const selectAll = tableEl.querySelector('input[data-role="select-all"]');
  if (selectAll) {
    selectAll.onchange = () => {
      for (const cb of rowChecks) cb.checked = selectAll.checked;
      selected = new Set(selectAll.checked ? clients.map((c) => c.id) : []);
      repaintSelBar();
    };
  }

  repaintSelBar();
}

async function editClientFlow(client, vendors, refresh) {
  const data = await openModal({
    title: "Editar cliente",
    submitLabel: "Guardar",
    fields: [
      { name: "name", label: "Nombre del cliente", type: "text", required: true, value: client.name || "" },
      {
        name: "payment_month", label: "Mes", type: "select", value: client.payment_month || "",
        options: [{ value: "", label: "—" }, ...MONTHS.map((m) => ({ value: m, label: m }))],
      },
      {
        name: "zone", label: "Zona", type: "select", value: client.zone || "",
        options: catalogOptions(ZONES, client.zone),
      },
      {
        name: "vendor_id", label: "Vendedor", type: "select", value: client.vendor_id || "",
        options: vendors.map((v) => ({ value: v.id, label: v.full_name || v.email })),
      },
      {
        name: "payment_method", label: "Método de pago", type: "select", value: client.payment_method || "",
        options: catalogOptions(METHODS, client.payment_method),
      },
      { name: "amount",   label: "Monto ($)",    type: "number", value: client.amount   ?? "" },
      { name: "enganche", label: "Enganche ($)", type: "number", value: client.enganche ?? "" },
      { name: "anticipo", label: "Anticipo ($)", type: "number", value: client.anticipo ?? "" },
    ],
  });
  if (!data) return;

  const update = {
    name: data.name,
    zone: data.zone || null,
    vendor_id: data.vendor_id,
    payment_month:  data.payment_month  || null,
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
    const { inserted, errors } = await importRows(rows, params.defaults);
    toast(`Insertados: ${inserted}. Errores: ${errors.length}.`, errors.length ? "info" : "success");
    if (errors.length) {
      for (const e of errors.slice(0, 5)) {
        toast(`${e.row.cliente || "(sin nombre)"} → ${e.reason}`, "error", 5000);
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
        name: "payment_month", label: "Mes", type: "select",
        options: [{ value: "", label: "—" }, ...MONTHS.map((m) => ({ value: m, label: m }))],
      },
      {
        name: "zone", label: "Zona", type: "select",
        options: catalogOptions(ZONES, ""),
      },
      {
        name: "vendor_id", label: "Vendedor", type: "select",
        options: vendors.map((v) => ({ value: v.id, label: v.full_name || v.email })),
      },
      {
        name: "payment_method", label: "Método de pago", type: "select",
        options: catalogOptions(METHODS, ""),
      },
      { name: "amount",   label: "Monto ($)",    type: "number" },
      { name: "enganche", label: "Enganche ($)", type: "number" },
      { name: "anticipo", label: "Anticipo ($)", type: "number" },
    ],
  });
  if (!data) return;

  const { error: insErr } = await sb.from("clients").insert({
    name: data.name,
    zone: data.zone || null,
    vendor_id: data.vendor_id,
    payment_month:  data.payment_month  || null,
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

function fmtMoneyOrNA(n) {
  const v = Number(n || 0);
  return v ? fmtMoney(v) : "N/A";
}

function deferredMonthly(client) {
  const method = client.payment_method || "";
  const msi = method.match(/^(\d+) Meses Sin Intereses$/) || method.match(/(\d+) MSI$/);
  if (!msi) return null;
  const n = parseInt(msi[1], 10);
  if (!n) return null;
  return +((Number(client.amount || 0) - Number(client.enganche || 0) - Number(client.anticipo || 0)) / n).toFixed(2);
}
