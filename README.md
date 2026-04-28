# Conciliación de pagos

MVP web para que un gerente entregue una lista de clientes a sus vendedores, cada vendedor reporte cuántas mensualidades pagó y cuánto recibió, y el master vea un consolidado con qué tan conciliada está la cartera.

- **Frontend**: HTML + CSS + JS vanilla (sin build).
- **Backend**: [Supabase](https://supabase.com) (Auth + Postgres + Row-Level Security).
- **Costo**: $0 dentro del free tier.

---

## 1. Crear el proyecto en Supabase

1. Entra a [supabase.com](https://supabase.com) y crea un proyecto (free tier).
2. Anota:
   - `Project URL` (Settings → API → Project URL).
   - `anon public key` (Settings → API → Project API keys).
3. Abre **SQL Editor → New query**, pega el contenido de [`schema.sql`](./schema.sql) y corre. Esto crea las tablas `profiles`, `clients`, `payments_report`, los triggers y las políticas RLS.

## 2. Crear los usuarios

En **Authentication → Users → Add user** crea al menos:

- Un usuario `master` (gerente).
- Uno o más usuarios `vendor`.

El trigger `on_auth_user_created` les genera un renglón en `profiles` con `role='vendor'`. Para promover al gerente, corre en SQL Editor:

```sql
update public.profiles
   set role = 'master', full_name = 'Nombre del gerente'
 where email = 'gerente@empresa.com';
```

Y para los vendedores, opcionalmente, llena `full_name` y `zone`:

```sql
update public.profiles
   set full_name = 'Juan Pérez', zone = 'Norte'
 where email = 'juan@empresa.com';
```

## 3. Configurar las claves en el frontend

Edita [`js/supabase.js`](./js/supabase.js) y reemplaza:

```js
export const SUPABASE_URL  = "https://xxxx.supabase.co";
export const SUPABASE_ANON = "eyJhbGciOi...";
```

Estas claves son **públicas por diseño**: la seguridad la da RLS, no la clave.

## 4. Servir local

```bash
cd /home/user/Consiliacion-pagos
python3 -m http.server 8000
# abre http://localhost:8000
```

Cualquier servidor estático sirve (Vercel, GitHub Pages, Netlify, etc.).

---

## Flujos

### Master (gerente)
- Login → ve dashboard con totales, % conciliado por vendedor y por zona, y la lista detallada de clientes.
- **Importar lista**: sube CSV/Excel con columnas `cliente`, `zona`, `vendedor_email`. Los emails deben coincidir con usuarios ya creados en Supabase.
- **Agregar cliente**: alta manual desde un modal.

### Vendedor
- Login → ve solo sus clientes (RLS lo garantiza).
- Captura `# mensualidades` y `monto total` por cliente; se guarda al `blur` o `Enter`.
- Indicadores en la cabecera: cuántos lleva reportados de los asignados.

---

## Formato del archivo de importación

Columnas (insensibles a mayúsculas/acentos/espacios). Las 3 primeras son obligatorias, el resto opcionales:

| cliente       | zona  | vendedor_email     | mes   | metodo     | monto |
|---------------|-------|--------------------|-------|------------|-------|
| Juan Pérez    | Norte | juan@empresa.com   | Marzo | Contado    | 5000  |
| Comercial XYZ | Sur   | maria@empresa.com  | Abril | Financiado | 1200  |

> Los valores válidos para `metodo` son **Contado** o **Financiado**. La importación acepta cualquier texto, pero los selects de la app solo permiten esos dos.

Filas con `vendedor_email` desconocido se reportan como error y no rompen el resto del import.

---

## Deploy gratis

- **GitHub Pages**: Settings → Pages → Source: `main` → carpeta raíz.
- **Vercel**: importar el repo, sin build command, output dir = raíz.
- **Netlify**: drag & drop de la carpeta o conectar repo.

---

## Roadmap (fase 2)

- Export a Excel por zona / vendedor (`js/export.js`, ya con SheetJS cargado).
- Historial detallado por mensualidad (tabla `payments` hija).
- Dashboard de diferencias contra "expected" cuando haya línea base.
