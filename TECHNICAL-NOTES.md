# Notas Tecnicas: cuota oficial y proxy de atribucion

Este documento explica de donde sale el porcentaje de cuota (de `/usage`, oficial) y como se
calcula el proxy con el que ccfuel atribuye el trabajo no-cache (heuristica propia, no una
formula de Anthropic). Son dos cosas distintas y no se mezclan.

---

## El Problema

Claude Code tiene un limite semanal. El CLI te dice **cuanto** queda si tipeas `/usage`, pero no
te dice **en que** se fue. Y los contadores crudos de los transcripts locales estan dominados
por lecturas de cache, asi que sumarlos no sirve para atribuir trabajo: en el corpus medido por
el maintainer, ~96% del volumen de tokens son `cacheReadTokens` (ver "Alcance de la medicion").

Si miras `totalTokens` directamente:
- Los numeros se ven enormes (millones por dia)
- Estan dominados por contexto reusado, no por trabajo nuevo
- No sirven para distinguir en que proyecto se concentro el trabajo

## Dos cosas distintas, y la separacion es el diseño

| | Fuente | Responde | Estatus |
|---|---|---|---|
| **Medidor oficial** | Las cifras de la cuenta, leidas como las lee Claude Code | **cuanto** de la cuota se fue | Autoritativo — el numero de Anthropic |
| **Proxy local de fuel** | Los transcripts de sesion | **donde** se concentro el trabajo no-cache | Heuristica de ccfuel. No es una formula de Anthropic |

El % de `/usage` es la **unica fuente de verdad para la cuota** (`claude-usage.js`). El proxy no
se convierte a % nunca: son unidades distintas.

### Que mide Claude `/usage`

| Metrica | Que es |
|---------|--------|
| `session.percent` | % de la sesion actual (5 horas) |
| `weekAll.percent` | % de la cuota semanal usada (todas las fuentes: CLI, web, API) |
| `weekSonnet.percent` | % semanal solo modelos Sonnet |

### El proxy de fuel: que entra y por que

`fuel = output_tokens + input_tokens + cache_creation_input_tokens`

| Contador | En el proxy | Por que |
|------|------------------|
| `outputTokens` | Si | Contenido generado — nunca viene de cache |
| `inputTokens` | Si | Contexto no cacheado de ese turno |
| `cacheCreationInputTokens` | Si | Escribir al cache es trabajo nuevo, y en la API se cobra *por encima* del input base |
| `cacheReadInputTokens` | No | Contexto reusado. Domina el volumen crudo y tapa la señal |

**Por que se excluyen las lecturas de cache, dicho con precision.** Reusar contexto cacheado
tiene tratamiento favorable: la guia de limites de uso de Anthropic dice que el contenido
cacheado de proyectos "doesn't count against your limits when reused" y que "only new/uncached
portions count against your limits"; y en la API las lecturas de cache se cobran a **0.1x el
precio del input base**, no a precio pleno. Es tratamiento favorable a tarifa reducida, y
Anthropic **no publica** una formula que mapee los cuatro contadores de los transcripts de Claude
Code al porcentaje semanal. El proxy las deja afuera por esas dos razones declaradas —
tratamiento favorable y volumen dominante que tapa la señal — y no afirma nada sobre lo que
Claude Code te cobra.

Fuentes:

- Precios de prompt caching (lecturas a 0.1x input base): <https://platform.claude.com/docs/en/build-with-claude/prompt-caching#pricing>
- Limites de uso y contenido cacheado: <https://support.claude.com/en/articles/9797557-usage-limit-best-practices>

### Metricas derivadas

El dashboard calcula consumo a partir de **deltas entre snapshots de %**:

```
rate = delta_percent / delta_hours    → %/hora actual
projection = rate * hours_remaining   → dia estimado de agotamiento
daily = sum(deltas) por dia           → consumo diario en %
hourly = sum(deltas) por hora         → consumo por franja horaria
```

Ver `computeUsageDeltas()` en `server.js`.

---

## Ciclo Semanal de Claude

La semana de Claude **NO es lunes a domingo**. Es un ciclo rolling de 7 dias que se resetea a una hora especifica cada dia (ej: 10am en el offset configurado). La hora de reset viene del campo `weekAll.resetsAtHour` del output de `/usage`.

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

Esto aplica al **fallback PTY**: por defecto los resets llegan ya como instantes ISO desde `/api/oauth/usage` y no hay nada que parsear (ver `usage-source.js`). El parser PTY (`claude-usage.js`) extrae 3 resets del output de `/usage`. Cada tipo (session, weekAll, weekSonnet) tiene su propio formato y ventana de tiempo.

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

## Timezone: un offset fijo, configurable

**Todo** el dashboard opera en un unico offset respecto de UTC. Esto es critico porque las
comparaciones de "hoy" y el ciclo semanal deben ser consistentes entre capas. El valor sale de
`DASHBOARD_TIMEZONE` y por defecto es `-5`; es un offset, no una timezone, asi que no hay DST.

### Patron centralizado

Una sola fuente, tres consumidores. El backend lee la variable, el frontend la recibe por
`/api/config`, y el parser de `/usage` la usa para interpretar la hora de reset que el panel
imprime sin zona.

Backend (`server.js`):
```javascript
const TZ_OFFSET = parseInt(process.env.DASHBOARD_TIMEZONE || '-5', 10);
const shifted = new Date(now.getTime() + (TZ_OFFSET * 3600000));
```

