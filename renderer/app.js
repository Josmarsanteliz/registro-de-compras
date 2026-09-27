'use strict';

/* ============================== Estado ============================== */
const state = {
  records: [],
  loans: [],
  settings: { tasaReferencia: 0, tasaFuente: 'BCV', tasaUltimaConsulta: 0, tasaUltimoError: null },
  tasa: null,
  tasaHistorial: [],
  mercado: null,
  mercadoHistorial: [],
  mercadoError: null,
  filtroMercado: 'todas',
  tasaInvertida: false,
  activeTab: 'Todo',
  filters: { q: '', categoria: '', exchange: '', desde: '', hasta: '' },
  editingId: null,
  detailId: null,
  editingLoanId: null,
  detailLoanId: null,
  cal: { year: new Date().getFullYear(), month: new Date().getMonth(), selDate: null },
};

const C = {
  BTC: { icon: '\u20BF', label: 'BTC', cls: 'btc' },
  USDT: { icon: '\u20AE', label: 'USDT', cls: 'usdt' },
  USD: { icon: '$', label: 'USD', cls: 'usd' },
  Bs: { icon: '', label: 'Bs', cls: 'bs' },
};

const EXCHANGES = ['Ninguno', 'Binance', 'Bybit', 'OKX', 'Otro'];
const CAT_DEFAULT = ['crypto', 'comida', 'servicios', 'tecnología', 'transporte', 'salud', 'préstamo', 'conversión', 'otros'];
const MONEY_TABS = ['BTC', 'USDT', 'USD', 'Bs'];
const LOAN_DEFAULTS = { interesPct: 10, dias: 14 };

/* ============================== Helpers ============================== */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function num(v) {
  const n = Number(String(v).replace(',', '.'));
  return isFinite(n) ? n : 0;
}

function val(v) {
  const n = Number(String(v).replace(',', '.'));
  return isFinite(n) && n > 0 ? n : null;
}

function fmtNum(n, maxDec = 8) {
  if (n === null || n === undefined || !isFinite(n)) return '\u2014';
  return n.toLocaleString('es-VE', { maximumFractionDigits: maxDec });
}

function fmtDate(iso) {
  if (!iso) return '\u2014';
  const p = String(iso).split('-');
  if (p.length !== 3) return iso;
  return `${p[2]}/${p[1]}/${p[0]}`;
}

function todayISO() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// === Espejo de core.js: mantener en sync o los totales se descuadran (ver AGENTS.md) ===

function isConversion(rec) {
  return !!rec && rec.tipo === 'Conversión';
}

// Cuántas unidades de la moneda entregada vale 1 unidad de la recibida.
function precioUnitario(rec) {
  if (!isConversion(rec)) return null;
  const c = rec.convierte || {};
  if (c.precioUnitario > 0) return c.precioUnitario;
  if (c.monto > 0 && num(rec.monto) > 0) return c.monto / num(rec.monto);
  return null;
}

// ÚNICA fuente de verdad del efecto de un registro sobre los saldos (espejo de core.js).
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
  for (const m of MONEY_TABS) s[m] = 0;
  return s;
}

