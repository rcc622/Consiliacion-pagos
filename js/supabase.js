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

// Pagina sobre cualquier select para esquivar el límite default (~1000)
// del PostgREST. `buildQuery` debe devolver un PostgrestFilterBuilder NUEVO
// en cada llamada porque cada uno se resuelve una sola vez al hacer await.
//
// Uso:
//   const clients = await fetchAll(() =>
//     sb.from("clients").select("id, name").order("name"));
export async function fetchAll(buildQuery, pageSize = 1000) {
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || !data.length) break;
    all.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}
