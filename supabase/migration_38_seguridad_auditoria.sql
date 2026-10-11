-- ============================================================
-- Migración 38: arreglos de la auditoría de seguridad (2026-10-11).
-- Ejecutar todo de una vez en el SQL Editor de Supabase. Va dentro de
-- una transacción: si algo falla, no se aplica nada.
-- Idempotente: se puede volver a correr sin problema.
--
-- 1) Pedidos: solo clientes con sesión, tope de unidades por producto y
--    de pedidos pendientes por cliente. Antes una sola petición directa a
--    la API, sin cuenta, podía reservar todo el stock de una tienda
--    durante 2 horas (la tienda se veía agotada).
-- 2) reclamar_cuenta_bodega: mismo freno de 8 intentos por DNI que ya
--    tenía puede_reclamar_bodega (sin él se podía probar PIN tras PIN
--    contra una bodega recién creada que su dueño todavía no reclamó).
-- 3) actualizar_mi_delivery, actualizar_mi_entrega_domicilio y
--    avisar_a_mis_clientes usan mi_bodega_id(): una bodega desactivada o
--    vencida ya no puede cambiar su tienda ni mandar avisos. De paso se
--    arreglan las tildes rotas de los mensajes de avisar_a_mis_clientes.
-- 4) Se quita a anon/authenticated el permiso TRUNCATE (y REFERENCES,
--    TRIGGER), que no usa la app y saltea RLS.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1) Pedidos
-- ------------------------------------------------------------
-- La tienda solo deja pedir con sesión de Google, así que la política
-- para anon sobraba, y la de authenticated aceptaba cliente_id nulo.
drop policy if exists "anon puede crear pedidos_delivery" on public.pedidos_delivery;
drop policy if exists "cliente logueado puede crear pedidos_delivery" on public.pedidos_delivery;
create policy "cliente logueado puede crear pedidos_delivery" on public.pedidos_delivery
  for insert to authenticated
  with check (
    bodega_admite_pedido_delivery(bodega_id)
    and cliente_id is not null
    and cliente_id = mi_cliente_delivery_id()
  );

create or replace function public.validar_pedido_delivery()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  -- Topes anti abuso. Un pedido de bodega normal no se acerca a ninguno.
  c_max_unidades_por_item constant numeric := 50;
  c_max_pendientes_por_cliente constant int := 3;
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
  v_pendientes int;
begin
  new.creado_en := now();
  new.usado := false;
  if new.cliente_id is null then
    raise exception 'Inicia sesión para hacer tu pedido.';
  end if;
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
  perform pg_advisory_xact_lock(hashtext(new.bodega_id::text));
  select count(*) into v_pedidos_recientes
    from pedidos_delivery
    where bodega_id = new.bodega_id
      and ip_origen = v_ip
      and creado_en > now() - interval '10 minutes';
  if v_pedidos_recientes >= 5 then
    raise exception 'Demasiados pedidos seguidos. Espera unos minutos e intenta de nuevo.';
  end if;
  select count(*) into v_pedidos_recientes
    from pedidos_delivery
    where bodega_id = new.bodega_id
      and cliente_id = new.cliente_id
      and creado_en > now() - interval '10 minutes';
  if v_pedidos_recientes >= 5 then
    raise exception 'Demasiados pedidos seguidos. Espera unos minutos e intenta de nuevo.';
  end if;
  -- Pedidos del mismo cliente en esta tienda que todavía reservan stock
  -- (sin cobrar, de las últimas 2 horas y no cancelados).
  select count(*) into v_pendientes
    from pedidos_delivery p
    where p.bodega_id = new.bodega_id
      and p.cliente_id = new.cliente_id
      and p.usado = false
      and p.creado_en > now() - interval '2 hours'
      and not exists (
        select 1 from pedidos_seguimiento s
        where s.codigo_corto = p.codigo_corto and s.estado = 'cancelado'
      );
  if v_pendientes >= c_max_pendientes_por_cliente then
    raise exception 'Ya tienes % pedidos pendientes en esta tienda. Espera a que estén listos o cancela alguno antes de hacer otro.', v_pendientes;
  end if;
  select count(*) into v_pendientes
    from pedidos_delivery
    where bodega_id = new.bodega_id
      and usado = false
      and creado_en > now() - interval '2 hours';
  if v_pendientes >= 40 then
    raise exception 'Esta bodega tiene muchos pedidos pendientes en este momento. Intenta de nuevo en unos minutos.';
  end if;
  v_items := '[]'::jsonb;
  for v_item in select * from jsonb_array_elements(new.items)
  loop
    v_cantidad := (v_item->>'cantidad')::numeric;
    if v_cantidad is null or v_cantidad <= 0 or v_cantidad > 9999 then
      raise exception 'Cantidad inválida en el pedido.';
    end if;
    if v_item ? 'combo_id' then
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
      if v_cantidad > c_max_unidades_por_item then
        raise exception 'Puedes pedir hasta % unidades de "%" por pedido.', c_max_unidades_por_item, v_combo.nombre;
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
      if v_cantidad > c_max_unidades_por_item then
        raise exception 'Puedes pedir hasta % unidades de "%" por pedido.', c_max_unidades_por_item, v_producto.descripcion;
      end if;
      v_ids := v_ids || v_producto.id;
      if v_producto.stock_actual is not null then
        v_disponible := v_producto.stock_actual - stock_reservado_delivery(new.bodega_id, v_producto.id);
        if v_cantidad > v_disponible then
          raise exception 'No hay suficiente stock de "%".', v_producto.descripcion;
        end if;
      end if;
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
$function$;

