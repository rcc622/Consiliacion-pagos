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

  const tdName   = document.createElement("td"); tdName.textContent   = client.name;
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
