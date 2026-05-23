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

import { sb, fetchAll } from "./supabase.js";
import { clear, toast, fmtMoney } from "./ui.js";
import { getProfile } from "./auth.js";
import {
  createFilterState,
  buildSearchBar,
  buildFilterableHeader,
  applyFilters,
  applySort,
  paintSortIndicators,
} from "./table-filters.js";

// Filtros + sort + búsqueda. Estado a nivel de módulo para que persista
// entre re-renders (igual que en la vista master).
const filterState = createFilterState();

// Metadata de columnas: orden visual + extractor de valor para sort/filter.
const VENDOR_COLS = [
  { key: "name",       label: "Cliente",        type: "string", value: (c) => c.name || "" },
  { key: "inherited",  label: "Heredado",       type: "string", value: (c) => c.inherited_from || "" },
  { key: "method",     label: "Método de pago", type: "string", value: (c) => c.payment_method || "—" },
  { key: "amount",     label: "Monto Proyecto", type: "number", value: (c) => Number(c.amount || 0) },
  { key: "conciliado", label: "Conciliado",     type: "number", value: (c, ctx) => Number(ctx.reportFor(c)?.total_amount || 0) },
  { key: "status",     label: "Estado",         type: "string", value: (c, ctx) => clientEffectiveStatus(c, Number(ctx.reportFor(c)?.total_amount || 0)).label },
  { key: "notes",      label: "Notas",          type: "string", value: (c) => c.notes || "" },
];

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
  const [clients, reports] = await Promise.all([
    fetchAll(() => sb.from("clients")
      .select("id, name, payment_method, amount, enganche, anticipo, notes, is_active, reference, status, enganche_form, enganche_date, anticipo_form, anticipo_date, medidor_bidi, inherited_from, vendor_id")
      .order("name")),
    fetchAll(() => sb.from("payments_report").select("client_id, total_amount, installments, updated_at")),
  ]);
  return { clients, reports };
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
  const ctx = { reportFor: (c) => reportByClient.get(c.id) };

  // Buscador por nombre (igual que en master).
  container.appendChild(buildSearchBar(filterState, () => repaintBody()));

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  for (const col of VENDOR_COLS) {
    const th = document.createElement("th");
    th.dataset.col = col.key;
    th.appendChild(buildFilterableHeader(col, clients, ctx, filterState, () => repaintBody()));
    trh.appendChild(th);
  }
  thead.appendChild(trh);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  table.appendChild(tbody);
  container.appendChild(table);

  function repaintBody() {
    paintSortIndicators(thead, VENDOR_COLS, filterState);
    const filtered = applyFilters(clients, ctx, VENDOR_COLS, filterState, "name");
    const sorted = applySort(filtered, ctx, VENDOR_COLS, filterState);
    clear(tbody);
    for (const c of sorted) {
      const r = reportByClient.get(c.id);
      tbody.appendChild(rowFor(c, r, profile, refresh));
    }
  }
  repaintBody();
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

  const tdOrigin = document.createElement("td");
  if (client.inherited_from) {
    tdOrigin.textContent = client.inherited_from;
    tdOrigin.className = "origin-inherited";
    tdOrigin.title = `Cliente heredado de ${client.inherited_from}`;
  } else {
    tdOrigin.textContent = "Propio";
    tdOrigin.className = "muted";
  }

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

  tr.append(tdName, tdOrigin, tdMethod, tdAmount, tdConc, tdStatus, tdNotes);
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
    case "Cancelado":  return { cls: "cancelled", label: "Cancelado" };
    case "Duplicado":  return { cls: "duplicate", label: "Duplicado" };
    case "Revisar":    return { cls: "revisar", label: "REVISAR" };
    case "Corregir":   return { cls: "corregir", label: "CORREGIR" };
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

