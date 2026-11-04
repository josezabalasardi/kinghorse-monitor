// Monitor en vivo King Horse / The Book: lee ondrv (solo lectura) y calcula tablero y alertas.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ia = require('./ia');
const acceso = require('./auth');

// Administración de usuarios desde la consola:
//   node server.js --usuario <usuario> <clave> [nombre]   crea o cambia la clave
//   node server.js --quitar-usuario <usuario>
//   node server.js --usuarios                             lista
{
  const a = process.argv, i = a.indexOf('--usuario');
  try {
    if (i > 0) { acceso.crear(a[i + 1], a[i + 2], a.slice(i + 3).join(' ')); console.log('Usuario guardado:', a[i + 1]); process.exit(0); }
    if (a.includes('--quitar-usuario')) { acceso.quitar(a[a.indexOf('--quitar-usuario') + 1]); console.log('Usuario quitado'); process.exit(0); }
    if (a.includes('--usuarios')) { console.table(acceso.lista()); process.exit(0); }
  } catch (e) { console.error(e.message); process.exit(1); }
}
const CFG_FILE = path.join(__dirname, 'config.json');
const CFG = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
CFG.telegram ||= { niveles: ['alta'] };
CFG.reglas ||= [];
CFG.alertas.cierreTardio ||= { activa: true, mediaSeg: 60, altaSeg: 180 };
CFG.refresco.calendarioCercaSeg ||= 3;
CFG.alertas.ticketGrande = { activa: true, porTaquilla: true, percentil: 99, vecesAlta: 3, minTickets: 30, pisoBS: 10000, pisoUSD: 50, BS: 100000, USD: 1000, manual: {}, ...CFG.alertas.ticketGrande };
const USER = process.env.ONDRV_USER || 'josezabala@bet.com';
const PASS = process.env.ONDRV_PASS || '';
const PORT = +process.env.PORT || 8080;
const FIXED_DATE = process.env.FECHA || null; // YYYY-MM-DD para repetir un día pasado
const FB_KEY = 'AIzaSyBSzG4R2wZjC7A4QU_fVqz4ux1TTMPxn1g';
const API = 'https://betracing-api-production-81fb.up.railway.app';
const ORG = '8752776';
const SECTORS_FILE = path.join(__dirname, 'sectores.json');
const SECTORES = ['Sportbook', 'Tribuna A', 'Tribuna B', 'Tribuna C', 'Jockey Club', 'The Book', 'Otros'];

if (!PASS) { console.error('Falta ONDRV_PASS'); process.exit(1); }
const BACKFILL = process.argv.includes('--historial') ? +process.argv[process.argv.indexOf('--historial') + 1] || 90 : 0;

// ---------- acceso a ondrv ----------
let auth = { token: null, uid: null, exp: 0 };
async function login() {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FB_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: USER, password: PASS, returnSecureToken: true }) });
  const j = await r.json();
  if (!j.idToken) throw new Error('Login falló: ' + JSON.stringify(j.error || j));
  auth = { token: j.idToken, uid: j.localId, exp: Date.now() + (+j.expiresIn - 300) * 1000 };
}
async function get(p, params = {}) {
  if (!auth.token || Date.now() > auth.exp) await login();
  const u = new URL(API + p);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  const r = await fetch(u, { headers: { Authorization: 'Bearer ' + auth.token, Referer: 'https://www.ondrv.com/' } });
  if (r.status === 401) { auth.token = null; return get(p, params); }
  const j = await r.json();
  if (!j.isSuccess) throw new Error(p + ': ' + (j.message || r.status));
  return j;
}

// ---------- estado ----------
const S = { date: null, taquillas: {}, grupos: {}, carreras: {}, tickets: new Map(), lastFull: 0, lastNew: 0, lastCal: 0, error: null, updatedAt: 0 };
let sectorOverrides = {};
try { sectorOverrides = JSON.parse(fs.readFileSync(SECTORS_FILE, 'utf8')); } catch {}

const today = () => FIXED_DATE || new Date(Date.now() - 4 * 3600e3).toISOString().slice(0, 10); // hora de Venezuela
const dmy = iso => { const [y, m, d] = iso.split('-'); return `${+d}/${+m}/${y}`; };

function sectorFromGroups(names) {
  const n = names.join(' ').toLowerCase();
  if (/tribuna_a|tribuna_a_piso/.test(n)) return 'Tribuna A';
  if (/tribunab|tribuna_b/.test(n)) return 'Tribuna B';
  if (/tribuna_c/.test(n)) return 'Tribuna C';
  if (/jockey_club/.test(n)) return 'Jockey Club';
  if (/sportbook/.test(n)) return 'Sportbook';
  if (/the_book/.test(n)) return 'The Book';
  return 'Otros';
}
const sectorOf = uid => sectorOverrides[uid] || S.taquillas[uid]?.sectorOndrv || 'Otros';
const nameOf = (uid, email) => (S.taquillas[uid]?.email || email || uid).replace('@bet.com', '');