function holdings(records) {
  const porExchange = {};
  const total = saldoVacio();
  for (const rec of records) {
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

// Último precio de 1 BTC registrado por el usuario, y en qué moneda está expresado.
function precioBtc(records, manual) {
  if (manual > 0) return { valor: manual, moneda: 'USDT' };
  let best = null;
  const considerar = (valor, moneda, rec) => {
    if (!(valor > 0) || !moneda || moneda === 'BTC') return;
    const cand = { valor, moneda, fecha: rec.fecha || '', creado: rec.creadoEn || 0 };
    if (!best || cand.fecha > best.fecha || (cand.fecha === best.fecha && cand.creado > best.creado)) best = cand;
  };
  for (const rec of records) {
    if (isConversion(rec)) {
      const p = precioUnitario(rec);
      if (!p) continue;
      if (rec.moneda === 'BTC') considerar(p, rec.convierte.moneda, rec);
      else if (rec.convierte.moneda === 'BTC') considerar(1 / p, rec.moneda, rec);
    } else if (rec.moneda === 'BTC') {
      considerar(rec.precioCompra, 'USDT', rec);
    }
  }
  return best;
}

function valorBsSaldo(saldos, tasa, precio) {
  if (!(tasa > 0)) return null;
  let total = 0;
  for (const m of MONEY_TABS) {
    const cantidad = num(saldos[m]);
    if (!cantidad) continue;
    if (m === 'Bs') {
      total += cantidad;
    } else if (m === 'BTC') {
      if (!precio || !(precio.valor > 0)) return null;
      total += cantidad * precio.valor * (precio.moneda === 'Bs' ? 1 : tasa);
    } else {
      total += cantidad * tasa;
    }
  }
  return round2(total);
}

// Suma días a una fecha ISO (yyyy-mm-dd).
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

// Días de diferencia entre dos fechas ISO (positivo si "to" es posterior).
function daysBetween(fromISO, toISO) {
  const a = String(fromISO || '').split('-');
  const b = String(toISO || '').split('-');
  if (a.length !== 3 || b.length !== 3) return 0;
  const da = Date.UTC(Number(a[0]), Number(a[1]) - 1, Number(a[2]));
  const db = Date.UTC(Number(b[0]), Number(b[1]) - 1, Number(b[2]));
  return Math.round((db - da) / 86400000);
}

function findLoan(id) {
  return state.loans.find((l) => l.id === id) || null;
}

// Interés y total: mismo cálculo que core.js (ej: 60 al 10% -> 6 -> 66).
function calcLoanValues(monto, interesPct) {
  const m = Math.max(0, num(monto));
  const pct = isFinite(interesPct) && interesPct >= 0 ? interesPct : LOAN_DEFAULTS.interesPct;
  const interes = round2((m * pct) / 100);
  return { interes, total: round2(m + interes) };
}

// Valor en Bs del total de un préstamo (tasa BCV propia o la de referencia).
function loanBs(loan) {
  const t = loan.tasaBCV > 0 ? loan.tasaBCV : state.settings.tasaReferencia > 0 ? state.settings.tasaReferencia : 0;
  return t > 0 ? round2(loan.total * t) : null;
}

function loanStatus(loan) {
  const today = todayISO();
  if (loan.pagado) return { estado: 'Pagado', dias: daysBetween(loan.fechaVenc, loan.pagadoEn || today) };
  const dias = daysBetween(today, loan.fechaVenc);
  if (dias < 0) return { estado: 'Vencido', dias };
  if (dias === 0) return { estado: 'Hoy', dias };
  return { estado: 'Pendiente', dias };
}

// Texto del estado para la tabla / calendario.
function loanStatusText(loan) {
  const st = loanStatus(loan);
  if (loan.pagado) return `Pagado el ${fmtDate(loan.pagadoEn)}`;
  if (st.estado === 'Vencido') return `Vencido hace ${Math.abs(st.dias)} día(s)`;
  if (st.estado === 'Hoy') return 'Vence hoy';
  return `Vence en ${st.dias} día(s)`;
}

function byId(id) {
  return state.records.find((r) => r.id === id);
}

function findChildren(id) {
  return state.records.filter((r) => r.origenId === id);
}

function getChain(id) {
  const chain = [];
  const seen = new Set();
  let cur = id;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const r = byId(cur);
    if (!r) break;
    chain.unshift(r);
    cur = r.origenId;
  }
  return chain;
}

function canSetOrigen(candidateId, selfId) {
  if (!candidateId) return true;
  if (candidateId === selfId) return false;
  const seen = new Set();
  let cur = candidateId;
  while (cur) {
    if (cur === selfId || seen.has(cur)) return false;
    seen.add(cur);
    const r = byId(cur);
    if (!r || !r.origenId) break;
    cur = r.origenId;
  }
  return true;
}

function bsValue(rec) {
  // Una conversión mueve valor entre monedas: 0 a propósito, para no alterar ningún total.
  if (isConversion(rec)) return 0;
  const t = rec.tasaDia > 0 ? rec.tasaDia : state.settings.tasaReferencia > 0 ? state.settings.tasaReferencia : 0;
  if (rec.bsInvolucrados > 0) return rec.bsInvolucrados;
  if (rec.moneda === 'Bs') return rec.monto;
  if (rec.moneda === 'USDT') return t > 0 ? rec.monto * t : null;
  if (rec.moneda === 'BTC') return t > 0 && rec.precioCompra > 0 ? rec.monto * rec.precioCompra * t : null;
  return null;
}

// Tasa vigente: la del registro si tiene, si no la de referencia (que el BCV mantiene al día).
function tasaDe(fecha) {
  if (state.tasaHistorial && fecha) {
    const exacta = state.tasaHistorial.find((t) => t.fecha === fecha);
    if (exacta) return exacta.valor;
    const previas = state.tasaHistorial.filter((t) => t.fecha < fecha).sort((a, b) => (a.fecha < b.fecha ? 1 : -1));
    if (previas.length) return previas[0].valor;
  }
  if (state.tasa && state.tasa.valor > 0) return state.tasa.valor;
  return state.settings.tasaReferencia > 0 ? state.settings.tasaReferencia : 0;
}

function toast(msg, kind = 'ok') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast ${kind}`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 2800);
}

function showError(el, msg, autoHide = true) {
  el.textContent = msg;
  el.classList.remove('hidden');
  if (autoHide) setTimeout(() => el.classList.add('hidden'), 4000);
}

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ============================== Filtrado ============================== */
function filteredRecords() {
  const f = state.filters;
  const q = f.q.trim().toLowerCase();
  return state.records
    .filter((r) => state.activeTab === 'Todo' || r.moneda === state.activeTab)
    .filter((r) => !q || `${r.concepto} ${r.notas} ${r.categoria} ${r.exchange}`.toLowerCase().includes(q))
    .filter((r) => !f.categoria || r.categoria === f.categoria)
    .filter((r) => !f.exchange || r.exchange === f.exchange)
    .filter((r) => !f.desde || r.fecha >= f.desde)
    .filter((r) => !f.hasta || r.fecha <= f.hasta)
    .sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '') || b.creadoEn - a.creadoEn);
}

/* ============================== Render ============================== */
function renderTabs() {
  const tabs = $('#tabs');
  const count = (m) => {
    if (m === 'Todo' || m === 'Calendario') return state.records.length;
    if (m === 'Préstamos') return state.loans.length;
    if (m === 'Cartera') return Object.keys(holdings(state.records).porExchange).length;
    if (m === 'Tasas') {
      const d = state.mercado;
      return d ? d.disponible || 0 : 0;
    }
    return state.records.filter((r) => r.moneda === m).length;
  };
  const defs = [
    ['Todo', '', 'Todo'],
    ['BTC', C.BTC.icon, 'BTC'],
    ['USDT', C.USDT.icon, 'USDT'],
    ['USD', C.USD.icon, 'USD'],
    ['Bs', C.Bs.icon, 'Bs'],
    ['Tasas', '\u{1F4B1}', 'Tasas'],
    ['Cartera', '\u{1F4BC}', 'Cartera'],
    ['Préstamos', '\u{1F3E6}', 'Préstamos'],
    ['Calendario', '\u{1F5D3}\uFE0F', 'Calendario'],
  ];
  tabs.innerHTML = defs
    .map(([id, icon, label]) => {
      const active = state.activeTab === id ? ' active' : '';
      return `<button class="tab${active}" data-tab="${id}">${icon} ${label}<span class="count">(${count(id)})</span></button>`;
    })
    .join('');
}

function renderTotals() {
  const list = filteredRecords();
  const totals = { BTC: 0, USDT: 0, USD: 0, Bs: 0 };
  const cnt = { BTC: { ing: 0, egr: 0 }, USDT: { ing: 0, egr: 0 }, USD: { ing: 0, egr: 0 }, Bs: { ing: 0, egr: 0 } };
  let bsSum = 0;
  let withBs = 0;
  let convs = 0;
  for (const r of list) {
    // Los saldos por moneda salen de aplicarMovimiento (una conversión mueve dos a la vez).
    for (const mv of aplicarMovimiento(r)) {
      if (!(mv.moneda in totals)) continue;
      totals[mv.moneda] += mv.signo * mv.monto;
    }
    if (isConversion(r)) {
      convs++;
      continue; // mueve valor, no aporta al total en Bs
    }
    const sgn = r.tipo === 'Ingreso' ? 1 : -1;
    cnt[r.moneda][r.tipo === 'Ingreso' ? 'ing' : 'egr']++;
    const b = bsValue(r);
    if (b !== null) {
      bsSum += sgn * b;
      withBs++;
    }
  }
  const hasRef = state.settings.tasaReferencia > 0;
  const fmtNet = (n) => (n > 0 ? '+' : '') + fmtNum(n);

  const cards = [];
  const push = (cls, lbl, val, sub) => cards.push(`<div class="total-card ${cls}"><div class="lbl">${lbl}</div><div class="val">${val}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`);

  if (state.activeTab === 'Todo') {
    for (const m of MONEY_TABS) {
      push(m.toLowerCase(), `Neto ${C[m].label}`, `${C[m].icon || C[m].label} ${fmtNet(totals[m])}`, `${fmtNum(list.filter((r) => r.moneda === m).length)} registro(s) · ${cnt[m].ing} ing · ${cnt[m].egr} egr`);
    }
  } else {
    const m = state.activeTab;
    push(m.toLowerCase(), `Neto ${C[m].label}`, `${C[m].icon || C[m].label} ${fmtNet(totals[m])}`, `${fmtNum(list.length)} registro(s) · ${cnt[m].ing} ing · ${cnt[m].egr} egr`);
  }

  const missing = list.length - withBs - convs;
  const partes = [];
  if (missing > 0) partes.push(`${fmtNum(missing)} sin tasa${hasRef ? '' : ' (define una tasa de referencia en el menú)'}`);
  if (convs > 0) partes.push(`${fmtNum(convs)} conversión(es) no afectan este total`);
  if (!partes.length && hasRef) partes.push(`usando tasa de referencia (${fmtNum(state.settings.tasaReferencia)})`);
  const sub = partes.join(' · ');
  push('tot', '\u2248 Neto en Bs', `Bs. ${fmtNet(bsSum)}`, sub);

  $('#totals').innerHTML = cards.join('');
}

function buildCategoriaOptions() {
  const cats = new Set(CAT_DEFAULT);
  for (const r of state.records) if (r.categoria) cats.add(r.categoria);
  $('#cat-list').innerHTML = Array.from(cats)
    .map((c) => `<option value="${esc(c)}">`)
    .join('');
  const sel = $('#f-categoria');
  const cur = sel.value;
  sel.innerHTML = '<option value="">Todas las categorías</option>' + Array.from(cats)
    .sort((a, b) => a.localeCompare(b, 'es'))
    .map((c) => `<option value="${esc(c)}">${esc(c)}</option>`)
    .join('');
  sel.value = cur;
}

function buildExchangeOptions() {
  const sel = $('#f-exchange');
  const cur = sel.value;
  sel.innerHTML = '<option value="">Todos los exchange</option>' + EXCHANGES.map((e) => `<option value="${esc(e)}">${esc(e)}</option>`).join('');
  sel.value = cur;
}

// Celda de monto: en una conversión muestra "entregado → recibido" en vez de una cifra sola.
function celdaMonto(r) {
  if (isConversion(r)) {
    const c = r.convierte || {};
    const p = precioUnitario(r);
    return `<span class="conv-monto">
      <span class="out">− ${fmtNum(c.monto)} ${esc(c.moneda)}</span>
      <span class="arrow">→</span>
      <span class="in">+ ${fmtNum(r.monto)} ${esc(r.moneda)}</span>
    </span>${p ? `<div class="sub">@ ${fmtNum(p)} ${esc(c.moneda)}/${esc(r.moneda)}</div>` : ''}`;
  }
  return fmtNum(r.monto);
}

function renderTable() {
  const list = filteredRecords();
  const showMoneda = state.activeTab === 'Todo';
  const head = ['Fecha', 'Concepto', 'Categoría', ...(showMoneda ? ['Moneda'] : []), 'Monto', 'Tasa', 'Exchange', 'Origen', 'Acciones'];
  $('#thead').innerHTML = `<tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>`;

  if (!list.length) {
    $('#tbody').innerHTML = '';
    $('#empty').classList.remove('hidden');
    $('#empty').textContent = state.activeTab === 'Todo'
      ? 'Aún no hay registros. Pulsa "+ Nuevo registro" para empezar.'
      : `No hay registros en ${C[state.activeTab].label}. Pulsa "+ Nuevo registro".`;
    return;
  }
  $('#empty').classList.add('hidden');

  $('#tbody').innerHTML = list
    .map((r) => {
      const origen = byId(r.origenId);
      const children = findChildren(r.id).length;
      const moneda = C[r.moneda];
      let origenCell = '<span class="muted">—</span>';
      if (origen && children) {
        origenCell = `<span class="chain-badge" title="${esc(origen.concepto)} (${fmtDate(origen.fecha)})">\u2190 ${C[origen.moneda].icon} ${esc(origen.concepto).slice(0, 22)}</span> <span class="chain-badge" title="Tiene ${children} registro(s) que nacen de él">\u2198 ${children}</span>`;
      } else if (origen) {
        origenCell = `<span class="chain-badge" title="${esc(origen.concepto)} (${fmtDate(origen.fecha)})">\u2190 ${C[origen.moneda].icon} ${esc(origen.concepto).slice(0, 22)}</span>`;
      } else if (children) {
        origenCell = `<span class="chain-badge" title="Tiene ${children} registro(s) que nacen de él">\u2198 ${children}</span>`;
      }

      const conv = isConversion(r);
      const tipoCls = conv ? 'conv' : r.tipo === 'Ingreso' ? 'ing' : 'egr';
      return `<tr data-id="${r.id}" class="${conv ? 'is-conv' : ''}">
        <td>${fmtDate(r.fecha)}</td>
        <td><span class="dot-tipo ${tipoCls}" title="${conv ? 'Conversión' : r.tipo}"></span><b>${esc(r.concepto)}</b>${conv ? ' <span class="cat-pill conv">↔ swap</span>' : ''}${r.spot ? ' <span class="cat-pill">spot</span>' : ''}</td>
        <td>${r.categoria ? `<span class="cat-pill">${esc(r.categoria)}</span>` : '<span class="muted">—</span>'}</td>
        ${showMoneda ? `<td><span class="moneda-badge ${moneda.cls}">${moneda.icon ? moneda.icon + ' ' : ''}${moneda.label}</span></td>` : ''}
        <td>${celdaMonto(r)}</td>
        <td class="muted">${r.tasaDia !== null ? fmtNum(r.tasaDia) : '—'}</td>
        <td>${r.exchange !== 'Ninguno' ? esc(r.exchange) : '<span class="muted">—</span>'}</td>
        <td>${origenCell}</td>
        <td><span class="acc">
          <button data-act="view" title="Ver detalle">👁</button>
          <button data-act="edit" title="Editar">✏️</button>
          <button data-act="del" class="del" title="Eliminar">🗑</button>
        </span></td>
      </tr>`;
    })
    .join('');
}

function render() {
  renderTabs();
  applyView();
  $('#btn-new').textContent = state.activeTab === 'Préstamos' ? '+ Nuevo préstamo' : '+ Nuevo registro';
  if (state.activeTab === 'Calendario') {
    renderCalendar();
    return;
  }
  if (state.activeTab === 'Préstamos') {
    renderLoans();
    return;
  }
  if (state.activeTab === 'Cartera') {
    renderCartera();
    return;
  }
  if (state.activeTab === 'Tasas') {
    renderMercado();
    return;
  }
  renderTotals();
  renderTable();
}

/* ============================== Tasas de mercado ============================== */
// Espejo de mercado.js: diferenciaPct y convertir. Si cambias uno, cambia el otro.

const ETIQUETAS_TASA = [
  { key: 'bcv', nombre: 'BCV (oficial)', moneda: 'USD' },
  { key: 'paralelo', nombre: 'Dólar paralelo', moneda: 'USD' },
  { key: 'euroOficial', nombre: 'Euro oficial', moneda: 'EUR' },
  { key: 'euroParalelo', nombre: 'Euro paralelo', moneda: 'EUR' },
];

function diferenciaPct(valor, referencia) {
  if (!(valor > 0) || !(referencia > 0)) return null;
  return Math.round(((valor - referencia) / referencia) * 1000) / 10;
}

function convertir(monto, tasa) {
  if (monto === null || monto === undefined || monto === '') return null;
  const m = Number(monto);
  if (!isFinite(m) || !(tasa > 0)) return null;
  return Math.round(m * tasa * 100) / 100;
}

// Cuántas horas tiene el dato, para no presentarlo como si fuera de hoy.
function antiguedadHoras(fecha) {
  if (!fecha) return null;
  const d = new Date(fecha.length <= 10 ? fecha + 'T00:00:00' : fecha);
  if (isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 3600000);
}

function tarjetaTasa(def, referencia) {
  const t = state.mercado ? state.mercado[def.key] : null;
  if (!t || !(t.valor > 0)) {
    return `<div class="mercado-card vacia">
      <div class="mc-nombre">${esc(def.nombre)}</div>
      <div class="mc-valor muted">—</div>
      <div class="mc-meta">No se pudo consultar</div>
    </div>`;
  }
  const horas = antiguedadHoras(t.fecha);
  const viejo = horas !== null && horas >= 24;
  const dif = def.key === 'bcv' ? null : diferenciaPct(t.valor, referencia);
  const difTxt = dif === null ? '' :
    `<span class="mc-dif ${dif >= 0 ? 'sube' : 'baja'}">${dif >= 0 ? '+' : ''}${fmtNum(dif)}% vs BCV</span>`;
  return `<div class="mercado-card ${viejo ? 'viejo' : ''}" data-usar-tasa="${def.key}" title="Usar esta tasa en el convertidor">
    <div class="mc-nombre">${esc(def.nombre)}</div>
    <div class="mc-valor">Bs. <b>${fmtNum(t.valor)}</b></div>
    <div class="mc-meta">
      <span>por 1 ${def.moneda}</span> · <span>${esc(t.fuente)}</span>
      ${t.fecha ? ` · <span title="${esc(t.fecha)}">${fmtDate(t.fecha)}</span>` : ''}
    </div>
    ${viejo ? `<div class="mc-aviso">⏳ Tiene ${horas >= 48 ? Math.floor(horas / 24) + ' días' : horas + ' h'} sin actualizarse</div>` : ''}
    ${difTxt}
    <div class="mc-usar">usar en el convertidor</div>
  </div>`;
}

// La tasa elegida en el convertidor, ya resuelta a su tarjeta.
function tasaElegida() {
  const d = state.mercado;
  const key = $('#cv-tasa').value;
  const def = ETIQUETAS_TASA.find((x) => x.key === key);
  if (!def || !d || !d[key] || !(d[key].valor > 0)) return null;
  return { def, tasa: d[key] };
}

function renderMercado() {
  const d = state.mercado;
  const ref = d && d.bcv ? d.bcv.valor : 0;

  const errBox = $('#mercado-error');
  if (state.mercadoError) {
    errBox.textContent = 'Algunas tasas no se pudieron consultar: ' + state.mercadoError;
    errBox.classList.remove('hidden');
  } else {
    errBox.classList.add('hidden');
  }

  // El filtro solo oculta tarjetas: no cambia la tasa del convertidor.
  const visibles = ETIQUETAS_TASA.filter((x) => state.filtroMercado === 'todas' || x.moneda === state.filtroMercado);
  if (!d) {
    $('#mercado-actual').innerHTML = '<div class="cal-empty">Todavía no hay tasas consultadas. Tocá "Actualizar ahora".</div>';
  } else if (!visibles.length) {
    $('#mercado-actual').innerHTML = '<div class="cal-empty">No hay tasas de esa moneda.</div>';
  } else {
    $('#mercado-actual').innerHTML = visibles.map((x) => tarjetaTasa(x, ref)).join('');
  }

  // Selector del convertidor
  const sel = $('#cv-tasa');
  const previa = sel.value;
  sel.innerHTML = ETIQUETAS_TASA
    .filter((x) => d && d[x.key] && d[x.key].valor > 0)
    .map((x) => `<option value="${x.key}">${esc(x.nombre)} — Bs. ${fmtNum(d[x.key].valor)}</option>`)
    .join('') || '<option value="">Sin tasas disponibles</option>';
  sel.value = ETIQUETAS_TASA.some((x) => x.key === previa) ? previa : sel.value;

  for (const b of $$('#mercado-filtro .chip-btn')) {
    b.classList.toggle('active', b.dataset.filtro === state.filtroMercado);
  }

  renderMercadoHistorial();
  actualizarConversion();
}

function renderMercadoHistorial() {
  const hist = state.mercadoHistorial || [];
  const el = $('#mercado-historial');
  if (!hist.length) {
    el.innerHTML = '<div class="muted">Sin historial todavía. Se guarda una fila por día.</div>';
    return;
  }
  const cols = [
    ['bcv', 'BCV'],
    ['paralelo', 'Paralelo'],
    ['euroOficial', 'Euro oficial'],
    ['euroParalelo', 'Euro paralelo'],
  ];
  el.innerHTML = '<table class="tasa-tbl"><thead><tr><th>Fecha</th>'
    + cols.map((c) => `<th>${c[1]}</th>`).join('')
    + '</tr></thead><tbody>'
    + hist.map((h) => '<tr><td>' + fmtDate(h.fecha) + '</td>'
      + cols.map((c) => '<td>' + (h[c[0]] > 0 ? fmtNum(h[c[0]]) : '<span class="muted">—</span>') + '</td>').join('')
      + '</tr>').join('')
    + '</tbody></table>';
}

function actualizarConversion() {
  const out = $('#cv-resultado');
  const unidad = $('#cv-unidad');
  const prefijo = $('#cv-prefijo');
  const boton = $('#cv-cambiar');
  const detalle = $('#cv-detalle');
  const elegida = tasaElegida();
  const monto = num($('#cv-monto').value);

  // El botón dice siempre qué va a pasar al apretarlo, y las unidades acompañan la dirección.
  boton.textContent = state.tasaInvertida ? '⇅ Bs → divisa' : '⇅ divisa → Bs';
  boton.title = state.tasaInvertida
    ? 'Ahora converts Bs a la divisa. Clic para volver a convertir divisa a Bs.'
    : 'Ahora converts la divisa a Bs. Clic para convertir Bs a la divisa.';

  if (!elegida) {
    unidad.textContent = '—';
    prefijo.textContent = '';
    out.textContent = '—';
    detalle.textContent = 'No hay ninguna tasa consultada todavía.';
    return;
  }

  const { def, tasa } = elegida;
  unidad.textContent = state.tasaInvertida ? 'Bs' : def.moneda;
  prefijo.textContent = state.tasaInvertida ? '' : 'Bs.';
  detalle.innerHTML = `1 ${def.moneda} = Bs. ${fmtNum(tasa.valor)} · ${esc(tasa.fuente)}${tasa.fecha ? ' · ' + fmtDate(tasa.fecha) : ''}`;

  if (!(monto > 0)) {
    out.textContent = '—';
    return;
  }
  out.textContent = state.tasaInvertida
    ? fmtNum(convertir(monto, 1 / tasa.valor)) + ' ' + def.moneda
    : fmtNum(convertir(monto, tasa.valor));
}

function cambiarDireccion() {
  state.tasaInvertida = !state.tasaInvertida;
  actualizarConversion();
}

async function cargarMercado() {
  const res = await window.api.getMercado();
  if (!res.ok) return;
  state.mercado = res.mercado;
  state.mercadoHistorial = res.historial || [];
  if (state.activeTab === 'Tasas') render();
}

async function refrescarMercado() {
  const btn = $('#mercado-refresh');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const res = await window.api.refreshMercado();
    state.mercado = res.mercado;
    state.mercadoHistorial = res.historial || [];
    state.mercadoError = res.ok ? null : res.error;
    render();
    if (res.ok) {
      toast('Tasas actualizadas');
    } else {
      toast('No se pudieron actualizar las tasas', 'err');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/* ============================== Cartera ============================== */
// Saldo por exchange, derivado de los movimientos. En una conversión el monto entra y sale
// del mismo exchange. Lo que no está en una plataforma (efectivo en divisas, Bs del banco)
// cae en "Ninguno".

const ORDEN_EXCHANGES = ['Binance', 'Bybit', 'OKX', 'Otro', 'Ninguno'];

function etiquetaExchange(ex) {
  return ex === 'Ninguno' ? 'Efectivo / bancos' : ex;
}

function filaSaldo(m, valor) {
  const vacio = !valor;
  return `<div class="saldo-fila" data-saldo="${m}">
    <span class="saldo-mono"><span class="c ${C[m].cls}">${C[m].icon || C[m].label}</span> ${C[m].label}</span>
    <span class="saldo-val ${vacio ? 'muted' : C[m].cls}">${vacio ? '—' : fmtNum(valor)}</span>
  </div>`;
}

function renderCartera() {
  const h = holdings(state.records);
  const tasa = state.settings.tasaReferencia > 0 ? state.settings.tasaReferencia : tasaDe(todayISO());
  const precio = precioBtc(state.records, 0);
  const orden = ORDEN_EXCHANGES.filter((e) => h.porExchange[e]);
  const extra = Object.keys(h.porExchange).filter((e) => !ORDEN_EXCHANGES.includes(e));
  const lista = [...orden, ...extra];

  // Tarjetas de totales
  const cards = [];
  const push = (cls, lbl, val, sub) => cards.push(`<div class="total-card ${cls}"><div class="lbl">${lbl}</div><div class="val">${val}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`);
  for (const m of MONEY_TABS) {
    push(m.toLowerCase(), `Total ${C[m].label}`, `${C[m].icon || C[m].label} ${fmtNum(h.total[m])}`, `${lista.filter((e) => h.porExchange[e][m]).length} lugar(es)`);
  }
  const bsTotal = valorBsSaldo(h.total, tasa, precio);
  push('tot', '≈ Valor total', bsTotal !== null ? `Bs. ${fmtNum(bsTotal)}` : '—', bsTotal === null
    ? (tasa > 0 ? 'falta un precio de BTC para valuedar' : 'consulta la tasa del BCV')
    : `tasa ${fmtNum(tasa)}${precio ? ` · BTC a ${fmtNum(precio.valor)} ${precio.moneda}` : ''}`);
  $('#cartera-totals').innerHTML = cards.join('');

  // Una tarjeta por exchange
  if (!lista.length) {
    $('#cartera-grid').innerHTML = '<div class="cal-empty">Aún no hay nada registrado. Cuando apuntes tu primer movimiento aparecerá aquí desglosado por exchange.</div>';
    $('#cartera-nota').textContent = '';
    return;
  }

  $('#cartera-grid').innerHTML = lista
    .map((ex) => {
      const saldos = h.porExchange[ex];
      const bs = valorBsSaldo(saldos, tasa, precio);
      return `<div class="cartera-card" data-exchange="${esc(ex)}">
        <div class="cartera-head">
          <b>${esc(etiquetaExchange(ex))}</b>
          <button class="btn small ghost" data-ver-exchange="${esc(ex)}">Ver movimientos</button>
        </div>
        ${MONEY_TABS.map((m) => filaSaldo(m, saldos[m])).join('')}
        <div class="cartera-bs">${bs !== null ? `≈ Bs. ${fmtNum(bs)}` : '<span class="muted">≈ Bs. —</span>'}</div>
      </div>`;
    })
    .join('');

  const sinPrecio = precio ? '' : ' El saldo en BTC no se valúa porque aún no has registrado ningún precio de compra.';
  const sinTasa = tasa > 0 ? '' : ' Falta la tasa del BCV: los valores en Bs no se pueden calcular.';
  $('#cartera-nota').textContent =
    'Los saldos salen de tus registros: una conversión descuenta lo entregado y suma lo recibido dentro del mismo exchange. '
    + 'El ≈ Bs de cada tarjeta usa la tasa del BCV' + (precio ? ' y tu último precio de BTC' : '') + '.' + sinPrecio + sinTasa;
}

function verExchange(ex) {
  state.activeTab = 'Todo';
  state.filters.exchange = ex;
  $('#f-exchange').value = ex;
  render();
  toast(`Movimientos de ${etiquetaExchange(ex)}`);
}

/* ============================== Calendario ============================== */
function applyView() {
  const isCal = state.activeTab === 'Calendario';
  const isLoans = state.activeTab === 'Préstamos';
  const isCartera = state.activeTab === 'Cartera';
  const isTasas = state.activeTab === 'Tasas';
  const isMain = !isCal && !isLoans && !isCartera && !isTasas;
  $('#totals').classList.toggle('hidden', !isMain);
  document.querySelector('.filters').classList.toggle('hidden', !isMain);
  $('#table-wrap').classList.toggle('hidden', !isMain);
  $('#view-calendar').classList.toggle('hidden', !isCal);
  $('#view-loans').classList.toggle('hidden', !isLoans);
  $('#view-cartera').classList.toggle('hidden', !isCartera);
  $('#view-tasas').classList.toggle('hidden', !isTasas);
  $('#btn-new').classList.toggle('hidden', isCartera || isTasas);
  if (!isCal) $('#cal-jump').classList.add('hidden');
}

function calMonthPrefix() {
  const { year, month } = state.cal;
  return `${year}-${String(month + 1).padStart(2, '0')}-`;
}

function monthRecords() {
  const prefix = calMonthPrefix();
  return state.records
    .filter((r) => r.fecha && r.fecha.startsWith(prefix))
    .sort((a, b) => a.fecha.localeCompare(b.fecha) || a.creadoEn - b.creadoEn);
}

// Préstamos que vencen en el mes mostrado.
function monthLoans() {
  const prefix = calMonthPrefix();
  return state.loans
    .filter((l) => l.fechaVenc && l.fechaVenc.startsWith(prefix))
    .sort((a, b) => a.fechaVenc.localeCompare(b.fechaVenc) || a.creadoEn - b.creadoEn);
}

function calNoteLine(r) {
  const m = C[r.moneda];
  const isConv = isConversion(r);
  const isIng = !isConv && r.tipo === 'Ingreso';
  const sign = isIng ? '+' : '\u2212';
  const extra = [];
  if (r.categoria) extra.push(esc(r.categoria));
  if (r.exchange !== 'Ninguno') extra.push(esc(r.exchange));
  if (isConv) {
    const c = r.convierte || {};
    const p = precioUnitario(r);
    return `<li class="note conv"><span class="dot conv"></span><b>Conversi\u00F3n</b> \u00B7 ${fmtNum(c.monto)} ${esc(c.moneda)} \u2192 ${fmtNum(r.monto)} ${m.label} \u00B7 ${esc(r.concepto)}${extra.length ? ` \u00B7 ${extra.join(' \u00B7 ')}` : ''}${p ? ` <span class="muted">(@ ${fmtNum(p)})</span>` : ''}</li>`;
  }
  const b = bsValue(r);
  const bTxt = b !== null ? ` <span class="muted">(\u2248 Bs ${sign}${fmtNum(b)})</span>` : '';
  return `<li class="note ${isIng ? 'ing' : 'egr'}"><span class="dot ${isIng ? 'ing' : 'egr'}"></span><b>${isIng ? 'Ingreso' : 'Egreso'}</b> \u00B7 ${m.icon} ${fmtNum(r.monto)} ${m.label} \u00B7 ${esc(r.concepto)}${extra.length ? ` \u00B7 ${extra.join(' \u00B7 ')}` : ''}${bTxt}</li>`;
}

// Línea de préstamo dentro de la lista del día (vencimiento).
function loanNoteLine(l) {
  const bs = loanBs(l);
  const bsTxt = bs !== null ? ` <span class="muted">(\u2248 Bs ${fmtNum(bs)})</span>` : '';
  const clase = loanBadgeClass(l);
  const estado = l.pagado ? `Pagado el ${fmtDate(l.pagadoEn)}` : loanStatusText(l);
  return `<li class="note loan ${clase}"><span class="dot loan ${clase}"></span><b>Pr\u00E9stamo</b> \u00B7 $ ${fmtNum(l.monto)} \u2192 <b>$ ${fmtNum(l.total)}</b> (${fmtNum(l.interesPct)}%) \u00B7 ${estado}${l.contraparte ? ` \u00B7 ${esc(l.contraparte)}` : ''}${bsTxt}</li>`;
}

function renderCalNotes(recs, loans) {
  if (loans === undefined) loans = monthLoans();
  const el = $('#cal-notes');
  if (!recs.length && !loans.length) {
    el.innerHTML = '<div class="cal-empty">Sin movimientos en este mes.</div>';
    return;
  }
  const groups = {};
  const group = (day) => (groups[day] = groups[day] || { recs: [], loans: [] });
  for (const r of recs) group(r.fecha).recs.push(r);
  for (const l of loans) group(l.fechaVenc).loans.push(l);

  const days = Object.keys(groups).sort();
  el.innerHTML = days
    .map((day) => {
      const dayRecs = groups[day].recs;
      const dayLoans = groups[day].loans;
      let net = 0;
      let anyNet = false;
      for (const r of dayRecs) {
        const b = bsValue(r);
        if (b !== null) {
          net += (r.tipo === 'Ingreso' ? 1 : -1) * b;
          anyNet = true;
        }
      }
      const netTxt = anyNet
        ? `<span class="net ${net >= 0 ? 'pos' : 'neg'}">${net >= 0 ? '+' : ''}${fmtNum(net)} Bs</span>`
        : '';
      const sel = state.cal.selDate === day ? ' sel' : '';
      const lines = dayRecs.map(calNoteLine).concat(dayLoans.map(loanNoteLine)).join('');
      return `<div class="cal-day${sel}" data-day="${day}">
        <div class="cal-day-head"><span class="when">${fmtDate(day)}</span>${netTxt}</div>
        <ul class="cal-day-list">${lines}</ul>
      </div>`;
    })
    .join('');
}

function renderCalendar() {
  const { year, month } = state.cal;
  const title = new Date(year, month, 1).toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
  $('#cal-title').textContent = title.charAt(0).toUpperCase() + title.slice(1);

  const byDay = new Map();
  for (const r of state.records) {
    if (!r.fecha) continue;
    const day = r.fecha.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(r);
  }

  // Vencimientos de préstamos por día.
  const loanByDay = new Map();
  for (const l of state.loans) {
    if (!l.fechaVenc) continue;
    if (!loanByDay.has(l.fechaVenc)) loanByDay.set(l.fechaVenc, []);
    loanByDay.get(l.fechaVenc).push(l);
  }

  const first = new Date(year, month, 1);
  const startDow = (first.getDay() + 6) % 7; // semana lunes-primero
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = todayISO();
  const prefix = calMonthPrefix();

  const wd = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
  let cells = wd.map((d) => `<div class="cal-wd">${d}</div>`).join('');
  for (let i = 0; i < startDow; i++) cells += '<div class="cal-cell empty"></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${prefix}${String(d).padStart(2, '0')}`;
    const list = byDay.get(iso) || [];
    const loans = loanByDay.get(iso) || [];
    const pendLoans = loans.filter((l) => !l.pagado);
    const convs = list.filter((r) => isConversion(r)).length;
    const ing = list.filter((r) => !isConversion(r) && r.tipo === 'Ingreso').length;
    const egr = list.length - ing - convs;
    const cls = ['cal-cell'];
    if (list.length || loans.length) cls.push('has');
    if (iso === today) cls.push('today');
    if (pendLoans.some((l) => loanStatus(l).estado === 'Vencido')) cls.push('overdue');
    let markers = '';
    if (list.length || loans.length) {
      markers =
        '<div class="cal-markers">' +
        (ing ? `<span class="m ing" title="${ing} ingreso(s)">+${ing}</span>` : '') +
        (egr ? `<span class="m egr" title="${egr} egreso(s)">\u2212${egr}</span>` : '') +
        (convs ? `<span class="m conv" title="${convs} conversi\u00F3n(es)">\u2194 ${convs}</span>` : '') +
        (loans.length
          ? `<span class="m loan${pendLoans.length ? '' : ' paid'}" title="${loans.length} vencimiento(s) de pr\u00E9stamo">\u{1F3E6} ${loans.length}</span>`
          : '') +
        '</div>';
    }
    cells += `<div class="${cls.join(' ')}" data-date="${iso}"><span class="d">${d}</span>${markers}</div>`;
  }
  $('#cal-grid').innerHTML = cells;

  renderCalNotes(monthRecords(), monthLoans());
}

