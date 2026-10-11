-- ============================================================
-- Migración 39 (2026-10-11). Ejecutar todo de una vez en el SQL Editor.
-- Va dentro de una transacción: si algo falla, no se aplica nada.
-- Idempotente: se puede volver a correr sin problema.
--
-- 1) Cancelar un pedido libera su stock en el momento. Antes el pedido
--    cancelado seguía en pedidos_delivery sin usar y reservaba stock
--    hasta 2 horas.
-- 2) La tienda de una bodega desactivada o con la suscripción vencida se
--    ve cerrada: obtener_bodega_delivery devuelve "abierta = false", no
--    lista productos ni combos y no acepta pedidos.
-- 3) Mensajes en "tú" (antes en "vos") en las funciones que ve el
--    cliente de la tienda y el dueño en el POS.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1) Cancelar libera el stock
-- ------------------------------------------------------------
create or replace function public.cancelar_seguimiento_pedido(p_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_bodega uuid;
  v_codigo text;
begin
  update pedidos_seguimiento
    set estado = 'cancelado', actualizado_en = now()
    where id = p_id
      and (
        (bodega_id = mi_bodega_id() and estado in ('pendiente', 'listo', 'en_camino'))
        -- el cliente ya no puede cancelar cuando el pedido va en camino
        or (cliente_id = mi_cliente_delivery_id() and estado in ('pendiente', 'listo'))
      )
    returning bodega_id, codigo_corto into v_bodega, v_codigo;
  if not found then
    raise exception 'No se pudo cancelar el pedido.';
  end if;
  -- El pedido sin cobrar es lo que reserva el stock (stock_reservado_delivery).
  delete from pedidos_delivery
    where bodega_id = v_bodega and codigo_corto = v_codigo and usado = false;
end;
$function$;

-- Los que ya estaban cancelados y todavía reservaban stock.
delete from public.pedidos_delivery p
  where p.usado = false
    and exists (
      select 1 from public.pedidos_seguimiento s
      where s.codigo_corto = p.codigo_corto
        and s.bodega_id = p.bodega_id
        and s.estado = 'cancelado'
    );

-- ------------------------------------------------------------
-- 2) Tienda cerrada si la bodega no está activa y al día
-- ------------------------------------------------------------
-- Misma condición que mi_bodega_id(): activa y sin vencer.
create or replace view public.bodegas_delivery with (security_invoker = true) as
  select b.id as bodega_id, b.slug, b.nombre, u.telefono, b.logo_url, b.banner_url, b.direccion,
         b.horario_atencion, b.delivery_domicilio, b.costo_envio, b.pedido_minimo, b.zona_reparto,
         (b.activa = true and (b.activa_hasta is null or b.activa_hasta >= current_date)) as abierta
  from bodegas b
  left join lateral (
    select usuarios.telefono from usuarios
    where usuarios.bodega_id = b.id and usuarios.rol = 'dueno' and usuarios.telefono is not null
    limit 1
  ) u on true
  where b.delivery_habilitado = true and b.delivery_permitido = true and b.slug is not null;

create or replace view public.productos_delivery with (security_invoker = true) as
  select p.id, p.bodega_id, p.descripcion, p.categoria, coalesce(cm.foto_url, p.foto_url) as foto_url,
         p.precio_venta, p.stock_actual, p.fotos_extra, p.descripcion_larga, p.es_destacado
  from productos p
  join bodegas b on b.id = p.bodega_id
  left join catalogo_maestro cm on cm.id = p.catalogo_maestro_id
  where b.delivery_habilitado = true and b.delivery_permitido = true
    and b.activa = true and (b.activa_hasta is null or b.activa_hasta >= current_date);

create or replace view public.combos_delivery with (security_invoker = true) as
  select c.id, c.bodega_id, c.nombre, c.descripcion, c.precio_venta,
         (select jsonb_agg(jsonb_build_object('producto_id', ci.producto_id, 'descripcion', p.descripcion,
                                              'foto_url', p.foto_url, 'cantidad', ci.cantidad) order by ci.id)
            from combos_items ci join productos p on p.id = ci.producto_id
            where ci.combo_id = c.id) as items
  from combos c
  join bodegas b on b.id = c.bodega_id
  where c.activo = true and b.delivery_habilitado = true and b.delivery_permitido = true
    and b.activa = true and (b.activa_hasta is null or b.activa_hasta >= current_date);

