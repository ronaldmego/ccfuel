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

**Control de stock de tokens Claude** — Trata los tokens como combustible: saber cuanto queda, a que ritmo se gasta, y cuando se va a agotar.

El dashboard responde tres preguntas clave:
1. **Cuanto queda?** — Porcentajes reales de la cuenta Anthropic (via `/usage`)
2. **A que ritmo voy?** — Pace semanal con indicador on track / acelerado / critico
3. **Cuando se agota?** — Proyeccion de dia de agotamiento basada en ritmo actual

Fuentes de datos:
- **ccusage** — Parsea logs JSONL locales del VPS para bloques, tokens, costos y gaps
- **Claude /usage** — Fuente de verdad real ejecutada via PTY, muestra porcentajes globales de la cuenta

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
├── data/               # Datos legacy (backup, no conectados)
├── CLAUDE.md           # Este archivo
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

**Global Usage:** Ejecuta Claude Code via PTY (~15-20s), cache 5 min. Retorna session%, weekAll%, weekSonnet%, extraUsage.

**Cache:** Datos en memoria, auto-refresh cada 5 min, `/api/refresh` fuerza actualizacion.

### Metricas del Dashboard

**Tab Overview:** Uso global real, pace semanal, proyeccion de agotamiento, ventana activa (5h), tokens usados, costo equivalente, burn rate, chart diario (14d), chart por franja horaria (0-23h).

**Tab Gaps:** Resumen diario de horas/tokens perdidos, gaps individuales, estimado ~500K tokens/hora.

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
- **Consumo combinado** — No hay separacion por usuario, se muestra total
- **ccusage es externo** — No modificamos esa tool, solo la consumimos
- **PM2 para produccion** — Nunca `node server.js` directo

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

- La tabla de gaps debe ser legible en movil
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

ccusage solo ve logs locales de este VPS. No captura uso desde laptop, Claude.ai web, ni API calls directas. Los "gaps" pueden ser falsos si se uso Claude desde otra fuente.

---

## Recursos

| Necesidad | Recurso |
|-----------|---------|
| Limitaciones | `LIMITATIONS.md` (en este directorio) |
| ccusage docs | https://github.com/ryoppippi/ccusage |
| Chart.js | https://www.chartjs.org/docs/ |
| VPS/Infra | `~/CLAUDE.md` |
| Port Registry | `~/maintenance/docs/infrastructure/port-registry.md` |

---

*Documento atemporal — Solo info constante*
