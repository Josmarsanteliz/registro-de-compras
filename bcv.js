'use strict';

// Tasa oficial del BCV (Bs por 1 USD) + fuente de respaldo.
//
// El BCV no publica una API pública: la tasa está embebida en el HTML de la portada.
// Por eso el parser es un regex sobre el bloque del dólar, y por eso existe una segunda
// fuente (DolarAPI). Si el BCV cambia su maquetación, el parser falla y caemos a DolarAPI;
// si fallan las dos, el llamador conserva la última tasa guardada.
//
// Sin `require('electron')`: los parsers son puros y se prueban con `node test-core.js`.

const https = require('https');

const BCV_URL = 'https://www.bcv.org.ve/';
const DOLARAPI_URL = 'https://ve.dolarapi.com/v1/dolares/oficial';
const TIMEOUT_MS = 12000;

// Última tasa consultada con éxito en esta sesión: { valor, fecha, fuente, consultadoEn }.
let cache = null;

// El BCV sirve una cadena de certificados incompleta (falta la intermedia), así que la
// verificación estricta de Node falla aunque la página sea legítima. Cuando detectamos ese
// error reintentamos con un agente propio sin verificación, en lugar de relajar
// NODE_TLS_REJECT_UNAUTHORIZED (que es global y dejaría abierta toda la app).
// Es aceptable acá: es una página pública de solo lectura, no se envían credenciales, y el
// valor resultante es un número que el usuario puede ver y corregir a mano.
const agenteSinVerificar = new https.Agent({ rejectUnauthorized: false });

function esErrorDeCertificado(err) {
  const msg = String((err && err.message) || '').toLowerCase();
  return msg.includes('certificate') || msg.includes('cert_') || msg.includes('self signed')
    || msg.includes('unable to verify');
}

// GET https plano con timeout. Devuelve el body como texto.
function get(url, agent) {
  return new Promise((resolve, reject) => {
    const opts = { headers: { Accept: 'text/html,application/json' } };
    if (agent) opts.agent = agent;
    const req = https.get(url, opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        get(new URL(res.headers.location, url).toString(), agent).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy(new Error('timeout'));
    });
  });
}

// GET con un reintento sin verificar si el primer intento muere por el certificado.
async function getTolerante(url) {
  try {
    return await get(url);
  } catch (err) {
    if (!esErrorDeCertificado(err)) throw err;
    return get(url, agenteSinVerificar);
  }
}

// "857,00580000" -> 857.0058 (punto de miles, coma decimal).
function parseEsNum(txt) {
  const limpio = String(txt || '').replace(/[^\d,.]/g, '');
  if (!limpio) return null;
  const normalizado = limpio.includes(',')
    ? limpio.replace(/\./g, '').replace(',', '.')
    : limpio.replace(/,/g, '');
  const n = Number(normalizado);
  return isFinite(n) && n > 0 ? n : null;
}

// Extrae la tasa y la fecha del HTML de la portada del BCV.
// Acepta decimales con coma o punto y fechas ISO o dd/mm/aaaa.
function parseBcvHtml(html) {
  const txt = String(html || '');
  if (!txt) return null;

  // El bloque empieza en id="dolar" y el valor es el <strong> que le sigue.
  const inicio = txt.search(/id="dolar"/i);
  if (inicio === -1) return null;
  const bloque = txt.slice(inicio, inicio + 1200);
  const valor = parseEsNum((bloque.match(/strong-tb"[^>]*>\s*([\d.,]+)/i) || [])[1]);
  if (valor === null) return null;

  // "Fecha Valor: <span ... content="2026-09-28T00:00:00-04:00">Lunes, 28 Septiembre 2026"
  const iso = (txt.match(/Fecha Valor[\s\S]{0,200}?content="(\d{4}-\d{2}-\d{2})/i) || [])[1];
  return { valor, fecha: iso || null, fuente: 'BCV' };
}

// Extrae la tasa de la respuesta de DolarAPI ({ moneda, promedio, fechaActualizacion, ... }).
function parseDolarApi(body) {
  let data = body;
  if (typeof body === 'string') {
    try {
      data = JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== 'object') return null;
  const valor = parseEsNum(data.promedio != null ? data.promedio : data.venta);
  if (valor === null) return null;
  const iso = String(data.fechaActualizacion || '').slice(0, 10);
  return { valor, fecha: /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null, fuente: 'DolarAPI' };
}

// Intenta las fuentes en orden. Nunca lanza: devuelve { ok, tasa, error, intentos }.
// `tasa` es null solo si fallaron todas las fuentes.
async function consultar() {
  const intentos = [];

  try {
    const tasa = parseBcvHtml(await getTolerante(BCV_URL));
    if (tasa) {
      tasa.consultadoEn = Date.now();
      cache = tasa;
      return { ok: true, tasa, error: null, intentos: ['BCV'] };
    }
    intentos.push('BCV: no se encontró la tasa en el HTML');
  } catch (err) {
    intentos.push('BCV: ' + (err && err.message ? err.message : err));
  }

  try {
    const tasa = parseDolarApi(await get(DOLARAPI_URL));
    if (tasa) {
      tasa.consultadoEn = Date.now();
      cache = tasa;
      return { ok: true, tasa, error: null, intentos };
    }
    intentos.push('DolarAPI: respuesta sin tasa utilizable');
  } catch (err) {
    intentos.push('DolarAPI: ' + (err && err.message ? err.message : err));
  }

  return { ok: false, tasa: null, error: intentos.join(' · '), intentos };
}

// Última tasa conocida en esta sesión, sin tocar la red.
function getCache() {
  return cache;
}

// Tasa del día según el historial guardado: la del BCV va con fecha propia (a veces del día
// siguiente, porque el BCV publica la tasa del próximo día hábil), así que si no hay
// entrada para hoy se usa la más reciente disponible.
function tasaDeFecha(historial, iso) {
  const lista = Array.isArray(historial) ? historial : [];
  const exacta = lista.find((t) => t && t.fecha === iso && t.valor > 0);
  if (exacta) return exacta.valor;
  const previas = lista.filter((t) => t && t.fecha && t.fecha < iso && t.valor > 0);
  if (!previas.length) return null;
  return previas.sort((a, b) => (a.fecha < b.fecha ? 1 : -1))[0].valor;
}

module.exports = {
  BCV_URL,
  DOLARAPI_URL,
  parseEsNum,
  parseBcvHtml,
  parseDolarApi,
  consultar,
  getCache,
  tasaDeFecha,
};
