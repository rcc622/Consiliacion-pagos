// Exportación a XLSX/CSV con pre-configuración.
//
// Estructura del XLSX:
//   - 1 hoja por asesor (vendedor).
//   - Dentro de cada hoja, bloques separados por método de pago.
//   - Bloques con métodos de mensualidades (MSI / Meses Sin Intereses)
//     incluyen N tripletas (Mens N, Fecha MN, F. Pago MN), donde N es el
//     máximo de mensualidades capturadas en ese bloque.
//   - El usuario puede filtrar por vendedor y por método antes de exportar.

import { sb, fetchAll } from "./supabase.js";
import { toast, clear } from "./ui.js";

const BASE_COLS = [
  "Referencia",
  "Cliente",
  "Método de pago",
  "Monto Proyecto",
  "Conciliado",
  "Pte Conciliar %",
  "Estado",
  "", // separador
  "$ Enganche",
  "Fecha Eng.",
  "F. Pago Eng.",
  "$ Anticipo",
  "Fecha Ant.",
  "F. Pago Ant.",
];

// Métodos que se consideran a mensualidades (se agregan columnas Mens N).
function isInstallmentMethod(method) {
  if (!method) return false;
  return /MSI|Meses Sin Intereses/i.test(method);
}

async function fetchData() {
  const [vendorsRes, clients, reports] = await Promise.all([
    sb.from("profiles").select("id, email, full_name").eq("role", "vendor"),
    fetchAll(() => sb.from("clients").select("id, name, reference, vendor_id, payment_method, amount, status, enganche, enganche_form, enganche_date, anticipo, anticipo_form, anticipo_date, notes")),
    fetchAll(() => sb.from("payments_report").select("client_id, total_amount, installments")),
  ]);
  if (vendorsRes.error) throw vendorsRes.error;
  return { vendors: vendorsRes.data || [], clients, reports };
}

function deriveStatus(c, conciliado) {
  if (c.status) return c.status;
  const monto = Number(c.amount || 0);
  if (monto > 0 && conciliado >= monto) return "Conciliado";
  if (conciliado > 0) return "Parcial";
  return "Pendiente";
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
    const pctPte = monto > 0 ? Math.round((pte / monto) * 1000) / 10 : 0;
    const installments = (Array.isArray(r?.installments) ? r.installments : [])
      .slice()
      .sort((a, b) => (a.n || 0) - (b.n || 0));
    return {
      vendor_id: c.vendor_id || null,
      vendor_label: v ? (v.full_name || v.email) : "Sin vendedor",
      reference: c.reference || "",
      cliente: c.name,
      metodo: c.payment_method || "—",
      monto,
      conciliado,
      pte_pct: `${pctPte}%`,
      estado: deriveStatus(c, conciliado),
      enganche: Number(c.enganche || 0) || "",
      enganche_date: c.enganche_date || "",
      enganche_form: c.enganche_form === "N/A" ? "N/A" : (c.enganche_form || ""),
      anticipo: Number(c.anticipo || 0) || "",
      anticipo_date: c.anticipo_date || "",
      anticipo_form: c.anticipo_form === "N/A" ? "N/A" : (c.anticipo_form || ""),
      installments,
    };
  });
}

function applyFilters(rows, config) {
  return rows.filter((row) => {
    if (config.vendor_ids && !config.vendor_ids.has(row.vendor_id)) return false;
    if (config.methods && !config.methods.has(row.metodo)) return false;
    return true;
  });
}

// Agrupa rows por vendedor y luego por método dentro de cada vendedor.
function groupForExport(rows) {
  const byVendor = new Map();
  for (const row of rows) {
    if (!byVendor.has(row.vendor_label)) byVendor.set(row.vendor_label, new Map());
    const byMethod = byVendor.get(row.vendor_label);
    if (!byMethod.has(row.metodo)) byMethod.set(row.metodo, []);
    byMethod.get(row.metodo).push(row);
  }
  return [...byVendor.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([vendorLabel, byMethod]) => ({
      vendorLabel,
      blocks: [...byMethod.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([metodo, list]) => ({
          metodo,
          rows: list.sort((a, b) => a.cliente.localeCompare(b.cliente)),
        })),
    }));
}

function buildBlockHeaders(metodo, rowsInBlock) {
  if (!isInstallmentMethod(metodo)) return BASE_COLS.slice();
  let maxN = 0;
  for (const row of rowsInBlock) {
    if (row.installments.length > maxN) maxN = row.installments.length;
  }
  const out = BASE_COLS.slice();
  for (let i = 1; i <= maxN; i++) {
    out.push(`Mens ${i}`, `Fecha M${i}`, `F. Pago M${i}`);
  }
  return out;
}

function rowToArray(row, headers) {
  const baseLen = BASE_COLS.length;
  const arr = [
    row.reference,
    row.cliente,
    row.metodo,
    row.monto,
    row.conciliado,
    row.pte_pct,
    row.estado,
    "",
    row.enganche,
    row.enganche_date,
    row.enganche_form,
    row.anticipo,
    row.anticipo_date,
    row.anticipo_form,
  ];
  // Tripletas de mensualidades (si la fila tiene), hasta lo que pidan los headers.
  const extraN = (headers.length - baseLen) / 3;
  for (let i = 0; i < extraN; i++) {
    const it = row.installments[i];
    arr.push(it ? it.amount : "");
    arr.push(it ? it.date   : "");
    arr.push(it ? it.form   : "");
  }
  return arr;
}

