-- KaseritaDelivery -- entrega a domicilio (el local reparte con su propio
-- repartidor). Ejecutar a mano en el SQL Editor de Supabase, despues de
-- migration_32.
--
-- Como funciona:
--   * El local activa "Entrega a domicilio" en Mi Link de Pedidos (POS) y
--     define costo de envio fijo, pedido minimo, zona y (opcional) el
--     WhatsApp de su repartidor.
--   * El cliente, al confirmar, elige "Retiro en tienda" o "A domicilio".
--     En domicilio manda su ubicacion (pin en el mapa o GPS), una
--     referencia, un telefono y como va a pagar al recibir.
--   * El pedido llega al POS con esos datos; el local lo reenvia por
--     WhatsApp a su repartidor y lo marca "En camino" -> "Entregado".
--
-- Seguridad: nada de lo importante lo decide el cliente. El costo de envio
-- se copia SIEMPRE desde la bodega en el servidor, el pedido minimo y que la
-- bodega admita domicilio se validan en un trigger, y el WhatsApp del
-- repartidor NO se expone en la vista publica (solo lo lee la propia bodega).
--
-- Es idempotente: se puede correr mas de una vez.

-- ============================================================
-- 1) Configuracion de la bodega
-- ============================================================

alter table public.bodegas
  add column if not exists delivery_domicilio boolean not null default false,
  add column if not exists costo_envio numeric(10,2) not null default 0,
  add column if not exists pedido_minimo numeric(10,2) not null default 0,
  add column if not exists zona_reparto text,
  add column if not exists whatsapp_repartidor text;

-- Expuesto al publico (vitrina): todo MENOS whatsapp_repartidor.
-- create or replace view solo deja agregar columnas al final.
create or replace view public.bodegas_delivery
with (security_invoker = true) as
select
  b.id as bodega_id,
  b.slug,
  b.nombre,
  u.telefono,
  b.logo_url,
  b.banner_url,
  b.direccion,
  b.horario_atencion,
  b.delivery_domicilio,
  b.costo_envio,
  b.pedido_minimo,
  b.zona_reparto
from bodegas b
left join lateral (
  select telefono
  from usuarios
  where usuarios.bodega_id = b.id
    and usuarios.rol = 'dueno'
    and usuarios.telefono is not null
  limit 1
) u on true
where b.delivery_habilitado = true
  and b.delivery_permitido = true
  and b.slug is not null;

drop function if exists public.obtener_bodega_delivery(text);

create function public.obtener_bodega_delivery(p_slug text)
returns table (
  bodega_id uuid,
  slug text,
  nombre text,
  telefono text,
  logo_url text,
  banner_url text,
  direccion text,
  horario_atencion jsonb,
  delivery_domicilio boolean,
  costo_envio numeric,
  pedido_minimo numeric,
  zona_reparto text
)
language sql
stable
security definer
set search_path = public
as $$
  select bodega_id, slug, nombre, telefono, logo_url, banner_url, direccion,
         horario_atencion, delivery_domicilio, costo_envio, pedido_minimo, zona_reparto
  from bodegas_delivery
  where slug = p_slug;
$$;

grant execute on function public.obtener_bodega_delivery(text) to anon;
grant execute on function public.obtener_bodega_delivery(text) to authenticated;

-- El dueño / cajero de la bodega guarda su configuracion de domicilio
-- (mismo criterio que actualizar_mi_delivery: solo su propia bodega).
drop function if exists public.actualizar_mi_entrega_domicilio(boolean, numeric, numeric, text, text);

create function public.actualizar_mi_entrega_domicilio(
  p_habilitado boolean,
  p_costo_envio numeric,
  p_pedido_minimo numeric,
  p_zona text default null,
  p_whatsapp_repartidor text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bodega_id uuid;
  v_permitido boolean;
  v_wsp text;
begin
  select bodega_id into v_bodega_id from usuarios where auth_id = auth.uid();
  if v_bodega_id is null then
    raise exception 'No autorizado.';
  end if;

  select delivery_permitido into v_permitido from bodegas where id = v_bodega_id;
  if p_habilitado and not coalesce(v_permitido, false) then
    raise exception 'Esta bodega todavía no tiene habilitados los Pedidos por WhatsApp. Contactá al administrador.';
  end if;

  if p_costo_envio is null or p_costo_envio < 0 or p_costo_envio > 200 then
    raise exception 'El costo de envío debe estar entre 0 y 200.';
  end if;
  if p_pedido_minimo is null or p_pedido_minimo < 0 or p_pedido_minimo > 5000 then
    raise exception 'El pedido mínimo debe estar entre 0 y 5000.';
  end if;

  v_wsp := nullif(regexp_replace(coalesce(p_whatsapp_repartidor, ''), '\D', '', 'g'), '');
  if v_wsp is not null and length(v_wsp) not between 7 and 15 then
    raise exception 'El WhatsApp del repartidor no es válido.';
  end if;

  update bodegas
    set delivery_domicilio = coalesce(p_habilitado, false),
        costo_envio = p_costo_envio,
        pedido_minimo = p_pedido_minimo,
        zona_reparto = nullif(left(trim(coalesce(p_zona, '')), 120), ''),
        whatsapp_repartidor = v_wsp
    where id = v_bodega_id;
end;
$$;

grant execute on function public.actualizar_mi_entrega_domicilio(boolean, numeric, numeric, text, text) to authenticated;

-- ============================================================
-- 2) Datos de entrega en el pedido (temporal) y en el seguimiento
-- ============================================================

