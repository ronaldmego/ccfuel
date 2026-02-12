# Claude Token Dashboard

Monitoreo de gasolina real de Claude Code. Mide el consumo de tokens que realmente queman cuota semanal, ignorando cache reads (~96% del volumen) que no cuestan nada.

## Por que existe

Claude Code tiene un limite semanal de tokens. Si lo agotas, te quedas sin acceso hasta el reset. Este dashboard te dice:

- **Cuanta gasolina queda** — % semanal real (directo de Claude `/usage`)
- **A que ritmo vas** — Pace semanal con alerta si vas acelerado
- **Cuando se agota** — Proyeccion del dia de agotamiento
- **Cuanto quemas por dia** — Tokens reales, no inflados con cache reads

## Que mide (y que NO)

| Concepto | Incluido | Razon |
|----------|----------|-------|
| outputTokens | Si | Lo que Claude genera — cuesta cuota |
| inputTokens | Si | Contexto nuevo — cuesta cuota |
| cacheCreationTokens | Si | Primera escritura a cache — cuesta cuota |
| **cacheReadTokens** | **NO** | ~96% del volumen, gratis o casi gratis |

**Formula:** `realTokens = totalTokens - cacheReadTokens`

Ver `TECHNICAL-NOTES.md` para la explicacion completa.

## Stack

```
Node.js + Express
Frontend: Vanilla HTML/CSS/JS + Chart.js (un solo index.html)
Datos: ccusage (parsea logs JSONL) + Claude /usage (via PTY)
Process Manager: PM2
```

## Quick Start

```bash
# En el VPS
npm install
pm2 start server.js --name token-dashboard

# Acceder (solo via Tailscale)
http://100.64.216.28:3400
```

## Fuentes de datos

```
VPS (~/.claude/*.jsonl)  ──▶  ccusage  ──▶  server.js  ──▶  Dashboard
                                                ▲
Laptop (push-usage.sh)  ──POST /api/external-usage──┘
                                                │
Claude Code (/usage PTY) ──▶  claude-usage.js ──┘
```

- **VPS**: ccusage parsea logs JSONL locales cada 5 min
- **Laptop**: `push-usage.sh` ejecuta ccusage local y envia datos via POST
- **Claude /usage**: PTY wrapper ejecuta el comando real para obtener % de cuenta

## Sincronizacion Laptop

Ver `LOCALSETUP.md` para configurar la sincronizacion automatica desde laptop al VPS.

## Documentacion

| Archivo | Contenido |
|---------|-----------|
| `CLAUDE.md` | Guia para Claude Code (filosofia, arquitectura, comandos) |
| `TECHNICAL-NOTES.md` | Metodologia de medicion: gasolina real vs cache reads |
| `LOCALSETUP.md` | Configuracion de sync laptop → VPS |
| `LIMITATIONS.md` | Limitaciones conocidas de las fuentes de datos |