// `mode` controla si el modal arranca editable o read-only. El usuario puede
// alternar con el toggle en el header. Default "edit" para vendedores;
// master pasa "view" para ver lo que captura el asesor sin tocar nada.
export function openClientDetail(client, report, profile, refresh, mode = "edit") {
  let currentMode = mode;
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";

  const modal = document.createElement("div");
  modal.className = "modal detail-modal";

  // Título con toggle de modo
  const header = document.createElement("div");
  header.className = "detail-header";
  const h = document.createElement("h2");
  h.textContent = client.name;
  const modeBtn = document.createElement("button");
  modeBtn.type = "button";
  modeBtn.className = "mode-toggle";
  modeBtn.dataset.role = "mode-toggle";
  modeBtn.addEventListener("click", () => {
    currentMode = currentMode === "view" ? "edit" : "view";
    paintMode();
  });
  header.append(h, modeBtn);
  modal.appendChild(header);

  function paintMode() {
    if (currentMode === "view") {
      modeBtn.textContent = "🔒 Vista — click para editar";
      modeBtn.classList.remove("on");
    } else {
      modeBtn.textContent = "✏️ Edición — click para solo ver";
      modeBtn.classList.add("on");
    }
    applyModeToModal(modal, currentMode);
  }

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
  addBtn.className = "ghost add-row-btn";
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
    let totalPaid = paidRows.reduce((s, r) => s + Number(r.amount || 0), 0);
    // Enganche y anticipo (con forma + fecha capturados) son pagos hechos
    // y deben sumar al "Conciliado". El form="N/A" no cuenta.
    if (client.enganche_form && client.enganche_form !== "N/A" && client.enganche_date) {
      totalPaid += Number(client.enganche || 0);
    }
    if (client.anticipo_form && client.anticipo_form !== "N/A" && client.anticipo_date) {
      totalPaid += Number(client.anticipo || 0);
    }
    const totalContract = Number(client.amount || 0);
    clear(summary);
    summary.append(
      stat("Monto Proyecto", fmtMoney(totalContract)),
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
    let totalPaid = installments.reduce((s, r) => s + Number(r.amount || 0), 0);
    // Enganche y anticipo (con forma + fecha) cuentan al total cobrado.
    if (client.enganche_form && client.enganche_form !== "N/A" && client.enganche_date) {
      totalPaid += Number(client.enganche || 0);
    }
    if (client.anticipo_form && client.anticipo_form !== "N/A" && client.anticipo_date) {
      totalPaid += Number(client.anticipo || 0);
    }

    return sb.from("payments_report").upsert({
      client_id: client.id,
      vendor_id: client.vendor_id || profile.id,
      months_paid: installments.length,
      total_amount: totalPaid,
      installments,
    }, { onConflict: "client_id" });
  }

  // Self-heal: si total_amount guardado en payments_report no coincide con
  // la suma actual (installments + enganche + anticipo con forma+fecha),
  // persistimos para sincronizar. Datos viejos podían quedar inflados por
  // bugs previos de doble conteo.
  (function syncStoredTotal() {
    const computed =
      rows.filter(isPaidRow).reduce((s, r) => s + Number(r.amount || 0), 0)
      + ((client.enganche_form && client.enganche_form !== "N/A" && client.enganche_date) ? Number(client.enganche || 0) : 0)
      + ((client.anticipo_form && client.anticipo_form !== "N/A" && client.anticipo_date) ? Number(client.anticipo || 0) : 0);
    const stored = Number(report?.total_amount || 0);
    if (Math.abs(computed - stored) > 0.01) {
      if (report) report.total_amount = computed;
      persist();
    }
  })();

  paintInfo();
  function paintInfo() {
    clear(info);
    const onChange = () => { refreshSummary(); persist(); paintInfo(); };
    // Calcula el estatus que tendría el cliente si no hubiera override manual,
    // para mostrarlo como label de la opción "vacía" del picker (en lugar de
    // un genérico "Auto"). Refleja monto vs conciliado actual.
    let totalPaid = rows.filter(isPaidRow).reduce((s, r) => s + Number(r.amount || 0), 0);
    if (client.enganche_form && client.enganche_form !== "N/A" && client.enganche_date) {
      totalPaid += Number(client.enganche || 0);
    }
    if (client.anticipo_form && client.anticipo_form !== "N/A" && client.anticipo_date) {
      totalPaid += Number(client.anticipo || 0);
    }
    const monto = Number(client.amount || 0);
    let derived = "Pendiente";
    if (monto > 0 && totalPaid >= monto) derived = "Conciliado";
    else if (totalPaid > 0) derived = "Parcial";
    info.append(
      methodPicker(client),
      moneyEditorBlock("Enganche", client, "enganche", onChange),
      moneyEditorBlock("Anticipo (opc)", client, "anticipo", onChange),
      statusPicker(client, derived),
      bidiCheckbox(client),
      inheritedFromBlock(client),
      notesEditorBlock(client),
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
      // Empty state clickeable: el botón principal queda arriba del modal y
      // si la pantalla es chica puede no estar visible. Aquí dentro de la
      // tabla damos una segunda manera de agregar fila, sin scroll.
      const empty = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 5;
      td.className = "muted center empty-add-cell";
      td.style.textAlign = "center";
      const emptyBtn = document.createElement("button");
      emptyBtn.type = "button";
      emptyBtn.className = "ghost add-row-btn empty-add-btn";
      emptyBtn.textContent = "+ Agregar primera fila";
      emptyBtn.onclick = () => addBtn.click();
      td.append("Sin pagos capturados. ", emptyBtn);
      empty.appendChild(td);
      tbody.appendChild(empty);
    } else {
      rows.slice(start, end).forEach((r, i) => {
        tbody.appendChild(buildRow(r, start + i + 1));
      });
    }
    paintPagination();
    applyModeToModal(modal, currentMode);
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

    const tdDel = document.createElement("td");
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "icon-danger row-delete-btn";
    delBtn.title = "Borrar fila";
    delBtn.textContent = "✕";
    tdDel.appendChild(delBtn);

    function paintAmount() {
      if (r.amount != null && r.amount !== "") amountInput.value = fmtMoney(Number(r.amount));
      else amountInput.value = "";
    }
    paintAmount();

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

    tr.append(tdIdx, tdAmount, tdForm, tdDate, tdDel);
    return tr;
  }

  addBtn.addEventListener("click", async () => {
    // Si faltan método/enganche/anticipo, recuerda al asesor antes de seguir.
    const ans = await askMissingDataConfirmation(client);
    if (!ans.proceed) return;

    // Si declaró "No lleva" para algunos, los marcamos como N/A en BD.
    if (Array.isArray(ans.markNA) && ans.markNA.length) {
      const patch = {};
      for (const k of ans.markNA) {
        if (k === "método") patch.payment_method = "N/A";
        if (k === "enganche") { patch.enganche = 0; patch.enganche_form = "N/A"; patch.enganche_date = null; }
        if (k === "anticipo") { patch.anticipo = 0; patch.anticipo_form = "N/A"; patch.anticipo_date = null; }
      }
      const { error } = await sb.from("clients").update(patch).eq("id", client.id);
      if (error) { toast(error.message, "error"); return; }
      Object.assign(client, patch);
      paintInfo();
    }

    rows.push({ id: localId(), n: rows.length + 1, amount: null, form: "", date: "" });
    if (pageSize !== Infinity) currentPage = totalPages();
    renderPage();
    refreshSummary();
    applyModeToModal(modal, currentMode);
  });

  renderPage();
  refreshSummary();

  // Footer
  const actions = document.createElement("div");
  actions.className = "actions";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Cerrar";
  let dirty = false;
  function markDirty() {
    if (dirty) return;
    dirty = true;
    close.textContent = "Cerrar y guardar";
  }
  // Cualquier cambio en inputs/selects/textareas del modal marca dirty.
  // El toggle de modo está fuera del flujo de captura, así que lo excluimos.
  modal.addEventListener("change", (ev) => {
    if (ev.target.closest("[data-role=mode-toggle]")) return;
    markDirty();
  });
  close.onclick = async () => {
    // Si hay foco en algún input, blurear primero para forzar persist
    // (los editores guardan al perder foco).
    if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
    // Pequeña espera para que termine cualquier save async pendiente.
    if (dirty) await new Promise((r) => setTimeout(r, 150));
    backdrop.remove();
    refresh();
  };
  actions.appendChild(close);
  modal.appendChild(actions);

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  // Aplicar modo inicial una vez que todos los elementos están en el DOM.
  paintMode();

  backdrop.addEventListener("click", (ev) => {
    if (ev.target === backdrop) { backdrop.remove(); refresh(); }
  });
}

