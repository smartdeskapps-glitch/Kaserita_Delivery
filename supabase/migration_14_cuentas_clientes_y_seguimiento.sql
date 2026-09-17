-- KaseritaDelivery — cuentas de cliente + seguimiento de pedido con estado
-- (pendiente / listo / retirado / cancelado) + push cuando está listo.
-- Ejecutar a mano en el SQL Editor de Supabase, después de migration_13.
--
-- Diseño, para que quede claro qué se tocó y qué no:
--
-- * pedidos_delivery (el puente efímero código->carrito) NO cambia su
--   comportamiento para nadie que compre sin cuenta -- sigue siendo anon,
--   se sigue borrando al cargarlo o a las 2 horas. Solo se le agrega una
--   columna nueva (cliente_id, nullable) y una política de INSERT para el
--   rol authenticated, porque un cliente logueado ya no pega con la
--   anon key: su sesión de Supabase Auth pasa a ser "authenticated".
--
-- * Todo lo nuevo (cuenta, historial con estado) vive en dos tablas
--   nuevas -- clientes_delivery y pedidos_seguimiento -- separadas del
--   puente efímero, para no tocar nada de lo que ya se auditó ahí.
--
-- * El login de cliente reusa el mismo truco que ya usa Kaserita para los
--   cajeros (ver emailAuthDesdeDni/passwordAuthDesdePin en el POS): un
--   email sintético a partir del celular + el PIN como contraseña de
--   Supabase Auth. Nada de esto pasa por SMS ni WhatsApp.

-- ============================================================
-- 1) Cuenta de cliente
-- ============================================================

create table if not exists clientes_delivery (
  id uuid primary key default gen_random_uuid(),
  auth_id uuid unique references auth.users(id),
  nombre text not null,
  telefono text not null unique,
  push_subscription jsonb,
  creado_en timestamptz not null default now()
);

alter table clientes_delivery enable row level security;

drop policy if exists "cliente crea su propia cuenta" on clientes_delivery;
create policy "cliente crea su propia cuenta"
  on clientes_delivery for insert
  to authenticated
  with check (auth_id = auth.uid());

drop policy if exists "cliente lee su propia cuenta" on clientes_delivery;
create policy "cliente lee su propia cuenta"
  on clientes_delivery for select
  to authenticated
  using (auth_id = auth.uid());

drop policy if exists "cliente actualiza su propia cuenta" on clientes_delivery;
create policy "cliente actualiza su propia cuenta"
  on clientes_delivery for update
  to authenticated
  using (auth_id = auth.uid())
  with check (auth_id = auth.uid());

-- Sin política de SELECT para nadie más: ni anon, ni otra bodega, ni otro
-- cliente pueden leer el nombre/teléfono de esta tabla.

create or replace function public.mi_cliente_delivery_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from clientes_delivery where auth_id = auth.uid();
$$;

grant execute on function public.mi_cliente_delivery_id() to authenticated;

-- ============================================================
-- 1.5) Un cliente logueado ya no pega con la anon key -- su sesión de
--      Supabase Auth pasa a usar el rol authenticated. Los RPC públicos
--      que ya existían solo tenían grant para anon; sin esto, cualquiera
--      logueado dejaría de poder ver el catálogo o crear un pedido.
-- ============================================================

grant execute on function public.obtener_bodega_delivery(text) to authenticated;
grant execute on function public.obtener_productos_delivery(text) to authenticated;
grant execute on function public.bodega_admite_pedido_delivery(uuid) to authenticated;

-- ============================================================
-- 2) pedidos_delivery: columna nueva + política para clientes logueados
-- ============================================================

alter table pedidos_delivery
  add column if not exists cliente_id uuid references clientes_delivery(id);

drop policy if exists "cliente logueado puede crear pedidos_delivery" on pedidos_delivery;
create policy "cliente logueado puede crear pedidos_delivery"
  on pedidos_delivery for insert
  to authenticated
  with check (
    bodega_admite_pedido_delivery(bodega_id)
    and (cliente_id is null or cliente_id = mi_cliente_delivery_id())
  );

-- ============================================================
-- 3) Seguimiento persistente (esto SÍ sobrevive más de 2 horas)
-- ============================================================

