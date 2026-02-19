# Notas Tecnicas: Medicion de Gasolina Real

Este documento explica como el dashboard mide el consumo de tokens y por que ignoramos la mayoria del volumen reportado.

---

## El Problema

ccusage reporta `totalTokens` por dia y por bloque. Pero ~96% de esos tokens son **cacheReadTokens** (o `cacheReadInputTokens` en bloques), que son lecturas de cache que no consumen cuota real.

Si muestras `totalTokens` directamente:
- Los numeros se ven enormes (millones por dia)
- No reflejan el gasto real de cuota
- No sirven para saber si la gasolina te alcanza la semana

## La Solucion: Gasolina Real

### Que SI consume cuota (gasolina real)

| Campo ccusage | Que es | Impacto en cuota |
|---------------|--------|------------------|
| `outputTokens` | Lo que Claude genera como respuesta | Alto — es la operacion mas cara |
| `inputTokens` | Contexto nuevo que Claude tiene que procesar | Medio — cada mensaje nuevo |
| `cacheCreationInputTokens` | Primera vez que algo entra al cache | Medio — se paga una vez |

### Que NO consume cuota (ruido)

| Campo ccusage | Que es | Impacto en cuota |
|---------------|--------|------------------|
| `cacheReadInputTokens` | Re-leer algo que ya esta en cache | Ninguno — gratis o ~10% del costo |

### Proporcion real observada

En datos tipicos de uso:
- cacheReadTokens: **~96%** del totalTokens
- Tokens reales (output + input + cacheCreation): **~4%** del totalTokens

Mostrar `totalTokens` infla las cifras 25x vs la gasolina real.

---

## Formulas

### En datos diarios (daily)

ccusage daily reporta por dia: `totalTokens`, `cacheReadTokens`, `cacheCreationTokens`, `totalCost`.

```
realTokensDaily = totalTokens - cacheReadTokens
```

### En datos de bloques (blocks)

ccusage blocks reporta por bloque: `totalTokens`, `costUSD`, y un objeto `tokenCounts` con los detalles.

```
realTokensBlock = totalTokens - tokenCounts.cacheReadInputTokens
```

> **Nota:** Los nombres y estructura difieren entre daily y blocks:
> - Daily: `cacheReadTokens` a nivel raiz del objeto
> - Blocks: `tokenCounts.cacheReadInputTokens` (anidado dentro de `tokenCounts`)

---

## Alineacion con Claude /usage

Claude tiene su propio sistema de medicion de cuota, accesible via el comando `/usage`. Retorna:

- `session.percent` — % de la sesion actual (5 horas)
- `weekAll.percent` — % de la cuota semanal usada (todas las fuentes)
- `weekSonnet.percent` — % semanal solo modelos Sonnet

El dashboard usa `weekAll.percent` como **fuente de verdad**. Los tokens reales calculados con ccusage son una aproximacion complementaria, pero el % de Claude es lo oficial.

### Estimacion de cuota total

```
estimatedAllocation = combinedRealTokens / (weekPercent / 100)
```

Esto es una aproximacion. Si Claude dice 40% usado y nosotros medimos 10M tokens reales, entonces el total estimado es ~25M tokens. Pero es impreciso porque:
- Claude puede medir de forma diferente (pesos distintos por modelo)
- Hay fuentes que ccusage no captura (Claude.ai web, API directa)

---

## Fuentes de Datos y Merge

### Local (maquina principal)

ccusage parsea `~/.claude/*.jsonl` directamente en la maquina donde corre el dashboard. Datos frescos cada 5 min.

### Remoto (maquinas adicionales, opcional)

`push-usage.sh` ejecuta ccusage en la maquina remota y envia JSON via POST:

```
POST /api/external-usage
{
  "source": "laptop",
  "blocks": { "blocks": [...] },
  "daily": { "daily": [...] }
}
```

Guardado en `data/external/<source>.json`. El frontend hace merge sumando local + remotos.

### Merge en charts

- **Chart diario**: Para cada fecha, suma `realTokens` de local + `realTokens` de cada fuente remota
- **Chart horario**: Agrega bloques por hora del dia (timezone Panama UTC-5), local + remotos stacked
- **Stats cards**: Suma gasolina real de todas las fuentes

---

## Ciclo Semanal de Claude

La semana de Claude **NO es lunes a domingo**. Es un ciclo rolling de 7 dias que se resetea a una hora especifica cada dia (ej: 10am Panama). La hora de reset viene del campo `weekAll.resetsAtHour` del output de `/usage`.

### Calculo del ciclo

```
resetHour = weekAll.resetsAtHour (ej: 10 = 10am)
nextReset = hoy a resetHour, o manana si ya paso
cycleStart = nextReset - 7 dias
elapsedDays = (ahora - cycleStart) en dias (fraccionario)
dayNum = ceil(elapsedDays), max 7
```

Tanto `server.js` como `index.html` usan esta misma logica (ver `getWeekCycleInfo()` en ambos).

### Parsing de resets: por seccion, no por posicion

El parser PTY (`claude-usage.js`) extrae 3 resets del output de `/usage`. Cada tipo (session, weekAll, weekSonnet) tiene su propio formato y ventana de tiempo.

