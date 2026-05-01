-- =====================================================================
-- 👥 GESTIÓN DE USUARIOS
-- Tabla única: public.profiles (id, email, full_name, role, zone)
-- role ∈ {'master','vendor'}.  Idempotente: se puede re-correr sin
-- romper nada. Cuando agregues a alguien nuevo en Authentication,
-- vuelve a correr la sección 1 y luego asígnale rol/zona en la 2 o 3.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) BACKFILL: crea profiles para auth.users que no tengan uno.
--    Útil cuando das de alta en Authentication y el trigger no corre.
-- ---------------------------------------------------------------------
insert into public.profiles (id, email, role)
select u.id, u.email, 'vendor'
  from auth.users u
  left join public.profiles p on p.id = u.id
 where p.id is null;

-- ---------------------------------------------------------------------
-- 2) MASTERS (gerentes / admins).  Permisos totales sobre clientes y
--    payments_report.
-- ---------------------------------------------------------------------
update public.profiles set role='master', full_name='Randall Cruz'
 where email='randall@kenetsolar.com';
update public.profiles set role='master', full_name='Roberto Laguna'
 where email='roberto.laguna@electricakenet.com';

-- ---------------------------------------------------------------------
-- 3) VENDEDORES POR ZONA.  Ajusta los emails a los reales que tengas
--    en Authentication. El nombre se ve en la app; la zona se usa para
--    filtros y agrupaciones.
-- ---------------------------------------------------------------------

-- Monterrey
update public.profiles set role='vendor', full_name='Aarón',     zone='Monterrey' where email='aaron@kenetsolar.com';
update public.profiles set role='vendor', full_name='Miguel',    zone='Monterrey' where email='miguel@kenetsolar.com';
update public.profiles set role='vendor', full_name='Said',      zone='Monterrey' where email='said@kenetsolar.com';
update public.profiles set role='vendor', full_name='Mara',      zone='Monterrey' where email='mara@kenetsolar.com';
update public.profiles set role='vendor', full_name='Carlos',    zone='Monterrey' where email='carlos@kenetsolar.com';
update public.profiles set role='vendor', full_name='Yazmín',    zone='Monterrey' where email='yazmin@kenetsolar.com';
update public.profiles set role='vendor', full_name='Gaby',      zone='Monterrey' where email='gaby@kenetsolar.com';
update public.profiles set role='vendor', full_name='Samuel',    zone='Monterrey' where email='samuel@kenetsolar.com';

-- Saltillo
update public.profiles set role='vendor', full_name='Mónica',    zone='Saltillo'  where email='monica@kenetsolar.com';
update public.profiles set role='vendor', full_name='Elizabeth', zone='Saltillo'  where email='elizabeth@kenetsolar.com';
update public.profiles set role='vendor', full_name='Mildred',   zone='Saltillo'  where email='ventasaltillo1@kenetsolar.com';

-- Torreón
update public.profiles set role='vendor', full_name='Carolina',  zone='Torreón'   where email='carolina@kenetsolar.com';
update public.profiles set role='vendor', full_name='Oscar',     zone='Torreón'   where email='oscar@kenetsolar.com';
update public.profiles set role='vendor', full_name='Javier',    zone='Torreón'   where email='javier@kenetsolar.com';
update public.profiles set role='vendor', full_name='Juan',      zone='Torreón'   where email='juan@kenetsolar.com';
update public.profiles set role='vendor', full_name='Felipe',    zone='Torreón'   where email='felipe@kenetsolar.com';

-- Monclova
update public.profiles set role='vendor', full_name='Edgar',     zone='Monclova'  where email='edgar@kenetsolar.com';
update public.profiles set role='vendor', full_name='José Luis', zone='Monclova'  where email='joseluis@kenetsolar.com';

-- ---------------------------------------------------------------------
-- 4) VERIFICACIÓN — corre esto para ver el estado actual.
-- ---------------------------------------------------------------------
select role, full_name, zone, email
  from public.profiles
 order by role desc, zone nulls last, full_name nulls last;

-- ---------------------------------------------------------------------
-- 5) DUPLICADOS — debe regresar 0 filas.
-- ---------------------------------------------------------------------
select email, count(*) as c
  from public.profiles
 group by email
having count(*) > 1;
