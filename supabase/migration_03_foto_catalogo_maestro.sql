-- KaseritaDelivery — mostrar la foto del Catálogo Maestro en la vitrina.
-- Ejecutar a mano en el SQL Editor de Supabase.
--
-- Kaserita (el POS) ya hace esto del lado del cliente: si un producto está
-- vinculado a una ficha del catálogo maestro (productos.catalogo_maestro_id),
-- su foto en vivo del maestro manda sobre la propia -- así una foto que se
-- suba después también les llega a las bodegas que ya tenían ese producto
-- (ver el .map() en cargarProductos, index.html de Kaserita). La vista
-- productos_delivery leía foto_url directo de productos y se perdía esa
-- foto para cualquier producto importado del maestro que nunca tuvo foto
-- propia. Este cambio hace lo mismo que el POS, pero en la vista.

create or replace view public.productos_delivery
with (security_invoker = false) as
select
  p.id,
  p.bodega_id,
  p.descripcion,
  p.categoria,
  coalesce(cm.foto_url, p.foto_url) as foto_url,
  p.precio_venta,
  p.stock_actual
from productos p
join bodegas b on b.id = p.bodega_id
left join catalogo_maestro cm on cm.id = p.catalogo_maestro_id
where b.delivery_habilitado = true;
