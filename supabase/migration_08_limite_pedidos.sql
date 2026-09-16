-- KaseritaDelivery — límite anti-spam para pedidos_delivery.
-- Ejecutar a mano en el SQL Editor de Supabase, después de migration_05.
--
-- Hallazgo: anon puede insertar en pedidos_delivery las veces que quiera,
-- sin CAPTCHA ni límite de velocidad. El trigger de migration_05 ya obliga
-- a que use productos y precios reales, así que no puede inventar datos --
-- pero sí puede generar pedidos "basura" en cadena contra una bodega
-- puntual, ensuciando la búsqueda de "Cargar Pedido" del cajero.
--
-- Esto agrega un límite simple: máximo 5 pedidos por IP de origen hacia la
-- misma bodega en 10 minutos. Se apoya en el header x-forwarded-for que
-- Supabase (vía su proxy) agrega a cada request -- no es infalible contra
-- alguien que rote de IP a propósito, pero frena scripts de spam simples
-- sin agregar un CAPTCHA (que requeriría integrar Cloudflare Turnstile u
-- otro servicio en el frontend). Si el abuso real supera esto, ese sería
-- el siguiente paso.

alter table pedidos_delivery
  add column if not exists ip_origen text;

create or replace function public.validar_pedido_delivery()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_items jsonb;
  v_item jsonb;
  v_producto record;
  v_cantidad numeric;
  v_ip text;
  v_pedidos_recientes int;
begin
  -- x-forwarded-for puede traer varias IPs separadas por coma (proxies
  -- encadenados); la primera es la del cliente real.
  v_ip := trim(split_part(
    coalesce(current_setting('request.headers', true)::json->>'x-forwarded-for', 'desconocida'),
    ',', 1
  ));

  select count(*) into v_pedidos_recientes
    from pedidos_delivery
    where bodega_id = new.bodega_id
      and ip_origen = v_ip
      and v_ip <> 'desconocida'
      and creado_en > now() - interval '10 minutes';

  if v_pedidos_recientes >= 5 then
    raise exception 'Demasiados pedidos seguidos. Esperá unos minutos e intentá de nuevo.';
  end if;

  if jsonb_typeof(new.items) is distinct from 'array' or jsonb_array_length(new.items) = 0 then
    raise exception 'El pedido no tiene productos.';
  end if;

  v_items := '[]'::jsonb;

  for v_item in select * from jsonb_array_elements(new.items)
  loop
    v_cantidad := (v_item->>'cantidad')::numeric;
    if v_cantidad is null or v_cantidad <= 0 or v_cantidad > 9999 then
      raise exception 'Cantidad inválida en el pedido.';
    end if;

    select id, descripcion, precio_venta into v_producto
      from productos
      where id = (v_item->>'id')::uuid
        and bodega_id = new.bodega_id;

    if v_producto.id is null then
      raise exception 'Uno de los productos del pedido ya no existe en esta bodega.';
    end if;

    -- Se reconstruye el item entero con los datos reales del producto --
    -- nunca se confía en descripcion/precio_venta que mandó el cliente.
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'id', v_producto.id,
      'descripcion', v_producto.descripcion,
      'precio_venta', v_producto.precio_venta,
      'cantidad', v_cantidad
    ));
  end loop;

  new.items := v_items;
  new.ip_origen := v_ip;
  return new;
end;
$$;

-- El trigger ya existe (creado en migration_05); create or replace de la
-- función alcanza, pero lo dejamos explícito por si algún día se borra.
drop trigger if exists validar_pedido_delivery_trigger on pedidos_delivery;
create trigger validar_pedido_delivery_trigger
  before insert on pedidos_delivery
  for each row
  execute function public.validar_pedido_delivery();
