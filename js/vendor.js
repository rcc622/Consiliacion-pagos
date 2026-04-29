// Vista vendedor: tabla resumen de sus clientes + modal con detalle por mensualidad.

import { sb } from "./supabase.js";
import { clear, toast, fmtMoney } from "./ui.js";
import { getProfile } from "./auth.js";

const PAYMENT_FORMS = ["Efectivo", "Transferencia", "Link de pago"];

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
    sb.from("clients").select("id, name, zone, payment_month, payment_method, amount, enganche, anticipo").order("name"),
    sb.from("payments_report").select("client_id, months_paid, total_amount, installments, updated_at"),
  ]);

  if (clientsRes.error) { toast(clientsRes.error.message, "error"); throw clientsRes.error; }
  if (reportsRes.error) { toast(reportsRes.error.message, "error"); throw reportsRes.error; }

  return { clients: clientsRes.data || [], reports: reportsRes.data || [] };
}

function paintSummary(container, clients, reports) {
  const reportedIds = new Set(reports.filter(isReportedAtAll).map((r) => r.client_id));
  const reportedCount = clients.filter((c) => reportedIds.has(c.id)).length;
  const total = clients.length;
  const totalAmount = reports.reduce((s, r) => s + Number(r.total_amount || 0), 0);

  clear(container);
  container.append(
    stat("Asignados", total),
    stat("Con captura", `${reportedCount} / ${total}`),
    stat("Pendientes", total - reportedCount),
    stat("Monto cobrado", fmtMoney(totalAmount)),
  );
}

function isReportedAtAll(r) {
  return r && (r.months_paid > 0 || Number(r.total_amount) > 0);
}

function stat(label, value) {
  const el = document.createElement("div");
  el.className = "stat";
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
      <th>Mes</th>
      <th>Zona</th>
      <th>Método de pago</th>
      <th>Monto</th>
      <th>Pagadas / Total</th>
      <th>Cobrado</th>
      <th>Estado</th>
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

  const tdMonth   = document.createElement("td"); tdMonth.textContent   = client.payment_month  || "—";
  const tdZone    = document.createElement("td"); tdZone.textContent    = client.zone           || "—";
  const tdMethod  = document.createElement("td"); tdMethod.textContent  = client.payment_method || "—";
  const tdAmount  = document.createElement("td"); tdAmount.textContent  = client.amount != null ? fmtMoney(client.amount) : "—";

  const expected = expectedInstallmentCount(client);
  const paid = Number(report?.months_paid || 0);
  const tdProgress = document.createElement("td");
  tdProgress.textContent = expected ? `${paid} / ${expected}` : "—";

  const tdCobrado = document.createElement("td");
  tdCobrado.textContent = report?.total_amount != null ? fmtMoney(report.total_amount) : fmtMoney(0);

  const tdStatus = document.createElement("td");
  const badge = document.createElement("span");
  paintRowStatus(badge, paid, expected);
  tdStatus.appendChild(badge);

  tr.append(tdName, tdMonth, tdZone, tdMethod, tdAmount, tdProgress, tdCobrado, tdStatus);
  return tr;
}

function paintRowStatus(el, paid, expected) {
  if (!expected) { el.className = "badge pending"; el.textContent = "—"; return; }
  if (paid >= expected) { el.className = "badge ok"; el.textContent = "Completo"; return; }
  if (paid > 0) { el.className = "badge partial"; el.textContent = "Parcial"; return; }
  el.className = "badge pending"; el.textContent = "Pendiente";
}

// === Schedule por método ====================================================

