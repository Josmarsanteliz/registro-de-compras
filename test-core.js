'use strict';

// Pruebas rápidas de la lógica pura (core.js). Ejecutar: node test-core.js

const assert = require('assert');
const core = require('./core');
const mercado = require('./mercado');

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log('  ✓ ' + name);
}

console.log('core: normalizeRecord');
t('convierte número con coma y aplica defaults', () => {
  const r = core.normalizeRecord({ concepto: '  test  ', monto: '3,5', moneda: 'BTC' });
  assert.strictEqual(r.concepto, 'test');
  assert.strictEqual(r.monto, 3.5);
  assert.strictEqual(r.moneda, 'BTC');
  assert.strictEqual(r.exchange, 'Ninguno');
  assert.strictEqual(r.spot, false);
});
t('moneda inválida cae a Bs', () => {
  assert.strictEqual(core.normalizeRecord({ moneda: 'EUR' }).moneda, 'Bs');
});
t('tipo por defecto es Egreso', () => {
  assert.strictEqual(core.normalizeRecord({ concepto: 'x', monto: 1 }).tipo, 'Egreso');
});
t('tipo Ingreso se conserva', () => {
  assert.strictEqual(core.normalizeRecord({ concepto: 'x', monto: 1, tipo: 'Ingreso' }).tipo, 'Ingreso');
});
t('tipo inválido cae a Egreso', () => {
  assert.strictEqual(core.normalizeRecord({ concepto: 'x', monto: 1, tipo: 'Regalo' }).tipo, 'Egreso');
});

console.log('core: validateRecord / ciclos');
const records = [
  { id: 'a', concepto: 'Bs a USDT', moneda: 'Bs', monto: 1 },
  { id: 'b', concepto: 'USDT a BTC', moneda: 'USDT', monto: 1, origenId: 'a' },
  { id: 'c', concepto: 'BTC final', moneda: 'BTC', monto: 1, origenId: 'b' },
];
t('sin origen es válido', () => {
  assert.deepStrictEqual(core.validateRecord(core.normalizeRecord({ concepto: 'x', monto: 1 }), records), { ok: true });
});
t('concepto vacío rechazado', () => {
  assert.strictEqual(core.validateRecord(core.normalizeRecord({ concepto: '', monto: 1 }), records).ok, false);
});
t('monto cero rechazado', () => {
  assert.strictEqual(core.validateRecord(core.normalizeRecord({ concepto: 'x', monto: 0 }), records).ok, false);
});
t('origen inexistente rechazado', () => {
  assert.strictEqual(core.validateRecord(core.normalizeRecord({ concepto: 'x', monto: 1, origenId: 'zzz' }), records).ok, false);
});
t('cadena válida aceptada', () => {
  assert.deepStrictEqual(core.validateRecord(core.normalizeRecord({ concepto: 'x', monto: 1, origenId: 'b' }), records), { ok: true });
});
t('detecta auto-referencia', () => {
  assert.strictEqual(core.validateRecord(core.normalizeRecord({ id: 'a', concepto: 'x', monto: 1, origenId: 'a' }), records).ok, false);
});
t('detecta ciclo A->B->A', () => {
  // Si "a" se edita y su origen pasa a ser "c" (que desciende de "a") -> ciclo.
  assert.strictEqual(core.validateRecord(core.normalizeRecord({ id: 'a', concepto: 'x', monto: 1, origenId: 'c' }), records).ok, false);
});
t('cadena profunda no tiene falso positivo', () => {
  assert.deepStrictEqual(core.validateRecord(core.normalizeRecord({ id: 'z', concepto: 'x', monto: 1, origenId: 'c' }), records), { ok: true });
});

