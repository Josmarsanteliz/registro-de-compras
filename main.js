'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const core = require('./core');
const mercado = require('./mercado');

const DATA_DIR = app.isPackaged ? path.join(app.getPath('userData'), 'datos') : path.join(__dirname, 'datos');
const DATA_PATH = path.join(DATA_DIR, 'registro.json');

const SETTINGS_DEFAULT = { tasaReferencia: 0, tasaFuente: 'BCV', tasaUltimaConsulta: 0, tasaUltimoError: null };

let mainWindow = null;
let db = { records: [], loans: [], tasas: [], mercado: [], settings: { ...SETTINGS_DEFAULT } };

// Log de diagnóstico (solo actúa si se define REGISTRO_DEBUG=1).
function dbg(msg) {
  if (process.env.REGISTRO_DEBUG !== '1') return;
  try {
    fs.appendFileSync(path.join(__dirname, 'launch-debug.log'), `[${new Date().toLocaleTimeString()}] ${msg}\n`, 'utf8');
  } catch {}
}

// Instancia única: si la app ya está abierta, enfocarla en vez de crear otra.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

dbg('main.js cargado');

// ---------- Persistencia (JSON plano, todo local) ----------

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    db = {
      records: Array.isArray(parsed.records) ? parsed.records : [],
      // Migración: respaldos viejos no traen "loans".
      loans: Array.isArray(parsed.loans) ? parsed.loans.map((l) => core.normalizeLoan(l)) : [],
      // Migración: tampoco traen el historial de tasas del BCV.
      tasas: Array.isArray(parsed.tasas) ? parsed.tasas.filter((t) => t && t.valor > 0) : [],
      // Migración: tampoco traen el historial de mercado (paralelo y euros).
      mercado: Array.isArray(parsed.mercado) ? parsed.mercado.filter((m) => m && m.fecha) : [],
      settings: { ...SETTINGS_DEFAULT, ...(parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {}) },
    };
  } catch {
    db = { records: [], loans: [], tasas: [], mercado: [], settings: { ...SETTINGS_DEFAULT } };
    save();
  }
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(db, null, 2), 'utf8');
}

function recordById(id) {
  return core.findBy(db.records, id);
}

function loanById(id) {
  return db.loans.find((l) => l.id === id) || null;
}

