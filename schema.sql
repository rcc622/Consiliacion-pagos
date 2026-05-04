-- Consiliacion-pagos: schema + RLS
-- Ejecutar UNA SOLA VEZ en el SQL Editor de Supabase tras crear el proyecto.

-- Extensiones --------------------------------------------------------------
create extension if not exists "pgcrypto";

-- profiles -----------------------------------------------------------------
-- Espejo de auth.users con metadata propia. Se llena manualmente o via trigger.
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  full_name   text,
  role        text not null check (role in ('vendor','master')),
  zone        text,
  created_at  timestamptz not null default now()
);

-- Trigger para crear profile vacio cuando se crea un usuario en auth.users.
-- Se asigna 'vendor' por defecto; el master se promueve a mano con un UPDATE.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, role)
  values (new.id, new.email, 'vendor')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- clients ------------------------------------------------------------------
create table if not exists public.clients (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  zone           text,
  vendor_id      uuid references public.profiles(id) on delete set null,
  payment_month  text,
  payment_method text,
  amount         numeric(12,2),
  enganche       numeric(12,2),
  anticipo       numeric(12,2),
  notes          text,
  due_date       date,
  reference      text,
  is_active      boolean not null default false,
  status         text,
  enganche_form  text,
  enganche_date  date,
  anticipo_form  text,
  anticipo_date  date,
  dup_ok         boolean not null default false,
  created_at     timestamptz not null default now()
);

-- En instalaciones existentes, agregar columnas nuevas si faltan.
alter table public.clients add column if not exists payment_month  text;
alter table public.clients add column if not exists payment_method text;
alter table public.clients add column if not exists amount         numeric(12,2);
alter table public.clients add column if not exists enganche       numeric(12,2);
alter table public.clients add column if not exists anticipo       numeric(12,2);
alter table public.clients add column if not exists notes          text;
alter table public.clients add column if not exists due_date       date;
alter table public.clients add column if not exists reference      text;
alter table public.clients add column if not exists is_active      boolean not null default false;
alter table public.clients add column if not exists status         text;
alter table public.clients add column if not exists enganche_form  text;
alter table public.clients add column if not exists enganche_date  date;
alter table public.clients add column if not exists anticipo_form  text;
alter table public.clients add column if not exists anticipo_date  date;
alter table public.clients add column if not exists dup_ok         boolean not null default false;

create index if not exists clients_vendor_idx on public.clients(vendor_id);
create index if not exists clients_zone_idx   on public.clients(zone);

-- payments_report ----------------------------------------------------------
create table if not exists public.payments_report (
  client_id     uuid primary key references public.clients(id) on delete cascade,
  vendor_id     uuid not null references public.profiles(id) on delete cascade,
  months_paid   int           check (months_paid >= 0),
  total_amount  numeric(12,2) check (total_amount >= 0),
  installments  jsonb,
  reported_at   timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Para instalaciones existentes:
alter table public.payments_report add column if not exists installments jsonb;

create index if not exists pr_vendor_idx on public.payments_report(vendor_id);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_pr_updated_at on public.payments_report;
create trigger trg_pr_updated_at
  before update on public.payments_report
  for each row execute function public.touch_updated_at();

-- Cuando el master reasigna un cliente a otro vendedor, mover tambien el
-- reporte para que la captura siga al cliente y no rompa la RLS del nuevo
-- vendedor. SECURITY DEFINER ignora RLS dentro del trigger.
create or replace function public.sync_pr_vendor()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.vendor_id is distinct from new.vendor_id then
    update public.payments_report
       set vendor_id = new.vendor_id
     where client_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_pr_vendor on public.clients;
create trigger trg_sync_pr_vendor
  after update on public.clients
  for each row execute function public.sync_pr_vendor();

-- RLS ----------------------------------------------------------------------
alter table public.profiles        enable row level security;
alter table public.clients         enable row level security;
alter table public.payments_report enable row level security;

-- Helper: rompe la recursion de RLS al consultar el rol del usuario activo.
-- SECURITY DEFINER hace que la subconsulta a profiles ignore las policies
-- (que de otro modo se referenciarian a si mismas y Postgres bloquea).
create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

-- profiles: cada usuario lee su propio renglon; el master lee todos.
drop policy if exists profiles_self_read   on public.profiles;
drop policy if exists profiles_master_read on public.profiles;
drop policy if exists profiles_self_update on public.profiles;

create policy profiles_self_read on public.profiles
  for select using (id = auth.uid());

create policy profiles_master_read on public.profiles
  for select using (public.current_user_role() = 'master');

create policy profiles_self_update on public.profiles
  for update using (id = auth.uid());

-- clients: vendor solo ve los suyos; master lee y escribe todo.
-- El vendor puede actualizar sus propios clientes (enganche, anticipo, etc.);
-- el master sigue siendo dueño absoluto.
drop policy if exists clients_vendor_select on public.clients;
drop policy if exists clients_vendor_update on public.clients;
drop policy if exists clients_master_all    on public.clients;

create policy clients_vendor_select on public.clients
  for select using (
    vendor_id = auth.uid()
    or public.current_user_role() = 'master'
  );

create policy clients_vendor_update on public.clients
  for update using (vendor_id = auth.uid())
  with check (vendor_id = auth.uid());

create policy clients_master_all on public.clients
  for all using (public.current_user_role() = 'master')
  with check (public.current_user_role() = 'master');

-- payments_report: vendor lee/escribe lo suyo; master lee/escribe todo
-- (master puede entrar al modal de cualquier cliente y editar capturas).
drop policy if exists pr_vendor_rw     on public.payments_report;
drop policy if exists pr_master_select on public.payments_report;
drop policy if exists pr_master_all    on public.payments_report;

create policy pr_vendor_rw on public.payments_report
  for all using (vendor_id = auth.uid())
  with check (vendor_id = auth.uid());

create policy pr_master_all on public.payments_report
  for all using (public.current_user_role() = 'master')
  with check (public.current_user_role() = 'master');