create or replace function public.bodega_admite_pedido_delivery(p_bodega_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select exists (
    select 1 from bodegas b
    where b.id = p_bodega_id
      and b.delivery_habilitado = true
      and b.delivery_permitido = true
      and b.activa = true
      and (b.activa_hasta is null or b.activa_hasta >= current_date)
  );
$function$;

-- Cambia lo que devuelve (agrega "abierta"), por eso hay que borrarla y crearla.
drop function if exists public.obtener_bodega_delivery(text);
create function public.obtener_bodega_delivery(p_slug text)
 returns table(bodega_id uuid, slug text, nombre text, telefono text, logo_url text, banner_url text,
               direccion text, horario_atencion jsonb, delivery_domicilio boolean, costo_envio numeric,
               pedido_minimo numeric, zona_reparto text, abierta boolean)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select bodega_id, slug, nombre, telefono, logo_url, banner_url, direccion,
         horario_atencion, delivery_domicilio, costo_envio, pedido_minimo, zona_reparto, abierta
  from bodegas_delivery
  where slug = p_slug;
$function$;
revoke execute on function public.obtener_bodega_delivery(text) from public;
grant execute on function public.obtener_bodega_delivery(text) to anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 3) Mensajes en "tú"
-- ------------------------------------------------------------
create or replace function public.validar_entrega_pedido_delivery()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_domicilio boolean;
  v_costo numeric;
  v_minimo numeric;
  v_subtotal numeric;
begin
  if new.tipo_entrega is null or new.tipo_entrega not in ('retiro', 'domicilio') then
    raise exception 'Tipo de entrega inválido.';
  end if;
  if new.tipo_entrega = 'retiro' then
    new.entrega_lat := null;
    new.entrega_lng := null;
    new.entrega_referencia := null;
    new.telefono_contacto := null;
    new.costo_envio := 0;
    new.medio_pago := null;
    new.paga_con := null;
    return new;
  end if;
  select delivery_domicilio, costo_envio, pedido_minimo
    into v_domicilio, v_costo, v_minimo
    from bodegas where id = new.bodega_id;
  if not coalesce(v_domicilio, false) then
    raise exception 'Esta bodega no hace entregas a domicilio.';
  end if;
  if new.entrega_lat is null or new.entrega_lng is null
     or new.entrega_lat not between -90 and 90
     or new.entrega_lng not between -180 and 180 then
    raise exception 'Marca en el mapa dónde quieres recibir el pedido.';
  end if;
  new.entrega_referencia := left(trim(coalesce(new.entrega_referencia, '')), 200);
  if length(new.entrega_referencia) < 3 then
    raise exception 'Escribe una referencia de tu dirección (calle, número, piso, color de puerta).';
  end if;
  new.telefono_contacto := regexp_replace(coalesce(new.telefono_contacto, ''), '\D', '', 'g');
  if length(new.telefono_contacto) not between 7 and 15 then
    raise exception 'Ingresa un teléfono de contacto válido.';
  end if;
  if new.medio_pago is null or new.medio_pago not in ('efectivo', 'yape_plin', 'tarjeta') then
    raise exception 'Elige cómo vas a pagar al recibir.';
  end if;
  if new.medio_pago <> 'efectivo' then
    new.paga_con := null;
  elsif new.paga_con is not null and (new.paga_con <= 0 or new.paga_con > 100000) then
    raise exception 'El monto con el que pagas no es válido.';
  end if;
  select coalesce(sum((i->>'precio_venta')::numeric * (i->>'cantidad')::numeric), 0)
    into v_subtotal
    from jsonb_array_elements(new.items) i;
  if v_subtotal < coalesce(v_minimo, 0) then
    raise exception 'El pedido mínimo para delivery es S/ %.', to_char(v_minimo, 'FM999990.00');
  end if;
  new.costo_envio := coalesce(v_costo, 0);
  if new.paga_con is not null and new.paga_con < v_subtotal + new.costo_envio then
    raise exception 'Con el monto que indicaste no alcanza para pagar el pedido.';
  end if;
  return new;
end;
$function$;

create or replace function public.eliminar_mi_cuenta()
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'auth'
as $function$
declare
  v_uid uuid := auth.uid();
  v_cliente uuid;
begin
  if v_uid is null then
    raise exception 'Tienes que iniciar sesión para eliminar tu cuenta.';
  end if;
  if exists (select 1 from public.usuarios where auth_id = v_uid) then
    raise exception 'Esta cuenta pertenece a una bodega y no se puede eliminar desde Delivery.';
  end if;
  select id into v_cliente from public.clientes_delivery where auth_id = v_uid;
  if v_cliente is not null then
    if exists (
      select 1 from public.pedidos_seguimiento
      where cliente_id = v_cliente and estado in ('pendiente', 'listo', 'en_camino')
    ) then
      raise exception 'Tienes un pedido en curso. Espera a que termine (o cancélalo) antes de eliminar tu cuenta.';
    end if;
    delete from public.pedidos_delivery where cliente_id = v_cliente;
    delete from public.pedidos_seguimiento where cliente_id = v_cliente;
    delete from public.clientes_delivery where id = v_cliente;
  end if;
  delete from auth.users where id = v_uid;