// Construye el workbook XLSX de UN asesor: una sola hoja con todos los
// bloques por método, formato moneda en columnas $.
function buildVendorWorkbook(vendorGroup) {
  const XLSX = window.XLSX;
  const wb = XLSX.utils.book_new();
  const aoa = [];
  aoa.push([`ASESOR: ${vendorGroup.vendorLabel.toUpperCase()}`]);
  aoa.push([]);

  for (const block of vendorGroup.blocks) {
    const headers = buildBlockHeaders(block.metodo, block.rows);
    aoa.push([`Método de pago: ${block.metodo}`]);
    aoa.push(headers);
    for (const row of block.rows) aoa.push(rowToArray(row, headers));
    aoa.push([]); // separador entre bloques
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [
    { wch: 12 },                            // Referencia
    { wch: 30 }, { wch: 24 },                // Cliente, Método
    { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, // Monto, Conciliado, Pte%, Estado
    { wch: 2  },                             // separador
    { wch: 12 }, { wch: 12 }, { wch: 14 },   // Enganche $, fecha, forma
    { wch: 12 }, { wch: 12 }, { wch: 14 },   // Anticipo $, fecha, forma
  ];
  applyMoneyFormatting(XLSX, ws);
  XLSX.utils.book_append_sheet(wb, ws, sanitizeSheetName(vendorGroup.vendorLabel));
  return wb;
}

// 1 asesor → un único .xlsx.
// >1 asesores → un .zip con un .xlsx por asesor.
async function exportXLSX(grouped, baseName) {
  if (!window.XLSX) { toast("SheetJS no está disponible.", "error"); return; }
  const XLSX = window.XLSX;

  if (grouped.length === 1) {
    const wb = buildVendorWorkbook(grouped[0]);
    const filename = `${baseName}_${sanitizeFileName(grouped[0].vendorLabel)}.xlsx`;
    XLSX.writeFile(wb, filename);
    toast(`Exportado: ${filename}`, "success");
    return;
  }

  if (!window.JSZip) {
    toast("JSZip no está disponible. No se puede armar el zip.", "error");
    return;
  }
  const zip = new window.JSZip();
  for (const vendorGroup of grouped) {
    const wb = buildVendorWorkbook(vendorGroup);
    const buffer = XLSX.write(wb, { type: "array", bookType: "xlsx" });
    zip.file(`${sanitizeFileName(vendorGroup.vendorLabel)}.xlsx`, buffer);
  }
  const blob = await zip.generateAsync({ type: "blob" });
  const filename = `${baseName}.zip`;
  triggerDownload(blob, filename);
  toast(`Exportado: ${filename} (${grouped.length} asesores)`, "success");
}

// Aplica formato moneda ($#,##0.00) a las columnas con $.
// Base: 3 (Monto), 4 (Conciliado), 8 (Enganche), 11 (Anticipo).
// MSI: 14, 17, 20, ... (cada 3 cols, los montos de Mens N).
function applyMoneyFormatting(XLSX, ws) {
  if (!ws["!ref"]) return;
  const range = XLSX.utils.decode_range(ws["!ref"]);
  const baseMoneyCols = [3, 4, 8, 11];
  const fmt = '"$"#,##0.00';
  for (let row = range.s.r; row <= range.e.r; row++) {
    for (let col = range.s.c; col <= range.e.c; col++) {
      const isBaseMoney = baseMoneyCols.includes(col);
      const isMensMoney = col >= 14 && (col - 14) % 3 === 0;
      if (!isBaseMoney && !isMensMoney) continue;
      const ref = XLSX.utils.encode_cell({ r: row, c: col });
      const cell = ws[ref];
      if (cell && typeof cell.v === "number") {
        cell.t = "n";
        cell.z = fmt;
      }
    }
  }
}

function sanitizeSheetName(name) {
  return String(name).replace(/[:\\/?*\[\]]/g, "_").slice(0, 31);
}

// Construye el CSV de UN asesor (con sus bloques por método). Sin BOM,
// el caller decide si lo agrega.
function buildVendorCSV(vendorGroup) {
  const lines = [];
  for (const block of vendorGroup.blocks) {
    const headers = buildBlockHeaders(block.metodo, block.rows);
    lines.push(csvLine([`Método de pago: ${block.metodo}`]));
    lines.push(csvLine(headers));
    for (const row of block.rows) lines.push(csvLine(rowToArray(row, headers)));
    lines.push("");
  }
  return lines.join("\r\n");
}

// 1 asesor → un único .csv con BOM UTF-8.
// >1 asesores → un .zip con un .csv por asesor.
async function exportCSV(grouped, baseName) {
  if (grouped.length === 1) {
    const csv = "﻿" + buildVendorCSV(grouped[0]);
    const filename = `${baseName}_${sanitizeFileName(grouped[0].vendorLabel)}.csv`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    triggerDownload(blob, filename);
    toast(`Exportado: ${filename}`, "success");
    return;
  }

  if (!window.JSZip) {
    toast("JSZip no está disponible. No se puede armar el zip.", "error");
    return;
  }
  const zip = new window.JSZip();
  for (const vendorGroup of grouped) {
    const csv = "﻿" + buildVendorCSV(vendorGroup);
    zip.file(`${sanitizeFileName(vendorGroup.vendorLabel)}.csv`, csv);
  }
  const blob = await zip.generateAsync({ type: "blob" });
  const filename = `${baseName}.zip`;
  triggerDownload(blob, filename);
  toast(`Exportado: ${filename} (${grouped.length} asesores)`, "success");
}

function sanitizeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, "_").trim() || "asesor";
}

