# Scripts auxiliares

## seed-users.mjs

Crea usuarios en Authentication y arma sus profiles en una sola corrida.
Útil para alta masiva. Idempotente: si el email ya existe en Auth, solo
actualiza el profile.

### Setup (una vez)

```bash
cd scripts
npm init -y
npm install @supabase/supabase-js
```

### Cómo correrlo

1. En Supabase: **Settings → API**, copia el `service_role` key. Es
   secreto, nunca lo commits.
2. Edita la lista `USERS` dentro de `seed-users.mjs` con los emails,
   nombres, role y zona.
3. Exporta credenciales y corre:

```bash
export SUPABASE_URL="https://xxxxx.supabase.co"
export SUPABASE_SERVICE_ROLE="eyJ..."

node seed-users.mjs
```

### Salida esperada

```
+ gaby@kenetsolar.com: creado (uuid)
✓ profile gaby@kenetsolar.com: Gaby (vendor/Monterrey)
+ javier@kenetsolar.com: creado (uuid)
✓ profile javier@kenetsolar.com: Javier Rodriguez (vendor/Torreón)

Listo. Comparte la password temporal con cada usuario: Cambiame123!
```

Cada usuario se crea con la password temporal definida en el script. Diles
que la cambien al primer login.
