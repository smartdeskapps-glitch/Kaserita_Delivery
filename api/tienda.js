// Vista previa de cada tienda al compartir su link (WhatsApp, Facebook, Telegram...).
//
// La app es una sola página estática: todos los links (/sunshir, /otra-tienda) devuelven el mismo
// index.html, así que la vista previa salía siempre con la imagen y el título de Kaserita Delivery.
// vercel.json manda a esta función SOLO los pedidos de esos robots de vista previa (por el
// user-agent); las personas siguen recibiendo la app directo, sin pasar por aquí.
//
// Devuelve un HTML mínimo con las etiquetas Open Graph de la tienda (nombre, logo, dirección).
// Los robots no ejecutan JavaScript, así que no hace falta nada más. Si algo falla, se usan los
// datos de siempre de Kaserita Delivery.
// La clave publishable es pública (ya viaja en el JS de la app); no hay secretos aquí.
const SUPABASE_URL = 'https://hzmrsbeamtbloudmxjrp.supabase.co';
const SUPABASE_KEY = 'sb_publishable_RHAkd7pZIadDnSQClFdjMQ_lrG3p-gw';
const SITIO = 'https://delivery.smartdeskapps.com';
const IMAGEN_GENERICA = `${SITIO}/og-image.jpg`;
const DESCRIPCION_GENERICA = 'Pide en tu bodega de confianza y manda el pedido por WhatsApp.';

const escapar = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Solo se aceptan imágenes del almacenamiento público de este proyecto.
const imagenValida = (u) => typeof u === 'string' && u.startsWith(`${SUPABASE_URL}/storage/v1/object/public/`);

async function buscarTienda(slug) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/obtener_bodega_delivery`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_slug: slug }),
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return null;
    const filas = await r.json();
    return Array.isArray(filas) && filas.length ? filas[0] : null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  const slug = String(req.query.slug || '').toLowerCase();
  const tienda = /^[a-z0-9-]{2,60}$/.test(slug) ? await buscarTienda(slug) : null;

  const url = tienda ? `${SITIO}/${slug}` : SITIO;
  const titulo = tienda ? `${tienda.nombre} · Kaserita Delivery` : 'Kaserita Delivery';
  const descripcion = tienda
    ? `Haz tu pedido en ${tienda.nombre}${tienda.direccion ? ` (${tienda.direccion})` : ''}. Lo armas aquí y lo mandas directo por WhatsApp.`
    : DESCRIPCION_GENERICA;
  const logo = tienda && imagenValida(tienda.logo_url) ? tienda.logo_url : null;
  const banner = tienda && imagenValida(tienda.banner_url) ? tienda.banner_url : null;
  // El logo es cuadrado: WhatsApp lo muestra como miniatura al costado. Sin logo se usa el banner o la imagen de siempre.
  const imagen = logo || banner || IMAGEN_GENERICA;
  const tarjeta = logo ? 'summary' : 'summary_large_image';

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Los robots piden el mismo link muchas veces: se guarda 5 minutos y se sirve el anterior mientras se renueva.
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=86400');
  res.status(200).send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<title>${escapar(titulo)}</title>
<meta name="description" content="${escapar(descripcion)}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Kaserita Delivery" />
<meta property="og:title" content="${escapar(titulo)}" />
<meta property="og:description" content="${escapar(descripcion)}" />
<meta property="og:image" content="${escapar(imagen)}" />
<meta property="og:url" content="${escapar(url)}" />
<meta name="twitter:card" content="${tarjeta}" />
<meta name="twitter:title" content="${escapar(titulo)}" />
<meta name="twitter:description" content="${escapar(descripcion)}" />
<meta name="twitter:image" content="${escapar(imagen)}" />
<meta http-equiv="refresh" content="0;url=${escapar(url)}" />
</head>
<body><a href="${escapar(url)}">${escapar(titulo)}</a></body>
</html>`);
}