**Metodo:** El texto limpio del PTY se divide en secciones usando los headers "Current session", "Current week (all models)", "Current week (Sonnet only)". Cada seccion se parsea independientemente para su porcentaje y tiempo de reset. Esto evita que un reset no-parseado desplace a los demas.

**Formato de hora variable:** El PTY a veces muestra "4:59pm" y a veces redondea a "5pm" (sin minutos). El regex acepta ambos formatos: `(\d{1,2})(?::(\d{2}))?\s*(am|pm)`.

**Persistencia:** `data/resets-cache.json` guarda el ultimo `resetsAt` valido por seccion. Si el PTY no logra parsear un reset, se reutiliza el valor persistido (siempre que no haya expirado). Esto protege contra garbling intermitente del PTY.

### Ejemplo

Si Claude dice "resets at 10am" y hoy es miercoles 11 feb a las 7pm:
- nextReset = jueves 12 feb 10am
- cycleStart = jueves 5 feb 10am
- elapsedDays = ~6.4
- dayNum = 7

---

## Timezone: Panama (UTC-5)

**Todo** el dashboard opera en hora Panama (UTC-5). Esto es critico porque ccusage reporta fechas en la zona local donde corre, y las comparaciones de "hoy" y ciclo semanal deben coincidir.

### Patron centralizado

Frontend (`index.html`):
```javascript
const PANAMA_OFFSET = -5;

function getPanamaDate(date) {
  const d = date || new Date();
  return new Date(d.getTime() + (PANAMA_OFFSET * 3600000));
}

function getPanamaTodayISO() {
  return getPanamaDate().toISOString().split('T')[0];
}
```

Backend (`server.js`):
```javascript
const panamaMs = now.getTime() + (-5 * 60 * 60 * 1000);
const panama = new Date(panamaMs);
```

### Regla clave: usar metodos UTC

Cuando se trabaja con el Date panama-shifted, **siempre usar metodos UTC** (`getUTCDate()`, `setUTCHours()`, `getUTCDay()`, etc). Nunca usar metodos locales (`getDate()`, `setHours()`, `getDay()`), porque estos dependen del timezone del browser o del servidor, y el Date ya esta shifted a Panama.

### Bug corregido: getTimezoneOffset

El frontend originalmente usaba `now.getTimezoneOffset()` para calcular Panama time:

```javascript
// BUG: depende del timezone del browser
const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
const panamaMs = utcMs + (-5 * 60) * 60000;
```

Esto solo funciona si el browser esta en un timezone con offset consistente. Si el browser esta en UTC, `getTimezoneOffset()` es 0 y el calculo es correcto. Pero si esta en otro timezone con DST, el offset cambia y los calculos fallan.

La solucion es usar **offset directo desde UTC** sin pasar por el timezone del browser:

```javascript
// CORRECTO: directo desde UTC, sin depender del browser
const panamaMs = new Date().getTime() + (PANAMA_OFFSET * 3600000);
```

Funciones afectadas y corregidas:
- `getWeekCycleInfo()` — ciclo semanal, pace, reset countdown
- `getBillingCycleDates()` — ciclo de facturacion mensual
- `updatePace()` — fecha de agotamiento proyectada
- Formato de fechas — cambiado de `toLocaleDateString()` a formato manual con `getUTCDate()/getUTCMonth()`

---

## Ventanas de Tiempo

El dashboard opera con 3 ventanas de tiempo distintas. Cada metrica usa una sola ventana y **no deben mezclarse**.

| Ventana | Rango | Metricas que la usan |
|---------|-------|---------------------|
| **Ciclo semanal** | 7 dias rolling, reset a hora especifica (ej: 10am) | Gauges (sesion/semanal), pace, heatmap, comparacion semanal |
| **Ciclo facturacion** | Mensual (ej: 2 feb → 2 mar) | Dias restantes, Tokens Ciclo (tab Eficiencia) |
| **Calendario** | Ultimos 14 dias (medianoche a medianoche) | Chart "Consumo Tokens por Dia", chart "Tokens por Franja Horaria" |

### Por que no coinciden los numeros entre charts

Un bloque registrado a las 1pm del dia de reset puede caer en la semana **anterior** (si el reset es a las 3pm) pero en el dia calendario **de hoy**. Esto es correcto — cada ventana agrupa por su propia logica.

---

## Pace Semanal

Compara tokens reales consumidos en la semana actual vs la semana anterior, al mismo punto del ciclo.

### Calculo

```
currentCurve = computeWeeklyCurve(allBlocks, cycleStart, nextReset)  // 168 buckets
prevCurve = computeWeeklyCurve(allBlocks, cycleStart - 7d, cycleStart)

elapsedHours = floor(elapsedDays * 24)
currentTokensAtNow = currentCurve[elapsedHours - 1]
prevTokensAtNow = prevCurve[elapsedHours - 1]
tokenDiffPct = (current - prev) / prev * 100
```

### Clasificacion

