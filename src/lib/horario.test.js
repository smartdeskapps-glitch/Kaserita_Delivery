import { describe, it, expect } from 'vitest';
import { estadoAtencion, textoApertura, formatoHora12 } from './horario.js';

// Hora de Lima (UTC-5) -> Date. 2026-11-16 es lunes.
const lima = (dia, hora) => new Date(`2026-11-${String(15 + dia).padStart(2, '0')}T${hora}:00-05:00`);
const SEMANA = { abierto: true, desde: '08:00', hasta: '21:00' };
const horario = { 0: null, 1: SEMANA, 2: SEMANA, 3: SEMANA, 4: SEMANA, 5: SEMANA, 6: { abierto: true, desde: '09:00', hasta: '14:00' } };

describe('estadoAtencion', () => {
  it('sin horario o sin ningún día abierto no hay estado', () => {
    expect(estadoAtencion(null)).toBeNull();
    expect(estadoAtencion({})).toBeNull();
    expect(estadoAtencion({ 0: null, 1: { abierto: false, desde: '08:00', hasta: '20:00' } })).toBeNull();
  });
  it('abierta dentro del tramo', () => {
    expect(estadoAtencion(horario, lima(1, '08:00')).abierto).toBe(true);
    expect(estadoAtencion(horario, lima(1, '20:59')).abierto).toBe(true);
  });
  it('dice a qué hora cierra', () => {
    expect(estadoAtencion(horario, lima(1, '10:00')).cierra).toBe('21:00');
    const noche = { 5: { abierto: true, desde: '18:00', hasta: '02:00' } };
    expect(estadoAtencion(noche, lima(6, '01:00')).cierra).toBe('02:00');
  });
  it('"hasta" ya es cerrado', () => {
    expect(estadoAtencion(horario, lima(1, '21:00')).abierto).toBe(false);
  });
  it('antes de abrir: abre hoy', () => {
    const e = estadoAtencion(horario, lima(1, '06:30'));
    expect(e.abierto).toBe(false);
    expect(textoApertura(e)).toBe('Abre hoy a las 8:00 a. m.');
  });
  it('después de cerrar: abre mañana', () => {
    expect(textoApertura(estadoAtencion(horario, lima(2, '22:00')))).toBe('Abre mañana a las 8:00 a. m.');
  });
  it('día cerrado: dice qué día abre', () => {
    // sábado 15:00 -> el domingo está cerrado, abre el lunes
    expect(textoApertura(estadoAtencion(horario, lima(6, '15:00')))).toBe('Abre el lunes a las 8:00 a. m.');
  });
  it('usa la hora de Lima, no la del dispositivo', () => {
    // 03:00 UTC del martes = 22:00 del lunes en Lima -> cerrado
    expect(estadoAtencion(horario, new Date('2026-11-17T03:00:00Z')).abierto).toBe(false);
    // 14:00 UTC del lunes = 09:00 en Lima -> abierto
    expect(estadoAtencion(horario, new Date('2026-11-16T14:00:00Z')).abierto).toBe(true);
  });
  it('horario que cruza la medianoche', () => {
    const noche = { 5: { abierto: true, desde: '18:00', hasta: '02:00' } }; // viernes
    expect(estadoAtencion(noche, lima(5, '23:00')).abierto).toBe(true);
    expect(estadoAtencion(noche, lima(6, '01:00')).abierto).toBe(true); // sábado de madrugada, sigue el del viernes
    expect(estadoAtencion(noche, lima(6, '02:00')).abierto).toBe(false);
    expect(estadoAtencion(noche, lima(5, '01:00')).abierto).toBe(false); // la madrugada del viernes no es suya
    expect(estadoAtencion(noche, lima(5, '17:00')).abierto).toBe(false);
  });
  it('desde = hasta es todo el día', () => {
    const todo = { 1: { abierto: true, desde: '00:00', hasta: '00:00' } };
    expect(estadoAtencion(todo, lima(1, '03:15')).abierto).toBe(true);
  });
  it("semana de un solo día: abre el mismo día siguiente", () => {
    const e = estadoAtencion({ 1: SEMANA }, lima(1, '22:00'));
    expect(textoApertura(e)).toBe('Abre el lunes a las 8:00 a. m.');
  });
});

describe('formatoHora12', () => {
  it('12 horas con a. m. / p. m.', () => {
    expect(formatoHora12(0)).toBe('12:00 a. m.');
    expect(formatoHora12(8 * 60)).toBe('8:00 a. m.');
    expect(formatoHora12(12 * 60 + 5)).toBe('12:05 p. m.');
    expect(formatoHora12(18 * 60 + 30)).toBe('6:30 p. m.');
  });
});
