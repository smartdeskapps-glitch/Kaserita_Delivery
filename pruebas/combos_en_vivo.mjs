// Prueba en vivo de los combos del lado de Delivery, contra la bodega demo.
// Reemplaza a test_combos_en_vivo.py: desde la migración 38 los pedidos exigen
// sesión de cliente, así que esta versión necesita el token de una sesión de
// prueba y se limpia sola (cancela los pedidos que crea y comprueba que el
// stock vuelva exactamente a lo de antes).
//
// Cómo obtener el token (dura ~1 hora):
//   1. Abre https://delivery.smartdeskapps.com/bodega-demo con una cuenta de PRUEBA de Google.
//   2. En la consola del navegador (F12) pega:
//        JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.endsWith('-auth-token')))).access_token
//   3. Corre (PowerShell):   $env:TOKEN_CLIENTE = "<token>"; node pruebas/combos_en_vivo.mjs
//      o (bash):             TOKEN_CLIENTE="<token>" node pruebas/combos_en_vivo.mjs
//
// El token es una credencial: no lo guardes en el repo ni lo compartas.
const SUPABASE_URL = 'https://hzmrsbeamtbloudmxjrp.supabase.co';
const ANON_KEY = 'sb_publishable_RHAkd7pZIadDnSQClFdjMQ_lrG3p-gw';
const SLUG = 'bodega-demo';
const BODEGA_ID = 'f1c4a872-3230-4f61-89aa-8f7441ef6af1';
const TOKEN = process.env.TOKEN_CLIENTE;

if (!TOKEN) {
  console.log('Falta TOKEN_CLIENTE. Mira las instrucciones al inicio de pruebas/combos_en_vivo.mjs.');
  process.exit(2);
}

