-- KaseritaDelivery — migración inicial sobre el proyecto Supabase compartido con Kaserita.
-- Ejecutar manualmente en el SQL Editor de Supabase (no se corre desde este repo).
-- No modifica ninguna tabla ni política existente de Kaserita: solo agrega columnas,
-- una tabla nueva y dos vistas de solo lectura para el rol anon.

-- 1. Cada bodega decide si aparece en la vitrina pública, y necesita un slug para la URL.
alter table bodegas
  add column if not exists delivery_habilitado boolean not null default false;

alter table bodegas
  add column if not exists slug text unique;

-- 2. Vistas de solo lectura para anon. No se otorga acceso directo a bodegas/productos/
--    usuarios: las vistas exponen únicamente las columnas seguras, y solo de bodegas con
--    delivery_habilitado = true. precio_costo y los datos de usuarios (dni, auth_id,
--    telefono de cualquier rol que no sea dueño) nunca se exponen.

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
  and b.slug is not null;

create or replace view public.productos_delivery
with (security_invoker = false) as
select
  p.id,
  p.bodega_id,
  p.descripcion,
  p.categoria,
  p.foto_url,
  p.precio_venta,
  p.stock_actual
from productos p
join bodegas b on b.id = p.bodega_id
where b.delivery_habilitado = true;

grant select on public.bodegas_delivery to anon;
grant select on public.productos_delivery to anon;

-- 3. Carrito temporal detrás del código de referencia que la bodega ingresa en el POS.
create table if not exists pedidos_delivery (
  id uuid primary key default gen_random_uuid(),
  codigo_corto text not null unique,
  bodega_id uuid not null references bodegas(id),
  items jsonb not null,
  creado_en timestamptz not null default now(),
  usado boolean not null default false
);

create index if not exists pedidos_delivery_bodega_id_idx on pedidos_delivery (bodega_id);

alter table pedidos_delivery enable row level security;

-- Cualquiera puede crear un pedido (lo hace el cliente desde la vitrina, sin login),
-- pero solo puede insertar — nunca leer, actualizar ni borrar por esta vía.
create policy "anon puede crear pedidos_delivery"
  on pedidos_delivery for insert
  to anon
  with check (
    exists (
      select 1 from bodegas b
      where b.id = pedidos_delivery.bodega_id
        and b.delivery_habilitado = true
    )
  );

-- Solo la bodega dueña (vía su sesión autenticada en el POS) puede leer y marcar como
-- usado su propio pedido. Ajustar esta condición si Kaserita identifica la sesión de la
-- bodega de otra forma (por ejemplo auth.uid() contra usuarios.auth_id).
create policy "la bodega dueña puede leer sus pedidos_delivery"
  on pedidos_delivery for select
  to authenticated
  using (
    exists (
      select 1 from usuarios
      where usuarios.auth_id = auth.uid()
        and usuarios.bodega_id = pedidos_delivery.bodega_id
    )
  );

create policy "la bodega dueña puede marcar usados sus pedidos_delivery"
  on pedidos_delivery for update
  to authenticated
  using (
    exists (
      select 1 from usuarios
      where usuarios.auth_id = auth.uid()
        and usuarios.bodega_id = pedidos_delivery.bodega_id
    )
  )
  with check (
    exists (
      select 1 from usuarios
      where usuarios.auth_id = auth.uid()
        and usuarios.bodega_id = pedidos_delivery.bodega_id
    )
  );

-- 4. Pendiente manual: para probar la vitrina con la bodega demo (San Luis / DNI 99999001),
--    hay que ponerle un slug y habilitarla, por ejemplo:
-- update bodegas set slug = 'san-luis', delivery_habilitado = true
--   where id = '380f3079-3a93-4429-9c49-b93fde66f3e0';
