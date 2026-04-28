// Vista master: dashboard de progreso por vendedor / zona + import + alta manual.

import { sb } from "./supabase.js";
import { clear, toast, openModal, confirmDialog, fmtMoney } from "./ui.js";
import { parseFile, importRows } from "./import.js";

export async function renderMaster() {
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

  const spacer = document.createElement("div");
  spacer.className = "spacer";

  const wipeBtn = document.createElement("button");
  wipeBtn.className = "danger";
  wipeBtn.textContent = "Vaciar lista";
  wipeBtn.onclick = () => bulkDeleteFlow(refresh);

  bar.append(importBtn, addBtn, spacer, wipeBtn);
  return bar;
}

async function loadAll() {
  const [vendorsRes, clientsRes, reportsRes] = await Promise.all([
    sb.from("profiles").select("id, email, full_name, zone, role").eq("role", "vendor"),
    sb.from("clients").select("id, name, zone, vendor_id, payment_month, payment_method, amount"),
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

  const table = document.createElement("table");
  table.innerHTML = `
    <thead><tr>
      <th>Cliente</th><th>Mes</th><th>Zona</th><th>Vendedor</th>
      <th>Método de pago</th><th>Monto</th>
      <th># Mens. reportadas</th><th>Monto reportado</th><th>Estado</th>
      <th></th>
    </tr></thead>`;
  const tbody = document.createElement("tbody");
  for (const c of clients) {
    const v = vendorById.get(c.vendor_id);
    const r = reportByClient.get(c.id);
    const reported = r && (r.months_paid != null || r.total_amount != null);
    const tr = document.createElement("tr");

    const fixedHtml = `
      <td>${escapeHtml(c.name)}</td>
      <td>${escapeHtml(c.payment_month || "—")}</td>
      <td>${escapeHtml(c.zone || "—")}</td>
      <td>${escapeHtml(v ? (v.full_name || v.email) : "—")}</td>
      <td>${escapeHtml(c.payment_method || "—")}</td>
      <td>${c.amount != null ? fmtMoney(c.amount) : "—"}</td>
      <td>${r?.months_paid ?? "—"}</td>
      <td>${r?.total_amount != null ? fmtMoney(r.total_amount) : "—"}</td>
      <td><span class="badge ${reported ? "ok" : "pending"}">${reported ? "Reportado" : "Pendiente"}</span></td>`;
    tr.innerHTML = fixedHtml;

    const tdActions = document.createElement("td");
    const delBtn = document.createElement("button");
    delBtn.className = "icon-danger";
    delBtn.textContent = "Eliminar";
    delBtn.onclick = () => deleteClientFlow(c, refresh);
    tdActions.appendChild(delBtn);
    tr.appendChild(tdActions);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
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

function triggerImport(refresh) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".csv,.xlsx,.xls";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const rows = await parseFile(file);
      if (!rows.length) { toast("El archivo no tiene filas válidas.", "error"); return; }
      const { inserted, errors } = await importRows(rows);
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
  };
  input.click();
}

async function addClientFlow(refresh) {
  const { data: vendors, error } = await sb
    .from("profiles")
    .select("id, email, full_name")
    .eq("role", "vendor")
    .order("email");
  if (error) { toast(error.message, "error"); return; }
  if (!vendors?.length) { toast("No hay vendedores registrados.", "error"); return; }

  const months = [
    "Enero","Febrero","Marzo","Abril","Mayo","Junio",
    "Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre",
  ];
  const methods = ["Efectivo","Transferencia","Cheque","Depósito"];

  const data = await openModal({
    title: "Agregar cliente",
    submitLabel: "Crear",
    fields: [
      { name: "name", label: "Nombre del cliente", type: "text", required: true },
      {
        name: "payment_month", label: "Mes", type: "select",
        options: [{ value: "", label: "—" }, ...months.map((m) => ({ value: m, label: m }))],
      },
      { name: "zone", label: "Zona", type: "text" },
      {
        name: "vendor_id", label: "Vendedor", type: "select",
        options: vendors.map((v) => ({ value: v.id, label: v.full_name || v.email })),
      },
      {
        name: "payment_method", label: "Método de pago", type: "select",
        options: [{ value: "", label: "—" }, ...methods.map((m) => ({ value: m, label: m }))],
      },
      { name: "amount", label: "Monto ($)", type: "number" },
    ],
  });
  if (!data) return;

  const { error: insErr } = await sb.from("clients").insert({
    name: data.name,
    zone: data.zone || null,
    vendor_id: data.vendor_id,
    payment_month:  data.payment_month  || null,
    payment_method: data.payment_method || null,
    amount: data.amount === "" ? null : Number(data.amount),
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