console.log('core: bsValue');
t('Bs directo', () => {
  assert.strictEqual(core.bsValue({ moneda: 'Bs', monto: 100 }, 0), 100);
});
t('USDT con tasa del día', () => {
  assert.strictEqual(core.bsValue({ moneda: 'USDT', monto: 10, tasaDia: 36.5 }, 0), 365);
});
t('USDT con tasa de referencia', () => {
  assert.strictEqual(core.bsValue({ moneda: 'USDT', monto: 10, tasaDia: 0 }, 36.5), 365);
});
t('USDT sin tasa -> null', () => {
  assert.strictEqual(core.bsValue({ moneda: 'USDT', monto: 10 }, 0), null);
});
t('BTC con precio y tasa', () => {
  assert.strictEqual(core.bsValue({ moneda: 'BTC', monto: 0.001, precioCompra: 60000, tasaDia: 36.5 }, 0), 2190);
});
t('bsInvolucrados tiene prioridad', () => {
  assert.strictEqual(core.bsValue({ moneda: 'USDT', monto: 10, bsInvolucrados: 500 }, 36.5), 500);
});

console.log('core: buildCsv');
t('genera CSV con BOM y comillas', () => {
  const csv = core.buildCsv(
    [
      { fecha: '2026-09-21', concepto: 'compra; especial', categoria: 'crypto', moneda: 'USDT', monto: 100, tasaDia: null, spot: true, precioCompra: null, bsInvolucrados: 3650, exchange: 'Binance', origenId: null, notas: 'hola "mundo"' },
    ],
    () => ''
  );
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('"compra; especial"'));
  assert.ok(csv.includes('"hola ""mundo"""'));
});
t('CSV incluye la columna Tipo con su valor', () => {
  const csv = core.buildCsv(
    [
      { fecha: '2026-09-21', tipo: 'Ingreso', concepto: 'venta', moneda: 'Bs', monto: 500 },
      { fecha: '2026-09-22', concepto: 'luz', moneda: 'Bs', monto: 100 },
    ],
    () => ''
  );
  const line1 = csv.split('\r\n')[0];
  assert.ok(line1.includes('Tipo'), 'header sin Tipo');
  assert.ok(csv.includes('2026-09-21;Ingreso;venta'), 'ingreso mal escrito');
  assert.ok(csv.includes('2026-09-22;Egreso;luz'), 'egreso por defecto mal escrito');
});

console.log('core: formato');
t('fecha dd/mm/aaaa y número español', () => {
  assert.strictEqual(core.fmtDate('2026-09-21'), '21/09/2026');
  assert.strictEqual(core.fmtNumber(1234.5), '1.234,5');
  assert.strictEqual(core.fmtNumber(null), '\u2014');
});

