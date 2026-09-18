-- KaseritaDelivery — saca el SECURITY DEFINER de bodegas_delivery y
-- productos_delivery (hallazgo del linter de seguridad de Supabase).
-- Ejecutar a mano en el SQL Editor de Supabase.
--
-- Por qué estaban así: estas dos vistas leen de tablas con RLS activado
-- (usuarios, productos, bodegas) para que las funciones públicas
-- (obtener_bodega_delivery, obtener_productos_delivery, etc.) puedan
-- armar el catálogo. Se marcaron "security_invoker = false" para que la
-- vista se ejecute con los permisos de su dueño y no los de quien
-- pregunta (typicamente anon, sin acceso a esas tablas).
--
-- Por qué es seguro sacarlo ahora: esas dos vistas NUNCA se consultan
-- directas desde afuera -- el SELECT sobre ellas está revocado de anon
-- desde migration_06/07, y nunca se le dio a authenticated tampoco. Lo
-- único que las consulta son las funciones obtener_bodega_delivery,
-- obtener_productos_delivery y obtener_nombres_bodegas, que YA son
-- "security definer" -- mientras corren, Postgres ya las hace actuar
-- como su dueño (no como el que llamó a la función), así que una vista
-- con security_invoker = true consultada desde adentro de esas funciones
-- de todas formas ve el mundo con los permisos del dueño de la función,
-- no los del cliente anónimo original. El SECURITY DEFINER de la vista
-- era redundante, no una capa de seguridad real.

create or replace view public.bodegas_delivery
with (security_invoker = true) as
select
  b.id as bodega_id,
  b.slug,
  b.nombre,
  u.telefono,
  b.logo_url,
  b.banner_url,
  b.direccion
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
with (security_invoker = true) as
select
  p.id,
  p.bodega_id,
  p.descripcion,
  p.categoria,
  coalesce(cm.foto_url, p.foto_url) as foto_url,
  p.precio_venta,
  p.stock_actual,
  p.fotos_extra,
  p.descripcion_larga
from productos p
join bodegas b on b.id = p.bodega_id
left join catalogo_maestro cm on cm.id = p.catalogo_maestro_id
where b.delivery_habilitado = true
  and b.delivery_permitido = true;

NOTIFY pgrst, 'reload schema';