end;
$function$;

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
    raise exception 'Esta bodega todavía no tiene habilitados los Pedidos por WhatsApp. Contacta al administrador.';
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
    raise exception 'Esta bodega todavía no tiene habilitados los Pedidos por WhatsApp. Contacta al administrador.';
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

create or replace function public.bloquear_cambio_slug_bodega()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if coalesce(old.slug, '') <> ''
     and new.slug is distinct from old.slug
     and auth.uid() is not null
     and not public.es_superadmin() then
    raise exception 'El link de pedidos ya está asignado y no se puede cambiar. Contacta al administrador.';
  end if;
  return new;
end;
$function$;

create or replace function public.anular_venta(p_venta_id text, p_motivo text default null::text)
 returns jsonb
 language plpgsql
 set search_path to 'public'
as $function$
declare
  v record;
  d record;
  v_filas integer;
begin
  execute format(
    'select id, bodega_id, medio_pago, cliente_id, total_venta, nro_boleta, coalesce(anulada, false) as anulada
       from public.ventas where id = %L for update',
    p_venta_id
  ) into v;
  get diagnostics v_filas = row_count;

  if v_filas = 0 then
    raise exception 'La boleta no existe o no tienes permiso para anularla.';
  end if;

  if v.anulada then
    return jsonb_build_object('id', v.id, 'nro_boleta', v.nro_boleta, 'ya_anulada', true);
  end if;

  -- 1) Marcar la boleta como anulada (soft-delete: se conserva el historial).
  update public.ventas
    set anulada = true,
        motivo_anulacion = coalesce(nullif(trim(p_motivo), ''), 'Sin motivo especificado')
    where id = v.id;

  -- 2) Si era a crédito, revertir la deuda del cliente.
  if v.medio_pago = 'CREDITO' and v.cliente_id is not null then
    perform public.ajustar_saldo_cliente(v.cliente_id, -v.total_venta);
  end if;

  -- 3) Devolver el stock. Se usa unidades_stock (lo que de verdad se descontó,
  --    en unidades base) y, si es una venta vieja sin esa columna, cantidad.
  --    Siempre en el mismo orden (por producto_id) para no bloquearse con otra
  --    operación simultánea.
  for d in
    select producto_id, sum(coalesce(unidades_stock, cantidad)) as unidades
    from public.ventas_detalle
    where venta_id = v.id and producto_id is not null
    group by producto_id
    order by producto_id
  loop
    perform public.ajustar_stock(d.producto_id, d.unidades);
  end loop;

  return jsonb_build_object('id', v.id, 'nro_boleta', v.nro_boleta, 'ya_anulada', false);
end;
$function$;

commit;

notify pgrst, 'reload schema';

-- ------------------------------------------------------------
-- Verificación: una sola tabla. "esperado" dice qué debería dar.
-- ------------------------------------------------------------
select 'cancelar libera stock' as revision,
       (pg_get_functiondef('public.cancelar_seguimiento_pedido(uuid)'::regprocedure) ilike '%delete from pedidos_delivery%')::text as valor,
       'true' as esperado
union all
select 'pedidos cancelados que todavía reservan stock',
       (select count(*) from public.pedidos_delivery p
         where p.usado = false
           and exists (select 1 from public.pedidos_seguimiento s
                       where s.codigo_corto = p.codigo_corto and s.bodega_id = p.bodega_id
                         and s.estado = 'cancelado'))::text,
       '0'
union all
select 'obtener_bodega_delivery devuelve "abierta"',
       (pg_get_function_result('public.obtener_bodega_delivery(text)'::regprocedure) ilike '%abierta boolean%')::text,
       'true'
union all
select 'obtener_bodega_delivery: anon puede usarla',
       has_function_privilege('anon', 'public.obtener_bodega_delivery(text)', 'execute')::text,
       'true'
union all
select 'tiendas publicadas cerradas por bodega inactiva o vencida',
       (select count(*) from public.bodegas_delivery where not abierta)::text,
       'informativo'
union all
select 'funciones con mensajes en "vos"',
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.prokind = 'f'
           and pg_get_functiondef(p.oid) ~ '(Marcá|Escribí|Ingresá|Elegí|pagás|Tenés|Esperá|Intentá|Contactá|tenés)')::text,
       '0';
