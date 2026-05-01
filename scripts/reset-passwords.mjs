// Cambia el password de usuarios ya creados en Authentication.
// Útil cuando te equivocas dando de alta y no quieres borrar / recrear.
//
// Requisitos:
//   - Node 18+
//   - npm i @supabase/supabase-js  (en scripts/)
//
// Uso:
//   export SUPABASE_URL=https://xxx.supabase.co
//   export SUPABASE_SERVICE_ROLE=eyJ...
//   node scripts/reset-passwords.mjs

import { createClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE;

if (!URL || !KEY) {
  console.error("Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE en el entorno.");
  process.exit(1);
}

const sb = createClient(URL, KEY, { auth: { persistSession: false } });

// Edita esta lista. Cada entrada {email, password}.
// La password puede ser distinta por usuario o la misma para todos.
const RESETS = [
  // { email: "gaby@kenetsolar.com",   password: "Cambiame123!" },
  // { email: "javier@kenetsolar.com", password: "Cambiame123!" },
];

if (!RESETS.length) {
  console.error("La lista RESETS está vacía. Edita scripts/reset-passwords.mjs.");
  process.exit(1);
}

async function findUserByEmail(email) {
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

for (const r of RESETS) {
  const u = await findUserByEmail(r.email);
  if (!u) {
    console.error(`✗ ${r.email}: no existe en Authentication`);
    continue;
  }
  const { error } = await sb.auth.admin.updateUserById(u.id, { password: r.password });
  if (error) console.error(`✗ ${r.email}: ${error.message}`);
  else console.log(`✓ ${r.email}: password actualizado`);
}

console.log("\nListo. Avísale a cada usuario su nueva password y que la cambie al entrar.");