// Habilita / deshabilita inputs y oculta botones según modo.
function applyModeToModal(modal, mode) {
  const view = mode === "view";
  modal.classList.toggle("view-mode", view);
  for (const el of modal.querySelectorAll("input, select, textarea")) {
    if (el.closest("[data-role=mode-toggle]")) continue;
    // Campos bloqueados por rol (status Conciliado/Revisar/Corregir para
    // vendor) NO se reactivan al entrar en edit mode. Si los re-habilitamos
    // aquí, el lock del statusPicker queda inerte y el vendor puede cambiar
    // un status que no le toca.
    if (el.closest(".field-locked")) { el.disabled = true; continue; }
    el.disabled = view;
  }
  for (const el of modal.querySelectorAll(".add-row-btn, .row-delete-btn")) {
    el.style.display = view ? "none" : "";
  }
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
  select.appendChild(opt("N/A", "N/A — no aplica"));
  if (current && !inCatalog && current !== "N/A") select.appendChild(opt(current, current + " (legacy)"));
  select.value = current;
  if (current === "N/A") wrap.classList.add("field-na");

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

// Bloque editable para enganche / anticipo. Cuando el asesor cambia el
// monto, se abre un mini-modal pidiendo fecha y forma de pago. Se guardan
// 3 columnas: <field>, <field>_form, <field>_date.
function moneyEditorBlock(label, client, field, onChange = () => {}) {
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
  const sub = document.createElement("small");
  sub.className = "info-sub muted";

  const formField = `${field}_form`;
  const dateField = `${field}_date`;

  function paint() {
    while (sub.firstChild) sub.removeChild(sub.firstChild);
    sub.classList.remove("warn");
    if (client[formField] === "N/A") {
      input.value = "";
      input.placeholder = "N/A";
      wrap.classList.add("field-na");
      sub.textContent = "Marcado como No aplica";
      return;
    }
    wrap.classList.remove("field-na");
    input.placeholder = "—";
    const v = Number(client[field] || 0);
    input.value = v ? fmtMoney(v) : "";
    if (v && client[formField] && client[dateField]) {
      sub.textContent = `${client[formField]} · ${formatDate(client[dateField])}`;
    } else if (v) {
      sub.classList.add("warn");
      const txt = document.createElement("span");
      txt.textContent = "Falta fecha / forma · ";
      const link = document.createElement("button");
      link.type = "button";
      link.className = "info-link-btn";
      link.textContent = "capturar";
      link.onclick = async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const data = await askPaymentDetails({
          title: `${label}: ${fmtMoney(v)}`,
          defaultForm: client[formField] || "",
          defaultDate: client[dateField] || "",
        });
        if (!data) return;
        const { error } = await sb.from("clients")
          .update({ [formField]: data.form, [dateField]: data.date })
          .eq("id", client.id);
        if (error) { toast(error.message, "error"); return; }
        client[formField] = data.form;
        client[dateField] = data.date;
        paint();
        onChange();
        toast("Guardado.", "success", 1500);
      };
      sub.append(txt, link);
    }
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

    if (cleaned == null || cleaned === 0) {
      // Limpia monto + forma + fecha asociados.
      saving = true;
      const { error } = await sb.from("clients")
        .update({ [field]: null, [formField]: null, [dateField]: null })
        .eq("id", client.id);
      saving = false;
      if (error) { toast(error.message, "error"); paint(); return; }
      client[field] = null;
      client[formField] = null;
      client[dateField] = null;
      paint();
      onChange();
      return;
    }

    // Pide fecha y forma con un mini-modal.
    const data = await askPaymentDetails({
      title: `${label.replace(" (opc)", "")}: ${fmtMoney(cleaned)}`,
      defaultForm: client[formField] || "",
      defaultDate: client[dateField] || "",
    });
    if (!data) {
      paint(); // canceló: revertir display
      return;
    }

    saving = true;
    const { error } = await sb.from("clients")
      .update({ [field]: cleaned, [formField]: data.form, [dateField]: data.date })
      .eq("id", client.id);
    saving = false;
    if (error) { toast(error.message, "error"); paint(); return; }
    client[field] = cleaned;
    client[formField] = data.form;
    client[dateField] = data.date;
    paint();
    onChange();
    toast("Guardado.", "success", 1500);
  });

  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); input.blur(); }
    if (ev.key === "Escape") { paint(); input.blur(); }
  });

  wrap.append(span, input, sub);
  return wrap;
}