alter table public.pedidos_delivery
  add column if not exists tipo_entrega text not null default 'retiro',
  add column if not exists entrega_lat double precision,
  add column if not exists entrega_lng double precision,
  add column if not exists entrega_referencia text,
  add column if not exists telefono_contacto text,
  add column if not exists costo_envio numeric(10,2) not null default 0,
  add column if not exists medio_pago text,
  add column if not exists paga_con numeric(10,2);

alter table public.pedidos_seguimiento
  add column if not exists tipo_entrega text not null default 'retiro',
  add column if not exists entrega_lat double precision,
  add column if not exists entrega_lng double precision,
  add column if not exists entrega_referencia text,
  add column if not exists telefono_contacto text,
  add column if not exists costo_envio numeric(10,2) not null default 0,
  add column if not exists medio_pago text,
  add column if not exists paga_con numeric(10,2);

-- Estado nuevo: 'en_camino' (el final sigue siendo 'retirado' para no
-- tocar el resto del sistema; en domicilio se muestra como "Entregado").
do $$
declare
  r record;
begin
  for r in
    select conname from pg_constraint
    where conrelid = 'public.pedidos_seguimiento'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%estado%'
  loop
    execute format('alter table public.pedidos_seguimiento drop constraint %I', r.conname);
  end loop;
end $$;

alter table public.pedidos_seguimiento
  add constraint pedidos_seguimiento_estado_check
  check (estado in ('pendiente', 'listo', 'en_camino', 'retirado', 'cancelado'));

-- ============================================================
-- 3) Validacion en el servidor de los datos de entrega
-- ============================================================
-- Nombre con "zz_" para que corra DESPUES de validar_pedido_delivery
-- (los triggers BEFORE corren en orden alfabetico): asi new.items ya viene
-- reconstruido con los precios reales y de ahi se calcula el subtotal.

create or replace function public.validar_entrega_pedido_delivery()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_domicilio boolean;
  v_costo numeric;
  v_minimo numeric;
  v_subtotal numeric;
begin
  if new.tipo_entrega is null or new.tipo_entrega not in ('retiro', 'domicilio') then
    raise exception 'Tipo de entrega inválido.';
  end if;

  if new.tipo_entrega = 'retiro' then
    new.entrega_lat := null;
    new.entrega_lng := null;
    new.entrega_referencia := null;
    new.telefono_contacto := null;
    new.costo_envio := 0;
    new.medio_pago := null;
    new.paga_con := null;
    return new;
  end if;

  select delivery_domicilio, costo_envio, pedido_minimo
    into v_domicilio, v_costo, v_minimo
    from bodegas where id = new.bodega_id;

  if not coalesce(v_domicilio, false) then
    raise exception 'Esta bodega no hace entregas a domicilio.';
  end if;

  if new.entrega_lat is null or new.entrega_lng is null
     or new.entrega_lat not between -90 and 90
     or new.entrega_lng not between -180 and 180 then
    raise exception 'Marcá en el mapa dónde querés recibir el pedido.';
  end if;

  new.entrega_referencia := left(trim(coalesce(new.entrega_referencia, '')), 200);
  if length(new.entrega_referencia) < 3 then
    raise exception 'Escribí una referencia de tu dirección (calle, número, piso, color de puerta).';
  end if;

  new.telefono_contacto := regexp_replace(coalesce(new.telefono_contacto, ''), '\D', '', 'g');
  if length(new.telefono_contacto) not between 7 and 15 then
    raise exception 'Ingresá un teléfono de contacto válido.';
  end if;

  if new.medio_pago is null or new.medio_pago not in ('efectivo', 'yape_plin', 'tarjeta') then
    raise exception 'Elegí cómo vas a pagar al recibir.';
  end if;
  if new.medio_pago <> 'efectivo' then
    new.paga_con := null;
  elsif new.paga_con is not null and (new.paga_con <= 0 or new.paga_con > 100000) then
    raise exception 'El monto con el que pagás no es válido.';
  end if;

  select coalesce(sum((i->>'precio_venta')::numeric * (i->>'cantidad')::numeric), 0)
    into v_subtotal
    from jsonb_array_elements(new.items) i;

  if v_subtotal < coalesce(v_minimo, 0) then
    raise exception 'El pedido mínimo para delivery es S/ %.', to_char(v_minimo, 'FM999990.00');
  end if;

  -- El costo de envio lo fija la bodega, nunca el cliente.
  new.costo_envio := coalesce(v_costo, 0);

  if new.paga_con is not null and new.paga_con < v_subtotal + new.costo_envio then
    raise exception 'Con el monto que indicaste no alcanza para pagar el pedido.';
  end if;

  return new;