-- ------------------------------------------------------------
-- 2) reclamar_cuenta_bodega con freno de intentos
-- ------------------------------------------------------------
create or replace function public.reclamar_cuenta_bodega(p_dni text, p_pin text)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_id uuid;
  v_bodega uuid;
  v_bloqueado_hasta timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Sesión requerida.';
  end if;

  -- Mismo contador que puede_reclamar_bodega (tabla intentos_reclamo_pin):
  -- 8 fallos seguidos para un DNI lo bloquean 15 minutos.
  select bloqueado_hasta into v_bloqueado_hasta from intentos_reclamo_pin where dni = p_dni;
  if v_bloqueado_hasta is not null and v_bloqueado_hasta > now() then
    raise exception 'Demasiados intentos. Espera unos minutos e intenta de nuevo.';
  end if;

  select id, bodega_id into v_id, v_bodega from usuarios
    where dni = p_dni and pin_acceso = p_pin and auth_id is null
    limit 1;
  if v_id is null then
    insert into intentos_reclamo_pin (dni, intentos, bloqueado_hasta)
    values (p_dni, 1, null)
    on conflict (dni) do update set
      intentos = intentos_reclamo_pin.intentos + 1,
      bloqueado_hasta = case
        when intentos_reclamo_pin.intentos + 1 >= 8 then now() + interval '15 minutes'
        else intentos_reclamo_pin.bloqueado_hasta
      end;
    return null;
  end if;

  delete from intentos_reclamo_pin where dni = p_dni;
  update usuarios set auth_id = auth.uid(), pin_acceso = null where id = v_id;
  return v_bodega;
end;
$function$;

-- ------------------------------------------------------------
-- 3) Funciones de la tienda: solo bodegas activas y al día
-- ------------------------------------------------------------
create or replace function public.actualizar_mi_delivery(p_slug text, p_delivery_habilitado boolean, p_logo_url text default null::text, p_banner_url text default null::text, p_direccion text default null::text, p_horario_atencion jsonb default null::jsonb)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_bodega_id uuid;
  v_permitido boolean;
begin
  v_bodega_id := mi_bodega_id();
  if v_bodega_id is null then
    raise exception 'No autorizado.';
  end if;
  select delivery_permitido into v_permitido from bodegas where id = v_bodega_id;
  if p_delivery_habilitado and not coalesce(v_permitido, false) then
    raise exception 'Esta bodega todavía no tiene habilitados los Pedidos por WhatsApp. Contactá al administrador.';
  end if;
  update bodegas
    set slug = nullif(trim(p_slug), ''),
        delivery_habilitado = p_delivery_habilitado,
        logo_url = p_logo_url,
        banner_url = p_banner_url,
        direccion = nullif(trim(p_direccion), ''),
        horario_atencion = p_horario_atencion
    where id = v_bodega_id;
end;
$function$;

