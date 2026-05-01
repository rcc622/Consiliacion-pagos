// Parseo CSV/Excel via SheetJS y upsert en clients.
//
// Soporta dos formatos:
//
// A) "deuda" (nuevo) — formato del archivo de cartera:
//    Contacto | Fecha de vencimiento | Total en moneda firmado |
//    Cantidad por pagar | Referencia
//    Reglas: agrupar por Referencia (o Contacto si no hay), sumar
//    Cantidad por pagar, skip si suma = 0, upsert por reference.
//
// B) "legacy" — formato original con vendedor_email y monto por fila.

import { sb } from "./supabase.js";

export async function parseFile(file) {
  if (!window.XLSX) throw new Error("SheetJS no está disponible.");
  const buf = await file.arrayBuffer();
  // codepage 65001 = UTF-8. Sin esto SheetJS asume Latin-1 para CSVs sin BOM
  // y rompe ñ / acentos.
  const wb  = window.XLSX.read(buf, { type: "array", codepage: 65001 });
  const ws  = wb.Sheets[wb.SheetNames[0]];
  const rows = window.XLSX.utils.sheet_to_json(ws, { defval: "", raw: false });
  return rows.map(normalizeRow).filter((r) => r._hasContent);
}

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

  // Formato deuda: detecta presencia de "cantidad_por_pagar" o "referencia".
  const hasDeudaCols = "cantidad_por_pagar" in out || "referencia" in out;
  if (hasDeudaCols) {
    const contacto = out.contacto || out.cliente || out.nombre || "";
    return {
      _format: "deuda",
      _hasContent: !!contacto,
      contacto,
      // Total en moneda firmado = monto del contrato (lo que firmó). Va a `amount`.
      total_firmado: out.total_en_moneda_firmado || out.total_firmado || out.monto_firmado || "",
      // Cantidad por pagar = lo que aún debe. Solo se usa para skip-zeros
      // (si todo el grupo tiene 0, el cliente ya saldó y no entra al sistema).
      cantidad: out.cantidad_por_pagar || "",
      referencia: out.referencia || "",
    };
  }

  // Formato legacy.
  const cliente = out.cliente || out.nombre || out.client || "";
  return {
    _format: "legacy",
    _hasContent: !!cliente,
    cliente,
    zona:    out.zona    || out.zone   || "",
    vendedor_email: (out.vendedor_email || out.vendedor || out.email || "").trim().toLowerCase(),
    mes:      out.mes      || out.month   || "",
    metodo:   out.metodo   || out.metodo_de_pago || out.method || "",
    monto:    out.monto    || out.amount  || "",
    enganche: out.enganche || out.down_payment || "",
    anticipo: out.anticipo || out.advance     || "",
  };
}

function parseAmount(raw) {
  if (raw === "" || raw == null) return null;
  const n = Number(String(raw).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Punto de entrada. Retorna { inserted, updated, skipped, errors }.
//
// `defaults` viene del modal de import. Para formato deuda solo usa vendor_id.
export async function importRows(rows, defaults = {}) {
  if (!rows.length) return { inserted: 0, updated: 0, skipped: 0, errors: [] };
  const isDeuda = rows[0]._format === "deuda";
  return isDeuda ? importDeuda(rows, defaults) : importLegacy(rows, defaults);
}

// === Formato deuda ===
//
// Agrupa por Referencia (o Contacto si no hay), suma Cantidad por pagar,
// crea/actualiza un cliente por grupo. Skip si la suma es 0.
async function importDeuda(rows, defaults) {
  const defaultVendor = defaults.vendor_id || null;
  if (!defaultVendor) {
    return {
      inserted: 0, updated: 0, skipped: 0,
      errors: [{ row: {}, reason: "Selecciona un vendedor en el modal antes de importar." }],
    };
  }

  // 1) Agrupar.  Sumamos por separado:
  //    totalFirmado → contrato total (va a clients.amount = "Monto Proyecto").
  //    totalPagar   → pendiente; solo se usa para descartar clientes ya saldados.
  const groups = new Map();
  for (const r of rows) {
    const contacto = r.contacto.trim();
    if (!contacto) continue;
    const ref = r.referencia.trim();
    const key = ref || `name:${contacto.toLowerCase()}`;
    if (!groups.has(key)) {
      groups.set(key, { contacto, referencia: ref || null, totalFirmado: 0, totalPagar: 0 });
    }
    const g = groups.get(key);
    g.totalFirmado += parseAmount(r.total_firmado) || 0;
    g.totalPagar   += parseAmount(r.cantidad)      || 0;
  }

  // 2) Filtrar grupos en cero.  Si el cliente no debe nada (totalPagar=0),
  //    se omite — ya saldó y no necesita estar en el sistema.
  const candidates = [];
  let skipped = 0;
  for (const g of groups.values()) {
    if (g.totalPagar <= 0) { skipped++; continue; }
    candidates.push({ ...g, amount: +g.totalFirmado.toFixed(2) });
  }

  // 3) Lookup de existentes por reference (en una sola query).
  const refs = candidates.map((g) => g.referencia).filter(Boolean);
  const existingByRef = new Map();
  if (refs.length) {
    const { data, error } = await sb.from("clients").select("id, reference").in("reference", refs);
    if (error) throw error;
    for (const c of data || []) existingByRef.set(c.reference, c.id);
  }

  // 4) Split: insert (nuevos) vs update (existentes con reference).
  //    En el update preservamos notes / status / installments — solo
  //    se actualiza name + amount.
  const toInsert = [];
  const toUpdate = []; // [{ id, patch }]
  for (const g of candidates) {
    const existingId = g.referencia ? existingByRef.get(g.referencia) : null;
    if (existingId) {
      toUpdate.push({ id: existingId, patch: { name: g.contacto, amount: g.amount } });
    } else {
      toInsert.push({
        name: g.contacto,
        reference: g.referencia,
        vendor_id: defaultVendor,
        amount: g.amount,
      });
    }
  }

  const errors = [];
  let inserted = 0;
  let updated = 0;

  if (toInsert.length) {
    const { error, count } = await sb.from("clients").insert(toInsert, { count: "exact" });
    if (error) {
      errors.push({ row: {}, reason: `Insert falló: ${error.message}` });
    } else {
      inserted = count ?? toInsert.length;
    }
  }

  for (const u of toUpdate) {
    const { error } = await sb.from("clients").update(u.patch).eq("id", u.id);
    if (error) {
      errors.push({ row: u.patch, reason: `Update falló (${u.id}): ${error.message}` });
    } else {
      updated++;
    }
  }

  return { inserted, updated, skipped, errors };
}

// === Formato legacy (compat) ===
async function importLegacy(rows, defaults) {
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
      vid = vendorByEmail.get(r.vendedor_email);
      if (!vid) {
        errors.push({ row: r, reason: `Vendedor no encontrado: ${r.vendedor_email}` });
        continue;
      }
    }
    toInsert.push({
      name: r.cliente,
      zone: defaultZone || r.zona || null,
      vendor_id: vid,
      payment_month:  defaultMonth || r.mes || null,
      payment_method: r.metodo || null,
      amount:   parseAmount(r.monto),
      enganche: parseAmount(r.enganche),
      anticipo: parseAmount(r.anticipo),
    });
  }

  let inserted = 0;
  if (toInsert.length) {
    const { error, count } = await sb
      .from("clients")
      .insert(toInsert, { count: "exact" });
    if (error) throw error;
    inserted = count ?? toInsert.length;
  }

  return { inserted, updated: 0, skipped: 0, errors };
}
