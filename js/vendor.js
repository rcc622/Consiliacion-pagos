// Vista vendedor: tabla resumen de sus clientes + modal con captura libre.
//
// Modelo simplificado (sin schedule auto-calculado):
//   - El vendor agrega filas manualmente con "+ Agregar fila".
//   - Cada fila: monto + forma de pago + fecha + status.
//   - Conciliado = suma de filas con monto > 0.
//   - Estado del cliente derivado de conciliado vs monto contratado.
//   - Enganche, anticipo y método de pago son campos informativos opcionales.
//   - Activo: bandera del cliente que indica al admin que la diferencia
//     entre monto y conciliado es esperada (cliente sigue pagando).

import { sb } from "./supabase.js";
import { clear, toast, fmtMoney } from "./ui.js";
import { getProfile } from "./auth.js";

const PAYMENT_FORMS = ["Efectivo", "Transferencia", "Link de pago"];
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

export async function renderVendor() {
  const root = document.getElementById("view-vendor");
  clear(root);

  const profile = getProfile();
  if (!profile) return;

  root.appendChild(headerNode(profile));

  const summary = document.createElement("div");
  summary.className = "summary";
  root.appendChild(summary);

  const tableWrap = document.createElement("div");
  tableWrap.className = "table-wrap";
  root.appendChild(tableWrap);

  const { clients, reports } = await loadData();
  paintSummary(summary, clients, reports);
  paintTable(tableWrap, clients, reports, profile, () => renderVendor());
}

function headerNode(profile) {
  const h = document.createElement("h1");
  h.textContent = `Mis clientes — ${profile.full_name || profile.email}`;
  return h;
}

async function loadData() {
  const [clientsRes, reportsRes] = await Promise.all([
    sb.from("clients")
      .select("id, name, payment_method, amount, enganche, anticipo, notes, is_active, reference, status")
      .order("name"),
    sb.from("payments_report").select("client_id, total_amount, installments, updated_at"),
  ]);

  if (clientsRes.error) { toast(clientsRes.error.message, "error"); throw clientsRes.error; }
  if (reportsRes.error) { toast(reportsRes.error.message, "error"); throw reportsRes.error; }

  return { clients: clientsRes.data || [], reports: reportsRes.data || [] };
}

function paintSummary(container, clients, reports) {
  const reportedIds = new Set(reports.filter((r) => Number(r?.total_amount) > 0).map((r) => r.client_id));
  const reportedCount = clients.filter((c) => reportedIds.has(c.id)).length;
  const total = clients.length;
  const totalConciliado = reports.reduce((s, r) => s + Number(r.total_amount || 0), 0);

  clear(container);
  container.append(
    stat("Asignados", total),
    stat("Con captura", `${reportedCount} / ${total}`),
    stat("Pendientes", total - reportedCount),
    stat("Conciliado", fmtMoney(totalConciliado)),
  );
}

function stat(label, value, kind = "") {
  const el = document.createElement("div");
  el.className = `stat${kind ? ` stat-${kind}` : ""}`;
  const l = document.createElement("div"); l.className = "label"; l.textContent = label;
  const v = document.createElement("div"); v.className = "value"; v.textContent = value;
  el.append(l, v);
  return el;
}

