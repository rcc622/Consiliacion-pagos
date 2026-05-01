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
update public.profiles set role='vendor', full_name='Aaron',           zone='Monterrey' where email='btnhlopez@gmail.com';
update public.profiles set role='vendor', full_name='Miguel',          zone='Monterrey' where email='cambaceo1@kenetsolar.com';
update public.profiles set role='vendor', full_name='Said Ceron',      zone='Monterrey' where email='ventasmty4@kenetsolar.com';
update public.profiles set role='vendor', full_name='Mara',            zone='Monterrey' where email='ventas@kenetsolar.com';
update public.profiles set role='vendor', full_name='Carlos',          zone='Monterrey' where email='elisa@kenetsolar.com';
update public.profiles set role='vendor', full_name='Yazmin',          zone='Monterrey' where email='humberto@kenetsolar.com';
update public.profiles set role='vendor', full_name='Samuel Giacoman', zone='Monterrey' where email='samuel@kenetsolar.com';
-- Gaby — pendiente: agregar usuario en Authentication y completar email aquí.

-- Saltillo
update public.profiles set role='vendor', full_name='Monica Muñiz',    zone='Saltillo'  where email='monica@kenetsolar.com';
update public.profiles set role='vendor', full_name='Elizabeth',       zone='Saltillo'  where email='ventasaltillo1@kenetsolar.com';
update public.profiles set role='vendor', full_name='Mildred',         zone='Saltillo'  where email='rodolfo@kenetsolar.com';

-- Torreón — pendientes: agregar usuarios en Authentication y completar emails.
-- Carolina, Oscar, Javier, Juan, Felipe

-- Monclova — pendientes: agregar usuarios en Authentication y completar emails.
-- Edgar, José Luis

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
