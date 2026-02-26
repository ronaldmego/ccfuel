# Changelog

## 2026-02-26

### Refactor: Dashboard 100% basado en deltas de % (sin ccusage)

**Cambio mayor:** El dashboard ahora opera exclusivamente con snapshots de `Claude /usage` via PTY. Se elimino toda dependencia de ccusage, datos externos (laptop sync), y metricas basadas en tokens.

**Backend (`server.js`):**
- Eliminado: `runCcusage()`, `updateCache()`, `getWeekTokensFromBlocks()`, directorio `data/external/`
- Nuevo: `computeUsageDeltas()` — calcula consumo derivado de deltas entre snapshots de % (rate, projection, daily, hourly, heatmap, curves por semana)
- Nuevo endpoint: `GET /api/usage-deltas` — retorna todas las metricas derivadas
- Nuevo endpoint: `GET /api/config` — retorna timezone

**Frontend (`public/index.html`):**
- Nuevo tab **Consumo** (principal): ritmo actual (%/hora), proyeccion de agotamiento, consumo diario (barras con colores por nivel), consumo por hora (48h), heatmap de intensidad (cyan)
- Tab **Patrones**: ahora usa curvas de % acumulado (0-100%) en vez de tokens acumulados
- Tab **Eficiencia**: simplificado a 3 columnas (semana, dia, % usado), sin tokens
- Eliminados: charts de tokens, pace token-based, datos VPS+Laptop, ciclo de facturacion
- Leyenda de colores en chart de Consumo Diario: cyan (≤10%), amarillo (>10%), rojo (>15%)

**Docs (`CLAUDE.md`):**
- Actualizado para reflejar arquitectura sin ccusage
- Endpoints, metricas y estructura de archivos actualizados

## 2026-02-21

### Fix: Dashboard muestra 0% intermitentemente (#12)

**Problema:** El dashboard mostraba 0% en todas las métricas de forma intermitente. Refrescar el navegador a veces lo arreglaba y otras no.

**Causa:** El frontend hacía un solo fetch a `/api/global-usage` al cargar. Si la API respondía con data vacía (cache expirado, respuesta parcial, o API lenta), mostraba 0% sin reintentar.

**Fix:** Retry con 3 intentos y 2s de espera en `loadGlobalUsage()`. Si después de 3 intentos falla, muestra mensaje de error en vez de 0% silencioso.

**Issue:** https://github.com/ronaldmego/claude-code-usage-dashboard/issues/12

---

## 2026-02-17

### Fix: Reset de sesion mostraba fecha del reset semanal (#1)

**Problema:** Los 3 KPIs de "Uso Global" mostraban la misma fecha de reset (feb 19). El reset de sesion (ej: 4:59pm hoy) no se mostraba — en su lugar aparecia el reset semanal.

**Causa 1 — Parsing posicional:** El parser capturaba todos los "Resets ..." globalmente y los asignaba por indice (`resets[0]` = session, `resets[1]` = weekAll). Si el PTY garbleaba el reset de sesion y el regex no lo capturaba, los demas se corrian un lugar. Los valores incorrectos se persistian en `resets-cache.json`.

**Causa 2 — Minutos opcionales:** El PTY a veces redondea y omite minutos ("5pm" en vez de "4:59pm"). El regex exigia `:MM` obligatorio, causando que ningun reset matcheara.

**Fix (`claude-usage.js`):**
- Parsing por seccion: divide el texto PTY por headers ("Current session", "Current week (all models)", "Current week (Sonnet only)") y parsea cada seccion independientemente
- Regex con minutos opcionales: `(\d{1,2})(?::(\d{2}))?\s*(am|pm)` — si no hay minutos, default `:00`

## 2026-02-13

### Mejora: Pace semanal basado en semana anterior

El indicador "Pace semanal" ahora compara tokens reales contra la semana anterior (misma fuente que el chart de Patrones), en vez de una proyeccion lineal. Muestra barra de progreso con marcador punteado de la semana pasada y diferencia porcentual.

### Mejora: Reorganizacion de paneles

- **Overview** simplificado: solo gauges (sesion + semanal), pace, y charts de tokens. Eliminados cards "Gastado Hoy" y "Promedio Diario" (redundantes con charts).
- **Eficiencia** ampliado: recibe la barra de ciclo de facturacion (Dias Restantes + Tokens Ciclo) que antes estaba en Overview.
- Colores de eficiencia ahora relativos al progreso del ciclo (no umbrales absolutos).

### Mejora: Claridad en metricas