// Elimina un registro y limpia las referencias "origen" huérfanas.
function deleteRecordById(id) {
  const idx = db.records.findIndex((r) => r.id === id);
  if (idx === -1) return false;
  db.records.splice(idx, 1);
  for (const r of db.records) if (r.origenId === id) r.origenId = null;
  return true;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/* ---------- Tasa del BCV ---------- */

// Última tasa conocida: primero el historial guardado (sobrevive al reinicio), después la
// caché de la consulta de esta sesión. Nunca se devuelve un valor sin fuente.
function ultimaTasa() {
  const historial = db.tasas;
  const ultima = historial.length ? historial[historial.length - 1] : null;
  const cache = mercado.getCache();
  if (cache && (!ultima || cache.consultadoEn > (ultima.guardadoEn || 0))) return cache;
  return ultima;
}

// Guarda la tasa en el historial (una por fecha) y, si el usuario no fijó una tasa a mano,
// la deja como tasa de referencia para que los registros que no tienen tasa propia se
// calculen solos.
function guardarTasa(tasa) {
  db.settings.tasaUltimaConsulta = Date.now();
  db.settings.tasaUltimoError = null;
  if (tasa && tasa.valor > 0) {
    const fecha = tasa.fecha || todayISO();
    const i = db.tasas.findIndex((t) => t.fecha === fecha);
    const fila = { fecha, valor: tasa.valor, fuente: tasa.fuente, guardadoEn: Date.now() };
    if (i === -1) db.tasas.push(fila);
    else db.tasas[i] = fila;
    db.tasas.sort((a, b) => a.fecha.localeCompare(b.fecha));
    // Podría crecer sin límite si se consultara mucho; con ~3 años alcanza de sobra.
    if (db.tasas.length > 1500) db.tasas.splice(0, db.tasas.length - 1500);
    if (db.settings.tasaFuente !== 'Manual') db.settings.tasaReferencia = tasa.valor;
  }
  save();
}

// Consulta las fuentes (BCV y, si falla, DolarAPI) y guarda el resultado.
async function refrescarTasa() {
  const res = await mercado.consultar();
  if (res.ok) {
    guardarTasa(res.tasa);
  } else {
    // No se pisa la última tasa buena: solo se registra el error para mostrarlo en la UI.
    db.settings.tasaUltimaConsulta = Date.now();
    db.settings.tasaUltimoError = res.error;
    save();
  }
  return { ...res, historial: db.tasas.slice(-30).reverse(), settings: { ...db.settings } };
}

/* ---------- Mercado (paralelo y euros) ---------- */

let cacheMercado = null;

// Última consulta conocida: el historial si es más nuevo que la caché de esta sesión.
function ultimoMercado() {
  const ultimo = db.mercado.length ? db.mercado[db.mercado.length - 1] : null;
  if (cacheMercado && (!ultimo || cacheMercado.consultadasEn > (ultimo.guardadoEn || 0))) {
    return { ...cacheMercado, esCache: true };
  }
  return ultimo;
}

// Una fila por día con las cuatro tasas. Re-consultar el mismo día solo actualiza los valores.
function guardarMercado(datos) {
  cacheMercado = datos;
  const hoy = todayISO();
  const fila = {
    fecha: hoy,
    bcv: datos.bcv ? datos.bcv.valor : null,
    paralelo: datos.paralelo ? datos.paralelo.valor : null,
    euroOficial: datos.euroOficial ? datos.euroOficial.valor : null,
    euroParalelo: datos.euroParalelo ? datos.euroParalelo.valor : null,
    guardadoEn: Date.now(),
  };
  const i = db.mercado.findIndex((m) => m.fecha === hoy);
  if (i === -1) db.mercado.push(fila);
  else db.mercado[i] = fila;
  if (db.mercado.length > 1500) db.mercado.splice(0, db.mercado.length - 1500);
  save();
  return datos;
}

async function refrescarMercado() {
  const res = await mercado.consultarMercado();
  const datos = res.ok ? guardarMercado(res.mercado) : ultimoMercado();
  return {
    ok: res.ok,
    mercado: datos,
    error: res.error,
    historial: db.mercado.slice(-20).reverse(),
  };
}

// Registro (Ingreso al recibir / Egreso al pagar) que nace de un préstamo.
function buildLoanRecord(loan, tipo) {
  const esIngreso = tipo === 'Ingreso';
  const fecha = esIngreso ? loan.fecha : loan.pagadoEn || todayISO();
  const concepto = `${esIngreso ? 'Préstamo recibido' : 'Pago de préstamo'}: ${loan.total} USD${loan.contraparte ? ' · ' + loan.contraparte : ''}`;
  const notas = esIngreso
    ? `Recibí ${core.fmtNumber(loan.monto)} USD. Debo devolver ${core.fmtNumber(loan.total)} USD (interés ${core.fmtNumber(loan.interesPct)}% = ${core.fmtNumber(loan.interes)} USD) el ${core.fmtDate(loan.fechaVenc)}.`
    : `Pagué el préstamo del ${core.fmtDate(loan.fecha)} (total ${core.fmtNumber(loan.total)} USD).`;
  return core.normalizeRecord({
    fecha,
    tipo,
    concepto,
    categoria: 'préstamo',
    moneda: 'USD',
    monto: esIngreso ? loan.monto : loan.total,
    tasaDia: loan.tasaBCV,
    exchange: 'Ninguno',
    notas,
    origenId: esIngreso ? null : (loan.registroIngresoId && recordById(loan.registroIngresoId) ? loan.registroIngresoId : null),
  });
}

// Sincroniza los registros vinculados cuando se edita un préstamo.
function syncLoanRecords(loan) {
  const ingreso = loan.registroIngresoId ? recordById(loan.registroIngresoId) : null;
  if (ingreso) {
    const built = buildLoanRecord(loan, 'Ingreso');
    ingreso.fecha = built.fecha;
    ingreso.monto = built.monto;
    ingreso.tasaDia = built.tasaDia;
    ingreso.concepto = built.concepto;
    ingreso.notas = built.notas;
  }
  const pago = loan.registroPagoId ? recordById(loan.registroPagoId) : null;
  if (pago) {
    const built = buildLoanRecord(loan, 'Egreso');
    pago.fecha = built.fecha;
    pago.monto = built.monto;
    pago.tasaDia = built.tasaDia;
    pago.concepto = built.concepto;
    pago.notas = built.notas;
  }
}

// ---------- Ventana ----------

function createWindow() {
  dbg('createWindow: iniciando');
  try {
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 900,
      minHeight: 600,
      show: false,
      backgroundColor: '#252422',
      icon: fs.existsSync(path.join(__dirname, 'Logo', 'app.ico'))
        ? path.join(__dirname, 'Logo', 'app.ico')
        : path.join(__dirname, 'Logo', 'PNG.png'),
      title: 'Registro de Compras',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    dbg('createWindow: BrowserWindow creado');

    Menu.setApplicationMenu(null);
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    mainWindow.once('ready-to-show', () => {
      dbg('ready-to-show: mostrando ventana');
      mainWindow.show();
    });
    mainWindow.webContents.on('did-finish-load', () => dbg('did-finish-load: OK'));
    mainWindow.webContents.on('did-fail-load', (_e, code, desc) => dbg(`did-fail-load: ${code} ${desc}`));
    mainWindow.webContents.on('render-process-gone', (_e, details) => dbg(`render-process-gone: ${details.reason}`));
    mainWindow.on('show', () => dbg('show: ventana visible'));
    mainWindow.on('unresponsive', () => dbg('unresponsive'));

    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    dbg('createWindow: loadFile llamada');
  } catch (err) {
    dbg('createWindow: EXCEPCION ' + (err && err.stack ? err.stack : err));
  }
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('db:records', () => {
    return { ok: true, records: JSON.parse(JSON.stringify(db.records)) };
  });

  ipcMain.handle('settings:get', () => {
    return { ok: true, settings: { ...db.settings } };
  });

  ipcMain.handle('settings:set', (_e, s) => {
    const prev = db.settings;
    const fuente = s && s.tasaFuente === 'Manual' ? 'Manual' : 'BCV';
    db.settings = {
      ...prev,
      tasaReferencia: Number(s && s.tasaReferencia) > 0 ? Number(s.tasaReferencia) : 0,
      // Escribir la tasa a mano es una decisión explícita: el auto-refresh no la pisa nunca más.
      tasaFuente: fuente,
    };
    save();
    return { ok: true, settings: { ...db.settings } };
  });

  // ---------- Tasa BCV ----------

  ipcMain.handle('tasa:get', () => {
    return { ok: true, tasa: ultimaTasa(), historial: db.tasas.slice(-30).reverse(), settings: { ...db.settings } };
  });

  ipcMain.handle('tasa:refresh', () => refrescarTasa());

  // ---------- Mercado ----------

  ipcMain.handle('mercado:get', () => {
    return { ok: true, mercado: ultimoMercado(), historial: db.mercado.slice(-20).reverse() };
  });

  ipcMain.handle('mercado:refresh', () => refrescarMercado());

  ipcMain.handle('registro:add', (_e, rec) => {
    const r = core.normalizeRecord(rec);
    const check = core.validateRecord(r, db.records);
    if (!check.ok) return check;
    r.id = crypto.randomUUID();
    r.creadoEn = Date.now();
    if (core.wouldCreateCycle(db.records, r.id, r.origenId)) {
      return { ok: false, error: 'Esa cadena crearía un ciclo (A\u2192B\u2192A)' };
    }
    db.records.push(r);
    save();
    return { ok: true, record: r };
  });

  ipcMain.handle('registro:update', (_e, rec) => {
    const existing = recordById(rec.id);
    if (!existing) return { ok: false, error: 'El registro no existe' };
    const r = { ...core.normalizeRecord(rec), id: existing.id, creadoEn: existing.creadoEn };
    const check = core.validateRecord(r, db.records);
    if (!check.ok) return check;
    Object.assign(existing, r);
    save();
    return { ok: true, record: existing };
  });

  ipcMain.handle('registro:delete', (_e, id) => {
    if (!recordById(id)) return { ok: false, error: 'No existe' };
    deleteRecordById(id);
    save();
    return { ok: true };
  });

  // ---------- Préstamos ----------

  ipcMain.handle('loans:get', () => {
    return { ok: true, loans: JSON.parse(JSON.stringify(db.loans)) };
  });

  ipcMain.handle('loan:add', (_e, payload) => {
    const opts = (payload && payload.opts) || {};
    const loan = core.normalizeLoan(payload && payload.loan);
    const check = core.validateLoan(loan);
    if (!check.ok) return check;
    loan.id = crypto.randomUUID();
    loan.creadoEn = Date.now();
    if (opts.crearRegistro !== false) {
      const rec = buildLoanRecord(loan, 'Ingreso');
      rec.id = crypto.randomUUID();
      rec.creadoEn = Date.now();
      db.records.push(rec);
      loan.registroIngresoId = rec.id;
    }
    db.loans.push(loan);
    save();
    return { ok: true, loan };
  });

  ipcMain.handle('loan:update', (_e, payload) => {
    const existing = loanById(payload && payload.id);
    if (!existing) return { ok: false, error: 'El préstamo no existe' };
    const opts = (payload && payload.opts) || {};
    const loan = core.normalizeLoan({ ...(payload.loan || {}), id: existing.id, creadoEn: existing.creadoEn });
    const check = core.validateLoan(loan);
    if (!check.ok) return check;

    // Vínculo con registros: se crea o se quita según la casilla.
    if (loan.registroIngresoId && !recordById(loan.registroIngresoId)) loan.registroIngresoId = null;
    if (opts.crearRegistro && !loan.registroIngresoId) {
      const rec = buildLoanRecord(loan, 'Ingreso');
      rec.id = crypto.randomUUID();
      rec.creadoEn = Date.now();
      db.records.push(rec);
      loan.registroIngresoId = rec.id;
    } else if (opts.crearRegistro === false && loan.registroIngresoId) {
      // Solo se puede soltar el vínculo si no hay pago encadenado todavía.
      if (!loan.registroPagoId) {
        deleteRecordById(loan.registroIngresoId);
        loan.registroIngresoId = null;
      }
    }

    Object.assign(existing, loan);
    syncLoanRecords(existing);
    save();
    return { ok: true, loan: existing };
  });

  ipcMain.handle('loan:pay', (_e, id) => {
    const loan = loanById(id);
    if (!loan) return { ok: false, error: 'El préstamo no existe' };
    if (loan.pagado) return { ok: false, error: 'Ya está marcado como pagado' };
    // Si el registro de ingreso fue borrado a mano, limpiamos el vínculo roto.
    if (loan.registroIngresoId && !recordById(loan.registroIngresoId)) loan.registroIngresoId = null;
    loan.pagado = true;
    loan.pagadoEn = todayISO();
    const rec = buildLoanRecord(loan, 'Egreso');
    rec.id = crypto.randomUUID();
    rec.creadoEn = Date.now();
    db.records.push(rec);
    loan.registroPagoId = rec.id;
    save();
    return { ok: true, loan };
  });

  ipcMain.handle('loan:unpay', (_e, id) => {
    const loan = loanById(id);
    if (!loan) return { ok: false, error: 'El préstamo no existe' };
    if (loan.registroPagoId) {
      deleteRecordById(loan.registroPagoId);
      loan.registroPagoId = null;
    }
    loan.pagado = false;
    loan.pagadoEn = null;
    save();
    return { ok: true, loan };
  });

  ipcMain.handle('loan:delete', (_e, id) => {
    const loan = loanById(id);
    if (!loan) return { ok: false, error: 'El préstamo no existe' };
    if (loan.registroPagoId) deleteRecordById(loan.registroPagoId);
    if (loan.registroIngresoId) deleteRecordById(loan.registroIngresoId);
    db.loans = db.loans.filter((l) => l.id !== id);
    save();
    return { ok: true };
  });

  ipcMain.handle('backup:export', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Guardar respaldo',
      defaultPath: `registro-compras-respaldo-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'Respaldo JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    fs.writeFileSync(filePath, JSON.stringify(db, null, 2), 'utf8');
    return { ok: true, path: filePath };
  });

  ipcMain.handle('backup:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Importar respaldo',
      properties: ['openFile'],
      filters: [{ name: 'Respaldo JSON', extensions: ['json'] }],
    });
    if (canceled || !filePaths.length) return { ok: false, canceled: true };
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
    } catch {
      return { ok: false, error: 'El archivo no es un respaldo válido' };
    }
    if (!Array.isArray(parsed.records)) {
      return { ok: false, error: 'No parece un respaldo de esta app' };
    }
    // Normaliza para que no entren campos rotos (monedas inválidas, tipos, etc.).
    db.records = parsed.records.map((r) => {
      const n = core.normalizeRecord(r);
      if (!n.id) n.id = crypto.randomUUID();
      return n;
    });
    db.loans = Array.isArray(parsed.loans) ? parsed.loans.map((l) => core.normalizeLoan(l)) : [];
    db.tasas = Array.isArray(parsed.tasas) ? parsed.tasas.filter((t) => t && t.valor > 0) : [];
    db.mercado = Array.isArray(parsed.mercado) ? parsed.mercado.filter((m) => m && m.fecha) : [];
    db.settings = { ...SETTINGS_DEFAULT, ...(parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {}) };
    // Limpieza: quitar referencias rotas (huérfanas) tras la importación.
    const ids = new Set(db.records.map((r) => r.id));
    for (const r of db.records) if (r.origenId && !ids.has(r.origenId)) r.origenId = null;
    for (const l of db.loans) {
      if (l.registroIngresoId && !ids.has(l.registroIngresoId)) l.registroIngresoId = null;
      if (l.registroPagoId && !ids.has(l.registroPagoId)) l.registroPagoId = null;
    }
    save();
    return { ok: true, count: db.records.length, loans: db.loans.length };
  });

  ipcMain.handle('backup:exportCsv', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Exportar CSV',
      defaultPath: `registro-compras-${new Date().toISOString().slice(0, 10)}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    const sorted = [...db.records].sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '') || b.creadoEn - a.creadoEn);
    let csv = core.buildCsv(sorted, (id) => (recordById(id) ? recordById(id).concepto : ''));
    if (db.loans.length) {
      const sortedLoans = [...db.loans].sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
      csv += '\r\n\r\n' + core.buildLoansCsv(sortedLoans);
    }
    fs.writeFileSync(filePath, csv, 'utf8');
    return { ok: true, path: filePath };
  });
}

