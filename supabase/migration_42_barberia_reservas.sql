-- ============================================================
-- Migración 42 (2026-10-19): tienda de barbería con reserva de citas.
-- Ejecutar todo de una vez en el SQL Editor. Requiere haber corrido antes
-- tipo_negocio_barberia.sql del POS (columna bodegas.tipo_negocio).
--
-- obtener_barberia_delivery(slug) le dice a la tienda pública si la bodega es
-- una barbería y, si lo es, qué barberos están activos (solo id y nombre).
-- Para cualquier otra bodega devuelve {"es_barberia": false}.
-- Función NUEVA: no cambia ninguna existente. Solo muestra datos de bodegas
-- con la tienda publicada (las que aparecen en bodegas_delivery).
-- ============================================================

create or replace function public.obtener_barberia_delivery(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select case
    when b.tipo_negocio = 'barberia' then jsonb_build_object(
      'es_barberia', true,
      'barberos', coalesce((
        select jsonb_agg(jsonb_build_object('id', c.id, 'nombre', c.nombre) order by c.nombre)
        from cajeros c
        where c.bodega_id = b.id and c.activo is not false
      ), '[]'::jsonb)
    )
    else jsonb_build_object('es_barberia', false)
  end
  from bodegas b
  join bodegas_delivery bd on bd.bodega_id = b.id
  where b.slug = p_slug;
$$;

grant execute on function public.obtener_barberia_delivery(text) to anon;
grant execute on function public.obtener_barberia_delivery(text) to authenticated;

notify pgrst, 'reload schema';