function calGo(delta) {
  const d = new Date(state.cal.year, state.cal.month + delta, 1);
  state.cal.year = d.getFullYear();
  state.cal.month = d.getMonth();
  state.cal.selDate = null;
  $('#cal-jump').classList.add('hidden');
  renderCalendar();
}

function calGoToday() {
  const now = new Date();
  state.cal.year = now.getFullYear();
  state.cal.month = now.getMonth();
  state.cal.selDate = null;
  $('#cal-jump').classList.add('hidden');
  renderCalendar();
}

function calSelect(iso) {
  state.cal.selDate = iso;
  renderCalNotes(monthRecords(), monthLoans());
  const j = $('#cal-jump');
  j.classList.remove('hidden');
  j.dataset.date = iso;
}

function calJumpToList() {
  const d = $('#cal-jump').dataset.date;
  if (!d) return;
  state.activeTab = 'Todo';
  state.filters.desde = d;
  state.filters.hasta = d;
  $('#f-desde').value = d;
  $('#f-hasta').value = d;
  render();
  toast(`Registros del ${fmtDate(d)}`);
}

/* ============================== Préstamos ============================== */
function sortedLoans() {
  return [...state.loans].sort((a, b) => {
    const pa = a.pagado ? 1 : 0;
    const pb = b.pagado ? 1 : 0;
    if (pa !== pb) return pa - pb;
    if (!a.pagado && !b.pagado) return (a.fechaVenc || '').localeCompare(b.fechaVenc || '');
    return (b.fecha || '').localeCompare(a.fecha || '');
  });
}

