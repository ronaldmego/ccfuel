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
| 3400 | `127.0.0.1` | `http://100.64.216.28:3400` | PM2: `token-dashboard` |

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

> **Do I need a plan?**
> Does this have more than 2 steps or architectural decisions? → Plan first. Write it in `tasks/todo.md`.
> Did something go differently than expected? → Stop. Re-plan.
> Am I assuming something I haven't verified?

> **Am I using my resources well?**
> Can I delegate this to a subagent to keep my context window clean?
> Is there a skill in `~/.claude/skills/` that already does this? → Use it.
> Am I doing this for the third time? → It should be a skill.

> **Am I learning from my mistakes?**
> If the user corrected me → did I update `tasks/lessons.md` with the pattern?
> Did I review lessons at the start of this session?

> **Is this actually done?**
> Can I DEMONSTRATE it works? → Tests, logs, screenshots.
> Did I test the happy path AND the error path?

> **Is this the best solution or just the first one that worked?**
> Would I write it this way if 1000 people would read the code?
> Is the fix surgical or am I applying duct tape?

> **Can I resolve this without hand-holding?**
> If there's a bug → read logs, find root cause, fix it.
> If CI fails → fix it without waiting for instructions.

### Task Management

1. **Plan First:** Write plan to `tasks/todo.md` with checkable items
2. **Verify Plan:** Check in before starting implementation
3. **Track Progress:** Mark items complete as you go
4. **Explain Changes:** High-level summary at each step
5. **Document Results:** Add review section to `tasks/todo.md`
6. **Capture Lessons:** Update `tasks/lessons.md` after corrections

### Core Principles

> **Is there a simpler way to solve this?** If there is, why am I not using it?
> **Am I solving the symptom or the cause?** If I had to bet money this won't come back, would I bet?
> **How many files did I touch?** If more than necessary, what's extra?

---

## Filosofia de Desarrollo

### Convenciones

- **Frontend inline** — Todo en un solo `index.html` (HTML, CSS, JS). No hay build step
- **Solo % oficial** — Todo se mide con el % reportado por Claude /usage via PTY. No dependemos de ccusage ni logs JSONL
- **PM2 para produccion** — Nunca `node server.js` directo
- **Timezone Panama (UTC-5)** — Todas las fechas pasan por `getPanamaDate()`. Usar metodos UTC (`getUTCDate()`, `setUTCHours()`, etc). Nunca metodos locales del browser. Ver `TECHNICAL-NOTES.md` seccion Timezone
- **Ciclo semanal rolling** — La semana de Claude NO es lun-dom. Es un ciclo de 7 dias con reset a una hora especifica (`weekAll.resetsAtHour`). Nunca asumir dia de semana fijo

### Estilo Visual

- Tema dark (`#0f0f14` fondo)
- Paleta: Verde (#4ade80), Cyan (#22d3ee), Purple (#a78bfa), Orange (#f97316)
- Font: Inter
- Charts: Chart.js

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
