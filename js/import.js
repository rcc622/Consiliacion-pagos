// Parseo CSV/Excel via SheetJS y upsert masivo en clients.

import { sb } from "./supabase.js";

// Devuelve array de objetos {cliente, zona, vendedor_email, mes, metodo, monto}
export async function parseFile(file) {
  if (!window.XLSX) throw new Error("SheetJS no está disponible.");
  const buf = await file.arrayBuffer();
  // codepage 65001 = UTF-8. Sin esto SheetJS asume Latin-1 para CSVs sin BOM
  // y rompe ñ / acentos.
  const wb  = window.XLSX.read(buf, { type: "array", codepage: 65001 });
  const ws  = wb.Sheets[wb.SheetNames[0]];
  const rows = window.XLSX.utils.sheet_to_json(ws, { defval: "", raw: false });
  return rows.map(normalizeRow).filter((r) => r.cliente);
}

// Normaliza un nombre de columna: minusculas, sin acentos/diéresis, sin espacios.
function normalizeKey(k) {
  return String(k)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_");
}

function normalizeRow(row) {
  const out = {};
  for (const k of Object.keys(row)) {
    out[normalizeKey(k)] = String(row[k]).trim();
  }
  return {
    cliente: out.cliente || out.nombre || out.client || "",
    zona:    out.zona    || out.zone   || "",
    vendedor_email: (out.vendedor_email || out.vendedor || out.email || "").trim().toLowerCase(),
    mes:    out.mes    || out.month  || "",
    metodo: out.metodo || out.metodo_de_pago || out.method || "",
    monto:  out.monto  || out.amount || "",
  };
}

// Inserta cada fila en clients haciendo lookup de vendor_id por email.
// El lookup ignora mayusculas/minusculas y espacios, y trae a TODOS los
// vendedores en una sola consulta para evitar problemas de casing en .in().
//
// `defaults` permite forzar valores en bloque (sobrescriben el CSV):
//   { vendor_id, zone, payment_month }
//
// Retorna { inserted, errors:[{row, reason}] }.
export async function importRows(rows, defaults = {}) {
  const defaultVendor = defaults.vendor_id || null;
  const defaultZone   = defaults.zone || null;
  const defaultMonth  = defaults.payment_month || null;

  let vendorByEmail = new Map();
  if (!defaultVendor) {
    const { data, error } = await sb
      .from("profiles")
      .select("id, email")
      .eq("role", "vendor");
    if (error) throw error;
    vendorByEmail = new Map(
      (data || []).map((v) => [(v.email || "").trim().toLowerCase(), v.id])
    );
  }

  const toInsert = [];
  const errors = [];
  for (const r of rows) {
    let vid = defaultVendor;
    if (!vid) {
      if (!r.vendedor_email) {
        errors.push({ row: r, reason: "Sin vendedor (ni en CSV ni en selector)" });
        continue;
      }
      const key = r.vendedor_email.trim().toLowerCase();
      vid = vendorByEmail.get(key);
      if (!vid) {
        errors.push({ row: r, reason: `Vendedor no encontrado: ${r.vendedor_email}` });
        continue;
      }
    }
    const amount = r.monto === "" ? null : Number(String(r.monto).replace(/[^0-9.\-]/g, ""));
    toInsert.push({
      name: r.cliente,
      zone: defaultZone || r.zona || null,
      vendor_id: vid,
      payment_month:  defaultMonth || r.mes    || null,
      payment_method: r.metodo || null,
      amount: Number.isFinite(amount) ? amount : null,
    });
  }

  let inserted = 0;
  if (toInsert.length) {
    const { error: insErr, count } = await sb
      .from("clients")
      .insert(toInsert, { count: "exact" });
    if (insErr) throw insErr;
    inserted = count ?? toInsert.length;
  }

  return { inserted, errors };
}