function loanBadgeClass(loan) {
  if (loan.pagado) return 'ok';
  const st = loanStatus(loan);
  if (st.estado === 'Vencido') return 'danger';
  if (st.estado === 'Hoy') return 'due';
  return 'wait';
}

function renderLoanTotals() {
  const loans = state.loans;
  const pend = loans.filter((l) => !l.pagado);
  const sum = (arr, f) => round2(arr.reduce((a, l) => a + f(l), 0));
  const tasa = state.settings.tasaReferencia;
  const bs = (usd) => (tasa > 0 ? `\u2248 Bs ${fmtNum(round2(usd * tasa))}` : 'define la tasa BCV en el men\u00FA');

  const cards = [];
  const push = (cls, lbl, val, sub) => cards.push(`<div class="total-card ${cls}"><div class="lbl">${lbl}</div><div class="val">${val}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`);

  push('tot', 'Deuda pendiente', `$ ${fmtNum(sum(pend, (l) => l.total))}`, `${bs(sum(pend, (l) => l.total))} \u00B7 ${pend.length} pr\u00E9stamo(s)`);
  push('usd', 'Total prestado', `$ ${fmtNum(sum(loans, (l) => l.monto))}`, `${loans.length} pr\u00E9stamo(s) en total`);
  push('loan-int', 'Inter\u00E9s pendiente', `$ ${fmtNum(sum(pend, (l) => l.interes))}`, `sobre $ ${fmtNum(sum(pend, (l) => l.monto))} recibidos`);

  const next = pend.slice().sort((a, b) => (a.fechaVenc || '').localeCompare(b.fechaVenc || ''))[0];
  if (next) {
    const st = loanStatus(next);
    push('loan-next', 'Pr\u00F3ximo vencimiento', fmtDate(next.fechaVenc), `$ ${fmtNum(next.total)} \u00B7 ${loanStatusText(next)}`);
  } else {
    push('loan-next', 'Pr\u00F3ximo vencimiento', loans.length ? '\u2705 Al d\u00EDa' : '\u2014', loans.length ? 'No hay deudas pendientes' : 'A\u00FAn no hay pr\u00E9stamos');
  }

  $('#loan-totals').innerHTML = cards.join('');
}

