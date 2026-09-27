# Registro de Compras — instrucciones del proyecto

App de escritorio (Electron) para llevar el registro personal de compras, ingresos,
**conversiones entre monedas** y préstamos, en **BTC, USDT, USD y Bs**, con el saldo
desglosado por exchange y la tasa del BCV automática.

Todo es local: sin servidor, sin base de datos, sin cuentas.

## Comandos

En Windows con PowerShell hay que usar **`npm.cmd`**, no `npm` (Error de *Execution Policy*).
`iniciar.bat` e `instalar.bat` ya lo hacen solos.

```bat
npm.cmd start                              :: arranca la app
npm.cmd test                               :: pruebas de la lógica pura (rápido, sin Electron ni npm install)
npm.cmd run smoke                          :: smoke test end-to-end (ventana oculta; necesita npm.cmd install)
npm.cmd run dist                           :: genera release\Registro-de-Compras-Setup.exe (instalador)
instalar.bat                               :: descarga el instalador de la release de GitHub
```

El build es lento la primera vez (descarga Electron y el toolchain de NSIS, ~100 MB) y puede
tardar 10+ minutos. **Córrelo en segundo plano** y ten paciencia; no lo mates por ver que no
avanza, porque en la fase de empaquetado se queda callado varios minutos.

Variables de entorno útiles en desarrollo:
- `REGISTRO_DEBUG=1` → escribe `launch-debug.log` con el ciclo de vida de la ventana.
- `REGISTRO_SMOKE=1` → `main.js` no crea ventana propia (lo usa `smoke.js`).

## Arquitectura (4 capas, sin framework)

```
renderer/index.html + app.js + styles.css   Interfaz (JS plano, sin build step)
        │  window.api.*
        ▼
preload.js                                  contextBridge: única puerta a Node
        │  ipcRenderer.invoke
        ▼
main.js                                     Ventana, persistencia JSON, IPC, instancia única
        │  require
        ▼
core.js  +  bcv.js                          Lógica pura (sin Electron, sin I/O)
```

- **`core.js` no puede hacer `require('electron')` ni tocar el disco.** Es lo que permite
  correr `node test-core.js` sin levantar la app. Toda la lógica de negocio y de formato va aquí.
- **`bcv.js` no puede hacer `require('electron')`.** Solo `https`/`fetch`. Los parsers de
  respuesta son funciones puras y testeables; la capa de red es la única que hace I/O.
- **`main.js`** es dueño del estado: `db = { records, loans, tasas, settings }` y lo persiste
  con `save()` (escritura síncrona a JSON plano).
- **`preload.js`** expone `window.api`. Si agregas un método ahí, agrégalo también como
  `ipcMain.handle` en `main.js` y como stub en `core.js`/`bcv.js` si aplica. Nada más.

## ⚠️ La trampa: lógica duplicada en el renderer

Estos helpers existen **copiados** en `core.js` **y** en `renderer/app.js`:

`num`, `val`, `fmtNumber`/`fmtNum`, `fmtDate`, `addDaysISO`, `daysBetween`, `round2`,
`bsValue`, `calcLoan`/`calcLoanValues`, `loanBs`, `loanStatus`,
y los de conversiones y saldos: `isConversion`, `precioUnitario`, `aplicarMovimiento`,
`saldoVacio`, `holdings`, `precioBtc`, `valorBsSaldo`.

Están duplicados a propósito: el renderer corre en el navegador (sandbox, sin Node), así que
no puede importar `core.js`. **Si cambias uno, cambia el otro en el mismo commit**, o los
totales de la tabla y los del calendario empiezan a dar números distintos.

Preferencia al agregar lógica de negocio nueva: **escríbela en `core.js`, pruébala con
`node test-core.js`, y recién entonces copia/adaptación en `renderer/app.js`.**

### Y la trampa hermana: el nombre de la clave `convierte`

El lado "entregado" de una conversión viaja en la propiedad **`convierte`** (con `i`).
Ya se escribió mal dos veces como `converte`, y el síntoma es silencioso y confuso: el
`moneda` sale bien (viene del default) pero el `monto` llega en 0.

Cuando agregues o renombres una clave que cruza la frontera IPC, grepéala en los dos lados:

```bat
node -e "for(const f of ['core.js','renderer/app.js','main.js']){const t=require('fs').readFileSync(f,'utf8');t.split(/\r?\n/).forEach((l,i)=>{if(/\bconverte\b/.test(l))console.log(f+':'+(i+1),l.trim())})}"
```

Si no imprime nada, el nombre es consistente.

## Reglas de código

- **Idioma**: los textos de interfaz y los comentarios van en **español**. Los nombres de
  identificadores también (`moneda`, `exchange`, `tasaDia`). Sin excepciones.
- **Sin dependencias nuevas** sin avisar antes. Hoy el proyecto tiene 0 dependencias de
  runtime: solo `electron` y `electron-builder` en `devDependencies`.
- **Sin build step**: nada de TypeScript, bundler, transpiler ni framework. Se edita el
  `.js` y se recarga.
- Estilo: 2 espacios, `const`/`let` (nada de `var`), comillas simples, punto y coma.
- Commentarios solo cuando explican *por qué*, no *qué hace el código*.
- Un solo `return` temprano cuando simplifica; evita bloques `if` anidados profundos.

## Modelo de datos (`datos/registro.json`)