- Renombrados charts: "Gasolina Diaria Real" → "Consumo Tokens por Dia", "Gasolina por Franja Horaria" → "Tokens por Franja Horaria".
- Notas aclaratorias bajo charts que usan ventanas de tiempo distintas al ciclo semanal.
- Eliminada proyeccion de agotamiento (imprecisa con datos de una sola semana).

## 2026-02-12

### Feature: Tab Patrones (heatmap + comparacion semanal)

**Heatmap de actividad:** Grilla 7x24 (dias del ciclo x horas del dia) renderizada con CSS grid. Muestra intensidad de uso real (tokens sin cache reads) por hora. Color verde con alpha proporcional al volumen. Combina VPS + laptop.

**Comparacion semanal:** Chart.js line chart con tokens acumulados — curva verde "Esta semana" vs gris punteada "Semana pasada". Summary textual: "A las Xh: Y esta sem vs Z anterior (+/-N%)".

**Usage curve snapshots:** Nuevo endpoint `GET /api/usage-curve`. Cada fetch exitoso de global-usage guarda weekPercent, sessionPercent, elapsedHours en `data/usage-curve.json`. Poda automatica a 28 dias.

**Tabs reordenados:** Overview → Patrones → Eficiencia.

### Cleanup: Barra "Ciclo Actual" simplificada

Eliminados 4 items redundantes (Costo Equiv., % Semanal, En Riesgo, Pace). La barra ahora solo muestra **Dias Restantes** y **Tokens Ciclo**. CSS grid de 6 a 2 columnas.

- Eliminado `cycleCost` de `analyzeBillingCycle()` — usaba pricing de API (engañoso vs plan $100/mes)
- Eliminado `extStats.cost` de `getExternalCycleStats()`
- Eliminadas referencias a `cycle-cost`, `cycle-week-pct`, `cycle-risk`, `cycle-pace` en JS

### Fix: Frontend crash cuando PTY devuelve success:false

**Problema:** Cuando Claude estaba ocupado (ej: sesion activa), la PTY devuelvia `success: false` con 0% en todo. El frontend solo mostraba datos si `data.success === true`, rechazando el cache valido y mostrando "Error: Unknown".

**Fix:** `index.html` cambiado de `if (data.success)` a `if (data.session && data.weekAll)` — ahora muestra datos siempre que haya campos de porcentaje, independientemente del flag success.

### Fix: Weekly snapshot overwrite on reset

**Problema:** Al resetear la semana (~10am), Claude devuelve 0% pero el calculo de `weekId` todavia apuntaba a la semana anterior por unos minutos. Esto sobreescribia el % de cierre (93%) con el valor post-reset (0-2%).

**Evidencia en logs:**
```
Weekly snapshot saved: week 2026-02-05, 93%   ← correcto
Weekly snapshot saved: week 2026-02-05, 0%    ← post-reset, sobreescribio el 93%
Weekly snapshot saved: week 2026-02-05, 2%    ← siguio degradando
```

**Fix:** `server.js` linea ~159 — `saveWeeklySnapshot` nunca degrada `weekPercent` de una entrada existente. Si el nuevo % es menor, se ignora con log de proteccion.

**Datos corregidos:** `weekly-history.json` semana `2026-02-05` restaurada a 93%.

### Fix: Fechas de semana incorrectas en todos los paneles

**Problema:** El parser PTY (`claude-usage.js`) solo extraia la **hora** del reset (ej: "10am") pero ignoraba la **fecha** (ej: "Feb 19"). Sin la fecha, `getWeekCycleInfo()` asumia "el reset es manana", dando una semana de 6 feb → 13 feb cuando la real era 12 feb → 19 feb. Afectaba: tanque semanal, pace, eficiencia, y consumo semanal.

**Causa adicional:** Los codigos ANSI de cursor (`[1C]`) se eliminaban como string vacio en vez de reemplazarse con espacios, pegando palabras: "Resets Feb" → "ResetsFeb". Ningun regex podia parsear eso.

**Fix (3 archivos):**
- `claude-usage.js`: ANSI codes reemplazados con espacios; regex mejorado que parsea fecha+hora ("Resets Feb 19, 9:59am") y devuelve `resetsAt` como ISO datetime completo
- `server.js`: `getWeekCycleInfo()` usa `resetsAt` para calcular la semana exacta
- `index.html`: `getWeekCycleInfo()` usa `resetsAt`; muestra fecha de reset prominente ("jue 19 feb 10am")

**Resultado:** Semana 12 feb → 19 feb, Dia 1/7, reset jue 19 feb.