function renderLoans() {
  renderLoanTotals();
  const head = ['Fecha', 'Recibido', 'Inter\u00E9s', 'Total a pagar', 'Vencimiento', '\u2248 Bs', 'Estado', 'Acciones'];
  $('#loan-thead').innerHTML = `<tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>`;

  const list = sortedLoans();
  if (!list.length) {
    $('#loan-tbody').innerHTML = '';
    $('#loan-empty').classList.remove('hidden');
    $('#loan-empty').textContent = 'A\u00FAn no hay pr\u00E9stamos. Pulsa "+ Nuevo préstamo" para registrar uno (ej: 60$ al 10% en 14 d\u00EDas).';
    return;
  }
  $('#loan-empty').classList.add('hidden');

  $('#loan-tbody').innerHTML = list
    .map((l) => {
      const bs = loanBs(l);
      const badge = loanBadgeClass(l);
      const clase = !l.pagado && loanStatus(l).estado === 'Vencido' ? ' class="overdue"' : '';
      const acts = `<span class="acc">
          <button data-lact="view" title="Ver detalle">👁</button>
          ${l.pagado
            ? '<button data-lact="undo" title="Deshacer pago">\u21B6</button>'
            : '<button data-lact="pay" title="Marcar como pagado">\u{1F4B8}</button>'}
          <button data-lact="edit" title="Editar">✏️</button>
          <button data-lact="del" class="del" title="Eliminar">🗑</button>
        </span>`;
      return `<tr data-loan-id="${l.id}"${clase}>
        <td>${fmtDate(l.fecha)}</td>
        <td>$ ${fmtNum(l.monto)}</td>
        <td class="muted">$ ${fmtNum(l.interes)} <span class="cat-pill">${fmtNum(l.interesPct)}%</span></td>
        <td><b>$ ${fmtNum(l.total)}</b></td>
        <td>${fmtDate(l.fechaVenc)}<div class="sub">${l.dias} d\u00EDas</div></td>
        <td class="muted">${bs !== null ? `Bs ${fmtNum(bs)}` : '—'}</td>
        <td><span class="loan-badge ${badge}">${l.pagado ? '\u2705' : badge === 'danger' ? '\u26A0' : '\u23F3'} ${loanStatusText(l)}</span></td>
        <td>${acts}</td>
      </tr>`;
    })
    .join('');
}

function openLoanForm(id) {
  state.editingLoanId = id || null;
  const isEdit = !!state.editingLoanId;
  const l = isEdit ? findLoan(state.editingLoanId) : null;
  if (isEdit && !l) return;

  $('#loan-title').textContent = isEdit ? 'Editar pr\u00E9stamo' : 'Nuevo pr\u00E9stamo';
  $('#l-monto').value = l ? l.monto : '';
  $('#l-fecha').value = l ? l.fecha : todayISO();
  $('#l-dias').value = l ? l.dias : LOAN_DEFAULTS.dias;
  $('#l-interes').value = l ? l.interesPct : LOAN_DEFAULTS.interesPct;
  $('#l-tasa').value = l && l.tasaBCV > 0 ? l.tasaBCV : (state.settings.tasaReferencia > 0 ? state.settings.tasaReferencia : '');
  $('#l-contraparte').value = l ? l.contraparte : '';
  $('#l-notas').value = l ? l.notas : '';
  $('#l-gen').checked = l ? !!l.registroIngresoId : true;
  // Una vez pagado no se puede soltar el vínculo (ya existe el registro de pago encadenado).
  $('#l-gen').disabled = !!(l && l.registroPagoId);

  $('#loan-error').classList.add('hidden');
  updateLoanCalc();
  $('#modal-loan').classList.remove('hidden');
  $('#l-monto').focus();
}

function closeLoanForm() {
  $('#modal-loan').classList.add('hidden');
  state.editingLoanId = null;
}

function loanFormData() {
  const monto = num($('#l-monto').value);
  const pctRaw = $('#l-interes').value.trim();
  const interesPct = pctRaw === '' ? LOAN_DEFAULTS.interesPct : num(pctRaw);
  const diasRaw = $('#l-dias').value.trim();
  const dias = diasRaw === '' ? LOAN_DEFAULTS.dias : Math.round(num(diasRaw));
  const fecha = $('#l-fecha').value || todayISO();
  const tasa = val($('#l-tasa').value);
  const { interes, total } = calcLoanValues(monto, interesPct);
  return {
    loan: { fecha, monto, interesPct, dias, tasaBCV: tasa, contraparte: $('#l-contraparte').value.trim(), notas: $('#l-notas').value.trim() },
    opts: { crearRegistro: $('#l-gen').checked },
    interes,
    total,
    fechaVenc: addDaysISO(fecha, dias),
    tasa,
  };
}

// Caja de cálculo en vivo: 60$ + 6$ (10%) = 66$ a pagar el <fecha>.
function updateLoanCalc() {
  const d = loanFormData();
  const bs = d.tasa > 0 ? `\u2248 Bs ${fmtNum(round2(d.total * d.tasa))}` : '';
  const bsMonto = d.tasa > 0 ? `\u2248 Bs ${fmtNum(round2(d.loan.monto * d.tasa))}` : '';
  $('#loan-calc').innerHTML = `
    <span class="calc-chip in">$ ${fmtNum(d.loan.monto)} recibidos ${bsMonto ? `<i>${bsMonto}</i>` : ''}</span>
    <span class="calc-arrow">+</span>
    <span class="calc-chip int">$ ${fmtNum(d.interes)} de inter\u00E9s <i>${fmtNum(d.loan.interesPct)}%</i></span>
    <span class="calc-arrow">=</span>
    <span class="calc-chip total">$ ${fmtNum(d.total)} a pagar</span>
    <span class="calc-when">\u{1F4C5} Vence <b>${fmtDate(d.fechaVenc)}</b> (${fmtNum(d.loan.dias)} d\u00EDas) ${bs ? `<i>${bs}</i>` : ''}</span>`;
}

async function saveLoan() {
  const d = loanFormData();
  if (d.loan.monto <= 0) return showError($('#loan-error'), 'El monto recibido debe ser mayor a 0');
  if (d.loan.dias <= 0) return showError($('#loan-error'), 'El plazo en días debe ser mayor a 0');

  const op = state.editingLoanId
    ? window.api.updateLoan({ id: state.editingLoanId, loan: d.loan, opts: d.opts })
    : window.api.addLoan({ loan: d.loan, opts: d.opts });

  const res = await op;
  if (!res.ok) return showError($('#loan-error'), res.error);
  const wasEdit = !!state.editingLoanId;
  await reloadAll();
  closeLoanForm();
  render();
  toast(wasEdit ? 'Préstamo actualizado' : `Préstamo guardado: $ ${fmtNum(d.total)} a pagar el ${fmtDate(d.fechaVenc)}`);
}