// Select de estatus del cliente. Reemplaza al toggle binario "Activo".
// Persiste en clients.status. Vacío = el badge se deriva del conciliado vs
// monto (el option vacío muestra esa etiqueta derivada en lugar de "Auto").
const STATUS_OPTIONS = ["Pendiente", "Parcial", "Activo", "Conciliado", "Cancelado", "Duplicado", "Revisar", "Corregir"];
// El vendedor puede aplicar manualmente Activo, Cancelado o Duplicado. Los
// demás (Pendiente / Parcial / Conciliado) salen del derivado automático de
// conciliado vs monto, así no se le da al asesor la opción de marcar como
// conciliado algo que no lo está. El master sí puede usar todos.
const VENDOR_STATUS_OPTIONS = ["Activo", "Cancelado", "Duplicado"];
// Status que el vendedor NO puede cambiar (los pone solo el master). Si el
// cliente actual ya tiene uno de estos, su select queda deshabilitado.
// Conciliado también está bloqueado: una vez que el master cierra el cliente,
// el vendor no debe poder reabrirlo cambiando el status.
const VENDOR_LOCKED_STATUSES = new Set(["Conciliado", "Revisar", "Corregir"]);

// Notas dentro del modal del cliente. Ocupa el ancho completo del grid.
// Persiste al perder foco (igual que el editor de la tabla del vendor).
function notesEditorBlock(client) {
  const wrap = document.createElement("label");
  wrap.className = "info-field info-field-full";
  const span = document.createElement("span");
  span.className = "info-label";
  span.textContent = "Notas";
  const ta = document.createElement("textarea");
  ta.className = "modal-notes-editor";
  ta.placeholder = "Notas del cliente…";
  ta.rows = 2;
  ta.value = client.notes || "";

  let saving = false;
  ta.addEventListener("blur", async () => {
    if (saving) return;
    const next = ta.value.trim() || null;
    if ((client.notes ?? null) === (next ?? null)) return;
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

  wrap.append(span, ta);
  return wrap;
}

// Campo "Heredado de": indica al vendor actual de qué vendedor original le
// transfirieron el cliente. Editable solo por master; el vendor lo ve en
// solo-lectura. El master lo llena vía el backfill por CSV o a mano aquí.
function inheritedFromBlock(client) {
  const profile = getProfile();
  const isMaster = profile?.role === "master";
  const wrap = document.createElement("label");
  wrap.className = "info-field";
  const span = document.createElement("span");
  span.className = "info-label";
  span.textContent = "Heredado de";

  if (!isMaster) {
    const ro = document.createElement("div");
    ro.className = "info-readonly";
    ro.textContent = client.inherited_from || "— (propio)";
    if (!client.inherited_from) ro.classList.add("muted");
    wrap.append(span, ro);
    return wrap;
  }

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Vendedor original (opcional)";
  input.value = client.inherited_from || "";

  let saving = false;
  input.addEventListener("blur", async () => {
    if (saving) return;
    const next = input.value.trim() || null;
    if ((client.inherited_from ?? null) === (next ?? null)) return;
    saving = true;
    const { error } = await sb.from("clients").update({ inherited_from: next }).eq("id", client.id);
    saving = false;
    if (error) { toast(error.message, "error"); input.value = client.inherited_from || ""; return; }
    client.inherited_from = next;
    toast(next ? `Heredado de: ${next}` : "Origen limpiado", "success", 1500);
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); input.blur(); }
    if (ev.key === "Escape") { input.value = client.inherited_from || ""; input.blur(); }
  });

  wrap.append(span, input);
  return wrap;
}

