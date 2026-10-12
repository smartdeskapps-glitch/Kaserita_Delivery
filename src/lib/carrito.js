// Cuentas del carrito y del pedido a domicilio. Son funciones puras para poder
// probarlas sin la interfaz: aquí vive todo lo que toca el dinero del cliente.

export function formatoMoneda(n) {
  return `S/ ${Number(n || 0).toFixed(2)}`;
}

const sumaImporte = (items) => items.reduce((acc, it) => acc + it.precio_venta * it.cantidad, 0);

// Productos sueltos + combos (cada combo se cobra a su propio precio de venta).
export function totalCarrito(itemsProductos, itemsCombos) {
  return sumaImporte(itemsProductos) + sumaImporte(itemsCombos);
}

export function totalUnidades(itemsProductos, itemsCombos) {
  return itemsProductos.reduce((acc, it) => acc + it.cantidad, 0) + itemsCombos.reduce((acc, it) => acc + it.cantidad, 0);
}

// El envío solo se cobra si la tienda reparte y el cliente eligió domicilio.
export function entregaDomicilio(bodega, tipoEntrega) {
  return tipoEntrega === 'domicilio' && !!bodega?.delivery_domicilio;
}

export function costoEnvio(bodega, esDomicilio) {
  return esDomicilio ? Number(bodega?.costo_envio) || 0 : 0;
}

// Total de un pedido ya hecho: sus items más el envío que quedó guardado.
export function totalPedido(p) {
  return sumaImporte(p.items || []) + Number(p.costo_envio || 0);
}

// Qué le falta al cliente para poder enviar un pedido a domicilio ("" si nada).
// El mínimo se compara contra los productos, sin contar el envío.
export function problemaEntrega({
  esDomicilio,
  ubicacion,
  referencia,
  telefono,
  total,
  totalConEnvio,
  pedidoMinimo,
  medioPago,
  pagaCon,
}) {
  if (!esDomicilio) return '';
  const tel = String(telefono || '').replace(/\D/g, '');
  if (!ubicacion) return 'Marca en el mapa dónde quieres recibir tu pedido.';
  if (String(referencia || '').trim().length < 3) return 'Escribe una referencia de tu dirección.';
  if (tel.length < 7 || tel.length > 15) return 'Ingresa un teléfono de contacto válido.';
  if (total < pedidoMinimo) return `El pedido mínimo para delivery es ${formatoMoneda(pedidoMinimo)}.`;
  if (medioPago === 'efectivo' && pagaCon && Number(pagaCon) < totalConEnvio) return 'El monto con el que pagas no alcanza para el total.';
  return '';
}