| tokenDiffPct | Estado | Color |
|-------------|--------|-------|
| <= -20% | Por debajo | Verde |
| -20% a +20% | Similar | Verde |
| +20% a +50% | Por encima | Naranja |
| > +50% | Muy por encima | Rojo |

### Barra visual

Escala = `max(current, prev) * 1.15` (15% headroom). Barra solida = semana actual. Marcador punteado = semana anterior al mismo punto.

### Nota importante

El pace usa tokens de ccusage (solo logs JSONL), **no** `weekAllPercent` de Claude `/usage`. Mezclar ambas fuentes produce discrepancias porque `/usage` incluye web y API que ccusage no ve.

---

## Eficiencia Semanal

Los tokens de Claude no se acumulan — lo que no usas en la semana se pierde al reset. Por eso medimos eficiencia como:

```
eficiencia = 100% - weekPercent (lo que queda disponible)
```

### Colores relativos al ciclo

Los colores de eficiencia son relativos al progreso esperado, no umbrales absolutos:

```
expectedPercent = (elapsedDays / 7) * 100
paceRatio = weekPercent / expectedPercent
```

- paceRatio <= 1.15: Verde (on track o por debajo)
- paceRatio <= 1.50: Amarillo (acelerado)
- paceRatio > 1.50: Rojo (critico)

> **Nota:** `elapsedDays` es fraccionario (ej: 6.4), no un entero de dia de semana.

### Historial semanal

Cada vez que se consulta `/api/global-usage` con datos frescos, se guarda un snapshot en `data/weekly-history.json`:

```json
{
  "weekId": "2026-02-05",
  "weekPercent": 85,
  "vpsTokens": 5702615,
  "extTokens": 3030476,
  "combinedTokens": 8733091,
  "estimatedAllocation": 10274225,
  "dayNum": 7
}
```

El `weekId` es la fecha de inicio del ciclo (no el dia de la semana tradicional).

---

## Tab Patrones: Heatmap y Comparacion Semanal

### Heatmap de Actividad (CSS Grid)

Renderizado como HTML/CSS grid (no Chart.js matrix — ese plugin no alineaba las celdas correctamente). Cada celda representa 1 hora de 1 dia del ciclo semanal.

**Funcion:** `buildHeatmapMatrix(allBlocks, cycleStartISO)` → matriz 7x24

**Logica por bloque:**
1. Convertir `block.startTime` a hora Panama via `getPanamaDate()`
2. Calcular dia del ciclo: `floor((blockPanama - cycleStartPanama) / 1 dia)` → 0-6
3. Extraer hora: `blockPanama.getUTCHours()` → 0-23
4. Sumar `blockRealTokens(block)` a `matrix[day][hour]`

**Colores:** Verde (#4ade80) con alpha proporcional a `val / maxVal`. Celdas sin actividad: gris minimo. Dias futuros: casi invisible.

**Combina:** Local + remoto (todos los bloques mezclados antes de construir la matriz).

### Comparacion Semana Actual vs Anterior

Chart.js line chart con tokens **acumulados** por hora del ciclo.

**Funcion:** `computeWeeklyCurve(allBlocks, weekStartISO, weekEndISO)` → array de 168 valores

**Logica:**
1. Crear 168 buckets (7 dias x 24h), cada uno = tokens de esa hora
2. Filtrar bloques en el rango [weekStartISO, weekEndISO)
3. Asignar cada bloque al bucket correspondiente segun hora transcurrida desde weekStart
4. Convertir a acumulado (cada bucket = suma de todos los anteriores + propio)

**Semana anterior:** Se calcula `prevStart = cycleStart - 7 dias`. Si no hay datos previos, solo muestra curva actual con mensaje "Primera semana registrada".

**Summary:** Muestra comparacion textual al punto actual: "A las Xh: Y esta semana vs Z anterior (+/-N%)"

### Snapshots de Curva de Uso

Archivo `data/usage-curve.json` con snapshots periodicos del % global.

**Trigger:** Cada fetch exitoso de `/api/global-usage` (cada ~5 min). Despues de `saveWeeklySnapshot()`.

**Estructura por snapshot:**
```json
{
  "timestamp": "ISO datetime",
  "weekId": "YYYY-MM-DD (inicio del ciclo)",
  "weekPercent": 8,
  "sessionPercent": 60,
  "elapsedHours": 6.5,
  "dayNum": 1
}
```

**Poda:** Elimina entries con timestamp > 28 dias.

**Uso futuro:** Graficari curva de % a lo largo de la semana, comparar perfil de uso vs semana anterior a nivel de porcentaje (complementa la comparacion de tokens).

---

## Que NO Capturamos

| Fuente | Visible | Razon |
|--------|---------|-------|
| Claude Code local | Si | Logs locales en ~/.claude/ |
| Claude Code remoto | Si | Sync via push-usage.sh (opcional) |
| Claude.ai web | No | No genera logs JSONL |
| API calls directas | No | No pasan por Claude Code |
| Cursor, Continue, etc. | No | Apps terceras no generan logs compatibles |

El % de Claude `/usage` SI incluye todo (web, API, etc), por eso es la fuente de verdad para el % semanal.

---

*Documento atemporal — Solo metodologia y decisiones de diseño*