async function loadCatalogs() {
  const g = await get('/api/groups', { orgId: ORG, actorId: auth.uid });
  S.grupos = Object.fromEntries(g.data.map(x => [x.id, x.name]));
  const b = await get('/get-boxoffices', { rootId: auth.uid, orgId: ORG, onlyBoxOffices: true });
  S.taquillas = {};
  for (const t of b.data) { // solo lo necesario: nunca guardamos contraseñas
    const gn = (t.groups || []).map(id => S.grupos[id] || id);
    S.taquillas[t.id] = { email: t.email, moneda: t.currency, grupos: gn, sectorOndrv: sectorFromGroups(gn), estado: t.status };
  }
}
// ondrv no guarda la hora real de cierre: el monitor la captura al ver que la carrera pasa a "Closed".
const DIR_CIERRES = path.join(__dirname, 'cierres');
let CIERRES = { fecha: null, datos: {} };
function cierresDe(fecha) {
  if (CIERRES.fecha !== fecha) { CIERRES = { fecha, datos: {} }; try { CIERRES.datos = JSON.parse(fs.readFileSync(path.join(DIR_CIERRES, fecha + '.json'), 'utf8')); } catch {} }
  return CIERRES.datos;
}
async function loadCalendar() {
  const c = await get('/api/closes/day', { date: S.date });
  const h = c.data.hipodromos.find(x => x.brisCode === CFG.hipodromo);
  const prev = S.carreras, cie = cierresDe(S.date), now = Date.now(); let nuevo = false;
  S.carreras = {};
  for (const r of h?.races || []) {
    const n = +r.raceNumber, cerrada = r.status === 'Closed';
    // solo se registra si la vimos abierta antes: así la hora es real (con margen del refresco)
    if (!FIXED_DATE && cerrada && prev[n] && prev[n].status !== 'Closed' && !cie[n]) { cie[n] = { closeMs: now, margenSeg: Math.round((now - (S.lastCal || now)) / 1000) }; nuevo = true; }
    S.carreras[n] = { postMs: r.postMs, postTime: r.postTime, status: r.status, hasResult: r.hasResult, closeMs: cie[n]?.closeMs || null, margenSeg: cie[n]?.margenSeg ?? null };
  }
  if (nuevo) { fs.mkdirSync(DIR_CIERRES, { recursive: true }); fs.writeFileSync(path.join(DIR_CIERRES, S.date + '.json'), JSON.stringify(cie, null, 1)); }
  S.lastCal = now;
}
// ¿hay una carrera por cerrar? entonces el calendario se consulta más seguido
function carreraPorCerrar() {
  const now = Date.now();
  return Object.values(S.carreras).some(c => c.status !== 'Closed' && c.postMs && now > c.postMs - 3 * 60e3 && now < c.postMs + 20 * 60e3);
}
function addTickets(rows) { for (const t of rows) S.tickets.set(t.id, t); }
async function loadAllTickets() {
  const j = await get('/api/history-org', { orgId: ORG, date: dmy(S.date), userId: auth.uid, brisCode: CFG.hipodromo, exportAll: true });
  S.tickets = new Map(); addTickets(j.data); S.lastFull = Date.now();
  if (!FIXED_DATE || BACKFILL) guardarHistorial();
}
function guardarHistorial() {
  const taq = {}; for (const [uid, t] of Object.entries(S.taquillas)) taq[uid] = { ...t, sector: sectorOf(uid) };
  try { ia.guardarJornada(S.date, [...S.tickets.values()], S.carreras, taq); } catch (e) { console.error('historial', e.message); }
}
async function descargarHistorial(dias) {
  await login(); await loadCatalogs();
  for (let i = 1; i <= dias; i++) {
    S.date = new Date(Date.now() - 4 * 3600e3 - i * 86400e3).toISOString().slice(0, 10);
    try { await loadCalendar(); await loadAllTickets(); console.log(S.date, S.tickets.size, 'tickets'); } catch (e) { console.log(S.date, 'error', e.message); }
  }
}
async function loadNewTickets() {
  const j = await get('/api/history-org', { orgId: ORG, date: dmy(S.date), userId: auth.uid, brisCode: CFG.hipodromo, limit: 300 });
  addTickets(j.data); S.lastNew = Date.now();
}

let busy = false;
async function tick() {
  if (busy) return; busy = true;
  try {
    const d = today();
    if (d !== S.date || !Object.keys(S.taquillas).length) { S.date = d; await login(); await loadCatalogs(); await loadCalendar(); await loadAllTickets(); }
    else if (!FIXED_DATE) {
      const now = Date.now(), R = CFG.refresco;
      if (now - S.lastCal > (carreraPorCerrar() ? (R.calendarioCercaSeg || 3) : R.calendarioSeg) * 1e3) await loadCalendar();
      if (now - S.lastFull > R.ticketsCompletoSeg * 1e3) await loadAllTickets();
      else if (now - S.lastNew > R.ticketsNuevosSeg * 1e3) await loadNewTickets();
    }
    S.error = null; S.updatedAt = Date.now();
  } catch (e) { S.error = e.message; console.error(new Date().toISOString(), e.message); }
  busy = false;
}

