# Notas Tecnicas: Medicion de Gasolina Real

Este documento explica como el dashboard mide el consumo de tokens y por que ignoramos la mayoria del volumen reportado.

---

## El Problema

Claude Code tiene un limite semanal de tokens. Pero ~96% de los tokens reportados son **cacheReadTokens** — lecturas de cache que no consumen cuota real.

Si miras `totalTokens` directamente:
- Los numeros se ven enormes (millones por dia)
- No reflejan el gasto real de cuota
- No sirven para saber si la gasolina te alcanza la semana

## La Solucion: % Oficial via PTY

El dashboard obtiene el **porcentaje oficial** directamente de Claude Code via el comando `/usage` ejecutado en un PTY interactivo (`claude-usage.js`). Este % es la **unica fuente de verdad**.

### Que mide Claude `/usage`

| Metrica | Que es |
|---------|--------|
| `session.percent` | % de la sesion actual (5 horas) |
| `weekAll.percent` | % de la cuota semanal usada (todas las fuentes: CLI, web, API) |
| `weekSonnet.percent` | % semanal solo modelos Sonnet |

### Que tokens consumen cuota

| Tipo | Impacto en cuota |
|------|------------------|
| `outputTokens` | Alto — lo que Claude genera |
| `inputTokens` | Medio — contexto nuevo |
| `cacheCreationInputTokens` | Medio — primera escritura a cache |
| `cacheReadInputTokens` | Ninguno — ~96% del volumen, gratis |

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

**Todo** el dashboard opera en hora Panama (UTC-5). Esto es critico porque las comparaciones de "hoy" y ciclo semanal deben ser consistentes.

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

## Tab Patrones: Curvas de % y Heatmap

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

## Cobertura de Datos

El % de Claude `/usage` es **account-level** — incluye todo el consumo independientemente de la fuente:

| Fuente | Incluida en % | Razon |
|--------|---------------|-------|
| Claude Code (CLI) | Si | Cuenta contra la cuota semanal |
| Claude.ai web | Si | Misma cuenta, misma cuota |
| API calls directas | Si | Misma cuenta |
| Cursor, Continue, etc. | Si | Si usan la misma cuenta |

Esta es la ventaja principal del enfoque PTY: el % oficial ya incluye todo, sin necesidad de parsear logs individuales.

---

*Documento atemporal — Solo metodologia y decisiones de diseño*