function paintTable(container, clients, reports, profile, refresh) {
  clear(container);
  const reportByClient = new Map(reports.map((r) => [r.client_id, r]));

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  thead.innerHTML = `
    <tr>
      <th>Cliente</th>
      <th>Método de pago</th>
      <th>Monto</th>
      <th>Conciliado</th>
      <th>Estado</th>
      <th>Notas</th>
    </tr>`;
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const c of clients) {
    const r = reportByClient.get(c.id);
    tbody.appendChild(rowFor(c, r, profile, refresh));
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

function rowFor(client, report, profile, refresh) {
  const tr = document.createElement("tr");

  const tdName = document.createElement("td");
  const link = document.createElement("a");
  link.href = "#";
  link.textContent = client.name;
  link.className = "row-link";
  link.onclick = (ev) => { ev.preventDefault(); openClientDetail(client, report, profile, refresh); };
  tdName.appendChild(link);

  const tdMethod  = document.createElement("td"); tdMethod.textContent  = client.payment_method || "—";
  const tdAmount  = document.createElement("td"); tdAmount.textContent  = client.amount != null ? fmtMoney(client.amount) : "—";

  const conciliado = Number(report?.total_amount || 0);
  const tdConc = document.createElement("td");
  tdConc.textContent = fmtMoney(conciliado);

  const tdStatus = document.createElement("td");
  const badge = document.createElement("span");
  paintRowStatus(badge, client, conciliado);
  tdStatus.appendChild(badge);

  const tdNotes = document.createElement("td");
  tdNotes.appendChild(notesEditor(client));

  tr.append(tdName, tdMethod, tdAmount, tdConc, tdStatus, tdNotes);
  return tr;
}

function paintRowStatus(el, client, conciliado) {
  const s = clientEffectiveStatus(client, conciliado);
  el.className = `badge ${s.cls}`;
  el.textContent = s.label;
}

// Si el asesor seteó un status manual, gana sobre el derivado.
function clientEffectiveStatus(client, conciliado) {
  if (client.status) return statusBadge(client.status);
  const monto = Number(client.amount || 0);
  if (monto > 0 && conciliado >= monto) return { cls: "ok", label: "Conciliado" };
  if (conciliado > 0) return { cls: "partial", label: "Parcial" };
  return { cls: "pending", label: "Pendiente" };
}

function statusBadge(status) {
  switch (status) {
    case "Conciliado": return { cls: "ok", label: "Conciliado" };
    case "Activo":     return { cls: "ok", label: "Activo" };
    case "Parcial":    return { cls: "partial", label: "Parcial" };
    case "Pendiente":  return { cls: "pending", label: "Pendiente" };
    default:           return { cls: "partial", label: status };
  }
}

// Textarea inline para notes. Persiste en clients.notes via UPDATE.
function notesEditor(client) {
  const ta = document.createElement("textarea");
  ta.className = "notes-editor";
  ta.placeholder = "Notas…";
  ta.rows = 2;
  ta.value = client.notes || "";

  let saving = false;
  ta.addEventListener("blur", async () => {
    if (saving) return;
    const next = ta.value.trim() || null;
    const prev = client.notes ?? null;
    if ((prev ?? null) === (next ?? null)) return;

    saving = true;
    const { error } = await sb.from("clients").update({ notes: next }).eq("id", client.id);
    saving = false;
    if (error) {
      toast(error.message, "error");
      ta.value = client.notes || "";
      return;
    }
    client.notes = next;
    toast("Notas guardadas.", "success", 1500);
  });

  ta.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") { ta.value = client.notes || ""; ta.blur(); }
  });

  return ta;
}

// === Modal de detalle =======================================================