console.log('core: pr\u00E9stamos');
t('inter\u00E9s del 10% y total: 60$ -> 6$ -> 66$', () => {
  const c = core.calcLoan(60, 10);
  assert.strictEqual(c.interes, 6);
  assert.strictEqual(c.total, 66);
});
t('plazo de 14 d\u00EDas: vencimiento = fecha + 14', () => {
  assert.strictEqual(core.addDaysISO('2026-09-20', 14), '2026-10-04');
});
t('addDaysISO cruza de mes y a\u00F1o', () => {
  assert.strictEqual(core.addDaysISO('2026-12-28', 10), '2027-01-07');
});
t('normalizeLoan calcula vencimiento, interés y total', () => {
  const l = core.normalizeLoan({ fecha: '2026-09-20', monto: 60, interesPct: 10, dias: 14 });
  assert.strictEqual(l.interes, 6);
  assert.strictEqual(l.total, 66);
  assert.strictEqual(l.fechaVenc, '2026-10-04');
  assert.strictEqual(l.pagado, false);
  assert.strictEqual(l.tasaBCV, null);
});
t('normalizeLoan aplica defaults 10% y 14 d\u00EDas', () => {
  const l = core.normalizeLoan({ fecha: '2026-09-20', monto: 100 });
  assert.strictEqual(l.interesPct, 10);
  assert.strictEqual(l.dias, 14);
  assert.strictEqual(l.total, 110);
});
t('validateLoan: monto cero o sin fecha rechazado', () => {
  assert.strictEqual(core.validateLoan(core.normalizeLoan({ fecha: '', monto: 60 })).ok, false);
  assert.strictEqual(core.validateLoan(core.normalizeLoan({ fecha: '2026-09-20', monto: 0 })).ok, false);
  assert.strictEqual(core.validateLoan(core.normalizeLoan({ fecha: '2026-09-20', monto: 60 })).ok, true);
});
t('loanBs usa tasa BCV propia y si no la de referencia', () => {
  const conTasa = core.normalizeLoan({ fecha: '2026-09-20', monto: 60, tasaBCV: 40 });
  assert.strictEqual(core.loanBs(conTasa, 61), 2640); // 66 * 40
  const sinTasa = core.normalizeLoan({ fecha: '2026-09-20', monto: 60 });
  assert.strictEqual(core.loanBs(sinTasa, 40), 2640); // 66 * 40
  assert.strictEqual(core.loanBs(sinTasa, 0), null);
});
t('loanStatus: pendiente, hoy, vencido y pagado', () => {
  const base = { fecha: '2026-09-01', monto: 60, dias: 14 }; // vence 2026-09-15
  const pend = core.normalizeLoan(base);
  assert.strictEqual(core.loanStatus(pend, '2026-09-10').estado, 'Pendiente');
  assert.strictEqual(core.loanStatus(pend, '2026-09-10').dias, 5);
  assert.strictEqual(core.loanStatus(pend, '2026-09-15').estado, 'Hoy');
  assert.strictEqual(core.loanStatus(pend, '2026-09-20').estado, 'Vencido');
  assert.strictEqual(core.loanStatus(pend, '2026-09-20').dias, -5);
  const pagado = core.normalizeLoan({ ...base, pagado: true, pagadoEn: '2026-09-14' });
  assert.strictEqual(core.loanStatus(pagado, '2026-09-20').estado, 'Pagado');
});
t('buildLoansCsv incluye headers y el total', () => {
  const csv = core.buildLoansCsv([core.normalizeLoan({ fecha: '2026-09-20', monto: 60, contraparte: 'vecino' })]);
  assert.ok(csv.startsWith('Fecha;Monto recibido'));
  assert.ok(csv.includes('2026-09-20;60;10;6;66;14;2026-10-04'));
});
t('moneda USD existe en CURRENCIES', () => {
  assert.strictEqual(core.normalizeRecord({ concepto: 'x', monto: 1, moneda: 'USD' }).moneda, 'USD');
});

/* ============================== Conversiones ============================== */
console.log('core: conversiones');
t('el tipo Conversión se conserva', () => {
  const r = core.normalizeRecord({ concepto: 'swap', monto: 0.01, moneda: 'BTC', tipo: 'Conversión', convierte: { moneda: 'USDT', monto: 800 } });
  assert.strictEqual(r.tipo, 'Conversión');
  assert.strictEqual(r.convierte.moneda, 'USDT');
  assert.strictEqual(r.convierte.monto, 800);
});
t('el precio unitario se deriva si no viene', () => {
  const r = core.normalizeRecord({ tipo: 'Conversión', concepto: 's', monto: 0.0125, moneda: 'BTC', convierte: { moneda: 'USDT', monto: 1000 } });
  assert.strictEqual(r.convierte.precioUnitario, 80000);
});
t('el precio unitario explícito manda sobre el derivado', () => {
  const r = core.normalizeRecord({ tipo: 'Conversión', concepto: 's', monto: 0.0125, moneda: 'BTC', convierte: { moneda: 'USDT', monto: 1000, precioUnitario: 79500 } });
  assert.strictEqual(r.convierte.precioUnitario, 79500);
});
t('conversión sin moneda origen: el default es el otro lado', () => {
  const aUSDT = core.normalizeRecord({ tipo: 'Conversión', concepto: 's', monto: 0.01, moneda: 'BTC' });
  assert.strictEqual(aUSDT.convierte.moneda, 'USDT');
  const aBTC = core.normalizeRecord({ tipo: 'Conversión', concepto: 's', monto: 500, moneda: 'USDT' });
  assert.strictEqual(aBTC.convierte.moneda, 'BTC');
});
t('tipo inválido cae a Egreso', () => {
  assert.strictEqual(core.normalizeRecord({ concepto: 'x', monto: 1, tipo: 'Regalo' }).tipo, 'Egreso');
});
t('isConversion solo es true para Conversión', () => {
  assert.strictEqual(core.isConversion({ tipo: 'Conversión' }), true);
  assert.strictEqual(core.isConversion({ tipo: 'Ingreso' }), false);
  assert.strictEqual(core.isConversion({}), false);
});
t('validateRecord: conversión sin monto entregado rechazada', () => {
  const r = core.normalizeRecord({ tipo: 'Conversión', concepto: 'swap', monto: 0.01, moneda: 'BTC', convierte: { moneda: 'USDT', monto: 0 } });
  assert.strictEqual(core.validateRecord(r, records).ok, false);
});
t('validateRecord: conversión de una moneda a sí misma rechazada', () => {
  const r = core.normalizeRecord({ tipo: 'Conversión', concepto: 'swap', monto: 1, moneda: 'BTC', convierte: { moneda: 'BTC', monto: 100 } });
  assert.strictEqual(core.validateRecord(r, records).ok, false);
});
t('validateRecord: conversión válida aceptada', () => {
  const r = core.normalizeRecord({ tipo: 'Conversión', concepto: 'swap', monto: 0.01, moneda: 'BTC', convierte: { moneda: 'USDT', monto: 800 } });
  assert.deepStrictEqual(core.validateRecord(r, records), { ok: true });
});

