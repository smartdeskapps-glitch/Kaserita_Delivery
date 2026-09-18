-- KaseritaDelivery — registrar bodegas visitadas (no solo compradas).
-- Ejecutar a mano en el SQL Editor de Supabase, después de migration_19.
--
-- Hallazgo: "Mis tiendas" se armaba solo a partir de pedidos_seguimiento
-- (o sea, bodegas donde el cliente llegó a CONFIRMAR un pedido). Si un
-- cliente logueado solo entraba a mirar el catálogo de una bodega sin
-- llegar a pedir, esa bodega nunca aparecía en "Mis tiendas" -- lo cual
-- se sentía como que "desapareció", cuando en realidad nunca se guardó.
-- Esta tabla registra cualquier visita de un cliente logueado a una
-- bodega, se haya pedido algo o no.

create table if not exists bodegas_visitadas (
  cliente_id uuid not null references clientes_delivery(id) on delete cascade,
  bodega_id uuid not null references bodegas(id) on delete cascade,
  visto_en timestamptz not null default now(),
  primary key (cliente_id, bodega_id)
);

create index if not exists bodegas_visitadas_cliente_idx on bodegas_visitadas (cliente_id, visto_en desc);

alter table bodegas_visitadas enable row level security;

drop policy if exists "cliente lee sus bodegas visitadas" on bodegas_visitadas;
create policy "cliente lee sus bodegas visitadas"
  on bodegas_visitadas for select
  to authenticated
  using (cliente_id = mi_cliente_delivery_id());

drop policy if exists "cliente registra su visita" on bodegas_visitadas;
create policy "cliente registra su visita"
  on bodegas_visitadas for insert
  to authenticated
  with check (cliente_id = mi_cliente_delivery_id());

drop policy if exists "cliente actualiza su visita" on bodegas_visitadas;
create policy "cliente actualiza su visita"
  on bodegas_visitadas for update
  to authenticated
  using (cliente_id = mi_cliente_delivery_id())
  with check (cliente_id = mi_cliente_delivery_id());

NOTIFY pgrst, 'reload schema';
