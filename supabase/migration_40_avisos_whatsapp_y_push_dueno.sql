-- migration_40: (1) saber si el cliente tocó "Enviar por WhatsApp" y (2) avisos push al dueño
-- cuando entra un pedido. Ya está aplicada en producción; este archivo es el registro para
-- poder reconstruir la base. Se puede volver a correr sin problema.

-- 1) WhatsApp: WhatsApp no avisa si el mensaje se envió; solo se sabe si el cliente abrió el enlace.
alter table public.pedidos_seguimiento
  add column if not exists whatsapp_abierto_en timestamptz;

create or replace function public.marcar_whatsapp_abierto(p_codigo text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.pedidos_seguimiento
     set whatsapp_abierto_en = now()
   where codigo_corto = p_codigo
     and cliente_id = (select public.mi_cliente_delivery_id())
     and whatsapp_abierto_en is null;
$$;
revoke all on function public.marcar_whatsapp_abierto(text) from public, anon;
grant execute on function public.marcar_whatsapp_abierto(text) to authenticated;

-- 2) Celulares del dueño que reciben el aviso de pedido nuevo (uno por dispositivo).
create table if not exists public.push_dueno (
  id bigint generated always as identity primary key,
  bodega_id uuid not null references public.bodegas(id) on delete cascade,
  endpoint text not null unique,
  suscripcion jsonb not null,
  creado timestamptz not null default now()
);
create index if not exists push_dueno_bodega_idx on public.push_dueno (bodega_id);
alter table public.push_dueno enable row level security;
revoke all on public.push_dueno from anon;

drop policy if exists push_dueno_select on public.push_dueno;
create policy push_dueno_select on public.push_dueno for select to authenticated
  using (bodega_id = (select public.mi_bodega_id()));
drop policy if exists push_dueno_delete on public.push_dueno;
create policy push_dueno_delete on public.push_dueno for delete to authenticated
  using (bodega_id = (select public.mi_bodega_id()));
-- Sin política de INSERT/UPDATE: el alta solo se hace con registrar_push_dueno (abajo).
drop policy if exists push_dueno_insert on public.push_dueno;
drop policy if exists push_dueno_update on public.push_dueno;

-- Solo se aceptan endpoints de los servicios push reales: la función de servidor le habla a esa
-- dirección, así que nunca puede ser una cualquiera.
create or replace function public.endpoint_push_valido(p_endpoint text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select coalesce(p_endpoint ~ '^https://(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]+\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9.-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)/[^\s]*$', false);
$$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'push_dueno_endpoint_valido') then
    alter table public.push_dueno
      add constraint push_dueno_endpoint_valido
      check (public.endpoint_push_valido(endpoint) and public.endpoint_push_valido(suscripcion->>'endpoint') and endpoint = suscripcion->>'endpoint');
  end if;
end $$;

-- Registra (o reasigna) el celular a la bodega de quien llama. El endpoint es secreto del
-- dispositivo: quien lo conoce es quien tiene ese celular, por eso se reasigna si antes era de otra bodega.
create or replace function public.registrar_push_dueno(p_suscripcion jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bodega uuid := (select public.mi_bodega_id());
  v_endpoint text := p_suscripcion->>'endpoint';
begin
  if v_bodega is null then
    raise exception 'Sin bodega';
  end if;
  if not public.endpoint_push_valido(v_endpoint) then
    raise exception 'Endpoint de notificaciones no válido';
  end if;
  delete from public.push_dueno where endpoint = v_endpoint;
  insert into public.push_dueno (bodega_id, endpoint, suscripcion) values (v_bodega, v_endpoint, p_suscripcion);
end;
$$;
revoke all on function public.registrar_push_dueno(jsonb) from public, anon;
grant execute on function public.registrar_push_dueno(jsonb) to authenticated;

-- Falta (a mano, en el Dashboard): Integrations > Database Webhooks > tabla pedidos_seguimiento,
-- evento Insert, función enviar-aviso-pedido-tienda, header x-webhook-secret. Ver INSTRUCCIONES_PUSH.md, paso 5.

-- 3) Lo mismo para los celulares de los clientes (avisos de "pedido listo" y de la tienda): el
-- endpoint que guarda cada cliente también debe ser de un servicio push real.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'clientes_delivery_push_endpoint_valido') then
    alter table public.clientes_delivery
      add constraint clientes_delivery_push_endpoint_valido
      check (push_subscription is null or public.endpoint_push_valido(push_subscription->>'endpoint'));
  end if;
end $$;
