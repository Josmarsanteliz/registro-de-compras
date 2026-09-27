# 💰 Registro de Compras

App de escritorio (local) para llevar el registro de compras en **BTC, USDT, USD y Bs**, con pestañas por moneda, **conversiones entre monedas** (swaps), **saldo desglosado por exchange**, **tasa del BCV automática** y control de **préstamos** con interés fijo y vencimientos en el calendario. Interfaz **dark mode minimalista** con toque neumórfico (paleta Floral White · Silver · Charcoal · Carbon Black · Spicy Paprika).

## Instalar

**Si solo quieres usar la app** (no necesitas Node.js ni saber nada de programación):

1. Ve a **[Releases](https://github.com/Josmarsanteliz/registro-de-compras/releases)** y descarga **`Registro-de-Compras-Setup.exe`** (la última versión).
2. Ábrelo. Elige la carpeta de instalación (o deja la que viene por defecto) y dale *Instalar*.
3. Listo: aparece el acceso directo **"Registro de Compras"** en el escritorio y en el Menú Inicio.

**O desde el código** (si clonaste el repositorio):

```bat
git clone https://github.com/Josmarsanteliz/registro-de-compras.git
cd registro-de-compras
instalar.bat
```

`instalar.bat` descarga la última versión publicada y abre el instalador. Si prefieres compilar desde el código, `npm.cmd install` y después `npm.cmd start`.

> Tus datos **nunca** se borran al desinstalar ni al reinstalar: viven en `%APPDATA%\Registro de Compras\datos\registro.json`. Aun así, saca respaldos de vez en cuando (menú ☰ → *Exportar respaldo*).

## Requisitos
- Para **usar** la app: Windows. Nada más.
- Para **desarrollar**: [Node.js](https://nodejs.org) (probado con v24).

> ⚠️ En Windows, si al usar `npm` en PowerShell ves un error de *Execution Policy*, usa siempre `npm.cmd` (los lanzadores `iniciar.bat` e `instalar.bat` ya lo hacen solo).

## Cómo usarla
1. **[Instalada]** Doble clic en el acceso directo **"Registro de Compras"** del escritorio o del Menú Inicio.
   - **[Desde el código]** Doble clic en **`iniciar.bat`**.
2. La app **abre directo** (sin contraseña). Pestañas **Todo / BTC / USDT / USD / Bs / 💼 Cartera / 🏦 Préstamos / 🗓️ Calendario**: cada una muestra solo sus registros y totales. "Todo" muestra el panorama completo.
3. Solo se abre **una ventana**: si vuelves a dar clic estando abierta, simplemente se enfoca.

## Funciones
- **+ Nuevo registro**: tipo (🔴 egreso / 🟢 ingreso / ↔ conversión), fecha, concepto, categoría, moneda, monto, tasa del día (se llena sola con la del BCV), ¿spot?, precio de compra, Bs involucrados, exchange destino (Binance/Bybit/OKX/Otro/Ninguno), notas.
- **↔ Conversión**: cuando no es compra ni gasto, sino un cambio de moneda (tienes USDT y compras BTC a cierto precio). Registras **lo que entregas** y **lo que recibes**, y la app calcula el precio unitario solo. Ej: `1.000 USDT → ₿0,01234 @ 81.037 USDT/BTC`.
  - Contablemente el saldo de USDT **baja** 1.000 y el de BTC **sube** 0,01234, pero el **total en Bs no se altera**: el valor se movió de un lado a otro en vez de gastarse. Por eso en la tabla sale con punto gris (ni rojo ni verde) y la tarjeta de Bs aclara cuántas conversiones hay.
  - El swap ocurre dentro de un exchange: lo que entra y lo que sale se cuentan en la **misma** plataforma.
- **💼 Cartera**: tu saldo real de BTC / USDT / USD / Bs **desglosado por exchange**, derivado de los registros (sin claves de API ni conexiones a Binance/Bybit/OKX). Lo que no está en una plataforma (efectivo en divisas, o Bs en el banco) aparece como **"Efectivo / bancos"**. Cada tarjeta muestra su `≈ Bs` y un botón *Ver movimientos* que filtra la tabla por ese exchange.
  - El `≈ Bs` del BTC usa **tu último precio registrado** (de una compra o de una conversión), no un mercado de precios: es una estimación sobre lo que tú pagaste.
- **🏦 Préstamos**: registra cuánto pediste (ej. **60 USD**), con **interés fijo del 10 %** (6 USD) y plazo de **14 días** → la app calcula **66 USD a pagar** y la fecha de vencimiento. Al guardarlo crea un registro de **Ingreso** automáticamente (encadenado), y al marcarlo como **pagado** crea el **Egreso** por el total, con los Bs calculados por la **tasa BCV**. Tarjetas de deuda pendiente, interés y próximo vencimiento; estados: vencido / vence hoy / pendiente / pagado (con opción de deshacer).
- **🗓️ Calendario**: vista de mes con los días donde hubo ingresos (🟢 +n), egresos (🔴 −n), conversiones (↔ n) y **vencimientos de préstamos (🏦)**; debajo, las notas día por día que reflejan lo mismo del calendario, incluyendo cada préstamo que vence (monto, interés y estado). Clic en un día → resáltalo y "Ver en la lista" para filtrar la tabla a esa fecha.
- **Totales netos**: por moneda y total ≈ en Bs calculados como **Ingresos − Egresos** (con signo), usando la tasa de cada registro o la del BCV. Las conversiones mueven saldos entre monedas pero **no entran** en el total en Bs.
- **Filtros**: buscar por texto, categoría, exchange y rango de fechas.
- **Respaldo**: menú ☰ → Exportar respaldo (archivo JSON), Importar respaldo y Exportar CSV (compatible con Excel; incluye la columna Tipo y una sección de Préstamos).
- **Diseño**: paleta dark (Carbon Black `#252422`, Charcoal `#403d39`, Silver `#ccc5b9`, Floral White `#fffcf2`, Spicy Paprika `#eb5e28`), tarjetas y botones neumórficos, logo de la app en el encabezado.

## Tasa del BCV
- Al abrir la app se consulta **sola** la tasa oficial del BCV y queda como *tasa de referencia*, para que los registros y préstamos que no tienen tasa propia se calculen solos.
- Botón **↻ BCV** junto a cada campo de tasa para consultarla a mano, y menú ☰ → **Tasa del BCV** para ver la tasa actual, su fuente, cuándo se consultó, el historial y cambiar entre **Automática** y **Manual** (en Manual la app nunca vuelve a tocar la tasa).
- **Fuentes**: primero el BCV oficial; si su página no se puede leer, cae a **DolarAPI**. Si ambas fallan se conserva la última tasa buena y solo se avisa — nunca te quedas sin tasa.
- La tasa se guarda en un historial (una por fecha) dentro del respaldo JSON.

## Datos y seguridad
- Los datos se guardan en JSON (legible) en **`datos\registro.json`** (al correr la app desde la carpeta con `iniciar.bat`), o en **`%APPDATA%\Registro de Compras\datos\registro.json`** (al usar el instalador o el `.exe`). Todo es local y sin cifrado: **no compartas esos archivos**.
- La carpeta `datos\` está en `.gitignore` a propósito: **tus movimientos financieros nunca se suben al repositorio**. Lo que se sube es solo el código.
- Haz respaldos seguido: menú ☰ → *Exportar respaldo*, o copia la carpeta `datos\`.

## Estructura
```
compras\
├── main.js          → ventana, persistencia (JSON), IPC, instancia única
├── preload.js       → API segura para la interfaz
├── core.js          → lógica pura (validaciones, cadena, conversiones, saldos, CSV)
├── bcv.js           → tasa del BCV (parsers puros + red, con DolarAPI de respaldo)
├── AGENTS.md        → instrucciones del proyecto para el agente
├── test-core.js     → pruebas: node test-core.js
├── smoke.js         → prueba end-to-end de la app
├── renderer\        → interfaz (index.html, styles.css, app.js)
├── renderer\assets\ → logo de la app (logo.png)
├── datos\           → registro.json (se genera solo; NO se sube al repo)
├── iniciar.bat      → lanzador para correr la app desde el código
├── instalar.bat     → descarga el instalador desde la release de GitHub
└── release\         → aquí se genera el instalador (NO se sube al repo)
```

## Comandos
```bat
npm.cmd start                  :: inicia la app
npm.cmd run dist               :: genera release\Registro-de-Compras-Setup.exe (instalador)
node test-core.js              :: corre las pruebas de la lógica
node_modules\.bin\electron.cmd smoke.js   :: corre el smoke test
```

## Publicar una versión nueva

El `.exe` **no** se sube a git (pesa ~97 MB y GitHub bloquea archivos de más de 100 MB).
Va como adjunto de una *release*, que admite hasta 2 GB:

```bat
npm.cmd run dist
gh release create v1.2.0 release\Registro-de-Compras-Setup.exe --generate-notes
```

Mientras no publiques una release nueva, `instalar.bat` sigue descargando la última que exista.