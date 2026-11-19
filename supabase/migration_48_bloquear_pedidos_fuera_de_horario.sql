-- ============================================================
-- Migración 48 (2026-11-19): una tienda fuera de su horario no recibe pedidos.
-- Ejecutar todo de una vez en el SQL Editor. Se puede volver a correr.
--
-- Antes el horario de atención (bodegas.horario_atencion) solo servía para
-- mostrar "Abierto" / "Cerrado": el cliente igual podía hacer el pedido.
-- Ahora un disparador lo rechaza (la tienda ya bloquea el botón; esto cubre
-- a quien tenga la pantalla abierta de antes o mande el pedido por fuera).
--
-- Reglas (las mismas que usa la tienda y el POS):
--  - Hora de Lima (UTC-5), no la del celular.
--  - Sin horario guardado, o sin ningún día abierto: no se bloquea nada.
--  - "hasta" mayor que "desde": tramo normal. "hasta" menor: cruza la
--    medianoche (la madrugada pertenece al día anterior). Iguales: todo el día.
--  - Las citas de barbería (cita_fecha) no se bloquean: son para otro día u
--    hora y las valida la agenda.
--  - Si el horario guardado tiene un formato roto, se deja pasar el pedido.
-- ============================================================

create or replace function public.horario_esta_abierto(p_horario jsonb, p_ahora timestamp)
returns boolean
language plpgsql
immutable
set search_path to 'public'
as $$
declare
  v_dia int := extract(dow from p_ahora)::int;
  v_min int := extract(hour from p_ahora)::int * 60 + extract(minute from p_ahora)::int;
  v_cfg jsonb;
  v_desde int;
  v_hasta int;
begin
  if p_horario is null or jsonb_typeof(p_horario) <> 'object' then
    return true;
  end if;
  -- Sin ningún día abierto = horario sin configurar.
  if not exists (
    select 1 from jsonb_each(p_horario) e
    where jsonb_typeof(e.value) = 'object' and coalesce((e.value ->> 'abierto')::boolean, false)
  ) then
    return true;
  end if;

  -- Tramo de hoy.
  v_cfg := p_horario -> v_dia::text;
  if jsonb_typeof(v_cfg) = 'object' and coalesce((v_cfg ->> 'abierto')::boolean, false)
     and v_cfg ->> 'desde' is not null and v_cfg ->> 'hasta' is not null then
    v_desde := split_part(v_cfg ->> 'desde', ':', 1)::int * 60 + split_part(v_cfg ->> 'desde', ':', 2)::int;
    v_hasta := split_part(v_cfg ->> 'hasta', ':', 1)::int * 60 + split_part(v_cfg ->> 'hasta', ':', 2)::int;
    if v_desde = v_hasta then
      return true;
    elsif v_desde < v_hasta then
      if v_min >= v_desde and v_min < v_hasta then return true; end if;
    else
      if v_min >= v_desde then return true; end if;
    end if;
  end if;

  -- Cola de ayer: un tramo que cruzó la medianoche sigue abierto hasta su "hasta".
  v_cfg := p_horario -> ((v_dia + 6) % 7)::text;
  if jsonb_typeof(v_cfg) = 'object' and coalesce((v_cfg ->> 'abierto')::boolean, false)
     and v_cfg ->> 'desde' is not null and v_cfg ->> 'hasta' is not null then
    v_desde := split_part(v_cfg ->> 'desde', ':', 1)::int * 60 + split_part(v_cfg ->> 'desde', ':', 2)::int;
    v_hasta := split_part(v_cfg ->> 'hasta', ':', 1)::int * 60 + split_part(v_cfg ->> 'hasta', ':', 2)::int;
    if v_desde > v_hasta and v_min < v_hasta then return true; end if;
  end if;

  return false;
exception when others then
  return true;
end;
$$;

create or replace function public.validar_horario_pedido_delivery()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_horario jsonb;
begin
  if new.cita_fecha is not null then
    return new;
  end if;
  select horario_atencion into v_horario from bodegas where id = new.bodega_id;
  if not public.horario_esta_abierto(v_horario, (now() at time zone 'America/Lima')) then
    raise exception 'La tienda está cerrada ahora. Vuelve a pedir cuando abra.';
  end if;
  return new;
end;
$$;

drop trigger if exists validar_horario_pedido_delivery_trigger on public.pedidos_delivery;
create trigger validar_horario_pedido_delivery_trigger
before insert on public.pedidos_delivery
for each row
execute function public.validar_horario_pedido_delivery();

notify pgrst, 'reload schema';

-- Comprobación rápida (lunes 2026-11-16, horario Lu a Vi 08:00-21:00):
--   select public.horario_esta_abierto('{"1":{"abierto":true,"desde":"08:00","hasta":"21:00"}}', '2026-11-16 09:00'); -- true
--   select public.horario_esta_abierto('{"1":{"abierto":true,"desde":"08:00","hasta":"21:00"}}', '2026-11-16 22:00'); -- false
--   select public.horario_esta_abierto('{"5":{"abierto":true,"desde":"18:00","hasta":"02:00"}}', '2026-11-21 01:00'); -- true (sábado de madrugada)