// Checkbox: ¿el cliente ya tiene medidor bidireccional instalado? Es un dato
// que necesita el equipo de operaciones; se persiste en clients.medidor_bidi.
function bidiCheckbox(client) {
  const wrap = document.createElement("label");
  wrap.className = "info-field info-field-check";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = !!client.medidor_bidi;
  const span = document.createElement("span");
  span.className = "info-label";
  span.textContent = "Medidor bidireccional instalado";

  let saving = false;
  cb.addEventListener("change", async () => {
    if (saving) return;
    saving = true;
    const next = cb.checked;
    const { error } = await sb.from("clients").update({ medidor_bidi: next }).eq("id", client.id);
    saving = false;
    if (error) { toast(error.message, "error"); cb.checked = !!client.medidor_bidi; return; }
    client.medidor_bidi = next;
    toast(next ? "Medidor bidireccional: sí" : "Medidor bidireccional: no", "success", 1500);
  });

  wrap.append(cb, span);
  return wrap;
}

function statusPicker(client, derivedLabel = "Pendiente") {
  const profile = getProfile();
  const isVendor = profile?.role === "vendor";
  const allowed = isVendor ? VENDOR_STATUS_OPTIONS : STATUS_OPTIONS;

  const wrap = document.createElement("div");
  wrap.className = "info-field";

  const span = document.createElement("span");
  span.textContent = "Estatus";
  span.className = "info-label";

  const select = document.createElement("select");
  // La opción vacía representa "sin override manual": el badge se calcula
  // automáticamente según monto vs conciliado. La etiqueta muestra el estado
  // derivado (Pendiente / Parcial / Conciliado) en lugar de un genérico "Auto"
  // para que el asesor vea exactamente cómo está clasificado el cliente.
  select.appendChild(opt("", derivedLabel));
  for (const s of allowed) {
    if (s === derivedLabel) continue; // ya está como "auto"
    select.appendChild(opt(s, s));
  }
  // Si el status actual fue puesto por master fuera del catálogo del vendor,
  // lo mostramos para que se vea (etiquetado) y no se pierda al cambiar.
  if (client.status && !allowed.includes(client.status)) {
    select.appendChild(opt(client.status, `${client.status} (master)`));
  }
  select.value = client.status || "";

  // Status bloqueados (Revisar / Corregir): el vendor no puede modificarlos;
  // solo el master los quita o cambia.
  if (isVendor && VENDOR_LOCKED_STATUSES.has(client.status)) {
    select.disabled = true;
    select.title = "Este status solo lo puede cambiar el master.";
    wrap.classList.add("field-locked");
  }

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

function formatDate(d) {
  if (!d) return "";
  const dt = new Date(d + "T00:00:00");
  if (isNaN(dt)) return d;
  return dt.toLocaleDateString("es-MX");
}

// Mini-modal: pide forma de pago y fecha. Usado cuando el asesor captura
// enganche o anticipo. Resuelve a {form, date} o null si canceló.
function askPaymentDetails({ title, defaultForm = "", defaultDate = "" }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";

    const modal = document.createElement("div");
    modal.className = "modal";

    const h = document.createElement("h2");
    h.textContent = title;
    modal.appendChild(h);

    const note = document.createElement("p");
    note.className = "muted";
    note.style.margin = "0";
    note.textContent = "Captura la fecha y forma de pago.";
    modal.appendChild(note);

    const form = document.createElement("form");
    form.className = "stacked-form";

    const formLabel = document.createElement("label");
    formLabel.textContent = "Forma de pago";
    const formSelect = document.createElement("select");
    formSelect.required = true;
    formSelect.appendChild(opt("", "—"));
    for (const f of PAYMENT_FORMS) formSelect.appendChild(opt(f, f));
    formSelect.value = defaultForm;
    formLabel.appendChild(formSelect);
    form.appendChild(formLabel);

    const dateLabel = document.createElement("label");
    dateLabel.textContent = "Fecha de pago";
    const dateInput = document.createElement("input");
    dateInput.type = "date";
    dateInput.required = true;
    dateInput.value = defaultDate;
    dateLabel.appendChild(dateInput);
    form.appendChild(dateLabel);

    const actions = document.createElement("div");
    actions.className = "actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "ghost";
    cancel.textContent = "Cancelar";
    cancel.onclick = () => { backdrop.remove(); resolve(null); };
    const save = document.createElement("button");
    save.type = "submit";
    save.textContent = "Guardar";
    actions.append(cancel, save);
    form.appendChild(actions);
    modal.appendChild(form);

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    setTimeout(() => formSelect.focus(), 0);

    form.onsubmit = (ev) => {
      ev.preventDefault();
      if (!formSelect.value || !dateInput.value) return;
      backdrop.remove();
      resolve({ form: formSelect.value, date: dateInput.value });
    };
    backdrop.addEventListener("click", (ev) => {
      if (ev.target === backdrop) { backdrop.remove(); resolve(null); }
    });
  });
}

