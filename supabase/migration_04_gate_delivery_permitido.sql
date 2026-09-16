-- KaseritaDelivery — exigir también delivery_permitido en las vistas públicas.
-- Ejecutar a mano en el SQL Editor de Supabase, después de
-- delivery_permitido.sql (repo Kaserita).
--
-- delivery_habilitado es el interruptor del propio dueño ("aparecer en el
-- catálogo público"); delivery_permitido es el permiso pago que solo el
-- super-admin otorga. Desde ahora Kaserita solo deja prender
-- delivery_habilitado si delivery_permitido ya es true (ver
-- actualizar_mi_delivery en delivery_permitido.sql), pero una bodega que
-- ya tenía delivery_habilitado=true de ANTES de que existiera este gate
-- se seguía mostrando en la vitrina sin el permiso pago. Esto lo cierra
-- por las dudas, en vez de depender solo de que el POS se porte bien.

create or replace view public.bodegas_delivery
with (security_invoker = false) as
select
  b.id as bodega_id,
  b.slug,
  b.nombre,
  u.telefono
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
where b.delivery_habilitado = true
  and b.delivery_permitido = true;