```jsonc
{
  "records": [ /* movimientos: Ingreso | Egreso | Conversión */ ],
  "loans":   [ /* préstamos con interés fijo */ ],
  "tasas":   [ /* historial BCV: { fecha, valor, fuente, guardadoEn } */ ],
  "settings": { "tasaReferencia": 0, "tasaFuente": "BCV", "tasaUltimaConsulta": 0, "tasaUltimoError": null }
}
```

Reglas que no hay que romper:

- **Todo registro nuevo pasa por `core.normalizeRecord()`** antes de guardarse. Es la que
  sanea tipos, recorta strings y aplica defaults. Nunca construyas el objeto a mano.
- **Migración hacia adelante, no hacia atrás**: `load()` rellena los campos que falten con
  defaults. Respaldos viejos siempre deben seguir cargando. Agregar un campo a un registro
  implica agregar su default en `load()` o en `normalizeRecord()`.
- **`origenId` encadena los movimientos** (Bs → USDT → ↔ BTC → venta). `core.wouldCreateCycle()`
  impide ciclos A→B→A; toda alta/edición debe pasar por `core.validateRecord()`.
- **`exchange`** es el venue: `Binance | Bybit | OKX | Otro | Ninguno`. `Ninguno` significa
  "no está en ningún exchange" (efectivo en divisas, o Bs en el banco).
- **Una conversión mueve valor, no lo gasta**: su efecto en el total de Bs es 0. Ver
  `core.aplicarMovimiento()`, que es la **única** fuente de verdad de los saldos (la usan los
  totales, la tabla y la pestaña Cartera).

## Tasa del BCV

`bcv.js` consulta el BCV oficial (scraping del HTML de `bcv.org.ve`) y, si falla, cae a
DolarAPI. **El BCV no tiene API pública**: es scraping, así que el parser puede romperse si
cambian la página. Por eso hay dos fuentes y, si ambas fallan, se conserva la última tasa
guardada (nunca se deja al usuario sin tasa).

- `settings.tasaFuente === 'Manual'` significa que el usuario fijó la tasa a mano: el
  auto-refresh **no** debe pisarla.
- Los parsers (`parseBcvHtml`, `parseDolarApi`) son puros y están cubiertos por tests con
  HTML real congelado. Si actualizas uno, actualiza el fixture del test.

## Seguridad

- `webPreferences`: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
  **No los aflojes.** Toda la red pasa por `main.js`.
- `index.html` tiene una CSP estricta (`default-src 'self'`). No agregar `unsafe-eval`,
  `connect-src` remoto ni scripts externos.
- **Nunca** escribir una API key, un `.env` o un token en el repo. `datos/` está en
  `.gitignore` y contiene data privada del usuario.

## Verificación (obligatoria antes de dar algo por terminado)

1. Si tocaste `core.js` o `bcv.js`: `node test-core.js` debe pasar **y** debes agregar al menos
   una prueba por cada función nueva. Cero excusas: `test-core.js` es la red de seguridad de
   este proyecto.
2. Si tocaste `main.js`, `preload.js` o el renderer: `node_modules\.bin\electron.cmd smoke.js`
   debe imprimir `SMOKE_OK`.
3. Si tocaste la UI de arranque: `npm.cmd start` y mirarla con ojos humanos.

`smoke.js` borra `datos/` al empezar y al terminar. **No lo corras si tienes registros reales
sin respaldar** (menú ☰ → Exportar respaldo).

## Publicar una versión

**El `.exe` nunca se commitea.** Pesa ~97 MB y GitHub rechaza con error cualquier archivo de
más de 100 MB; además git guardaría cada build como un blob nuevo y el clone se pondría más
lento con cada versión. El `.exe` va como **adjunto de una release de GitHub** (límite 2 GB):

```bat
npm.cmd run dist
gh release create v1.2.0 release\Registro-de-Compras-Setup.exe --generate-notes
```

`instalar.bat` descarga siempre de `releases/latest/download/...`, así que no hay que tocar
ese archivo al publicar: apunta solo a "la última release".

Reglas al commitear:

- **Nunca** subas `datos/`, `release/` ni `node_modules/`. Ya están en `.gitignore`; antes de
  cada commit revisa `git status` para confirmar que efectivamente no entran.
- La versión va en `package.json`. Súbela antes de crear la release para que el número del
  `.exe` y el tag coincidan.
- Si agregas un archivo nuevo al `.exe`, agrégalo a `build.files` en `package.json`. Si se
  olvida, la app **funciona en desarrollo y se rompe empaquetada** (el síntoma clásico es un
  `require` que no falla hasta que alguien instala de verdad).

## Datos del usuario

`datos/registro.json` es información financiera real e irreemplazable. Antes de tocar el
código que la escribe, verifica que el formato nuevo siga siendo legible por un respaldo viejo
(ver "Migración hacia adelante"). Nunca borres `datos/` a mano, ni la regeneres, ni la
subas a ningún lado.

- `datos/` solo se usa al correr `npm start` / `iniciar.bat` desde la carpeta.
- Los datos reales del usuario están en **`%APPDATA%\Registro de Compras\datos\`** (app
  instalada o `.exe`). `smoke.js` **borra la carpeta `datos/` del repo**, no esa; aun así,
  no corras el smoke test esperando encontrar datos ahí.
- `build.nsis.deleteAppDataOnUninstall` está en `false` **a propósito**: el default de
  electron-builder es `true` y desinstalaría los registros del usuario. Si tocas ese bloque,
  déjalo en `false`.