function openLoanDetail(id) {
  const l = findLoan(id);
  if (!l) return;
  state.detailLoanId = id;
  const st = loanStatus(l);
  const bs = loanBs(l);
  const ingreso = l.registroIngresoId ? byId(l.registroIngresoId) : null;
  const pago = l.registroPagoId ? byId(l.registroPagoId) : null;

  const items = [
    ['Fecha del pr\u00E9stamo', fmtDate(l.fecha)],
    ['Recibido', `$ ${fmtNum(l.monto)}`],
    ['Inter\u00E9s', `$ ${fmtNum(l.interes)} (${fmtNum(l.interesPct)}%)`],
    ['Total a pagar', `$ ${fmtNum(l.total)}`],
    ['Plazo', `${fmtNum(l.dias)} d\u00EDas`],
    ['Vencimiento', fmtDate(l.fechaVenc)],
    ['\u2248 Valor en Bs', bs !== null ? `Bs. ${fmtNum(bs)}` : 'Sin tasa BCV'],
    ['Tasa BCV', l.tasaBCV > 0 ? fmtNum(l.tasaBCV) : 'Usa la de referencia'],
    ['Estado', `${l.pagado ? '\u2705' : st.estado === 'Vencido' ? '\u26A0' : '\u23F3'} ${loanStatusText(l)}`],
    ['Pagado el', l.pagadoEn ? fmtDate(l.pagadoEn) : '—'],
    ['A qui\u00E9n / referencia', l.contraparte ? esc(l.contraparte) : '—'],
  ];

  const vinculos = [];
  if (ingreso) vinculos.push(`\u{1F7E2} Ingreso: ${fmtDate(ingreso.fecha)} \u00B7 ${fmtNum(ingreso.monto)} USD`);
  if (pago) vinculos.push(`\u{1F534} Pago: ${fmtDate(pago.fecha)} \u00B7 ${fmtNum(pago.monto)} USD`);
  if (!vinculos.length) vinculos.push('<span class="muted">Sin registro vinculado</span>');

  $('#loan-detail-body').innerHTML = `
    <div class="detail-grid">
      ${items.map(([lbl, v]) => `<div class="detail-item"><div class="lbl">${lbl}</div><div class="val">${v}</div></div>`).join('')}
      <div class="detail-item full"><div class="lbl">Registros vinculados</div><div class="val">${vinculos.join('<br>')}</div></div>
      ${l.notas ? `<div class="detail-item full"><div class="lbl">Notas</div><div class="val">${esc(l.notas)}</div></div>` : ''}
    </div>`;

  const payBtn = $('#loan-detail-pay');
  payBtn.textContent = l.pagado ? '\u21B6 Deshacer pago' : '\u{1F4B8} Marcar como pagado';
  payBtn.classList.toggle('primary', !l.pagado);

  $('#modal-loan-detail').classList.remove('hidden');
}

function closeLoanDetail() {
  $('#modal-loan-detail').classList.add('hidden');
  state.detailLoanId = null;
}

async function toggleLoanPay(id) {
  const l = findLoan(id);
  if (!l) return;

  if (!l.pagado) {
    const ok = confirm(
      `\u00BFMarcar como pagado hoy (${fmtDate(todayISO())})?\n\nSe crear\u00E1 un registro de Egreso de $ ${fmtNum(l.total)} USD encadenado al ingreso.`
    );
    if (!ok) return;
    const res = await window.api.payLoan(id);
    if (!res.ok) return toast(res.error || 'Error', 'err');
    toast(`Préstamo pagado: $ ${fmtNum(l.total)}`);
  } else {
    const ok = confirm('\u00BFDeshacer el pago?\n\nSe eliminar\u00E1 el registro de pago que se gener\u00F3.');
    if (!ok) return;
    const res = await window.api.unpayLoan(id);
    if (!res.ok) return toast(res.error || 'Error', 'err');
    toast('Pago deshecho');
  }
  await reloadAll();
  if (!$('#modal-loan-detail').classList.contains('hidden')) openLoanDetail(id);
  render();
}

async function deleteLoan(id) {
  const l = findLoan(id);
  if (!l) return;
  const vinculos = [l.registroIngresoId, l.registroPagoId].filter(Boolean).length;
  const extra = vinculos ? `\n\n\u26A0\uFE0F Tambi\u00E9n se eliminar\u00E1n ${vinculos} registro(s) vinculado(s).` : '';
  if (!confirm(`\u00BFEliminar el pr\u00E9stamo de $ ${fmtNum(l.monto)} (${fmtDate(l.fecha)})?${extra}`)) return;
  const res = await window.api.deleteLoan(id);
  if (!res.ok) return toast(res.error || 'Error', 'err');
  closeLoanDetail();
  await reloadAll();
  render();
  toast('Préstamo eliminado');
}

/* ============================== Entrar a la app ============================== */
async function reloadAll() {
  const [rec, loans] = await Promise.all([window.api.getRecords(), window.api.getLoans()]);
  if (rec.ok) state.records = rec.records;
  if (loans.ok) state.loans = loans.loans;
  buildCategoriaOptions();
  buildExchangeOptions();
}

// Sin PIN: la app abre directo con los datos locales.
async function enterApp() {
  const set = await window.api.getSettings();
  if (set.ok) state.settings = set.settings;
  await reloadAll();
  await cargarTasa();
  await cargarMercado();
  // El proceso principal consulta el BCV al abrir y avisa cuando termina.
  window.api.onTasaActualizada((payload) => {
    if (!payload) return;
    state.settings = payload.settings || state.settings;
    state.tasaHistorial = payload.historial || state.tasaHistorial;
    if (payload.ok) {
      state.tasa = payload.tasa;
      toast(`Tasa BCV actualizada: Bs. ${fmtNum(payload.tasa.valor)}`);
    }
    if (!$('#modal-settings').classList.contains('hidden')) renderTasaPanel();
    render();
  });
  // Lo mismo con el paralelo y los euros.
  window.api.onMercadoActualizado((payload) => {
    if (!payload) return;
    state.mercado = payload.mercado;
    state.mercadoHistorial = payload.historial || state.mercadoHistorial;
    state.mercadoError = payload.ok ? null : payload.error;
    if (state.activeTab === 'Tasas') render();
    else renderTabs();
  });
  render();
}

/* ============================== Formulario ============================== */
// Muestra u oculta los campos propios de una conversión según el radio elegido.
function syncTipoCampos() {
  const sel = document.querySelector('input[name="tipo"]:checked');
  const esConv = !!sel && sel.value === 'Conversión';
  $('#conv-fields').classList.toggle('hidden', !esConv);
  $('#conv-help').classList.toggle('hidden', !esConv);
  // En conversión el precio de compra no aplica: el precio va en su propio campo.
  $('#f-precio').closest('.field').classList.toggle('hidden', esConv);
  $('#f-spot').closest('.field').classList.toggle('hidden', esConv);
  updateConvCalc();
}

// Caja en vivo: "1.000 USDT → ₿0,0125 @ 80.000" mientras se escribe.
function updateConvCalc() {
  const sel = document.querySelector('input[name="tipo"]:checked');
  if (!sel || sel.value !== 'Conversión') return;
  const desde = $('#f-conv-moneda').value;
  const hacia = $('#f-moneda').value;
  const mDesde = num($('#f-conv-monto').value);
  const mHacia = num($('#f-monto').value);
  if (mDesde <= 0 || mHacia <= 0) {
    $('#conv-calc').innerHTML = '<span class="muted">Completa ambos montos para ver el precio.</span>';
    return;
  }
  const precio = mDesde / mHacia;
  // Autofill: solo mientras el usuario no haya escrito un precio a mano.
  const campoPrecio = $('#f-conv-precio');
  if (!campoPrecio.dataset.tocado) campoPrecio.value = round2(precio);
  if (desde === hacia) {
    $('#conv-calc').innerHTML = '<span class="err">Las dos monedas deben ser distintas.</span>';
    return;
  }
  $('#conv-calc').innerHTML =
    `<span class="chip">${fmtNum(mDesde)} ${esc(desde)}</span><span class="arrow">→</span>` +
    `<span class="chip">${fmtNum(mHacia)} ${esc(hacia)}</span><span class="arrow">=</span>` +
    `<span class="chip total">1 ${esc(hacia)} = ${fmtNum(num(campoPrecio.value) || precio)} ${esc(desde)}</span>`;
}

function openForm(id) {
  state.editingId = id || null;
  const isEdit = !!state.editingId;
  const rec = isEdit ? byId(state.editingId) : null;
  const conv = isEdit && isConversion(rec);

  $('#form-title').textContent = isEdit ? (conv ? 'Editar conversión' : 'Editar registro') : 'Nuevo registro';

  $('#f-fecha').value = rec ? rec.fecha : todayISO();
  const tipoRadio = document.querySelector(`input[name="tipo"][value="${rec ? rec.tipo || 'Egreso' : 'Egreso'}"]`);
  if (tipoRadio) tipoRadio.checked = true;
  $('#f-concepto').value = rec ? rec.concepto : '';
  $('#f-categoria').value = rec ? rec.categoria : '';
  $('#f-moneda').value = rec ? rec.moneda : (MONEY_TABS.includes(state.activeTab) ? state.activeTab : 'Bs');
  $('#f-monto').value = rec ? rec.monto : '';
  // Autofill de la tasa: la del día de la fecha elegida, si la tenemos en el historial.
  const t = tasaDe($('#f-fecha').value);
  $('#f-tasa').value = rec && rec.tasaDia !== null ? rec.tasaDia : (t > 0 ? t : '');
  $('#f-precio').value = rec && rec.precioCompra !== null ? rec.precioCompra : '';
  $('#f-bs').value = rec && rec.bsInvolucrados !== null ? rec.bsInvolucrados : '';
  $('#f-exchange-form').value = rec ? rec.exchange : 'Ninguno';
  $('#f-spot').checked = rec ? rec.spot : false;
  $('#f-notas').value = rec ? rec.notas : '';

  // Campos de conversión
  const c = (rec && rec.convierte) || {};
  const otra = (moneda) => (moneda === 'BTC' ? 'USDT' : 'BTC');
  $('#f-conv-moneda').value = c.moneda || otra(rec ? rec.moneda : $('#f-moneda').value);
  $('#f-conv-monto').value = conv ? c.monto : '';
  const pf = $('#f-conv-precio');
  pf.value = conv && c.precioUnitario ? c.precioUnitario : '';
  pf.dataset.tocado = conv ? '1' : '';
  syncTipoCampos();

  // Selector de origen (excluye auto-referencias y ciclos)
  const sel = $('#f-origen');
  const selfId = state.editingId;
  const groups = { BTC: [], USDT: [], USD: [], Bs: [] };
  for (const r of state.records) {
    if (!canSetOrigen(r.id, selfId)) continue;
    (groups[r.moneda] = groups[r.moneda] || []).push(r);
  }
  let html = '<option value="">— Sin origen —</option>';
  for (const m of MONEY_TABS) {
    if (!groups[m].length) continue;
    html += `<optgroup label="${C[m].icon} ${C[m].label}">`;
    for (const r of groups[m]) {
      html += `<option value="${r.id}">${fmtDate(r.fecha)} — ${esc(r.concepto)} (${fmtNum(r.monto)} ${C[m].label})</option>`;
    }
    html += '</optgroup>';
  }
  sel.innerHTML = html;
  sel.value = rec && rec.origenId ? rec.origenId : '';

  $('#form-error').classList.add('hidden');
  $('#modal-form').classList.remove('hidden');
  if (conv) $('#f-conv-monto').focus();
  else $('#f-concepto').focus();
}

