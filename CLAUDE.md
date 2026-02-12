# Token Dashboard - Guia Claude Code

## Tabla de Contenidos

- [Vision y Filosofia](#vision-y-filosofia)
- [Quick Start](#quick-start)
- [Arquitectura](#arquitectura)
- [Comandos Frecuentes](#comandos-frecuentes)
- [Filosofia de Desarrollo](#filosofia-de-desarrollo)
- [Seguridad](#seguridad)
- [Recursos](#recursos)

---

## Vision y Filosofia

**Monitoreo de gasolina real de Claude** — Los tokens de Claude son combustible finito que se resetea semanalmente. Este dashboard mide el consumo real para que alcance todos los dias.

### Principio clave: Gasolina Real

No todos los tokens son iguales. ~96% del volumen son **cacheReadTokens** (lectura de cache), que son gratis o muy baratos y **no consumen cuota**. Lo que realmente quema gasolina son:

- `outputTokens` — Lo que Claude genera
- `inputTokens` — Contexto nuevo que Claude procesa
- `cacheCreationInputTokens` — Primera escritura a cache

**Formula:** `realTokens = totalTokens - cacheReadTokens`

Solo medimos gasolina real. Todo lo demas es ruido.

### Preguntas que responde

1. **Cuanto queda?** — % semanal real (alineado con Claude `/usage`)
2. **A que ritmo voy?** — Pace semanal: on track / acelerado / critico
3. **Cuando se agota?** — Proyeccion de dia de agotamiento
4. **Cuanta gasolina queme hoy/esta semana?** — Tokens reales (sin cache reads)

### Fuentes de datos

- **ccusage** — Parsea logs JSONL locales para bloques y tokens (VPS + laptop via sync)
- **Claude /usage** — Fuente de verdad: porcentajes globales de la cuenta via PTY
- **Datos externos** — Laptop sincroniza via `push-usage.sh` → POST `/api/external-usage`

### Metodologia detallada

Ver `TECHNICAL-NOTES.md` para la explicacion completa del metodo de medicion, que ignoramos, y por que.

| Aspecto | Valor |
|---------|-------|
| URL | `http://100.64.216.28:3400` |
| Acceso | Solo via Tailscale (privado) |
| Directorio | `/home/adminmgo/projects/token-dashboard/` |
| Puerto | 3400 (registrado) |
| PM2 | `token-dashboard` |

---

## Quick Start

```bash
# Iniciar/Reiniciar
pm2 restart token-dashboard

# Ver logs
pm2 logs token-dashboard --lines 50

# Acceder (solo Tailscale)
http://100.64.216.28:3400

# Forzar refresh de datos
curl http://100.64.216.28:3400/api/refresh
```

---

## Arquitectura

### Stack

```
Node.js + Express
Frontend: Vanilla HTML/CSS/JS + Chart.js
Datos: ccusage (CLI tool) + Claude /usage (PTY)
Process Manager: PM2
```

**Sin build step** — El frontend es un solo `index.html` con todo inline.

### Diagrama

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────┐
│  ~/.claude/     │────▶│   ccusage    │────▶│   server.js │
│  (JSONL logs)   │     │   (parser)   │     │   (Express) │
└─────────────────┘     └──────────────┘     └──────────────┘
                                                     │
┌─────────────────┐     ┌──────────────┐             │
│  Claude Code    │────▶│ claude-usage │─────────────┤
│  (/usage PTY)   │     │   (parser)   │             │
└─────────────────┘     └──────────────┘             ▼
                                             ┌─────────────┐
                                             │ index.html  │
                                             │ (Dashboard) │
                                             └─────────────┘
```

### Estructura de Archivos

```
token-dashboard/
├── server.js           # Express server + ccusage integration
├── claude-usage.js     # PTY wrapper para Claude /usage
├── public/
│   └── index.html      # Dashboard (todo inline: HTML, CSS, JS)
├── scripts/
│   └── push-usage.sh   # Sync laptop → VPS (hook + cron)
├── data/
│   ├── external/       # Datos externos (laptop.json, etc)
│   ├── weekly-history.json  # Snapshots de eficiencia semanal
│   └── usage-curve.json     # Snapshots periodicos de % (cada 5 min)
├── CLAUDE.md           # Este archivo
├── TECHNICAL-NOTES.md  # Metodologia: gasolina real, que medimos, que ignoramos
├── LOCALSETUP.md       # Setup laptop: hooks, Task Scheduler, sync
├── LIMITATIONS.md      # Limitaciones conocidas (IMPORTANTE)
└── package.json
```

### API Endpoints

| Endpoint | Metodo | Descripcion |
|----------|--------|-------------|
| `/` | GET | Dashboard HTML |
| `/api/data` | GET | Datos cacheados ccusage (blocks + daily) |
| `/api/refresh` | GET | Fuerza actualizacion de cache ccusage |
| `/api/global-usage` | GET | **Uso global real** (Claude /usage via PTY) |
| `/api/global-usage/refresh` | GET | Fuerza refresh de global usage |
| `/api/external-usage` | POST | Recibe datos de fuentes externas (laptop) |
| `/api/external-usage` | GET | Lista datos de todas las fuentes externas |
| `/api/usage-curve` | GET | Snapshots periodicos de % (para comparacion semanal) |
| `/api/weekly-history` | GET | Historial de eficiencia semanal |

**Global Usage:** Ejecuta Claude Code via PTY (~15-20s), cache 5 min. Retorna session%, weekAll%, weekSonnet%, extraUsage.

**Cache:** Datos en memoria, auto-refresh cada 5 min, `/api/refresh` fuerza actualizacion.

**Usage Curve:** Cada fetch exitoso de global-usage guarda un snapshot en `data/usage-curve.json` (%, hora, dia del ciclo). Poda automatica: ultimos 28 dias.

### Metricas del Dashboard

**Tab Overview:** Uso global real (% semanal), pace semanal, proyeccion de agotamiento, sesion actual, barra de ciclo (dias restantes + tokens ciclo), gasolina hoy, promedio diario. Charts de uso diario y por franja horaria (solo tokens reales, sin cache reads).

**Tab Patrones:** Heatmap de actividad semanal (7 dias x 24 horas, CSS grid), comparacion de consumo semana actual vs anterior (Chart.js line chart, tokens acumulados).

**Tab Eficiencia:** Eficiencia semanal actual (% usado vs disponible), historial de semanas anteriores, tokens combinados VPS+Laptop.

---

## Comandos Frecuentes

```bash
# PM2
pm2 restart token-dashboard
pm2 logs token-dashboard
pm2 status

# ccusage directo (para debug)
npx ccusage@latest daily --json
npx ccusage@latest blocks --json
npx ccusage@latest summary

# Test API
curl http://100.64.216.28:3400/api/data | jq '.daily.daily | length'
```

### Troubleshooting

```bash
# Dashboard no carga
pm2 status && pm2 restart token-dashboard && pm2 logs token-dashboard --err

# Datos no actualizan
curl http://100.64.216.28:3400/api/refresh && npx ccusage@latest summary

# ccusage falla
ls -la ~/.claude/*.jsonl && npx ccusage@latest --version
```

---

## Filosofia de Desarrollo

### Convenciones

- **Frontend inline** — Todo en un solo `index.html` (HTML, CSS, JS). No hay build step
- **Solo gasolina real** — Siempre mostrar `totalTokens - cacheReadTokens`. Nunca inflar numeros con cache reads
- **Consumo combinado** — VPS + Laptop, no hay separacion por usuario
- **ccusage es externo** — No modificamos esa tool, solo la consumimos
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
- **Siempre verificar** en http://100.64.216.28:3400

### Mobile-friendly

- Tablas y cards deben ser legibles en movil
- Usar valores compactos (ej: `02-08` en vez de `2026-02-08`)
- Evitar scroll horizontal cuando sea posible

### Agregar Nueva Metrica

1. Modificar `loadData()` en `index.html` para calcular
2. Agregar elemento HTML en la seccion correspondiente
3. Actualizar en el ciclo de render

---

## Seguridad

- **Acceso restringido a Tailscale** — Solo accesible via IP `100.64.216.28`, no expuesto a internet
- **Sin autenticacion** — No se requiere login porque Tailscale ya controla el acceso
- **Sin datos sensibles** — El dashboard solo muestra metricas de consumo, no credenciales ni tokens de API
- **PTY isolation** — `claude-usage.js` ejecuta Claude Code en un PTY aislado, solo lee `/usage`
- **Puerto registrado** — Puerto 3400 en `~/maintenance/docs/infrastructure/port-registry.md`

### Limitaciones de Datos

**LEER:** `LIMITATIONS.md`

ccusage solo ve logs JSONL locales. El VPS captura sus propios logs y la laptop sincroniza los suyos via `push-usage.sh` (ver `LOCALSETUP.md`). No captura: Claude.ai web ni API calls directas. Los "gaps" pueden ser falsos si se uso Claude desde otra fuente no integrada.

---

## Recursos

| Necesidad | Recurso |
|-----------|---------|
| Metodologia de medicion | `TECHNICAL-NOTES.md` — Que medimos, que ignoramos, por que |
| Limitaciones | `LIMITATIONS.md` |
| Setup Laptop | `LOCALSETUP.md` (sync laptop → VPS, hooks, Task Scheduler) |
| ccusage docs | https://github.com/ryoppippi/ccusage |
| Chart.js | https://www.chartjs.org/docs/ |
| VPS/Infra | `~/CLAUDE.md` |
| Port Registry | `~/maintenance/docs/infrastructure/port-registry.md` |

---

*Documento atemporal — Solo info constante*
