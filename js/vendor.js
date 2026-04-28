// Vista vendedor: una tabla con sus clientes y captura inline.

import { sb } from "./supabase.js";
import { clear, toast, fmtMoney } from "./ui.js";
import { getProfile } from "./auth.js";

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
  paintTable(tableWrap, clients, reports, profile);
}

function headerNode(profile) {
  const h = document.createElement("h1");
  h.textContent = `Mis clientes — ${profile.full_name || profile.email}`;
  return h;
}

async function loadData() {
  const [clientsRes, reportsRes] = await Promise.all([
    sb.from("clients").select("id, name, zone, payment_month, payment_method, amount").order("name"),
    sb.from("payments_report").select("client_id, months_paid, total_amount, updated_at"),
  ]);

  if (clientsRes.error) { toast(clientsRes.error.message, "error"); throw clientsRes.error; }
  if (reportsRes.error) { toast(reportsRes.error.message, "error"); throw reportsRes.error; }

  return { clients: clientsRes.data || [], reports: reportsRes.data || [] };
}

function paintSummary(container, clients, reports) {
  const reportedIds = new Set(reports.map((r) => r.client_id));
  const reportedCount = clients.filter((c) => reportedIds.has(c.id)).length;
  const total = clients.length;
  const totalAmount = reports.reduce((s, r) => s + Number(r.total_amount || 0), 0);

  clear(container);
  container.append(
    stat("Asignados", total),
    stat("Reportados", `${reportedCount} / ${total}`),
    stat("Pendientes", total - reportedCount),
    stat("Monto total reportado", fmtMoney(totalAmount)),
  );
}

function stat(label, value) {
  const el = document.createElement("div");
  el.className = "stat";
  const l = document.createElement("div"); l.className = "label"; l.textContent = label;
  const v = document.createElement("div"); v.className = "value"; v.textContent = value;
  el.append(l, v);
  return el;
}