end;
$$;

drop trigger if exists zz_validar_entrega_delivery_trigger on public.pedidos_delivery;
create trigger zz_validar_entrega_delivery_trigger
  before insert on public.pedidos_delivery
  for each row
  execute function public.validar_entrega_pedido_delivery();

-- ============================================================
-- 4) El seguimiento copia los datos de entrega ya validados
-- ============================================================

create or replace function public.crear_seguimiento_pedido()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_nombre text;
begin
  if new.cliente_id is not null then
    select nombre into v_nombre from clientes_delivery where id = new.cliente_id;
    insert into pedidos_seguimiento (
      cliente_id, bodega_id, codigo_corto, items, cliente_nombre,
      tipo_entrega, entrega_lat, entrega_lng, entrega_referencia,
      telefono_contacto, costo_envio, medio_pago, paga_con
    )
    values (
      new.cliente_id, new.bodega_id, new.codigo_corto, new.items, v_nombre,
      new.tipo_entrega, new.entrega_lat, new.entrega_lng, new.entrega_referencia,
      new.telefono_contacto, new.costo_envio, new.medio_pago, new.paga_con
    );
  end if;
  return new;
end;
$$;

-- ============================================================
-- 5) Estados: en camino
-- ============================================================

-- La bodega marca "en camino" (solo pedidos a domicilio).
create or replace function public.marcar_pedido_en_camino(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update pedidos_seguimiento
    set estado = 'en_camino', actualizado_en = now()
    where id = p_id
      and bodega_id = mi_bodega_id()
      and tipo_entrega = 'domicilio'
      and estado in ('pendiente', 'listo');
  if not found then
    raise exception 'No se pudo marcar el pedido como en camino.';
  end if;
end;
$$;

grant execute on function public.marcar_pedido_en_camino(uuid) to authenticated;

-- Cerrar el pedido (venta cobrada / entregado) tambien vale desde en_camino.
create or replace function public.marcar_pedido_retirado(p_codigo_corto text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update pedidos_seguimiento
    set estado = 'retirado', actualizado_en = now()
    where codigo_corto = p_codigo_corto
      and bodega_id = mi_bodega_id()
      and estado in ('pendiente', 'listo', 'en_camino');
end;
$$;

grant execute on function public.marcar_pedido_retirado(text) to authenticated;

-- La bodega puede cancelar tambien desde en_camino (el cliente no estaba, etc.).
create or replace function public.cancelar_seguimiento_pedido(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update pedidos_seguimiento
    set estado = 'cancelado', actualizado_en = now()
    where id = p_id
      and (
        (bodega_id = mi_bodega_id() and estado in ('pendiente', 'listo', 'en_camino'))
        -- el cliente ya no puede cancelar cuando el pedido va en camino
        or (cliente_id = mi_cliente_delivery_id() and estado in ('pendiente', 'listo'))
      );
  if not found then
    raise exception 'No se pudo cancelar el pedido.';
  end if;
end;
$$;

grant execute on function public.cancelar_seguimiento_pedido(uuid) to authenticated;

NOTIFY pgrst, 'reload schema';

-- Verificacion: deben aparecer el trigger y las 5 columnas nuevas de bodegas
select tgname from pg_trigger where tgname = 'zz_validar_entrega_delivery_trigger';
select column_name from information_schema.columns
 where table_schema = 'public' and table_name = 'bodegas'
   and column_name in ('delivery_domicilio', 'costo_envio', 'pedido_minimo', 'zona_reparto', 'whatsapp_repartidor');