console.log('core: aplicarMovimiento');
t('Ingreso suma, Egreso resta', () => {
  assert.deepStrictEqual(core.aplicarMovimiento({ tipo: 'Ingreso', moneda: 'USDT', monto: 100 }), [{ moneda: 'USDT', signo: 1, monto: 100 }]);
  assert.deepStrictEqual(core.aplicarMovimiento({ tipo: 'Egreso', moneda: 'Bs', monto: 50 }), [{ moneda: 'Bs', signo: -1, monto: 50 }]);
});
t('conversión: resta lo entregado y suma lo recibido', () => {
  const r = core.normalizeRecord({ tipo: 'Conversión', concepto: 'swap', monto: 0.01234, moneda: 'BTC', convierte: { moneda: 'USDT', monto: 1000 } });
  assert.deepStrictEqual(core.aplicarMovimiento(r), [
    { moneda: 'USDT', signo: -1, monto: 1000 },
    { moneda: 'BTC', signo: 1, monto: 0.01234 },
  ]);
});
t('conversión a la inversa (BTC -> USDT) invierte los lados', () => {
  const r = core.normalizeRecord({ tipo: 'Conversión', concepto: 'venta', monto: 1000, moneda: 'USDT', convierte: { moneda: 'BTC', monto: 0.01234 } });
  assert.deepStrictEqual(core.aplicarMovimiento(r), [
    { moneda: 'BTC', signo: -1, monto: 0.01234 },
    { moneda: 'USDT', signo: 1, monto: 1000 },
  ]);
});

console.log('core: la conversión no altera el total en Bs');
t('bsValue de una conversión es 0', () => {
  const r = core.normalizeRecord({ tipo: 'Conversión', concepto: 'swap', monto: 0.01234, moneda: 'BTC', convierte: { moneda: 'USDT', monto: 1000 }, tasaDia: 857 });
  assert.strictEqual(core.bsValue(r, 857), 0);
});
t('convertir 1000 USDT a BTC deja el total en Bs intacto', () => {
  const r = core.normalizeRecord({ tipo: 'Conversión', concepto: 'swap', monto: 0.01234, moneda: 'BTC', convierte: { moneda: 'USDT', monto: 1000 }, tasaDia: 857 });
  // Suma de los Bs de una compra de 1000 USDT y los de la conversión que la originó.
  const compra = core.bsValue(core.normalizeRecord({ tipo: 'Egreso', concepto: 'usdt', monto: 1000, moneda: 'USDT', tasaDia: 857 }), 857);
  assert.strictEqual(compra + core.bsValue(r, 857), compra);
});
t('precioUnitario devuelve null si no es conversión', () => {
  assert.strictEqual(core.precioUnitario({ tipo: 'Ingreso', moneda: 'BTC', monto: 1 }), null);
});

