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
core.js  +  mercado.js                      Lógica pura (sin Electron, sin I/O)
```

- **`core.js` no puede hacer `require('electron')` ni tocar el disco.** Es lo que permite
  correr `node test-core.js` sin levantar la app. Toda la lógica de negocio y de formato va aquí.
- **`mercado.js` no puede hacer `require('electron')`.** Solo `https`. Los parsers de
  respuesta son funciones puras y testeables; la capa de red es la única que hace I/O.
  Trae cuatro tasas de dos fuentes distintas (BCV oficial y DolarAPI), y está documentado
  más abajo por qué no se puede usar DolarAPI para la tasa oficial.
- **`main.js`** es dueño del estado: `db = { records, loans, tasas, settings }` y lo persiste
  con `save()` (escritura síncrona a JSON plano).
- **`preload.js`** expone `window.api`. Si agregas un método ahí, agrégalo también como
  `ipcMain.handle` en `main.js` y como stub en `core.js`/`mercado.js` si aplica. Nada más.

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
  "mercado": [ /* una fila por día: { fecha, bcv, paralelo, euroOficial, euroParalelo, guardadoEn } */ ],
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

## Tasa del BCV y mercado

### Por qué el BCV se lee del HTML y no de DolarAPI

El BCV no publica API pública, así que su tasa se saca del HTML de la portada con un regex. Y
**DolarAPI no sirve para la tasa oficial**: la devuelve con varios días de atraso (se ha visto
el oficial del 25 mientras el BCV real ya daba el del 28). Por eso el BCV se lee directo de
`bcv.org.ve` y de DolarAPI solo se toman el paralelo y los euros.

Cada tasa lleva su `fecha`, y la interfaz **avisa cuando un dato tiene más de 24 horas** en vez
de presentarlo como si fuera de hoy. No lo quites: es la diferencia entre informar y engañar.

Un resultado parcial es mejor que un error: `consultarMercado()` devuelve las tasas que logró
traer y deja en `null` las que fallaron.

### Tabla de lo que trae cada fuente

| Tarjeta | Fuente | Endpoint |
|---|---|---|
| BCV (oficial) | bcv.org.ve | HTML, bloque `id="dolar"` |
| Dólar paralelo | DolarAPI | `/v1/dolares/paralelo` |
| Euro oficial | DolarAPI | `/v1/euros` (el ítem "Euro") |
| Euro paralelo | DolarAPI | `/v1/euros` (el ítem "Paralelo") |

## La tasa de referencia

Además de la pestaña de mercado, el BCV alimenta la **tasa de referencia** con la que se
calculan los registros que no traen tasa propia.

- `settings.tasaFuente === 'Manual'` significa que el usuario fijó la tasa a mano: el
  auto-refresh **no** debe pisarla.
- Los parsers (`parseBcvHtml`, `parseDolarApiLista`) son puros y están cubiertos por tests con
  HTML y JSON reales congelados. Si actualizas uno, actualiza el fixture del test.
- `db.tasas` (historial del BCV) y `db.mercado` (una fila por día con las cuatro tasas) son
  cosas separadas: la tasa del BCV a veces es del día siguiente y mezclarla con el paralelo
  etiquetaría mal las fechas.

### Trampa: las barras invertidas dentro de `executeJavaScript`

En `smoke.js` el código de la página va dentro de un **template literal**. Ahí `\D` no es un
escape válido: la barra se pierde y el regex llega a la página como `/D/g`, que no quita
nada. Hay que escribir `\\D`. Pasa igual con cualquier `\\`. Si una aserción falla por
cuestiones de formato raro, sospechá de esto primero.

### Trampa: `ok()` sin `failures.push()` no hace fallar el smoke

`ok('nombre', cond)` solo anota `FALLO` en `out.steps`: el proceso **igual imprime
`SMOKE_OK`**. Para que una comprobación haga fallar el smoke tiene que estar además en la
lista `failures` del final. Cuando agregues una comprobación, agregá las dos cosas, o te vas
a creer que el test pasa cuando en realidad no miró nada.

Relacionado: `$` es `querySelector` (un elemento) y `$$` es `querySelectorAll` (una lista).
Escribir `$('...').length` devuelve `undefined` **en silencio**, y la aserción falla sin que
nadie entienda por qué.

## Seguridad

- `webPreferences`: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
  **No los aflojes.** Toda la red pasa por `main.js`.
- `index.html` tiene una CSP estricta (`default-src 'self'`). No agregar `unsafe-eval`,
  `connect-src` remoto ni scripts externos.
- **Nunca** escribir una API key, un `.env` o un token en el repo. `datos/` está en
  `.gitignore` y contiene data privada del usuario.

## Verificación (obligatoria antes de dar algo por terminado)

1. Si tocaste `core.js` o `mercado.js`: `node test-core.js` debe pasar **y** debes agregar al menos
   una prueba por cada función nueva. Cero excusas: `test-core.js` es la red de seguridad de
   este proyecto.
2. Si tocaste `main.js`, `preload.js` o el renderer: `node_modules\.bin\electron.cmd smoke.js`
   debe imprimir `SMOKE_OK`.
3. Si tocaste la UI de arranque: `npm.cmd start` y mirarla con ojos humanos.

`smoke.js` borra `datos/` al empezar y al terminar. **No lo corras si tienes registros reales
sin respaldar** (menú ☰ → Exportar respaldo).

## Publicar una versión

### Tamaño del `.exe`

Electron pesa lo que pesa. Lo que sí se controla:

- `build.electronLanguages: ["es", "en-US"]` quita los otros 53 idiomas: **ahorra ~47 MB**.
  No lo quites pensando "es solo un archivo de 687 KB": son 48 MB en total.
- El target `portable` se eliminó a propósito: eran 107 MB de un segundo `.exe` que nadie
  usaba. Si lo vuelves a agregar, recuerda que `npm run dist` debe ser `--win` **a secas**:
  pasarle `--win nsis` por consola pisa el `target` del `package.json` y el otro target no se
  construye.
- `release\win-unpacked\` es un intermedio de 369 MB que se regenera solo. Bórralo después
  de compilar.
- El piso real es el runtime de Electron (~235 MB en el `.exe` principal). Para llegar a 10 MB
  habría que reescribir la app en otro framework: no vale la pena para una herramienta personal.

**El `.exe` nunca se commitea.** Pesa más de 100 MB y GitHub rechaza con error cualquier archivo de
más de 100 MB; además git guardaría cada build como un blob nuevo y el clone se pondría más
lento con cada versión. El `.exe` va como **adjunto de una release de GitHub** (límite 2 GB):

```bat
npm.cmd run dist
gh release create v1.2.0 "release\Registro-de-Compras-Setup.exe" --generate-notes
```

`instalar.bat` descarga siempre de `releases/latest/download/...`, así que no hay que tocar
ese archivo al publicar: apunta solo a "la última release".

### Trampa: `instalar.bat` NO debe descargar en `release\`

`release\` es la carpeta de salida **del build**. Si `instalar.bat` descarga ahí, en el propio
repo el archivo ya existe, el `if exist` se lo salta y termina ejecutando el **binario viejo
del build** en vez del publicado (que fue exactamente el bug que pasó). Además, 107 MB sin
barra de progreso hacen que el usuario cierre la consola y se vaya sin instalar nada.

Por eso descarga en `%LOCALAPPDATA%\Registro de Compras\instalador\`, usa `curl.exe` (que ya
viene en Windows y sí muestra progreso) y siempre imprime ruta, tamaño y fecha de lo que va a
ejecutar. Si tocas ese archivo, conserva esas tres cosas.

Además, `.bat` es un lenguaje de shell con trampas: los signos `%` se escriben `%VARIABLE%`,
no `%%VARIABLE%%` (con doble % se imprime literal), y dentro de un `for` la variable del
bucle sí es `%%A`. No copies sintaxis de bash.

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
- `build.nsis.perMachine: false` **y `allowElevation: false`**. Con `oneClick: false` y solo
  `perMachine: false` el asistente igual ofrecía instalar "para todos los usuarios": metía el
  uninstall en `HKLM` con `/allusers`, dejaba la app en `C:\Program Files`, pedía
  administrador, y el acceso directo caía en `C:\Users\Public\Desktop` en vez del escritorio
  del usuario. `allowElevation: false` cierra esa puerta: instala siempre en
  `%LOCALAPPDATA%\Programs` sin pedir permisos. **No lo quites** salvo que quieras
  deliberadamente la instalación para todo el sistema.
- Al verificar una instalación, mira **las tres** cosas: carpeta en
  `%LOCALAPPDATA%\Programs\Registro de Compras`, clave de desinstalación en el registro, y el
  `.lnk` en el escritorio del usuario. Con que falte una, la instalación está incompleta.
