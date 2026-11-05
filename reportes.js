// Reportes por rango de fechas en Excel y PDF. Solo lectura: arma los números con los tickets que ya trae el monitor.
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

const MONEDAS = ['BS', 'USD'];
const PISTAS = { RINCONADA: 'La Rinconada', INTL: 'Internacionales', TODO: 'La Rinconada e internacionales' };
const MAX_DIAS = 93;
const blank = () => ({ ventas: 0, premios: 0, tickets: 0, anulado: 0, anulados: 0 });
const par = () => ({ BS: blank(), USD: blank() });
function acc(o, t) {
  if (t.status === 'cancel') { o.anulado += t.income; o.anulados++; return; }
  o.ventas += t.income; o.premios += t.egress || 0; o.tickets++;
}
// solo las monedas que tuvieron movimiento en el rango (los internacionales son solo en dólares)
const monedasUsadas = R => { const u = MONEDAS.filter(c => R.tot[c].tickets || R.tot[c].anulados); return u.length ? u : MONEDAS; };
const gan = o => o.ventas - o.premios;
const margen = o => o.ventas ? gan(o) / o.ventas : 0;

function fechas(desde, hasta) {
  const r = []; for (let d = new Date(desde + 'T12:00Z'); d <= new Date(hasta + 'T12:00Z'); d.setUTCDate(d.getUTCDate() + 1)) r.push(d.toISOString().slice(0, 10));
  return r;
}
function validar({ desde, hasta, pista }, hoy) {
  const ok = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  if (!ok(desde) || !ok(hasta)) throw new Error('Fechas inválidas');
  if (desde > hasta) throw new Error('La fecha inicial es posterior a la final');
  if (hasta > hoy) throw new Error('La fecha final no puede ser futura');
  if (!PISTAS[pista]) throw new Error('Elige La Rinconada, internacionales o ambas');
  if (fechas(desde, hasta).length > MAX_DIAS) throw new Error(`El rango máximo es de ${MAX_DIAS} días`);
}

