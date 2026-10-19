-- ============================================================
-- Migración 45 (2026-10-19): agenda real para barberías (horarios por barbero,
-- duración por servicio, horas libres y sin cruces).
-- Ejecutar todo de una vez en el SQL Editor.
--
-- Solo afecta a bodegas con tipo_negocio = 'barberia' que ya hayan cargado el
-- horario de al menos un barbero. Las bodegas/minimarkets no cambian, y una
-- barbería sin horarios cargados sigue como en la migración 44 (día y hora libres).
--
-- 1) productos.duracion_min: minutos que dura un servicio (vacío = 30).
-- 2) barbero_horarios: bloques de atención por barbero y día de la semana
--    (0 = domingo ... 6 = sábado). Varios bloques por día permiten un descanso.
-- 3) citas: una fila por reserva, con barbero, inicio y fin. Una restricción de
--    exclusión impide que un mismo barbero tenga dos citas que se pisen, aunque
--    dos clientes reserven a la vez.
-- 4) Funciones: duración de un pedido, barberos libres a una hora, horas libres
--    de un día (la usa la tienda) y guardar el horario de un barbero (la usa el POS).
-- 5) El disparador de pedidos_delivery valida la cita contra la agenda y, si el
--    cliente eligió "Cualquiera", asigna el barbero con menos citas ese día.
-- 6) La cita se crea al crearse el seguimiento del pedido y se libera si el
--    pedido se cancela.
-- ============================================================

create extension if not exists btree_gist;

alter table public.productos
  add column if not exists duracion_min integer
  check (duracion_min is null or duracion_min between 5 and 480);

-- Horarios de atención por barbero -----------------------------------------
create table if not exists public.barbero_horarios (
  id uuid primary key default gen_random_uuid(),
  bodega_id uuid not null references public.bodegas(id) on delete cascade,
  barbero_id uuid not null references public.cajeros(id) on delete cascade,
  dia smallint not null check (dia between 0 and 6),
  desde time not null,
  hasta time not null,
  check (hasta > desde)
);
create index if not exists barbero_horarios_barbero_idx on public.barbero_horarios (barbero_id);
create index if not exists barbero_horarios_bodega_idx on public.barbero_horarios (bodega_id);
alter table public.barbero_horarios enable row level security;
drop policy if exists "bodega lee sus horarios de barberos" on public.barbero_horarios;
create policy "bodega lee sus horarios de barberos" on public.barbero_horarios
  for select to authenticated using (bodega_id = mi_bodega_id());
revoke all on public.barbero_horarios from anon, authenticated;
grant select on public.barbero_horarios to authenticated;

-- Citas ---------------------------------------------------------------------
create table if not exists public.citas (
  id uuid primary key default gen_random_uuid(),
  bodega_id uuid not null references public.bodegas(id) on delete cascade,
  barbero_id uuid not null references public.cajeros(id) on delete cascade,
  seguimiento_id uuid not null references public.pedidos_seguimiento(id) on delete cascade,
  inicio timestamptz not null,
  fin timestamptz not null,
  creado_en timestamptz not null default now(),
  check (fin > inicio),
  constraint citas_sin_cruce exclude using gist (barbero_id with =, tstzrange(inicio, fin) with &&)
);
create index if not exists citas_bodega_inicio_idx on public.citas (bodega_id, inicio);
create index if not exists citas_seguimiento_idx on public.citas (seguimiento_id);
alter table public.citas enable row level security;
drop policy if exists "bodega lee sus citas" on public.citas;
create policy "bodega lee sus citas" on public.citas
  for select to authenticated using (bodega_id = mi_bodega_id());
revoke all on public.citas from anon, authenticated;
grant select on public.citas to authenticated;

-- Columnas nuevas en el pedido y su seguimiento ----------------------------
alter table public.pedidos_delivery   add column if not exists cita_barbero_id uuid;
alter table public.pedidos_delivery   add column if not exists cita_duracion_min integer;
alter table public.pedidos_seguimiento add column if not exists cita_barbero_id uuid;
alter table public.pedidos_seguimiento add column if not exists cita_duracion_min integer;
grant insert (cita_barbero_id) on public.pedidos_delivery to anon, authenticated;
grant select (cita_barbero_id, cita_duracion_min) on public.pedidos_delivery to anon, authenticated;

