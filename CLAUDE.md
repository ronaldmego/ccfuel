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

## Workflow para agentes

1. Revisar **[GitHub Issues](https://github.com/ronaldmego/claude-code-usage-dashboard/issues)** del repo para encontrar trabajo pendiente
2. **Cambios simples** (docs, README, typos, comentarios): commit directo a main, sin PR
3. **Cambios de codigo**: Crear branch, hacer cambios, abrir PR con `Closes #N`
4. Dejar comentario en el GitHub Issue con resumen de cambios y archivos modificados

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

### Fuente de datos

- **Claude /usage** — Fuente de verdad: porcentajes globales de la cuenta via PTY. Snapshots cada ~10 min en `data/usage-curve.json`

### Metodologia detallada

Ver `TECHNICAL-NOTES.md` para la explicacion completa del metodo de medicion, que ignoramos, y por que.

| Aspecto | Valor |
|---------|-------|
| URL | `http://<DASHBOARD_HOST>:<DASHBOARD_PORT>` |
| Acceso | Configurable (default: localhost) |
| Puerto | Configurable via `DASHBOARD_PORT` (default: 3400) |
| PM2 | `token-dashboard` |

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

## Arquitectura

### Stack

```
Node.js + Express
Frontend: Vanilla HTML/CSS/JS + Chart.js
Datos: Claude /usage (PTY) — snapshots de % cada ~10 min
Process Manager: PM2
```

**Sin build step** — El frontend es un solo `index.html` con todo inline.

### Diagrama

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────┐
│  Claude Code    │────▶│ claude-usage │────▶│   server.js │
│  (/usage PTY)   │     │   (parser)   │     │   (Express) │
└─────────────────┘     └──────────────┘     └──────────────┘
                                                     │
                                                     ▼
                                             ┌─────────────┐
                                             │ index.html  │
                                             │ (Dashboard) │
                                             └─────────────┘
```

### Estructura de Archivos

```
token-dashboard/
├── server.js           # Express server + PTY integration
├── claude-usage.js     # PTY wrapper para Claude /usage
├── public/
│   └── index.html      # Dashboard (todo inline: HTML, CSS, JS)
├── data/
│   ├── weekly-history.json  # Snapshots de eficiencia semanal
│   └── usage-curve.json     # Snapshots periodicos de % (cada ~10 min)
├── CLAUDE.md           # Este archivo
├── TECHNICAL-NOTES.md  # Metodologia: gasolina real, que medimos, que ignoramos
├── LIMITATIONS.md      # Limitaciones conocidas (IMPORTANTE)
└── package.json
```

### API Endpoints

| Endpoint | Metodo | Descripcion |
|----------|--------|-------------|
| `/` | GET | Dashboard HTML |
| `/api/refresh` | GET | Redirige a `/api/global-usage/refresh` |
| `/api/global-usage` | GET | **Uso global real** (Claude /usage via PTY) |
| `/api/global-usage/refresh` | GET | Fuerza refresh de global usage |
| `/api/usage-curve` | GET | Snapshots periodicos de % (para comparacion semanal) |
| `/api/usage-deltas` | GET | Consumo derivado de deltas de % (rate, projection, daily, hourly, heatmap, curves) |
| `/api/weekly-history` | GET | Historial de eficiencia semanal |
| `/api/config` | GET | Configuracion (timezone) |

**Global Usage:** Ejecuta Claude Code via PTY (~15-20s), cache 5 min. Retorna session%, weekAll%, weekSonnet%, extraUsage.

**Usage Curve:** Cada fetch exitoso de global-usage guarda un snapshot en `data/usage-curve.json` (%, hora, dia del ciclo). Poda automatica: ultimos 28 dias.

### Metricas del Dashboard

**Tab Consumo (principal):** Derivado de deltas de % via snapshots de /usage. Ritmo actual (%/hora, ultimas 6h), proyeccion de agotamiento, consumo diario (delta % por dia, 14 dias), consumo por hora (48h), heatmap de intensidad del ciclo actual (cyan). Fuente: `/api/usage-deltas`.

**Tab Overview:** Uso global (fuente de verdad: % sesion, semanal, sonnet), gauges de sesion y semanal (% restante). Fuente: `/api/global-usage`.

**Tab Patrones:** Chart de lineas con % acumulado (0-100%) por hora del ciclo. Semana actual (verde) vs anterior (gris) vs ritmo ideal (purple). Fuente: `curves` en `/api/usage-deltas`.

**Tab Eficiencia:** Eficiencia semanal actual (% usado vs disponible, colores relativos al progreso del ciclo), historial de semanas anteriores (3 columnas: semana, dia, % usado).

### Ventanas de Tiempo (ver TECHNICAL-NOTES.md)

El dashboard usa 3 ventanas de tiempo distintas. Cada metrica opera en una sola ventana y no deben mezclarse entre si.

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

### Limitaciones de Datos

**LEER:** `LIMITATIONS.md`

El dashboard depende del % oficial de Claude /usage via PTY. El PTY tarda ~15-20s y puede fallar intermitentemente. Los snapshots se guardan cada ~10 min y se filtran anomalias (drops >3%, weekPercent=0). La resolucion de datos es limitada por la frecuencia de snapshots.

---

## Recursos

| Necesidad | Recurso |
|-----------|---------|
| Metodologia de medicion | `TECHNICAL-NOTES.md` — Que medimos, que ignoramos, por que |
| Limitaciones | `LIMITATIONS.md` |
| Chart.js | https://www.chartjs.org/docs/ |

---

*Documento atemporal — Solo info constante*