// ctx: { dia(fecha) -> Promise<X>, esNacional(X, bris), moneda(uid), sector(uid), nombre(uid, email) }
// Cada día se resume en filas "N|hipódromo|taquilla" (N nacional, I internacional) con sus sumas.
// Los días cerrados (de anteayer para atrás) se guardan en disco: un mes sale en segundos la segunda vez.
const DIR_CACHE = path.join(__dirname, 'reportes-cache');
async function resumenDia(f, ctx) {
  const archivo = path.join(DIR_CACHE, f + '.json');
  try { return JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch {}
  const X = await ctx.dia(f), filas = {}, emails = {};
  for (const t of X.tickets.values()) {
    const nac = ctx.esNacional(X, t.racecourse), hip = X.hipodromos[t.racecourse]?.nombre || t.racecourse;
    acc(filas[`${nac ? 'N' : 'I'}|${hip}|${t.uid}`] ||= blank(), t); emails[t.uid] = t.email;
  }
  const r = { fecha: f, filas, emails };
  if (f <= ctx.cerradoHasta) { try { fs.mkdirSync(DIR_CACHE, { recursive: true }); fs.writeFileSync(archivo, JSON.stringify(r)); } catch {} }
  return r;
}
async function armar(params, ctx) {
  const R = { ...params, nombrePista: PISTAS[params.pista], tot: par(), dias: [], hipodromos: {}, sectores: {}, taquillas: {}, errores: [] };
  const lista = fechas(params.desde, params.hasta);
  // de a 6 días a la vez para no cargar demasiado a ondrv
  for (let i = 0; i < lista.length; i += 6) {
    const lote = await Promise.all(lista.slice(i, i + 6).map(f => resumenDia(f, ctx).then(x => [f, x], e => [f, null, e])));
    for (const [f, x, e] of lote) {
      if (!x) { R.errores.push(`${f}: ${e.message}`); continue; }
      const D = { fecha: f, ...par() };
      for (const [k, o] of Object.entries(x.filas)) {
        const [n, hip, uid] = k.split('|'), nac = n === 'N';
        if (params.pista === 'RINCONADA' ? !nac : params.pista === 'INTL' ? nac : false) continue;
        const cur = ctx.moneda(uid), sec = ctx.sector(uid);
        for (const dst of [R.tot[cur], D[cur], (R.hipodromos[hip] ||= { nombre: hip, nacional: nac, ...par() })[cur], (R.sectores[sec] ||= { nombre: sec, ...par() })[cur],
          R.taquillas[uid] ||= { nombre: ctx.nombre(uid, x.emails[uid]), sector: sec, moneda: cur, ...blank() }]) for (const c in o) dst[c] += o[c];
      }
      if (MONEDAS.some(c => D[c].tickets || D[c].anulados)) R.dias.push(D);
    }
  }
  R.dias.sort((a, b) => a.fecha.localeCompare(b.fecha));
  const peso = x => x.BS.ventas / 1000 + x.USD.ventas; // solo para ordenar
  R.hipodromos = Object.values(R.hipodromos).sort((a, b) => b.nacional - a.nacional || peso(b) - peso(a));
  R.sectores = Object.values(R.sectores).sort((a, b) => peso(b) - peso(a));
  R.taquillas = Object.values(R.taquillas).sort((a, b) => a.moneda.localeCompare(b.moneda) || b.ventas - a.ventas);
  return R;
}

const fechaTxt = f => { const [y, m, d] = f.split('-'); return `${d}/${m}/${y}`; };
const rangoTxt = R => R.desde === R.hasta ? fechaTxt(R.desde) : `${fechaTxt(R.desde)} al ${fechaTxt(R.hasta)}`;
const nombreArchivo = (R, ext) => `reporte-kinghorse-${R.pista.toLowerCase()}-${R.desde}${R.desde === R.hasta ? '' : '_' + R.hasta}.${ext}`;

// ---------- Excel ----------
const NAVY = 'FF13244A', GOLD = 'FFA47B26', GRIS = 'FFEEF1F6';
async function excel(R) {
  const wb = new ExcelJS.Workbook(); wb.creator = 'Monitor King Horse'; wb.created = new Date();
  const fmtN = '#,##0;[Red]-#,##0', fmtP = '0.0%;[Red]-0.0%';
  function hoja(nombre, titulo, cols, filas) {
    const ws = wb.addWorksheet(nombre, { views: [{ state: 'frozen', ySplit: 4 }] });
    ws.columns = cols.map(c => ({ key: c.k, width: c.w || 14 }));
    ws.mergeCells(1, 1, 1, cols.length); ws.getCell(1, 1).value = titulo;
    ws.getCell(1, 1).font = { bold: true, size: 14, color: { argb: NAVY } };
    ws.mergeCells(2, 1, 2, cols.length); ws.getCell(2, 1).value = `${R.nombrePista} · ${rangoTxt(R)}`;
    ws.getCell(2, 1).font = { color: { argb: GOLD } };
    const h = ws.getRow(4); cols.forEach((c, i) => { const x = h.getCell(i + 1); x.value = c.t; x.font = { bold: true, color: { argb: 'FFFFFFFF' } }; x.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; x.alignment = { horizontal: i ? 'right' : 'left', wrapText: true }; });
    h.height = 30;
    filas.forEach((f, j) => { const row = ws.getRow(5 + j); cols.forEach((c, i) => { const x = row.getCell(i + 1); x.value = f[c.k]; if (c.f) x.numFmt = c.f; if (f._total) { x.font = { bold: true }; x.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRIS } }; } }); });
    return ws;
  }
  const cMon = (pref = '') => monedasUsadas(R).flatMap(c => [
    { k: pref + c + 'v', t: `Ventas ${c}`, f: fmtN, w: 15 }, { k: pref + c + 'p', t: `Premios ${c}`, f: fmtN, w: 15 },
    { k: pref + c + 'g', t: `Ganancia ${c}`, f: fmtN, w: 15 }, { k: pref + c + 'm', t: `Margen ${c}`, f: fmtP, w: 10 },
    { k: pref + c + 't', t: `Tickets ${c}`, f: fmtN, w: 10 }, { k: pref + c + 'a', t: `Anulado ${c}`, f: fmtN, w: 13 }]);
  const r2 = v => Math.round(v * 100) / 100;
  const vMon = x => Object.assign({}, ...monedasUsadas(R).map(c => ({ [c + 'v']: r2(x[c].ventas), [c + 'p']: r2(x[c].premios), [c + 'g']: r2(gan(x[c])), [c + 'm']: margen(x[c]), [c + 't']: x[c].tickets, [c + 'a']: r2(x[c].anulado) })));
  const total = { _total: true, ...vMon(R.tot) };

  hoja('Resumen', 'Reporte de ventas King Horse', [{ k: 'n', t: 'Moneda', w: 18 }, { k: 'v', t: 'Ventas', f: fmtN, w: 16 }, { k: 'p', t: 'Premios', f: fmtN, w: 16 }, { k: 'g', t: 'Ganancia', f: fmtN, w: 16 }, { k: 'm', t: 'Margen', f: fmtP, w: 10 }, { k: 't', t: 'Tickets', f: fmtN, w: 10 }, { k: 'a', t: 'Anulado', f: fmtN, w: 14 }, { k: 'an', t: 'Tickets anulados', f: fmtN, w: 12 }],
    monedasUsadas(R).map(c => ({ n: c === 'BS' ? 'Bolívares' : 'Dólares', v: r2(R.tot[c].ventas), p: r2(R.tot[c].premios), g: r2(gan(R.tot[c])), m: margen(R.tot[c]), t: R.tot[c].tickets, a: R.tot[c].anulado, an: R.tot[c].anulados })));
  hoja('Por día', 'Ventas por día', [{ k: 'f', t: 'Fecha', w: 12 }, ...cMon()], [...R.dias.map(d => ({ f: fechaTxt(d.fecha), ...vMon(d) })), { f: 'Total', ...total }]);
  if (R.pista !== 'RINCONADA') hoja('Por hipódromo', 'Ventas por hipódromo', [{ k: 'n', t: 'Hipódromo', w: 24 }, ...cMon()], [...R.hipodromos.map(h => ({ n: h.nombre, ...vMon(h) })), { n: 'Total', ...total }]);
  hoja('Por sector', 'Ventas por sector', [{ k: 'n', t: 'Sector', w: 16 }, ...cMon()], [...R.sectores.map(s => ({ n: s.nombre, ...vMon(s) })), { n: 'Total', ...total }]);
  hoja('Por taquilla', 'Ventas por taquilla', [{ k: 'n', t: 'Taquilla', w: 24 }, { k: 's', t: 'Sector', w: 14 }, { k: 'c', t: 'Moneda', w: 9 }, { k: 'v', t: 'Ventas', f: fmtN, w: 15 }, { k: 'p', t: 'Premios', f: fmtN, w: 15 }, { k: 'g', t: 'Ganancia', f: fmtN, w: 15 }, { k: 'm', t: 'Margen', f: fmtP, w: 10 }, { k: 't', t: 'Tickets', f: fmtN, w: 10 }, { k: 'a', t: 'Anulado', f: fmtN, w: 13 }],
    R.taquillas.map(t => ({ n: t.nombre, s: t.sector, c: t.moneda, v: r2(t.ventas), p: r2(t.premios), g: r2(gan(t)), m: margen(t), t: t.tickets, a: r2(t.anulado) })));
  if (R.errores.length) hoja('Avisos', 'Días que no se pudieron leer de ondrv', [{ k: 'e', t: 'Detalle', w: 80 }], R.errores.map(e => ({ e })));
  return wb.xlsx.writeBuffer();
}