-- Duración de un pedido: suma los servicios (productos sin stock, sueltos o
-- dentro de un combo). Un servicio sin duración cargada cuenta 30 minutos.
create or replace function public.barberia_duracion_items(p_bodega uuid, p_items jsonb)
returns integer
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(sum(d), 0)::integer from (
    select coalesce(p.duracion_min, 30)
           * ceil(greatest(coalesce((it->>'cantidad')::numeric, 1), 1)) as d
    from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) it
    join productos p on p.id = (it->>'id')::uuid and p.bodega_id = p_bodega
    where it ? 'id' and p.stock_actual is null
    union all
    select coalesce(p.duracion_min, 30)
           * ceil(coalesce(ci.cantidad, 1))
           * ceil(greatest(coalesce((it->>'cantidad')::numeric, 1), 1)) as d
    from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) it
    join combos_items ci on ci.combo_id = (it->>'combo_id')::uuid and ci.bodega_id = p_bodega
    join productos p on p.id = ci.producto_id
    where it ? 'combo_id' and p.stock_actual is null
  ) x;
$$;

-- Barberos que pueden atender a esa hora: trabajan en ese horario y no tienen
-- otra cita que se pise. Si se pasa p_barbero, solo se revisa ese barbero.
create or replace function public.barberia_barberos_libres(p_bodega uuid, p_inicio timestamptz, p_dur integer, p_barbero uuid default null)
returns setof uuid
language sql
stable
security definer
set search_path to 'public'
as $$
  select c.id
  from cajeros c
  where c.bodega_id = p_bodega
    and c.activo is not false
    and (p_barbero is null or c.id = p_barbero)
    and exists (
      select 1 from barbero_horarios h
      where h.barbero_id = c.id
        and h.dia = extract(dow from (p_inicio at time zone 'America/Lima'))::int
        and h.desde <= (p_inicio at time zone 'America/Lima')::time
        and h.hasta >= ((p_inicio + make_interval(mins => p_dur)) at time zone 'America/Lima')::time
        and ((p_inicio + make_interval(mins => p_dur)) at time zone 'America/Lima')::date
            = (p_inicio at time zone 'America/Lima')::date
    )
    and not exists (
      select 1 from citas ci
      where ci.barbero_id = c.id
        and tstzrange(ci.inicio, ci.fin) && tstzrange(p_inicio, p_inicio + make_interval(mins => p_dur))
    );
$$;