// ---------- cálculo ----------
const blank = () => ({ ventas: 0, premios: 0, tickets: 0, anulado: 0, anulados: 0 });
function acc(o, t) {
  if (t.status === 'cancel') { o.anulado += t.income; o.anulados++; return; }
  o.ventas += t.income; o.premios += t.egress || 0; o.tickets++;
}
const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// Perfil histórico por taquilla, recalculado cuando cambia el día
let PERF = { fecha: null, datos: {} };
function perfilDe(uid) {
  if (PERF.fecha !== S.date) PERF = { fecha: S.date, datos: ia.perfiles(S.date) };
  return PERF.datos[uid];
}
function umbralGrande(uid, cur) {
  const G = CFG.alertas.ticketGrande;
  if (G.manual && G.manual[uid] > 0) return { monto: G.manual[uid], fuente: 'manual', record: perfilDe(uid)?.montos.at(-1) || 0 };
  const P = perfilDe(uid);
  if (G.porTaquilla && P && P.montos.length >= G.minTickets) {
    const piso = cur === 'BS' ? G.pisoBS : G.pisoUSD;
    return { monto: Math.max(piso, ia.percentil(P.montos, G.percentil)), fuente: 'historial', record: P.montos.at(-1) };
  }
  return { monto: G[cur], fuente: 'general', record: 0 };
}
function infoUmbral(uid, cur) {
  const P = perfilDe(uid), U = umbralGrande(uid, cur);
  return { ...U, tickets: P?.montos.length || 0, jornadas: P?.jornadas || 0, mediana: P ? ia.percentil(P.montos, 50) : null, p95: P ? ia.percentil(P.montos, 95) : null, p99: P ? ia.percentil(P.montos, 99) : null, manual: CFG.alertas.ticketGrande.manual?.[uid] || null };
}