console.log('core: holdings (cartera por exchange)');
// Historia: vendo Bs y recibo 1000 USDT en Binance, convierto 800 a BTC ahí mismo,
// compro 500 USDT en Bybit y retiro Bs del banco.
const carteraRecords = [
  core.normalizeRecord({ fecha: '2026-09-01', tipo: 'Ingreso', concepto: 'vendo Bs, recibo USDT', monto: 1000, moneda: 'USDT', exchange: 'Binance' }),
  core.normalizeRecord({ fecha: '2026-09-02', tipo: 'Conversión', concepto: 'swap a BTC', monto: 0.01, moneda: 'BTC', convierte: { moneda: 'USDT', monto: 800 }, exchange: 'Binance' }),
  core.normalizeRecord({ fecha: '2026-09-03', tipo: 'Ingreso', concepto: 'vendo Bs, recibo USDT', monto: 500, moneda: 'USDT', exchange: 'Bybit' }),
  core.normalizeRecord({ fecha: '2026-09-04', tipo: 'Egreso', concepto: 'retiro a banco', monto: 200, moneda: 'Bs', exchange: 'Ninguno' }),
];
t('el swap deja USDT y BTC dentro del mismo exchange', () => {
  const h = core.holdings(carteraRecords);
  assert.strictEqual(h.porExchange.Binance.USDT, 200);
  assert.strictEqual(h.porExchange.Binance.BTC, 0.01);
  assert.strictEqual(h.porExchange.Bybit.USDT, 500);
});
t('exchange = Ninguno agrupa lo que no está en una plataforma', () => {
  const h = core.holdings(carteraRecords);
  assert.strictEqual(h.porExchange.Ninguno.Bs, -200);
});
t('los totales suman todos los exchanges', () => {
  const h = core.holdings(carteraRecords);
  assert.strictEqual(h.total.USDT, 700);
  assert.strictEqual(h.total.BTC, 0.01);
  assert.strictEqual(h.total.Bs, -200);
});
t('holdings de una lista vacía no explota', () => {
  const h = core.holdings([]);
  assert.deepStrictEqual(h.total, { BTC: 0, USDT: 0, USD: 0, Bs: 0 });
  assert.deepStrictEqual(h.porExchange, {});
});

console.log('core: precioBtc y valorBsSaldo');
t('precioBtc toma la última conversión con BTC', () => {
  const p = core.precioBtc(carteraRecords, 0);
  assert.strictEqual(p.valor, 80000);
  assert.strictEqual(p.moneda, 'USDT');
});
t('precioBtc usa precioCompra si no hay conversiones', () => {
  const p = core.precioBtc([core.normalizeRecord({ fecha: '2026-09-01', tipo: 'Egreso', concepto: 'btc', monto: 0.01, moneda: 'BTC', precioCompra: 75000 })], 0);
  assert.strictEqual(p.valor, 75000);
});
t('precioBtc manual tiene prioridad', () => {
  assert.strictEqual(core.precioBtc(carteraRecords, 99000).valor, 99000);
});
t('precioBtc es null si nunca registró un precio', () => {
  assert.strictEqual(core.precioBtc([core.normalizeRecord({ tipo: 'Egreso', concepto: 'x', monto: 1, moneda: 'BTC' })], 0), null);
});
t('valorBsSaldo convierte USDT, USD y BTC a Bs', () => {
  const h = core.holdings(carteraRecords);
  const bs = core.valorBsSaldo(h.total, 800, { valor: 80000, moneda: 'USDT' });
  // 700 USDT + 0,01 BTC (800 USD) + (-200 Bs), todo a 800 Bs por USD:
  // 560000 + 640000 - 200
  assert.strictEqual(bs, 1199800);
});
t('valorBsSaldo con el precio de BTC ya en Bs no vuelve a multiplicar', () => {
  const s = { BTC: 0.01, USDT: 0, USD: 0, Bs: 0 };
  // 0,01 BTC a 8.000.000 Bs la unidad = 80.000 Bs, sin aplicar la tasa otra vez.
  assert.strictEqual(core.valorBsSaldo(s, 800, { valor: 8000000, moneda: 'Bs' }), 80000);
});
t('valorBsSaldo sin tasa devuelve null', () => {
  assert.strictEqual(core.valorBsSaldo(core.saldoVacio(), 0, null), null);
});
t('valorBsSaldo con BTC pero sin precio devuelve null', () => {
  const s = { BTC: 0.01, USDT: 0, USD: 0, Bs: 0 };
  assert.strictEqual(core.valorBsSaldo(s, 800, null), null);
});