// ---------- PDF ----------
function pdf(R) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, bufferPages: true, info: { Title: `Reporte King Horse ${rangoTxt(R)}`, Author: 'Monitor King Horse' } });
    const out = []; doc.on('data', b => out.push(b)); doc.on('end', () => resolve(Buffer.concat(out))); doc.on('error', reject);
    const W = doc.page.width - 72, L = 36, n = v => Math.round(v || 0).toLocaleString('es-VE'), p = v => (v * 100).toFixed(1).replace('.', ',') + ' %';
    const navy = '#13244A', gold = '#A47B26', gris = '#EEF1F6', rojo = '#C2362B', muted = '#5B6478';
    // encabezado
    doc.rect(0, 0, doc.page.width, 70).fill(navy);
    try { doc.image(path.join(__dirname, 'public', 'logo.png'), L, 8, { height: 54 }); } catch {}
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(18).text('Reporte de ventas', L + 64, 16);
    doc.font('Helvetica').fontSize(11).fillColor('#E8D9B5').text(`${R.nombrePista} · ${rangoTxt(R)}`, L + 64, 40);
    doc.fontSize(8).fillColor('#C9D1E0').text(`Generado ${new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' })}`, L, 44, { width: W, align: 'right' });
    doc.y = 88;

    function titulo(t) { if (doc.y > doc.page.height - 120) doc.addPage(); doc.moveDown(0.6); doc.font('Helvetica-Bold').fontSize(12).fillColor(navy).text(t, L, doc.y); doc.moveDown(0.3); }
    // cols: [{t, w (fracción), a: 'left'|'right'}], filas: arrays de [texto, color?]
    function tabla(cols, filas, { totalUltima = false } = {}) {
      const ws = cols.map(c => c.w * W), rh = 15;
      const head = () => { let x = L; doc.rect(L, doc.y, W, rh + 2).fill(navy); const y = doc.y + 4; doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#fff'); cols.forEach((c, i) => { doc.text(c.t, x + 3, y, { width: ws[i] - 6, align: c.a || 'right', lineBreak: false }); x += ws[i]; }); doc.y = y - 4 + rh + 2; };
      head();
      filas.forEach((f, j) => {
        if (doc.y > doc.page.height - 50) { doc.addPage(); doc.y = 36; head(); }
        const tot = totalUltima && j === filas.length - 1, y = doc.y;
        if (tot) doc.rect(L, y, W, rh).fill(gris); else if (j % 2) doc.rect(L, y, W, rh).fill('#F7F8FB');
        let x = L; doc.font(tot ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5);
        cols.forEach((c, i) => { const [v, col] = Array.isArray(f[i]) ? f[i] : [f[i]]; doc.fillColor(col || '#1B2333').text(String(v), x + 3, y + 4, { width: ws[i] - 6, align: c.a || 'right', lineBreak: false }); x += ws[i]; });
        doc.y = y + rh;
      });
    }
    const g = (v) => [n(v), v < 0 ? rojo : undefined];
    const k = 2 / monedasUsadas(R).length; // con una sola moneda las columnas se ensanchan
    const colsMon = monedasUsadas(R).flatMap(c => [{ t: `Ventas ${c}`, w: .09 * k }, { t: `Ganancia ${c}`, w: .09 * k }, { t: `Margen ${c}`, w: .065 * k }, { t: `Tickets ${c}`, w: .065 * k }]);
    const sumW = colsMon.reduce((a, c) => a + c.w, 0), conEtiq = t => [{ t, w: .16, a: 'left' }, ...colsMon.map(c => ({ ...c, w: c.w / sumW * .84 }))];
    const vMon = x => monedasUsadas(R).flatMap(c => [n(x[c].ventas), g(gan(x[c])), p(margen(x[c])), n(x[c].tickets)]);

    // tarjetas de totales
    const usadas = monedasUsadas(R), cw = (W - 12) / 2, y0 = doc.y;
    usadas.forEach((c, i) => {
      const x = L + i * (cw + 12), y = y0, t = R.tot[c];
      doc.roundedRect(x, y, cw, 74, 8).lineWidth(1).strokeColor('#D9DFEA').stroke();
      doc.font('Helvetica-Bold').fontSize(9).fillColor(c === 'BS' ? '#8A6A1F' : '#2F5FB0').text(c === 'BS' ? 'BOLÍVARES' : 'DÓLARES', x + 12, y + 10);
      doc.fontSize(20).fillColor(navy).text(n(t.ventas), x + 12, y + 24);
      doc.font('Helvetica').fontSize(8.5).fillColor(muted).text(`vendido · ${n(t.tickets)} tickets · premios ${n(t.premios)}${t.anulados ? ` · anulado ${n(t.anulado)} (${t.anulados})` : ''}`, x + 12, y + 50, { width: cw - 24 });
      doc.font('Helvetica-Bold').fontSize(12).fillColor(gan(t) < 0 ? rojo : '#1E7A4F').text(`${gan(t) > 0 ? '+' : ''}${n(gan(t))}  (${p(margen(t))})`, x + 12, y + 10, { width: cw - 24, align: 'right' });
    });
    doc.y = y0 + 84;

    if (R.dias.length > 1) { titulo('Por día'); tabla(conEtiq('Fecha'), [...R.dias.map(d => [fechaTxt(d.fecha), ...vMon(d)]), ['Total', ...vMon(R.tot)]], { totalUltima: true }); }
    if (R.pista !== 'RINCONADA' && R.hipodromos.length) { titulo('Por hipódromo'); tabla(conEtiq('Hipódromo'), [...R.hipodromos.map(h => [h.nombre, ...vMon(h)]), ['Total', ...vMon(R.tot)]], { totalUltima: true }); }
    titulo('Por sector'); tabla(conEtiq('Sector'), [...R.sectores.map(s => [s.nombre, ...vMon(s)]), ['Total', ...vMon(R.tot)]], { totalUltima: true });
    titulo('Por taquilla');
    tabla([{ t: 'Taquilla', w: .2, a: 'left' }, { t: 'Sector', w: .13, a: 'left' }, { t: 'Moneda', w: .07, a: 'left' }, { t: 'Ventas', w: .12 }, { t: 'Premios', w: .12 }, { t: 'Ganancia', w: .12 }, { t: 'Margen', w: .08 }, { t: 'Tickets', w: .08 }, { t: 'Anulado', w: .08 }],
      R.taquillas.map(t => [t.nombre, t.sector, t.moneda, n(t.ventas), n(t.premios), g(gan(t)), p(margen(t)), n(t.tickets), n(t.anulado)]));
    if (R.errores.length) { titulo('Días que no se pudieron leer'); doc.font('Helvetica').fontSize(8).fillColor(rojo).text(R.errores.join('\n'), L, doc.y, { width: W }); }
    if (!R.dias.length) { doc.moveDown(); doc.font('Helvetica').fontSize(11).fillColor(muted).text('No hubo ventas en este rango.', L, doc.y); }
    // pie con número de página
    const r = doc.bufferedPageRange();
    for (let i = r.start; i < r.start + r.count; i++) { doc.switchToPage(i); doc.page.margins.bottom = 0; doc.font('Helvetica').fontSize(7).fillColor(muted).text(`King Horse · ${rangoTxt(R)} · página ${i + 1} de ${r.count}`, L, doc.page.height - 24, { width: W, align: 'right', lineBreak: false }); }
    doc.end();
  });
}

module.exports = { validar, armar, resumenDia, fechas, excel, pdf, nombreArchivo, PISTAS, MAX_DIAS };
