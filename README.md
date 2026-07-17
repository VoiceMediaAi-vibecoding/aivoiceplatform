# VoiceMedia — Plataforma de Agentes de Voz / Voice Agent Platform

> 🇪🇸 Documentación técnica completa del sistema. Está escrita en **español e inglés**: cada
> sección presenta primero la versión en español (🇪🇸) y luego la versión en inglés (🇬🇧).
>
> 🇬🇧 Full technical documentation of the system. Written in **Spanish and English**: each
> section shows the Spanish version first (🇪🇸), followed by the English version (🇬🇧).

---

## Tabla de contenidos / Table of contents

1. [Resumen / Overview](#1-resumen--overview)
2. [Arquitectura / Architecture](#2-arquitectura--architecture)
3. [Servicios en detalle / Services in detail](#3-servicios-en-detalle--services-in-detail)
4. [Base de datos / Database (Supabase)](#4-base-de-datos--database-supabase)
5. [Modelo de costos / Cost model](#5-modelo-de-costos--cost-model)
6. [Variables de entorno / Environment variables](#6-variables-de-entorno--environment-variables)
7. [Cómo correr localmente / Running locally](#7-cómo-correr-localmente--running-locally)
8. [Despliegue / Deployment](#8-despliegue--deployment)
9. [Cómo hacer cambios comunes / How to make common changes](#9-cómo-hacer-cambios-comunes--how-to-make-common-changes)
10. [Convenciones y gotchas / Conventions & gotchas](#10-convenciones-y-gotchas--conventions--gotchas)

---

## 1. Resumen / Overview

### 🇪🇸 Español

**VoiceMedia** es una **plataforma autohospedada de agentes de voz** construida sobre
[LiveKit](https://livekit.io). Permite ejecutar llamadas telefónicas automatizadas
(principalmente *outbound* / salientes) en las que un agente de IA conversa con un cliente
real por teléfono, en tiempo real y con voz natural.

- **Caso de uso actual:** un agente llamado **Camila** que llama a clientes de **Tigo Panamá**
  para ofrecerles planes móviles (conversión de prepago a pospago).
- **Multi-tenant:** soporta varios clientes, cada uno con sus propios agentes, configuraciones
  y campañas.
- **Autohospedado:** todo corre en un único servidor (AWS EC2, IP de producción
  `44.247.225.191`) mediante Docker Compose. Usa nuestras propias llaves de OpenAI, Deepgram,
  ElevenLabs e Inworld en lugar de un proveedor "todo en uno", lo que da control total sobre
  costos y comportamiento.
- **Telefonía:** las llamadas entran/salen por **Twilio** vía **SIP** hacia la red telefónica
  pública (PSTN).
- **Seguimiento de costos:** cada llamada registra en Supabase el consumo real de cada
  proveedor (tokens de LLM, segundos de audio STT, caracteres de TTS) para saber cuánto cuesta
  exactamente cada conversación.

El sistema se compone de un **plano de datos** (la llamada en sí: SIP → LiveKit → agente) y un
**plano de control** (dashboard web + API para administrar agentes, campañas y ver resultados).

### 🇬🇧 English

**VoiceMedia** is a **self-hosted voice agent platform** built on top of
[LiveKit](https://livekit.io). It runs automated phone calls (primarily *outbound*) where an AI
agent talks to a real customer over the phone, in real time and with a natural voice.

- **Current use case:** an agent named **Camila** that calls **Tigo Panamá** customers to offer
  mobile plans (prepaid → postpaid conversion).
- **Multi-tenant:** supports multiple clients, each with their own agents, configurations and
  campaigns.
- **Self-hosted:** everything runs on a single server (AWS EC2, production IP `44.247.225.191`)
  via Docker Compose. It uses our own OpenAI, Deepgram, ElevenLabs and Inworld keys instead of
  an all-in-one provider, giving full control over cost and behavior.
- **Telephony:** calls go in/out through **Twilio** via **SIP** to the public telephone network
  (PSTN).
- **Cost tracking:** every call records into Supabase the real usage of each provider (LLM
  tokens, STT audio seconds, TTS characters) so we know exactly how much each conversation
  costs.

The system has a **data plane** (the call itself: SIP → LiveKit → agent) and a **control plane**
(web dashboard + API to manage agents, campaigns and review results).

---

## 2. Arquitectura / Architecture

### 🇪🇸 Español

**Flujo de una llamada (plano de datos):**

```
  Cliente (teléfono)
        │  PSTN
        ▼
     Twilio  ──────────── SIP (puerto 5060)
        │
        ▼
  Servicio SIP (livekit/sip)  ── usa Redis ──┐
        │                                     │
        ▼                                     ▼
  Servidor LiveKit (7880 WS / 7881 TCP / 7882 UDP)   Redis
        │  WebRTC (audio)
        ▼
  Agente Python (STT → LLM → TTS)
        │  registra costos, transcripción, resultado
        ▼
     Supabase (Postgres)
```

**Plano de control:**

```
  Navegador (admin / cliente)
        │
        ▼
  Dashboard (Next.js, puerto 3000)
        │  HTTP + JWT
        ▼
  API (FastAPI, puerto 8000) ───► LiveKit (crear salas, despachar agente, llamadas SIP)
        │
        ▼
     Supabase (Postgres)
```

El **dialer** (marcador batch) es un proceso Python que la API lanza como subproceso: lee la
cola de números de una campaña y crea llamadas salientes una por una respetando la concurrencia
configurada.

**Servicios:**

| Servicio    | Lenguaje      | Puerto(s)                          | Imagen / Build              | Responsabilidad |
|-------------|---------------|------------------------------------|-----------------------------|-----------------|
| `livekit`   | Go            | 7880 (WS), 7881 (TCP), 7882 (UDP)  | `livekit/livekit-server`    | Señalización WebRTC y enrutamiento de audio |
| `redis`     | C             | 127.0.0.1:6379                     | `redis:7-alpine`            | Almacén que requiere el servidor SIP |
| `sip`       | Go            | host network (5060, 10000–20000)   | `livekit/sip`               | Puente SIP ↔ Twilio (entrada y salida PSTN) |
| `api`       | Python 3.11   | 8000                               | build `./services/api`      | Tokens, costos, sesiones, campañas, auth |
| `agent`     | Python 3.11   | — (interno)                        | build `./services/agent`    | Agente conversacional (Camila): STT+LLM+TTS |
| `dashboard` | Node 20       | 3000                               | build `./services/dashboard`| UI de administración (Next.js) |
| `dialer`    | Python 3.11   | — (subproceso de la API)           | en `./services/dialer`      | Marcador batch para campañas salientes |

### 🇬🇧 English

**Call flow (data plane):**

```
  Customer (phone)
        │  PSTN
        ▼
     Twilio  ──────────── SIP (port 5060)
        │
        ▼
  SIP service (livekit/sip)  ── uses Redis ──┐
        │                                     │
        ▼                                     ▼
  LiveKit server (7880 WS / 7881 TCP / 7882 UDP)   Redis
        │  WebRTC (audio)
        ▼
  Python agent (STT → LLM → TTS)
        │  logs cost, transcript, outcome
        ▼
     Supabase (Postgres)
```

**Control plane:**

```
  Browser (admin / client)
        │
        ▼
  Dashboard (Next.js, port 3000)
        │  HTTP + JWT
        ▼
  API (FastAPI, port 8000) ───► LiveKit (create rooms, dispatch agent, SIP calls)
        │
        ▼
     Supabase (Postgres)
```

The **dialer** (batch dialer) is a Python process the API launches as a subprocess: it reads a
campaign's number queue and creates outbound calls one by one, honoring the configured
concurrency.

**Services:**

| Service     | Language      | Port(s)                            | Image / Build               | Responsibility |
|-------------|---------------|------------------------------------|-----------------------------|----------------|
| `livekit`   | Go            | 7880 (WS), 7881 (TCP), 7882 (UDP)  | `livekit/livekit-server`    | WebRTC signaling and audio routing |
| `redis`     | C             | 127.0.0.1:6379                     | `redis:7-alpine`            | Store required by the SIP server |
| `sip`       | Go            | host network (5060, 10000–20000)   | `livekit/sip`               | SIP ↔ Twilio bridge (inbound & outbound PSTN) |
| `api`       | Python 3.11   | 8000                               | build `./services/api`      | Tokens, costs, sessions, campaigns, auth |
| `agent`     | Python 3.11   | — (internal)                       | build `./services/agent`    | Conversational agent (Camila): STT+LLM+TTS |
| `dashboard` | Node 20       | 3000                               | build `./services/dashboard`| Admin UI (Next.js) |
| `dialer`    | Python 3.11   | — (API subprocess)                 | in `./services/dialer`      | Batch dialer for outbound campaigns |

> **Nota / Note:** el servicio `sip` usa `network_mode: host` para no mapear los ~10 000 puertos
> UDP de RTP (mapearlos haría caer el servidor). / the `sip` service uses `network_mode: host`
> to avoid mapping the ~10,000 RTP UDP ports (mapping them would crash the server).

---

## 3. Servicios en detalle / Services in detail

### 3.1 `services/agent/` — Agente de voz / Voice agent

#### 🇪🇸 Español

Es el cerebro de la llamada. Cada vez que se conecta una llamada, LiveKit despacha una
instancia del agente a la sala.

- **Entrypoint:** `src/agent.py`, función `entrypoint(ctx)`. Se registra con
  `cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, agent_name="voice-agent", ...))`.
- **Stack de IA por defecto:** STT Deepgram `nova-3` → LLM OpenAI `gpt-4o` → TTS ElevenLabs
  `eleven_turbo_v2_5` (voz `6uZeZ0TKIeJahuKIBwp7`). Alternativa: Inworld para STT/TTS.
- **Configuración dinámica:** `_load_agent_config(agent_id)` lee la tabla `agents` (y
  `agent_knowledge`, `agent_tools`) para construir el prompt, saludo, modelos, voz e idioma en
  tiempo de ejecución. Si no hay agente en BD, usa los valores hardcodeados de Camila
  (`CAMILA_PROMPT`, `CAMILA_GREETING`).
- **Tools (funciones que el LLM puede invocar):**
  - `info_tigo(...)` — guarda un lead en la tabla `tigo_leads` y dispara un webhook N8N.
  - `tigo_correo(...)` — envía una propuesta por correo y guarda el lead.
  - `calcular_tigo_fecha_cobro()` — calcula la fecha de cobro (día 18 o 3) según la activación.
  - Tools tipo *webhook* construidas dinámicamente desde filas de `agent_tools`.
- **Detección de buzón de voz:** `_looks_like_voicemail(transcript)` usa una regex con ~50
  frases típicas de contestadoras (ES/EN). `_classify_end_reason()` mapea el motivo de
  desconexión a una disposición (`client_hangup`, `voicemail`, `no_answer`, `completed`).
- **Guardado de sesión:** `_save_session_to_db(...)` escribe la fila de `sessions` (transcripción,
  costo, `twilio_call_sid`, `end_reason`) y luego, de forma asíncrona, busca en Twilio la URL de
  la grabación (con reintentos).
- **Costos:** instancia `CostLogger` y se engancha al evento `@session.on("metrics_collected")`
  para registrar consumo real en `api_usage` durante la llamada.
- **Idioma:** las conversaciones son en español (configurable por agente).

#### 🇬🇧 English

This is the brain of the call. Whenever a call connects, LiveKit dispatches an agent instance
to the room.

- **Entrypoint:** `src/agent.py`, function `entrypoint(ctx)`. Registered with
  `cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, agent_name="voice-agent", ...))`.
- **Default AI stack:** Deepgram `nova-3` STT → OpenAI `gpt-4o` LLM → ElevenLabs
  `eleven_turbo_v2_5` TTS (voice `6uZeZ0TKIeJahuKIBwp7`). Alternative: Inworld for STT/TTS.
- **Dynamic config:** `_load_agent_config(agent_id)` reads the `agents` table (plus
  `agent_knowledge`, `agent_tools`) to build the prompt, greeting, models, voice and language at
  runtime. With no DB agent, it falls back to hardcoded Camila values (`CAMILA_PROMPT`,
  `CAMILA_GREETING`).
- **Tools (functions the LLM can call):** `info_tigo(...)` (save lead to `tigo_leads` + N8N
  webhook), `tigo_correo(...)` (email proposal + save lead), `calcular_tigo_fecha_cobro()`
  (billing date), and *webhook* tools built dynamically from `agent_tools` rows.
- **Voicemail detection:** `_looks_like_voicemail(transcript)` matches ~50 typical IVR phrases
  (ES/EN). `_classify_end_reason()` maps the disconnect reason to a disposition.
- **Session save:** `_save_session_to_db(...)` writes the `sessions` row (transcript, cost,
  `twilio_call_sid`, `end_reason`), then asynchronously fetches the Twilio recording URL.
- **Costs:** instantiates `CostLogger` and hooks into `@session.on("metrics_collected")` to log
  real usage into `api_usage` during the call.

**Archivos clave / Key files:** `services/agent/src/agent.py`, `services/agent/src/cost_logger.py`,
`services/agent/pyproject.toml`.

---

### 3.2 `services/api/` — API (FastAPI)

#### 🇪🇸 Español

Backend REST del plano de control. Genera tokens de LiveKit, expone costos/sesiones, gestiona
campañas y llamadas, y maneja la autenticación. Corre en `0.0.0.0:8000`.

**Endpoints principales (`main.py`):**

| Método | Ruta | Auth | Descripción |
|--------|------|------|-------------|
| POST | `/token` | — | Genera token de acceso de LiveKit |
| GET | `/sessions`, `/sessions/{id}` | — / admin | Lista/detalle de sesiones con costos |
| GET | `/costs/summary`, `/costs/daily` | — | Resumen y desglose diario de costos |
| GET | `/health` | — | Healthcheck |
| GET | `/calls`, `/calls/{id}` | admin | Registro de llamadas (entrantes y salientes) |
| POST | `/calls/outbound` | admin | Inicia una llamada saliente individual |
| POST | `/calls/webhook/inbound` | Twilio | Webhook SIP de llamadas entrantes |
| POST/GET | `/campaigns`, `/campaigns/{id}` | admin | Crear/listar/ver campañas |
| POST | `/campaigns/{id}/upload` | admin | Subir CSV de contactos a la cola |
| POST | `/campaigns/{id}/start|pause|resume|stop|restart` | admin | Control de campaña |
| DELETE | `/campaigns/{id}` | admin | Eliminar campaña |
| GET | `/campaigns/{id}/logs` | admin | Log de llamadas de la campaña |
| POST | `/auth/login` | — | Login unificado (admin o cliente) |
| GET/POST/PATCH/DELETE | `/admin/clients...` | admin | Gestión de clientes y sus agentes |
| GET/POST | `/admin/users...` | admin | Gestión e invitación de usuarios |

**Tareas en segundo plano (corren en bucle):**
- `_reconcile_stuck_sessions()` (cada ~5 min) — cierra sesiones atascadas.
- `_backfill_recordings()` (cada ~3 min) — completa URLs de grabación faltantes desde Twilio.
- `_backfill_sid_by_phone()` (cada ~3 min) — recupera el `twilio_call_sid` buscando por número
  y ventana de tiempo (resuelve una *race condition* al cerrar el agente).

**Auth:** JWT validado contra Supabase. `_get_admin_from_token(...)` y
`_get_client_from_token(...)` aplican RBAC de dos niveles (admin ≠ cliente).

#### 🇬🇧 English

REST backend of the control plane. Generates LiveKit tokens, exposes costs/sessions, manages
campaigns and calls, and handles auth. Runs on `0.0.0.0:8000`. See the endpoint table above
(routes are the same regardless of UI language).

- **Background loops:** `_reconcile_stuck_sessions()` (~5 min, closes stuck sessions),
  `_backfill_recordings()` (~3 min, fills missing Twilio recording URLs),
  `_backfill_sid_by_phone()` (~3 min, recovers `twilio_call_sid` by phone + time window).
- **Auth:** JWT validated against Supabase. `_get_admin_from_token(...)` and
  `_get_client_from_token(...)` enforce two-tier RBAC (admin ≠ client).

**Archivo clave / Key file:** `services/api/main.py`.

---

### 3.3 `services/dialer/dialer.py` — Marcador batch / Batch dialer

#### 🇪🇸 Español

Proceso lanzado por la API (`python dialer.py <campaign_id>`) al iniciar una campaña.

- **Bucle principal:** `run_campaign(campaign_id)` lee la config de la campaña, resuelve el
  trunk SIP, crea un semáforo de concurrencia (`max_concurrent`) y va sacando filas `pending`
  de `call_queue`, lanzando una tarea `_dial(...)` por cada una.
- **Detección de contestadora (AMD) — 3 checkpoints** tras contestar:
  1. **~25 s:** si no hay actividad de IA (`api_usage` = 0) → buzón, colgar.
  2. **~50 s:** si aún no habló el cliente, difiere la decisión (buffer por latencia del STT).
  3. **~50 s + 8 s de gracia:** chequeo final de `customer_spoke`; si sigue sin hablar → buzón.
- **Resolución de trunk:** BYOC (`sip_trunks.lk_trunk_id`) → `outbound_trunk_id` explícito →
  default de plataforma (`LIVEKIT_SIP_OUTBOUND_TRUNK_ID`).
- **Timeout de timbrado:** 30 s antes de marcar `no_answer`.
- Actualiza cada fila de `call_queue` con estado, duración y costos estimados, y los contadores
  de la campaña.

#### 🇬🇧 English

Process launched by the API (`python dialer.py <campaign_id>`) when a campaign starts.

- **Main loop:** `run_campaign(campaign_id)` reads campaign config, resolves the SIP trunk,
  creates a concurrency semaphore (`max_concurrent`), and pulls `pending` rows from `call_queue`,
  spawning a `_dial(...)` task per row.
- **Answering-machine detection (AMD) — 3 checkpoints** after pickup: ~25 s (no AI activity →
  voicemail), ~50 s (no customer speech yet → defer), ~50 s + 8 s grace (final `customer_spoke`
  check → voicemail if silent).
- **Trunk resolution:** BYOC → explicit `outbound_trunk_id` → platform default.
- **Ring timeout:** 30 s before marking `no_answer`.

**Archivo clave / Key file:** `services/dialer/dialer.py`.

---

### 3.4 `services/dashboard/` — Dashboard (Next.js)

#### 🇪🇸 Español

UI de administración. **Next.js 16 (App Router) + React 19 + TypeScript + Tailwind 4 + Radix
UI**, con `@livekit/components-react` para hablar con el agente en vivo y `recharts` para los
gráficos de costos. La autenticación es por JWT guardado en `localStorage` (no usa el cliente de
Supabase directamente).

**Mapa de rutas (`app/`):**
- **Operación:** `/dashboard` (KPIs y costos), `/calls` (registro de llamadas), `/campaigns`
  (campañas), `/sessions` + `/sessions/[id]` (sesiones y desglose de costo), `/agent` (hablar
  con el agente para probar).
- **Administración:** `/admin/clients`, `/admin/agents` + `/admin/agents/[id]` (constructor de
  agentes), `/admin/users`, `/admin/sip-trunks` (BYOC), `/settings`.
- **Portal cliente:** `/portal` + `/portal/campaigns` (vista reducida, solo lectura, para
  clientes).
- **Auth:** `/login` (login unificado), `/auth/set-password` (usuarios invitados fijan su clave).

**Autenticación (archivos `lib/`):**
- `lib/auth.ts` → `unifiedLogin(email, password)` hace POST a `/auth/login`; el backend
  determina el rol (admin vs cliente) y devuelve el token. Según el rol se guarda en
  `admin_token` o `portal_token` y redirige a `/dashboard` o `/portal`.
- `lib/admin-auth.ts` / `lib/portal-auth.ts` → wrappers de fetch que adjuntan el `Bearer` y
  redirigen a `/login` ante un 401.
- `lib/api-config.ts` → resuelve la URL base de la API (`NEXT_PUBLIC_API_URL`, o
  `http://<host>:8000` en navegador, o `localhost:8000` en SSR).

**Constructor de agentes (`app/admin/agents/[id]/`)** — estilo VAPI, con pestañas:
`PromptTab` (prompt + saludo + idle), `ModelVoiceTab` (LLM, STT, TTS, voz, temperatura,
idioma), `ToolsTab` (tools builtin/webhook), `KnowledgeTab` (base de conocimiento),
`VersionsTab` (historial + rollback), `PlaygroundTab` (chat de prueba sin llamar). Los tipos
están en `types.ts`.

#### 🇬🇧 English

Admin UI. **Next.js 16 (App Router) + React 19 + TypeScript + Tailwind 4 + Radix UI**, with
`@livekit/components-react` for live agent testing and `recharts` for cost charts. Auth is via a
JWT stored in `localStorage` (it does not use the Supabase client directly).

- **Routes:** Operations (`/dashboard`, `/calls`, `/campaigns`, `/sessions`, `/agent`),
  Administration (`/admin/clients`, `/admin/agents/[id]`, `/admin/users`, `/admin/sip-trunks`,
  `/settings`), Client portal (`/portal/campaigns`), Auth (`/login`, `/auth/set-password`).
- **Auth files:** `lib/auth.ts` (`unifiedLogin`), `lib/admin-auth.ts` & `lib/portal-auth.ts`
  (fetch wrappers attaching `Bearer`, redirect on 401), `lib/api-config.ts` (API base URL).
- **Agent builder (`app/admin/agents/[id]/`)** — VAPI-style tabs: Prompt, Model & Voice, Tools,
  Knowledge, Versions, Playground. Types in `types.ts`.

**Carpeta clave / Key folder:** `services/dashboard/app/`, `services/dashboard/lib/`.

---

## 4. Base de datos / Database (Supabase)

### 🇪🇸 Español

Postgres gestionado por Supabase. El esquema base está en
[`docs/supabase_schema.sql`](docs/supabase_schema.sql).

| Tabla | Propósito |
|-------|-----------|
| `sessions` | **Fuente de verdad de las llamadas.** Una fila por conversación: inicio/fin, costo total, `cost_by_provider`, `room_name`, `transcript`, `twilio_call_sid`, `end_reason`, `customer_spoke`, `recording_url`. |
| `api_usage` | **Costo granular.** Una fila por evento de consumo (provider, model, metric_type, metric_value, cost_usd) ligada a `session_id`. |
| `campaigns` | Definición de campañas batch (nombre, estado, `max_concurrent`, trunk, `agent_id`, contadores). |
| `call_queue` | Contactos por campaña esperando ser llamados (teléfono, nombre, estado, resultado por fila). |
| `agents` | Configuración de cada agente (prompt, saludo, `llm_model`, `stt_provider`/`stt_model`, `tts_provider`/`tts_model`, `voice_id`, temperatura, idioma, idle). |
| `agent_knowledge` | Fragmentos de conocimiento que se inyectan en el prompt en runtime. |
| `agent_tools` | Tools por agente (`builtin` o `webhook`) con su config (url, método, parámetros). |
| `clients` | Cuentas de cliente (multi-tenant). |
| `admin_users` | Usuarios administradores de la plataforma. |
| `sip_trunks` | Trunks SIP BYOC (Bring Your Own Carrier) por cliente. |
| `tigo_leads` | Leads capturados por las tools del agente Camila. |

**Relaciones clave:** `clients` 1→N `agents`; `agents` 1→N `agent_knowledge`, `agent_tools`,
`sessions`; `campaigns` 1→N `call_queue` y (vía `room_name`) `sessions`; `sessions` 1→N
`api_usage`.

> ⚠️ La disposición real de una llamada se lee de `sessions.end_reason`, **no** de
> `call_queue.status` (que puede quedar desactualizado).

### 🇬🇧 English

Postgres managed by Supabase. Base schema lives in
[`docs/supabase_schema.sql`](docs/supabase_schema.sql). See the table above for each table's
purpose (column notes are language-independent).

**Key relationships:** `clients` 1→N `agents`; `agents` 1→N `agent_knowledge`, `agent_tools`,
`sessions`; `campaigns` 1→N `call_queue` and (via `room_name`) `sessions`; `sessions` 1→N
`api_usage`.

> ⚠️ A call's real disposition comes from `sessions.end_reason`, **not** `call_queue.status`
> (which can be stale).

---

## 5. Modelo de costos / Cost model

### 🇪🇸 Español

Las tarifas viven en `PRICING` dentro de
[`services/agent/src/cost_logger.py`](services/agent/src/cost_logger.py). **Actualízalas ahí**
cuando cambien los precios de los proveedores.

| Proveedor | Modelo | Tarifa | Unidad |
|-----------|--------|--------|--------|
| OpenAI | `gpt-4o` | $2.50 in / $10.00 out | por 1M tokens |
| OpenAI | `gpt-4o-mini` | $0.15 in / $0.60 out | por 1M tokens |
| Deepgram | `nova-3` / `nova-2` | $0.0043 | por minuto |
| ElevenLabs | `eleven_turbo_v2_5` | $0.18 | por 1K caracteres |
| ElevenLabs | `eleven_flash_v2_5` | $0.11 | por 1K caracteres |
| Inworld STT | `inworld/inworld-stt-1` | $0.0025 | por minuto |
| Inworld TTS | `inworld-tts-1` / `-1.5-max` | $0.05 | por 1K caracteres |

**Cómo se calcula:** durante la llamada, el agente escucha el evento `metrics_collected` de
LiveKit y llama a `CostLogger.log_openai/log_deepgram/log_elevenlabs/...`. Cada llamada calcula
el costo (`_calc_*_cost`) e inserta una fila en `api_usage` con el consumo real medido.

> **Importante:** el costo en `api_usage`/`sessions` es **real** (medido). El dialer
> (`dialer.py`) hace una **estimación aparte** por minuto solo para mostrar progreso; no es la
> cifra autoritativa. El costo de **Twilio** (la parte telefónica, ~$0.013/min saliente) **no**
> está incluido en `cost_logger.py` — solo cubre IA. Si necesitas el costo telefónico exacto,
> hay que conciliarlo contra la facturación de Twilio.

### 🇬🇧 English

Rates live in `PRICING` inside
[`services/agent/src/cost_logger.py`](services/agent/src/cost_logger.py). **Update them there**
when provider prices change (see the rate table above).

**How it's computed:** during the call the agent listens to LiveKit's `metrics_collected` event
and calls `CostLogger.log_*`. Each call computes the cost (`_calc_*_cost`) and inserts a row into
`api_usage` with real measured usage.

> **Important:** the cost in `api_usage`/`sessions` is **real** (measured). The dialer
> (`dialer.py`) does a **separate per-minute estimate** only to show progress — not authoritative.
> **Twilio** telephony cost (~$0.013/min outbound) is **not** included in `cost_logger.py`
> (it only covers AI). For exact telephony cost, reconcile against Twilio billing.

---

## 6. Variables de entorno / Environment variables

### 🇪🇸 Español

Plantilla en [`.env.example`](.env.example). Copia a `.env` y rellena los valores.

| Variable | Obligatoria | Para qué sirve |
|----------|:-----------:|----------------|
| `LIVEKIT_URL` | ✅ | URL del servidor LiveKit (`ws://livekit:7880` en Docker) |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | ✅ | Credenciales de LiveKit (deben coincidir con `livekit.yaml`/`sip.yaml`) |
| `OPENAI_API_KEY` | ✅ | LLM (GPT-4o) |
| `DEEPGRAM_API_KEY` | ✅ | STT (nova-3) |
| `ELEVEN_API_KEY` | ✅ | TTS (ElevenLabs) |
| `ELEVEN_VOICE_ID` | ⬜ | Voz por defecto (fallback `6uZeZ0TKIeJahuKIBwp7`) |
| `INWORLD_API_KEY` | ⬜ | Proveedor STT/TTS alternativo (clave base64) |
| `SUPABASE_URL` | ✅ | Endpoint de Postgres/Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Clave admin (servidor) |
| `SUPABASE_ANON_KEY` | ✅ | Clave pública (cliente) |
| `DATABASE_URL` | ⬜ | Conexión directa a Postgres |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | ✅ | Cuenta Twilio (telefonía) |
| `TWILIO_PHONE_NUMBER` | ✅ | Caller ID saliente (ej. `+18782849980`) |
| `TWILIO_SIP_TRUNK_SID` | ⬜ | Identificador del trunk SIP en Twilio |
| `TWILIO_SIP_AUTH_USER` / `TWILIO_SIP_AUTH_PASS` | ⬜ | Credenciales del trunk SIP |
| `SIP_SERVER_IP` | ✅ | IP pública del servidor (`44.247.225.191`) |
| `LIVEKIT_SIP_OUTBOUND_TRUNK_ID` | ✅ | Trunk saliente (lo llena `scripts/setup_sip_trunks.py`) |
| `API_PORT` | ⬜ | Puerto de la API (default 8000) |

**Variables opcionales adicionales usadas por el código** (no están en `.env.example`, agrégalas
si las necesitas): multi-cuenta Panamá (`TWILIO_ACCOUNT_SID_PA`, `TWILIO_AUTH_TOKEN_PA`,
`TWILIO_PHONE_NUMBER_PA`, `LIVEKIT_SIP_OUTBOUND_TRUNK_PA`), `LIVEKIT_PUBLIC_URL` (clientes en
navegador), `FRONTEND_URL` (enlaces de correo), overrides de modelo (`LLM_MODEL`, `STT_MODEL`,
`TTS_MODEL`) y webhooks N8N (`N8N_WEBHOOK_INFO_TIGO`, `N8N_WEBHOOK_TIGO_CORREO`).

### 🇬🇧 English

Template in [`.env.example`](.env.example). Copy it to `.env` and fill in the values (see the
table above; required vars are marked ✅).

**Additional optional vars used by the code** (not in `.env.example`, add them if needed):
Panama multi-account (`TWILIO_*_PA`, `LIVEKIT_SIP_OUTBOUND_TRUNK_PA`), `LIVEKIT_PUBLIC_URL`
(browser clients), `FRONTEND_URL` (email links), model overrides (`LLM_MODEL`, `STT_MODEL`,
`TTS_MODEL`), and N8N webhooks (`N8N_WEBHOOK_INFO_TIGO`, `N8N_WEBHOOK_TIGO_CORREO`).

---

## 7. Cómo correr localmente / Running locally

### 🇪🇸 Español

**Requisitos:** Docker + Docker Compose. Llaves de los proveedores. Un proyecto Supabase con el
esquema de `docs/supabase_schema.sql`.

```bash
# 1. Configurar variables
cp .env.example .env      # luego edita .env con tus llaves

# 2. Levantar todo
docker compose up --build

# 3. Acceder
#   Dashboard → http://localhost:3000
#   API       → http://localhost:8000  (healthcheck: /health)
#   LiveKit   → ws://localhost:7880
```

- Los servicios `api`, `agent` y `dashboard` montan el código como volumen → **hot-reload** sin
  reconstruir la imagen (para `agent`, edita `services/agent/src/`).
- **Solo el dashboard** (sin Docker): `cd services/dashboard && npm install && npm run dev`,
  apuntando a una API en `:8000` (vía `NEXT_PUBLIC_API_URL` o detección automática del host).
- **Puertos:** 3000 dashboard, 8000 API, 7880–7882 LiveKit, 5060 + 10000–20000 SIP/RTP.

### 🇬🇧 English

**Requirements:** Docker + Docker Compose. Provider keys. A Supabase project with the schema in
`docs/supabase_schema.sql`.

```bash
cp .env.example .env       # then edit .env with your keys
docker compose up --build
# Dashboard → http://localhost:3000 | API → http://localhost:8000 | LiveKit → ws://localhost:7880
```

- `api`, `agent` and `dashboard` mount the code as a volume → **hot-reload** without rebuilding
  (for `agent`, edit `services/agent/src/`).
- **Dashboard only** (no Docker): `cd services/dashboard && npm install && npm run dev`, pointing
  at an API on `:8000`.

---

## 8. Despliegue / Deployment

### 🇪🇸 Español

Producción: un único EC2 (`44.247.225.191`). Dominios: dashboard en
`dashboard.voicemedia.ai`, API en `api.voicemedia.ai`.

Scripts en [`scripts/`](scripts/):
- **`deploy_server.sh`** — instala Docker + uv, clona/actualiza el repo, abre puertos del
  firewall, hace `docker compose up -d` y corre el setup de SIP.
- **`setup_sip_trunks.py`** — crea los trunks SIP de LiveKit (entrante y saliente) hacia Twilio
  y guarda `LIVEKIT_SIP_OUTBOUND_TRUNK_ID` en `.env`.
- **`setup_panama_sip.py`** — variante para la cuenta/trunk de Panamá.
- **`sip_firewall.sh`** — reglas iptables que restringen el puerto 5060 a las IPs de
  **Twilio/Telnyx** (whitelist) y permiten el rango RTP 10000–20000. Endurece la seguridad del
  SIP.

**Pasos típicos de actualización:** `git pull` en el servidor → `docker compose up -d --build`
(los volúmenes de código permiten cambios sin rebuild en muchos casos).

### 🇬🇧 English

Production: a single EC2 (`44.247.225.191`). Domains: dashboard at `dashboard.voicemedia.ai`,
API at `api.voicemedia.ai`.

Scripts in [`scripts/`](scripts/): `deploy_server.sh` (installs Docker + uv, clones/updates the
repo, opens firewall ports, `docker compose up -d`, runs SIP setup), `setup_sip_trunks.py`
(creates LiveKit SIP trunks → Twilio, saves `LIVEKIT_SIP_OUTBOUND_TRUNK_ID`),
`setup_panama_sip.py` (Panama variant), `sip_firewall.sh` (iptables rules whitelisting
Twilio/Telnyx IPs on port 5060 and allowing RTP 10000–20000).

**Typical update:** `git pull` on the server → `docker compose up -d --build`.

---

## 9. Cómo hacer cambios comunes / How to make common changes

### 🇪🇸 Español

**➤ Crear o editar un agente.** Vía UI: `/admin/agents` → selecciona/crea → `/admin/agents/[id]`.
Edita prompt, saludo, modelos, voz, tools y knowledge en las pestañas. Cada guardado crea una
versión (rollback en `VersionsTab`). En runtime, `_load_agent_config(agent_id)` en
`services/agent/src/agent.py` arma la config combinando `agents` + `agent_knowledge` +
`agent_tools`. *(Sin agente en BD, el agente usa los defaults hardcodeados de Camila.)*

**➤ Agregar una tool nueva.** En la pestaña **Tools**:
- *builtin* → activa una de las funciones ya implementadas en `agent.py`
  (`info_tigo`, `tigo_correo`, `calcular_tigo_fecha_cobro`). Para una nueva builtin, impleméntala
  en `agent.py` y regístrala en `agent_tools`.
- *webhook* → define url, método y parámetros (JSON Schema); el agente la construye dinámicamente
  y hace el HTTP cuando el LLM la invoca.

**➤ Cambiar modelo o voz.** Pestaña **Model & Voice**: ajusta `llm_model`, `stt_provider`/
`stt_model`, `tts_provider`/`tts_model`, `voice_id`, `temperature`, `language`. Si añades un
modelo nuevo con tarifa distinta, agrega su precio en `PRICING` de `cost_logger.py`.

**➤ Lanzar una campaña.** `/campaigns` → crear (nombre, concurrencia, agente, trunk) → subir CSV
de números (`/campaigns/{id}/upload`) → **Start**. La API lanza `dialer.py`, que marca respetando
`max_concurrent` y aplica AMD. Sigue el progreso en la misma página o en `/campaigns/{id}/logs`.

**➤ Agregar un número/trunk SIP (BYOC).** `/admin/sip-trunks` para registrar el trunk del
cliente; luego asígnalo a la campaña. La prioridad de resolución en el dialer es BYOC → explícito
→ default de plataforma.

**➤ Ver costos y transcripciones.** Costos: `/dashboard` (KPIs y gráfico) y `/sessions/[id]`
(desglose por proveedor desde `api_usage`). Transcripciones y grabaciones: `/calls` y la sesión
correspondiente.

### 🇬🇧 English

**➤ Create/edit an agent.** UI: `/admin/agents` → `/admin/agents/[id]`; edit prompt, greeting,
models, voice, tools, knowledge across tabs (each save creates a version, rollback in
`VersionsTab`). At runtime, `_load_agent_config(agent_id)` in `agent.py` merges `agents` +
`agent_knowledge` + `agent_tools`.

**➤ Add a tool.** Tools tab: *builtin* (enable an existing function in `agent.py`) or *webhook*
(define url/method/parameters; built dynamically and called over HTTP when the LLM invokes it).
For a brand-new builtin, implement it in `agent.py` and register it in `agent_tools`.

**➤ Change model/voice.** Model & Voice tab: `llm_model`, `stt_provider`/`stt_model`,
`tts_provider`/`tts_model`, `voice_id`, `temperature`, `language`. Add new models with different
rates to `PRICING` in `cost_logger.py`.

**➤ Launch a campaign.** `/campaigns` → create → upload CSV (`/campaigns/{id}/upload`) → Start.
The API launches `dialer.py` (honors `max_concurrent`, applies AMD). Track progress on the page
or `/campaigns/{id}/logs`.

**➤ Add a SIP number/trunk (BYOC).** Register it in `/admin/sip-trunks`, assign to a campaign.
Dialer resolution order: BYOC → explicit → platform default.

**➤ View costs & transcripts.** Costs: `/dashboard` and `/sessions/[id]` (per-provider breakdown
from `api_usage`). Transcripts/recordings: `/calls` and the related session.

---

## 10. Convenciones y gotchas / Conventions & gotchas

### 🇪🇸 Español

- **Idioma del proyecto:** la UI, los comentarios y muchos nombres están en **español** (mercado
  LatAm). Mantén la coherencia al contribuir.
- **`sessions.end_reason` manda:** es la disposición real de la llamada; `call_queue.status` puede
  quedar obsoleto. La API consolida estadísticas a partir de `sessions`.
- **Detección de buzón:** combina regex de frases (`_looks_like_voicemail` en el agente) con la
  heurística AMD de 3 checkpoints del dialer. Ajusta ambas si hay falsos positivos/negativos.
- **Race del `twilio_call_sid`:** si el agente cierra antes de obtener el SID, los background
  tasks de la API (`_backfill_sid_by_phone`, `_backfill_recordings`) lo recuperan después; no lo
  consideres faltante de inmediato.
- **Costo IA ≠ costo telefónico:** `cost_logger.py` solo mide IA. Twilio se concilia aparte.
- **Tarifas hardcodeadas:** los precios viven en `PRICING` (`cost_logger.py`) y en el estimador
  del dialer; actualiza ambos al cambiar tarifas.
- **Secretos:** nunca commitees `.env`. Usa `.env.example` como plantilla.

### 🇬🇧 English

- **Project language:** UI, comments and many names are in **Spanish** (LatAm market). Keep it
  consistent when contributing.
- **`sessions.end_reason` is authoritative:** it's the real call disposition; `call_queue.status`
  may be stale. The API consolidates stats from `sessions`.
- **Voicemail detection:** phrase regex (`_looks_like_voicemail` in the agent) + the dialer's
  3-checkpoint AMD heuristic. Tune both for false positives/negatives.
- **`twilio_call_sid` race:** if the agent exits before getting the SID, API background tasks
  (`_backfill_sid_by_phone`, `_backfill_recordings`) recover it later; don't treat it as missing
  immediately.
- **AI cost ≠ telephony cost:** `cost_logger.py` measures AI only. Twilio is reconciled separately.
- **Hardcoded rates:** prices live in `PRICING` (`cost_logger.py`) and the dialer estimator;
  update both when rates change.
- **Secrets:** never commit `.env`. Use `.env.example` as the template.

---

### Mapa rápido de archivos / Quick file map

| Quiero tocar… / I want to touch… | Archivo / File |
|----------------------------------|----------------|
| Lógica del agente / Agent logic | `services/agent/src/agent.py` |
| Tarifas de costos / Cost rates | `services/agent/src/cost_logger.py` |
| Endpoints / Endpoints | `services/api/main.py` |
| Marcador batch / Batch dialer | `services/dialer/dialer.py` |
| UI / Frontend | `services/dashboard/app/`, `services/dashboard/lib/` |
| Constructor de agentes / Agent builder | `services/dashboard/app/admin/agents/[id]/` |
| Orquestación / Orchestration | `docker-compose.yml` |
| Config LiveKit/SIP | `livekit.yaml`, `sip.yaml` |
| Esquema BD / DB schema | `docs/supabase_schema.sql` |
| Despliegue / Deployment | `scripts/` |

# testing branch protection
