// Exporta la conciliación completa agrupada por zona.
//
// XLSX: una hoja por zona.
// CSV : un solo archivo con BOM UTF-8 y secciones por zona.

import { sb } from "./supabase.js";
import { toast } from "./ui.js";

const COLUMNS = [
  "Cliente",
  "Vendedor",
  "Método de pago",
  "Monto contratado",
  "Conciliado",
  "Pte conciliar",
  "Estado",
  "Activo",
  "Notas",
];

async function fetchData() {
  const [vendorsRes, clientsRes, reportsRes] = await Promise.all([
    sb.from("profiles").select("id, email, full_name").eq("role", "vendor"),
    sb.from("clients").select("id, name, zone, vendor_id, payment_method, amount, notes, is_active"),
    sb.from("payments_report").select("client_id, total_amount"),
  ]);
  for (const r of [vendorsRes, clientsRes, reportsRes]) {
    if (r.error) throw r.error;
  }
  return {
    vendors: vendorsRes.data || [],
    clients: clientsRes.data || [],
    reports: reportsRes.data || [],
  };
}

function buildRows({ vendors, clients, reports }) {
  const vendorById = new Map(vendors.map((v) => [v.id, v]));
  const reportByClient = new Map(reports.map((r) => [r.client_id, r]));

  return clients.map((c) => {
    const v = vendorById.get(c.vendor_id);
    const r = reportByClient.get(c.id);
    const monto = Number(c.amount || 0);
    const conciliado = Number(r?.total_amount || 0);
    const pte = Math.max(0, monto - conciliado);
    let estado = "Pendiente";
    if (monto > 0 && conciliado >= monto) estado = "Conciliado";
    else if (conciliado > 0) estado = "Parcial";
    return {
      zona: c.zone || "Sin zona",
      cliente: c.name,
      vendedor: v ? (v.full_name || v.email) : "—",
      metodo: c.payment_method || "—",
      monto,
      conciliado,
      pte,
      estado,
      activo: c.is_active ? "Sí" : "",
      notas: c.notes || "",
    };
  });
}

function groupByZone(rows) {
  const byZone = new Map();
  for (const row of rows) {
    if (!byZone.has(row.zona)) byZone.set(row.zona, []);
    byZone.get(row.zona).push(row);
  }
  return [...byZone.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([zona, list]) => ({
      zona,
      rows: list.slice().sort((a, b) => a.cliente.localeCompare(b.cliente)),
    }));
}

export async function exportConciliation(format) {
  let data;
  try {
    data = await fetchData();
  } catch (e) {
    toast(`Error obteniendo datos: ${e.message || e}`, "error");
    return;
  }
  const rows = buildRows(data);
  if (!rows.length) {
    toast("No hay clientes que exportar.", "info");
    return;
  }

  const grouped = groupByZone(rows);
  const ts = new Date().toISOString().slice(0, 10);

  if (format === "xlsx") {
    exportXLSX(grouped, `conciliacion_${ts}.xlsx`);
  } else {
    exportCSV(grouped, `conciliacion_${ts}.csv`);
  }
}

function rowToArray(row) {
  return [
    row.cliente,
    row.vendedor,
    row.metodo,
    row.monto,
    row.conciliado,
    row.pte,
    row.estado,
    row.activo,
    row.notas,
  ];
}

function exportXLSX(grouped, filename) {
  if (!window.XLSX) { toast("SheetJS no está disponible.", "error"); return; }
  const XLSX = window.XLSX;
  const wb = XLSX.utils.book_new();

  for (const zoneGroup of grouped) {
    const aoa = [];
    aoa.push([`ZONA: ${String(zoneGroup.zona).toUpperCase()}`]);
    aoa.push([]);
    aoa.push(COLUMNS);
    for (const row of zoneGroup.rows) aoa.push(rowToArray(row));

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [
      { wch: 28 }, { wch: 22 }, { wch: 24 },
      { wch: 16 }, { wch: 16 }, { wch: 14 },
      { wch: 12 }, { wch: 8 }, { wch: 30 },
    ];
    const sheetName = sanitizeSheetName(zoneGroup.zona);
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  }

  XLSX.writeFile(wb, filename);
  toast(`Exportado: ${filename}`, "success");
}

function sanitizeSheetName(name) {
  // Excel: <= 31 chars y prohibe : \ / ? * [ ]
  return String(name).replace(/[:\\/?*\[\]]/g, "_").slice(0, 31);
}

function exportCSV(grouped, filename) {
  const lines = [];
  for (const zoneGroup of grouped) {
    lines.push(csvLine([`ZONA: ${String(zoneGroup.zona).toUpperCase()}`]));
    lines.push("");
    lines.push(csvLine(COLUMNS));
    for (const row of zoneGroup.rows) lines.push(csvLine(rowToArray(row)));
    lines.push("");
  }
  // BOM UTF-8 al inicio para que Excel respete acentos / ñ
  const csv = "﻿" + lines.join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  triggerDownload(blob, filename);
  toast(`Exportado: ${filename}`, "success");
}

function csvLine(values) {
  return values.map(csvEscape).join(",");
}

function csvEscape(val) {
  if (val == null) return "";
  const s = String(val);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
