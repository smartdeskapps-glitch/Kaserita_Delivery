// Prueba de seguridad en vivo contra la bodega demo, con la clave PÚBLICA de la
// tienda (la misma que ve cualquiera en el navegador). Comprueba que alguien sin
// sesión NO puede: crear pedidos, leer datos privados, ni ejecutar las funciones
// de gestión del POS (migraciones 23, 30 y 38).
//
// No crea ni borra nada: todo se verifica con lecturas o con intentos que deben
// ser rechazados. Si una regresión dejara pasar un pedido de prueba, el código
// empieza con QAT para poder borrarlo desde "Pedidos por retirar".
//
// Uso:  node pruebas/seguridad_en_vivo.mjs        (Node 18 o superior, sin dependencias)
const SUPABASE_URL = 'https://hzmrsbeamtbloudmxjrp.supabase.co';
const ANON_KEY = 'sb_publishable_RHAkd7pZIadDnSQClFdjMQ_lrG3p-gw';
const SLUG = 'bodega-demo';
const BODEGA_ID = 'f1c4a872-3230-4f61-89aa-8f7441ef6af1';
const UUID_FALSO = '00000000-0000-0000-0000-000000000000';

async function llamar(metodo, ruta, cuerpo, extra = {}) {
  const res = await fetch(SUPABASE_URL + ruta, {
    method: metodo,
    headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + ANON_KEY, 'Content-Type': 'application/json', ...extra },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  const texto = await res.text();
  let json = null;
  try { json = texto.trim() ? JSON.parse(texto) : null; } catch { json = texto; }
  return { estado: res.status, cuerpo: json };
}
const rpc = (nombre, cuerpo) => llamar('POST', '/rest/v1/rpc/' + nombre, cuerpo);
const mensaje = (r) => (r.cuerpo && typeof r.cuerpo === 'object' ? r.cuerpo.message || JSON.stringify(r.cuerpo) : String(r.cuerpo));
const filasDevueltas = (r) => r.estado === 200 && Array.isArray(r.cuerpo) && r.cuerpo.length > 0;
const rechazada = (r) => r.estado >= 400;

const resultados = [];
async function prueba(nombre, fn) {
  try {
    await fn();
    resultados.push([nombre, true]);
    console.log('  OK    ' + nombre);
  } catch (e) {
    resultados.push([nombre, false]);
    console.log('  FALLA ' + nombre + '\n        -> ' + e.message);
  }
}
function afirma(cond, msg) { if (!cond) throw new Error(msg); }

console.log(`Seguridad en vivo - bodega '${SLUG}' (sin iniciar sesión)\n`);

const prods = await rpc('obtener_productos_delivery', { p_slug: SLUG });
afirma(prods.estado === 200 && prods.cuerpo.length > 0, 'no se pudo leer el catálogo público de la demo; no se puede seguir');
const producto = prods.cuerpo[0];

await prueba('1. Crear un pedido sin iniciar sesión se rechaza (migración 38)', async () => {
  const cod = 'QAT' + Math.random().toString(36).slice(2, 8).toUpperCase();
  const r = await llamar('POST', '/rest/v1/pedidos_delivery',
    { codigo_corto: cod, bodega_id: BODEGA_ID, items: [{ id: producto.id, cantidad: 1 }] },
    { Prefer: 'return=minimal' });
  afirma(rechazada(r), `se aceptó un pedido anónimo (código ${cod}); bórralo desde "Pedidos por retirar"`);
});

await prueba('2. Las tablas privadas no devuelven filas a un anónimo', async () => {
  const tablas = ['pedidos_delivery', 'pedidos_seguimiento', 'usuarios', 'ventas', 'clientes', 'bodegas', 'combos', 'productos'];
  const filtradas = [];
  for (const t of tablas) {
    const r = await llamar('GET', `/rest/v1/${t}?select=*&limit=1`);
    if (filasDevueltas(r)) filtradas.push(t);
  }
  afirma(filtradas.length === 0, 'se pudieron leer filas de: ' + filtradas.join(', '));
});

await prueba('3. Un anónimo no puede modificar ni borrar bodegas, productos ni pedidos', async () => {
  const intentos = [
    ['PATCH', `/rest/v1/bodegas?id=eq.${BODEGA_ID}`, { nombre: 'HACKEADA' }],
    ['PATCH', `/rest/v1/productos?bodega_id=eq.${BODEGA_ID}`, { precio_venta: 0.01 }],
    ['DELETE', `/rest/v1/productos?bodega_id=eq.${BODEGA_ID}`, undefined],
    ['DELETE', '/rest/v1/pedidos_delivery?codigo_corto=like.*', undefined],
    ['DELETE', '/rest/v1/pedidos_seguimiento?codigo_corto=like.*', undefined],
  ];
  const pasaron = [];
  for (const [m, ruta, cuerpo] of intentos) {
    const r = await llamar(m, ruta, cuerpo, { Prefer: 'return=representation' });
    if (r.estado < 300 && Array.isArray(r.cuerpo) && r.cuerpo.length > 0) pasaron.push(`${m} ${ruta}`);
  }
  afirma(pasaron.length === 0, 'afectaron filas: ' + pasaron.join(' | '));
  const b = await rpc('obtener_bodega_delivery', { p_slug: SLUG });
  afirma(b.cuerpo?.[0]?.nombre !== 'HACKEADA', 'el nombre de la bodega fue cambiado por un anónimo');
});

await prueba('4. Las funciones de gestión del POS no se pueden ejecutar sin sesión', async () => {
  const funciones = [
    ['actualizar_mi_entrega_domicilio', { p_habilitado: true, p_costo_envio: 0, p_pedido_minimo: 0, p_zona: 'x', p_whatsapp_repartidor: '' }],
    ['avisar_a_mis_clientes', {}],
    ['reclamar_cuenta_bodega', { p_dni: '00000000', p_pin: '0000' }],
    ['cancelar_seguimiento_pedido', { p_id: UUID_FALSO }],
  ];
  const ejecutaron = [];
  for (const [nombre, args] of funciones) {
    const r = await rpc(nombre, args);
    if (r.estado === 404) throw new Error(`${nombre}: la función no existe o los parámetros de la prueba están mal (HTTP 404)`);
    if (r.estado >= 200 && r.estado < 300) ejecutaron.push(nombre);
  }
  afirma(ejecutaron.length === 0, 'respondieron con éxito a un anónimo: ' + ejecutaron.join(', '));
});

await prueba('5. Un slug inventado no devuelve bodega, productos ni combos', async () => {
  for (const f of ['obtener_bodega_delivery', 'obtener_productos_delivery', 'obtener_combos_delivery']) {
    const r = await rpc(f, { p_slug: 'no-existe-zzz' });
    afirma(r.estado === 200 && Array.isArray(r.cuerpo) && r.cuerpo.length === 0, `${f}: HTTP ${r.estado} ${JSON.stringify(r.cuerpo).slice(0, 80)}`);
  }
});

await prueba('6. La ficha pública de la bodega no expone datos privados', async () => {
  const r = await rpc('obtener_bodega_delivery', { p_slug: SLUG });
  afirma(r.estado === 200 && r.cuerpo.length === 1, `HTTP ${r.estado}`);
  const claves = Object.keys(r.cuerpo[0]);
  const prohibidas = claves.filter((k) => /pin|dni|password|clave|email|correo|token|secret|api_key/i.test(k));
  afirma(prohibidas.length === 0, 'campos sensibles en la ficha pública: ' + prohibidas.join(', '));
  afirma(typeof r.cuerpo[0].abierta === 'boolean', 'falta "abierta" (migración 39): la tienda cerrada no se podría avisar');
});

await prueba('7. El catálogo público solo trae campos de vitrina', async () => {
  const claves = new Set(prods.cuerpo.flatMap((p) => Object.keys(p)));
  const prohibidas = [...claves].filter((k) => /costo|compra|proveedor|margen|bodega_id.*privado|pin|dni/i.test(k));
  afirma(prohibidas.length === 0, 'campos internos expuestos en el catálogo: ' + prohibidas.join(', '));
});

await prueba('8. Pedir con la clave pública no permite saltarse la validación (precio alterado)', async () => {
  const r = await llamar('POST', '/rest/v1/pedidos_delivery',
    { codigo_corto: 'abc', bodega_id: BODEGA_ID, items: [{ id: producto.id, cantidad: 1, precio_venta: 0.01 }] },
    { Prefer: 'return=minimal' });
  afirma(rechazada(r), 'se aceptó un pedido con código inválido y precio alterado');
});

const fallas = resultados.filter(([, ok]) => !ok);
console.log(`\n${resultados.length - fallas.length}/${resultados.length} pruebas OK`);
process.exit(fallas.length ? 1 : 0);
