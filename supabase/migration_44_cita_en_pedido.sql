-- ============================================================
-- Migración 44 (2026-10-19): la reserva de una barbería guarda su cita
-- (día, hora y barbero) en el pedido, para que el POS la muestre.
-- Ejecutar todo de una vez en el SQL Editor.
--
-- Antes la cita solo viajaba en el mensaje de WhatsApp: si el cliente no lo
-- enviaba, el local no sabía a qué hora venía.
--
-- 1) pedidos_delivery y pedidos_seguimiento ganan cita_fecha, cita_hora y
--    cita_barbero (todas opcionales; las bodegas no las usan).
-- 2) pedidos_delivery tiene permisos por columna: se dan INSERT/SELECT a las
--    tres nuevas (pedidos_seguimiento tiene permisos de tabla completa).
-- 3) Un disparador valida la cita: solo en barberías, día entre hoy y 60 días
--    (hora de Lima), hora HH:MM y barbero de hasta 80 caracteres. En una
--    bodega las tres columnas se vacían.
-- 4) crear_seguimiento_pedido copia la cita al seguimiento (que es lo que lee
--    el POS y "Mis pedidos" del cliente).
-- ============================================================

alter table public.pedidos_delivery  add column if not exists cita_fecha   date;
alter table public.pedidos_delivery  add column if not exists cita_hora    text;
alter table public.pedidos_delivery  add column if not exists cita_barbero text;
alter table public.pedidos_seguimiento add column if not exists cita_fecha   date;
alter table public.pedidos_seguimiento add column if not exists cita_hora    text;
alter table public.pedidos_seguimiento add column if not exists cita_barbero text;

grant insert (cita_fecha, cita_hora, cita_barbero) on public.pedidos_delivery to anon, authenticated;
grant select (cita_fecha, cita_hora, cita_barbero) on public.pedidos_delivery to anon, authenticated;

create or replace function public.validar_cita_pedido_delivery()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_hoy date := (now() at time zone 'America/Lima')::date;
begin
  if new.cita_fecha is null and new.cita_hora is null and new.cita_barbero is null then
    return new;
  end if;
  if not exists (select 1 from bodegas b where b.id = new.bodega_id and b.tipo_negocio = 'barberia') then
    new.cita_fecha := null;
    new.cita_hora := null;
    new.cita_barbero := null;
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
end;
$$;

drop trigger if exists validar_cita_pedido_delivery_trigger on public.pedidos_delivery;
create trigger validar_cita_pedido_delivery_trigger
before insert on public.pedidos_delivery
for each row
execute function public.validar_cita_pedido_delivery();

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
      cita_fecha, cita_hora, cita_barbero
    )
    values (
      new.cliente_id, new.bodega_id, new.codigo_corto, new.items, v_nombre,
      new.tipo_entrega, new.entrega_lat, new.entrega_lng, new.entrega_referencia,
      new.telefono_contacto, new.costo_envio, new.medio_pago, new.paga_con,
      new.cita_fecha, new.cita_hora, new.cita_barbero
    );
  end if;
  return new;
end;
$$;

notify pgrst, 'reload schema';