function closeForm() {
  $('#modal-form').classList.add('hidden');
  state.editingId = null;
}

function saveForm() {
  const tipo = (document.querySelector('input[name="tipo"]:checked') || {}).value || 'Egreso';
  const rec = {
    fecha: $('#f-fecha').value || todayISO(),
    tipo,
    concepto: $('#f-concepto').value.trim(),
    categoria: $('#f-categoria').value.trim(),
    moneda: $('#f-moneda').value,
    monto: num($('#f-monto').value),
    tasaDia: val($('#f-tasa').value),
    spot: $('#f-spot').checked,
    precioCompra: val($('#f-precio').value),
    bsInvolucrados: val($('#f-bs').value),
    // OJO: la clave debe ser "convierte" (con r), es la que lee core.normalizeRecord().
    convierte: {
      moneda: $('#f-conv-moneda').value,
      monto: num($('#f-conv-monto').value),
      precioUnitario: val($('#f-conv-precio').value),
    },
    exchange: $('#f-exchange-form').value,
    notas: $('#f-notas').value.trim(),
    origenId: $('#f-origen').value || null,
  };

  if (!rec.concepto) return showError($('#form-error'), 'El concepto es obligatorio');
  if (rec.monto <= 0) return showError($('#form-error'), isConversion(rec) ? 'El monto que recibes debe ser mayor a 0' : 'El monto debe ser mayor a 0');
  if (isConversion(rec)) {
    if (rec.convierte.monto <= 0) return showError($('#form-error'), 'El monto que entregas debe ser mayor a 0');
    if (rec.convierte.moneda === rec.moneda) return showError($('#form-error'), 'Una conversión debe ser entre dos monedas distintas');
  }

  const op = state.editingId ? window.api.updateRecord({ ...rec, id: state.editingId }) : window.api.addRecord(rec);
  op.then(async (res) => {
    if (!res.ok) return showError($('#form-error'), res.error);
    const wasEdit = !!state.editingId;
    closeForm();
    await reloadAll();
    render();
    toast(wasEdit ? 'Actualizado' : 'Registro guardado');
  });
}

/* ============================== Detalle + cadena ============================== */
function openDetail(id) {
  state.detailId = id;
  const r = byId(id);
  if (!r) return;

  const m = C[r.moneda];
  const chain = getChain(id);
  const children = findChildren(id);

  const chainHtml = chain.length > 1
    ? `<div class="chain">${chain
        .map((c) => {
          const cc = C[c.moneda];
          const cur = c.id === id;
          return `<span class="chip ${cur ? 'current' : ''}" data-id="${c.id}"><span class="c ${cc.cls}">${cc.icon || cc.label}</span> ${fmtDate(c.fecha)} · ${esc(c.concepto)}</span>`;
        })
        .join('<span class="arrow">→</span>')}</div>`
    : '';

  const childrenHtml = children.length
    ? `<div class="detail-item full"><div class="lbl">Registros que nacen de este</div><div class="val">${children
        .map((c) => `${C[c.moneda].icon} ${esc(c.concepto)} (${fmtDate(c.fecha)})`)
        .join('<br>')}</div></div>`
    : '';

  const b = bsValue(r);
  const conv = isConversion(r);
  const c = r.convierte || {};
  const pUnit = precioUnitario(r);
  const items = [
    ['Fecha', fmtDate(r.fecha)],
    ['Tipo', conv ? '\u2194 Conversi\u00F3n' : r.tipo === 'Ingreso' ? '\u{1F7E2} Ingreso' : '\u{1F534} Egreso'],
    ['Moneda', `${m.icon} ${m.label}`],
    ['Monto', conv ? celdaMonto(r) : fmtNum(r.monto)],
    ['Concepto', esc(r.concepto)],
    ['Categor\u00EDa', r.categoria ? esc(r.categoria) : '\u2014'],
    ['Tasa del d\u00EDa (Bs)', r.tasaDia !== null ? fmtNum(r.tasaDia) : '\u2014'],
    ['Compra por spot', r.spot ? 'S\u00ED' : 'No'],
    ['Precio de compra', r.precioCompra !== null ? fmtNum(r.precioCompra) : '\u2014'],
    ['Bs involucrados', r.bsInvolucrados !== null ? fmtNum(r.bsInvolucrados) : '\u2014'],
    ['Exchange destino', r.exchange],
    ['\u2248 Valor en Bs', conv ? 'No aplica (no es gasto)' : b !== null ? `Bs. ${fmtNum(b)}` : '\u2014'],
  ];

  $('#detail-body').innerHTML = `
    <div class="detail-grid">
      ${items.map(([l, v]) => `<div class="detail-item"><div class="lbl">${l}</div><div class="val">${v}</div></div>`).join('')}
      ${conv ? `<div class="detail-item full"><div class="lbl">Conversi\u00F3n</div><div class="val">${celdaMonto(r)}${pUnit ? `<div class="sub">1 ${esc(m.label)} = ${fmtNum(pUnit)} ${esc(c.moneda)}</div>` : ''}<div class="sub muted">El valor se movi\u00F3 dentro de ${esc(r.exchange === 'Ninguno' ? 'ning\u00FAn exchange' : r.exchange)}: no altera el total en Bs.</div></div></div>` : ''}
      ${r.notas ? `<div class="detail-item full"><div class="lbl">Notas</div><div class="val">${esc(r.notas)}</div></div>` : ''}
      ${childrenHtml}
    </div>
    ${chainHtml}`;

  $('#modal-detail').classList.remove('hidden');
}

function closeDetail() {
  $('#modal-detail').classList.add('hidden');
  state.detailId = null;
}

async function deleteRecord(id) {
  const r = byId(id);
  if (!r) return;
  const children = findChildren(id).length;
  const extra = children ? `\n\n⚠️ Este registro es origen de ${children} registro(s); quedarán sin origen.` : '';
  if (!confirm(`¿Eliminar "${r.concepto}" (${C[r.moneda].icon} ${fmtNum(r.monto)})?${extra}`)) return;
  const res = await window.api.deleteRecord(id);
  if (!res.ok) return toast(res.error || 'Error', 'err');
  closeDetail();
  await reloadAll();
  render();
  toast('Registro eliminado');
}

/* ============================== Menú ============================== */
function toggleMenu(open) {
  $('#menu-drop').classList.toggle('hidden', !open);
}

async function menuAction(action) {
  toggleMenu(false);
  switch (action) {
    case 'export': {
      const res = await window.api.exportBackup();
      if (res.ok) toast(`Respaldo guardado en ${res.path}`);
      break;
    }
    case 'csv': {
      const res = await window.api.exportCsv();
      if (res.ok) toast(`CSV guardado en ${res.path}`);
      break;
    }
    case 'import': {
      await doImport();
      break;
    }
    case 'settings': {
      $('#set-tasa').value = state.settings.tasaReferencia > 0 ? state.settings.tasaReferencia : '';
      $('#set-fuente').value = state.settings.tasaFuente === 'Manual' ? 'Manual' : 'BCV';
      renderTasaPanel();
      $('#modal-settings').classList.remove('hidden');
      break;
    }
  }
}

async function doImport() {
  const res = await window.api.importBackup();
  if (!res.ok) {
    if (!res.canceled) toast(res.error, 'err');
    return;
  }
  const set = await window.api.getSettings();
  if (set.ok) state.settings = set.settings;
  await reloadAll();
  render();
  toast(`Respaldo importado: ${res.count} registro(s)`);
}

async function doSaveSettings() {
  const t = num($('#set-tasa').value);
  const fuente = $('#set-fuente').value === 'Manual' ? 'Manual' : 'BCV';
  const res = await window.api.saveSettings({ tasaReferencia: t, tasaFuente: fuente });
  if (!res.ok) return;
  state.settings.tasaReferencia = t;
  state.settings.tasaFuente = fuente;
  $('#modal-settings').classList.add('hidden');
  render();
  toast(fuente === 'Manual' ? 'Tasa guardada (manual: la app no la va a tocar)' : 'Tasa guardada');
}

/* ============================== Tasa BCV ============================== */

function renderTasaPanel() {
  const t = state.tasa;
  const err = state.settings.tasaUltimoError;
  const errBox = $('#tasa-error');
  if (err) {
    errBox.textContent = 'No se pudo consultar: ' + err;
    errBox.classList.remove('hidden');
  } else {
    errBox.classList.add('hidden');
  }

  const cuando = state.settings.tasaUltimaConsulta
    ? new Date(state.settings.tasaUltimaConsulta).toLocaleString('es-VE', { dateStyle: 'short', timeStyle: 'short' })
    : 'sin consultar';
  $('#tasa-actual').innerHTML = t && t.valor > 0
    ? `<div class="tasa-cifra">Bs. <b>${fmtNum(t.valor)}</b> <span class="muted">por 1 USD</span></div>
       <div class="tasa-meta">Fuente: <b>${esc(t.fuente)}</b>${t.fecha ? ` · valor del ${fmtDate(t.fecha)}` : ''} · consultado ${cuando}</div>`
    : '<div class="tasa-cifra muted">Todavía no hay ninguna tasa consultada.</div>';

  const hist = state.tasaHistorial || [];
  $('#tasa-historial').innerHTML = hist.length
    ? '<table class="tasa-tbl"><thead><tr><th>Fecha</th><th>Bs por USD</th><th>Fuente</th></tr></thead><tbody>'
      + hist.map((x) => `<tr><td>${fmtDate(x.fecha)}</td><td>${fmtNum(x.valor)}</td><td>${esc(x.fuente || '—')}</td></tr>`).join('')
      + '</tbody></table>'
    : '<div class="muted">Sin historial todavía. Se guarda una tasa por cada día que se consulte.</div>';
}