function snapshot(until) {
  const A = CFG.alertas;
  const all = [...S.tickets.values()].filter(t => !until || t.createdAtMs <= until).sort((a, b) => a.createdAtMs - b.createdAtMs);
  const now = until || (FIXED_DATE && all.length ? all[all.length - 1].createdAtMs : Date.now());
  const tot = { BS: blank(), USD: blank() };
  const sect = {}; for (const s of SECTORES) sect[s] = { BS: blank(), USD: blank() };
  const taq = {}; const races = {}; const alerts = [];
  const ticketsByTaq = {};

  for (const t of all) {
    const cur = S.taquillas[t.uid]?.moneda || 'USD';
    const sec = sectorOf(t.uid);
    acc(tot[cur], t); acc(sect[sec][cur], t);
    const tq = taq[t.uid] ||= { uid: t.uid, nombre: nameOf(t.uid, t.email), sector: sec, moneda: cur, ...blank() };
    acc(tq, t); tq.last = t.createdAtMs;
    if (t.status !== 'cancel') (ticketsByTaq[t.uid] ||= []).push(t.income);
    const [tipo, horse] = t.horses.split('-');
    const R = races[t.race] ||= { carrera: t.race, BS: blank(), USD: blank(), caballos: {}, tardias: 0 };
    acc(R[cur], t); R.last = t.createdAtMs;
    const H = R.caballos[horse] ||= { caballo: horse, BS: blank(), USD: blank(), porSector: {}, porTaquilla: {} };
    acc(H[cur], t);
    const hs = H.porSector[sec] ||= { BS: blank(), USD: blank() }; acc(hs[cur], t);
    const ht = H.porTaquilla[t.uid] ||= { nombre: tq.nombre, sector: sec, moneda: cur, ...blank() }; acc(ht, t);

    if (t.status === 'cancel') continue;
    const base = { hora: t.createdAtMs, carrera: t.race, taquilla: tq.nombre, uid: t.uid, sector: sec, moneda: cur, monto: t.income, jugada: `${tipo} ${horse}`, ticket: t.id, estado: t.status };
    // 1. venta después de la hora asignada (y, si se capturó, después del cierre real)
    const C = S.carreras[t.race], post = C?.postMs;
    if (A.ventaTardia.activa && post && t.createdAtMs > post + (A.ventaTardia.leveSeg || 0) * 1000) {
      const seg = Math.round((t.createdAtMs - post) / 1000); R.tardias++;
      const gano = t.status === 'pay' || t.status === 'win';
      const trasCierre = C.closeMs && t.createdAtMs > C.closeMs;
      let nivel = seg >= A.ventaTardia.graveSeg ? 'alta' : seg >= A.ventaTardia.mediaSeg ? 'media' : 'baja';
      if (gano && nivel !== 'alta') nivel = nivel === 'baja' ? 'media' : 'alta';
      if (trasCierre) nivel = 'alta';
      const cierreTxt = C.closeMs ? (trasCierre ? ` · VENDIDO ${Math.round((t.createdAtMs - C.closeMs) / 1000)} s DESPUÉS DEL CIERRE REAL` : ` · la carrera seguía abierta (cerró a +${Math.round((C.closeMs - post) / 1000)} s)`) : '';
      alerts.push({ ...base, tipo: 'Venta tardía', nivel, trasCierre: !!trasCierre,
        detalle: `${seg} s después de la hora (${C.postTime})${cierreTxt}${gano ? ' · ticket GANADOR, pagó ' + fmt(t.egress) : ''}` });
    }
    // 2. ticket grande: umbral propio de cada taquilla según su historial
    const U = A.ticketGrande.activa ? umbralGrande(t.uid, cur) : null;
    if (U && t.income > U.monto) {
      const alta = t.income >= U.monto * (A.ticketGrande.vecesAlta || 3) || (U.record && t.income > U.record);
      alerts.push({ ...base, tipo: 'Ticket grande', nivel: alta ? 'alta' : 'media',
        detalle: `${fmt(t.income)} ${cur} · ${U.fuente === 'historial' ? `lo habitual en esta taquilla es hasta ${fmt(U.monto)} (récord ${fmt(U.record)})` : U.fuente === 'manual' ? `umbral fijado para esta taquilla: ${fmt(U.monto)}` : `sin historial suficiente, umbral general ${fmt(U.monto)}`}${U.record && t.income > U.record ? ' · NUEVO RÉCORD' : ''}` });
    }
    // 3. ticket atípico para esa taquilla
    const hist = ticketsByTaq[t.uid];
    if (A.ticketAtipicoTaquilla.activa && hist.length >= 10 && !(U && (t.income > U.monto || U.fuente !== 'general'))) {
      const m = median(hist.slice(0, -1));
      const min = cur === 'BS' ? A.ticketAtipicoTaquilla.minimoBS : A.ticketAtipicoTaquilla.minimoUSD;
      if (m > 0 && t.income >= m * A.ticketAtipicoTaquilla.vecesMediana && t.income >= min)
        alerts.push({ ...base, tipo: 'Apuesta atípica', nivel: 'media', detalle: `${Math.round(t.income / m)}× el ticket normal de esta taquilla (${fmt(m)})` });
    }
  }
  // cierre tardío: la carrera se cerró mucho después de la hora programada
  if (A.cierreTardio?.activa) for (const [n, c] of Object.entries(S.carreras)) {
    if (!c.closeMs || !c.postMs || c.closeMs > now) continue;
    const seg = Math.round((c.closeMs - c.postMs) / 1000);
    if (seg < A.cierreTardio.mediaSeg) continue;
    const R = races[n], venta = R ? R.BS.ventas + R.USD.ventas : 0;
    alerts.push({ hora: c.closeMs, carrera: +n, tipo: 'Cierre tardío', nivel: seg >= A.cierreTardio.altaSeg ? 'alta' : 'media',
      detalle: `La carrera se cerró ${seg} s después de la hora (${c.postTime})${R?.tardias ? ` · ${R.tardias} tickets vendidos en ese tiempo` : ''}` });
  }
  // reglas aprobadas desde las sugerencias de la IA
  if (CFG.reglas.length) for (const t of all) {
    if (t.status === 'cancel') continue;
    for (const rg of CFG.reglas) {
      const x = rg.regla;
      const hit = (x.tipo === 'vigilarTaquilla' && t.uid === x.taquillaUid && t.income >= (x.montoMinimo || 0)) ||
                  (x.tipo === 'vigilarCliente' && t.clientId && t.clientId === x.clienteId && t.income >= (x.montoMinimo || 0));
      if (!hit) continue;
      const cur = S.taquillas[t.uid]?.moneda || 'USD', [tipo, horse] = t.horses.split('-');
      alerts.push({ hora: t.createdAtMs, carrera: t.race, taquilla: nameOf(t.uid, t.email), uid: t.uid, sector: sectorOf(t.uid), moneda: cur, monto: t.income, jugada: `${tipo} ${horse}`, ticket: t.id, estado: t.status,
        tipo: 'Regla: ' + rg.titulo, nivel: 'alta', detalle: (t.clientName ? 'Cliente ' + t.clientName + ' · ' : '') + 'Regla sugerida por la IA y aprobada' });
    }
  }
  // 4. taquilla en pérdida, 5. anulaciones
  for (const tq of Object.values(taq)) {
    const g = tq.ventas - tq.premios;
    if (A.taquillaEnPerdida.activa && g <= A.taquillaEnPerdida[tq.moneda])
      alerts.push({ hora: tq.last, tipo: 'Taquilla en pérdida', nivel: 'alta', taquilla: tq.nombre, uid: tq.uid, sector: tq.sector, moneda: tq.moneda, monto: g, detalle: `Ganancia ${fmt(g)} ${tq.moneda} con ${tq.tickets} tickets` });
    if (A.anulaciones.activa && (tq.anulados >= A.anulaciones.cantidad || (tq.ventas && tq.anulado / tq.ventas * 100 >= A.anulaciones.porcentajeVenta)))
      alerts.push({ hora: tq.last, tipo: 'Anulaciones', nivel: 'media', taquilla: tq.nombre, uid: tq.uid, sector: tq.sector, moneda: tq.moneda, monto: tq.anulado, detalle: `${tq.anulados} anulados por ${fmt(tq.anulado)} ${tq.moneda} (${tq.ventas ? Math.round(tq.anulado / tq.ventas * 100) : 0} % de la venta)` });
  }
  // 6. carga concentrada en un caballo
  for (const R of Object.values(races)) for (const cur of ['BS', 'USD']) {
    const tv = R[cur].ventas; const min = A.cargaEnCaballo['minimo' + cur];
    for (const H of Object.values(R.caballos)) {
      const p = tv ? H[cur].ventas / tv * 100 : 0;
      if (A.cargaEnCaballo.activa && p >= A.cargaEnCaballo.porcentaje && H[cur].ventas >= min)
        alerts.push({ hora: R.last, carrera: R.carrera, tipo: 'Carga en un caballo', nivel: 'media', moneda: cur, monto: H[cur].ventas, taquilla: '—', sector: '—', detalle: `Caballo ${H.caballo}: ${Math.round(p)} % del dinero ${cur} de la carrera ${R.carrera}` });
    }
  }
  for (const a of alerts) { a.id = [a.tipo, a.ticket || '', a.uid || '', a.carrera || '', a.moneda || ''].join('|'); if (TG.acks[a.id]) a.revisado = TG.acks[a.id]; if (a.uid && TG.mutes[a.uid] > Date.now()) a.silenciada = true; }
  const order = { alta: 0, media: 1, baja: 2 };
  alerts.sort((a, b) => b.hora - a.hora || order[a.nivel] - order[b.nivel]);
  const carreras = Object.entries(S.carreras).map(([n, c]) => ({ carrera: +n, ...c, minutos: Math.round((c.postMs - now) / 60000),
    cerrada: until || FIXED_DATE ? (c.closeMs ? now >= c.closeMs : now >= c.postMs + 3 * 60e3) : c.status === 'Closed' }));
  return { fecha: S.date, ahora: now, modo: FIXED_DATE ? 'repeticion' : 'vivo', actualizado: S.updatedAt, error: S.error,
    rango: S.tickets.size ? [Math.min(...[...S.tickets.values()].map(t => t.createdAtMs)), Math.max(...[...S.tickets.values()].map(t => t.createdAtMs))] : null,
    totales: tot, sectores: sect, taquillas: Object.values(taq), carreras, races, alertas: alerts.slice(0, 1500), totalAlertas: alerts.length };
}
const fmt = n => Math.round(n).toLocaleString('es-VE');