create or replace function public.actualizar_mi_entrega_domicilio(p_habilitado boolean, p_costo_envio numeric, p_pedido_minimo numeric, p_zona text default null::text, p_whatsapp_repartidor text default null::text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_bodega_id uuid;
  v_permitido boolean;
  v_wsp text;
begin
  v_bodega_id := mi_bodega_id();
  if v_bodega_id is null then
    raise exception 'No autorizado.';
  end if;
  select delivery_permitido into v_permitido from bodegas where id = v_bodega_id;
  if p_habilitado and not coalesce(v_permitido, false) then
    raise exception 'Esta bodega todavía no tiene habilitados los Pedidos por WhatsApp. Contactá al administrador.';
  end if;
  if p_costo_envio is null or p_costo_envio < 0 or p_costo_envio > 200 then
    raise exception 'El costo de envío debe estar entre 0 y 200.';
  end if;
  if p_pedido_minimo is null or p_pedido_minimo < 0 or p_pedido_minimo > 5000 then
    raise exception 'El pedido mínimo debe estar entre 0 y 5000.';
  end if;
  v_wsp := nullif(regexp_replace(coalesce(p_whatsapp_repartidor, ''), '\D', '', 'g'), '');
  if v_wsp is not null and length(v_wsp) not between 7 and 15 then
    raise exception 'El WhatsApp del repartidor no es válido.';
  end if;
  update bodegas
    set delivery_domicilio = coalesce(p_habilitado, false),
        costo_envio = p_costo_envio,
        pedido_minimo = p_pedido_minimo,
        zona_reparto = nullif(left(trim(coalesce(p_zona, '')), 120), ''),
        whatsapp_repartidor = v_wsp
    where id = v_bodega_id;
end;
$function$;

create or replace function public.avisar_a_mis_clientes()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_bodega_id uuid;
  v_habilitado boolean;
  v_permitido boolean;
  v_audiencia integer;
begin
  v_bodega_id := mi_bodega_id();
  if v_bodega_id is null then
    raise exception 'No autorizado.';
  end if;
  select delivery_habilitado, delivery_permitido into v_habilitado, v_permitido
    from bodegas where id = v_bodega_id;
  if not (coalesce(v_habilitado, false) and coalesce(v_permitido, false)) then
    raise exception 'Activa tu catálogo público antes de avisar a tus clientes.';
  end if;
  if exists (
    select 1 from avisos_tienda
    where bodega_id = v_bodega_id and origen = 'manual'
      and creado_en > now() - interval '7 days'
  ) then
    raise exception 'Ya avisaste a tus clientes hace poco. Podrás volver a hacerlo en unos días.';
  end if;
  select count(*) into v_audiencia
    from bodegas_visitadas bv
    join clientes_delivery c on c.id = bv.cliente_id
    where bv.bodega_id = v_bodega_id and bv.avisos and c.push_subscription is not null;
  if v_audiencia = 0 then
    raise exception 'Todavía no tienes clientes con avisos activados.';
  end if;
  insert into avisos_tienda (bodega_id, tipo, origen) values (v_bodega_id, 'manual', 'manual');
  return v_audiencia;
end;
$function$;

-- Ninguna de las dos se usa sin sesión.
revoke execute on function public.actualizar_mi_entrega_domicilio(boolean, numeric, numeric, text, text) from public, anon;
revoke execute on function public.avisar_a_mis_clientes() from public, anon;
grant execute on function public.actualizar_mi_entrega_domicilio(boolean, numeric, numeric, text, text) to authenticated;
grant execute on function public.avisar_a_mis_clientes() to authenticated;

-- ------------------------------------------------------------
-- 4) Sin TRUNCATE / REFERENCES / TRIGGER para anon y authenticated
-- ------------------------------------------------------------
revoke truncate, references, trigger on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke truncate, references, trigger on tables from anon, authenticated;

commit;

notify pgrst, 'reload schema';

-- ------------------------------------------------------------
-- Verificación: una sola tabla. "esperado" dice qué debería dar.
-- ------------------------------------------------------------
select 'pedidos_delivery: politicas de INSERT' as revision,
       string_agg(policyname || ' -> ' || roles::text, ' | ') as valor,
       'solo "cliente logueado..." -> {authenticated}' as esperado
from pg_policies
where schemaname = 'public' and tablename = 'pedidos_delivery' and cmd = 'INSERT'
union all
select 'validar_pedido_delivery tiene topes',
       (pg_get_functiondef('public.validar_pedido_delivery()'::regprocedure) ilike '%c_max_unidades_por_item%')::text,
       'true'
union all
select 'reclamar_cuenta_bodega cuenta intentos',
       (pg_get_functiondef('public.reclamar_cuenta_bodega(text, text)'::regprocedure) ilike '%intentos_reclamo_pin%')::text,
       'true'
union all
select 'funciones de la tienda usan mi_bodega_id()',
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname in ('actualizar_mi_delivery', 'actualizar_mi_entrega_domicilio', 'avisar_a_mis_clientes')
           and pg_get_functiondef(p.oid) ilike '%mi_bodega_id()%')::text,
       '3'
union all
select 'tildes de avisar_a_mis_clientes',
       (pg_get_functiondef('public.avisar_a_mis_clientes()'::regprocedure) like '%catálogo%')::text,
       'true (si sale false, el archivo se pegó con otra codificación)'
union all
select 'tablas con TRUNCATE para anon/authenticated',
       count(distinct table_name)::text,
       '0'
from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon', 'authenticated') and privilege_type = 'TRUNCATE';