function csvLine(values) { return values.map(csvEscape).join(","); }
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

// === Modal de pre-configuración =============================================

function openExportConfigModal({ vendors, methods }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";

    const modal = document.createElement("div");
    modal.className = "modal export-config-modal";

    const h = document.createElement("h2");
    h.textContent = "Configurar exportación";
    modal.appendChild(h);

    const note = document.createElement("p");
    note.className = "muted";
    note.style.margin = "0";
    note.textContent = "Selecciona qué incluir en el archivo. Por defecto se incluye todo.";
    modal.appendChild(note);

    const vendorSection = buildCheckboxSection("Vendedores", vendors.map((v) => ({
      value: v.id, label: v.full_name || v.email,
    })));
    modal.appendChild(vendorSection.wrap);

    const methodSection = buildCheckboxSection("Métodos de pago", methods.map((m) => ({
      value: m, label: m,
    })));
    modal.appendChild(methodSection.wrap);

    const actions = document.createElement("div");
    actions.className = "actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "ghost";
    cancel.textContent = "Cancelar";
    cancel.onclick = () => { backdrop.remove(); resolve(null); };
    const submit = document.createElement("button");
    submit.type = "button";
    submit.textContent = "Exportar";
    submit.onclick = () => {
      backdrop.remove();
      resolve({
        vendor_ids: vendorSection.getSelected(),
        methods: methodSection.getSelected(),
      });
    };
    actions.append(cancel, submit);
    modal.appendChild(actions);

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    backdrop.addEventListener("click", (ev) => {
      if (ev.target === backdrop) { backdrop.remove(); resolve(null); }
    });
  });
}

function buildCheckboxSection(title, options) {
  const wrap = document.createElement("div");
  wrap.className = "export-section";

  const head = document.createElement("div");
  head.className = "export-section-head";
  const t = document.createElement("strong");
  t.textContent = title;
  const links = document.createElement("span");
  links.className = "export-section-links";
  const all = document.createElement("a");
  all.href = "#"; all.textContent = "Todos";
  const none = document.createElement("a");
  none.href = "#"; none.textContent = "Ninguno";
  links.append(all, document.createTextNode(" · "), none);
  head.append(t, links);
  wrap.appendChild(head);

  const list = document.createElement("div");
  list.className = "export-section-list";
  const checks = [];
  for (const opt of options) {
    const row = document.createElement("label");
    row.className = "export-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.value = opt.value;
    const span = document.createElement("span");
    span.textContent = opt.label;
    row.append(cb, span);
    list.appendChild(row);
    checks.push(cb);
  }
  wrap.appendChild(list);

  all.onclick = (ev) => { ev.preventDefault(); for (const c of checks) c.checked = true; };
  none.onclick = (ev) => { ev.preventDefault(); for (const c of checks) c.checked = false; };

  return {
    wrap,
    getSelected() {
      const set = new Set();
      for (const c of checks) if (c.checked) set.add(c.value);
      return set;
    },
  };
}

// === Punto de entrada =======================================================

export async function exportConciliation(format) {
  let data;
  try {
    data = await fetchData();
  } catch (e) {
    toast(`Error obteniendo datos: ${e.message || e}`, "error");
    return;
  }
  if (!data.clients.length) {
    toast("No hay clientes que exportar.", "info");
    return;
  }

  const allRows = buildRows(data);
  // Listas únicas para el modal de configuración.
  const allMethods = [...new Set(allRows.map((r) => r.metodo))].sort((a, b) => a.localeCompare(b));
  const config = await openExportConfigModal({ vendors: data.vendors, methods: allMethods });
  if (!config) return;

  // Sets vacíos = nada selecciona; advertir.
  if (!config.vendor_ids.size || !config.methods.size) {
    toast("No seleccionaste nada que exportar.", "info");
    return;
  }

  const filtered = applyFilters(allRows, config);
  if (!filtered.length) {
    toast("Ningún cliente cumple los filtros.", "info");
    return;
  }

  const grouped = groupForExport(filtered);
  const ts = new Date().toISOString().slice(0, 10);
  if (format === "xlsx") await exportXLSX(grouped, `conciliacion_${ts}`);
  else                   await exportCSV(grouped, `conciliacion_${ts}`);
}
