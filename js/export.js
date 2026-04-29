// Exporta la conciliación completa agrupada por mes y zona.
//
// XLSX: una hoja por mes; cada hoja con secciones por zona.
// CSV : un solo archivo con BOM UTF-8 y secciones de mes / zona.

import { sb } from "./supabase.js";
import { toast } from "./ui.js";

const MONTH_ORDER = [
  "Enero","Febrero","Marzo","Abril","Mayo","Junio",
  "Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre",
];

const COLUMNS = [
  "Cliente",
  "Vendedor",
  "Método de pago",
  "Monto contratado",
  "Enganche",
  "Anticipo",
  "Restante diferido",
  "Mens. reportadas",
  "Monto reportado",
  "Adeudo",
  "Estado",
];

async function fetchData() {
  const [vendorsRes, clientsRes, reportsRes] = await Promise.all([
    sb.from("profiles").select("id, email, full_name").eq("role", "vendor"),
    sb.from("clients").select("id, name, zone, vendor_id, payment_month, payment_method, amount, enganche, anticipo"),
    sb.from("payments_report").select("client_id, months_paid, total_amount"),
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
    const monto    = Number(c.amount   || 0);
    const enganche = Number(c.enganche || 0);
    const anticipo = Number(c.anticipo || 0);
    const pagado = Number(r?.total_amount || 0);
    const adeudo = Math.max(0, monto - pagado);
    const reported = !!(r && (r.months_paid || r.total_amount));
    return {
      mes: c.payment_month || "Sin mes",
      zona: c.zone || "Sin zona",
      cliente: c.name,
      vendedor: v ? (v.full_name || v.email) : "—",
      metodo: c.payment_method || "—",
      monto,
      enganche: enganche || "N/A",
      anticipo: anticipo || "N/A",
      restante_diferido: deferredMonthly(c.payment_method, monto, enganche, anticipo) ?? "N/A",
      mens_reportadas: r?.months_paid ?? "",
      monto_reportado: pagado,
      adeudo,
      estado: reported ? "Reportado" : "Pendiente",
    };
  });
}

function deferredMonthly(method, total, enganche, anticipo) {
  const m = (method || "").match(/^(\d+) Meses Sin Intereses$/) || (method || "").match(/(\d+) MSI$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!n) return null;
  return +((total - enganche - anticipo) / n).toFixed(2);
}

function groupByMonthZone(rows) {
  const byMonth = new Map();
  for (const row of rows) {
    if (!byMonth.has(row.mes)) byMonth.set(row.mes, new Map());
    const byZone = byMonth.get(row.mes);
    if (!byZone.has(row.zona)) byZone.set(row.zona, []);
    byZone.get(row.zona).push(row);
  }

  const monthRank = (m) => {
    const i = MONTH_ORDER.indexOf(m);
    return i === -1 ? MONTH_ORDER.length : i;
  };

  return [...byMonth.keys()]
    .sort((a, b) => monthRank(a) - monthRank(b))
    .map((mes) => ({
      mes,
      zones: [...byMonth.get(mes).entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([zona, list]) => ({
          zona,
          rows: list.slice().sort((a, b) => a.cliente.localeCompare(b.cliente)),
        })),
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

  const grouped = groupByMonthZone(rows);
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
    row.enganche,
    row.anticipo,
    row.restante_diferido,
    row.mens_reportadas,
    row.monto_reportado,
    row.adeudo,
    row.estado,
  ];
}

function exportXLSX(grouped, filename) {
  if (!window.XLSX) { toast("SheetJS no está disponible.", "error"); return; }
  const XLSX = window.XLSX;
  const wb = XLSX.utils.book_new();

  for (const monthGroup of grouped) {
    const aoa = [];
    aoa.push([`MES: ${String(monthGroup.mes).toUpperCase()}`]);
    aoa.push([]);

    for (const zoneGroup of monthGroup.zones) {
      aoa.push([`Zona: ${zoneGroup.zona}`]);
      aoa.push(COLUMNS);
      for (const row of zoneGroup.rows) aoa.push(rowToArray(row));
      aoa.push([]);
    }

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [
      { wch: 28 }, { wch: 22 }, { wch: 26 },
      { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 16 },
      { wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 12 },
    ];
    const sheetName = sanitizeSheetName(monthGroup.mes);
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
  for (const monthGroup of grouped) {
    lines.push(csvLine([`MES: ${String(monthGroup.mes).toUpperCase()}`]));
    lines.push("");
    for (const zoneGroup of monthGroup.zones) {
      lines.push(csvLine([`Zona: ${zoneGroup.zona}`]));
      lines.push(csvLine(COLUMNS));
      for (const row of zoneGroup.rows) lines.push(csvLine(rowToArray(row)));
      lines.push("");
    }
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
