-- KaseritaDelivery -- "Seguir tienda" y avisos a los clientes de una bodega.
-- Ejecutar a mano en el SQL Editor de Supabase, despues de migration_33.
--
-- Que hace:
--   * bodegas_visitadas gana dos columnas: favorita (el corazon "Seguir
--     tienda") y avisos (si el cliente quiere recibir novedades de esa
--     tienda; por defecto si, y lo puede apagar).
--   * avisos_tienda: cola de avisos. Cada fila que se inserta dispara, por
--     Database Webhook, la funcion enviar-aviso-tienda, que manda el push
--     a los clientes de esa bodega (ver INSTRUCCIONES_PUSH.md, paso 4).
--   * Automatico: cuando una bodega activa su catalogo publico o activa la
--     entrega a domicilio, se encola un aviso. Tope: 1 automatico por
--     bodega cada 7 dias, y solo si hay a quien avisar.
--   * Manual: el dueno tiene un boton "Avisar a mis clientes" en el POS.
--     Tope: 1 manual por bodega cada 7 dias.
--
-- Es idempotente: se puede correr mas de una vez.

-- ============================================================
-- 1) Seguir tienda + preferencia de avisos
-- ============================================================

alter table public.bodegas_visitadas
  add column if not exists favorita boolean not null default false,
  add column if not exists avisos boolean not null default true;

-- ============================================================
-- 2) Cola de avisos (solo la tocan las funciones y el servicio)
-- ============================================================

create table if not exists public.avisos_tienda (
  id uuid primary key default gen_random_uuid(),
  bodega_id uuid not null references public.bodegas(id) on delete cascade,
  tipo text not null check (tipo in ('reactivada', 'domicilio', 'manual')),
  origen text not null check (origen in ('automatico', 'manual')),
  creado_en timestamptz not null default now(),
  enviados integer
);

create index if not exists avisos_tienda_bodega_idx
  on public.avisos_tienda (bodega_id, origen, creado_en desc);

alter table public.avisos_tienda enable row level security;
-- Sin politicas: ni anon ni authenticated leen ni escriben directo.

-- ============================================================
-- 3) Aviso automatico al activar catalogo o domicilio
-- ============================================================

create or replace function public.bodega_avisar_novedad()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tipo text;
  v_audiencia integer;
begin
  if not (new.delivery_habilitado and new.delivery_permitido) then
    return null;
  end if;

  if not coalesce(old.delivery_habilitado, false) then
    v_tipo := 'reactivada';
  elsif new.delivery_domicilio and not coalesce(old.delivery_domicilio, false) then
    v_tipo := 'domicilio';
  else
    return null;
  end if;

  -- Tope: un aviso automatico por bodega cada 7 dias.
  if exists (
    select 1 from avisos_tienda
    where bodega_id = new.id and origen = 'automatico'
      and creado_en > now() - interval '7 days'
  ) then
    return null;
  end if;

  -- Solo si hay a quien avisar (asi una bodega nueva no gasta el tope).
  select count(*) into v_audiencia
    from bodegas_visitadas bv
    join clientes_delivery c on c.id = bv.cliente_id
    where bv.bodega_id = new.id and bv.avisos and c.push_subscription is not null;

  if v_audiencia = 0 then
    return null;
  end if;

  insert into avisos_tienda (bodega_id, tipo, origen) values (new.id, v_tipo, 'automatico');
  return null;
end;
$$;

drop trigger if exists trg_bodega_avisar_novedad on public.bodegas;
create trigger trg_bodega_avisar_novedad
after update of delivery_habilitado, delivery_domicilio on public.bodegas
for each row
when (
  (new.delivery_habilitado is distinct from old.delivery_habilitado)
  or (new.delivery_domicilio is distinct from old.delivery_domicilio)
)
execute function public.bodega_avisar_novedad();

-- ============================================================
-- 4) Aviso manual desde el POS
-- ============================================================

-- Cuantos clientes recibirian el aviso y desde cuando se puede volver a enviar.
drop function if exists public.resumen_avisos_clientes();

create function public.resumen_avisos_clientes()
returns table (audiencia integer, proximo_envio timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_bodega_id uuid;
  v_ultimo timestamptz;
begin
  select bodega_id into v_bodega_id from usuarios where auth_id = auth.uid();
  if v_bodega_id is null then
    raise exception 'No autorizado.';
  end if;

  select count(*)::integer into audiencia
    from bodegas_visitadas bv
    join clientes_delivery c on c.id = bv.cliente_id
    where bv.bodega_id = v_bodega_id and bv.avisos and c.push_subscription is not null;

  select max(creado_en) into v_ultimo
    from avisos_tienda where bodega_id = v_bodega_id and origen = 'manual';

  proximo_envio := case
    when v_ultimo is null or v_ultimo + interval '7 days' <= now() then null
    else v_ultimo + interval '7 days'
  end;

  return next;
end;
$$;

grant execute on function public.resumen_avisos_clientes() to authenticated;

drop function if exists public.avisar_a_mis_clientes();

create function public.avisar_a_mis_clientes()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bodega_id uuid;
  v_habilitado boolean;
  v_permitido boolean;
  v_audiencia integer;
begin
  select bodega_id into v_bodega_id from usuarios where auth_id = auth.uid();
  if v_bodega_id is null then
    raise exception 'No autorizado.';
  end if;

  select delivery_habilitado, delivery_permitido into v_habilitado, v_permitido
    from bodegas where id = v_bodega_id;
  if not (coalesce(v_habilitado, false) and coalesce(v_permitido, false)) then
    raise exception 'Activa tu catálogo público antes de avisar a tus clientes.';
  end if;

  if exists (
    select 1 from avisos_tienda
    where bodega_id = v_bodega_id and origen = 'manual'
      and creado_en > now() - interval '7 days'
  ) then
    raise exception 'Ya avisaste a tus clientes hace poco. Podrás volver a hacerlo en unos días.';
  end if;

  select count(*) into v_audiencia
    from bodegas_visitadas bv
    join clientes_delivery c on c.id = bv.cliente_id
    where bv.bodega_id = v_bodega_id and bv.avisos and c.push_subscription is not null;

  if v_audiencia = 0 then
    raise exception 'Todavía no tienes clientes con avisos activados.';
  end if;

  insert into avisos_tienda (bodega_id, tipo, origen) values (v_bodega_id, 'manual', 'manual');
  return v_audiencia;
end;
$$;

grant execute on function public.avisar_a_mis_clientes() to authenticated;

NOTIFY pgrst, 'reload schema';

-- Verificacion: deben aparecer el trigger y la tabla
select tgname from pg_trigger where tgname = 'trg_bodega_avisar_novedad';
select to_regclass('public.avisos_tienda') as tabla_avisos;
