'use strict';

// Tasas de mercado de Venezuela: BCV oficial, dólar paralelo y euros.
//
// El BCV no publica una API pública: su tasa está embebida en el HTML de la portada, así que
// se lee con un regex sobre el bloque del dólar. Para el paralelo y los euros se usa DolarAPI.
//
// Cada fuente tiene su propia fecha y hay que respetar la diferencia: DolarAPI suele tener el
// "oficial" unos días atrasado respecto al BCV real. Por eso el BCV se lee del sitio oficial
// y no de DolarAPI, y cada tasa viaja con su `fecha` para que la interfaz pueda avisar cuando
// un dato está viejo en vez de presentarlo como si fuera de hoy.
//
// Sin `require('electron')`: los parsers son puros y se prueban con `node test-core.js`.

const https = require('https');

const BCV_URL = 'https://www.bcv.org.ve/';
const DOLARAPI_PARALELO_URL = 'https://ve.dolarapi.com/v1/dolares/paralelo';
const DOLARAPI_EUROS_URL = 'https://ve.dolarapi.com/v1/euros';
const DOLARAPI_OFICIAL_URL = 'https://ve.dolarapi.com/v1/dolares/oficial';
const TIMEOUT_MS = 12000;

// Última tasa del BCV consultada con éxito en esta sesión: { valor, fecha, fuente, consultadoEn }.
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

function isoFecha(v) {
  const s = String(v || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
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
  return { valor, fecha: isoFecha(iso), fuente: 'BCV' };
}

// Normaliza la respuesta de DolarAPI, que puede venir como objeto suelto o como lista.
// Devuelve [{ valor, fecha, fuente, nombre, moneda }]; null si no hay nada utilizable.
function parseDolarApiLista(body) {
  let data = body;
  if (typeof body === 'string') {
    try {
      data = JSON.parse(body);
    } catch {
      return null;
    }
  }
  const lista = Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : null;
  if (!lista) return null;
  const out = [];
  for (const item of lista) {
    if (!item || typeof item !== 'object') continue;
    const valor = parseEsNum(item.promedio != null ? item.promedio : item.venta);
    if (valor === null) continue;
    out.push({
      valor,
      fecha: isoFecha(item.fechaActualizacion),
      fuente: 'DolarAPI',
      nombre: String(item.nombre || ''),
      moneda: String(item.moneda || ''),
    });
  }
  return out.length ? out : null;
}

// Objeto suelto de DolarAPI (un solo tipo de cambio), para la tasa oficial de respaldo.
function parseDolarApi(body) {
  const lista = parseDolarApiLista(body);
  return lista ? lista[0] : null;
}

// Busca en una lista de DolarAPI el item de la fuente pedida ("paralelo", "oficial").
function buscarFuente(lista, fuente) {
  if (!Array.isArray(lista)) return null;
  return lista.find((x) => String(x.nombre || '').toLowerCase() === fuente) || null;
}

// Junta las tasas consultadas en una sola respuesta, dejando en null lo que falló.
// Un resultado parcial es más útil que un error: mejor mostrar 2 de 4 que no mostrar nada.
function combinarMercado(partes, consultadasEn) {
  const m = {
    bcv: partes.bcv || null,
    paralelo: partes.paralelo || null,
    euroOficial: partes.euroOficial || null,
    euroParalelo: partes.euroParalelo || null,
    consultadasEn: consultadasEn || Date.now(),
  };
  m.disponible = [m.bcv, m.paralelo, m.euroOficial, m.euroParalelo].filter((x) => x && x.valor > 0).length;
  return m;
}

async function consultarBcv() {
  const tasa = parseBcvHtml(await getTolerante(BCV_URL));
  if (!tasa) throw new Error('no se encontró la tasa del dólar en el HTML del BCV');
  tasa.consultadoEn = Date.now();
  cache = tasa;
  return tasa;
}

// Intenta las fuentes en orden. Nunca lanza: devuelve { ok, tasa, error, intentos }.
// `tasa` es null solo si fallaron todas las fuentes.
async function consultar() {
  const intentos = [];
  try {
    const tasa = await consultarBcv();
    return { ok: true, tasa, error: null, intentos: ['BCV'] };
  } catch (err) {
    intentos.push('BCV: ' + (err && err.message ? err.message : err));
  }

  try {
    const tasa = parseDolarApi(await get(DOLARAPI_OFICIAL_URL));
    if (tasa) {
      tasa.consultadoEn = Date.now();
      return { ok: true, tasa, error: null, intentos };
    }
    intentos.push('DolarAPI: respuesta sin tasa utilizable');
  } catch (err) {
    intentos.push('DolarAPI: ' + (err && err.message ? err.message : err));
  }

  return { ok: false, tasa: null, error: intentos.join(' · '), intentos };
}

// BCV + paralelo + euros. Cada bloque falla por separado: se llama a consultar() para el BCV
// (que ya tiene su propio respaldo a DolarAPI) y, en paralelo, a los dos endpoints de DolarAPI.
async function consultarMercado() {
  const errores = [];

  const [bcvRes, paraleloRes, eurosRes] = await Promise.all([
    consultar().catch((err) => ({ ok: false, error: String(err && err.message ? err.message : err) })),
    get(DOLARAPI_PARALELO_URL).then((t) => parseDolarApi(t)).catch((err) => {
      errores.push('paralelo: ' + (err && err.message ? err.message : err));
      return null;
    }),
    get(DOLARAPI_EUROS_URL).then((t) => parseDolarApiLista(t)).catch((err) => {
      errores.push('euros: ' + (err && err.message ? err.message : err));
      return null;
    }),
  ]);

  if (bcvRes && !bcvRes.ok && bcvRes.error) errores.push('BCV: ' + bcvRes.error);

  const mercado = combinarMercado({
    bcv: bcvRes && bcvRes.ok ? bcvRes.tasa : null,
    paralelo: paraleloRes,
    euroOficial: buscarFuente(eurosRes, 'euro'),
    euroParalelo: buscarFuente(eurosRes, 'paralelo'),
  });

  return { ok: mercado.disponible > 0, mercado, error: errores.length ? errores.join(' · ') : null };
}

// Última tasa del BCV conocida en esta sesión, sin tocar la red.
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

// Cuánto está por encima (o por debajo) una tasa respecto de otra, en porcentaje.
// Ej: el paralelo a 943,89 contra un BCV de 857,01 da +10,1%.
function diferenciaPct(valor, referencia) {
  if (!(valor > 0) || !(referencia > 0)) return null;
  return Math.round(((valor - referencia) / referencia) * 1000) / 10;
}

// Convierte un monto a Bs. Devuelve null si falta la tasa o el monto no es un número.
// Ojo: Number(null) y Number('') dan 0, así que el vacío se filtra a mano; un 0 de verdad
// sí devuelve 0 (convertir cero da cero, no "no se puede").
function convertir(monto, tasa) {
  if (monto === null || monto === undefined || monto === '') return null;
  const m = Number(monto);
  if (!isFinite(m) || !(tasa > 0)) return null;
  return Math.round(m * tasa * 100) / 100;
}

module.exports = {
  BCV_URL,
  DOLARAPI_PARALELO_URL,
  DOLARAPI_EUROS_URL,
  DOLARAPI_OFICIAL_URL,
  parseEsNum,
  isoFecha,
  parseBcvHtml,
  parseDolarApi,
  parseDolarApiLista,
  buscarFuente,
  combinarMercado,
  consultar,
  consultarMercado,
  getCache,
  tasaDeFecha,
  diferenciaPct,
  convertir,
};
