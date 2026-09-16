# Kaserita Delivery

Vitrina pública para que los clientes de una bodega armen su pedido y lo manden
por WhatsApp, sin necesidad de login. Es una app separada de
[Kaserita](https://kaserita.vercel.app) (el POS), pero lee del mismo proyecto de
Supabase.

## Cómo funciona

1. Cada bodega tiene un link propio: `/{slug-de-la-bodega}`.
2. El cliente ve el catálogo (foto, nombre, precio, stock) y arma un carrito.
3. Al confirmar, se genera un código de referencia corto y un link de WhatsApp
   con el pedido redactado.
4. El cliente manda ese mensaje a la bodega.
5. La bodega carga el código en el POS (Kaserita) y el carrito se prellena solo.

No hay pago online ni delivery propio — el cobro y la entrega siguen siendo
como la bodega ya los maneja.

## Stack

Un solo `index.html`: React 18 (UMD) + Babel Standalone (JSX en el navegador,
sin build step) + Tailwind CDN + Supabase JS (CDN). Mismo patrón que Kaserita,
para no necesitar tooling de build.

## Desarrollo local

Abrí `index.html` directamente en el navegador, o serví la carpeta con
cualquier servidor estático. Para probar una bodega necesitás que tenga
`slug` y `delivery_habilitado = true` en Supabase (ver `supabase/migration.sql`).

## Supabase

Este proyecto usa las vistas de solo lectura `bodegas_delivery` y
`productos_delivery` (creadas por `supabase/migration.sql`), que exponen solo
las columnas seguras de bodegas con delivery habilitado. La tabla
`pedidos_delivery` guarda el carrito temporal detrás del código de referencia.

La migración SQL vive en [`supabase/migration.sql`](supabase/migration.sql) y
se corre a mano desde el SQL Editor de Supabase — no se ejecuta desde este repo.

## Deploy

Pensado para desplegarse en Vercel como sitio estático (`vercel.json` reescribe
cualquier ruta a `index.html` para que el ruteo por slug funcione).