function paintTable(container, clients, reports, profile) {
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
      <th># Mensualidades</th>
      <th>Monto total</th>
      <th>Estado</th>
    </tr>`;
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const c of clients) {
    const r = reportByClient.get(c.id);
    tbody.appendChild(rowFor(c, r, profile));
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

function rowFor(client, report, profile) {
  const tr = document.createElement("tr");

  const tdName   = document.createElement("td");
  const nameLink = document.createElement("a");
  nameLink.href = "#";
  nameLink.textContent = client.name;
  nameLink.className = "row-link";
  nameLink.onclick = (ev) => { ev.preventDefault(); openClientDetail(client, report); };
  tdName.appendChild(nameLink);

  const tdMonth  = document.createElement("td"); tdMonth.textContent  = client.payment_month  || "—";
  const tdZone   = document.createElement("td"); tdZone.textContent   = client.zone           || "—";
  const tdMethod = document.createElement("td"); tdMethod.textContent = client.payment_method || "—";
  const tdContractAmount = document.createElement("td");
  tdContractAmount.textContent = client.amount != null ? fmtMoney(client.amount) : "—";

  const monthsInput = document.createElement("input");
  monthsInput.type = "number"; monthsInput.min = "0"; monthsInput.step = "1";
  monthsInput.value = report?.months_paid ?? "";

  const amountInput = document.createElement("input");
  amountInput.type = "number"; amountInput.min = "0"; amountInput.step = "0.01";
  amountInput.value = report?.total_amount ?? "";

  const tdMonths = document.createElement("td"); tdMonths.appendChild(monthsInput);
  const tdAmount = document.createElement("td"); tdAmount.appendChild(amountInput);

  const tdStatus = document.createElement("td");
  const badge = document.createElement("span");
  tdStatus.appendChild(badge);
  paintStatus(badge, report);

  const save = async () => {
    const months = monthsInput.value === "" ? null : Number(monthsInput.value);
    const amount = amountInput.value === "" ? null : Number(amountInput.value);
    if (months == null && amount == null) return; // nada que guardar

    const { error } = await sb.from("payments_report").upsert({
      client_id: client.id,
      vendor_id: profile.id,
      months_paid: months,
      total_amount: amount,
    }, { onConflict: "client_id" });

    if (error) { toast(error.message, "error"); return; }
    toast("Guardado", "success", 1500);
    paintStatus(badge, { months_paid: months, total_amount: amount });
  };

  for (const inp of [monthsInput, amountInput]) {
    inp.addEventListener("blur", save);
    inp.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); inp.blur(); }
    });
  }

  tr.append(tdName, tdMonth, tdZone, tdMethod, tdContractAmount, tdMonths, tdAmount, tdStatus);
  return tr;
}

function paintStatus(el, report) {
  const reported = report && (report.months_paid != null || report.total_amount != null);
  el.className = "badge " + (reported ? "ok" : "pending");
  el.textContent = reported ? "Reportado" : "Pendiente";
}

// Construye el calendario de pagos esperado segun el metodo del cliente.
// Devuelve { schedule, total, paid, due }.
//   schedule: [{label, amount, paidAmount, status}]
//   status: "pagado" | "parcial" | "pendiente"
function buildSchedule(client, report) {
  const total  = Number(client.amount || 0);
  const paid   = Math.max(0, Number(report?.total_amount || 0));
  const method = client.payment_method || "";

  const schedule = [];

  const pushItem = (label, amount, alreadyPaid) => {
    const eff = Math.min(Math.max(0, alreadyPaid), amount);
    let status = "pendiente";
    if (eff >= amount && amount > 0) status = "pagado";
    else if (eff > 0) status = "parcial";
    schedule.push({ label, amount, paidAmount: eff, status });
  };

  if (method.startsWith("Contado Parcial-")) {
    const enganche    = +(total * 0.5).toFixed(2);
    const mensualidad = +(total - enganche).toFixed(2);

    let remaining = paid;
    const engPaid = Math.min(remaining, enganche);
    remaining -= engPaid;
    const mensPaid = Math.min(remaining, mensualidad);

    pushItem("Enganche (50%)", enganche, engPaid);
    pushItem("Mensualidad final", mensualidad, mensPaid);
  } else if (/^\d+ Meses Sin Intereses$/.test(method) || /\b\d+ MSI$/.test(method)) {
    const m = method.match(/^(\d+) Meses/) || method.match(/(\d+) MSI/);
    const n = m ? parseInt(m[1], 10) : 12;
    const mensualidad = +(total / n).toFixed(2);

    let remaining = paid;
    for (let i = 1; i <= n; i++) {
      const pay = Math.min(remaining, mensualidad);
      remaining -= pay;
      pushItem(`Mensualidad ${i} de ${n}`, mensualidad, pay);
    }
  } else if (method === "Financiamiento" || method.startsWith("Anticipo Mejoravit")) {
    pushItem("Plan personalizado", total, paid);
  } else {
    pushItem(method || "Pago único", total, paid);
  }

  return { schedule, total, paid, due: Math.max(0, total - paid) };
}

function openClientDetail(client, report) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";

  const modal = document.createElement("div");
  modal.className = "modal detail-modal";

  const h = document.createElement("h2");
  h.textContent = client.name;
  modal.appendChild(h);

  const meta = document.createElement("div");
  meta.className = "detail-meta";
  meta.innerHTML = `
    <div><span class="muted">Zona</span><strong>${escapeHtml(client.zone || "—")}</strong></div>
    <div><span class="muted">Mes</span><strong>${escapeHtml(client.payment_month || "—")}</strong></div>
    <div><span class="muted">Método</span><strong>${escapeHtml(client.payment_method || "—")}</strong></div>
  `;
  modal.appendChild(meta);

  const { schedule, total, paid, due } = buildSchedule(client, report);

  const summary = document.createElement("div");
  summary.className = "summary";
  summary.append(
    stat("Total contratado", fmtMoney(total)),
    stat("Pagado a la fecha", fmtMoney(paid)),
    stat("Adeudo", fmtMoney(due)),
  );
  modal.appendChild(summary);

  const wrap = document.createElement("div");
  wrap.className = "table-wrap detail-schedule";
  const table = document.createElement("table");
  table.innerHTML = `
    <thead><tr>
      <th>Concepto</th><th>Monto</th><th>Pagado</th><th>Pendiente</th><th>Estado</th>
    </tr></thead>`;
  const tbody = document.createElement("tbody");
  for (const item of schedule) {
    const pending = Math.max(0, item.amount - item.paidAmount);
    const tr = document.createElement("tr");
    const badgeClass = item.status === "pagado" ? "ok" : item.status === "parcial" ? "partial" : "pending";
    const badgeText  = item.status === "pagado" ? "Pagado" : item.status === "parcial" ? "Parcial" : "Pendiente";
    tr.innerHTML = `
      <td>${escapeHtml(item.label)}</td>
      <td>${fmtMoney(item.amount)}</td>
      <td>${fmtMoney(item.paidAmount)}</td>
      <td>${fmtMoney(pending)}</td>
      <td><span class="badge ${badgeClass}">${badgeText}</span></td>`;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  modal.appendChild(wrap);

  const actions = document.createElement("div");
  actions.className = "actions";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Cerrar";
  close.onclick = () => backdrop.remove();
  actions.appendChild(close);
  modal.appendChild(actions);

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  backdrop.addEventListener("click", (ev) => {
    if (ev.target === backdrop) backdrop.remove();
  });
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
