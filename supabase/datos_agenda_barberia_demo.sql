-- Datos de muestra de la agenda para "Barberia Demo" (no es una migración).
-- Duración de cada servicio y horario de los dos barberos:
-- lunes a sábado, 09:00-13:00 y 15:00-20:00 (domingo no atienden).

update productos set duracion_min = v.min
from (values
  ('f6e6a22c-d667-4caa-9dd1-74ab1e2a62c6'::uuid, 30),  -- Corte clásico
  ('ae4e5427-33e6-478c-bed4-35d48750bfb7'::uuid, 40),  -- Corte fade
  ('625422d6-7920-4a99-b4a3-d43effeecff3'::uuid, 25),  -- Corte niño
  ('f43131ce-0a76-43c7-981e-be03b471f27b'::uuid, 50),  -- Corte + barba
  ('633835ea-7f3f-4d1e-bf31-d93d85b947bb'::uuid, 20),  -- Perfilado de barba
  ('a6953c30-f02a-4f2f-8144-9eb5885d23a1'::uuid, 15),  -- Perfilado de cejas
  ('b1542d74-e630-4a03-8e0f-f78773f6bff3'::uuid, 60)   -- Aplicación de tinte
) as v(id, min)
where productos.id = v.id;

insert into barbero_horarios (bodega_id, barbero_id, dia, desde, hasta)
select 'a8cec287-ea95-4ca2-b076-713a2d82b429', b.id, d.dia, t.desde, t.hasta
from (values ('84cbee22-1793-4db3-8d88-5de81132b1ad'::uuid), ('43c77a79-24f1-49e4-bb5d-4c1fd855cf03'::uuid)) as b(id)
cross join generate_series(1, 6) as d(dia)
cross join (values ('09:00'::time, '13:00'::time), ('15:00'::time, '20:00'::time)) as t(desde, hasta);