// Pide confirmación al asesor cuando intenta agregar fila sin enganche/
// anticipo/método capturados. Resuelve a true (proceder) o false (cancelar).
// Si el cliente declara "No lleva" enganche/anticipo, los marcamos en la BD
// con string "N/A" en el form para que el UI los pinte como deshabilitado.
function askMissingDataConfirmation(client) {
  return new Promise((resolve) => {
    const missing = [];
    if (!client.payment_method) missing.push("método");
    if (!client.enganche && client[`enganche_form`] !== "N/A") missing.push("enganche");
    if (!client.anticipo && client[`anticipo_form`] !== "N/A") missing.push("anticipo");
    if (missing.length === 0) { resolve({ proceed: true }); return; }

    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const modal = document.createElement("div");
    modal.className = "modal";

    const h = document.createElement("h2");
    h.textContent = "Recordatorio";
    modal.appendChild(h);

    const p = document.createElement("p");
    p.style.margin = "0";
    p.innerHTML = `Aún no capturaste: <strong>${missing.join(", ")}</strong>.
                   Esa información es importante antes de empezar a registrar pagos.
                   ¿El cliente sí los lleva?`;
    modal.appendChild(p);

    const actions = document.createElement("div");
    actions.className = "actions";
    const noLleva = document.createElement("button");
    noLleva.type = "button";
    noLleva.className = "ghost";
    noLleva.textContent = "No lleva — marcar N/A";
    noLleva.onclick = () => { backdrop.remove(); resolve({ proceed: true, markNA: missing }); };
    const siLleva = document.createElement("button");
    siLleva.type = "button";
    siLleva.textContent = "Sí lleva — capturar primero";
    siLleva.onclick = () => { backdrop.remove(); resolve({ proceed: false }); };
    actions.append(noLleva, siLleva);
    modal.appendChild(actions);

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    backdrop.addEventListener("click", (ev) => {
      if (ev.target === backdrop) { backdrop.remove(); resolve({ proceed: false }); }
    });
  });
}

function opt(value, label) {
  const o = document.createElement("option");
  o.value = value; o.textContent = label; return o;
}
