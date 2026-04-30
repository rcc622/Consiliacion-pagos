# CLAUDE.md

Notas de workflow para este repo.

## Cambios relacionados a pagos (clients, payments_report, schema, vendor/master views)

Cuando se apliquen cambios que afecten la lógica o el modelo de pagos:

1. Antes de mergear a `main`, crear una rama de backup desde el `main` actual,
   con nombre `backup/main-pre-<descripcion-corta>-YYYYMMDD`, y empujarla a
   `origin`.
2. Hacer merge de la rama de feature a `main` (preferir fast-forward cuando
   sea posible) y empujar `main`.
3. Vercel despliega `main`, por lo que solo después del merge los cambios
   llegan a producción.

Si el cambio toca `schema.sql`, recordarle al usuario correr el SQL en
Supabase antes de probar.
