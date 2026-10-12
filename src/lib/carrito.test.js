import { describe, it, expect } from 'vitest';
import {
  formatoMoneda,
  totalCarrito,
  totalUnidades,
  entregaDomicilio,
  costoEnvio,
  totalPedido,
  problemaEntrega,
} from './carrito.js';

const prod = (precio_venta, cantidad) => ({ precio_venta, cantidad });

describe('formatoMoneda', () => {
  it('siempre con dos decimales y prefijo S/', () => {
    expect(formatoMoneda(5)).toBe('S/ 5.00');
    expect(formatoMoneda(12.5)).toBe('S/ 12.50');
    expect(formatoMoneda('3.1')).toBe('S/ 3.10');
  });
  it('vacío, nulo o inválido se ve como cero', () => {
    expect(formatoMoneda()).toBe('S/ 0.00');
    expect(formatoMoneda(null)).toBe('S/ 0.00');
    expect(formatoMoneda(NaN)).toBe('S/ 0.00');
  });
});

describe('totalCarrito / totalUnidades', () => {
  it('suma productos sueltos y combos a su precio de venta', () => {
    const productos = [prod(2.5, 4), prod(1, 3)]; // 10 + 3
    const combos = [prod(15, 2)]; // 30
    expect(totalCarrito(productos, combos)).toBe(43);
    expect(totalUnidades(productos, combos)).toBe(9);
  });
  it('carrito vacío vale cero', () => {
    expect(totalCarrito([], [])).toBe(0);
    expect(totalUnidades([], [])).toBe(0);
  });
  it('funciona con solo combos o solo productos', () => {
    expect(totalCarrito([], [prod(20, 1)])).toBe(20);
    expect(totalCarrito([prod(7, 2)], [])).toBe(14);
  });
});

describe('entregaDomicilio / costoEnvio', () => {
  const reparte = { delivery_domicilio: true, costo_envio: '4.50' };
  it('cobra envío solo si la tienda reparte y el cliente eligió domicilio', () => {
    const dom = entregaDomicilio(reparte, 'domicilio');
    expect(dom).toBe(true);
    expect(costoEnvio(reparte, dom)).toBe(4.5);
  });
  it('retiro en tienda no cobra envío aunque la tienda reparta', () => {
    const dom = entregaDomicilio(reparte, 'retiro');
    expect(dom).toBe(false);
    expect(costoEnvio(reparte, dom)).toBe(0);
  });
  it('si la tienda no reparte, "domicilio" no cuenta', () => {
    const dom = entregaDomicilio({ delivery_domicilio: false, costo_envio: 3 }, 'domicilio');
    expect(dom).toBe(false);
    expect(costoEnvio({ delivery_domicilio: false, costo_envio: 3 }, dom)).toBe(0);
  });
  it('sin datos de la bodega o con costo inválido el envío es cero', () => {
    expect(entregaDomicilio(undefined, 'domicilio')).toBe(false);
    expect(costoEnvio(undefined, true)).toBe(0);
    expect(costoEnvio({ costo_envio: 'abc' }, true)).toBe(0);
  });
});

describe('totalPedido', () => {
  it('suma items y envío guardado', () => {
    expect(totalPedido({ items: [prod(3, 2), prod(1.5, 2)], costo_envio: 4 })).toBe(13);
  });
  it('sin envío ni items no falla', () => {
    expect(totalPedido({ items: [prod(3, 1)] })).toBe(3);
    expect(totalPedido({})).toBe(0);
    expect(totalPedido({ items: [], costo_envio: null })).toBe(0);
  });
});

describe('problemaEntrega', () => {
  const ok = {
    esDomicilio: true,
    ubicacion: { lat: -12.04, lng: -77.03 },
    referencia: 'Frente al parque',
    telefono: '987 654 321',
    total: 30,
    totalConEnvio: 34,
    pedidoMinimo: 20,
    medioPago: 'yape',
    pagaCon: '',
  };
  it('con todo en orden no hay problema', () => {
    expect(problemaEntrega(ok)).toBe('');
  });
  it('retiro en tienda nunca tiene problema de entrega', () => {
    expect(problemaEntrega({ ...ok, esDomicilio: false, ubicacion: null, telefono: '' })).toBe('');
  });
  it('pide marcar la ubicación primero', () => {
    expect(problemaEntrega({ ...ok, ubicacion: null })).toMatch(/mapa/);
  });
  it('pide referencia de al menos 3 letras', () => {
    expect(problemaEntrega({ ...ok, referencia: '  ab ' })).toMatch(/referencia/);
    expect(problemaEntrega({ ...ok, referencia: 'abc' })).toBe('');
  });
  it('valida el teléfono ignorando espacios y símbolos (7 a 15 dígitos)', () => {
    expect(problemaEntrega({ ...ok, telefono: '12345' })).toMatch(/teléfono/);
    expect(problemaEntrega({ ...ok, telefono: '1234567' })).toBe('');
    expect(problemaEntrega({ ...ok, telefono: '+51 987-654-321' })).toBe('');
    expect(problemaEntrega({ ...ok, telefono: '1'.repeat(16) })).toMatch(/teléfono/);
  });
  it('el mínimo se compara con los productos, sin contar el envío', () => {
    expect(problemaEntrega({ ...ok, total: 19, totalConEnvio: 23 })).toBe('El pedido mínimo para delivery es S/ 20.00.');
    expect(problemaEntrega({ ...ok, total: 20, totalConEnvio: 24 })).toBe('');
  });
  it('pago en efectivo: "paga con" debe alcanzar el total con envío', () => {
    const ef = { ...ok, medioPago: 'efectivo' };
    expect(problemaEntrega({ ...ef, pagaCon: '30' })).toMatch(/no alcanza/);
    expect(problemaEntrega({ ...ef, pagaCon: '34' })).toBe('');
    expect(problemaEntrega({ ...ef, pagaCon: '50' })).toBe('');
  });
  it('si no indica con cuánto paga, o no es efectivo, no se valida el monto', () => {
    expect(problemaEntrega({ ...ok, medioPago: 'efectivo', pagaCon: '' })).toBe('');
    expect(problemaEntrega({ ...ok, medioPago: 'yape', pagaCon: '5' })).toBe('');
  });
  it('reporta un solo problema, en orden de prioridad', () => {
    expect(problemaEntrega({ ...ok, ubicacion: null, referencia: '', telefono: '' })).toMatch(/mapa/);
  });
});
