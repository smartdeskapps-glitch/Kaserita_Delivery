-- ============================================================
-- Rehace los dos Database Webhooks de las notificaciones push SIN la
-- clave maestra (header Authorization) y con el WEBHOOK_SECRET nuevo.
-- Es lo mismo que editarlos en el Dashboard (Integrations -> Database
-- Webhooks): por dentro un webhook es un trigger que llama a
-- supabase_functions.http_request.
--
-- Uso: en el SQL Editor, reemplazar PEGAR_AQUI_EL_SECRETO_NUEVO por el
-- mismo valor que se guardó en Edge Functions -> Secrets -> WEBHOOK_SECRET,
-- y ejecutar todo. NO guardar el secreto en este archivo del repo.
--
-- Antes de esto, las dos funciones tienen que estar publicadas con el
-- código nuevo y con "Verify JWT" desactivado (PASOS_CLAVES_SUPABASE.md,
-- paso 3): sin el header Authorization, una función con Verify JWT
-- activado rechaza la llamada.
-- ============================================================

do $$
declare
  v_secreto text := 'PEGAR_AQUI_EL_SECRETO_NUEVO';
  v_headers text;
begin
  if v_secreto like 'PEGAR%' or length(v_secreto) < 20 then
    raise exception 'Falta pegar el secreto nuevo (el mismo de WEBHOOK_SECRET).';
  end if;
  v_headers := jsonb_build_object('Content-type', 'application/json', 'x-webhook-secret', v_secreto)::text;

  drop trigger if exists pedido_listo_push on public.pedidos_seguimiento;
  execute format(
    'create trigger pedido_listo_push after update on public.pedidos_seguimiento
       for each row execute function supabase_functions.http_request(%L, %L, %L, %L, %L)',
    'https://hzmrsbeamtbloudmxjrp.supabase.co/functions/v1/enviar-notificacion-pedido-listo',
    'POST', v_headers, '{}', '5000');

  drop trigger if exists avisos_tienda_webhook on public.avisos_tienda;
  execute format(
    'create trigger avisos_tienda_webhook after insert on public.avisos_tienda
       for each row execute function supabase_functions.http_request(%L, %L, %L, %L, %L)',
    'https://hzmrsbeamtbloudmxjrp.supabase.co/functions/v1/enviar-aviso-tienda',
    'POST', v_headers, '{}', '5000');
end $$;

-- Verificación (no muestra el secreto). Esperado: 2 filas,
-- lleva_clave_maestra = false y lleva_secreto = true.
select c.relname || '.' || t.tgname as webhook,
       pg_get_triggerdef(t.oid) ilike '%Authorization%' as lleva_clave_maestra,
       pg_get_triggerdef(t.oid) ilike '%x-webhook-secret%' as lleva_secreto
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
where t.tgname in ('pedido_listo_push', 'avisos_tienda_webhook');