console.log('core: CSV de conversiones');
t('el CSV incluye la moneda entregada y el precio', () => {
  const csv = core.buildCsv(
    [core.normalizeRecord({ fecha: '2026-09-05', tipo: 'Conversión', concepto: 'swap', monto: 0.01, moneda: 'BTC', convierte: { moneda: 'USDT', monto: 800 }, exchange: 'Binance' })],
    () => ''
  );
  const head = csv.split('\r\n')[0];
  assert.ok(head.includes('Moneda entregada'), 'header sin Moneda entregada');
  assert.ok(head.includes('Precio unitario'), 'header sin Precio unitario');
  assert.ok(csv.includes('2026-09-05;Conversión;swap'), 'tipo Conversión mal escrito');
  assert.ok(csv.includes('USDT;800;80000'), 'lado entregado incompleto');
});
t('un ingreso normal no llena las columnas de conversión', () => {
  const csv = core.buildCsv([core.normalizeRecord({ fecha: '2026-09-05', tipo: 'Ingreso', concepto: 'venta', monto: 100, moneda: 'Bs' })], () => '');
  const cols = csv.split('\r\n')[1].split(';');
  assert.strictEqual(cols.length, 16, 'cantidad de columnas: ' + cols.length);
  // 10 = Moneda entregada, 11 = Monto entregado, 12 = Precio unitario
  assert.strictEqual(cols[10], '', 'Moneda entregada debería quedar vacía');
  assert.strictEqual(cols[11], '', 'Monto entregado debería quedar vacío');
  assert.strictEqual(cols[12], '', 'Precio unitario debería quedar vacío');
  assert.strictEqual(cols[13], 'Ninguno');
});

/* ============================== Tasa BCV ============================== */
console.log('mercado: BCV y DolarAPI');
// Fragmento real de la portada del BCV (id="dolar" + "Fecha Valor:").
const HTML_BCV = `
  <div id="dolar" class="col-sm-12 col-xs-12 ">
    <div class="field-content"><div class="row recuadrotsmc">
      <div class="col-sm-6 col-xs-6"><img src="/sites/default/files/dollar-04_2.png"><span> USD</span></div>
      <div class="col-sm-6 col-xs-6 centrado textp"> <strong class="strong-tb">857,00580000</strong>  </div>
    </div></div>
  </div>
  <div class="pull-right dinpro center">
    Fecha Valor: <span class="date-display-single" content="2026-09-28T00:00:00-04:00">Lunes, 28 Septiembre 2026</span><hr>
  </div>`;