async function llamar(metodo, ruta, cuerpo, extra = {}, token = TOKEN) {
  const res = await fetch(SUPABASE_URL + ruta, {
    method: metodo,
    headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...extra },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  const texto = await res.text();
  let json = null;
  try { json = texto.trim() ? JSON.parse(texto) : null; } catch { json = texto; }
  return { estado: res.status, cuerpo: json };
}
const rpc = (n, c) => llamar('POST', '/rest/v1/rpc/' + n, c);
const msg = (r) => (r.cuerpo && typeof r.cuerpo === 'object' ? r.cuerpo.message || JSON.stringify(r.cuerpo) : String(r.cuerpo));
const codigo = () => 'QAT' + Math.random().toString(36).slice(2, 8).toUpperCase();
const afirma = (c, m) => { if (!c) throw new Error(m); };
const aceptado = (r) => [200, 201, 204].includes(r.estado);

let clienteId = null;
const creados = [];
async function crearPedido(items, cod = codigo()) {
  const r = await llamar('POST', '/rest/v1/pedidos_delivery',
    { codigo_corto: cod, bodega_id: BODEGA_ID, items, cliente_id: clienteId }, { Prefer: 'return=minimal' });
  if (aceptado(r)) creados.push(cod);
  return { r, cod };
}
async function stockPorProducto() {
  const r = await rpc('obtener_productos_delivery', { p_slug: SLUG });
  afirma(r.estado === 200, `obtener_productos_delivery -> ${r.estado}`);
  return Object.fromEntries(r.cuerpo.map((p) => [p.id, p.stock_disponible]));
}
// Cancela los pedidos creados: el servidor los borra y libera el stock.
async function limpiar() {
  for (const cod of creados) {
    const s = await llamar('GET', `/rest/v1/pedidos_seguimiento?select=id&codigo_corto=eq.${cod}&bodega_id=eq.${BODEGA_ID}`);
    const id = s.cuerpo?.[0]?.id;
    if (id) await rpc('cancelar_seguimiento_pedido', { p_id: id });
    else console.log(`  (no se encontró seguimiento de ${cod}; elimínalo desde Pedidos por retirar)`);
  }
}

const resultados = [];
async function prueba(nombre, fn) {
  try { await fn(); resultados.push(true); console.log('  OK    ' + nombre); }
  catch (e) { resultados.push(false); console.log('  FALLA ' + nombre + '\n        -> ' + e.message); }
}

console.log(`Combos en vivo - bodega '${SLUG}'\n`);
const yo = await rpc('mi_cliente_delivery_id', {});
if (yo.estado !== 200 || !yo.cuerpo) {
  console.log(`El token no sirve (HTTP ${yo.estado}: ${msg(yo)}). Puede haber vencido: genera uno nuevo.`);
  process.exit(2);
}
clienteId = yo.cuerpo;
const stockInicial = await stockPorProducto();
const combosR = await rpc('obtener_combos_delivery', { p_slug: SLUG });
const combos = Object.fromEntries((combosR.cuerpo || []).map((c) => [c.nombre, c]));
const gaseosas = combos['Combo QA Gaseosas'];
const desayuno = combos['Combo Desayuno'];

try {
  await prueba('1. El catálogo de combos trae nombre, precio y productos', async () => {
    afirma(combosR.estado === 200 && combosR.cuerpo.length >= 1, 'la demo no tiene combos activos');
    for (const c of combosR.cuerpo) {
      afirma(c.nombre.trim() && Number(c.precio_venta) > 0 && c.items?.length, `combo '${c.nombre}' incompleto`);
      for (const it of c.items) afirma(it.producto_id in stockInicial, `'${c.nombre}' incluye un producto fuera del catálogo: ${it.descripcion}`);
    }
  });

  await prueba('2. Pedir un combo se acepta y reserva 1 unidad de CADA producto', async () => {
    afirma(gaseosas, "no existe el 'Combo QA Gaseosas' en la demo");
    const antes = await stockPorProducto();
    const { r } = await crearPedido([{ combo_id: gaseosas.id, cantidad: 1 }]);
    afirma(aceptado(r), `rechazado: HTTP ${r.estado} ${msg(r)}`);
    const despues = await stockPorProducto();
    for (const it of gaseosas.items) {
      afirma(despues[it.producto_id] === antes[it.producto_id] - Number(it.cantidad),
        `${it.descripcion}: ${antes[it.producto_id]} -> ${despues[it.producto_id]}`);
    }
    const tocados = new Set(gaseosas.items.map((i) => i.producto_id));
    const otros = Object.keys(antes).filter((k) => !tocados.has(k) && antes[k] !== despues[k]);
    afirma(otros.length === 0, 'cambió el stock de productos que no son del combo');
  });

  await prueba('3. Pedido mezclado (combo + suelto con precio alterado) se acepta sin creerle al cliente', async () => {
    afirma(desayuno, "no existe el 'Combo Desayuno' en la demo");
    const suelto = (await rpc('obtener_productos_delivery', { p_slug: SLUG })).cuerpo.find((p) => p.descripcion.startsWith('Aceite Primor'));
    afirma(suelto, 'falta el producto de prueba "Aceite Primor"');
    const antes = await stockPorProducto();
    const { r } = await crearPedido([
      { combo_id: desayuno.id, cantidad: 1, precio_venta: 0.01, descripcion: 'hack' },
      { id: suelto.id, cantidad: 1, precio_venta: 0.01, descripcion: 'hack' },
    ]);
    afirma(aceptado(r), `rechazado: HTTP ${r.estado} ${msg(r)}`);
    const despues = await stockPorProducto();
    afirma(despues[suelto.id] === antes[suelto.id] - 1, 'no se reservó el producto suelto');
  });

  await prueba('4. Combo repetido en el mismo pedido se rechaza', async () => {
    const { r } = await crearPedido([{ combo_id: gaseosas.id, cantidad: 1 }, { combo_id: gaseosas.id, cantidad: 1 }]);
    afirma(r.estado === 400 && /repetido/.test(msg(r)), `HTTP ${r.estado}: ${msg(r)}`);
  });

  await prueba('5. Un combo inexistente se rechaza', async () => {
    const { r } = await crearPedido([{ combo_id: '00000000-0000-0000-0000-000000000000', cantidad: 1 }]);
    afirma(r.estado === 400 && /ya no está disponible/.test(msg(r)), `HTTP ${r.estado}: ${msg(r)}`);
  });

  await prueba('6. Más combos de los que alcanza el stock se rechaza, nombrando el producto', async () => {
    const { r } = await crearPedido([{ combo_id: gaseosas.id, cantidad: 40 }]);
    afirma(r.estado === 400 && /No hay suficiente stock/.test(msg(r)), `HTTP ${r.estado}: ${msg(r)}`);
  });

  await prueba('7. Cantidades inválidas o por encima del tope (50) se rechazan', async () => {
    for (const cant of [0, -1, 10000]) {
      const { r } = await crearPedido([{ combo_id: gaseosas.id, cantidad: cant }]);
      afirma(r.estado === 400 && /Cantidad inválida/.test(msg(r)), `cantidad ${cant}: HTTP ${r.estado} ${msg(r)}`);
    }
    const { r } = await crearPedido([{ combo_id: gaseosas.id, cantidad: 51 }]);
    afirma(r.estado === 400 && /hasta 50 unidades/.test(msg(r)), `51 unidades: HTTP ${r.estado} ${msg(r)}`);
  });

  await prueba('8. Pedido vacío y código de pedido inválido se rechazan', async () => {
    afirma((await crearPedido([])).r.estado === 400, 'se aceptó un pedido vacío');
    const { r } = await crearPedido([{ combo_id: gaseosas.id, cantidad: 1 }], 'abc');
    afirma(r.estado === 400 && /Código de pedido inválido/.test(msg(r)), `HTTP ${r.estado}: ${msg(r)}`);
  });

  await prueba('9. Un cliente no puede pedir a nombre de otro cliente', async () => {
    const { r } = await (async () => {
      const cod = codigo();
      const x = await llamar('POST', '/rest/v1/pedidos_delivery',
        { codigo_corto: cod, bodega_id: BODEGA_ID, items: [{ combo_id: gaseosas.id, cantidad: 1 }], cliente_id: '00000000-0000-0000-0000-000000000000' },
        { Prefer: 'return=minimal' });
      if (aceptado(x)) creados.push(cod);
      return { r: x };
    })();
    afirma(r.estado >= 400, 'se aceptó un pedido con el cliente_id de otra persona');
  });
} finally {
  console.log('\nLimpiando los pedidos de prueba…');
  await limpiar();
}

await prueba('10. Tras cancelar, el stock vuelve exactamente al inicial', async () => {
  const ahora = await stockPorProducto();
  const difs = Object.keys(stockInicial).filter((k) => stockInicial[k] !== ahora[k]);
  afirma(difs.length === 0, 'stock distinto en: ' + difs.map((k) => `${k} (${stockInicial[k]} -> ${ahora[k]})`).join(', '));
});

const fallas = resultados.filter((ok) => !ok).length;
console.log(`\n${resultados.length - fallas}/${resultados.length} pruebas OK`);
process.exit(fallas ? 1 : 0);