// Devuelve [{n, label, expected_amount}] segun el metodo del cliente.
// Si el cliente tiene enganche o anticipo, se descuentan del total antes de
// calcular las mensualidades y se agregan como filas propias del schedule.
function buildSchedule(client) {
  const total    = Number(client.amount   || 0);
  const enganche = Number(client.enganche || 0);
  const anticipo = Number(client.anticipo || 0);
  const method   = client.payment_method || "";

  if (method.startsWith("Contado Parcial-")) {
    if (enganche > 0 || anticipo > 0) {
      const out = [];
      if (enganche > 0) out.push({ n: 0,  label: "Enganche", expected_amount: enganche });
      if (anticipo > 0) out.push({ n: -2, label: "Anticipo", expected_amount: anticipo });
      out.push({ n: 1, label: "Mensualidad final", expected_amount: +(total - enganche - anticipo).toFixed(2) });
      return out;
    }
    const eng = +(total * 0.5).toFixed(2);
    return [
      { n: 0, label: "Enganche (50%)",    expected_amount: eng },
      { n: 1, label: "Mensualidad final", expected_amount: +(total - eng).toFixed(2) },
    ];
  }

  const msi = method.match(/^(\d+) Meses Sin Intereses$/) || method.match(/(\d+) MSI$/);
  if (msi) {
    const n = parseInt(msi[1], 10);
    const mensualidad = +((total - enganche - anticipo) / n).toFixed(2);
    const out = [];
    if (enganche > 0) out.push({ n: -1, label: "Enganche", expected_amount: enganche });
    if (anticipo > 0) out.push({ n: -2, label: "Anticipo", expected_amount: anticipo });
    for (let i = 1; i <= n; i++) {
      out.push({ n: i, label: `Mensualidad ${i} de ${n}`, expected_amount: mensualidad });
    }
    return out;
  }

  // Anticipo Mejoravit / Financiamiento / fallback
  if (enganche === 0 && anticipo === 0) {
    return [{ n: 1, label: "Plan personalizado", expected_amount: total }];
  }
  const out = [];
  if (enganche > 0) out.push({ n: -1, label: "Enganche", expected_amount: enganche });
  if (anticipo > 0) out.push({ n: -2, label: "Anticipo", expected_amount: anticipo });
  out.push({ n: 1, label: "Restante", expected_amount: +(total - enganche - anticipo).toFixed(2) });
  return out;
}

function expectedInstallmentCount(client) {
  return buildSchedule(client).length;
}

// Importe diferido por mes para el método del cliente. Devuelve null si el
// método no es a meses (no hay base para un "diferido").
function deferredMonthly(client) {
  const method = client.payment_method || "";
  const msi = method.match(/^(\d+) Meses Sin Intereses$/) || method.match(/(\d+) MSI$/);
  if (!msi) return null;
  const n = parseInt(msi[1], 10);
  if (!n) return null;
  const total    = Number(client.amount   || 0);
  const enganche = Number(client.enganche || 0);
  const anticipo = Number(client.anticipo || 0);
  return +((total - enganche - anticipo) / n).toFixed(2);
}

function fmtMoneyOrNA(n) {
  const v = Number(n || 0);
  return v ? fmtMoney(v) : "N/A";
}

// === Modal de detalle =======================================================

