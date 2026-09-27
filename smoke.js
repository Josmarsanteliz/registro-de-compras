'use strict';

// Smoke test end-to-end de la app Electron (ventana oculta).
// Ejecutar: node_modules\.bin\electron.cmd smoke.js
const path = require('path');
const fs = require('fs');

// Modo prueba: main.js no crea ventana propia cuando este flag está presente.
process.env.REGISTRO_SMOKE = '1';

// Arranque 100% limpio: borra datos residuales ANTES de cargar main.js.
const DATA_DIR = path.join(__dirname, 'datos');
fs.rmSync(DATA_DIR, { recursive: true, force: true });

const { app, BrowserWindow } = require('electron');

// Carga main.js para registrar los handlers IPC (sin crear la ventana real).
require('./main.js');

app.whenReady().then(async () => {
  let win;
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.webContents.on('console-message', (event) => {
      if (event.level === 'error') console.log('[renderer:' + event.level + '] ' + event.message);
    });
    await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

    const ui = await win.webContents.executeJavaScript(`(async () => {
      const out = { steps: [] };
      const ok = (name, cond) => { out.steps.push(name + ': ' + (cond ? 'ok' : 'FALLO')); return cond; };
      const run = async (name, fn) => {
        try { await fn(); out.steps.push(name + ': ok'); }
        catch (e) { out.steps.push(name + ': EXCEPTION ' + e.message); }
      };
      window.confirm = () => true;
      const $ = (s) => document.querySelector(s);
      const $$ = (s) => Array.from(document.querySelectorAll(s));
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));

      // 0) La app abre directo (sin pantalla de PIN)
      await sleep(200);
      ok('no-pin-screen', !document.getElementById('screen-pin'));
      ok('app-visible', !$('#screen-app').classList.contains('hidden'));
      ok('tabs-9', $('#tabs').children.length === 9);
      ok('empty-state', !$('#empty').classList.contains('hidden'));
      const pre = await window.api.getRecords();
      out.initialRecords = pre.records.map(function (r) { return r.moneda + '/' + r.tipo + '/' + r.concepto; });

      // 1) Crear registro USDT
      await run('1-create-usdt', async () => {
        $('#btn-new').click();
        $('#f-concepto').value = 'Compra USDT p2p';
        $('#f-monto').value = 100;
        $('#f-moneda').value = 'USDT';
        $('#f-tasa').value = 36.5;
        $('#f-exchange-form').value = 'Binance';
        $('#record-form').dispatchEvent(new Event('submit', { cancelable: true }));
        await sleep(200);
      });
      ok('rows-after-first', $$('#tbody tr').length === 1);

      // 2) Crear registro BTC con origen USDT (cadena)
      await run('2-create-btc', async () => {
        $('#btn-new').click();
        $('#f-concepto').value = 'Compra BTC spot';
        $('#f-monto').value = 0.001;
        $('#f-moneda').value = 'BTC';
        $('#f-precio').value = 60000;
        $('#f-spot').checked = true;
        const recs = await window.api.getRecords();
        const first = recs.records.find(r => r.moneda === 'USDT');
        $('#f-origen').value = first ? first.id : '';
        $('#record-form').dispatchEvent(new Event('submit', { cancelable: true }));
        await sleep(200);
      });
      ok('rows-after-second', $$('#tbody tr').length === 2);
      out.chainBadges = $$('#tbody .chain-badge').length;

      // 3) Detalle: cadena de 2 chips
      await run('3-detail', async () => {
        const rows = $$('#tbody tr');
        if (rows[0]) rows[0].click();
        await sleep(60);
        out.detailChips = $$('#detail-body .chip').length;
        $('#detail-close').click();
      });

      // 4) Pestaña BTC
      await run('4-tab-btc', async () => {
        const tab = $('#tabs .tab[data-tab="BTC"]');
        if (tab) tab.click();
        await sleep(60);
        out.btcRows = $$('#tbody tr').length;
        const todo = $('#tabs .tab[data-tab="Todo"]');
        if (todo) todo.click();
        await sleep(60);
      });

      // 5) Editar primer registro
      await run('5-edit', async () => {
        const firstRow = $('#tbody tr[data-id]');
        out.firstId = firstRow ? firstRow.dataset.id : null;
        if (firstRow) firstRow.querySelector('[data-act="edit"]').click();
        $('#f-concepto').value = 'Compra USDT p2p (editada)';
        $('#record-form').dispatchEvent(new Event('submit', { cancelable: true }));
        await sleep(200);
      });
      ok('edited', (document.querySelector('#tbody tr[data-id] td:nth-child(2)') || {}).innerText.includes('editada'));

      // 6) Eliminar el registro que NO es el primero (queda 1)
      await run('6-delete', async () => {
        const btcRow = $$('#tbody tr').find(tr => tr.dataset.id !== out.firstId);
        if (btcRow) btcRow.querySelector('[data-act="del"]').click();
        await sleep(200);
      });
      ok('rows-after-delete', $$('#tbody tr').length === 1);

      // 7) Crear un registro INGRESO (Bs +500)
      await run('7-create-ingreso', async () => {
        $('#btn-new').click();
        const radioIng = document.querySelector('input[name="tipo"][value="Ingreso"]');
        if (radioIng) radioIng.checked = true;
        $('#f-concepto').value = 'Venta de USD (ingreso)';
        $('#f-monto').value = 500;
        $('#f-moneda').value = 'Bs';
        $('#f-categoria').value = 'crypto';
        $('#record-form').dispatchEvent(new Event('submit', { cancelable: true }));
        await sleep(200);
      });
      ok('rows-after-ingreso', $$('#tbody tr').length === 2);

      // 7b) Conversión: 50 USDT -> 0,0005 BTC. No debe alterar el total en Bs.
      await run('7b-conversion', async () => {
        $('#btn-new').click();
        await sleep(80);
        const radioConv = document.querySelector('input[name="tipo"][value="Conversión"]');
        if (radioConv) {
          radioConv.checked = true;
          radioConv.dispatchEvent(new Event('change', { bubbles: true }));
        }
        await sleep(80);
        out.convFieldsVisible = !$('#conv-fields').classList.contains('hidden');
        $('#f-concepto').value = 'Swap USDT a BTC';
        $('#f-moneda').value = 'BTC';
        $('#f-monto').value = 0.0005;
        $('#f-conv-moneda').value = 'USDT';
        $('#f-conv-monto').value = 50;
        $('#f-conv-monto').dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(80);
        out.convPrecio = ($('#f-conv-precio') || {}).value || '';
        out.convCalc = ($('#conv-calc') || {}).textContent || '';
        $('#f-exchange-form').value = 'Binance';
        const recs = await window.api.getRecords();
        const usdt = recs.records.find((r) => r.moneda === 'USDT' && r.tipo === 'Egreso');
        $('#f-origen').value = usdt ? usdt.id : '';
        $('#record-form').dispatchEvent(new Event('submit', { cancelable: true }));
        await sleep(250);
        out.convFormError = (($('#form-error') || {}).textContent || '').trim();
        out.convFormErrorHidden = $('#form-error').classList.contains('hidden');
      });
      ok('conv-fields-visible', out.convFieldsVisible === true);
      ok('conv-precio-auto', String(out.convPrecio) === '100000');
      ok('conv-row-created', $$('#tbody tr').length === 3);

      const convRecs = await window.api.getRecords();
      const laConv = convRecs.records.find((r) => r.tipo === 'Conversión');
      out.convTipoOk = !!laConv;
      out.convLados = laConv ? laConv.convierte.moneda + '/' + laConv.convierte.monto + '->' + laConv.moneda + '/' + laConv.monto : '';
      ok('conv-guardada', out.convTipoOk === true);
      ok('conv-lados', out.convLados === 'USDT/50->BTC/0.0005');

      // 8) Calendario: cuadrícula + marcadores + notas del día
      await run('8-calendar', async () => {
        const tab = $('#tabs .tab[data-tab="Calendario"]');
        if (tab) tab.click();
        await sleep(100);
        const calEl = $('#view-calendar');
        const calRect = calEl.getBoundingClientRect();
        out.calVisible = !calEl.classList.contains('hidden') && calRect.height > 0;
        out.calOnScreen = calRect.top >= 0 && calRect.top < window.innerHeight && calRect.bottom > 0;
        out.tableHiddenOnCal = document.querySelector('.table-wrap').classList.contains('hidden');
        out.calCells = $$('#cal-grid .cal-cell').length;
        out.calHas = $$('#cal-grid .cal-cell.has').length;
        out.calDays = $$('#cal-notes .cal-day').length;
        out.calNotes = $$('.cal-day-list .note').length;
        out.calTitle = $('#cal-title').textContent;
        const cell = document.querySelector('#cal-grid .cal-cell.has');
        if (cell) {
          cell.click();
          await sleep(80);
          out.jumpVisible = !$('#cal-jump').classList.contains('hidden');
        }
        const todo = $('#tabs .tab[data-tab="Todo"]');
        if (todo) todo.click();
        await sleep(80);
      });
      ok('cal-visible', out.calVisible === true);
      ok('cal-has-days', out.calHas >= 1 && out.calDays >= 1 && out.calNotes >= 2);

      // 9) Totales NETOS (Bs ingreso +500 debe verse con signo, y la conversión no debe alterarlo)
      await run('9-totals-net', async () => {
        const bsCard = document.querySelector('.total-card.bs .val');
        out.bsNet = bsCard ? bsCard.textContent : null;
        const usdtCard = document.querySelector('.total-card.usdt .val');
        out.usdtNet = usdtCard ? usdtCard.textContent : null;
        const btcCard = document.querySelector('.total-card.btc .val');
        out.btcNet = btcCard ? btcCard.textContent : null;
        const totSub = document.querySelector('.total-card.tot .sub');
        out.totSub = totSub ? totSub.textContent : '';
      });
      ok('bs-net-pos', typeof out.bsNet === 'string' && out.bsNet.includes('+500'));
      // El único movimiento USDT que queda es la conversión: descuenta los 50 entregados.
      ok('usdt-net-conversion', typeof out.usdtNet === 'string' && out.usdtNet.includes('50'));
      ok('btc-net-conversion', typeof out.btcNet === 'string' && out.btcNet.includes('0'));
      ok('bs-card-dice-conversiones', /conversi/i.test(out.totSub));

      // 9b) Pestaña Cartera: saldo por exchange
      await run('9b-cartera', async () => {
        const tab = $('#tabs .tab[data-tab="Cartera"]');
        if (tab) tab.click();
        await sleep(120);
        const v = $('#view-cartera');
        out.carteraVisible = !v.classList.contains('hidden') && v.getBoundingClientRect().height > 0;
        out.carteraCards = $$('#cartera-grid .cartera-card').length;
        out.carteraNewHidden = $('#btn-new').classList.contains('hidden');
        const binance = $$('#cartera-grid .cartera-card').find((c) => c.dataset.exchange === 'Binance');
        const saldo = (m) => {
          const el = binance && binance.querySelector('[data-saldo="' + m + '"] .saldo-val');
          return el ? el.textContent.trim() : null;
        };
        out.binanceUsdt = saldo('USDT');
        out.binanceBtc = saldo('BTC');
        out.verBtn = $$('#cartera-grid [data-ver-exchange]').length;
        // "Ver movimientos" debe filtrar la tabla
        if (binance) {
          const btn = binance.querySelector('[data-ver-exchange]');
          if (btn) btn.click();
          await sleep(120);
          out.carteraFiltrada = $('#f-exchange').value;
          const todo = $('#tabs .tab[data-tab="Todo"]');
          if (todo) todo.click();
          await sleep(60);
        }
      });
      ok('cartera-visible', out.carteraVisible === true);
      ok('cartera-cards', out.carteraCards >= 1);
      ok('cartera-new-hidden', out.carteraNewHidden === true);
      ok('cartera-ver-movimientos', out.verBtn >= 1);
      ok('cartera-filtro', out.carteraFiltrada === 'Binance');
      // Binance: -150 USDT y +0,0005 BTC
      ok('cartera-binance-usdt', /150/.test(out.binanceText));
      ok('cartera-binance-btc', /0,0005/.test(out.binanceText));

      // 9c) Tasa BCV: los handlers responden (si falla la red solo se guarda el error)
      await run('9c-tasa-bcv', async () => {
        const r = await window.api.getTasa();
        out.tasaHandlerOk = r.ok === true && Array.isArray(r.historial);
        out.tasaFuente = r.settings ? r.settings.tasaFuente : null;
        const s = await window.api.saveSettings({ tasaReferencia: 40, tasaFuente: 'Manual' });
        const g = await window.api.getSettings();
        out.settingsFuente = s.ok && g.settings.tasaFuente === 'Manual';
        await window.api.saveSettings({ tasaReferencia: 40, tasaFuente: 'BCV' });
      });
      ok('tasa-handler', out.tasaHandlerOk === true);
      ok('tasa-fuente-manual', out.settingsFuente === true);

      // 10) Tasa de referencia
      await run('10-settings', async () => {
        const s = await window.api.saveSettings({ tasaReferencia: 40 });
        const g = await window.api.getSettings();
        out.settings = s.ok && g.settings.tasaReferencia === 40;
      });

      // 11) Préstamos: crear 60$ al 10% en 14 días
      await run('11-loan-create', async () => {
        const tab = $('#tabs .tab[data-tab="Préstamos"]');
        if (tab) tab.click();
        await sleep(100);
        out.loansView = !$('#view-loans').classList.contains('hidden');
        out.newBtnLabel = $('#btn-new').textContent;
        $('#btn-new').click();
        await sleep(60);
        $('#l-monto').value = 60;
        $('#l-monto').dispatchEvent(new Event('input', { bubbles: true }));
        $('#l-fecha').dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(50);
        out.calcText = ($('#loan-calc') || {}).textContent || '';
        $('#loan-form').dispatchEvent(new Event('submit', { cancelable: true }));
        await sleep(250);
      });
      ok('loans-view', out.loansView === true);
      ok('new-btn-loan', String(out.newBtnLabel).includes('préstamo'));
      ok('loan-calc-66', out.calcText.includes('66'));
      ok('loan-row-created', $$('#loan-tbody tr').length === 1);

      const loanRecs = await window.api.getRecords();
      out.loanIngresoOk = loanRecs.records.some((r) => r.moneda === 'USD' && r.tipo === 'Ingreso' && r.monto === 60);
      const loanList = await window.api.getLoans();
      out.loanFechaVenc = loanList.loans[0] ? loanList.loans[0].fechaVenc : null;
      ok('loan-ingreso-linked', out.loanIngresoOk === true);

      // 12) El vencimiento se marca en el calendario (ir al mes que corresponde)
      await run('12-loan-calendar', async () => {
        if (!out.loanFechaVenc) return;
        const y = Number(out.loanFechaVenc.slice(0, 4));
        const m = Number(out.loanFechaVenc.slice(5, 7));
        const want = new Date(y, m - 1, 1).toLocaleDateString('es-ES', { month: 'long', year: 'numeric' }).toLowerCase();
        const tab = $('#tabs .tab[data-tab="Calendario"]');
        if (tab) tab.click();
        await sleep(80);
        for (let i = 0; i < 14 && $('#cal-title').textContent.toLowerCase() !== want; i++) {
          $('#cal-next').click();
          await sleep(30);
        }
        for (let i = 0; i < 28 && $('#cal-title').textContent.toLowerCase() !== want; i++) {
          $('#cal-prev').click();
          await sleep(30);
        }
        out.loanMarkerText = ($('#cal-title').textContent.toLowerCase() === want)
          ? (($$('#cal-grid .m.loan')[0] || {}).textContent || '')
          : '';
        out.loanNoteLines = $$('.cal-day-list .note.loan').length;
        const todo = $('#tabs .tab[data-tab="Todo"]');
        if (todo) todo.click();
        await sleep(60);
      });
      ok('loan-cal-marker', out.loanMarkerText.includes('\u{1F3E6}'));
      ok('loan-cal-note', out.loanNoteLines >= 1);

      // 13) Marcar el préstamo como pagado -> crea Egreso de 66$
      await run('13-loan-pay', async () => {
        const tab = $('#tabs .tab[data-tab="Préstamos"]');
        if (tab) tab.click();
        await sleep(80);
        const payBtn = document.querySelector('#loan-tbody [data-lact="pay"]');
        if (payBtn) payBtn.click();
        await sleep(250);
      });
      const afterPay = await window.api.getRecords();
      out.loanEgresoOk = afterPay.records.some((r) => r.moneda === 'USD' && r.tipo === 'Egreso' && r.monto === 66);
      ok('loan-egreso-created', out.loanEgresoOk === true);
      out.loanBadgeText = ($('#loan-tbody .loan-badge') || {}).textContent || '';
      ok('loan-badge-paid', out.loanBadgeText.includes('Pagado'));

      // 13b) Pestaña Tasas: tarjetas, convertidor e historial.
      // Se usa el botón "Actualizar ahora" de la app, que es el camino real del usuario.
      await run('13b-tasas', async () => {
        const tab = $('#tabs .tab[data-tab="Tasas"]');
        if (tab) tab.click();
        await sleep(150);
        const v = $('#view-tasas');
        out.tasasVisible = !v.classList.contains('hidden') && v.getBoundingClientRect().height > 0;

        // La consulta de red puede tardar: se espera a que el botón se vuelva a habilitar.
        const btn = $('#mercado-refresh');
        btn.click();
        for (let i = 0; i < 60 && btn.disabled; i++) await sleep(500);
        await sleep(250);

        out.mercadoHandlerOk = ((await window.api.getMercado()) || {}).ok === true;
        out.mercadoCards = $$('#mercado-actual .mercado-card').length;
        out.mercadoConValor = $$('#mercado-actual .mercado-card .mc-valor b').length;
        out.cvOpciones = $$('#cv-tasa option').length;
        out.histFilas = $$('#mercado-historial tbody tr').length;
        out.estadoVacio = $$('#mercado-actual .cal-empty').length;
        out.mercadoOnline = out.mercadoConValor > 0;

        out.cvResultado = '';
        out.cvInvertido = '';
        if (out.mercadoOnline) {
          // El valor esperado sale de la propia tarjeta del BCV, para no depender de la red.
          const valorTxt = $$('#mercado-actual .mercado-card .mc-valor b')[0].textContent.replace(/\\D/g, '');
          out.cvEsperado = valorTxt;
          $('#cv-monto').value = 100;
          $('#cv-tasa').value = 'bcv';
          $('#cv-monto').dispatchEvent(new Event('input', { bubbles: true }));
          $('#cv-tasa').dispatchEvent(new Event('change', { bubbles: true }));
          await sleep(120);
          out.cvResultado = ($('#cv-resultado') || {}).textContent || '';
          // La direccion ahora se cambia con el boton, no con una casilla.
          $('#cv-cambiar').click();
          await sleep(120);
          out.cvInvertido = ($('#cv-resultado') || {}).textContent || '';
          $('#cv-cambiar').click();
          await sleep(80);
        }

        ok('mercado-handler', out.mercadoHandlerOk === true);
        ok('tasas-visible', out.tasasVisible === true);

        if (out.mercadoOnline) {
          // Filtro por moneda: EUR deja 2 tarjetas, USD deja 2, Todas deja 4.
          out.filtroTodas = $$('#mercado-actual .mercado-card').length;
          $('#mercado-filtro .chip-btn[data-filtro="EUR"]').click();
          await sleep(120);
          out.filtroEur = $$('#mercado-actual .mercado-card').length;
          out.filtroEurActivo = $$('#mercado-filtro .chip-btn.active').length;
          out.filtroEurTexto = ($$('#mercado-filtro .chip-btn.active')[0] || {}).textContent || '';
          $('#mercado-filtro .chip-btn[data-filtro="USD"]').click();
          await sleep(120);
          out.filtroUsd = $$('#mercado-actual .mercado-card').length;
          $('#mercado-filtro .chip-btn[data-filtro="todas"]').click();
          await sleep(120);
          out.filtroVuelta = $$('#mercado-actual .mercado-card').length;

          // Boton de direccion: el texto y las unidades tienen que cambiar.
          $('#cv-monto').value = 1000;
          $('#cv-tasa').value = 'bcv';
          $('#cv-monto').dispatchEvent(new Event('input', { bubbles: true }));
          $('#cv-tasa').dispatchEvent(new Event('change', { bubbles: true }));
          await sleep(120);
          out.dirAntes = ($('#cv-cambiar') || {}).textContent || '';
          out.unidadAntes = ($('#cv-unidad') || {}).textContent || '';
          out.prefijoAntes = ($('#cv-prefijo') || {}).textContent || '';
          out.resAntes = ($('#cv-resultado') || {}).textContent || '';

          $('#cv-cambiar').click();
          await sleep(120);
          out.dirDespues = ($('#cv-cambiar') || {}).textContent || '';
          out.unidadDespues = ($('#cv-unidad') || {}).textContent || '';
          out.prefijoDespues = ($('#cv-prefijo') || {}).textContent || '';
          out.resDespues = ($('#cv-resultado') || {}).textContent || '';
          $('#cv-cambiar').click();
          await sleep(80);

          // Clic en una tarjeta: usa esa tasa en el convertidor.
          const tarjetaPar = document.querySelector('#mercado-actual [data-usar-tasa="paralelo"]');
          if (tarjetaPar) tarjetaPar.click();
          await sleep(120);
          out.tasaTrasClic = $('#cv-tasa').value;
        }
        if (out.mercadoOnline) {
          ok('tasas-4-tarjetas', out.mercadoCards === 4);
          ok('tasas-convertidor-opciones', out.cvOpciones >= 1);
          // 100 USD al BCV debe empezar por el mismo prefijo que el valor de la tarjeta (x100).
          ok('tasas-conversion-100usd', out.cvResultado.replace(/\\D/g, '').startsWith(out.cvEsperado));
          ok('tasas-conversion-invertida', /USD/.test(out.cvInvertido));
          ok('tasas-historial', out.histFilas >= 1);
          ok('filtro-todas-4', out.filtroTodas === 4);
          ok('filtro-eur-2', out.filtroEur === 2);
          ok('filtro-usd-2', out.filtroUsd === 2);
          ok('filtro-vuelta-4', out.filtroVuelta === 4);
          ok('filtro-chip-activo', out.filtroEurActivo === 1 && out.filtroEurTexto.trim() === 'EUR');
          ok('direccion-cambia-texto', out.dirAntes !== out.dirDespues && /Bs/.test(out.dirDespues));
          ok('direccion-cambia-unidad', out.unidadAntes === 'USD' && out.unidadDespues === 'Bs');
          ok('direccion-cambia-prefijo', out.prefijoAntes.trim() === 'Bs.' && out.prefijoDespues.trim() === '');
          ok('direccion-cambia-resultado', out.resAntes !== out.resDespues);
          ok('tarjeta-selecciona-tasa', out.tasaTrasClic === 'paralelo');
        } else {
          // Sin internet: la vista debe explicar que no hay tasas, no romperse.
          ok('tasas-estado-vacio', out.estadoVacio === 1 && out.mercadoConValor === 0);
        }

        const todo = $('#tabs .tab[data-tab="Todo"]');
        if (todo) todo.click();
        await sleep(60);
      });

      // 14) Persistencia real en disco (JSON plano)
      await run('14-persistence', async () => {
        const recs = await window.api.getRecords();
        const loans = await window.api.getLoans();
        out.persistedCount = recs.records.length;
        out.persistedLoans = loans.loans.length;
        out.finalRecords = recs.records.map(function (r) { return r.moneda + '/' + r.tipo + '/' + r.concepto; });
      });

      return out;
    })()`);

    console.log('SMOKE_STEPS');
    for (const s of ui.steps) console.log('  ' + s);
    function out0(v) { return v === undefined ? "(sin dato)" : v; }
    console.log('SMOKE_RESULT ' + JSON.stringify({ ...ui, steps: undefined }, null, 2));

    const failures = [];
    if (!ui.steps.includes('no-pin-screen: ok')) failures.push('sigue habiendo pantalla PIN');
    if (!ui.steps.includes('app-visible: ok')) failures.push('app no visible');
    if (!ui.steps.includes('tabs-9: ok')) failures.push('tabs != 9');
    if (!ui.steps.includes('rows-after-first: ok')) failures.push('1er registro no creado');
    if (!ui.steps.includes('rows-after-second: ok')) failures.push('2do registro no creado');
    if (!ui.chainBadges) failures.push('sin badges de cadena');
    if (ui.detailChips !== 2) failures.push('cadena detalle != 2 chips');
    if (ui.btcRows !== 1) failures.push('pestaña BTC != 1 fila');
    if (!ui.steps.includes('edited: ok')) failures.push('edición falló');
    if (!ui.steps.includes('rows-after-delete: ok')) failures.push('borrado falló');
    if (!ui.steps.includes('rows-after-ingreso: ok')) failures.push('ingreso no creado');
    if (!ui.steps.includes('conv-fields-visible: ok')) failures.push('no se mostraron los campos de conversión');
    if (!ui.steps.includes('conv-precio-auto: ok')) failures.push('el precio unitario no se calculó solo');
    if (!ui.steps.includes('conv-row-created: ok')) failures.push('la conversión no se guardó');
    if (!ui.steps.includes('conv-guardada: ok')) failures.push('no existe el registro tipo Conversión');
    if (!ui.steps.includes('conv-lados: ok')) failures.push('los lados de la conversión están mal (=' + ui.convLados + ')');
    if (!ui.steps.includes('cal-visible: ok')) failures.push('calendario no visible');
    if (ui.calOnScreen !== true) failures.push('calendario fuera de pantalla');
    if (ui.tableHiddenOnCal !== true) failures.push('tabla no oculta en calendario');
    if (!ui.steps.includes('cal-has-days: ok')) failures.push('calendario sin días marcados');
    if (!ui.steps.includes('bs-net-pos: ok')) failures.push('total neto Bs incorrecto (= ' + ui.bsNet + ')');
    if (!ui.steps.includes('usdt-net-conversion: ok')) failures.push('la conversión no descontó lo entregado (USDT=' + ui.usdtNet + ')');
    if (!ui.steps.includes('btc-net-conversion: ok')) failures.push('la conversión no sumó lo recibido (BTC=' + ui.btcNet + ')');
    if (!ui.steps.includes('bs-card-dice-conversiones: ok')) failures.push('la tarjeta de Bs no aclara que la conversión no cuenta');
    if (!ui.steps.includes('cartera-visible: ok')) failures.push('la vista Cartera no se ve');
    if (!ui.steps.includes('cartera-cards: ok')) failures.push('Cartera sin tarjetas');
    if (!ui.steps.includes('cartera-new-hidden: ok')) failures.push('el botón "+ Nuevo" debería ocultarse en Cartera');
    if (!ui.steps.includes('cartera-ver-movimientos: ok')) failures.push('falta "Ver movimientos" en Cartera');
    if (!ui.steps.includes('cartera-filtro: ok')) failures.push('"Ver movimientos" no filtró la tabla');
    // Binance solo tiene la conversión: -50 USDT entregados y +0,0005 BTC recibidos.
    if (ui.binanceUsdt !== '-50') failures.push('saldo USDT de Binance = ' + ui.binanceUsdt + ' (esperado -50)');
    if (ui.binanceBtc !== '0,0005') failures.push('saldo BTC de Binance = ' + ui.binanceBtc + ' (esperado 0,0005)');
    if (!ui.steps.includes('tasa-handler: ok')) failures.push('el handler de tasa BCV no responde');
    if (!ui.steps.includes('tasa-fuente-manual: ok')) failures.push('no se pudo guardar la tasa como Manual');
    if (!ui.jumpVisible) failures.push('clic en día no mostró "ver en la lista"');
    if (!ui.settings) failures.push('settings falló');
    if (!ui.steps.includes('11-loan-create: ok')) failures.push('préstamo no creado');
    if (ui.persistedCount !== 5) failures.push('persistencia en disco (records=' + ui.persistedCount + ', esperado 5)');
    if (ui.persistedLoans !== 1) failures.push('persistencia de préstamos');
    if (!ui.loanIngresoOk) failures.push('no se creó el Ingreso del préstamo');
    if (!ui.loanEgresoOk) failures.push('no se creó el Egreso del pago');
    if (!ui.steps.includes('loan-cal-marker: ok')) failures.push('calendario sin marcador de préstamo');
    if (!ui.steps.includes('loan-cal-note: ok')) failures.push('calendario sin nota de préstamo');
    if (!ui.steps.includes('tasas-visible: ok')) failures.push('la vista Tasas no se ve');
    if (!ui.steps.includes('tasas-4-tarjetas: ok')) failures.push('faltan tarjetas en Tasas (= ' + ui.mercadoCards + ')');
    if (!ui.steps.includes('tasas-conversion-100usd: ok')) failures.push('el convertidor no calcula (= ' + out0(ui.cvResultado) + ')');
    if (!ui.steps.includes('mercado-handler: ok')) failures.push('el handler de mercado no responde');
    if (!ui.steps.includes('filtro-todas-4: ok')) failures.push('el filtro "Todas" no muestra 4 tarjetas');
    if (!ui.steps.includes('filtro-eur-2: ok')) failures.push('el filtro EUR no deja 2 tarjetas (= ' + ui.filtroEur + ')');
    if (!ui.steps.includes('filtro-usd-2: ok')) failures.push('el filtro USD no deja 2 tarjetas (= ' + ui.filtroUsd + ')');
    if (!ui.steps.includes('filtro-vuelta-4: ok')) failures.push('el filtro no vuelve a "Todas" (= ' + ui.filtroVuelta + ')');
    if (!ui.steps.includes('filtro-chip-activo: ok')) failures.push('el chip activo del filtro no se marca');
    if (!ui.steps.includes('direccion-cambia-texto: ok')) failures.push('el boton de direccion no cambia el texto');
    if (!ui.steps.includes('direccion-cambia-unidad: ok')) failures.push('la unidad del monto no cambia al invertir');
    if (!ui.steps.includes('direccion-cambia-prefijo: ok')) failures.push('el prefijo Bs. no desaparece al invertir');
    if (!ui.steps.includes('direccion-cambia-resultado: ok')) failures.push('el resultado no cambia al invertir');
    if (!ui.steps.includes('tarjeta-selecciona-tasa: ok')) failures.push('click en la tarjeta no elige la tasa');


    // Verificar que el archivo JSON existe en disco
    const onDisk = fs.existsSync(path.join(DATA_DIR, 'registro.json'));
    if (!onDisk) failures.push('registro.json no existe en disco');
    console.log(failures.length ? 'SMOKE_FAIL: ' + failures.join(' | ') : 'SMOKE_OK: flujo completo verificado ✓');
    app.exit(failures.length ? 1 : 0);
  } catch (err) {
    console.error('SMOKE_EXCEPTION', err);
    app.exit(1);
  } finally {
    try {
      if (win) win.destroy();
      fs.rmSync(DATA_DIR, { recursive: true, force: true });
    } catch {}
  }
});