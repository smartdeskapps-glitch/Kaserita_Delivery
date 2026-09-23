-- KaseritaDelivery — nombre del cliente en "Pedidos por retirar" del POS.
-- Ejecutar a mano en el SQL Editor de Supabase.
--
-- Para qué: la bodega (desde "Pedidos por retirar" en Kaserita) solo veía
-- el código corto del pedido, no quién lo hizo -- pedidos_seguimiento solo
-- guarda cliente_id, y RLS no deja que la bodega lea clientes_delivery
-- directo (esa tabla solo se lee a sí misma). Se agrega una columna
-- denormalizada, igual que se hizo con el nombre de bodega en
-- migration_16 pero al revés: se copia una sola vez al crear el
-- seguimiento (crear_seguimiento_pedido, ver migration_14), no se
-- resuelve con un join en cada lectura.

alter table pedidos_seguimiento
  add column if not exists cliente_nombre text;

-- Backfill de pedidos ya existentes (best-effort, corre una sola vez).
update pedidos_seguimiento ps
  set cliente_nombre = cd.nombre
  from clientes_delivery cd
  where cd.id = ps.cliente_id
    and ps.cliente_nombre is null;

-- El trigger que crea el seguimiento ahora también copia el nombre.
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
    insert into pedidos_seguimiento (cliente_id, bodega_id, codigo_corto, items, cliente_nombre)
    values (new.cliente_id, new.bodega_id, new.codigo_corto, new.items, v_nombre);
  end if;
  return new;
end;
$$;

NOTIFY pgrst, 'reload schema';