-- Horas libres de un día (cada 30 min) para lo que hay en el carrito.
create or replace function public.obtener_disponibilidad_barberia(p_slug text, p_fecha date, p_items jsonb, p_barbero uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_b uuid;
  v_dur integer;
  v_hoy date := (now() at time zone 'America/Lima')::date;
  v_horas jsonb;
begin
  select b.id into v_b
  from bodegas b
  join bodegas_delivery bd on bd.bodega_id = b.id
  where b.slug = p_slug and b.tipo_negocio = 'barberia';
  if v_b is null or not exists (select 1 from barbero_horarios where bodega_id = v_b) then
    return jsonb_build_object('agenda', false);
  end if;
  v_dur := barberia_duracion_items(v_b, p_items);
  if v_dur <= 0 or p_fecha is null or p_fecha < v_hoy or p_fecha > v_hoy + 60 then
    return jsonb_build_object('agenda', true, 'duracion', v_dur, 'horas', '[]'::jsonb);
  end if;
  select coalesce(jsonb_agg(to_char(s, 'HH24:MI') order by s), '[]'::jsonb) into v_horas
  from generate_series(p_fecha::timestamp, p_fecha::timestamp + interval '23 hours 30 minutes', interval '30 minutes') s
  where (s at time zone 'America/Lima') >= now() + interval '15 minutes'
    and exists (select 1 from barberia_barberos_libres(v_b, (s at time zone 'America/Lima'), v_dur, p_barbero));
  return jsonb_build_object('agenda', true, 'duracion', v_dur, 'horas', v_horas);
end;
$$;

grant execute on function public.obtener_disponibilidad_barberia(text, date, jsonb, uuid) to anon, authenticated;
revoke execute on function public.barberia_duracion_items(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.barberia_barberos_libres(uuid, timestamptz, integer, uuid) from public, anon, authenticated;

-- La tienda sabe si la barbería usa agenda y qué barberos atienden.
create or replace function public.obtener_barberia_delivery(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select case
    when b.tipo_negocio = 'barberia' then jsonb_build_object(
      'es_barberia', true,
      'agenda', exists (select 1 from barbero_horarios h where h.bodega_id = b.id),
      'barberos', coalesce((
        select jsonb_agg(jsonb_build_object('id', c.id, 'nombre', c.nombre) order by c.nombre)
        from cajeros c
        where c.bodega_id = b.id and c.activo is not false
          and (
            not exists (select 1 from barbero_horarios h where h.bodega_id = b.id)
            or exists (select 1 from barbero_horarios h where h.barbero_id = c.id)
          )
      ), '[]'::jsonb)
    )
    else jsonb_build_object('es_barberia', false)
  end
  from bodegas b
  join bodegas_delivery bd on bd.bodega_id = b.id
  where b.slug = p_slug;
$$;

-- El POS guarda el horario semanal de un barbero. p_bloques: [{dia, desde, hasta}].
create or replace function public.guardar_horario_barbero(p_barbero uuid, p_bloques jsonb)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_bodega uuid := mi_bodega_id();
  b jsonb;
begin
  if v_bodega is null or not exists (select 1 from cajeros where id = p_barbero and bodega_id = v_bodega) then
    raise exception 'No se pudo guardar el horario.';
  end if;
  if not exists (select 1 from bodegas where id = v_bodega and tipo_negocio = 'barberia') then
    raise exception 'La agenda es solo para barberías.';
  end if;
  if jsonb_typeof(p_bloques) <> 'array' or jsonb_array_length(p_bloques) > 28 then
    raise exception 'Horario inválido.';
  end if;
  delete from barbero_horarios where barbero_id = p_barbero;
  for b in select * from jsonb_array_elements(p_bloques) loop
    if (b->>'hasta')::time <= (b->>'desde')::time then
      raise exception 'La hora de fin debe ser después de la de inicio.';
    end if;
    insert into barbero_horarios (bodega_id, barbero_id, dia, desde, hasta)
    values (v_bodega, p_barbero, (b->>'dia')::smallint, (b->>'desde')::time, (b->>'hasta')::time);
  end loop;
end;
$$;
revoke execute on function public.guardar_horario_barbero(uuid, jsonb) from public, anon;
grant execute on function public.guardar_horario_barbero(uuid, jsonb) to authenticated;

-- Validación de la cita al crear el pedido ----------------------------------
create or replace function public.validar_cita_pedido_delivery()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_hoy date := (now() at time zone 'America/Lima')::date;
  v_dur integer;
  v_inicio timestamptz;
  v_libres uuid[];
  v_elegido uuid;
  v_nombre text;
begin
  if not exists (select 1 from bodegas b where b.id = new.bodega_id and b.tipo_negocio = 'barberia') then
    new.cita_fecha := null;
    new.cita_hora := null;
    new.cita_barbero := null;
    new.cita_barbero_id := null;
    new.cita_duracion_min := null;
    return new;
  end if;

  -- Barbería sin horarios cargados: se comporta como antes (día y hora libres).
  if not exists (select 1 from barbero_horarios where bodega_id = new.bodega_id) then
    new.cita_barbero_id := null;
    new.cita_duracion_min := null;
    if new.cita_fecha is null and new.cita_hora is null and new.cita_barbero is null then
      return new;
    end if;
    if new.cita_fecha is null or new.cita_fecha < v_hoy or new.cita_fecha > v_hoy + 60 then
      raise exception 'Elige un día para tu cita dentro de los próximos 60 días.';
    end if;
    if new.cita_hora is null or new.cita_hora !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      raise exception 'Elige la hora de tu cita.';
    end if;
    new.cita_barbero := nullif(left(trim(coalesce(new.cita_barbero, '')), 80), '');
    return new;
  end if;

  -- Barbería con agenda.
  v_dur := barberia_duracion_items(new.bodega_id, new.items);
  if v_dur <= 0 then
    new.cita_fecha := null;
    new.cita_hora := null;
    new.cita_barbero := null;
    new.cita_barbero_id := null;
    new.cita_duracion_min := null;
    return new;
  end if;
  if new.cita_fecha is null or new.cita_fecha < v_hoy or new.cita_fecha > v_hoy + 60 then
    raise exception 'Elige un día para tu cita dentro de los próximos 60 días.';
  end if;
  if new.cita_hora is null or new.cita_hora !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    raise exception 'Elige la hora de tu cita.';
  end if;
  -- Un cliente con la tienda abierta de antes puede mandar el nombre del barbero.
  if new.cita_barbero_id is null and nullif(trim(coalesce(new.cita_barbero, '')), '') is not null then
    select c.id into new.cita_barbero_id from cajeros c
      where c.bodega_id = new.bodega_id and c.activo is not false and c.nombre = trim(new.cita_barbero) limit 1;
  end if;

  -- Un pedido a la vez por barbería, para que dos clientes no se lleven la misma hora.
  perform pg_advisory_xact_lock(hashtextextended(new.bodega_id::text, 7));
  v_inicio := (new.cita_fecha + new.cita_hora::time) at time zone 'America/Lima';
  if v_inicio < now() then
    raise exception 'Esa hora ya pasó. Elige otra.';
  end if;
  select array_agg(l) into v_libres
    from barberia_barberos_libres(new.bodega_id, v_inicio, v_dur, new.cita_barbero_id) l;
  if v_libres is null then
    raise exception 'Esa hora ya no está disponible. Elige otra.';
  end if;
  select c.id, c.nombre into v_elegido, v_nombre
    from cajeros c
    where c.id = any(v_libres)
    order by (select count(*) from citas ci
              where ci.barbero_id = c.id
                and (ci.inicio at time zone 'America/Lima')::date = new.cita_fecha), c.nombre
    limit 1;
  new.cita_barbero_id := v_elegido;
  new.cita_barbero := v_nombre;
  new.cita_duracion_min := v_dur;
  return new;
end;
$$;

-- El seguimiento copia también barbero y duración.
create or replace function public.crear_seguimiento_pedido()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_nombre text;
begin
  if new.cliente_id is not null then
    select nombre into v_nombre from clientes_delivery where id = new.cliente_id;
    insert into pedidos_seguimiento (
      cliente_id, bodega_id, codigo_corto, items, cliente_nombre,
      tipo_entrega, entrega_lat, entrega_lng, entrega_referencia,
      telefono_contacto, costo_envio, medio_pago, paga_con,
      cita_fecha, cita_hora, cita_barbero, cita_barbero_id, cita_duracion_min
    )
    values (
      new.cliente_id, new.bodega_id, new.codigo_corto, new.items, v_nombre,
      new.tipo_entrega, new.entrega_lat, new.entrega_lng, new.entrega_referencia,
      new.telefono_contacto, new.costo_envio, new.medio_pago, new.paga_con,
      new.cita_fecha, new.cita_hora, new.cita_barbero, new.cita_barbero_id, new.cita_duracion_min
    );
  end if;
  return new;
end;
$$;

-- La cita se crea con el seguimiento y se libera si el pedido se cancela.
create or replace function public.crear_cita_desde_seguimiento()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_inicio timestamptz;
begin
  if new.cita_barbero_id is null or new.cita_fecha is null or new.cita_hora is null
     or coalesce(new.cita_duracion_min, 0) <= 0 then
    return new;
  end if;
  v_inicio := (new.cita_fecha + new.cita_hora::time) at time zone 'America/Lima';
  begin
    insert into citas (bodega_id, barbero_id, seguimiento_id, inicio, fin)
    values (new.bodega_id, new.cita_barbero_id, new.id, v_inicio, v_inicio + make_interval(mins => new.cita_duracion_min));
  exception when exclusion_violation then
    raise exception 'Esa hora acaba de ser tomada. Elige otra.';
  end;
  return new;
end;
$$;

drop trigger if exists crear_cita_desde_seguimiento_trigger on public.pedidos_seguimiento;
create trigger crear_cita_desde_seguimiento_trigger
after insert on public.pedidos_seguimiento
for each row
execute function public.crear_cita_desde_seguimiento();

create or replace function public.liberar_cita_al_cancelar()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.estado = 'cancelado' and old.estado is distinct from 'cancelado' then
    delete from citas where seguimiento_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists liberar_cita_al_cancelar_trigger on public.pedidos_seguimiento;
create trigger liberar_cita_al_cancelar_trigger
after update of estado on public.pedidos_seguimiento
for each row
execute function public.liberar_cita_al_cancelar();

notify pgrst, 'reload schema';

-- Las funciones de disparador no deben poder llamarse como RPC desde la API.
revoke execute on function public.validar_cita_pedido_delivery() from public, anon, authenticated;
revoke execute on function public.crear_cita_desde_seguimiento() from public, anon, authenticated;
revoke execute on function public.liberar_cita_al_cancelar() from public, anon, authenticated;
