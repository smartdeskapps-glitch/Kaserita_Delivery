-- KaseritaDelivery — stock disponible = stock real menos pedidos pendientes.
-- Ejecutar a mano en el SQL Editor de Supabase, después de migration_11.
--
-- 1. obtener_productos_delivery devolvía stock_actual (el número). La
--    vitrina solo lo usa para mostrar "Sin stock", así que ahora devuelve
--    hay_stock (boolean) y nadie con el link puede monitorear el
--    inventario exacto.
--
-- 2. hay_stock y el tope del trigger NO usan el stock real a secas: usan
--    stock_actual menos lo que ya está pedido en pedidos_delivery y todavía
--    nadie cargó en el POS (usado = false, menos de 2 horas). Así, si queda
--    1 unidad y un cliente la pide, el siguiente ya la ve como "Sin stock"
--    aunque el cajero todavía no haya cobrado. No se toca productos: el
--    stock real se descuenta recién al cobrar, y la "reserva" desaparece
--    sola cuando el pedido se carga, se elimina o vence a las 2 horas.
--
--    Costo de esto (aceptado por el dueño): alguien con el link puede
--    "reservar" unidades sin comprar, y durante hasta 2 horas se ven como
--    sin stock. El límite de 5 pedidos por IP cada 10 minutos lo acota.
--
-- 3. Dos pedidos exactamente simultáneos por la última unidad: el trigger
--    toma un lock por bodega (pg_advisory_xact_lock) así que se procesan
--    de a uno, y el segundo ya ve la reserva del primero.
--
-- 4. Regla para stock NULL: la bodega no lleva stock de ese producto =
--    siempre se puede pedir (igual que el POS, que no advierte en NULL).
--    Antes la vitrina lo mostraba "Sin stock" por accidente.
--
-- También se rechazan líneas repetidas del mismo producto, y los chequeos
-- baratos de formato van antes del COUNT del límite por IP.

create or replace function public.stock_reservado_delivery(p_bodega_id uuid, p_producto_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum((it->>'cantidad')::numeric), 0)
  from pedidos_delivery p
  cross join lateral jsonb_array_elements(p.items) as it
  where p.bodega_id = p_bodega_id
    and p.usado = false
    and p.creado_en > now() - interval '2 hours'
    and (it->>'id')::uuid = p_producto_id;
$$;

drop function if exists public.obtener_productos_delivery(text);

create function public.obtener_productos_delivery(p_slug text)
returns table (
  id uuid,
  bodega_id uuid,
  descripcion text,
  categoria text,
  foto_url text,
  precio_venta numeric,
  hay_stock boolean,
  fotos_extra text[],
  descripcion_larga text
)
language sql
stable
security definer
set search_path = public
as $$
  select pd.id, pd.bodega_id, pd.descripcion, pd.categoria, pd.foto_url, pd.precio_venta,
         (pd.stock_actual is null
          or pd.stock_actual - stock_reservado_delivery(pd.bodega_id, pd.id) > 0) as hay_stock,
         pd.fotos_extra, pd.descripcion_larga
  from productos_delivery pd
  join bodegas b on b.id = pd.bodega_id
  where b.slug = p_slug;
$$;

grant execute on function public.obtener_productos_delivery(text) to anon;

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
  v_disponible numeric;
  v_ids uuid[] := '{}';
  v_headers json;
  v_xff text;
  v_ip text;
  v_pedidos_recientes int;
begin
  -- Nada de esto lo decide el cliente.
  new.creado_en := now();
  new.usado := false;

  if new.codigo_corto is null or new.codigo_corto !~ '^[A-Z0-9]{4,12}$' then
    raise exception 'Código de pedido inválido.';
  end if;

  if jsonb_typeof(new.items) is distinct from 'array' or jsonb_array_length(new.items) = 0 then
    raise exception 'El pedido no tiene productos.';
  end if;

  if jsonb_array_length(new.items) > 50 then
    raise exception 'El pedido tiene demasiados productos distintos (máximo 50).';
  end if;

  v_headers := coalesce(current_setting('request.headers', true), '{}')::json;
  v_xff := v_headers->>'x-forwarded-for';
  v_ip := coalesce(
    nullif(trim(v_headers->>'cf-connecting-ip'), ''),
    nullif(trim(split_part(v_xff, ',', -1)), ''),
    'desconocida'
  );

  -- Un pedido a la vez por bodega: dos clientes pidiendo la última unidad
  -- al mismo tiempo se procesan en fila, y el segundo ve la reserva del
  -- primero. Se libera solo al terminar la transacción.
  perform pg_advisory_xact_lock(hashtext(new.bodega_id::text));

  select count(*) into v_pedidos_recientes
    from pedidos_delivery
    where bodega_id = new.bodega_id
      and ip_origen = v_ip
      and creado_en > now() - interval '10 minutes';

  if v_pedidos_recientes >= 5 then
    raise exception 'Demasiados pedidos seguidos. Esperá unos minutos e intentá de nuevo.';
  end if;

  v_items := '[]'::jsonb;

  for v_item in select * from jsonb_array_elements(new.items)
  loop
    v_cantidad := (v_item->>'cantidad')::numeric;
    if v_cantidad is null or v_cantidad <= 0 or v_cantidad > 9999 then
      raise exception 'Cantidad inválida en el pedido.';
    end if;

    select id, descripcion, precio_venta, stock_actual into v_producto
      from productos
      where id = (v_item->>'id')::uuid
        and bodega_id = new.bodega_id;

    if v_producto.id is null then
      raise exception 'Uno de los productos del pedido ya no existe en esta bodega.';
    end if;

    if v_producto.id = any(v_ids) then
      raise exception 'Hay un producto repetido en el pedido.';
    end if;
    v_ids := v_ids || v_producto.id;

    if v_producto.stock_actual is not null then
      v_disponible := v_producto.stock_actual - stock_reservado_delivery(new.bodega_id, v_producto.id);
      if v_cantidad > v_disponible then
        raise exception 'No hay suficiente stock de "%".', v_producto.descripcion;
      end if;
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
