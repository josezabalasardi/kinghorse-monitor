// Agente de IA: resume el historial de jornadas y le pide a Claude patrones nuevos para vigilar.
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk').default;
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const z = require('zod/v4');

const DIR_HIST = path.join(__dirname, 'historial');
const SUG_FILE = path.join(__dirname, 'sugerencias.json');
const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';

let SUG = { lista: [] };
try { SUG = JSON.parse(fs.readFileSync(SUG_FILE, 'utf8')); } catch {}
const saveSug = () => fs.writeFileSync(SUG_FILE, JSON.stringify(SUG, null, 1));

// ---------- historial ----------
// Cada jornada se guarda compacta: [id, uid, carrera, caballo, tipo, monto, premio, estado, hora, clienteId, clienteNombre]
function guardarJornada(fecha, tickets, carreras, taquillas) {
  fs.mkdirSync(DIR_HIST, { recursive: true });
  if (!tickets.length) return;
  const rows = tickets.map(t => { const [tipo, cab] = t.horses.split('-'); return [t.id, t.uid, t.race, cab, tipo, t.income, t.egress || 0, t.status, t.createdAtMs, t.clientId || null, t.clientName || null]; });
  const taq = {}; for (const t of tickets) if (taquillas[t.uid]) taq[t.uid] = { n: taquillas[t.uid].email.replace('@bet.com', ''), m: taquillas[t.uid].moneda, s: taquillas[t.uid].sector };
  fs.writeFileSync(path.join(DIR_HIST, fecha + '.json'), JSON.stringify({ fecha, carreras, taquillas: taq, tickets: rows }));
}
function jornadas() {
  try { return fs.readdirSync(DIR_HIST).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().map(f => JSON.parse(fs.readFileSync(path.join(DIR_HIST, f), 'utf8'))); } catch { return []; }
}

// ---------- resumen de patrones (lo que ve la IA; nunca los tickets crudos) ----------
const r0 = n => Math.round(n);
function resumen() {
  const js = jornadas();
  const taq = {}, cli = {}, porJornada = [];
  for (const j of js) {
    const tot = { BS: { v: 0, p: 0, t: 0 }, USD: { v: 0, p: 0, t: 0 } };
    // ganador de cada carrera = caballo con tickets pagados
    const ganador = {};
    for (const r of j.tickets) if ((r[7] === 'pay' || r[7] === 'win') && r[4] === 'winner') ganador[r[2]] = r[3];
    for (const r of j.tickets) {
      const [, uid, race, cab, tipo, monto, premio, estado, hora, cid, cnom] = r;
      const info = j.taquillas[uid] || { n: uid, m: 'USD', s: 'Otros' };
      const T = taq[uid] ||= { taquilla: info.n, uid, moneda: info.m, sector: info.s, jornadas: new Set(), ventas: 0, premios: 0, tickets: 0, anulados: 0, montoAnulado: 0, ticketMax: 0, tardios: 0, montoTardio: 0, tardiosGanadores: 0, premioTardio: 0, ultimoMin: 0, montoUltimoMin: 0, ganadoresUltimoMin: 0, alGanador: 0 };
      T.jornadas.add(j.fecha);
      if (estado === 'cancel') { T.anulados++; T.montoAnulado += monto; continue; }
      T.ventas += monto; T.premios += premio; T.tickets++; T.ticketMax = Math.max(T.ticketMax, monto);
      tot[info.m].v += monto; tot[info.m].p += premio; tot[info.m].t++;
      if (ganador[race] === cab) T.alGanador += monto;
      const post = j.carreras[race]?.postMs;
      const gano = estado === 'pay' || estado === 'win';
      if (post) {
        const d = (hora - post) / 1000;
        if (d > 0) { T.tardios++; T.montoTardio += monto; if (gano) { T.tardiosGanadores++; T.premioTardio += premio; } }
        else if (d > -120) { T.ultimoMin++; T.montoUltimoMin += monto; if (gano) T.ganadoresUltimoMin++; }
      }
      if (cid) { const C = cli[cid] ||= { cliente: cnom || cid, clienteId: cid, jornadas: new Set(), tickets: 0, ganadores: 0, ventas: 0, premios: 0, taquillas: new Set() }; C.jornadas.add(j.fecha); C.tickets++; C.ventas += monto; C.premios += premio; if (gano) C.ganadores++; C.taquillas.add(info.n); }
    }
    porJornada.push({ fecha: j.fecha, BS: { ventas: r0(tot.BS.v), ganancia: r0(tot.BS.v - tot.BS.p), tickets: tot.BS.t }, USD: { ventas: r0(tot.USD.v), ganancia: r0(tot.USD.v - tot.USD.p), tickets: tot.USD.t } });
  }
  const taquillas = Object.values(taq).map(T => ({
    taquilla: T.taquilla, uid: T.uid, moneda: T.moneda, sector: T.sector, jornadas: T.jornadas.size,
    ventas: r0(T.ventas), ganancia: r0(T.ventas - T.premios), margen: T.ventas ? +((T.ventas - T.premios) / T.ventas * 100).toFixed(1) : 0,
    tickets: T.tickets, ticketMax: T.ticketMax, anulados: T.anulados, montoAnulado: r0(T.montoAnulado),
    tardios: T.tardios, montoTardio: r0(T.montoTardio), tasaAciertoTardios: T.tardios ? +(T.tardiosGanadores / T.tardios * 100).toFixed(1) : null, premioPagadoATardios: r0(T.premioTardio),
    ultimoMinuto: T.ultimoMin, montoUltimoMinuto: r0(T.montoUltimoMin), tasaAciertoUltimoMinuto: T.ultimoMin ? +(T.ganadoresUltimoMin / T.ultimoMin * 100).toFixed(1) : null,
    porcentajeVentaAlGanador: T.ventas ? +(T.alGanador / T.ventas * 100).toFixed(1) : 0,
  }));
  const clientes = Object.values(cli).map(C => ({ cliente: C.cliente, clienteId: C.clienteId, jornadas: C.jornadas.size, tickets: C.tickets, tasaAcierto: +(C.ganadores / C.tickets * 100).toFixed(1), ventas: r0(C.ventas), ganancia: r0(C.ventas - C.premios), taquillas: [...C.taquillas] }))
    .sort((a, b) => a.ganancia - b.ganancia).slice(0, 40);
  return { jornadas: porJornada, taquillas, clientes };
}