function openClientDetail(client, report, profile, refresh) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";

  const modal = document.createElement("div");
  modal.className = "modal detail-modal";

  // Título
  const h = document.createElement("h2");
  h.textContent = client.name;
  modal.appendChild(h);

  // Stats (Total / Conciliado / Pte conciliar / Pagos)
  const summary = document.createElement("div");
  summary.className = "summary";
  modal.appendChild(summary);

  // Sección informativa: método, enganche, anticipo, estatus.
  // El subtítulo deja claro que estos campos los completa el asesor.
  const infoTitle = document.createElement("div");
  infoTitle.className = "client-info-title";
  infoTitle.textContent = "El asesor llena estos datos:";
  modal.appendChild(infoTitle);

  const info = document.createElement("div");
  info.className = "client-info-grid";
  modal.appendChild(info);

  // Pagos capturados header con botón Agregar fila
  const payHead = document.createElement("div");
  payHead.className = "pay-head";
  const payTitle = document.createElement("h3");
  payTitle.textContent = "Pagos capturados";
  payTitle.className = "pay-title";
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "ghost";
  addBtn.textContent = "+ Agregar fila";
  payHead.append(payTitle, addBtn);
  modal.appendChild(payHead);

  // Tabla de filas capturadas
  const wrap = document.createElement("div");
  wrap.className = "table-wrap detail-schedule";
  const table = document.createElement("table");
  table.innerHTML = `
    <thead><tr>
      <th>#</th>
      <th>Monto</th>
      <th>Forma de pago</th>
      <th>Fecha de pago</th>
      <th>Status</th>
      <th></th>
    </tr></thead>`;
  const tbody = document.createElement("tbody");
  table.appendChild(tbody);
  wrap.appendChild(table);

  const pagBar = document.createElement("div");
  pagBar.className = "pagination-bar";
  modal.appendChild(pagBar);
  modal.appendChild(wrap);

  // Estado en memoria: cada fila tiene un id local estable para borrarla
  const rows = (Array.isArray(report?.installments) ? report.installments : [])
    .map((it, i) => ({
      id: localId(),
      n: typeof it.n === "number" ? it.n : i + 1,
      amount: it.amount ?? null,
      form:   it.form   ?? "",
      date:   it.date   ?? "",
    }));

  function refreshSummary() {
    const paidRows = rows.filter(isPaidRow);
    const totalPaid = paidRows.reduce((s, r) => s + Number(r.amount || 0), 0);
    const totalContract = Number(client.amount || 0);
    clear(summary);
    summary.append(
      stat("Monto contratado", fmtMoney(totalContract)),
      stat("Conciliado", fmtMoney(totalPaid)),
      stat("Pte conciliar", fmtMoney(Math.max(0, totalContract - totalPaid)), "danger"),
      stat("Pagos", String(paidRows.length)),
    );
  }

  async function persist() {
    // Renumerar n sequencial al guardar (la fila eliminada deja huecos).
    rows.forEach((r, i) => { r.n = i + 1; });
    const installments = rows
      .filter(isPaidRow)
      .map((r) => ({ n: r.n, amount: Number(r.amount), form: r.form, date: r.date }));
    const totalPaid = installments.reduce((s, r) => s + Number(r.amount || 0), 0);

    return sb.from("payments_report").upsert({
      client_id: client.id,
      vendor_id: profile.id,
      months_paid: installments.length,
      total_amount: totalPaid,
      installments,
    }, { onConflict: "client_id" });
  }

  paintInfo();
  function paintInfo() {
    clear(info);
    info.append(
      methodPicker(client),
      moneyEditorBlock("Enganche (opc)", client, "enganche"),
      moneyEditorBlock("Anticipo (opc)", client, "anticipo"),
      statusPicker(client),
    );
  }

  // Pagos: paginación
  const PAGE_SIZES = [5, 10, 25, 50];
  let pageSize = 10;
  let currentPage = 1;

  function totalPages() {
    if (pageSize === Infinity) return 1;
    return Math.max(1, Math.ceil(rows.length / pageSize));
  }

  function paintPagination() {
    clear(pagBar);
    if (rows.length <= 5) { pagBar.hidden = true; return; }
    pagBar.hidden = false;

    const sizeLabel = document.createElement("label");
    sizeLabel.className = "page-size";
    sizeLabel.textContent = "Mostrar ";
    const sizeSelect = document.createElement("select");
    for (const s of PAGE_SIZES) sizeSelect.appendChild(opt(String(s), String(s)));
    sizeSelect.appendChild(opt("all", "Todos"));
    sizeSelect.value = pageSize === Infinity ? "all" : String(pageSize);
    sizeSelect.onchange = () => {
      pageSize = sizeSelect.value === "all" ? Infinity : Number(sizeSelect.value);
      currentPage = 1;
      renderPage();
    };
    sizeLabel.appendChild(sizeSelect);
    pagBar.appendChild(sizeLabel);

    const spacer = document.createElement("div");
    spacer.className = "spacer";
    pagBar.appendChild(spacer);

    const prev = document.createElement("button");
    prev.type = "button"; prev.className = "ghost"; prev.textContent = "‹";
    prev.disabled = currentPage <= 1;
    prev.onclick = () => { currentPage--; renderPage(); };

    const infoSp = document.createElement("span");
    infoSp.className = "muted page-info";
    infoSp.textContent = `Página ${currentPage} de ${totalPages()}`;

    const next = document.createElement("button");
    next.type = "button"; next.className = "ghost"; next.textContent = "›";
    next.disabled = currentPage >= totalPages();
    next.onclick = () => { currentPage++; renderPage(); };

    pagBar.append(prev, infoSp, next);
  }

  function renderPage() {
    if (currentPage > totalPages()) currentPage = totalPages();
    if (currentPage < 1) currentPage = 1;

    const start = pageSize === Infinity ? 0 : (currentPage - 1) * pageSize;
    const end   = pageSize === Infinity ? rows.length : start + pageSize;

    clear(tbody);
    if (rows.length === 0) {
      const empty = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 6;
      td.className = "muted center";
      td.style.textAlign = "center";
      td.textContent = "Sin pagos capturados. Click en + Agregar fila.";
      empty.appendChild(td);
      tbody.appendChild(empty);
    } else {
      rows.slice(start, end).forEach((r, i) => {
        tbody.appendChild(buildRow(r, start + i + 1));
      });
    }
    paintPagination();
  }

  function buildRow(r, displayIdx) {
    const tr = document.createElement("tr");

    const tdIdx = document.createElement("td");
    tdIdx.textContent = String(displayIdx);

    const tdAmount = document.createElement("td");
    const amountInput = document.createElement("input");
    amountInput.type = "text";
    amountInput.inputMode = "decimal";
    amountInput.placeholder = "$0.00";
    tdAmount.appendChild(amountInput);

    const tdForm = document.createElement("td");
    const formSelect = document.createElement("select");
    formSelect.appendChild(opt("", "—"));
    for (const f of PAYMENT_FORMS) formSelect.appendChild(opt(f, f));
    formSelect.value = r.form || "";
    tdForm.appendChild(formSelect);

    const tdDate = document.createElement("td");
    const dateInput = document.createElement("input");
    dateInput.type = "date";
    dateInput.value = r.date || "";
    tdDate.appendChild(dateInput);

    const tdStatus = document.createElement("td");
    const badge = document.createElement("span");
    tdStatus.appendChild(badge);

    const tdDel = document.createElement("td");
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "icon-danger";
    delBtn.title = "Borrar fila";
    delBtn.textContent = "✕";
    tdDel.appendChild(delBtn);

    function paintAmount() {
      if (r.amount != null && r.amount !== "") amountInput.value = fmtMoney(Number(r.amount));
      else amountInput.value = "";
    }
    function paintBadge() {
      if (isPaidRow(r)) { badge.className = "badge ok"; badge.textContent = "Pagado"; }
      else if ((r.amount != null && r.amount !== "") || r.form || r.date) {
        badge.className = "badge partial"; badge.textContent = "Incompleto";
      } else {
        badge.className = "badge pending"; badge.textContent = "Vacío";
      }
    }
    paintAmount();
    paintBadge();

    let pendingSave = false;
    async function save() {
      if (pendingSave) return;
      pendingSave = true;
      const { error } = await persist();
      pendingSave = false;
      if (error) toast(error.message, "error");
    }

    function commit() {
      const raw = amountInput.value.replace(/[^\d.\-]/g, "");
      r.amount = raw === "" ? null : Number(raw);
      if (!Number.isFinite(r.amount)) r.amount = null;
      r.form = formSelect.value;
      r.date = dateInput.value;
      paintAmount();
      paintBadge();
      refreshSummary();
      save();
    }

    amountInput.addEventListener("focus", () => {
      if (r.amount != null) amountInput.value = String(r.amount);
      else amountInput.value = "";
      setTimeout(() => amountInput.select(), 0);
    });
    amountInput.addEventListener("blur", commit);
    amountInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); amountInput.blur(); }
    });
    formSelect.addEventListener("change", commit);
    dateInput.addEventListener("change", commit);

    delBtn.addEventListener("click", async () => {
      const idx = rows.findIndex((x) => x.id === r.id);
      if (idx === -1) return;
      rows.splice(idx, 1);
      if (currentPage > totalPages()) currentPage = totalPages();
      renderPage();
      refreshSummary();
      const { error } = await persist();
      if (error) toast(error.message, "error");
    });

    tr.append(tdIdx, tdAmount, tdForm, tdDate, tdStatus, tdDel);
    return tr;
  }

  addBtn.addEventListener("click", () => {
    rows.push({ id: localId(), n: rows.length + 1, amount: null, form: "", date: "" });
    if (pageSize !== Infinity) currentPage = totalPages();
    renderPage();
    refreshSummary();
  });

  renderPage();
  refreshSummary();

  // Footer
  const actions = document.createElement("div");
  actions.className = "actions";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Cerrar";
  close.onclick = () => { backdrop.remove(); refresh(); };
  actions.appendChild(close);
  modal.appendChild(actions);

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  backdrop.addEventListener("click", (ev) => {
    if (ev.target === backdrop) { backdrop.remove(); refresh(); }
  });
}

