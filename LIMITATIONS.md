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
| Claude Code en laptop | ❌ No | Logs están en la laptop, no aquí |
| Claude.ai web | ❌ No | No genera logs JSONL locales |
| API calls directas | ❌ No | No pasan por Claude Code |
| Cursor, Continue, etc. | ❌ No | Apps terceras no usan Claude Code |

---

## Impacto en el Dashboard

### Gaps Incorrectos

Si usas Claude desde **otra máquina** (ej: laptop), el dashboard mostrará ese tiempo como "gap" (tokens perdidos), cuando en realidad sí hubo actividad.

**Ejemplo:**
- Viernes usaste Claude desde laptop todo el día
- Dashboard del VPS muestra viernes como 24h de gap
- En realidad, SÍ usaste tokens, pero desde otra fuente

### Tokens Subestimados

El conteo de tokens solo refleja lo usado **desde este VPS**. El consumo real de tu cuenta Anthropic puede ser mayor.

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

## Métricas Afectadas

| Métrica | Afectada | Notas |
|---------|----------|-------|
| Tokens del ciclo | ⚠️ Parcial | Solo VPS, no otras fuentes |
| Costo equivalente | ⚠️ Parcial | Basado en tokens parciales |
| Gaps detectados | ⚠️ Puede ser falso | Uso externo aparece como gap |
| Eficiencia | ⚠️ Puede ser incorrecto | Gaps falsos bajan el % |
| Uso por actor (Pepa/Ronald) | ⚠️ Parcial | Solo lo que pasa por VPS |

---

## Recomendaciones

1. **Usa el VPS como fuente principal** cuando sea posible
2. **Revisa Anthropic Console** para consumo real
3. **No confíes ciegamente en los gaps** — pueden ser uso externo
4. **Documenta cuándo usas otras fuentes** para correlacionar

---

## Mejoras Futuras

### Sincronización de logs desde laptop

Actualmente el dashboard solo ve los logs del VPS. Para tener vista consolidada:

```bash
# Script en laptop de Ronald que suba logs al VPS
rsync -avz ~/.claude/*.jsonl usuario@vps:~/.claude/laptop/
```

**Implementación propuesta:**
1. Script en laptop que suba `~/.claude/*.jsonl` al VPS
2. Podría correr con cron o al cerrar Claude Code
3. ccusage leería logs combinados (VPS + laptop)
4. Dashboard mostraría uso consolidado real

**Beneficio:** El desglose "Pepa vs Ronald" sería exacto, no estimado.

---

## Referencias

- ccusage repo: https://github.com/ryoppippi/ccusage
- ccusage npm: https://www.npmjs.com/package/ccusage
- Anthropic Console: https://console.anthropic.com

---

*Última actualización: 2026-02-08*
