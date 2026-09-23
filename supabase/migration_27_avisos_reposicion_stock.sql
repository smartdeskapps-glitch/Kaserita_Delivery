-- KaseritaDelivery — "avisame cuando vuelva a haber stock" en productos
-- agotados. Ejecutar a mano en el SQL Editor de Supabase, después de
-- migration_26.
--
-- Mismo patrón que bodegas_visitadas (migration_20): tabla simple con RLS,
-- sin RPC -- el cliente lee/escribe sus propias filas directo desde el
-- frontend. El aviso en sí lo manda una Edge Function aparte (ver
-- supabase/functions/avisar-reposicion-stock/) disparada por un Database
-- Webhook sobre UPDATE de productos -- ese webhook no se puede crear por
-- SQL, los pasos manuales quedan en INSTRUCCIONES_PUSH.md.

create table if not exists avisos_reposicion (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references clientes_delivery(id) on delete cascade,
  producto_id uuid not null references productos(id) on delete cascade,
  bodega_id uuid not null references bodegas(id) on delete cascade,
  creado_en timestamptz not null default now(),
  unique (cliente_id, producto_id)
);

create index if not exists avisos_reposicion_producto_idx on avisos_reposicion (producto_id);
create index if not exists avisos_reposicion_cliente_idx on avisos_reposicion (cliente_id);

alter table avisos_reposicion enable row level security;

drop policy if exists "cliente lee sus avisos" on avisos_reposicion;
create policy "cliente lee sus avisos"
  on avisos_reposicion for select
  to authenticated
  using (cliente_id = mi_cliente_delivery_id());

drop policy if exists "cliente pide su aviso" on avisos_reposicion;
create policy "cliente pide su aviso"
  on avisos_reposicion for insert
  to authenticated
  with check (cliente_id = mi_cliente_delivery_id());

drop policy if exists "cliente cancela su aviso" on avisos_reposicion;
create policy "cliente cancela su aviso"
  on avisos_reposicion for delete
  to authenticated
  using (cliente_id = mi_cliente_delivery_id());

NOTIFY pgrst, 'reload schema';