// ---------- llamada a Claude ----------
const Regla = z.object({
  tipo: z.enum(['vigilarTaquilla', 'vigilarCliente', 'ajustarUmbral', 'ninguna']).describe('vigilarTaquilla: alerta alta en cada ticket de esa taquilla desde montoMinimo. vigilarCliente: alerta en cada ticket de ese cliente. ajustarUmbral: cambiar un umbral existente. ninguna: solo observación.'),
  taquillaUid: z.string().nullable(),
  clienteId: z.string().nullable(),
  montoMinimo: z.number().nullable(),
  alerta: z.enum(['ventaTardia', 'ticketGrande', 'ticketAtipicoTaquilla', 'taquillaEnPerdida', 'anulaciones', 'cargaEnCaballo']).nullable(),
  campo: z.string().nullable(),
  valor: z.number().nullable(),
});
const Salida = z.object({
  sugerencias: z.array(z.object({
    titulo: z.string().describe('Frase corta, en español'),
    explicacion: z.string().describe('Qué se vio y por qué importa, 2 a 4 oraciones, en español claro para un gerente'),
    evidencia: z.string().describe('Cifras concretas del resumen que lo respaldan'),
    prioridad: z.enum(['alta', 'media', 'baja']),
    regla: Regla,
  })),
});

const SYSTEM = `Eres analista de riesgo de una casa de apuestas hípicas en Venezuela (King Horse en el hipódromo La Rinconada, y The Book). Recibes un resumen del historial de jornadas: por taquilla (punto de venta), por cliente y por jornada, en BS y USD por separado (nunca sumes monedas).
Tu trabajo es encontrar patrones que un gerente debería vigilar: taquillas que ganan demasiado seguido con ventas tardías o de último minuto (posible información privilegiada o ventas pasadas la hora), concentración en el caballo ganador muy por encima del promedio, anulaciones repetidas, tickets máximos fuera de su norma, clientes con tasa de acierto anormal, cambios bruscos entre jornadas.
Compara cada taquilla contra el promedio de su moneda; una cifra sola no es sospechosa. Con pocas jornadas o pocos tickets, dilo y baja la prioridad.
Propón como máximo 8 sugerencias, de la más importante a la menos. Cuando una sugerencia se pueda vigilar automáticamente, complétala en "regla" con los campos que aplican y pon null en los demás; si no, usa tipo "ninguna".
No repitas sugerencias que ya estén activas ni las que el gerente descartó; usa sus motivos para afinar el criterio.`;

async function analizar(config) {
  const r = resumen();
  if (!r.jornadas.length) throw new Error('Todavía no hay jornadas guardadas en el historial.');
  const contexto = {
    umbralesActuales: config.alertas,
    reglasActivas: (config.reglas || []).map(x => ({ titulo: x.titulo, ...x.regla })),
    descartadas: SUG.lista.filter(s => s.estado === 'descartada').slice(-30).map(s => ({ titulo: s.titulo, motivo: s.motivo || '' })),
    resumen: r,
  };
  const client = new Anthropic(process.env.CLAUDE_BASE_URL ? { baseURL: process.env.CLAUDE_BASE_URL } : {});
  const resp = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high', format: zodOutputFormat(Salida) },
    fallbacks: 'default',
    system: SYSTEM,
    messages: [{ role: 'user', content: 'Analiza este historial y propón alertas nuevas:\n\n' + JSON.stringify(contexto) }],
  }, { headers: { 'anthropic-beta': 'server-side-fallback-2026-07-01' } });
  if (resp.stop_reason === 'refusal') throw new Error('La IA no pudo analizar el historial (rechazo).');
  if (!resp.parsed_output) throw new Error('La IA respondió en un formato inesperado.');
  const ahora = Date.now();
  const nuevas = resp.parsed_output.sugerencias.map((s, i) => ({ id: `${ahora}-${i}`, creada: ahora, estado: 'pendiente', ...s }));
  for (const s of SUG.lista) if (s.estado === 'pendiente') s.estado = 'reemplazada';
  SUG.lista.push(...nuevas); saveSug();
  return nuevas;
}

// ---------- perfil histórico de montos por taquilla (para el umbral de ticket grande) ----------
// Solo usa jornadas anteriores a 'antesDe', para que el día en curso no se compare consigo mismo.
function perfiles(antesDe) {
  const montos = {}, dias = {};
  for (const j of jornadas()) {
    if (antesDe && j.fecha >= antesDe) continue;
    for (const r of j.tickets) { if (r[7] === 'cancel') continue; (montos[r[1]] ||= []).push(r[5]); (dias[r[1]] ||= new Set()).add(j.fecha); }
  }
  const out = {};
  for (const [uid, a] of Object.entries(montos)) { a.sort((x, y) => x - y); out[uid] = { montos: a, jornadas: dias[uid].size }; }
  return out;
}
const percentil = (a, p) => a.length ? a[Math.min(a.length - 1, Math.floor(p / 100 * a.length))] : 0;

module.exports = { guardarJornada, jornadas, resumen, analizar, perfiles, percentil, SUG, saveSug, DIR_HIST };