registerIpc();
load();
dbg('registerIpc y load completados');

module.exports = { registerIpc };

// ---------- Arranque ----------
// NOTA: en Electron el bloque "require.main === module" NO funciona como en Node plano,
// así que usamos una variable de entorno para distinguir las pruebas (smoke).
if (gotLock && !process.env.REGISTRO_SMOKE) {
  dbg('arranque normal; llamando app.whenReady()');
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  process.on('uncaughtException', (err) => {
    dbg('uncaughtException: ' + (err && err.stack ? err.stack : err));
  });
  app.whenReady().then(() => {
    dbg('whenReady RESUELTO');
    createWindow();
    // Consulta la tasa del BCV y las de mercado al abrir, sin bloquear el arranque: si algo
    // falla, la app abre igual con lo último guardado y el error se muestra en la UI.
    refrescarTasa()
      .then((r) => {
        dbg('tasa BCV: ' + (r.ok ? r.tasa.valor + ' (' + r.tasa.fuente + ')' : 'falló: ' + r.error));
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('tasa:actualizada', r);
        }
      })
      .catch((err) => dbg('tasa BCV excepción: ' + (err && err.message ? err.message : err)));
    refrescarMercado()
      .then((r) => {
        dbg('mercado: ' + (r.ok ? r.mercado.disponible + '/4 tasas' : 'falló: ' + r.error));
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('mercado:actualizado', r);
        }
      })
      .catch((err) => dbg(' mercado excepción: ' + (err && err.message ? err.message : err)));
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    dbg('window-all-closed');
    app.quit();
  });
}