function openClientDetail(client, report, profile, refresh) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";

  const modal = document.createElement("div");
  modal.className = "modal detail-modal";

  // Header con info del cliente
  const h = document.createElement("h2");
  h.textContent = client.name;
  modal.appendChild(h);

  const meta = document.createElement("div");
  meta.className = "detail-meta";
  const diferido = deferredMonthly(client);
  meta.innerHTML = `
    <div><span class="muted">Zona</span><strong>${escapeHtml(client.zone || "—")}</strong></div>
    <div><span class="muted">Mes</span><strong>${escapeHtml(client.payment_month || "—")}</strong></div>
    <div><span class="muted">Método</span><strong>${escapeHtml(client.payment_method || "—")}</strong></div>
    <div><span class="muted">Total</span><strong>${client.amount != null ? fmtMoney(client.amount) : "—"}</strong></div>
    <div><span class="muted">Enganche</span><strong>${fmtMoneyOrNA(client.enganche)}</strong></div>
    <div><span class="muted">Anticipo</span><strong>${fmtMoneyOrNA(client.anticipo)}</strong></div>
    <div><span class="muted">Restante diferido</span><strong>${diferido == null ? "N/A" : `${fmtMoney(diferido)} / mes`}</strong></div>
  `;
  modal.appendChild(meta);

  // Stats (se actualizan en cada cambio)
  const summary = document.createElement("div");
  summary.className = "summary";
  modal.appendChild(summary);

  // Tabla de mensualidades
  const wrap = document.createElement("div");
  wrap.className = "table-wrap detail-schedule";
  const table = document.createElement("table");
  table.innerHTML = `
    <thead><tr>
      <th>Mensualidad</th>
      <th>Monto</th>
      <th>Forma de pago</th>
      <th>Fecha de pago</th>
      <th>Status</th>
    </tr></thead>`;
  const tbody = document.createElement("tbody");
  table.appendChild(tbody);
  wrap.appendChild(table);

  // Barra de paginacion (solo se muestra si hay >5 mensualidades)
  const pagBar = document.createElement("div");
  pagBar.className = "pagination-bar";
  modal.appendChild(pagBar);
  modal.appendChild(wrap);

  // Estado en memoria de las mensualidades
  const schedule = buildSchedule(client);
  const saved = indexInstallments(report?.installments);
  const rows = schedule.map((item) => ({
    n: item.n,
    label: item.label,
    expected: item.expected_amount,
    amount: saved.get(item.n)?.amount ?? null,
    form:   saved.get(item.n)?.form   ?? "",
    date:   saved.get(item.n)?.date   ?? "",
  }));

  function refreshSummary() {
    const paidRows = rows.filter(isPaidRow);
    const monthsPaid = paidRows.length;
    const totalPaid = paidRows.reduce((s, r) => s + Number(r.amount || 0), 0);
    const totalContract = Number(client.amount || 0);
    clear(summary);
    summary.append(
      stat("Total contratado", fmtMoney(totalContract)),
      stat("Pagado a la fecha", fmtMoney(totalPaid)),
      stat("Adeudo", fmtMoney(Math.max(0, totalContract - totalPaid))),
      stat("Mensualidades", `${monthsPaid} / ${rows.length}`),
    );
  }

  async function persist() {
    const installments = rows
      .filter(isPaidRow)
      .map((r) => ({ n: r.n, amount: Number(r.amount), form: r.form, date: r.date }));
    const monthsPaid = installments.length;
    const totalPaid = installments.reduce((s, r) => s + Number(r.amount || 0), 0);

    return sb.from("payments_report").upsert({
      client_id: client.id,
      vendor_id: profile.id,
      months_paid: monthsPaid,
      total_amount: totalPaid,
      installments,
    }, { onConflict: "client_id" });
  }

  // === Paginacion ============================================================
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
    prev.type = "button";
    prev.className = "ghost";
    prev.textContent = "‹";
    prev.disabled = currentPage <= 1;
    prev.onclick = () => { currentPage--; renderPage(); };

    const info = document.createElement("span");
    info.className = "muted page-info";
    info.textContent = `Página ${currentPage} de ${totalPages()}`;

    const next = document.createElement("button");
    next.type = "button";
    next.className = "ghost";
    next.textContent = "›";
    next.disabled = currentPage >= totalPages();
    next.onclick = () => { currentPage++; renderPage(); };

    pagBar.append(prev, info, next);
  }

  function renderPage() {
    if (currentPage > totalPages()) currentPage = totalPages();
    if (currentPage < 1) currentPage = 1;

    const start = pageSize === Infinity ? 0 : (currentPage - 1) * pageSize;
    const end   = pageSize === Infinity ? rows.length : start + pageSize;

    clear(tbody);
    for (const r of rows.slice(start, end)) {
      tbody.appendChild(buildScheduleRow(r, refreshSummary, persist));
    }
    paintPagination();
  }

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

function indexInstallments(arr) {
  const m = new Map();
  if (Array.isArray(arr)) {
    for (const it of arr) {
      if (it && typeof it.n === "number") m.set(it.n, it);
    }
  }
  return m;
}

function isPaidRow(r) {
  return !!(r.form && r.date && r.amount != null && r.amount !== "");
}

function buildScheduleRow(r, refreshSummary, persist) {
  const tr = document.createElement("tr");

  const tdLabel = document.createElement("td");
  tdLabel.textContent = r.label;

  // Monto: input texto que muestra "$15,000.00" en blur y el numero crudo
  // en focus (para editar). Mantiene inputMode=decimal para teclado numerico.
  const tdAmount = document.createElement("td");
  const amountInput = document.createElement("input");
  amountInput.type = "text";
  amountInput.inputMode = "decimal";
  amountInput.placeholder = fmtMoney(r.expected);
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

  function paintAmount() {
    if (r.amount != null && r.amount !== "") amountInput.value = fmtMoney(Number(r.amount));
    else amountInput.value = "";
  }

  function paintBadge() {
    if (isPaidRow(r)) { badge.className = "badge ok"; badge.textContent = "Pagado"; }
    else if ((r.amount != null && r.amount !== "") || r.form || r.date) {
      badge.className = "badge partial"; badge.textContent = "Incompleto";
    } else {
      badge.className = "badge pending"; badge.textContent = "Pendiente";
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
    // Parsear el monto del display (puede traer "$" y comas)
    const raw = amountInput.value.replace(/[^\d.\-]/g, "");
    r.amount = raw === "" ? null : Number(raw);
    if (!Number.isFinite(r.amount)) r.amount = null;
    r.form = formSelect.value;
    r.date = dateInput.value;

    // Si llena forma+fecha pero el monto sigue vacio, asume el esperado.
    if (r.form && r.date && (r.amount == null)) {
      r.amount = r.expected;
    }

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

  tr.append(tdLabel, tdAmount, tdForm, tdDate, tdStatus);
  return tr;
}

function opt(value, label) {
  const o = document.createElement("option");
  o.value = value; o.textContent = label; return o;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
