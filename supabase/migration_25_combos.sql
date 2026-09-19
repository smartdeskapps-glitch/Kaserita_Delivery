-- KaseritaDelivery + Kaserita (POS) — combos: paquetes de varios productos
-- del catálogo a un precio especial, que sí descuentan el stock real de cada
-- producto que los compone (no llevan stock propio). Ejecutar a mano en el
-- SQL Editor de Supabase, después de migration_24.
--
-- Diseño (por qué así):
-- - Un combo NO es un producto nuevo: es una lista de productos existentes
--   + cantidad cada uno + un precio de bolsa. Por eso son dos tablas nuevas
--   (combos, combos_items) en vez de forzarlo dentro de "productos".
-- - Vender un combo en el POS (ver Kaserita/index.html, agregarComboAlCarrito
--   + expandirLineaCarrito) genera una línea de venta POR CADA producto que
--   lo compone (con el precio de bolsa repartido proporcional al precio de
--   cada uno), no una sola línea "Combo: X" con producto_id nulo -- así
--   anularVentaHoy() repone el stock de cada componente sin tocar ni una
--   línea de esa función, porque para ella es una venta de varios productos
--   como cualquier otra.
-- - Un pedido de Delivery puede traer un combo como { combo_id, cantidad }
--   en vez de { id, cantidad } -- validar_pedido_delivery() de abajo lo
--   reconoce y lo valida contra la tabla combos (nunca contra lo que mande
--   el cliente), igual que ya hace con productos.

-- ============================================================
-- 1) Tablas
-- ============================================================

create table if not exists public.combos (
  id uuid primary key default gen_random_uuid(),
  bodega_id uuid not null references bodegas(id) on delete cascade,
  nombre text not null,
  descripcion text,
  precio_venta numeric not null check (precio_venta > 0),
  activo boolean not null default true,
  creado_en timestamptz not null default now()
);

create table if not exists public.combos_items (
  id uuid primary key default gen_random_uuid(),
  bodega_id uuid not null references bodegas(id) on delete cascade,
  combo_id uuid not null references combos(id) on delete cascade,
  producto_id uuid not null references productos(id) on delete cascade,
  cantidad numeric not null check (cantidad > 0)
);

create index if not exists combos_bodega_idx on combos (bodega_id);
create index if not exists combos_items_combo_idx on combos_items (combo_id);
create index if not exists combos_items_producto_idx on combos_items (producto_id);

-- Traza qué venta (línea de ventas_detalle) vino de un combo, sin cambiar
-- cómo se lee/reporta ventas_detalle hoy (columna nueva, nullable).
alter table public.ventas_detalle
  add column if not exists combo_id uuid references combos(id) on delete set null;

-- ============================================================
-- 2) RLS (mismo patrón que el resto de tablas de Kaserita: scoped 1:1 a la
--    bodega del usuario autenticado, usando el helper mi_bodega_id() de
--    rls_migracion.sql en el repo de Kaserita).
-- ============================================================

alter table public.combos enable row level security;
alter table public.combos_items enable row level security;

drop policy if exists "combos_select" on combos;
drop policy if exists "combos_insert" on combos;
drop policy if exists "combos_update" on combos;
drop policy if exists "combos_delete" on combos;
create policy "combos_select" on combos for select using (bodega_id = mi_bodega_id());
create policy "combos_insert" on combos for insert with check (bodega_id = mi_bodega_id());
create policy "combos_update" on combos for update using (bodega_id = mi_bodega_id()) with check (bodega_id = mi_bodega_id());
create policy "combos_delete" on combos for delete using (bodega_id = mi_bodega_id());

drop policy if exists "combos_items_select" on combos_items;
drop policy if exists "combos_items_insert" on combos_items;
drop policy if exists "combos_items_update" on combos_items;
drop policy if exists "combos_items_delete" on combos_items;
create policy "combos_items_select" on combos_items for select using (bodega_id = mi_bodega_id());
create policy "combos_items_insert" on combos_items for insert with check (bodega_id = mi_bodega_id());
create policy "combos_items_update" on combos_items for update using (bodega_id = mi_bodega_id()) with check (bodega_id = mi_bodega_id());
create policy "combos_items_delete" on combos_items for delete using (bodega_id = mi_bodega_id());

