# Token Dashboard - Guia Claude Code

## Workflow para agentes

1. Revisar **[GitHub Issues](https://github.com/ronaldmego/claude-code-usage-dashboard/issues)** del repo para encontrar trabajo pendiente
2. **Cambios simples** (docs, README, typos, comentarios): commit directo a main, sin PR
3. **Cambios de codigo**: Crear branch, hacer cambios, abrir PR con `Closes #N`
4. Dejar comentario en el GitHub Issue con resumen de cambios y archivos modificados

---

## Port

| Puerto | Bind | URL VPN | Proceso |
|--------|------|---------|---------|
| 3400 | `100.64.216.28` | `http://100.64.216.28:3400` | PM2: `token-dashboard` |

---

## Project Context

Dashboard de consumo de tokens Claude. Mide gasolina real (`outputTokens` + `inputTokens` + `cacheCreationInputTokens`) ignorando `cacheReadTokens` (~96% del volumen, gratis). Fuente de verdad: % oficial de Claude `/usage` via PTY, snapshots cada ~10 min.

**Stack:** Node.js + Express, Vanilla HTML/CSS/JS + Chart.js, PM2. Sin build step.

Ver `README.md` para arquitectura detallada, endpoints, estructura de archivos, y componentes criticos.

---

## Quick Start

```bash
# Iniciar/Reiniciar
pm2 restart token-dashboard

# Ver logs
pm2 logs token-dashboard --lines 50

# Acceder
http://localhost:3400

# Forzar refresh de datos
curl http://localhost:3400/api/refresh
```

---

## Comandos Frecuentes

```bash
# PM2
pm2 restart token-dashboard
pm2 logs token-dashboard
pm2 status

# Test API
curl http://localhost:3400/api/usage-deltas | jq '.curves | keys'
curl http://localhost:3400/api/global-usage | jq '.weekAll.percent'
```

### Troubleshooting

```bash
# Dashboard no carga
pm2 status && pm2 restart token-dashboard && pm2 logs token-dashboard --err

# Datos no actualizan
curl http://localhost:3400/api/global-usage/refresh
```

---

## Boris Dev Principles

> **Mandatory.** Non-negotiable directives that every session must follow, plus self-check questions that develop judgment.

### Non-Negotiable Directives

**Planning:**
- Plan before any multi-step task (3+ steps or architectural decisions). Write to `tasks/todo.md`.
- If something goes wrong, STOP and re-plan. Don't keep pushing a failing approach.

**Quality:**
- Prove work is done — tests, logs, or screenshots. Never just say "it works."
- Fix bugs autonomously — read logs, find root cause, fix it. Zero hand-holding.
- After ANY user correction, update `tasks/lessons.md` immediately.
- Review `tasks/lessons.md` at session start.

**Traceability:**
- Every feature, fix, or improvement starts as a GitHub Issue. No issue, no work.
- Update `CHANGELOG.md` on every meaningful change. Reference the GitHub Issue (`#N`).
- Every PR must include `Closes #N`.

**Skills & Governance:**
- Check `~/.claude/skills/` at session start. Use existing skills.
- Invoke `supabase-local` before any Supabase DDL operation.
- Port/project/schema changes → update the corresponding registry.

### Self-Check Questions

> **Is this the best solution or the first that worked?**
> Surgical fix or duct tape? For simple changes, simplicity is also elegance.

> **Am I using my resources well?**
> Can I delegate to a subagent? Am I solving too many things at once?

> **Is there a simpler way?** If yes, why am I not using it?

> **Symptom or cause?** Would I bet money this won't come back?

> **How many files did I touch?** If more than necessary, what's extra?

> **Before merge:** Does it work, or does it just not break? Did I test as a user?

### Task Management

1. **Plan First:** `tasks/todo.md` with checkable items
2. **Verify Plan:** Check in before implementing
3. **Track Progress:** Mark items complete as you go
4. **Explain Changes:** High-level summary at each step
5. **Document Results:** Review section in todo.md
6. **Capture Lessons:** Update `tasks/lessons.md` after corrections

---

## Filosofia de Desarrollo

### Convenciones

- **Frontend inline** — Todo en un solo `index.html` (HTML, CSS, JS). No hay build step
- **Solo % oficial** — Todo se mide con el % reportado por Claude /usage via PTY. No dependemos de ccusage ni logs JSONL
- **PM2 para produccion** — Nunca `node server.js` directo
- **Timezone Panama (UTC-5)** — Todas las fechas pasan por `getPanamaDate()`. Usar metodos UTC (`getUTCDate()`, `setUTCHours()`, etc). Nunca metodos locales del browser. Ver `TECHNICAL-NOTES.md` seccion Timezone
- **Ciclo semanal rolling** — La semana de Claude NO es lun-dom. Es un ciclo de 7 dias con reset a una hora especifica (`weekAll.resetsAtHour`). Nunca asumir dia de semana fijo

### Estilo Visual

- Tema **light corporativo / ejecutivo** (BI). Fondo `#eef1f6`, superficies blancas con sombra suave
- Acentos: Navy `#1f3a5f`, Azul `#2563a8`. Colores semánticos (Verde `#15803d`, Ámbar `#b45309`, Rojo `#dc2626`) reservados solo para estado
- Font: IBM Plex Sans (UI) + IBM Plex Mono tabular para cifras/KPIs. Variables CSS en `:root`
- Iconos: SVG de línea (`stroke="currentColor"`). Sin emojis
- Charts: Chart.js retematizado para fondo claro (`Chart.defaults` + grids/ticks claros)
- **Solo datos reales** — no proyecciones/extrapolaciones lineales en la UI

### Flujo de Cambios

- **Frontend:** Editar `public/index.html`, refresh browser (no requiere restart)
- **Backend:** Editar `server.js`, luego `pm2 restart token-dashboard`
- **Siempre verificar** en http://localhost:3400 (o tu host configurado)

### Mobile-friendly

- Tablas y cards deben ser legibles en movil
- Usar valores compactos (ej: `02-08` en vez de `2026-02-08`)
- Evitar scroll horizontal cuando sea posible

### Agregar Nueva Metrica

1. Si es backend: agregar logica a `computeUsageDeltas()` en `server.js`
2. Agregar elemento HTML en la seccion correspondiente de `index.html`
3. Actualizar en la funcion de render del tab correspondiente

---

## Seguridad

- **Bind address configurable** — Default `127.0.0.1` (localhost only). Set `DASHBOARD_HOST` for remote access
- **Sin autenticacion** — No incluye login. Si se expone en red, usar VPN o reverse proxy con auth
- **Sin datos sensibles** — El dashboard solo muestra metricas de consumo, no credenciales ni tokens de API
- **PTY isolation** — `claude-usage.js` ejecuta Claude Code en un PTY aislado, solo lee `/usage`
- **Limitaciones:** Ver `LIMITATIONS.md`

---

## Relevant Skills

No hay skills especificas para este proyecto. Skills globales aplicables:

- `vps-admin` — Troubleshooting de PM2, servicios, Docker
- `security-ops` — Health checks, monitoreo

---

## Recursos

| Necesidad | Recurso |
|-----------|---------|
| Arquitectura y endpoints | `README.md` — File structure, API, dashboard tabs, critical components |
| Metodologia de medicion | `TECHNICAL-NOTES.md` — Que medimos, que ignoramos, por que |
| Limitaciones | `LIMITATIONS.md` |
| Chart.js | https://www.chartjs.org/docs/ |
