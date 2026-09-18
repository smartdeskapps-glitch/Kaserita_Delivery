-- KaseritaDelivery + Kaserita (POS) — cierra el permiso de ejecución por
-- defecto de PostgreSQL sobre TODAS las funciones del schema public.
-- Ejecutar a mano en el SQL Editor de Supabase.
--
-- Afecta a las DOS apps (comparten el mismo proyecto de Supabase / schema
-- public) -- se corre una sola vez, no hace falta repetirlo en cada repo.
--
-- Hallazgo del linter de seguridad: casi todas las funciones del proyecto
-- aparecían como "ejecutables por anon/authenticated" sin que nadie las
-- hubiera otorgado explícitamente a esos roles. Causa real: Postgres le da
-- permiso de EXECUTE a PUBLIC (o sea, a cualquier rol) a toda función
-- nueva por defecto, salvo que se revoque a mano -- acá nunca se hizo.
--
-- No es una falla de autorización real en la mayoría de los casos: cada
-- función ya valida por su cuenta quién puede usarla (es_superadmin(),
-- auth.uid(), etc. -- ver admin_eliminar_bodega, admin_crear_bodega,
-- actualizar_mi_delivery, etc., todas con su propio "if not ... raise
-- exception"). Pero reducir la superficie expuesta es buena práctica, y
-- deja mejor loggeado qué es realmente público a propósito (lo que tiene
-- su "grant execute ... to anon/authenticated" explícito en el código)
-- de lo que era público por descuido.
--
-- Tres funciones (admin_diagnostico_permisos, rls_auto_enable,
-- cerrar_cajas_automatico) no tienen ningún grant explícito en ningún
-- archivo del repo -- probablemente utilidades para correr a mano desde
-- el SQL Editor, nunca pensadas para que la app las llame. Con este
-- script dejan de ser invocables vía /rest/v1/rpc/... por cualquiera;
-- se siguen pudiendo correr a mano como superusuario en el SQL Editor.

-- Paso 1: revocar EXECUTE de PUBLIC en cada función que ya existe hoy.
-- Los "grant execute ... to anon/authenticated" explícitos que ya tiene
-- cada función en su propio archivo NO se tocan -- son grants aparte,
-- independientes del de PUBLIC, así que las funciones que sí deben ser
-- públicas siguen funcionando igual después de este paso.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as firma
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
  loop
    execute format('revoke execute on function %s from public', r.firma);
  end loop;
end $$;

-- Paso 2: que las funciones que se creen de ahora en más tampoco reciban
-- EXECUTE para PUBLIC por defecto -- así este problema no vuelve a
-- aparecer solo, cada función nueva necesita su propio "grant execute"
-- explícito (que de hecho ya es la costumbre en este proyecto).
alter default privileges in schema public revoke execute on functions from public;

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- Verificación (opcional): después de correr esto, probá de punta a
-- punta las dos apps -- login de cajero/dueño y catálogo público del POS,
-- y login de cliente + hacer un pedido en KaseritaDelivery. Si algo deja
-- de funcionar, es una función que dependía del permiso de PUBLIC sin
-- tener su propio "grant execute" -- avisame cuál para agregárselo.
-- ============================================================
