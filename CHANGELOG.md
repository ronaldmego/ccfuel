# Changelog

## 2026-03-31

### Fix: Dashboard no cargaba via Tailscale

**Problema:** `http://100.64.216.28:3400/` no respondía. El servidor estaba bindeado a `127.0.0.1` y rechazaba conexiones desde la IP de Tailscale.

**Fix:**
- Creado `ecosystem.config.cjs` con `DASHBOARD_HOST=100.64.216.28` para que PM2 pase la variable de entorno correctamente
- Reiniciado PM2 con la nueva config — servidor ahora escucha en `100.64.216.28:3400`
- `pm2 save` ejecutado para persistir la configuración

## 2026-03-01

### CRITICAL Fix: claude-usage.js rewritten from execSync to PTY (#18, #19)

**Problema:** El dashboard mostraba 0% en todas las métricas desde hace días. `claude-usage.js` usaba `execSync('claude usage')` pero `claude usage` **no es un subcomando válido de Claude CLI**. Claude lo interpretaba como un prompt de chat y respondía con texto conversacional.

**Causa raíz:** En algún momento Claude Code CLI eliminó o nunca tuvo el subcomando `usage`. La única forma de obtener datos de consumo es via el slash command `/usage` dentro de una sesión interactiva.

**Fix (`claude-usage.js` — rewrite completo):**
- Reemplazado `execSync('claude usage')` por spawn PTY interactivo via `node-pty`
- Secuencia: spawn claude → esperar 4s init → escribir `/usage` → esperar 1.5s autocomplete → Enter → parsear output
- Filtrado de env var `CLAUDECODE` para evitar detección de sesión anidada
- `parseUsageOutput()` sin cambios — la salida de `/usage` es la misma
- Timeout de seguridad 35s (PTY tarda ~20-25s en completar)

**⚠️ ADVERTENCIA:** `claude-usage.js` es la pieza MÁS CRÍTICA del dashboard. Sin ella, nada funciona — el UI es solo presentación. NO tocar este archivo sin testing exhaustivo. Cualquier cambio en Claude Code CLI (autocomplete timing, output format, env vars) puede romperlo.

**También resuelto:**
- Dashboard bindeado a `100.64.216.28` (Tailscale) para acceso remoto
- Cerrado issue #18 (bug report) via PR #19

**Issue:** https://github.com/ronaldmego/claude-code-usage-dashboard/issues/18
**PR:** https://github.com/ronaldmego/claude-code-usage-dashboard/pull/19


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
