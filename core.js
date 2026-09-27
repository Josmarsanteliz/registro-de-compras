'use strict';

// Lógica pura y helpers (sin dependencias de Electron), para poder probarla con Node.

const CURRENCIES = {
  BTC: { icon: '\u20BF', label: 'BTC', color: '#eb5e28' },
  USDT: { icon: '\u20AE', label: 'USDT', color: '#26a17b' },
  USD: { icon: '$', label: 'USD', color: '#fffcf2' },
  Bs: { icon: '', label: 'Bs', color: '#ccc5b9' },
};

const EXCHANGES = ['Ninguno', 'Binance', 'Bybit', 'OKX', 'Otro'];

// Dirección del movimiento de dinero de cada registro.
// Conversión no es ni ingreso ni egreso: el valor se mueve de una moneda a otra.
const TIPOS = ['Egreso', 'Ingreso', 'Conversión'];

// Monedas en las que se lleva el saldo (el orden fija el de las tarjetas de totales).
const MONEDAS = ['BTC', 'USDT', 'USD', 'Bs'];

function num(v) {
  const n = Number(String(v).replace(',', '.'));
  return isFinite(n) ? n : 0;
}

function val(v) {
  const n = Number(String(v).replace(',', '.'));
  return isFinite(n) && n > 0 ? n : null;
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function findBy(records, id) {
  return records.find((r) => r.id === id);
}

function isConversion(rec) {
  return !!rec && rec.tipo === 'Conversión';
}

// Lado "entregado" de una conversión. Defaults: si el destino es BTC lo natural es venir
// desde USDT, y al revés. El precio unitario se deriva si no viene dado.
function normalizeConvierte(c, destinoMoneda, destinoMonto) {
  c = c || {};
  const moneda = CURRENCIES[c.moneda] ? c.moneda : destinoMoneda === 'BTC' ? 'USDT' : 'BTC';
  const monto = num(c.monto);
  const precio = val(c.precioUnitario);
  return {
    moneda,
    monto,
    precioUnitario: precio || (monto > 0 && destinoMonto > 0 ? monto / destinoMonto : null),
  };
}

// Normaliza un registro viniendo de la UI.
function normalizeRecord(rec) {
  rec = rec || {};
  const tipo = TIPOS.includes(rec.tipo) ? rec.tipo : 'Egreso';
  const monto = num(rec.monto);
  return {
    id: rec.id || null,
    fecha: String(rec.fecha || '').slice(0, 10),
    tipo,
    concepto: String(rec.concepto || '').trim(),
    categoria: String(rec.categoria || '').trim(),
    moneda: CURRENCIES[rec.moneda] ? rec.moneda : 'Bs',
    monto,
    tasaDia: val(rec.tasaDia),
    spot: !!rec.spot,
    precioCompra: val(rec.precioCompra),
    bsInvolucrados: val(rec.bsInvolucrados),
    convierte: normalizeConvierte(rec.convierte, rec.moneda, monto),
    exchange: EXCHANGES.includes(rec.exchange) ? rec.exchange : 'Ninguno',
    notas: String(rec.notas || ''),
    origenId: rec.origenId || null,
    creadoEn: rec.creadoEn || Date.now(),
  };
}

// true si poner "origenId" como origen de "selfId" crearía un ciclo (A->B->A) o se auto-referencia.
function wouldCreateCycle(records, selfId, origenId) {
  if (!origenId) return false;
  if (origenId === selfId) return true;
  const seen = new Set();
  let cur = origenId;
  while (cur) {
    if (cur === selfId || seen.has(cur)) return true;
    seen.add(cur);
    const r = findBy(records, cur);
    if (!r || !r.origenId) break;
    cur = r.origenId;
  }
  return false;
}

function validateRecord(rec, records) {
  if (!rec.concepto) return { ok: false, error: 'El concepto es obligatorio' };
  if (rec.monto <= 0) return { ok: false, error: 'El monto debe ser mayor a 0' };
  if (isConversion(rec)) {
    if (rec.convierte.monto <= 0) return { ok: false, error: 'El monto que entregas debe ser mayor a 0' };
    if (rec.convierte.moneda === rec.moneda) {
      return { ok: false, error: 'Una conversión debe ser entre dos monedas distintas' };
    }
  }
  if (rec.origenId) {
    if (!findBy(records, rec.origenId)) return { ok: false, error: 'El registro origen no existe' };
    if (wouldCreateCycle(records, rec.id, rec.origenId)) {
      return { ok: false, error: 'Esa cadena crearía un ciclo (A\u2192B\u2192A)' };
    }
  }
  return { ok: true };
}

// Valor del registro en Bs. Usa "bsInvolucrados" si está, si no convierte con la tasa.
// Devuelve null si no se puede calcular. Una conversión devuelve 0 a propósito: mueve valor
// entre monedas, no lo gasta, así que no debe alterar el total en Bs en ningún acumulado.
function bsValue(rec, tasaReferencia) {
  if (isConversion(rec)) return 0;
  const t = rec.tasaDia > 0 ? rec.tasaDia : tasaReferencia > 0 ? tasaReferencia : 0;
  if (rec.bsInvolucrados > 0) return rec.bsInvolucrados;
  if (rec.moneda === 'Bs') return rec.monto;
  if (rec.moneda === 'USDT') return t > 0 ? rec.monto * t : null;
  if (rec.moneda === 'BTC') return t > 0 && rec.precioCompra > 0 ? rec.monto * rec.precioCompra * t : null;
  return null;
}

// Cuántas unidades de la moneda entregada vale 1 unidad de la recibida.
// Ej: 1000 USDT -> 0,01234 BTC = 81.037 USDT por BTC.
function precioUnitario(rec) {
  if (!isConversion(rec)) return null;
  const c = rec.convierte || {};
  if (c.precioUnitario > 0) return c.precioUnitario;
  if (c.monto > 0 && num(rec.monto) > 0) return c.monto / num(rec.monto);
  return null;
}

/* ==================== Movimientos y saldos ==================== */
// ESTA ES LA UNICA FUENTE DE VERDAD del efecto de un registro sobre los saldos por moneda.
// La usan los totales de la tabla, las notas del calendario y la pestana Cartera.

function aplicarMovimiento(rec) {
  if (isConversion(rec)) {
    const c = rec.convierte || {};
    return [
      { moneda: c.moneda, signo: -1, monto: num(c.monto) },
      { moneda: rec.moneda, signo: 1, monto: num(rec.monto) },
    ];
  }
  return [{ moneda: rec.moneda, signo: rec.tipo === 'Ingreso' ? 1 : -1, monto: num(rec.monto) }];
}

function saldoVacio() {
  const s = {};
  for (const m of MONEDAS) s[m] = 0;
  return s;
}

// Saldo por exchange derivado de los movimientos. En una conversion el monto entra y sale
// del MISMO exchange, porque un swap ocurre dentro de una sola plataforma. Si moviste USDT
// de OKX a Binance, ese traslado ya esta registrado como Egreso en OKX + Ingreso en Binance.
function holdings(records) {
  const porExchange = {};
  const total = saldoVacio();
  for (const rec of records || []) {
    const ex = EXCHANGES.includes(rec.exchange) ? rec.exchange : 'Ninguno';
    if (!porExchange[ex]) porExchange[ex] = saldoVacio();
    for (const mv of aplicarMovimiento(rec)) {
      if (!(mv.moneda in total)) continue;
      total[mv.moneda] += mv.signo * mv.monto;
      porExchange[ex][mv.moneda] += mv.signo * mv.monto;
    }
  }
  return { porExchange, total };
}

// Ultimo precio de 1 BTC que registro el usuario, y en que moneda esta expresado.
// Se usa solo para estimar el saldo de BTC en Bs: la app no tiene fuente de precios.
function precioBtc(records, manual) {
  if (manual > 0) return { valor: manual, moneda: 'USDT' };
  let best = null;
  const considerar = (valor, moneda, rec) => {
    if (!(valor > 0) || !moneda || moneda === 'BTC') return;
    const cand = { valor, moneda, fecha: rec.fecha || '', creado: rec.creadoEn || 0 };
    if (!best || cand.fecha > best.fecha || (cand.fecha === best.fecha && cand.creado > best.creado)) best = cand;
  };
  for (const rec of records || []) {
    if (isConversion(rec)) {
      const p = precioUnitario(rec);
      if (!p) continue;
      // Si BTC es el destino, p ya es "otra moneda por 1 BTC".
      if (rec.moneda === 'BTC') considerar(p, rec.convierte.moneda, rec);
      // Si BTC es lo entregado, p es "BTC por 1 otra": el precio de 1 BTC es su inverso.
      else if (rec.convierte.moneda === 'BTC') considerar(1 / p, rec.moneda, rec);
    } else if (rec.moneda === 'BTC') {
      considerar(rec.precioCompra, 'USDT', rec);
    }
  }
  return best;
}

// Valor aproximado en Bs de un saldo por moneda. Devuelve null si no se puede calcular
// (falta la tasa, o hay BTC y no hay ningun precio registrado).
function valorBsSaldo(saldos, tasa, precio) {
  if (!(tasa > 0)) return null;
  let total = 0;
  for (const m of MONEDAS) {
    const cantidad = num(saldos[m]);
    if (!cantidad) continue;
    if (m === 'Bs') {
      total += cantidad;
    } else if (m === 'BTC') {
      if (!precio || !(precio.valor > 0)) return null;
      const factor = precio.moneda === 'Bs' ? 1 : tasa;
      total += cantidad * precio.valor * factor;
    } else {
      total += cantidad * tasa;
    }
  }
  return round2(total);
}

/* ============================== Préstamos ============================== */
// Regla fija de la app: interés del 10% y plazo de 14 días (editables al crear).
const LOAN_DEFAULTS = { interesPct: 10, dias: 14 };

// Suma días a una fecha ISO (yyyy-mm-dd) y devuelve ISO. Devuelve '' si es inválida.
function addDaysISO(iso, days) {
  const p = String(iso || '').split('-');
  if (p.length !== 3) return '';
  const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  if (!isFinite(d.getTime())) return '';
  d.setDate(d.getDate() + (Number(days) || 0));
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// Días de diferencia entre dos fechas ISO: positivo si "to" es posterior.
function daysBetween(fromISO, toISO) {
  const a = String(fromISO || '').split('-');
  const b = String(toISO || '').split('-');
  if (a.length !== 3 || b.length !== 3) return 0;
  const da = Date.UTC(Number(a[0]), Number(a[1]) - 1, Number(a[2]));
  const db = Date.UTC(Number(b[0]), Number(b[1]) - 1, Number(b[2]));
  return Math.round((db - da) / 86400000);
}

// Interés y total de un préstamo: siempre el % sobre el monto recibido.
// Ej: 60 USD al 10% -> interés 6 -> total 66.
function calcLoan(monto, interesPct) {
  const m = Math.max(0, num(monto));
  const raw = Number(interesPct);
  const pct = isFinite(raw) && raw >= 0 ? raw : LOAN_DEFAULTS.interesPct;
  const interes = round2((m * pct) / 100);
  return { interes, total: round2(m + interes) };
}

function normalizeLoan(loan) {
  loan = loan || {};
  const fecha = String(loan.fecha || '').slice(0, 10);
  const monto = val(loan.monto) || 0;
  const rawPct = Number(loan.interesPct);
  const interesPct = isFinite(rawPct) && rawPct >= 0 ? rawPct : LOAN_DEFAULTS.interesPct;
  const rawDias = Math.round(Number(loan.dias));
  const dias = isFinite(rawDias) && rawDias > 0 ? rawDias : LOAN_DEFAULTS.dias;
  const { interes, total } = calcLoan(monto, interesPct);
  return {
    id: loan.id || null,
    fecha,
    monto,
    interesPct,
    dias,
    interes,
    total,
    fechaVenc: addDaysISO(fecha, dias),
    tasaBCV: val(loan.tasaBCV),
    contraparte: String(loan.contraparte || '').trim(),
    notas: String(loan.notas || ''),
    pagado: !!loan.pagado,
    pagadoEn: loan.pagado && loan.pagadoEn ? String(loan.pagadoEn).slice(0, 10) : null,
    registroIngresoId: loan.registroIngresoId || null,
    registroPagoId: loan.registroPagoId || null,
    creadoEn: loan.creadoEn || Date.now(),
  };
}

function validateLoan(loan) {
  if (!loan.fecha) return { ok: false, error: 'La fecha del préstamo es obligatoria' };
  if (!(loan.monto > 0)) return { ok: false, error: 'El monto recibido debe ser mayor a 0' };
  if (!(loan.dias > 0)) return { ok: false, error: 'El plazo en días debe ser mayor a 0' };
  if (loan.interesPct < 0) return { ok: false, error: 'El interés no puede ser negativo' };
  return { ok: true };
}

// Valor en Bs del total de un préstamo (usa la tasa BCV guardada o la de referencia).
function loanBs(loan, tasaReferencia) {
  const t = loan.tasaBCV > 0 ? loan.tasaBCV : tasaReferencia > 0 ? tasaReferencia : 0;
  return t > 0 ? round2(loan.total * t) : null;
}

// Estado de un préstamo frente a la fecha de hoy.
// dias: días hasta el vencimiento (negativo = vencido hace N días).
function loanStatus(loan, todayISOStr) {
  if (loan.pagado) return { estado: 'Pagado', dias: daysBetween(loan.fechaVenc, loan.pagadoEn || todayISOStr) };
  const dias = daysBetween(todayISOStr, loan.fechaVenc);
  if (dias < 0) return { estado: 'Vencido', dias };
  if (dias === 0) return { estado: 'Hoy', dias };
  return { estado: 'Pendiente', dias };
}

function buildLoansCsv(loans) {
  const headers = [
    'Fecha',
    'Monto recibido',
    'Inter\u00E9s %',
    'Inter\u00E9s',
    'Total a pagar',
    'Plazo (d\u00EDas)',
    'Vencimiento',
    'Tasa BCV',
    'Estado',
    'Pagado el',
    'A qui\u00E9n / nota',
    'Notas',
  ];
  const today = new Date().toISOString().slice(0, 10);
  const rows = loans.map((l) => {
    const st = loanStatus(l, today);
    return [
      l.fecha,
      l.monto,
      l.interesPct,
      l.interes,
      l.total,
      l.dias,
      l.fechaVenc,
      l.tasaBCV === null ? '' : l.tasaBCV,
      st.estado,
      l.pagadoEn || '',
      l.contraparte,
      l.notas,
    ];
  });
  const esc = (v) => {
    const s = String(v === null || v === undefined ? '' : v);
    return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [headers, ...rows].map((row) => row.map(esc).join(';')).join('\r\n');
}

function buildCsv(records, getConceptoById) {
  const headers = [
    'Fecha',
    'Tipo',
    'Concepto',
    'Categor\u00EDa',
    'Moneda',
    'Monto',
    'Tasa del d\u00EDa',
    'Spot',
    'Precio de compra',
    'Bs involucrados',
    'Moneda entregada',
    'Monto entregado',
    'Precio unitario',
    'Exchange',
    'Origen',
    'Notas',
  ];
  const rows = records.map((r) => [
    r.fecha,
    TIPOS.includes(r.tipo) ? r.tipo : 'Egreso',
    r.concepto,
    r.categoria,
    r.moneda,
    r.monto,
    r.tasaDia === null ? '' : r.tasaDia,
    r.spot ? 'S\u00ED' : 'No',
    r.precioCompra === null ? '' : r.precioCompra,
    r.bsInvolucrados === null ? '' : r.bsInvolucrados,
    isConversion(r) ? r.convierte.moneda : '',
    isConversion(r) && r.convierte.monto ? r.convierte.monto : '',
    isConversion(r) ? precioUnitario(r) || '' : '',
    r.exchange,
    r.origenId ? getConceptoById(r.origenId) || '' : '',
    r.notas,
  ]);
  const esc = (v) => {
    const s = String(v === null || v === undefined ? '' : v);
    return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return '\uFEFF' + [headers, ...rows].map((row) => row.map(esc).join(';')).join('\r\n');
}

function fmtNumber(n, maxDec = 8) {
  if (n === null || n === undefined || !isFinite(n)) return '\u2014';
  return n.toLocaleString('es-VE', { maximumFractionDigits: maxDec });
}

function fmtDate(iso) {
  if (!iso) return '\u2014';
  const parts = String(iso).split('-');
  if (parts.length !== 3) return iso;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

module.exports = {
  CURRENCIES,
  EXCHANGES,
  TIPOS,
  MONEDAS,
  LOAN_DEFAULTS,
  normalizeRecord,
  validateRecord,
  wouldCreateCycle,
  bsValue,
  isConversion,
  precioUnitario,
  aplicarMovimiento,
  saldoVacio,
  holdings,
  precioBtc,
  valorBsSaldo,
  buildCsv,
  normalizeLoan,
  validateLoan,
  calcLoan,
  addDaysISO,
  daysBetween,
  loanBs,
  loanStatus,
  buildLoansCsv,
  fmtNumber,
  fmtDate,
  findBy,
};