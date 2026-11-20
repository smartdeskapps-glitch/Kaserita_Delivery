// Horario de atención de una tienda (bodegas.horario_atencion): un objeto por día de la
// semana (0 = domingo ... 6 = sábado) con { abierto, desde: "HH:MM", hasta: "HH:MM" }.
// Es la misma regla que aplica el servidor (migration_48) y que usa el POS:
//  - "hasta" mayor que "desde": tramo normal dentro del mismo día.
//  - "hasta" menor o igual que "desde": cruza la medianoche (18:00 a 02:00); iguales = todo el día.
//  - Sin ningún día abierto es como no tener horario: no se muestra estado ni se bloquea nada.
// La hora siempre es la de Lima (UTC-5 fijo, sin horario de verano), no la del celular del
// cliente, para que coincida con la del servidor.

const DESFASE_LIMA_MS = -5 * 60 * 60 * 1000;
const NOMBRES_DIA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function aMinutos(texto) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(texto || ''));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function tramoDelDia(horario, dia) {
  const cfg = horario?.[String(dia)];
  if (!cfg || !cfg.abierto) return null;
  const desde = aMinutos(cfg.desde);
  const hasta = aMinutos(cfg.hasta);
  if (desde == null || hasta == null) return null;
  return { desde, hasta };
}

function hayDiaAbierto(horario) {
  return Object.values(horario || {}).some((cfg) => cfg && cfg.abierto);
}

// "8:00 a. m." / "6:30 p. m."
export function formatoHora12(minutos) {
  const h = Math.floor(minutos / 60) % 24;
  const m = minutos % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'a. m.' : 'p. m.'}`;
}

// null = sin horario configurado (no se muestra ni se bloquea nada).
// Si no, { abierto, cierra, proxima }: cierra = "HH:MM" de cierre cuando está abierta;
// proxima = { cuando: 'hoy' | 'mañana' | 'el lunes', hora: '8:00 a. m.' }
// cuando está cerrada (null si no vuelve a abrir en los próximos 7 días).
export function estadoAtencion(horario, ahora = new Date()) {
  if (!horario || typeof horario !== 'object' || !hayDiaAbierto(horario)) return null;
  const lima = new Date(ahora.getTime() + DESFASE_LIMA_MS);
  const dia = lima.getUTCDay();
  const minuto = lima.getUTCHours() * 60 + lima.getUTCMinutes();

  const hoy = tramoDelDia(horario, dia);
  const ayer = tramoDelDia(horario, (dia + 6) % 7);
  const horaCierre = (d) => horario[String(d)].hasta;
  if (hoy) {
    if (hoy.desde === hoy.hasta) return { abierto: true, cierra: horaCierre(dia), proxima: null };
    const dentro = hoy.desde < hoy.hasta ? minuto >= hoy.desde && minuto < hoy.hasta : minuto >= hoy.desde; // la madrugada es del tramo de ayer
    if (dentro) return { abierto: true, cierra: horaCierre(dia), proxima: null };
  }
  // Un tramo de ayer que cruzó la medianoche sigue abierto hasta su "hasta".
  if (ayer && ayer.hasta < ayer.desde && minuto < ayer.hasta) {
    return { abierto: true, cierra: horaCierre((dia + 6) % 7), proxima: null };
  }

  for (let salto = 0; salto <= 7; salto++) {
    const tramo = salto === 0 ? hoy : tramoDelDia(horario, (dia + salto) % 7);
    if (!tramo) continue;
    if (salto === 0 && tramo.desde <= minuto) continue; // el de hoy ya pasó
    const cuando = salto === 0 ? 'hoy' : salto === 1 ? 'mañana' : `el ${NOMBRES_DIA[(dia + salto) % 7]}`;
    return { abierto: false, proxima: { cuando, hora: formatoHora12(tramo.desde) } };
  }
  return { abierto: false, proxima: null };
}

// "Abre hoy a las 8:00 a. m." (o "" si no se sabe cuándo abre).
export function textoApertura(estado) {
  const p = estado?.proxima;
  return p ? `Abre ${p.cuando} a las ${p.hora}` : '';
}