t('parseBcvHtml saca valor y fecha', () => {
  assert.deepStrictEqual(mercado.parseBcvHtml(HTML_BCV), { valor: 857.0058, fecha: '2026-09-28', fuente: 'BCV' });
});
t('parseBcvHtml acepta decimal con punto', () => {
  assert.strictEqual(mercado.parseBcvHtml('<div id="dolar"><strong class="strong-tb">36.50</strong></div>').valor, 36.5);
});
t('parseBcvHtml con milesSeparados', () => {
  assert.strictEqual(mercado.parseBcvHtml('<div id="dolar"><strong class="strong-tb">1.234,56</strong></div>').valor, 1234.56);
});
t('parseBcvHtml devuelve null si no está el bloque del dólar', () => {
  assert.strictEqual(mercado.parseBcvHtml('<html><body>cae el sistema</body></html>'), null);
});
t('parseBcvHtml devuelve null con html vacío', () => {
  assert.strictEqual(mercado.parseBcvHtml(''), null);
});
t('parseDolarApi lee promedio, fecha, nombre y moneda', () => {
  const body = JSON.stringify({ moneda: 'USD', fuente: 'oficial', nombre: 'Dólar', promedio: 855.6625, fechaActualizacion: '2026-09-25T00:00:00-04:00' });
  assert.deepStrictEqual(mercado.parseDolarApi(body), {
    valor: 855.6625, fecha: '2026-09-25', fuente: 'DolarAPI', nombre: 'Dólar', moneda: 'USD',
  });
});
t('parseDolarApi acepta el objeto ya parseado', () => {
  assert.strictEqual(mercado.parseDolarApi({ promedio: 900, fechaActualizacion: '2026-09-26T10:00:00Z' }).valor, 900);
});
t('parseDolarApi con json inválido devuelve null', () => {
  assert.strictEqual(mercado.parseDolarApi('no es json'), null);
});
t('parseDolarApi sin tasa devuelve null', () => {
  assert.strictEqual(mercado.parseDolarApi(JSON.stringify({ moneda: 'USD' })), null);
});
t('parseEsNum limpia basura', () => {
  assert.strictEqual(mercado.parseEsNum(' 857,00580000 '), 857.0058);
  assert.strictEqual(mercado.parseEsNum('1.234,56'), 1234.56);
  assert.strictEqual(mercado.parseEsNum('abc'), null);
  assert.strictEqual(mercado.parseEsNum('0'), null);
});
t('tasaDeFecha toma la exacta del historial', () => {
  const hist = [{ fecha: '2026-09-25', valor: 855.66 }, { fecha: '2026-09-28', valor: 857.01 }];
  assert.strictEqual(mercado.tasaDeFecha(hist, '2026-09-28'), 857.01);
});
t('tasaDeFecha cae a la tasa vigente si no hay entrada para ese día', () => {
  const hist = [{ fecha: '2026-09-25', valor: 855.66 }, { fecha: '2026-09-28', valor: 857.01 }];
  assert.strictEqual(mercado.tasaDeFecha(hist, '2026-09-26'), 855.66);
});
t('tasaDeFecha nunca usa una tasa futura', () => {
  const hist = [{ fecha: '2026-09-28', valor: 857.01 }];
  assert.strictEqual(mercado.tasaDeFecha(hist, '2026-09-20'), null);
});
t('tasaDeFecha con historial vacío devuelve null', () => {
  assert.strictEqual(mercado.tasaDeFecha([], '2026-09-28'), null);
  assert.strictEqual(mercado.tasaDeFecha(null, '2026-09-28'), null);
});


/* ============================== Mercado ============================== */
console.log('mercado: DolarAPI lista');
// Respuesta real de https://ve.dolarapi.com/v1/euros
const JSON_EUROS = JSON.stringify([
  { moneda: 'EUR', fuente: 'oficial', nombre: 'Euro', compra: null, venta: null, promedio: 972.648677, fechaActualizacion: '2026-09-25T00:00:00-04:00' },
  { moneda: 'EUR', fuente: 'paralelo', nombre: 'Paralelo', compra: null, venta: null, promedio: 1074.366748, fechaActualizacion: '2026-09-27T04:01:57.900Z' },
]);
// Respuesta real de /v1/dolares/paralelo (objeto suelto)
const JSON_PARALELO = JSON.stringify({ moneda: 'USD', fuente: 'paralelo', nombre: 'Paralelo', compra: null, venta: null, promedio: 943.891353, fechaActualizacion: '2026-09-27T04:01:57.888Z' });