async function cargarTasa() {
  const res = await window.api.getTasa();
  if (!res.ok) return;
  state.tasa = res.tasa;
  state.tasaHistorial = res.historial || [];
  state.settings = res.settings;
  if (!$('#modal-settings').classList.contains('hidden')) renderTasaPanel();
  render();
}

// Consulta el BCV y deja la tasa nueva en el campo que se le pase (autofill del formulario).
async function refrescarTasaEn(campo) {
  const btn = campo === '#l-tasa' ? $('#l-tasa-bcv') : $('#f-tasa-bcv');
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const res = await window.api.refreshTasa();
    if (res.ok) {
      state.tasa = res.tasa;
      state.tasaHistorial = res.historial || [];
      state.settings = res.settings;
      campo.value = res.tasa.valor;
      if (!$('#modal-settings').classList.contains('hidden')) renderTasaPanel();
      toast(`Tasa BCV: Bs. ${fmtNum(res.tasa.valor)}${res.tasa.fecha ? ' (del ' + fmtDate(res.tasa.fecha) + ')' : ''}`);
    } else {
      state.settings.tasaUltimoError = res.error;
      if (!$('#modal-settings').classList.contains('hidden')) renderTasaPanel();
      toast('No se pudo consultar la tasa del BCV', 'err');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = '↻ BCV';
  }
}

/* ============================== Eventos ============================== */
function bindEvents() {
  // Pestañas
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (!b) return;
    state.activeTab = b.dataset.tab;
    render();
  });

  // Nueva compra / menú
  $('#btn-new').addEventListener('click', () => {
    if (state.activeTab === 'Préstamos') openLoanForm();
    else if (state.activeTab !== 'Cartera') openForm();
  });
  $('#btn-menu').addEventListener('click', (e) => {
    e.stopPropagation();
    const drop = $('#menu-drop');
    toggleMenu(drop.classList.contains('hidden'));
  });
  $('#menu-drop').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-action]');
    if (b) menuAction(b.dataset.action);
  });
  document.addEventListener('click', () => toggleMenu(false));

  // Filtros
  $('#f-q').addEventListener('input', (e) => { state.filters.q = e.target.value; renderTotals(); renderTable(); });
  $('#f-categoria').addEventListener('change', (e) => { state.filters.categoria = e.target.value; renderTotals(); renderTable(); });
  $('#f-exchange').addEventListener('change', (e) => { state.filters.exchange = e.target.value; renderTotals(); renderTable(); });
  $('#f-desde').addEventListener('change', (e) => { state.filters.desde = e.target.value; renderTotals(); renderTable(); });
  $('#f-hasta').addEventListener('change', (e) => { state.filters.hasta = e.target.value; renderTotals(); renderTable(); });
  $('#f-clear').addEventListener('click', () => {
    state.filters = { q: '', categoria: '', exchange: '', desde: '', hasta: '' };
    $('#f-q').value = '';
    $('#f-categoria').value = '';
    $('#f-exchange').value = '';
    $('#f-desde').value = '';
    $('#f-hasta').value = '';
    renderTotals();
    renderTable();
  });

  // Tabla (delegación): abrir detalle o accionar botones
  $('#tbody').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    const row = e.target.closest('tr[data-id]');
    if (!row) return;
    const id = row.dataset.id;
    if (act) {
      e.stopPropagation();
      if (act.dataset.act === 'view') openDetail(id);
      else if (act.dataset.act === 'edit') openForm(id);
      else if (act.dataset.act === 'del') deleteRecord(id);
    } else {
      openDetail(id);
    }
  });

  // Formulario
  $('#record-form').addEventListener('submit', (e) => { e.preventDefault(); saveForm(); });
  $('#form-cancel').addEventListener('click', closeForm);
  $('#modal-form').addEventListener('click', (e) => { if (e.target.id === 'modal-form') closeForm(); });

  // Tipo de movimiento: al cambiar a Conversión se muestran sus campos.
  for (const radio of document.querySelectorAll('input[name="tipo"]')) {
    radio.addEventListener('change', syncTipoCampos);
  }
  for (const sel of ['#f-conv-monto', '#f-conv-moneda', '#f-moneda']) {
    $(sel).addEventListener('input', updateConvCalc);
    $(sel).addEventListener('change', updateConvCalc);
  }
  // Si el usuario escribe un precio a mano, se respeta y deja de calcularse.
  $('#f-conv-precio').addEventListener('input', (e) => {
    e.target.dataset.tocado = '1';
    updateConvCalc();
  });

  // Tasa BCV: se rellena sola al cambiar la fecha, y hay botón de consulta en los formularios.
  $('#f-fecha').addEventListener('change', (e) => {
    if (val($('#f-tasa').value) !== null) return; // no pisar una tasa escrita a mano
    const t = tasaDe(e.target.value);
    if (t > 0) $('#f-tasa').value = t;
  });
  $('#f-tasa-bcv').addEventListener('click', () => refrescarTasaEn('#f-tasa'));
  $('#l-tasa-bcv').addEventListener('click', () => refrescarTasaEn('#l-tasa'));

  // Cartera: ver los movimientos de un exchange
  $('#cartera-grid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ver-exchange]');
    if (b) verExchange(b.dataset.verExchange);
  });

  // Tasas de mercado
  $('#mercado-refresh').addEventListener('click', refrescarMercado);
  $('#cv-cambiar').addEventListener('click', cambiarDireccion);
  for (const sel of ['#cv-monto', '#cv-tasa']) {
    $(sel).addEventListener('input', actualizarConversion);
    $(sel).addEventListener('change', actualizarConversion);
  }
  $('#mercado-filtro').addEventListener('click', (e) => {
    const b = e.target.closest('.chip-btn');
    if (!b) return;
    state.filtroMercado = b.dataset.filtro;
    renderMercado();
  });
  // Clic en una tarjeta: usar esa tasa en el convertidor.
  $('#mercado-actual').addEventListener('click', (e) => {
    const c = e.target.closest('[data-usar-tasa]');
    if (!c) return;
    $('#cv-tasa').value = c.dataset.usarTasa;
    actualizarConversion();
    $('.convertidor').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  // Tasa BCV: refresco y errores que llegan desde el proceso principal
  $('#tasa-refresh').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const res = await window.api.refreshTasa();
      if (res.ok) {
        state.tasa = res.tasa;
        state.tasaHistorial = res.historial || [];
        state.settings = res.settings;
        $('#set-tasa').value = res.tasa.valor;
        renderTasaPanel();
        toast(`Tasa BCV: Bs. ${fmtNum(res.tasa.valor)}`);
      } else {
        state.settings.tasaUltimoError = res.error;
        renderTasaPanel();
        toast('No se pudo consultar la tasa del BCV', 'err');
      }
    } finally {
      btn.disabled = false;
      btn.textContent = '↻ Consultar ahora';
    }
  });

  // Detalle
  $('#detail-body').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip[data-id]');
    if (chip) openDetail(chip.dataset.id);
  });
  $('#detail-close').addEventListener('click', closeDetail);
  $('#detail-edit').addEventListener('click', () => {
    const id = state.detailId;
    closeDetail();
    openForm(id);
  });
  $('#detail-delete').addEventListener('click', () => state.detailId && deleteRecord(state.detailId));
  $('#modal-detail').addEventListener('click', (e) => { if (e.target.id === 'modal-detail') closeDetail(); });

  // Settings
  $('#settings-cancel').addEventListener('click', () => $('#modal-settings').classList.add('hidden'));
  $('#settings-ok').addEventListener('click', doSaveSettings);

  // Calendario
  $('#cal-prev').addEventListener('click', () => calGo(-1));
  $('#cal-next').addEventListener('click', () => calGo(1));
  $('#cal-today').addEventListener('click', calGoToday);
  $('#cal-jump').addEventListener('click', calJumpToList);
  $('#cal-grid').addEventListener('click', (e) => {
    const cell = e.target.closest('.cal-cell.has');
    if (cell) calSelect(cell.dataset.date);
  });

  // ---------- Préstamos ----------
  $('#loan-form').addEventListener('submit', (e) => {
    e.preventDefault();
    saveLoan();
  });
  $('#loan-cancel').addEventListener('click', closeLoanForm);
  $('#modal-loan').addEventListener('click', (e) => {
    if (e.target.id === 'modal-loan') closeLoanForm();
  });
  for (const sel of ['#l-monto', '#l-interes', '#l-dias', '#l-fecha', '#l-tasa']) {
    $(sel).addEventListener('input', updateLoanCalc);
    $(sel).addEventListener('change', updateLoanCalc);
  }

  $('#loan-tbody').addEventListener('click', (e) => {
    const act = e.target.closest('[data-lact]');
    const row = e.target.closest('tr[data-loan-id]');
    if (!row) return;
    const id = row.dataset.loanId;
    if (act) {
      e.stopPropagation();
      const a = act.dataset.lact;
      if (a === 'view') openLoanDetail(id);
      else if (a === 'edit') openLoanForm(id);
      else if (a === 'del') deleteLoan(id);
      else if (a === 'pay' || a === 'undo') toggleLoanPay(id);
    } else {
      openLoanDetail(id);
    }
  });

  $('#loan-detail-close').addEventListener('click', closeLoanDetail);
  $('#loan-detail-edit').addEventListener('click', () => {
    const id = state.detailLoanId;
    closeLoanDetail();
    openLoanForm(id);
  });
  $('#loan-detail-pay').addEventListener('click', () => state.detailLoanId && toggleLoanPay(state.detailLoanId));
  $('#loan-detail-delete').addEventListener('click', () => state.detailLoanId && deleteLoan(state.detailLoanId));
  $('#modal-loan-detail').addEventListener('click', (e) => {
    if (e.target.id === 'modal-loan-detail') closeLoanDetail();
  });
}

/* ============================== Arranque ============================== */
document.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  enterApp();
});