create table if not exists pedidos_seguimiento (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references clientes_delivery(id),
  bodega_id uuid not null references bodegas(id),
  codigo_corto text not null,
  items jsonb not null,
  estado text not null default 'pendiente' check (estado in ('pendiente', 'listo', 'retirado', 'cancelado')),
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

create index if not exists pedidos_seguimiento_cliente_idx on pedidos_seguimiento (cliente_id, creado_en desc);
create index if not exists pedidos_seguimiento_bodega_idx on pedidos_seguimiento (bodega_id, estado);

alter table pedidos_seguimiento enable row level security;

drop policy if exists "cliente lee su seguimiento" on pedidos_seguimiento;
create policy "cliente lee su seguimiento"
  on pedidos_seguimiento for select
  to authenticated
  using (cliente_id = mi_cliente_delivery_id());

drop policy if exists "bodega lee su seguimiento" on pedidos_seguimiento;
create policy "bodega lee su seguimiento"
  on pedidos_seguimiento for select
  to authenticated
  using (bodega_id = mi_bodega_id());

-- Sin política de UPDATE/DELETE directa para nadie: todo cambio de estado
-- pasa por las funciones de abajo, así queda controlado qué transición es
-- válida y quién la puede hacer -- mismo motivo que ya usa el proyecto
-- para bodegas.delivery_habilitado (ver actualizar_mi_delivery).

-- Se llena solo: el BEFORE INSERT de pedidos_delivery (validar_pedido_delivery)
-- ya corrió y dejó new.items reconstruido con los datos reales del
-- producto -- este trigger corre DESPUÉS y copia ese resultado ya
-- validado, nunca lo que mandó el cliente.
create or replace function public.crear_seguimiento_pedido()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.cliente_id is not null then
    insert into pedidos_seguimiento (cliente_id, bodega_id, codigo_corto, items)
    values (new.cliente_id, new.bodega_id, new.codigo_corto, new.items);
  end if;
  return new;
end;
$$;

drop trigger if exists crear_seguimiento_pedido_trigger on pedidos_delivery;
create trigger crear_seguimiento_pedido_trigger
  after insert on pedidos_delivery
  for each row
  execute function public.crear_seguimiento_pedido();

-- ============================================================
-- 4) Cambios de estado, solo por función
-- ============================================================

-- La bodega marca "listo" desde la pantalla nueva del POS.
create or replace function public.marcar_pedido_listo(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update pedidos_seguimiento
    set estado = 'listo', actualizado_en = now()
    where id = p_id
      and bodega_id = mi_bodega_id()
      and estado = 'pendiente';
  if not found then
    raise exception 'No se pudo marcar el pedido como listo.';
  end if;
end;
$$;

grant execute on function public.marcar_pedido_listo(uuid) to authenticated;

-- Se llama sola desde "Cargar Pedido" cuando el cajero efectivamente cobra
-- y entrega -- no es un botón aparte, es la misma acción que ya existe.
-- No falla si no hay seguimiento (pedido sin cuenta de cliente): es
-- best-effort, un 0-filas ahí es normal.
create or replace function public.marcar_pedido_retirado(p_codigo_corto text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update pedidos_seguimiento
    set estado = 'retirado', actualizado_en = now()
    where codigo_corto = p_codigo_corto
      and bodega_id = mi_bodega_id()
      and estado in ('pendiente', 'listo');
end;
$$;

grant execute on function public.marcar_pedido_retirado(text) to authenticated;

-- La bodega (desde "Pedidos por retirar") o el propio cliente (desde "Mis
-- pedidos") pueden cancelar un pedido que todavía no se retiró.
create or replace function public.cancelar_seguimiento_pedido(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update pedidos_seguimiento
    set estado = 'cancelado', actualizado_en = now()
    where id = p_id
      and estado in ('pendiente', 'listo')
      and (bodega_id = mi_bodega_id() or cliente_id = mi_cliente_delivery_id());
  if not found then
    raise exception 'No se pudo cancelar el pedido.';
  end if;
end;
$$;

grant execute on function public.cancelar_seguimiento_pedido(uuid) to authenticated;

-- ============================================================
-- 5) Guardar/actualizar la suscripción push del cliente
-- ============================================================
-- No hace falta una función aparte: ya cubre esto la política de UPDATE
-- de clientes_delivery de la sección 1 (auth_id = auth.uid()). El
-- frontend hace un simple .update({ push_subscription: ... }).