// Editor inline para método de pago (informativo, no afecta cálculos).
function methodPicker(client) {
  const wrap = document.createElement("label");
  wrap.className = "info-field";
  const span = document.createElement("span");
  span.textContent = "Método de pago";
  span.className = "info-label";
  const select = document.createElement("select");
  select.appendChild(opt("", "—"));
  // Opción legacy para no romper datos viejos fuera del catálogo nuevo.
  const current = client.payment_method || "";
  const inCatalog = METHODS.includes(current);
  for (const m of METHODS) select.appendChild(opt(m, m));
  if (current && !inCatalog) select.appendChild(opt(current, current + " (legacy)"));
  select.value = current;

  let saving = false;
  select.addEventListener("change", async () => {
    if (saving) return;
    saving = true;
    const next = select.value || null;
    const { error } = await sb.from("clients").update({ payment_method: next }).eq("id", client.id);
    saving = false;
    if (error) { toast(error.message, "error"); select.value = client.payment_method || ""; return; }
    client.payment_method = next;
    toast("Método actualizado.", "success", 1500);
  });

  wrap.append(span, select);
  return wrap;
}

// Bloque editable para enganche / anticipo (informativo, no afecta cálculo).
function moneyEditorBlock(label, client, field) {
  const wrap = document.createElement("label");
  wrap.className = "info-field";
  const span = document.createElement("span");
  span.textContent = label;
  span.className = "info-label";
  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "decimal";
  input.placeholder = "—";
  input.className = "money-editor";

  function paint() {
    const v = Number(client[field] || 0);
    input.value = v ? fmtMoney(v) : "";
  }
  paint();

  input.addEventListener("focus", () => {
    const v = Number(client[field] || 0);
    input.value = v ? String(v) : "";
    setTimeout(() => input.select(), 0);
  });

  let saving = false;
  input.addEventListener("blur", async () => {
    if (saving) return;
    const raw = input.value.replace(/[^\d.\-]/g, "");
    const next = raw === "" ? null : Number(raw);
    const cleaned = Number.isFinite(next) ? next : null;
    if ((client[field] ?? null) === (cleaned ?? null)) { paint(); return; }

    saving = true;
    const { error } = await sb.from("clients").update({ [field]: cleaned }).eq("id", client.id);
    saving = false;
    if (error) { toast(error.message, "error"); paint(); return; }
    client[field] = cleaned;
    paint();
    toast("Guardado.", "success", 1500);
  });

  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); input.blur(); }
    if (ev.key === "Escape") { paint(); input.blur(); }
  });

  wrap.append(span, input);
  return wrap;
}

