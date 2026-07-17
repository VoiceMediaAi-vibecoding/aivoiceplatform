# Setup Guide

## 1. Copia las variables de entorno

```bash
cp .env.example .env
```

Edita `.env` y rellena:
- `OPENAI_API_KEY`
- `DEEPGRAM_API_KEY`
- `ELEVEN_API_KEY` + `ELEVEN_VOICE_ID`
- `SUPABASE_URL` + `SUPABASE_ANON_KEY` + `SUPABASE_SERVICE_ROLE_KEY`

## 2. Crea el schema en Supabase

1. Abre tu proyecto en [supabase.com](https://supabase.com)
2. Ve a **SQL Editor**
3. Pega y ejecuta el contenido de `docs/supabase_schema.sql`

## 3. Desarrollo local (sin Docker)

### LiveKit Server
```bash
# Ya instalado con lk CLI
livekit-server --dev --bind 0.0.0.0
# Corre en ws://localhost:7880 con devkey/secret
```

### Agent (Python)
```bash
cd services/agent
export PATH="$HOME/.local/bin:$PATH"

# Descarga modelos (solo primera vez)
uv run python src/agent.py download-files

# Corre el agente
uv run python src/agent.py dev
```

### API (FastAPI)
```bash
cd services/api
uv run uvicorn main:app --reload --port 8000
```

### Dashboard (Next.js)
```bash
cd services/dashboard
npm run dev
# Abre http://localhost:3000
```

## 4. Producción (Docker Compose)

```bash
# Arranca todos los servicios
docker compose up -d

# Ver logs del agente
docker compose logs -f agent

# Ver logs de la API
docker compose logs -f api
```

## 5. Probar el agente en terminal

```bash
cd services/agent
uv run python src/agent.py console
# Te conecta directamente como usuario — habla con el agente
```

## Puertos

| Servicio | Puerto |
|---|---|
| LiveKit WebSocket | 7880 |
| LiveKit RTC TCP | 7881 |
| LiveKit RTC UDP | 7882 |
| FastAPI | 8000 |
| Dashboard | 3000 |

## Estructura de archivos

```
services/
├── agent/
│   ├── src/agent.py          # Agente de voz principal
│   ├── src/cost_logger.py    # Logging de costos a Supabase
│   └── pyproject.toml
├── api/
│   └── main.py               # Token generation + cost API
└── dashboard/
    └── app/
        ├── page.tsx           # Home con resumen de costos
        ├── dashboard/         # Gráficas de costo diario
        ├── sessions/          # Historial de sesiones
        ├── agent/             # UI para hablar con el agente
        └── settings/          # Config de modelos y precios
```

## Actualizar precios de APIs

Edita `services/agent/src/cost_logger.py` → constante `PRICING`.
Los precios se actualizan instantáneamente sin reiniciar.
