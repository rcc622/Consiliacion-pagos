// Crea usuarios en Authentication y les asigna profile (role / full_name /
// zone) usando el service_role key. NUNCA committees el service_role: se
// pasa por variable de entorno.
//
// Requisitos:
//   - Node 18+
//   - npm i @supabase/supabase-js
//
// Uso:
//   export SUPABASE_URL=https://xxx.supabase.co
//   export SUPABASE_SERVICE_ROLE=eyJ...   (Settings → API → service_role)
//   node scripts/seed-users.mjs
//
// Edita la lista USERS más abajo con tus datos. Si un email ya existe en
// Authentication, el script no lo duplica: solo actualiza el profile.

import { createClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE;

if (!URL || !KEY) {
  console.error("Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE en el entorno.");
  console.error("export SUPABASE_URL=https://xxx.supabase.co");
  console.error("export SUPABASE_SERVICE_ROLE=eyJ...");
  process.exit(1);
}

const sb = createClient(URL, KEY, { auth: { persistSession: false } });

// Password temporal — el usuario la cambia al primer login.
const DEFAULT_PASSWORD = "Cambiame123!";

// Edita esta lista con los usuarios que quieras crear.
const USERS = [
  // Pendientes (rellena email reales antes de correr):
  // { email: "gaby@kenetsolar.com",   full_name: "Gaby",             role: "vendor", zone: "Monterrey" },
  // { email: "javier@kenetsolar.com", full_name: "Javier Rodriguez", role: "vendor", zone: "Torreón" },

  // Ejemplo:
  // { email: "nuevo@kenetsolar.com", full_name: "Nuevo Vendedor", role: "vendor", zone: "Monterrey" },
];

if (!USERS.length) {
  console.error("La lista USERS está vacía. Edita scripts/seed-users.mjs.");
  process.exit(1);
}

async function findUserByEmail(email) {
  // listUsers no soporta filtro por email; paginamos y filtramos.
  let page = 1;
  while (true) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const found = data?.users?.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (found) return found;
    if (!data?.users?.length || data.users.length < 1000) return null;
    page++;
  }
}

for (const u of USERS) {
  let userId;
  const { data: created, error: createErr } = await sb.auth.admin.createUser({
    email: u.email,
    password: DEFAULT_PASSWORD,
    email_confirm: true,
  });

  if (createErr) {
    if (/already (been )?registered|already exists/i.test(createErr.message)) {
      const existing = await findUserByEmail(u.email);
      if (!existing) {
        console.error(`✗ ${u.email}: existe en auth pero no se localizó.`);
        continue;
      }
      userId = existing.id;
      console.log(`= ${u.email}: ya existía (${userId})`);
    } else {
      console.error(`✗ ${u.email}: ${createErr.message}`);
      continue;
    }
  } else {
    userId = created.user.id;
    console.log(`+ ${u.email}: creado (${userId})`);
  }

  // Upsert del profile. Como vamos con service_role, RLS no bloquea.
  const { error: pErr } = await sb.from("profiles").upsert({
    id: userId,
    email: u.email,
    full_name: u.full_name,
    role: u.role,
    zone: u.zone || null,
  }, { onConflict: "id" });

  if (pErr) {
    console.error(`✗ profile ${u.email}: ${pErr.message}`);
  } else {
    console.log(`✓ profile ${u.email}: ${u.full_name} (${u.role}/${u.zone || "—"})`);
  }
}

console.log("\nListo. Comparte la password temporal con cada usuario:", DEFAULT_PASSWORD);
