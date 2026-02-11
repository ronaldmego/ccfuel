# Token Dashboard - Setup Laptop (Windows)

Configuracion para sincronizar datos de uso de Claude Code desde la laptop al VPS.

---

## Como Funciona

La laptop genera logs de Claude Code en `~/.claude/`. El script `push-usage.sh` ejecuta ccusage localmente, empaqueta los datos (blocks + daily) en JSON, y los sube al VPS via `POST /api/external-usage`. El dashboard combina automaticamente datos VPS + laptop.

```
Laptop                          VPS
~/.claude/*.jsonl
    │
    ▼
ccusage (blocks+daily)
    │
    ▼
push-usage.sh
    │
    ├──POST /api/external-usage──▶ data/external/laptop.json
    │                                    │
    │                                    ▼
    │                              Dashboard (merged)
```

---

## Metodos de Sincronizacion

### 1. Hook de Claude Code (principal)

Se ejecuta automaticamente al terminar cualquier sesion de Claude Code.

**Configuracion:** `~/.claude/settings.json`

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bash \"$HOME/APPs/claude-dashboard/scripts/push-usage.sh\"",
            "timeout": 120
          }
        ]
      }
    ]
  }
}
```

- **Matcher vacio** = se ejecuta en todas las sesiones (cualquier proyecto)
- **Timeout 120s** = suficiente para ccusage + upload
- No hay duplicados: el VPS sobreescribe `laptop.json` cada vez

### 2. Task Scheduler (backup diario)

Ejecuta el mismo script una vez al dia como safety net.

| Campo | Valor |
|-------|-------|
| Nombre tarea | `PushCcusageToVPS` |
| Horario | 23:00 diario |
| Ejecuta | `bash push-usage.sh` |

**Comandos utiles:**

```bash
# Ver estado
MSYS_NO_PATHCONV=1 schtasks /query /tn "PushCcusageToVPS"

# Ejecutar manualmente
MSYS_NO_PATHCONV=1 schtasks /run /tn "PushCcusageToVPS"

# Eliminar
MSYS_NO_PATHCONV=1 schtasks /delete /tn "PushCcusageToVPS" /f
```

Nota: `MSYS_NO_PATHCONV=1` es necesario en Git Bash para que no convierta `/tn` en rutas.

### 3. Manual

```bash
bash ~/APPs/claude-dashboard/scripts/push-usage.sh
```

---

## Script: push-usage.sh

**Ubicacion:** `scripts/push-usage.sh`

Flujo:
1. Ejecuta `npx ccusage@latest blocks --json` y `daily --json`
2. Guarda en archivos temporales (evita "argument list too long")
3. Construye payload JSON via Node.js
4. POST a `http://100.64.216.28:3400/api/external-usage`
5. Log en `$TEMP/push-usage.log`

**Requisitos:** Node.js, npx, curl, acceso Tailscale al VPS.

---

## Troubleshooting

```bash
# Ver log del ultimo push
cat "$TEMP/push-usage.log"

# Test manual
bash ~/APPs/claude-dashboard/scripts/push-usage.sh

# Verificar datos en VPS
curl -s http://100.64.216.28:3400/api/external-usage | node -e "
  let d='';process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    const j=JSON.parse(d);
    const s=j.sources?.laptop;
    if(!s) return console.log('No laptop data on VPS');
    console.log('Updated:', s.lastUpdate);
    console.log('Daily entries:', s.daily.daily.length);
    console.log('Block entries:', s.blocks.blocks.length);
  });
"

# Verificar hook esta configurado
cat ~/.claude/settings.json | node -e "
  let d='';process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    const j=JSON.parse(d);
    const h=j.hooks?.SessionEnd;
    console.log('SessionEnd hooks:', h ? h.length : 'NONE');
  });
"

# Verificar Task Scheduler
MSYS_NO_PATHCONV=1 schtasks /query /tn "PushCcusageToVPS"
```

---

*Documento atemporal — Solo info constante*