-- ============================================================
-- 3) Vista + función pública para KaseritaDelivery (mismo patrón que
--    productos_delivery / obtener_productos_delivery de migration_22/13).
--    Trae cada combo con sus ítems ya armados en un jsonb (nombre y foto de
--    cada producto incluida, para poder mostrar "Incluye: ..." en la
--    tarjeta sin otra consulta).
-- ============================================================

create or replace view public.combos_delivery
with (security_invoker = true) as
select
  c.id,
  c.bodega_id,
  c.nombre,
  c.descripcion,
  c.precio_venta,
  (
    select jsonb_agg(jsonb_build_object(
      'producto_id', ci.producto_id,
      'descripcion', p.descripcion,
      'foto_url', p.foto_url,
      'cantidad', ci.cantidad
    ) order by ci.id)
    from combos_items ci
    join productos p on p.id = ci.producto_id
    where ci.combo_id = c.id
  ) as items
from combos c
join bodegas b on b.id = c.bodega_id
where c.activo = true
  and b.delivery_habilitado = true
  and b.delivery_permitido = true;

create or replace function public.obtener_combos_delivery(p_slug text)
returns table (
  id uuid,
  bodega_id uuid,
  nombre text,
  descripcion text,
  precio_venta numeric,
  items jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select cd.id, cd.bodega_id, cd.nombre, cd.descripcion, cd.precio_venta, cd.items
  from combos_delivery cd
  join bodegas b on b.id = cd.bodega_id
  where b.slug = p_slug;
$$;

grant execute on function public.obtener_combos_delivery(text) to anon;
grant execute on function public.obtener_combos_delivery(text) to authenticated;

-- ============================================================
-- 4) stock_reservado_delivery: ahora también cuenta lo reservado por
--    combos pendientes de cargar (un pedido con { combo_id, cantidad }
--    reserva cantidad_del_item × cantidad_del_producto_en_el_combo de cada
--    producto que lo compone). Sin esto, un combo pendiente no bajaba el
--    "stock_disponible" que ve otro cliente para esos productos, pudiendo
--    vendérselos dos veces.
-- ============================================================

create or replace function public.stock_reservado_delivery(p_bodega_id uuid, p_producto_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce((
      select sum((it->>'cantidad')::numeric)
      from pedidos_delivery p
      cross join lateral jsonb_array_elements(p.items) as it
      where p.bodega_id = p_bodega_id
        and p.usado = false
        and p.creado_en > now() - interval '2 hours'
        and it ? 'id'
        and (it->>'id')::uuid = p_producto_id
    ), 0)
    +
    coalesce((
      select sum((it->>'cantidad')::numeric * ci.cantidad)
      from pedidos_delivery p
      cross join lateral jsonb_array_elements(p.items) as it
      join combos_items ci on ci.combo_id = (it->>'combo_id')::uuid
      where p.bodega_id = p_bodega_id
        and p.usado = false
        and p.creado_en > now() - interval '2 hours'
        and it ? 'combo_id'
        and ci.producto_id = p_producto_id
    ), 0);
$$;

-- ============================================================
-- 5) validar_pedido_delivery: mismo cuerpo que migration_12 (el vigente),
--    con una rama nueva para ítems { combo_id, cantidad } -- se valida y
--    reconstruye contra la tabla combos (nunca contra lo que mande el
--    cliente), igual que ya hace con productos. El chequeo de stock del
--    combo mira cada producto que lo compone por separado, contra el mismo
--    stock_disponible que ya usa un ítem normal (no intenta reconciliar
--    demanda repetida de un mismo producto entre varias líneas del mismo
--    pedido -- ninguna validación de este trigger lo hacía antes tampoco).
-- ============================================================

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
