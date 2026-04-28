// Cliente Supabase compartido por toda la app.
// Pegar URL y anon key del proyecto (Settings → API en Supabase).
// Es seguro publicarlas: la seguridad la da RLS, no estas claves.

export const SUPABASE_URL  = "https://mtgssesahqhnksuafznz.supabase.co";
export const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im10Z3NzZXNhaHFobmtzdWFmem56Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczNDA4NzgsImV4cCI6MjA5MjkxNjg3OH0.0CTHa1y99gr2hr3jU9trmOVCI0-n2q0brSD3c75PtYk";

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
