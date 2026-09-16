-- KaseritaDelivery — validar pedidos_delivery.items contra los productos reales.
-- Ejecutar a mano en el SQL Editor de Supabase.
--
-- Hallazgo: el INSERT de anon en pedidos_delivery no valida el contenido de
-- "items" (un JSONB armado en el navegador del cliente). Alguien que llame
-- a la API REST directo (solo necesita la anon key, que es pública) podía
-- craftear un pedido con un precio falso o una cantidad inválida (0,
-- negativa) y dárselo a un cajero para que lo cargue. El precio real de
-- venta nunca se ve afectado (el POS siempre usa el precio actual del
-- producto, no el guardado en el pedido), pero la cantidad sí se usaba tal
-- cual, y el precio falso se mostraba en la vista previa antes de cargarlo.
--
-- Esto agrega un trigger que, en cada insert, recalcula "items" contra los
-- productos reales de esa bodega (descripción y precio_venta actuales,
-- ignorando lo que mande el cliente) y rechaza el pedido si algún item no
-- existe en esa bodega o tiene una cantidad inválida.

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
begin
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
  return new;
end;
$$;

drop trigger if exists validar_pedido_delivery_trigger on pedidos_delivery;
create trigger validar_pedido_delivery_trigger
  before insert on pedidos_delivery
  for each row
  execute function public.validar_pedido_delivery();
