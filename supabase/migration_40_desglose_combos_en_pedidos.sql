-- ============================================================
-- Migración 40 (2026-10-11): desglose de combos en los pedidos.
-- Ejecutar todo de una vez en el SQL Editor.
--
-- validar_pedido_delivery() guarda, en cada combo del pedido, la lista de
-- productos que lo forman ("componentes": descripción y cantidad por combo).
-- El POS la muestra en "Pedidos por retirar" y en el mensaje al repartidor.
-- Es la misma función de la migración 38 con solo ese agregado. Los pedidos
-- anteriores no tienen el desglose: el POS lo arma con el combo actual.
-- ============================================================

create or replace function public.validar_pedido_delivery()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  -- Topes anti abuso. Un pedido de bodega normal no se acerca a ninguno.
  c_max_unidades_por_item constant numeric := 50;
  c_max_pendientes_por_cliente constant int := 3;
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
  v_componentes jsonb;
begin
  new.creado_en := now();
  new.usado := false;
  if new.cliente_id is null then
    raise exception 'Inicia sesión para hacer tu pedido.';
  end if;
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
  perform pg_advisory_xact_lock(hashtext(new.bodega_id::text));
  select count(*) into v_pedidos_recientes
    from pedidos_delivery
    where bodega_id = new.bodega_id
      and ip_origen = v_ip
      and creado_en > now() - interval '10 minutes';
  if v_pedidos_recientes >= 5 then
    raise exception 'Demasiados pedidos seguidos. Espera unos minutos e intenta de nuevo.';
  end if;
  select count(*) into v_pedidos_recientes
    from pedidos_delivery
    where bodega_id = new.bodega_id
      and cliente_id = new.cliente_id
      and creado_en > now() - interval '10 minutes';
  if v_pedidos_recientes >= 5 then
    raise exception 'Demasiados pedidos seguidos. Espera unos minutos e intenta de nuevo.';
  end if;
  -- Pedidos del mismo cliente en esta tienda que todavía reservan stock
  -- (sin cobrar, de las últimas 2 horas y no cancelados).
  select count(*) into v_pendientes
    from pedidos_delivery p
    where p.bodega_id = new.bodega_id
      and p.cliente_id = new.cliente_id
      and p.usado = false
      and p.creado_en > now() - interval '2 hours'
      and not exists (
        select 1 from pedidos_seguimiento s
        where s.codigo_corto = p.codigo_corto and s.estado = 'cancelado'
      );
  if v_pendientes >= c_max_pendientes_por_cliente then
    raise exception 'Ya tienes % pedidos pendientes en esta tienda. Espera a que estén listos o cancela alguno antes de hacer otro.', v_pendientes;
  end if;
  select count(*) into v_pendientes
    from pedidos_delivery
    where bodega_id = new.bodega_id
      and usado = false
      and creado_en > now() - interval '2 hours';
  if v_pendientes >= 40 then
    raise exception 'Esta bodega tiene muchos pedidos pendientes en este momento. Intenta de nuevo en unos minutos.';
  end if;
  v_items := '[]'::jsonb;
  for v_item in select * from jsonb_array_elements(new.items)
  loop
    v_cantidad := (v_item->>'cantidad')::numeric;
    if v_cantidad is null or v_cantidad <= 0 or v_cantidad > 9999 then
      raise exception 'Cantidad inválida en el pedido.';
    end if;
    if v_item ? 'combo_id' then
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
      if v_cantidad > c_max_unidades_por_item then
        raise exception 'Puedes pedir hasta % unidades de "%" por pedido.', c_max_unidades_por_item, v_combo.nombre;
      end if;
      v_ids := v_ids || v_combo.id;
      v_componentes := '[]'::jsonb;
      for v_combo_item in
        select ci.producto_id, ci.cantidad as cantidad_base, p.descripcion, p.stock_actual
        from combos_items ci
        join productos p on p.id = ci.producto_id
        where ci.combo_id = v_combo.id
        order by ci.id
      loop
        -- Desglose del combo guardado en el pedido: el cajero ve qué productos
        -- son, aunque el combo se edite después.
        v_componentes := v_componentes || jsonb_build_array(jsonb_build_object(
          'producto_id', v_combo_item.producto_id,
          'descripcion', v_combo_item.descripcion,
          'cantidad', v_combo_item.cantidad_base
        ));
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
        'cantidad', v_cantidad,
        'componentes', v_componentes
      ));
    else
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
      if v_cantidad > c_max_unidades_por_item then
        raise exception 'Puedes pedir hasta % unidades de "%" por pedido.', c_max_unidades_por_item, v_producto.descripcion;
      end if;
      v_ids := v_ids || v_producto.id;
      if v_producto.stock_actual is not null then
        v_disponible := v_producto.stock_actual - stock_reservado_delivery(new.bodega_id, v_producto.id);
        if v_cantidad > v_disponible then
          raise exception 'No hay suficiente stock de "%".', v_producto.descripcion;
        end if;
      end if;
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
$function$;

-- Verificación: debe dar true.
select pg_get_functiondef('public.validar_pedido_delivery()'::regprocedure) ilike '%componentes%' as guarda_desglose_de_combos;
