// Cliente Supabase compartido por toda la app.
// Pegar URL y anon key del proyecto (Settings → API en Supabase).
// Es seguro publicarlas: la seguridad la da RLS, no estas claves.

export const SUPABASE_URL  = "<TU_SUPABASE_URL>";
export const SUPABASE_ANON = "<TU_SUPABASE_ANON_KEY>";

if (!window.supabase) {
  throw new Error(
    "Supabase JS no cargó. Verifica el <script> de @supabase/supabase-js en index.html."
  );
}

export const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: { persistSession: true, autoRefreshToken: true },
});

export function isConfigured() {
  return !SUPABASE_URL.startsWith("<") && !SUPABASE_ANON.startsWith("<");
}
