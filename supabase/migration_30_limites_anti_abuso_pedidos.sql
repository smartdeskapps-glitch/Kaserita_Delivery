-- KaseritaDelivery -- protección adicional contra abuso de pedidos
-- (auditoría 2026-09-23). Ejecutar a mano en el SQL Editor de Supabase,
-- después de migration_25.
--
-- Lo que ya existía y NO cambia: precios/productos reales validados en el
-- servidor, stock reservado, máximo 50 líneas, cantidad máxima, código
-- corto con formato fijo, y 5 pedidos por IP y bodega cada 10 minutos.
--
-- Lo que se agrega (validar_pedido_delivery es la vigente de migration_25 más
-- estos dos frenos, que no dependen de la IP y por eso no se evaden rotándola):
--   1. Máximo 5 pedidos por cuenta de cliente y bodega cada 10 minutos.
--   2. Máximo 40 pedidos pendientes (sin retirar, de las últimas 2 horas)
--      por bodega. Si se llega, los clientes reciben un aviso de "muchos
--      pedidos pendientes" hasta que el cajero los procese.
--
-- Ajustar los números (5 y 40) en la función si una bodega real los supera.

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
  v_combo record;
  v_combo_item record;
  v_cantidad numeric;
  v_disponible numeric;
  v_ids uuid[] := '{}';
  v_headers json;
  v_xff text;
  v_ip text;
  v_pedidos_recientes int;
  v_pendientes int;
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

  -- Límite por cuenta: cambiar de IP (VPN, datos móviles) no evade este
  -- tope si el pedido viene de una cuenta de cliente.
  if new.cliente_id is not null then
    select count(*) into v_pedidos_recientes
      from pedidos_delivery
      where bodega_id = new.bodega_id
        and cliente_id = new.cliente_id
        and creado_en > now() - interval '10 minutes';

    if v_pedidos_recientes >= 5 then
      raise exception 'Demasiados pedidos seguidos. Esperá unos minutos e intentá de nuevo.';
    end if;
  end if;

  -- Tope de pedidos pendientes por bodega. Cada pedido pendiente reserva
  -- stock (stock_reservado_delivery), así que alguien que rote de IP podría
  -- "agotar" los productos de una bodega dejando pedidos sin retirar. Con
  -- este tope el daño máximo queda acotado hasta que el cajero los limpie o
  -- pasen las 2 horas de gracia.
  select count(*) into v_pendientes
    from pedidos_delivery
    where bodega_id = new.bodega_id
      and usado = false
      and creado_en > now() - interval '2 hours';

  if v_pendientes >= 40 then
    raise exception 'Esta bodega tiene muchos pedidos pendientes en este momento. Intentá de nuevo en unos minutos.';
  end if;

  v_items := '[]'::jsonb;

  for v_item in select * from jsonb_array_elements(new.items)
  loop
    v_cantidad := (v_item->>'cantidad')::numeric;
    if v_cantidad is null or v_cantidad <= 0 or v_cantidad > 9999 then
      raise exception 'Cantidad inválida en el pedido.';
    end if;

    if v_item ? 'combo_id' then
      -- ---- Ítem de combo ----
      select id, nombre, precio_venta into v_combo
        from combos
        where id = (v_item->>'combo_id')::uuid
          and bodega_id = new.bodega_id
          and activo = true;

      if v_combo.id is null then
        raise exception 'Uno de los combos del pedido ya no está disponible.';
      end if;

      if v_combo.id = any(v_ids) then
        raise exception 'Hay un combo repetido en el pedido.';
      end if;
      v_ids := v_ids || v_combo.id;

      for v_combo_item in
        select ci.producto_id, ci.cantidad as cantidad_base, p.descripcion, p.stock_actual
        from combos_items ci
        join productos p on p.id = ci.producto_id
        where ci.combo_id = v_combo.id
      loop
        if v_combo_item.stock_actual is not null then
          v_disponible := v_combo_item.stock_actual - stock_reservado_delivery(new.bodega_id, v_combo_item.producto_id);
          if (v_combo_item.cantidad_base * v_cantidad) > v_disponible then
            raise exception 'No hay suficiente stock de "%" para el combo "%".', v_combo_item.descripcion, v_combo.nombre;
          end if;
        end if;
      end loop;

      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'combo_id', v_combo.id,
        'descripcion', 'Combo: ' || v_combo.nombre,
        'precio_venta', v_combo.precio_venta,
        'cantidad', v_cantidad
      ));
    else
      -- ---- Ítem de producto normal (comportamiento sin cambios) ----
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
    end if;
  end loop;

  new.items := v_items;
  new.ip_origen := v_ip;
  return new;
end;
$$;

drop trigger if exists validar_pedido_delivery_trigger on pedidos_delivery;
create trigger validar_pedido_delivery_trigger
  before insert on pedidos_delivery
  for each row
  execute function public.validar_pedido_delivery();

NOTIFY pgrst, 'reload schema';