Frontend (`index.html`):
```javascript
let TZ_OFFSET = -5;  // default, sobreescrito por /api/config
fetch('/api/config').then(r => r.json()).then(cfg => {
  if (cfg.tzOffset != null) TZ_OFFSET = cfg.tzOffset;
});
```

Parser (`claude-usage.js`): `parseUsageOutput(output, tzOffset)` recibe el offset como
argumento — inyectable, por eso los tests son deterministas donde sea que corran.

### Regla clave: usar metodos UTC

Cuando se trabaja con el Date ya desplazado al offset, **siempre usar metodos UTC** (`getUTCDate()`, `setUTCHours()`, `getUTCDay()`, etc). Nunca usar metodos locales (`getDate()`, `setHours()`, `getDay()`), porque estos dependen del timezone del browser o del servidor, y el Date ya esta desplazado.

### Bug corregido: getTimezoneOffset

El frontend originalmente usaba `now.getTimezoneOffset()` para calcular la hora local:

```javascript
// BUG: depende del timezone del browser
const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
const localMs = utcMs + (-5 * 60) * 60000;
```

Esto solo funciona si el browser esta en un timezone con offset consistente. Si el browser esta en UTC, `getTimezoneOffset()` es 0 y el calculo es correcto. Pero si esta en otro timezone con DST, el offset cambia y los calculos fallan.

La solucion es usar **offset directo desde UTC** sin pasar por el timezone del browser:

```javascript
// CORRECTO: directo desde UTC, sin depender del browser
const localMs = new Date().getTime() + (TZ_OFFSET * 3600000);
```

Funciones afectadas y corregidas:
- `getWeekCycleInfo()` — ciclo semanal, pace, reset countdown
- `updatePace()` — fecha de agotamiento proyectada
- Formato de fechas — cambiado de `toLocaleDateString()` a formato manual con `getUTCDate()/getUTCMonth()`

---

## Ventanas de Tiempo

El dashboard opera con 2 ventanas de tiempo distintas. Cada metrica usa una sola ventana y **no deben mezclarse**.

| Ventana | Rango | Metricas que la usan |
|---------|-------|---------------------|
| **Ciclo semanal** | 7 dias rolling, reset a hora especifica (ej: 10am) | Gauges (sesion/semanal), pace, heatmap, comparacion semanal, "What burned it" con `window=cycle` |
| **Calendario** | Ultimos 14 dias / 48h (cortes al offset configurado) | Charts "Daily consumption" y "Hourly consumption" |

### Por que no coinciden los numeros entre charts

Un bloque registrado a las 1pm del dia de reset puede caer en la semana **anterior** (si el reset es a las 3pm) pero en el dia calendario **de hoy**. Esto es correcto — cada ventana agrupa por su propia logica.

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
  "dayNum": 7
}
```

El `weekId` es la fecha de inicio del ciclo (no el dia de la semana tradicional).

---

## Curvas de % y Heatmap

### Heatmap de Intensidad (CSS Grid)

Renderizado como HTML/CSS grid (no Chart.js matrix). Cada celda representa 1 hora de 1 dia del ciclo semanal. Derivado de deltas de % entre snapshots.

**Colores:** Cyan (#22d3ee) con alpha proporcional al consumo relativo. Celdas sin actividad: gris minimo. Dias futuros: casi invisible.

### Comparacion Semana Actual vs Anterior

Chart.js line chart con **% acumulado** (0-100%) por hora del ciclo.

- Curva verde: semana actual
- Curva gris punteada: semana anterior
- Curva morada: pace ideal (lineal)

Datos de `curves` en `/api/usage-deltas`, derivados de snapshots en `data/usage-curve.json`.

### Snapshots de Curva de Uso

Archivo `data/usage-curve.json` con snapshots periodicos del % global.

**Trigger:** Cada fetch exitoso de `/api/global-usage`. La cadencia la fija el auto-collector
(`DASHBOARD_COLLECT_INTERVAL_MIN`, 20 min por defecto); un request HTTP puede adelantarlo, con
cache de 5 min. Despues de `saveWeeklySnapshot()`.

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

## Cobertura de Datos

El % de Claude `/usage` es **account-level** — incluye todo el consumo independientemente de la fuente:

| Fuente | Incluida en % | Razon |
|--------|---------------|-------|
| Claude Code (CLI) | Si | Cuenta contra la cuota semanal |
| Claude.ai web | Si | Misma cuenta, misma cuota |
| API calls directas | Si | Misma cuenta |
| Cursor, Continue, etc. | Si | Si usan la misma cuenta |

Esta es la ventaja principal de leer el medidor oficial en vez de reconstruirlo: el % ya incluye todo, sin necesidad de parsear logs individuales.

---

## Alcance de la medicion

Los numeros de este documento salen de **un corpus propio**, no de una fuente publicada:

| Observacion | Corpus |
|---|---|
| ~96% del volumen de tokens son lecturas de cache | 1.778 sesiones reales, una sola maquina |
| El corte de 10.000 tokens descarta 63% de los archivos y retiene 99,95% del fuel | el mismo corpus |
| Sumar filas en vez de deduplicar por `message.id` inflaba 2,6x | 45.354 filas con `usage` vs 21.351 ids unicos |

Son observaciones de ese corpus, no constantes universales: dependen de como trabaja quien lo
midio (tamaño de contexto, cuantos turnos por sesion, cuanto reuso de cache). Nada en el codigo
depende de esas cifras — el corte de fuel es configurable y el resto son descriptivos. Si medis
tu propio corpus, esperá numeros distintos.

---

*Documento atemporal — Solo metodologia y decisiones de diseño*
