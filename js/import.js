// Parseo CSV/Excel via SheetJS y upsert masivo en clients.

import { sb } from "./supabase.js";

// Devuelve array de objetos {cliente, zona, vendedor_email}
export async function parseFile(file) {
  if (!window.XLSX) throw new Error("SheetJS no está disponible.");
  const buf = await file.arrayBuffer();
  const wb  = window.XLSX.read(buf, { type: "array" });
  const ws  = wb.Sheets[wb.SheetNames[0]];
  const rows = window.XLSX.utils.sheet_to_json(ws, { defval: "", raw: false });
  return rows.map(normalizeRow).filter((r) => r.cliente);
}

function normalizeRow(row) {
  const out = {};
  for (const k of Object.keys(row)) {
    const key = k.trim().toLowerCase()
      .replace(/[áä]/g, "a").replace(/[éë]/g, "e").replace(/[íï]/g, "i")
      .replace(/[óö]/g, "o").replace(/[úü]/g, "u").replace(/\s+/g, "_");
    out[key] = String(row[k]).trim();
  }
  return {
    cliente: out.cliente || out.nombre || out.client || "",
    zona:    out.zona    || out.zone   || "",
    vendedor_email: (out.vendedor_email || out.vendedor || out.email || "").toLowerCase(),
  };
}

// Inserta cada fila en clients haciendo lookup de vendor_id por email.
// Retorna { inserted, errors:[{row, reason}] }.
export async function importRows(rows) {
  const emails = [...new Set(rows.map((r) => r.vendedor_email).filter(Boolean))];

  let vendors = [];
  if (emails.length) {
    const { data, error } = await sb
      .from("profiles")
      .select("id, email")
      .in("email", emails);
    if (error) throw error;
    vendors = data || [];
  }
  const vendorByEmail = new Map(vendors.map((v) => [v.email.toLowerCase(), v.id]));

  const toInsert = [];
  const errors = [];
  for (const r of rows) {
    if (!r.vendedor_email) {
      errors.push({ row: r, reason: "Sin vendedor_email" });
      continue;
    }
    const vid = vendorByEmail.get(r.vendedor_email);
    if (!vid) {
      errors.push({ row: r, reason: `Vendedor no encontrado: ${r.vendedor_email}` });
      continue;
    }
    toInsert.push({ name: r.cliente, zone: r.zona || null, vendor_id: vid });
  }

  let inserted = 0;
  if (toInsert.length) {
    const { error, count } = await sb
      .from("clients")
      .insert(toInsert, { count: "exact" });
    if (error) throw error;
    inserted = count ?? toInsert.length;
  }

  return { inserted, errors };
}