t('parseDolarApiLista lee la lista de euros', () => {
  const l = mercado.parseDolarApiLista(JSON_EUROS);
  assert.strictEqual(l.length, 2);
  assert.strictEqual(l[0].valor, 972.648677);
  assert.strictEqual(l[0].fecha, '2026-09-25');
  assert.strictEqual(l[1].valor, 1074.366748);
  assert.strictEqual(l[1].nombre, 'Paralelo');
});
t('parseDolarApiLista acepta un objeto suelto', () => {
  const l = mercado.parseDolarApiLista(JSON_PARALELO);
  assert.strictEqual(l.length, 1);
  assert.strictEqual(l[0].valor, 943.891353);
  assert.strictEqual(l[0].fecha, '2026-09-27');
});
t('parseDolarApiLista con json inválido devuelve null', () => {
  assert.strictEqual(mercado.parseDolarApiLista('no es json'), null);
});
t('parseDolarApiLista sin promedio utilizable devuelve null', () => {
  assert.strictEqual(mercado.parseDolarApiLista(JSON.stringify([{ moneda: 'EUR' }])), null);
  assert.strictEqual(mercado.parseDolarApiLista(JSON.stringify([])), null);
});
t('parseDolarApi (objeto) sigue funcionando', () => {
  assert.strictEqual(mercado.parseDolarApi(JSON_PARALELO).valor, 943.891353);
  assert.strictEqual(mercado.parseDolarApi('nope'), null);
});
t('isoFecha descarta fechas invalidas', () => {
  assert.strictEqual(mercado.isoFecha('2026-09-25T10:00:00-04:00'), '2026-09-25');
  assert.strictEqual(mercado.isoFecha('ayer'), null);
  assert.strictEqual(mercado.isoFecha(''), null);
});
t('buscarFuente encuentra por nombre', () => {
  const l = mercado.parseDolarApiLista(JSON_EUROS);
  assert.strictEqual(mercado.buscarFuente(l, 'euro').valor, 972.648677);
  assert.strictEqual(mercado.buscarFuente(l, 'paralelo').valor, 1074.366748);
  assert.strictEqual(mercado.buscarFuente(l, 'bitcoin'), null);
  assert.strictEqual(mercado.buscarFuente(null, 'euro'), null);
});

console.log('mercado: combinar y calcular');
t('combinarMercado cuenta las disponibles', () => {
  const m = mercado.combinarMercado({
    bcv: { valor: 857.0058 },
    paralelo: { valor: 943.89 },
    euroOficial: null,
    euroParalelo: null,
  });
  assert.strictEqual(m.disponible, 2);
  assert.strictEqual(m.euroOficial, null);
  assert.ok(m.consultadasEn > 0);
});
t('combinarMercado con todo null no revienta', () => {
  const m = mercado.combinarMercado({});
  assert.strictEqual(m.disponible, 0);
  assert.strictEqual(m.bcv, null);
});
t('diferenciaPct: el paralelo esta ~10% sobre el BCV', () => {
  assert.strictEqual(mercado.diferenciaPct(943.89, 857.0058), 10.1);
});
t('diferenciaPct con la misma tasa da 0', () => {
  assert.strictEqual(mercado.diferenciaPct(857.0058, 857.0058), 0);
});
t('diferenciaPct puede ser negativa', () => {
  assert.strictEqual(mercado.diferenciaPct(800, 857), -6.7);
});
t('diferenciaPct sin referencia devuelve null', () => {
  assert.strictEqual(mercado.diferenciaPct(100, 0), null);
  assert.strictEqual(mercado.diferenciaPct(0, 100), null);
  assert.strictEqual(mercado.diferenciaPct(null, 100), null);
});
t('convertir multiplica y redondea a 2 decimales', () => {
  assert.strictEqual(mercado.convertir(100, 857.0058), 85700.58);
  assert.strictEqual(mercado.convertir(1, 857.0058), 857.01);
  assert.strictEqual(mercado.convertir(10, 0.125), 1.25);
});
t('convertir devuelve null si falta la tasa o el monto no es numero', () => {
  assert.strictEqual(mercado.convertir(100, 0), null);
  assert.strictEqual(mercado.convertir('abc', 857), null);
  assert.strictEqual(mercado.convertir(null, 857), null);
});
t('convertir con monto 0 devuelve 0 (la UI lo filtra antes)', () => {
  assert.strictEqual(mercado.convertir(0, 857), 0);
});
t('convertidor al revés: Bs a divisa', () => {
  assert.strictEqual(mercado.convertir(85700.58, 1 / 857.0058), 100);
});

console.log('\n' + passed + ' pruebas pasaron ✔');