// ---------- Telegram ----------
// TELEGRAM_TOKEN: token del bot (de @BotFather). TELEGRAM_PIN: clave que cada supervisor manda con /start <PIN> para suscribirse.
const TG_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TG_PIN = process.env.TELEGRAM_PIN || '';
const TG_API = process.env.TELEGRAM_API || 'https://api.telegram.org';
const TG_FILE = path.join(__dirname, 'telegram.json');
const TG = { chats: {}, acks: {}, mutes: {}, sent: null, offset: 0 };
try { Object.assign(TG, JSON.parse(fs.readFileSync(TG_FILE, 'utf8')), { sent: null }); } catch {}
function saveTG() { fs.writeFileSync(TG_FILE, JSON.stringify({ chats: TG.chats, acks: TG.acks, mutes: TG.mutes, offset: TG.offset }, null, 1)); }
async function tg(method, body) {
  const r = await fetch(`${TG_API}/bot${TG_TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
const escH = t => String(t ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const horaVE = ms => new Date(ms).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'America/Caracas' });
function alertText(a) {
  const ico = { alta: '🔴', media: '🟠', baja: '⚪' }[a.nivel];
  return `${ico} <b>${escH(a.tipo)}</b>${a.carrera ? ' · Carrera ' + a.carrera : ''}\n` +
    `${escH(a.taquilla && a.taquilla !== '—' ? a.taquilla : '')}${a.sector && a.sector !== '—' ? ' · ' + escH(a.sector) : ''}${a.jugada ? ' · ' + escH(a.jugada) : ''}\n` +
    `${a.monto != null ? '<b>' + fmt(a.monto) + ' ' + a.moneda + '</b> · ' : ''}${escH(a.detalle)}\n<i>${horaVE(a.hora)}</i>`;
}
const keyboard = a => ({ inline_keyboard: [[
  { text: '✅ Revisado', callback_data: 'ok|' + a.id.slice(0, 50) },
  ...(a.uid ? [{ text: '🔕 Silenciar 1 h', callback_data: 'mute|' + a.uid }] : []),
  { text: '⚠️ Escalar', callback_data: 'esc|' + a.id.slice(0, 50) },
]] });
const lastAlerts = new Map(); // id recortado -> alerta, para resolver los botones
async function tgNotify() {
  if (!TG_TOKEN || (FIXED_DATE && !process.env.TELEGRAM_API) || !S.updatedAt) return;
  const snap = snapshot(null);
  const nuevas = snap.alertas.filter(a => CFG.telegram.niveles.includes(a.nivel));
  if (!TG.sent) { TG.sent = new Set(nuevas.slice(process.env.TELEGRAM_API ? 2 : 0).map(a => a.id)); return; } // al arrancar no reenvía lo viejo
  for (const a of nuevas.reverse()) {
    if (TG.sent.has(a.id)) continue; TG.sent.add(a.id); lastAlerts.set(a.id.slice(0, 50), a);
    if (a.silenciada) continue;
    for (const chat of Object.keys(TG.chats)) await tg('sendMessage', { chat_id: chat, text: alertText(a), parse_mode: 'HTML', reply_markup: keyboard(a) }).catch(() => {});
  }
}
async function tgPoll() {
  if (!TG_TOKEN) return;
  try {
    const r = await fetch(`${TG_API}/bot${TG_TOKEN}/getUpdates?timeout=25&offset=${TG.offset}`);
    const j = await r.json();
    if (!j.ok) throw new Error(`getUpdates ${j.error_code}: ${j.description}${j.error_code === 409 ? ' (el bot tiene un webhook o lo usa otro programa)' : ''}`);
    for (const up of j.result || []) {
      TG.offset = up.update_id + 1;
      const m = up.message, cb = up.callback_query;
      if (m?.text) {
        const chat = m.chat.id, who = m.from.first_name || m.from.username || 'alguien', [cmd, arg] = m.text.trim().split(/\s+/);
        if (cmd === '/start') {
          if (TG_PIN && arg !== TG_PIN) { await tg('sendMessage', { chat_id: chat, text: 'Clave incorrecta. Escribe /start seguido de la clave.' }); continue; }
          TG.chats[chat] = { nombre: who, desde: Date.now() }; saveTG();
          await tg('sendMessage', { chat_id: chat, text: `Listo ${who}, vas a recibir las alertas (${CFG.telegram.niveles.join(', ')}). Comandos: /resumen, /alertas, /salir` });
        } else if (!TG.chats[chat]) { await tg('sendMessage', { chat_id: chat, text: 'Escribe /start seguido de la clave para suscribirte.' }); }
        else if (cmd === '/salir') { delete TG.chats[chat]; saveTG(); await tg('sendMessage', { chat_id: chat, text: 'Ya no recibirás alertas.' }); }
        else if (cmd === '/resumen') {
          const s = snapshot(null), t = s.totales;
          const line = c => `${c}: ventas ${fmt(t[c].ventas)} · ganancia ${fmt(t[c].ventas - t[c].premios)} · ${t[c].tickets} tickets`;
          await tg('sendMessage', { chat_id: chat, text: `<b>La Rinconada ${s.fecha}</b>\n${line('BS')}\n${line('USD')}\nAlertas altas: ${s.alertas.filter(a => a.nivel === 'alta').length}`, parse_mode: 'HTML' });
        } else if (cmd === '/alertas') {
          const al = snapshot(null).alertas.filter(a => a.nivel === 'alta').slice(0, 5);
          await tg('sendMessage', { chat_id: chat, text: al.map(alertText).join('\n\n') || 'Sin alertas altas.', parse_mode: 'HTML' });
        }
      }
      if (cb && TG.chats[cb.message.chat.id]) {
        const who = cb.from.first_name || cb.from.username || 'alguien'; const cut = cb.data.indexOf('|'), acc = cb.data.slice(0, cut), ref = cb.data.slice(cut + 1);
        const a = [...lastAlerts.entries()].find(([k]) => k === ref)?.[1];
        let nota = '';
        if (acc === 'ok') { const full = a?.id || ref; TG.acks[full] = { quien: who, hora: Date.now() }; nota = `✅ Revisado por ${who}`; }
        if (acc === 'mute') { TG.mutes[ref] = Date.now() + 3600e3; nota = `🔕 ${who} silenció ${nameOf(ref)} por 1 hora`; }
        if (acc === 'esc') {
          nota = `⚠️ Escalado por ${who}`;
          for (const chat of Object.keys(TG.chats)) if (+chat !== cb.message.chat.id) await tg('sendMessage', { chat_id: chat, text: `⚠️ <b>${escH(who)} escaló esta alerta</b>\n\n${a ? alertText(a) : escH(cb.message.text)}`, parse_mode: 'HTML' });
        }
        saveTG();
        await tg('answerCallbackQuery', { callback_query_id: cb.id, text: nota });
        await tg('editMessageText', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text: (a ? alertText(a) : escH(cb.message.text)) + '\n\n' + escH(nota), parse_mode: 'HTML', reply_markup: acc === 'ok' ? undefined : keyboard(a || { id: ref }) }).catch(() => {});
      }
    }
  } catch (e) { console.error('telegram', e.message); await new Promise(r => setTimeout(r, 5000)); }
  setImmediate(tgPoll);
}
if (TG_TOKEN) { tgPoll(); setInterval(() => tgNotify().catch(e => console.error('telegram', e.message)), 5000); console.log('Telegram activo'); }

// ---------- IA ----------
const IA = { corriendo: false, error: null, ultimoDia: null };
async function correrIA() {
  if (IA.corriendo) return; IA.corriendo = true; IA.error = null;
  try {
    const nuevas = await ia.analizar(CFG);
    console.log('IA:', nuevas.length, 'sugerencias');
    if (TG_TOKEN && nuevas.length) for (const chat of Object.keys(TG.chats))
      await tg('sendMessage', { chat_id: chat, text: `🤖 La IA tiene ${nuevas.length} sugerencias nuevas para revisar en el monitor:\n` + nuevas.map(x => '• ' + x.titulo).join('\n') }).catch(() => {});
  } catch (e) { IA.error = e.message; console.error('IA', e.message); }
  IA.corriendo = false;
}
// cada noche a las 23:00 (hora de Venezuela), si hay clave de Anthropic
setInterval(() => {
  const ve = new Date(Date.now() - 4 * 3600e3), dia = ve.toISOString().slice(0, 10);
  if ((process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) && ve.getUTCHours() === 23 && IA.ultimoDia !== dia && !FIXED_DATE) { IA.ultimoDia = dia; correrIA(); }
}, 5 * 60e3);

// ---------- servidor ----------
const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
if (BACKFILL) { descargarHistorial(BACKFILL).then(() => { console.log('Historial listo'); process.exit(0); }); return; }
const ABIERTO = process.env.MONITOR_ABIERTO === '1'; // solo para pruebas locales
if (!acceso.hayUsuarios() && !ABIERTO && !BACKFILL) { console.error('No hay usuarios. Crea uno con: node server.js --usuario <usuario> <clave> [nombre]'); process.exit(1); }
const PUBLICAS = new Set(['/login', '/login.html', '/api/login', '/manifest.json', '/icon.svg', '/logo.png', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/favicon.png', '/favicon.ico']);
const ipDe = req => { const ip = req.socket.remoteAddress || ''; return (/^(::ffff:)?127\.0\.0\.1$|^::1$/.test(ip) && req.headers['x-forwarded-for']) ? req.headers['x-forwarded-for'].split(',')[0].trim() : ip; };
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/api/login' && req.method === 'POST') {
      const ip = ipDe(req);
      if (acceso.bloqueado(ip)) return send(res, 429, { error: 'Demasiados intentos. Espera 15 minutos.' });
      let b = ''; for await (const c of req) { b += c; if (b.length > 2000) break; }
      let d = {}; try { d = JSON.parse(b); } catch {}
      const quien = acceso.verificar(d.usuario, d.clave);
      if (!quien) { acceso.fallo(ip); return send(res, 401, { error: 'Usuario o clave incorrectos' }); }
      acceso.ok(ip);
      res.setHeader('Set-Cookie', acceso.cookie(req, acceso.token(quien), acceso.DIAS * 86400));
      return send(res, 200, { ok: true });
    }
    if (u.pathname === '/api/salir') { res.setHeader('Set-Cookie', acceso.cookie(req, '', 0)); return send(res, 200, { ok: true }); }
    if (u.pathname === '/login') { res.writeHead(302, { Location: '/login.html' }); return res.end(); }
    req.sesion = ABIERTO ? { usuario: 'local', nombre: 'local' } : acceso.leer(req);
    if (!req.sesion && !PUBLICAS.has(u.pathname)) {
      if (u.pathname.startsWith('/api/')) return send(res, 401, { error: 'Inicia sesión' });
      res.writeHead(302, { Location: '/login.html' }); return res.end();
    }
    if (u.pathname === '/api/yo') return send(res, 200, req.sesion);
    if (u.pathname === '/api/estado') return send(res, 200, snapshot(+u.searchParams.get('hasta') || null));
    if (u.pathname === '/api/config' && req.method === 'GET') return send(res, 200, { alertas: CFG.alertas, telegram: { activo: !!TG_TOKEN, niveles: CFG.telegram.niveles, suscriptores: Object.keys(TG.chats).length } });
    if (u.pathname === '/api/config' && req.method === 'POST') {
      let b = ''; for await (const c of req) b += c; const nuevo = JSON.parse(b);
      for (const [tipo, conf] of Object.entries(nuevo.alertas || {})) {
        if (!CFG.alertas[tipo]) continue;
        for (const [k, v] of Object.entries(conf)) {
          if (!(k in CFG.alertas[tipo])) continue;
          if (typeof CFG.alertas[tipo][k] === 'boolean') CFG.alertas[tipo][k] = !!v;
          else if (Number.isFinite(+v)) CFG.alertas[tipo][k] = +v;
        }
      }
      if (Array.isArray(nuevo.telegramNiveles)) CFG.telegram.niveles = nuevo.telegramNiveles.filter(n => ['alta', 'media', 'baja'].includes(n));
      fs.writeFileSync(CFG_FILE, JSON.stringify(CFG, null, 2));
      return send(res, 200, { ok: true, alertas: CFG.alertas });
    }
    if (u.pathname === '/api/revisar' && req.method === 'POST') {
      let b = ''; for await (const c of req) b += c; const { id, quien } = JSON.parse(b);
      TG.acks[id] = { quien: req.sesion?.nombre || String(quien || 'app').slice(0, 40), hora: Date.now() }; saveTG();
      return send(res, 200, { ok: true });
    }
    if (u.pathname === '/api/sugerencias' && req.method === 'GET') {
      const L = ia.SUG.lista;
      return send(res, 200, { iaActiva: !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN), jornadas: ia.jornadas().map(j => j.fecha), analizando: !!IA.corriendo, error: IA.error,
        pendientes: L.filter(x => x.estado === 'pendiente'), revisadas: L.filter(x => ['aprobada', 'descartada'].includes(x.estado)).slice(-20).reverse(), reglas: CFG.reglas });
    }
    if (u.pathname === '/api/sugerencias/analizar' && req.method === 'POST') { correrIA(); return send(res, 200, { ok: true }); }
    if (u.pathname === '/api/sugerencias/accion' && req.method === 'POST') {
      let b = ''; for await (const c of req) b += c; const { id, accion, motivo, quien } = JSON.parse(b);
      const sg = ia.SUG.lista.find(x => x.id === id); if (!sg || sg.estado !== 'pendiente') return send(res, 400, { error: 'no existe' });
      sg.estado = accion === 'aprobar' ? 'aprobada' : 'descartada'; sg.motivo = String(motivo || '').slice(0, 300); sg.quien = req.sesion?.nombre || String(quien || '').slice(0, 40); sg.revisada = Date.now();
      if (sg.estado === 'aprobada') {
        const x = sg.regla;
        if (x.tipo === 'ajustarUmbral' && CFG.alertas[x.alerta] && typeof CFG.alertas[x.alerta][x.campo] === 'number' && Number.isFinite(x.valor)) CFG.alertas[x.alerta][x.campo] = x.valor;
        else if (x.tipo === 'vigilarTaquilla' || x.tipo === 'vigilarCliente') CFG.reglas.push({ id: sg.id, titulo: sg.titulo, regla: x, desde: Date.now() });
        fs.writeFileSync(CFG_FILE, JSON.stringify(CFG, null, 2));
      }
      ia.saveSug(); return send(res, 200, { ok: true });
    }
    if (u.pathname === '/api/reglas/quitar' && req.method === 'POST') {
      let b = ''; for await (const c of req) b += c; const { id } = JSON.parse(b);
      CFG.reglas = CFG.reglas.filter(r => r.id !== id); fs.writeFileSync(CFG_FILE, JSON.stringify(CFG, null, 2));
      return send(res, 200, { ok: true });
    }
    if (u.pathname === '/api/taquillas') return send(res, 200, { sectores: SECTORES, taquillas: Object.entries(S.taquillas).map(([uid, t]) => ({ uid, nombre: t.email.replace('@bet.com', ''), moneda: t.moneda, sector: sectorOf(uid), sectorOndrv: t.sectorOndrv, grupos: t.grupos })) });
    if (u.pathname === '/api/umbral' && req.method === 'GET') {
      const uid = u.searchParams.get('uid'); if (!S.taquillas[uid]) return send(res, 400, { error: 'no existe' });
      return send(res, 200, infoUmbral(uid, S.taquillas[uid].moneda));
    }
    if (u.pathname === '/api/umbral' && req.method === 'POST') {
      let b = ''; for await (const c of req) b += c; const { uid, monto } = JSON.parse(b);
      if (!S.taquillas[uid]) return send(res, 400, { error: 'no existe' });
      const G = CFG.alertas.ticketGrande; G.manual ||= {};
      if (Number.isFinite(+monto) && +monto > 0) G.manual[uid] = +monto; else delete G.manual[uid];
      fs.writeFileSync(CFG_FILE, JSON.stringify(CFG, null, 2));
      return send(res, 200, infoUmbral(uid, S.taquillas[uid].moneda));
    }
    if (u.pathname === '/api/sector' && req.method === 'POST') {
      let b = ''; for await (const c of req) b += c; const { uid, sector } = JSON.parse(b);
      if (!S.taquillas[uid] || !SECTORES.includes(sector)) return send(res, 400, { error: 'datos inválidos' });
      if (sector === S.taquillas[uid].sectorOndrv) delete sectorOverrides[uid]; else sectorOverrides[uid] = sector;
      fs.writeFileSync(SECTORS_FILE, JSON.stringify(sectorOverrides, null, 1));
      return send(res, 200, { ok: true });
    }
    const f = path.join(__dirname, 'public', u.pathname === '/' ? 'index.html' : path.normalize(u.pathname).replace(/^(\.\.[\/\\])+/, ''));
    if (f.startsWith(path.join(__dirname, 'public')) && fs.existsSync(f)) return send(res, 200, fs.readFileSync(f), ({ '.html': 'text/html; charset=utf-8', '.json': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' })[path.extname(f)] || 'text/plain');
    send(res, 404, { error: 'no existe' });
  } catch (e) { send(res, 500, { error: e.message }); }
}).listen(PORT, process.env.HOST || '0.0.0.0', () => console.log(`Monitor en http://${process.env.HOST || 'localhost'}:${PORT} · ${FIXED_DATE ? 'repitiendo ' + FIXED_DATE : 'en vivo'}`));

tick(); setInterval(tick, 2000);