// Select de estatus del cliente. Reemplaza al toggle binario "Activo".
// Persiste en clients.status. Vacío ("Auto") = el badge se deriva del
// conciliado vs monto.
const STATUS_OPTIONS = ["Pendiente", "Parcial", "Activo", "Conciliado"];

function statusPicker(client) {
  const wrap = document.createElement("div");
  wrap.className = "info-field";

  const span = document.createElement("span");
  span.textContent = "Estatus";
  span.className = "info-label";

  const select = document.createElement("select");
  select.appendChild(opt("", "Auto"));
  for (const s of STATUS_OPTIONS) select.appendChild(opt(s, s));
  select.value = client.status || "";

  let saving = false;
  select.addEventListener("change", async () => {
    if (saving) return;
    saving = true;
    const next = select.value || null;
    const { error } = await sb.from("clients").update({ status: next }).eq("id", client.id);
    saving = false;
    if (error) {
      toast(error.message, "error");
      select.value = client.status || "";
      return;
    }
    client.status = next;
    toast(next ? `Estatus: ${next}` : "Estatus en automático", "success", 1500);
  });

  wrap.append(span, select);
  return wrap;
}

function isPaidRow(r) {
  return r.amount != null && r.amount !== "" && Number(r.amount) > 0 && !!r.form && !!r.date;
}

function localId() {
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function opt(value, label) {
  const o = document.createElement("option");
  o.value = value; o.textContent = label; return o;
}
