# Limitaciones Conocidas - Token Dashboard

Este documento explica las limitaciones técnicas del dashboard y su fuente de datos.

---

## Fuente de Datos: ccusage

El dashboard usa **ccusage** para obtener datos de uso de Claude.

| Aspecto | Detalle |
|---------|---------|
| **Herramienta** | ccusage (github.com/ryoppippi/ccusage) |
| **Autor** | ryoppippi (comunidad, NO Anthropic) |
| **Licencia** | MIT (open source) |
| **Cómo funciona** | Lee archivos JSONL locales de `~/.claude/` |

---

## ⚠️ Qué NO Ve ccusage

ccusage **solo lee logs locales de Claude Code/CLI**. No captura:

| Fuente | ¿Visible? | Razón |
|--------|-----------|-------|
| Claude Code en este VPS | ✅ Sí | Logs locales en `~/.claude/` |
| OpenClaw en este VPS | ✅ Sí | Usa Claude Code internamente |
| Claude Code en laptop | ✅ Sí | Sync via push-usage.sh → POST /api/external-usage |
| Claude.ai web | ❌ No | No genera logs JSONL locales |
| API calls directas | ❌ No | No pasan por Claude Code |
| Cursor, Continue, etc. | ❌ No | Apps terceras no usan Claude Code |

---

## Impacto en el Dashboard

### Tokens Subestimados (fuentes no integradas)

El conteo de tokens refleja VPS + laptop (via sync). No incluye Claude.ai web ni API directas. El % semanal de Claude `/usage` SI incluye todo.

---

## Cómo Ver Consumo Global

Para ver **todo** el consumo de tu cuenta Anthropic (sin importar la fuente):

1. **Anthropic Console** (recomendado)
   - URL: https://console.anthropic.com
   - Sección: Usage
   - Ve todo: API, Claude.ai, cualquier integración

2. **Sincronizar logs de múltiples máquinas** (avanzado)
   - Copiar `~/.claude/` de cada máquina al VPS
   - ccusage leería todos los logs combinados
   - Requiere rsync o similar

---

## Timezone: Hardcoded UTC-5

El dashboard asume **Panama (UTC-5)** como timezone fijo. No usa DST ni detecta el timezone del usuario.

| Aspecto | Estado |
|---------|--------|
| Hora de reset semanal | Interpretada como Panama time |
| "Gastado Hoy" | Dia calculado en Panama time |
| Charts por hora | Bloques agrupados por hora Panama |
| Browser en otra zona | Sin impacto — no depende del timezone del browser |

Si cambiaras de residencia a otra zona horaria, habria que actualizar `PANAMA_OFFSET` en `index.html` y el equivalente en `server.js`.

### Bug historico: getTimezoneOffset

Antes de la correccion, el frontend usaba `now.getTimezoneOffset()` del browser para calcular Panama time. Esto hacia que los calculos dependieran del timezone del browser y produjeran resultados incorrectos si el browser no estaba en UTC. Se corrigio usando offset directo desde UTC. Ver `TECHNICAL-NOTES.md` seccion Timezone para detalles.

---

## Métricas Afectadas

| Métrica | Afectada | Notas |
|---------|----------|-------|
| Gasolina semanal | ⚠️ Parcial | VPS + laptop, no incluye web/API |
| % Semanal (Claude /usage) | ✅ Completo | Fuente de verdad, incluye todo |
| Eficiencia semanal | ✅ Completo | Basado en % de Claude |

---

## Recomendaciones

1. **Confia en el % de Claude /usage** como fuente de verdad del consumo global
2. **Los tokens reales de ccusage** son complementarios — miden VPS + laptop pero no web/API
3. **Revisa Anthropic Console** si necesitas desglose exacto por fuente

---

## Referencias

- ccusage repo: https://github.com/ryoppippi/ccusage
- ccusage npm: https://www.npmjs.com/package/ccusage
- Anthropic Console: https://console.anthropic.com

---

*Última actualización: 2026-02-11*
