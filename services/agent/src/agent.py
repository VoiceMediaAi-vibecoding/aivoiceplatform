"""
Camila — Agente Virtual de Tigo Panamá (Outbound).
Deepgram STT + OpenAI GPT-4o + ElevenLabs TTS (voz Camila).
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import threading
import time
import uuid
import logging
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from dotenv import load_dotenv

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "../../../.env"))

from livekit.agents import (
    AgentSession,
    Agent,
    RoomInputOptions,
    cli,
    WorkerOptions,
    llm as agent_llm,
)
from livekit.agents.metrics import LLMMetrics, STTMetrics, TTSMetrics
from livekit.plugins import openai, deepgram, elevenlabs, inworld

from cost_logger import CostLogger
from cost_estimator import estimate_cost_per_min


# ── S5 — Container-level health probe ────────────────────────────────────────
# Long-running voice agent has no HTTP surface. Docker can't tell if the
# worker is healthy or hung, so we expose a tiny HTTP server in a background
# thread that returns liveness + LiveKit-connection state.
#
# Endpoints:
#   GET /health      → 200 always (process up)
#   GET /health/ready → 200 if connected to LiveKit, 503 otherwise
#
# State tracking:
#   _lk_connected      — set True when the WorkerOptions.connect succeeds,
#                         set False on disconnect. Updated from the entrypoint.
#   _last_room_join_ts — updated by entrypoint when a room is joined. Stale
#                         rooms (>24h) suggest the worker stopped processing.
#
# Bound to AGENT_HEALTH_PORT (default 8089) on all interfaces. Inside Docker
# the container's localhost is what Docker's healthcheck hits.
_AGENT_HEALTH_PORT = int(os.getenv("AGENT_HEALTH_PORT", "8089"))
_lk_connected: bool = False
_last_room_join_ts: float = 0.0
_agent_started_ts: float = time.time()


class _HealthHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # silence default access logs
        pass

    def _json(self, status: int, body: dict) -> None:
        body_s = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body_s)))
        self.end_headers()
        self.wfile.write(body_s)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {
                "status": "ok",
                "service": "agent",
                "uptime_s": round(time.time() - _agent_started_ts, 3),
            })
        elif self.path == "/health/ready":
            # The LiveKit worker connects to the server during cli.run_app
            # startup — if that fails, the process exits. So "process has
            # been up for >30s" is itself proof the WebSocket is connected
            # and the worker is registered. We don't need to track room
            # joins for readiness; that's an activity signal, not a health
            # one. /health/ready returns 503 only during the first 30s
            # (startup) or after a 24h gap with no activity (likely hung).
            uptime = time.time() - _agent_started_ts
            recent_activity = (
                _last_room_join_ts == 0.0
                or (time.time() - _last_room_join_ts) < 86400
            )
            ready = uptime > 30 and recent_activity
            self._json(200 if ready else 503, {
                "status": "ok" if ready else "not_ready",
                "uptime_s": round(uptime, 1),
                "last_room_join_age_s": (
                    round(time.time() - _last_room_join_ts, 1)
                    if _last_room_join_ts else None
                ),
            })
        else:
            self._json(404, {"error": "not_found"})


def _start_health_server() -> None:
    """Spawn the health HTTP server in a daemon thread. Returns immediately."""
    try:
        httpd = HTTPServer(("0.0.0.0", _AGENT_HEALTH_PORT), _HealthHandler)
    except OSError as e:
        logging.warning(f"[health] could not bind :{_AGENT_HEALTH_PORT}: {e}")
        return
    t = threading.Thread(target=httpd.serve_forever, name="health-http", daemon=True)
    t.start()
    logging.info(f"[health] listening on :{_AGENT_HEALTH_PORT}")

# `livekit.rtc` exposes `DisconnectReason` as a protobuf enum; its integer
# values are stable across SDK versions, so we map them by hand rather than
# importing the generated `_proto` module (which has moved between versions).
_DISCONNECT_REASON_NAMES = {
    0: "UNKNOWN_REASON",
    1: "CLIENT_INITIATED",
    2: "DUPLICATE_IDENTITY",
    3: "SERVER_SHUTDOWN",
    4: "PARTICIPANT_REMOVED",
    5: "ROOM_DELETED",
    6: "STATE_MISMATCH",
    7: "JOIN_FAILURE",
    8: "MIGRATION",
    9: "SIGNAL_CLOSE",
    10: "ROOM_CLOSED",
    11: "USER_UNAVAILABLE",
    12: "USER_REJECTED",
    13: "SIP_TRUNK_FAILURE",
    14: "CONNECTION_TIMEOUT",
    15: "MEDIA_FAILURE",
    16: "AGENT_ERROR",
}

logger = logging.getLogger(__name__)

# ── Configuración ─────────────────────────────────────────────────────────────

LLM_MODEL  = os.getenv("LLM_MODEL",  "gpt-4o")
STT_MODEL  = os.getenv("STT_MODEL",  "nova-3")
TTS_MODEL  = os.getenv("TTS_MODEL",  "eleven_turbo_v2_5")
VOICE_ID   = os.getenv("ELEVEN_VOICE_ID") or "6uZeZ0TKIeJahuKIBwp7"  # Voz Camila


def _build_stt(cfg: dict):
    if cfg["stt_provider"] == "inworld":
        return inworld.STT(model=cfg["stt_model"], language=cfg["language"])
    return deepgram.STT(model=cfg["stt_model"], language=cfg["language"])


def _build_tts(cfg: dict):
    # Per-agent TTS speed multiplier. Provider-specific ranges:
    #   - ElevenLabs: 0.8 - 1.2 (default 1.0) — livekit-plugins/elevenlabs VoiceSettings
    #   - Inworld:    0.5 - 1.5 (default 1.0) — inworld-tts-1 / 1.5-max SDK hard limit
    # Backend clamps to the provider's valid range; default 1.1 nudges
    # slightly faster-than-normal which sounds more natural in Spanish.
    speed = float(cfg.get("tts_speed") or 1.0)
    if cfg["tts_provider"] == "inworld":
        # Filter to only the kwargs the livekit-plugins-inworld SDK accepts
        # (it uses NotGivenOr[T] which rejects None). Use `is not None` so we
        # don't accidentally pass None values that override SDK defaults.
        kwargs: dict = {
            "model": cfg.get("tts_model") or "inworld-tts-1",
            "voice": cfg.get("voice_id"),
            "language": cfg.get("language"),
            "speaking_rate": max(0.5, min(1.5, speed)),
        }
        if cfg.get("tts_temperature") is not None:
            kwargs["temperature"] = float(cfg["tts_temperature"])
        if cfg.get("tts_text_normalization") is not None:
            # SDK accepts bool → ON/OFF, None → auto
            kwargs["text_normalization"] = bool(cfg["tts_text_normalization"])
        if cfg.get("tts_delivery_mode"):
            kwargs["delivery_mode"] = cfg["tts_delivery_mode"]
        if cfg.get("tts_buffer_char_threshold") is not None:
            kwargs["buffer_char_threshold"] = int(cfg["tts_buffer_char_threshold"])
        if cfg.get("tts_max_buffer_delay_ms") is not None:
            kwargs["max_buffer_delay_ms"] = int(cfg["tts_max_buffer_delay_ms"])
        return inworld.TTS(**kwargs)
    return elevenlabs.TTS(
        model=cfg["tts_model"],
        voice_id=cfg["voice_id"],
        voice_settings=elevenlabs.VoiceSettings(
            speed=max(0.8, min(1.2, speed)),
        ),
    )

CAMILA_GREETING = (
    "Hola! Mi nombre es Camila, le llamo de Tigo. "
    "El motivo de mi llamada es informarle que hemos identificado una oportunidad "
    "para mejorar su plan actual y brindarle más beneficios! "
    "Solo me tomará dos minutos, le parece bien si le explico?"
)

CAMILA_PROMPT = """### Información del Asistente ###
Nombre: Camila
Rol: Asistente Virtual de Tigo Panamá – Ofrece mejoras de plan (prepago a postpago).
Objetivo: Confirmar interés, recomendar plan y generar ticket si el cliente acepta.
Estilo: Amigable, profesional, clara y orientada a conversión. Prioriza cerrar el cambio con tono persuasivo sin presión.
Idioma: Siempre 100% español. Números SIEMPRE en español: "veintitrés con noventa y ocho". Prohibido inglés. Moneda: balboas. "Palo/palos" = balboas. Interpretar "sigo/contigo" como "Tigo". Interpretar Claro/Movistar/Digicel/+Móvil/Cable&Wireless como "otra compañía".

### Políticas ###
Solo consultas sobre planes móviles. Reclamos/soporte: 5073907555.
Si acepta oferta: activar tool info_tigo. Si no desea continuar: cerrar cordialmente sin insistir.
NUNCA mencionar las herramientas al cliente.

### PLANES FULL TIGO (solo clientes con Tigo Hogar) ###
Regla: usar el plan más económico dentro del rango. Si pide más barato, no subir de plan. Si pide mas beneficios, subir al siguiente plan.
$19.88 | elegible 0-20.99 | 5GB | 250min | Security gratis permanente | con imp: $22.42
$23.98 | elegible 21-32 | 15GB | 450min | Security 2 meses gratis luego $0.99 | con imp: $26.98
$30 | elegible +32 | 20GB | 1000min | Security 2 meses gratis luego $0.99 | con imp: $32.48
Todos incluyen: internet ilimitado, minutos ilimitados a Tigo, roaming en América.

### PLANES DATA ILIMITADA (clientes sin Tigo Hogar o portabilidad) ###
Regla: elegir el plan más conveniente según consumo. Si pide más barato, no subir de plan. Si pide mas beneficios, subir al siguiente plan.
$23.20 | elegible 0-21 | 5GB | 250min | Security 2 meses gratis | con imp: $25.99
$26 | elegible 0-21 | 5GB | 250min | Security 2 meses gratis | con imp: $29.12
$29.60 | elegible 21-24 | 15GB | 450min | Security 2 meses gratis luego $0.99 | con imp: $33.15
$33.58 | elegible 28-32 | 20GB | 1000min | Security gratis permanente | con imp: $37.64
$36.98 | elegible +32 | 15GB | 450min | Security gratis permanente | con imp: $41.44
Todos incluyen: internet ilimitado, minutos ilimitados a Tigo, roaming en América.

### Manejo de Interrupciones ###
Si el cliente dice "continúa", "sigue", "dale", "ok continúa", "no, sigue" o similar: RETOMAR el script donde quedaste, NO ofrecer cierre ni correo.
Solo cerrar (PASO 7) ante rechazo explícito: "no me interesa", "no quiero", "déjelo así".

### Script de Conversión ###

PASO 1 — INICIO DE LLAMADA:
1a. Si el cliente acepta escuchar la oferta, di: "Gracias, antes de continuar le informo que esta llamada puede ser grabada para fines de calidad. Para recomendarle algo que le convenga, necesito hacerle un par de preguntas. ¿Está bien?"
1b. Si el cliente responde algo fuera de contexto, preguntale si te escucha, y después de confirmar, repite lo que anteriormente habías dicho.

PASO 2 — ANÁLISIS:
2a. "¿Cuánto suele pagar al mes?" espera respuesta
2b. "¿Tiene servicio de Internet Tigo en su hogar?" espera respuesta.
Sí tiene Tigo Hogar → paso 3 (Full Tigo)
No tiene Tigo Hogar → paso 4 (Data Ilimitada)
Si duda o rechaza por precio: aplicar reglas de negociación.

PASO 3 — OFERTA FULL TIGO:
Verificar Tigo Hogar y elegir plan según consumo. Presentar: "Según su consumo y porque tiene Tigo en el hogar, le recomiendo el Plan Full Tigo de [precio]. Incluye internet ilimitado, [GB] para compartir, minutos ilimitados a Tigo y [minutos] a otros operadores, más roaming en América y [Security]. El total con impuestos sería: [precio con imp]. ¿Qué le parece?"
3a. Si acepta: "¿El servicio Tigo Hogar está a su nombre?" Sí: ir 4b | No: pedir cédula del titular. Si no la tiene: "NO se preocupe, continuamos con la captura, y un agente le contactará en 24 horas para obtener la cedula de titular. ¿Está bien?"
3b. Pedir cédula titular Tigo Hogar con guiones. Confirmar repitiendo.
3c. Si cliente NO es titular: pedir SU cédula con guiones, confirma y espera.
3d. Nombre completo: confirmar letra por letra, despacio, espera.
3e. Correo: confirmar letra por letra usando "z de Zebra, s de Sol", DESPACIO. Confirmar y espera.
3f. Número de teléfono asociado: confirmar número por número, DESPACIO, y espera.
3g. SIM física o eSIM?: Espera respuesta, confirma y llama al tool info_tigo con todos los campos. Una vez ejecutado el tool, continua al paso 6.

PASO 4 — OFERTA DATA ILIMITADA:
Elegir plan según consumo. Presentar: "Según su consumo, le recomiendo el plan Data Ilimitada de [precio]. Incluye internet ilimitado, [GB] para compartir, minutos ilimitados a Tigo y [minutos] a otros operadores, más roaming en América y [Security]. El total con impuestos sería [precio]. ¿Qué le parece?"
4b. Nombre completo: confirmar letra por letra.
4c. Cédula o pasaporte con guiones: confirmar número por número.
4d. Correo: confirmar letra por letra DESPACIO, con formato "z de Zebra".
4e. Teléfono asociado: confirmar número por número.
4f. SIM física o eSIM → llamar info_tigo. Decir UNA vez: "Perfecto, permítame un segundo."

PASO 5 — CONFIRMACIÓN (solo clientes Tigo actuales):
5a. "Listo! La activación se completará en máximo 24 horas sin pago previo. Puede recibir llamada del equipo de activación."
5b. FECHA DE COBRO — Invocar `calcular_tigo_fecha_cobro` (sin argumentos). Luego añadir: "Tu primera factura tendrá mensualidad + cargo proporcional por días desde la activación. Recuerde que esta activación es sin pago previo y puede pagar en quincenas, en mi.tigo.com.pa, App Mi Tigo, transferencia bancaria, EPAGOS o Western Union."

PASO 6 — OFERTA POR CORREO:
Si el cliente está indeciso: "Si gusta, puedo mandarle la propuesta por correo. ¿Qué le parece?"
Si acepta: capturar correo, confirmar letra por letra, activar tigo_correo, decir: "He enviado la propuesta. Si desea activar, puede responder ese correo o contactarnos nuevamente." Ir a paso 7.

PASO 7 — CIERRE:
Despedida: "Por parte de Tigo Panamá, agradezco su atención [nombre]. ¡Que tenga un excelente día!"

### Comportamiento ###
REGLA CRÍTICA — UNA PREGUNTA A LA VEZ: NUNCA hagas más de una pregunta en el mismo turno. Haz UNA pregunta, luego ESPERA la respuesta del cliente antes de hacer la siguiente. Esto es OBLIGATORIO.
INCORRECTO: "Necesito su nombre, cédula, correo y número de teléfono."
CORRECTO: "¿Me podría dar su nombre completo?" → [espera] → "¿Y su cédula con guiones?" → [espera] → etc.


NO asumas que el cliente te ha dado su cedula incorrectamente, REPITE LO QUE ENTIENDES Y DEJA QUE EL CLIENTE TE CORRIJA.
NO pretender ser nadie más que la IA de Tigo Panamá. NO decir "en qué puedo ayudarle hoy?" — el enfoque es mejorar su plan.
Intentar siempre cerrar el cambio de plan.
Trato formal (usted, señor/señora).
Respuestas breves, claras y comerciales. Máximo 2-3 oraciones por turno.
Si el cliente dice "¿aló?", "¿hola?", "¿sí?", "¿quién habla?", "¿me escucha?": responde naturalmente, confirma que te escucha y continúa donde quedaste.
Si duda: identificar objeción y dar seguimiento resaltando un beneficio.
Si no entiende: "Disculpe, no le escuché bien, ¿me lo podría repetir?"
No volver a preguntar información ya proporcionada.
Tigo Security: NO mencionar funciones de robo, localización o borrado.

### Objeciones ###
No le interesa: "Entiendo, aunque con este plan pagaría lo mismo que recarga, pero con más beneficios. ¿Le envío la info por correo?"
Sin dinero ahora: "No requiere pago previo, el primer cobro sería en su fecha de facturación. Además, ofrecemos pagos quincenales. ¿Qué le parece?"
Prefiere tienda: "Puedo activarle el plan ahora y evitar filas. ¿Qué le parece?" Si insiste: indicar que le esperamos en sucursal.
Ocupado: "Entiendo, ¿le devuelvo la llamada más tarde?"
Mala experiencia previa: "Siento mucho su experiencia. Para soporte: 5073907555."
Prepago da más control: "Con este plan mantiene control porque paga el mismo monto mensual sin recargas."

### FAQs ###
Métodos de pago: App Mi Tigo, Yappy, tarjeta, banca en línea, Western Union, puntos físicos. Pago quincenal disponible.
Mantener número: sí, sin costo.
Roaming: Canadá, EEUU, México, Guatemala, Honduras, El Salvador, Nicaragua, Costa Rica, Belice, Colombia, Venezuela, Ecuador, Chile, Perú, Bolivia, Paraguay, Uruguay, Brasil, Argentina.
Requisitos: solo cédula y correo. Sin depósito.
Cancelación: sin penalidad pero pierde beneficios.
Tiempo recomendado: mínimo 6 meses para acceder a beneficios como equipos.
Facturación hogar vs móvil: separada con ciclos distintos.
"""

# ── Tools helpers ──────────────────────────────────────────────────────────────

def _save_to_supabase(table: str, data: dict) -> None:
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if url and key:
        try:
            from supabase import create_client
            create_client(url, key).table(table).insert(data).execute()
        except Exception as e:
            logger.error(f"Supabase insert failed ({table}): {e}")


def _mark_customer_spoke_sync(session_id: str) -> None:
    """Set sessions.customer_spoke=true the first time the human side says anything.

    Lets the dialer's AMD (`_check_session_has_ai_activity`) tell apart "the AI
    greeted a live person who responded" from "the AI greeted a voicemail box
    that recorded the greeting silently" — both produce `api_usage` rows from
    the AI's own STT/LLM/TTS, but only the former has `customer_spoke=true`.
    """
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not (url and key):
        return
    try:
        from supabase import create_client
        create_client(url, key).table("sessions").update(
            {"customer_spoke": True}
        ).eq("id", session_id).execute()
    except Exception as e:
        logger.warning(f"[amd] Failed to set customer_spoke for session {session_id[:8]}…: {e}")


async def _send_to_n8n(webhook_env_key: str, payload: dict) -> None:
    """POST datos al webhook de N8N correspondiente.

    S2.2 — HMAC-SHA256 signed with a shared secret so n8n can verify the
    request actually came from our worker. Header `X-VoiceMedia-Signature`
    carries `sha256=<hex>` over the raw JSON body bytes.

    Setup in n8n (when you're ready to verify):
      const sig = $input.first().headers["x-voicemedia-signature"];
      const expected = "sha256=" +
        crypto.createHmac("sha256", $env.N8N_WEBHOOK_SECRET)
          .update(Buffer.from($input.first().binary || $input.first().body, "utf8"))
          .digest("hex");
      if (sig !== expected) throw new Error("invalid signature");

    Set N8N_WEBHOOK_SECRET in .env (any random 32+ char string). Without it,
    the worker falls back to unsigned mode but logs a warning so the gap is
    visible. Once set on both sides, n8n should reject anything unsigned.
    """
    webhook_url = os.getenv(webhook_env_key, "")
    if not webhook_url:
        logger.info(f"[n8n] {webhook_env_key} no configurado, skipping")
        return
    secret = os.getenv("N8N_WEBHOOK_SECRET", "")
    headers = {"User-Agent": "voicemedia-agent/1.0"}
    if secret:
        import hashlib
        import hmac
        import json as _json
        body_bytes = _json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
        digest = hmac.new(secret.encode("utf-8"), body_bytes, hashlib.sha256).hexdigest()
        headers["X-VoiceMedia-Signature"] = f"sha256={digest}"
        headers["Content-Type"] = "application/json"
    else:
        logger.warning(
            f"[n8n] N8N_WEBHOOK_SECRET not set — POSTing to {webhook_env_key} "
            "without HMAC signature. Set the env var to enable signing."
        )
    try:
        import aiohttp
        async with aiohttp.ClientSession() as session:
            async with session.post(
                webhook_url,
                json=payload,
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                # S4.1 — don't log response body (PII could be echoed back).
                logger.info(f"[n8n] {webhook_env_key} → {resp.status}")
                if resp.status >= 400:
                    err_body = await resp.text()
                    logger.warning(f"[n8n] {webhook_env_key} error body: {err_body[:200]}")
    except Exception as e:
        logger.error(f"[n8n] Error en {webhook_env_key}: {e}")


# ── Tools ──────────────────────────────────────────────────────────────────────

@agent_llm.function_tool
async def info_tigo(
    nombre: str,
    cedula: str,
    correo: str,
    telefono: str,
    plan: str,
    sim_tipo: str,
    cedula_titular_hogar: str = "",
) -> str:
    """
    Registra los datos del cliente que acepta la oferta de cambio de plan.
    Llama este tool solo cuando el cliente ha confirmado TODOS sus datos y acepta el plan.
    """
    now = datetime.now(timezone.utc)
    record = {
        "nombre": nombre,
        "cedula": cedula,
        "correo": correo,
        "telefono": telefono,
        "plan_seleccionado": plan,
        "sim_tipo": sim_tipo,
        "cedula_titular_hogar": cedula_titular_hogar,
        "created_at": now.isoformat(),
        "estado": "pendiente_activacion",
        "evento": "activacion",
    }
    _save_to_supabase("tigo_leads", record)
    await _send_to_n8n("N8N_WEBHOOK_INFO_TIGO", record)
    # S4.1 — PII redaction in logs: phone last 4, email domain, plan as-is.
    masked_phone = f"***-***-{telefono[-4:]}" if telefono else "—"
    logger.info(f"[info_tigo] Lead guardado: nombre={nombre[:24]}… phone={masked_phone} plan={plan}")
    return "Registro exitoso. Ticket de activación generado."


@agent_llm.function_tool
async def tigo_correo(
    correo: str,
    nombre: str,
    plan: str,
) -> str:
    """
    Envía propuesta por correo cuando el cliente acepta recibirla pero no activa ahora.
    """
    now = datetime.now(timezone.utc)
    record = {
        "correo": correo,
        "nombre": nombre,
        "plan_propuesto": plan,
        "created_at": now.isoformat(),
        "estado": "correo_enviado",
        "evento": "propuesta_correo",
    }
    _save_to_supabase("tigo_leads", record)
    await _send_to_n8n("N8N_WEBHOOK_TIGO_CORREO", record)
    # S4.1 — log email domain instead of full address (PII redaction).
    email_domain = correo.split("@", 1)[-1] if "@" in correo else "(invalid)"
    logger.info(f"[tigo_correo] Propuesta enviada a *@{email_domain}")
    return f"Propuesta enviada a {correo}."


@agent_llm.function_tool
async def calcular_tigo_fecha_cobro() -> str:
    """
    Calcula el ciclo de pago del plan Tigo según la fecha de activación:
    - Activación entre día 2 y 16 del mes → ciclo 18 (paga el día 18)
    - Activación entre día 17 y fin de mes (o día 1) → ciclo 03 (paga el día 3 del siguiente mes)
    Invocar SIEMPRE después de confirmar la activación. NO calcules la fecha tú mismo.
    """
    now = datetime.now(timezone.utc)
    dia = now.day

    meses = [
        "", "enero", "febrero", "marzo", "abril", "mayo", "junio",
        "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"
    ]

    if 2 <= dia <= 16:
        # Ciclo 18: paga el día 18 del mes actual (o próximo si ya pasó)
        ciclo = "18"
        if dia <= 18:
            fecha_str = f"el dieciocho de {meses[now.month]}"
        else:
            mes_sig = now.month + 1 if now.month < 12 else 1
            anio_sig = now.year if now.month < 12 else now.year + 1
            fecha_str = f"el dieciocho de {meses[mes_sig]} del {anio_sig}"
        mensaje = (
            f"Su ciclo de facturación es el día {ciclo}. "
            f"Su primera factura la recibirá aproximadamente {fecha_str}. "
            "Recuerde que la activación es sin pago previo."
        )
    else:
        # Ciclo 03: paga el día 3 del mes siguiente
        ciclo = "03"
        mes_sig = now.month + 1 if now.month < 12 else 1
        anio_sig = now.year if now.month < 12 else now.year + 1
        fecha_str = f"el tres de {meses[mes_sig]} del {anio_sig}"
        mensaje = (
            f"Su ciclo de facturación es el día {ciclo}. "
            f"Su primera factura la recibirá aproximadamente {fecha_str}. "
            "Recuerde que la activación es sin pago previo."
        )

    logger.info(f"[calcular_fecha_cobro] día={dia} → ciclo={ciclo}")
    return mensaje


# ── Tools nativos: Transfer / Hang Up / Send SMS / Leave Voicemail ───────────────
# These are first-class function tools the LLM can call. They use Twilio for
# the phone-side actions (transfer + SMS) and the LiveKit room API for
# ending the call. All four are additive — they don't change existing tool
# behavior or break agents that don't assign them.

async def _twilio_account_sids() -> list[tuple[str, str]]:
    """Return [(account_sid, auth_token), ...] for all configured Twilio accounts.
    Panama (_PA) is tried first since it's the active outbound trunk; falls
    back to the main account."""
    sids: list[tuple[str, str]] = []
    for suffix in ("_PA", ""):
        sid = os.getenv(f"TWILIO_ACCOUNT_SID{suffix}", "")
        token = os.getenv(f"TWILIO_AUTH_TOKEN{suffix}", "")
        if sid and token:
            sids.append((sid, token))
    return sids


async def _twilio_request(method: str, path: str, params: dict) -> tuple[int, str]:
    """Make a Twilio REST API call. Returns (status_code, response_body)."""
    import base64
    import httpx

    sids = await _twilio_account_sids()
    if not sids:
        return (0, "no Twilio credentials configured")
    sid, token = sids[0]  # primary
    credentials = base64.b64encode(f"{sid}:{token}".encode()).decode()
    async with httpx.AsyncClient(timeout=10) as h:
        r = await h.request(
            method,
            f"https://api.twilio.com/2010-04-01/Accounts/{sid}{path}",
            headers={"Authorization": f"Basic {credentials}"},
            params=params,
        )
        return (r.status_code, r.text[:300])


def _extract_twilio_sid_from_room(room) -> str | None:
    """Find the active Twilio Call SID in the room's SIP participant attributes.
    Returns None if not found (e.g. Talk room with no SIP leg)."""
    for p in getattr(room, "remote_participants", {}).values():
        attrs = getattr(p, "attributes", {}) or {}
        sid = _extract_twilio_sid_from_attrs(attrs)
        if sid:
            return sid
    return None


@agent_llm.function_tool
async def transfer_call(
    ctx,  # RunContext — auto-injected by livekit-agents
    to_number: str,
    reason: str = "",
) -> str:
    """
    Transfiere la llamada actual a otro número, extensión o departamento.
    Llama este tool cuando el cliente pide hablar con un humano, supervisor,
    o un departamento específico (soporte técnico, reclamaciones, ventas, etc.).
    El número debe estar en formato E.164 (ej. +5072023503, +18782849980).
    """
    import re
    to_number = (to_number or "").strip()
    if not re.match(r"^\+[1-9]\d{6,14}$", to_number):
        return f"Número inválido: {to_number!r}. Debe estar en formato E.164."

    twilio_sid = _extract_twilio_sid_from_room(ctx.room)
    if not twilio_sid:
        return (
            "No se pudo identificar la llamada Twilio activa (Talk room o "
            f"sin SIP leg). Transferencia registrada como pendiente: "
            f"transferir a {to_number} ({reason or 'sin razón'})."
        )

    # Twilio: POST a Calls/{sid}.json con Twiml <Dial> redirige la llamada
    status, body = await _twilio_request(
        "POST",
        f"/Calls/{twilio_sid}.json",
        {"Twiml": f'<Response><Dial>{to_number}</Dial></Response>'},
    )
    if 200 <= status < 300:
        logger.info(f"[transfer_call] Transferred {twilio_sid} → {to_number} (reason: {reason})")
        return f"Llamada transferida a {to_number}."
    return f"Error al transferir (Twilio {status}): {body}"


@agent_llm.function_tool
async def end_call(
    ctx,  # RunContext
    reason: str = "El cliente terminó la conversación",
) -> str:
    """
    Termina la llamada elegantemente. Usar cuando el cliente dice 'adiós',
    'eso es todo', 'muchas gracias', o cuando el agente confirma que la
    conversación ha terminado.
    """
    logger.info(f"[end_call] Ending call: {reason}")
    try:
        await ctx.delete_room(ctx.room.name)
        return "Llamada terminada. Despídete cordialmente del cliente."
    except Exception as e:
        logger.warning(f"[end_call] delete_room failed: {e}")
        return f"Llamada marcada para terminar (error: {e})"


@agent_llm.function_tool
async def send_sms(
    ctx,  # RunContext (unused but required for tool signature)
    to_number: str,
    body: str,
) -> str:
    """
    Envía un SMS al cliente durante o después de la llamada con
    información adicional (resumen, link a un recurso, confirmación).
    Usar solo cuando el cliente lo solicite o cuando refuerce un mensaje
    verbal que el cliente podría olvidar.
    El número debe estar en formato E.164.
    """
    import re
    to_number = (to_number or "").strip()
    body = (body or "").strip()
    if not re.match(r"^\+[1-9]\d{6,14}$", to_number):
        return f"Número inválido: {to_number!r}. Debe estar en formato E.164."
    if not body:
        return "Mensaje vacío."
    if len(body) > 1600:
        return f"Mensaje demasiado largo ({len(body)} chars; máximo 1600)."

    sids = await _twilio_account_sids()
    if not sids:
        return "No hay credenciales de Twilio configuradas."
    from_number = (
        os.getenv("TWILIO_PHONE_NUMBER_PA")
        if "PA" in sids[0][0] or len(sids) == 1
        else os.getenv("TWILIO_PHONE_NUMBER", "")
    ) or os.getenv("TWILIO_PHONE_NUMBER", "")
    if not from_number:
        return "No hay número de origen configurado (TWILIO_PHONE_NUMBER)."

    status, body_resp = await _twilio_request(
        "POST",
        "/Messages.json",
        {"From": from_number, "To": to_number, "Body": body},
    )
    if 200 <= status < 300:
        logger.info(f"[send_sms] SMS sent → {to_number} ({len(body)} chars)")
        return f"SMS enviado a {to_number}."
    return f"Error al enviar SMS (Twilio {status}): {body_resp}"


@agent_llm.function_tool
async def leave_voicemail(
    ctx,  # RunContext
    message: str = "",
) -> str:
    """
    Cuelga la llamada dejando un mensaje de voicemail predefinido.
    Usar cuando el AMD ya detectó buzón de voz y el agente aún no terminó,
    o cuando el agente decide dejar un mensaje de cortesía.

    El parámetro `message` es opcional; si se omite, se usa un mensaje
    genérico del agente. La llamada se cuelga después de TTS el mensaje.
    """
    if not message:
        message = (
            "Hola, soy Camila, asistente virtual de Tigo Panamá. "
            "Te llamamos para informarte sobre una oportunidad de mejorar "
            "tu plan móvil. Si estás interesado, por favor devuélvenos la "
            "llamada. ¡Gracias!"
        )
    try:
        # TTS the message then disconnect (ctx.session isn't on RunContext,
        # so we use the room's audio directly via a marker; the actual TTS
        # is performed by the agent's normal turn generation if needed)
        await asyncio.sleep(0.2)
        await ctx.delete_room(ctx.room.name)
        logger.info("[leave_voicemail] Hung up after voicemail")
        return "Mensaje de voicemail registrado y llamada terminada."
    except Exception as e:
        return f"Error al dejar voicemail: {e}"


# ── Configuración dinámica por agente (admin builder, Phase 3) ─────────────────
#
# Each room is dispatched with `RoomAgentDispatch(metadata=json.dumps({"agent_id": ...}))`
# (see services/api/main.py make_outbound_call and services/dialer/dialer.py).
# At job start we look up that agent's row in Supabase — if it has builder config
# (system_prompt/greeting/models/tools/knowledge), we run with it; any field left
# NULL falls back to the historical "Camila" hardcoded defaults below, and an
# entirely missing/unknown agent_id falls back to the full legacy persona. This
# keeps older dispatches (and the original hardcoded behavior) working unchanged.

BUILTIN_TOOLS = {
    "info_tigo": info_tigo,
    "tigo_correo": tigo_correo,
    "calcular_tigo_fecha_cobro": calcular_tigo_fecha_cobro,
    "transfer_call": transfer_call,
    "end_call": end_call,
    "send_sms": send_sms,
    "leave_voicemail": leave_voicemail,
}


def _make_webhook_tool(tool_row: dict) -> object:
    """Build a RawFunctionTool that POSTs the LLM's chosen arguments to a custom
    webhook URL — the runtime half of the admin's "custom tools" builder tab.

    The request body merges the LLM-supplied arguments with two metadata
    fields (`_tool` and `_tool_key`) so the receiving webhook can identify
    which tool fired without inspecting its own routing logic."""
    key = tool_row["key"]
    tool_name = tool_row.get("label") or tool_row.get("name") or key
    config = tool_row.get("config") or {}
    url = config.get("url", "")
    method = (config.get("method") or "POST").upper()
    headers = config.get("headers") or {}
    parameters = config.get("parameters") or {"type": "object", "properties": {}}

    async def _call(raw_arguments: dict) -> str:
        if not url:
            return "Tool no configurado correctamente (falta URL)."
        # Merge metadata so the receiver can identify which tool fired.
        # Underscored keys avoid collision with the LLM argument names.
        if isinstance(raw_arguments, dict):
            body_payload = {**raw_arguments, "_tool": tool_name, "_tool_key": key}
        else:
            body_payload = raw_arguments
        from datetime import datetime, timezone
        import time
        call_started = time.monotonic()
        called_at = datetime.now(timezone.utc).isoformat()
        try:
            import aiohttp
            async with aiohttp.ClientSession() as session:
                async with session.request(
                    method, url, json=body_payload, headers=headers,
                    timeout=aiohttp.ClientTimeout(total=15),
                ) as resp:
                    body = await resp.text()
                    logger.info(f"[webhook_tool:{key}] {method} {url} → {resp.status}")
                    # Audit-trail entry consumed by the post-call webhook.
                    try:
                        _tool_calls_log.append({
                            "name": tool_name,
                            "tool_key": key,
                            "called_at": called_at,
                            "arguments": raw_arguments if isinstance(raw_arguments, dict) else {},
                            "status": resp.status,
                            "ok": 200 <= resp.status < 300,
                            "latency_ms": int((time.monotonic() - call_started) * 1000),
                            "response_preview": (body or "")[:500],
                        })
                    except NameError:
                        # Defensive: if _tool_calls_log isn't bound (race), skip
                        # logging — the tool still works for the LLM.
                        pass
                    return body[:2000] if body else f"OK ({resp.status})"
        except Exception as e:
            logger.error(f"[webhook_tool:{key}] error: {e}")
            # Log the failure so the post-call report can show partial state
            try:
                _tool_calls_log.append({
                    "name": tool_name,
                    "tool_key": key,
                    "called_at": called_at,
                    "arguments": raw_arguments if isinstance(raw_arguments, dict) else {},
                    "status": 0,
                    "ok": False,
                    "latency_ms": int((time.monotonic() - call_started) * 1000),
                    "response_preview": "",
                    "error": str(e)[:300],
                })
            except NameError:
                pass
            return f"Error al llamar la herramienta: {e}"

    return agent_llm.function_tool(
        _call,
        raw_schema={
            "name": key,
            "description": tool_row.get("description") or tool_row.get("label") or key,
            "parameters": parameters,
        },
    )


def _build_tools(tool_rows: list[dict]) -> list[object]:
    """Build the runtime tool list for the agent. Supports:
      - Builtin presets: `tool_type="builtin"` with `key` in BUILTIN_TOOLS
        (transfer_call, end_call, send_sms, leave_voicemail, info_tigo, etc.)
      - Webhook tools: `tool_type="webhook"` with a `config` JSON that has
        `url`, `method`, and `parameters` (JSON Schema).
      - Custom overrides: if the row has `custom_config`, it overrides the
        webhook's url/method/parameters — useful for per-agent tweaks of a
        global catalog tool.
      - Builtin overrides: `custom_config` can also carry per-agent defaults
        for builtin tools (e.g. `default_to_number` for transfer_call). These
        are injected via closure so the LLM-invoked call picks them up
        transparently.
    """
    tools: list[object] = []
    for row in tool_rows:
        if not row.get("enabled", True):
            continue
        if row.get("tool_type") == "builtin":
            fn = BUILTIN_TOOLS.get(row["key"])
            if fn is None:
                continue
            custom = row.get("custom_config") if isinstance(row.get("custom_config"), dict) else None
            if custom and any(k in custom for k in ("default_to_number", "default_message")):
                tools.append(_wrap_builtin_with_overrides(row["key"], fn, custom))
            else:
                tools.append(fn)
        elif row.get("tool_type") == "webhook":
            row_for_tool = dict(row)
            # Apply per-agent custom_config over the row's config (deep merge)
            custom = row.get("custom_config")
            if isinstance(custom, dict) and custom:
                base = dict(row.get("config") or {})
                base.update(custom)
                row_for_tool["config"] = base
            tools.append(_make_webhook_tool(row_for_tool))
    return tools


def _wrap_builtin_with_overrides(key: str, fn, custom_config: dict):
    """Build a per-agent function tool that injects defaults from custom_config
    when the LLM doesn't provide them. Currently supports:
      - transfer_call: per-agent list of transfer numbers (custom_config.transfer_numbers
        = [{label, number, priority}, ...]) plus a fallback default_to_number.
        The LLM picks a department by name and we resolve to the matching number;
        otherwise we fall back to the LLM-provided to_number or the default.
      - leave_voicemail: custom_config.default_message
    """
    if key == "transfer_call":
        default_number = str(custom_config.get("default_to_number") or "").strip()

        # Parse + normalize the per-agent transfer_numbers list. Each entry is
        # {label, number, priority?} — we drop invalid rows so a malformed
        # custom_config doesn't take down the whole agent.
        raw_numbers = custom_config.get("transfer_numbers") or []
        transfer_numbers: list[dict] = []
        if isinstance(raw_numbers, list):
            for entry in raw_numbers:
                if not isinstance(entry, dict):
                    continue
                num = str(entry.get("number") or "").strip()
                lbl = str(entry.get("label") or "").strip()
                if not num or not lbl:
                    continue
                try:
                    prio = int(entry.get("priority") or 99)
                except (TypeError, ValueError):
                    prio = 99
                transfer_numbers.append({"label": lbl, "number": num, "priority": prio})
        # Sort by priority so the docstring reflects the routing order.
        transfer_numbers.sort(key=lambda x: x["priority"])

        # Build a dynamic docstring listing the available departments so the
        # LLM knows which department labels are valid. The original docstring
        # is preserved as the base — we just append a section.
        if transfer_numbers:
            dept_lines = ", ".join(
                f"'{n['label']}' → {n['number']}" for n in transfer_numbers
            )
            dynamic_doc = (
                (fn.__doc__ or "").rstrip()
                + f"\n\nDepartamentos disponibles para transferir: {dept_lines}."
                "\nSi el cliente nombra uno de estos, pásalo en `department`;"
                " si no, pasa el `to_number` (E.164). Si solo dices un número,"
                " se usa ese. Si no dices nada, se intenta el número por defecto"
                f" ({default_number or 'ninguno configurado'})."
            )
        else:
            dynamic_doc = (fn.__doc__ or "").rstrip() + (
                f"\n\nSi no especificas `to_number`, se intentará el número por"
                f" defecto ({default_number or 'ninguno configurado'})."
                if default_number else ""
            )

        async def transfer_call_with_default(
            ctx,  # RunContext
            to_number: str = "",
            department: str = "",
            reason: str = "",
        ) -> str:
            # Resolution chain (in order):
            #  1. department → match label → number
            #  2. to_number (LLM-provided raw number)
            #  3. default_to_number (single-number legacy fallback)
            target = ""
            dept_clean = (department or "").strip()
            if dept_clean and transfer_numbers:
                lc = dept_clean.lower()
                for n in transfer_numbers:
                    if n["label"].lower() == lc:
                        target = n["number"]
                        break
                if not target:
                    logger.warning(
                        f"[transfer_call] LLM passed department={dept_clean!r}"
                        " but no matching label found in transfer_numbers;"
                        " falling through to to_number/default."
                    )
            if not target:
                target = (to_number or "").strip()
            if not target:
                target = default_number
            return await fn(ctx, to_number=target, reason=reason)

        transfer_call_with_default.__name__ = fn.__name__
        transfer_call_with_default.__doc__ = dynamic_doc
        return transfer_call_with_default
    if key == "leave_voicemail":
        default_message = str(custom_config.get("default_message") or "").strip()

        async def leave_voicemail_with_default(
            ctx,
            message: str = "",
        ) -> str:
            msg = (message or "").strip() or default_message
            return await fn(ctx, message=msg)
        leave_voicemail_with_default.__name__ = fn.__name__
        leave_voicemail_with_default.__doc__ = fn.__doc__
        return leave_voicemail_with_default
    return fn


def _filter_nulls(d: dict) -> dict:
    """Drop None values so LiveKit uses its own defaults for unset fields."""
    return {k: v for k, v in d.items() if v is not None}


def _load_agent_config(agent_id: str | None) -> dict:
    """Resolve the full runtime config for this session: prompt, greeting, models,
    voice, tools and knowledge base — from the DB if `agent_id` is set and the
    agent has builder config, otherwise the legacy hardcoded Camila persona."""
    cfg = {
        "name": "Camila",
        "system_prompt": CAMILA_PROMPT,
        "greeting": CAMILA_GREETING,
        "voice_id": VOICE_ID,
        "llm_model": LLM_MODEL,
        "stt_model": STT_MODEL,
        "tts_model": TTS_MODEL,
        "stt_provider": "deepgram",
        "tts_provider": "elevenlabs",
        "temperature": 0.7,
        "language": "es",
        "tools": [info_tigo, tigo_correo, calcular_tigo_fecha_cobro],
        # Idle nudge: speak up if the customer goes silent for this long.
        # `None`/0 disables it (legacy/default behavior).
        "idle_timeout_seconds": None,
        "idle_message": "¿Sigues ahí?",
        # Turn handling config (Start/Stop Speaking Plan + interruptions +
        # preemptive generation). Empty dict = use LiveKit defaults (legacy
        # behavior: turn_detection="stt", sensible endpointing/interruption).
        "turn_handling": {},
        # TTS speed multiplier. 1.0 = normal. Read from DB when the row has it;
        # otherwise falls back to 1.1 in _build_tts (slightly faster than
        # default which sounds more natural in Spanish).
        "tts_speed": 1.0,
    }
    if not agent_id:
        return cfg

    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        return cfg

    try:
        from supabase import create_client
        db = create_client(url, key)
        agent = db.table("agents").select("*").eq("id", agent_id).single().execute()
        if not agent.data:
            logger.warning(f"[agent_config] agent_id {agent_id} not found, using defaults")
            return cfg
        a = agent.data

        for field in ("name", "voice_id", "llm_model", "stt_model", "tts_model", "language", "stt_provider", "tts_provider"):
            if a.get(field):
                cfg[field] = a[field]
        if a.get("temperature") is not None:
            cfg["temperature"] = float(a["temperature"])
        # TTS speed — Inworld clamps to [0.5, 1.5] internally; ElevenLabs to
        # [0.8, 1.2]. Backend clamp in _build_tts applies the right range per
        # provider before forwarding.
        if a.get("tts_speed") is not None:
            cfg["tts_speed"] = float(a["tts_speed"])
        # Inworld TTS fine-tuning knobs. Null = use SDK default.
        if a.get("tts_temperature") is not None:
            cfg["tts_temperature"] = float(a["tts_temperature"])
        if a.get("tts_text_normalization") is not None:
            cfg["tts_text_normalization"] = bool(a["tts_text_normalization"])
        if a.get("tts_delivery_mode"):
            cfg["tts_delivery_mode"] = a["tts_delivery_mode"]
        if a.get("tts_buffer_char_threshold") is not None:
            cfg["tts_buffer_char_threshold"] = int(a["tts_buffer_char_threshold"])
        if a.get("tts_max_buffer_delay_ms") is not None:
            cfg["tts_max_buffer_delay_ms"] = int(a["tts_max_buffer_delay_ms"])
        if a.get("idle_timeout_seconds") is not None:
            cfg["idle_timeout_seconds"] = int(a["idle_timeout_seconds"])
        if a.get("idle_message"):
            cfg["idle_message"] = a["idle_message"]

        system_prompt = a.get("system_prompt") or cfg["system_prompt"]
        knowledge = db.table("agent_knowledge").select("title,content").eq("agent_id", agent_id).execute()
        if knowledge.data:
            kb_text = "\n\n".join(f"### {k['title']} ###\n{k['content']}" for k in knowledge.data)
            system_prompt = f"{system_prompt}\n\n## Base de conocimiento ##\n{kb_text}"
        cfg["system_prompt"] = system_prompt
        cfg["greeting"] = a.get("greeting") or cfg["greeting"]

        tool_rows = db.table("agent_tools").select("*").eq("agent_id", agent_id).execute()
        if tool_rows.data:
            cfg["tools"] = _build_tools(tool_rows.data)

        # Load turn handling config (VAPI-style Start/Stop Speaking Plan +
        # interruption + preemptive generation). Stored as JSONB in the DB.
        th = a.get("turn_handling")
        if isinstance(th, dict) and th:
            cfg["turn_handling"] = th
            logger.info(
                f"[agent_config] turn_handling for {agent_id}: "
                f"turn_detection={th.get('turn_detection', 'auto')!r}"
            )

        logger.info(f"[agent_config] Loaded config for agent {agent_id} ({cfg['name']})")
    except Exception as e:
        logger.error(f"[agent_config] Failed to load agent {agent_id}, using defaults: {e}")

    return cfg


# ── Agente ────────────────────────────────────────────────────────────────────

class CamilaAgent(Agent):
    def __init__(self, cost_logger: CostLogger, instructions: str, tools: list, llm_model: str = LLM_MODEL) -> None:
        super().__init__(
            instructions=instructions,
            tools=tools,
        )
        self._cost = cost_logger
        self._llm_model = llm_model
        self._transcript_lines: list[str] = []

    def add_transcript(self, speaker: str, text: str) -> None:
        line = f"[{speaker}]: {text}"
        # Multiple event handlers (agent_speech_committed, conversation_item_added)
        # can fire for the same utterance — skip exact consecutive duplicates so
        # the saved transcript doesn't repeat the same line back-to-back.
        if self._transcript_lines and self._transcript_lines[-1] == line:
            return
        self._transcript_lines.append(line)

    @property
    def transcript(self) -> str:
        return "\n".join(self._transcript_lines)


def _extract_twilio_sid_from_attrs(attrs: dict) -> str | None:
    """Pull a Twilio CallSid (format `CA` + 32 hex chars) out of SIP participant attributes."""
    for key in (
        "sip.header.X-Twilio-CallSid",
        "sip.header.X-Twilio-Call-Sid",
        "sip.twilio.callSid",
        "sip.callID",
    ):
        val = attrs.get(key)
        if val and str(val).startswith("CA"):
            return str(val)
    # Fallback: scan all attribute values for a CallSid-shaped string.
    for key, val in attrs.items():
        if val and str(val).startswith("CA") and len(str(val)) == 34:
            logger.info(f"[recording] Found CallSid under unexpected attr {key!r}: {val}")
            return str(val)
    return None


def _get_twilio_call_sid(room: object) -> str | None:
    """Extract Twilio CallSid from SIP participant attributes still present on the room.

    Only useful while the SIP participant is connected — by the time the room's
    `disconnected` event fires, the participant has typically already left and
    `remote_participants` is empty. Kept as a fallback; the primary capture path
    is the `participant_connected` handler in `entrypoint`, which grabs the SID
    the moment the SIP participant joins (see `_captured_twilio_sid`).
    """
    try:
        participants = getattr(room, "remote_participants", {})
        for p in participants.values():
            attrs = getattr(p, "attributes", {}) or {}
            sid = _extract_twilio_sid_from_attrs(attrs)
            if sid:
                return sid
            if attrs:
                logger.warning(f"[recording] No CallSid found; participant {getattr(p, 'identity', '?')!r} attributes={attrs!r}")
    except Exception as e:
        logger.warning(f"[recording] _get_twilio_call_sid failed: {e}")
    return None


# Telltale phrases from Spanish (and a few English) voicemail/IVR/answering-machine
# greetings and menus. When Deepgram transcribes one of these — even if it gets
# mis-attributed to "[Cliente]" because it came down the phone line — the call
# landed on a machine, not a person, regardless of how the SIP leg disconnected
# (a voicemail system "hanging up" isn't "el cliente colgó").
_VOICEMAIL_PHRASE_RE = re.compile(
    r"buz[oó]n de voz"
    r"|deje (su|un) mensaje"
    r"|despu[eé]s del tono"
    r"|al escuchar el tono"
    r"|no se encuentra disponible"
    r"|no est[aá] disponible"
    r"|fin del mensaje"
    r"|tiempo de grabaci[oó]n"
    r"|grabar( nuevamente)? su mensaje"
    r"|presione uno"
    r"|presione \d"
    r"|casilla de mensajes"
    r"|leave a message"
    r"|voice ?mail"
    r"|is not available"
    # Tigo Panama / Latin-American carrier voicemail prompts
    r"|pul?se cualquier tecla"
    r"|para detener la grabaci[oó]n"
    r"|de la se[ñn]al pulse"
    r"|su llamada ha sido transferida al sistema de mensajes"
    r"|en este momento no (puede|puedo) atender"
    r"|deje un mensaje despu[eé]s"
    # Generic "number unreachable / out of service" carrier announcements
    r"|el n[uú]mero (que (usted )?(marc[oó]|ha marcado)|al que (usted )?llama)"
    r"|n[uú]mero (no )?(se encuentra )?(fuera de servicio|en servicio)"
    r"|no (fue posible|pudimos) (comunicar|conectar)"
    r"|temporalmente fuera de servicio"
    r"|buz[oó]n.*(lleno|completo)"
    r"|mailbox is full"
    r"|mailbox.*(full|not been set ?up)"
    r"|person you are (trying to reach|calling)"
    r"|number you (have )?dialed"
    r"|your call has been forwarded"
    r"|please leave your message"
    r"|record your message"
    r"|grabaci[oó]n de su mensaje"
    r"|in[uú]til.*intente.*tarde"
    r"|cellular customer you (have )?called",
    re.IGNORECASE,
)


def _looks_like_voicemail(transcript: str) -> bool:
    return bool(_VOICEMAIL_PHRASE_RE.search(transcript or ""))


def _classify_end_reason(phone_disconnect_reason: int | None, transcript: str) -> str:
    """Classify how a call ended for display in the admin/portal call log.

    `phone_disconnect_reason` is the `DisconnectReason` captured when the SIP/phone
    leg left the room — CLIENT_INITIATED means the customer hung up, and that's
    surfaced as "client_hangup" regardless of how much conversation happened first
    (per explicit product decision: "si el cliente cuelga, colgó", full stop).

    Voicemail/IVR detection runs *first* and can override that: answering-machine
    greetings and menus get transcribed too (often mis-tagged as "[Cliente]" since
    they come down the phone line), which would otherwise defeat the old "agent
    spoke but customer never said a word" heuristic and make a machine look like a
    real conversation that the customer hung up on. See `_VOICEMAIL_PHRASE_RE`.

    Falls back to the original heuristic when no machine phrases are found: if the
    agent spoke but the "customer" never said a word, the call most likely landed
    on voicemail (mirrors the dialer's `VOICEMAIL_TIMEOUT` heuristic for campaigns).
    """
    reason_name = _DISCONNECT_REASON_NAMES.get(phone_disconnect_reason or -1)
    transcript = transcript or ""

    if _looks_like_voicemail(transcript):
        return "voicemail"

    if reason_name == "CLIENT_INITIATED":
        return "client_hangup"

    client_spoke = "[Cliente]" in transcript
    if not client_spoke and transcript.strip():
        return "voicemail"

    if reason_name in ("USER_UNAVAILABLE", "USER_REJECTED", "SIP_TRUNK_FAILURE", "CONNECTION_TIMEOUT"):
        return "no_answer"

    return "completed"


# LiveKit's SIP server embeds the inbound caller-ID verbatim into the room
# name (format `call-_<caller-id>_<suffix>`). Two distinct scanners have been
# hammering our trunk:
#   1. SQL-injection probe strings as caller-ID (e.g. "call-_'or''='_xxxx")
#   2. Short extension-style numbers like "1001" — a classic PBX/extension
#      scanner — which the agent answered and ran full 60s sessions for,
#      burning real STT/LLM/TTS cost (~$0.045 every ~40s, observed live).
# Real PSTN caller-IDs are always full national/international numbers (10+
# digits, or 7+ for bare local numbers) — never 4-6 digit extensions — so we
# require a minimum length to catch class 2 as well as class 1.
# Mirrors (and tightens) `_PHONE_LIKE_RE` in services/api/main.py.
_PHONE_LIKE_RE = re.compile(r"^\+?[0-9]{7,15}$")


def _is_probe_room(room_name: str) -> bool:
    """True if `room_name` is an inbound room whose embedded caller-ID isn't a real phone number."""
    if not room_name.startswith("call-_"):
        return False
    inner = room_name[len("call-_"):]
    last_sep = inner.rfind("_")
    caller_id = inner[:last_sep] if last_sep > 0 else inner
    return not _PHONE_LIKE_RE.match(caller_id)


# Country code → ISO 3166-1 alpha-2. LiveKit's SIP server embeds the inbound
# caller-id in the room name (`call-_<caller-id>_<suffix>`); we parse the
# leading `+<digits>` and look up the country so the cost estimator can
# price the Twilio inbound leg at the right per-country rate instead of
# defaulting to US. Add prefixes here as new markets come online.
_PHONE_PREFIX_TO_COUNTRY: dict[str, str] = {
    "1":   "US",   # +1 covers US/Canada — default to US
    "52":  "MX",
    "507": "PA",
    "44":  "GB",
    "34":  "ES",
    "49":  "DE",
    "33":  "FR",
    "39":  "IT",
    "353": "IE",
    "54":  "AR",
    "55":  "BR",
    "56":  "CL",
    "57":  "CO",
    "51":  "PE",
}


def _caller_country_from_room(room_name: str) -> str | None:
    """Extract the caller's ISO country code from the SIP room name.

    Room names look like `call-_+526642462621_aBc123`. The caller-id is the
    E.164-formatted number between `call-_` and the trailing underscore +
    suffix. We match the leading `+<digits>` against `_PHONE_PREFIX_TO_COUNTRY`,
    trying longest prefixes first (e.g. +507 → PA, not +50 → IL).
    Returns the country code or None if the prefix isn't in the table or the
    room name doesn't look like an inbound call.
    """
    if not room_name or not room_name.startswith("call-_"):
        return None
    inner = room_name[len("call-_"):]
    last_sep = inner.rfind("_")
    caller_id = inner[:last_sep] if last_sep > 0 else inner
    if not caller_id.startswith("+") or not caller_id[1:].isdigit():
        return None
    # Try longest prefixes first so +507 → PA, +44 → GB, +1 → US
    for length in (3, 2, 1):
        prefix = caller_id[1:1 + length]
        cc = _PHONE_PREFIX_TO_COUNTRY.get(prefix)
        if cc:
            return cc
    return None


async def _create_session_row(session_id: str, room_name: str, agent_id: str | None) -> None:
    """Insert the `sessions` row at call start so it carries the real `started_at`
    and exists as an FK target for `api_usage` rows logged mid-call by `CostLogger`
    (see cost_logger.py::_save — without this row, every usage insert fails its
    `session_id references sessions(id)` constraint and `total_cost_usd` stays 0).
    `_save_session_to_db` updates this same row with the final outcome at call end.
    """
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        return
    try:
        from supabase import create_client
        db = create_client(url, key)

        def _write() -> None:
            db.table("sessions").insert({
                "id": session_id,
                "started_at": datetime.now(timezone.utc).isoformat(),
                "room_name": room_name,
                "agent_id": agent_id,
            }).execute()

        await asyncio.to_thread(_write)
    except Exception as e:
        logger.error(f"Failed to create session row: {e}")


async def entrypoint(ctx: object) -> None:
    # S5 — health signal. Marking connected on every entrypoint invocation
    # is the strongest signal we get that the LiveKit worker is fully
    # wired up: this is called per-session by the LiveKit agent framework,
    # which only happens once the WebSocket connect + register sequence
    # has completed. /health/ready uses this to confirm the worker can
    # actually receive traffic.
    global _lk_connected, _last_room_join_ts
    _lk_connected = True
    _last_room_join_ts = time.time()
    session_id = str(uuid.uuid4())
    cost_logger = CostLogger(session_id)

    # `ctx.job.room.name` is populated from the dispatch assignment before we ever
    # connect — `ctx.room.name` isn't reliably set this early.
    room_name = getattr(getattr(getattr(ctx, "job", None), "room", None), "name", "") or ""
    if _is_probe_room(room_name):
        logger.warning(f"[security] Rejecting probe call with invalid caller-ID: room={room_name!r}")
        try:
            await ctx.delete_room(room_name)
        except Exception as e:
            logger.warning(f"[security] Failed to delete probe room {room_name!r}: {e}")
        return

    # Resolve which DB-backed agent (if any) this dispatch targets, via the
    # `agent_id` carried in RoomAgentDispatch metadata (see _load_agent_config).
    agent_id: str | None = None
    try:
        raw_meta = getattr(getattr(ctx, "job", None), "metadata", None)
        if raw_meta:
            parsed_agent_id = json.loads(raw_meta).get("agent_id")
            agent_id = parsed_agent_id if isinstance(parsed_agent_id, str) else None
    except Exception as e:
        logger.warning(f"[agent_config] Could not parse job metadata: {e}")

    cfg = _load_agent_config(agent_id)

    # Predictive cost estimate based on the resolved config (TTS/LLM/STT providers
    # + Twilio). Logged once at session start so you can correlate actual vs
    # estimated spend via the existing sessions.total_cost_usd column.
    # The caller's country is extracted from the SIP room name (LiveKit embeds
    # the inbound caller-id in the format `call-_<caller>_<suffix>`) so the
    # Twilio leg is priced per-country, not just defaulted to US.
    caller_country = _caller_country_from_room(room_name)
    estimate = estimate_cost_per_min({
        "stt_provider":   cfg.get("stt_provider"),
        "stt_model":      cfg.get("stt_model"),
        "llm_provider":   "openai",
        "llm_model":      cfg.get("llm_model"),
        "tts_provider":   cfg.get("tts_provider"),
        "tts_model":      cfg.get("tts_model"),
        "caller_country": caller_country,
    })
    logger.info(
        f"[cost_estimate] ${estimate['total_per_min']:.4f}/min total "
        f"(stt=${estimate['stt_per_min']:.4f}, llm=${estimate['llm_per_min']:.4f}, "
        f"tts=${estimate['tts_per_min']:.4f}, twilio=${estimate['twilio_voice_per_min']:.4f} [{caller_country}]) for {cfg['name']}"
    )

    # Create the `sessions` row now (real `started_at`, FK target for `api_usage`
    # rows the cost logger writes as the call progresses) — see _create_session_row.
    await _create_session_row(session_id, room_name, agent_id)

    stt = _build_stt(cfg)
    llm = openai.LLM(model=cfg["llm_model"], temperature=cfg["temperature"])
    tts = _build_tts(cfg)
    agent = CamilaAgent(cost_logger, instructions=cfg["system_prompt"], tools=cfg["tools"], llm_model=cfg["llm_model"])

    # ── Build session kwargs from turn_handling config ────────────────────────
    # Empty / missing `turn_handling` falls back to the legacy "stt" mode
    # (preserves behavior for any agent that hasn't been updated yet).
    session_kwargs: dict = dict(
        stt=stt,
        llm=llm,
        tts=tts,
        user_away_timeout=None,
    )
    turn_cfg = cfg.get("turn_handling") or {}
    turn_mode = turn_cfg.get("turn_detection")

    if turn_mode == "multilingual":
        # Best quality: open-weights turn detector from LiveKit. Loads lazily
        # on first call so agents that don't use it don't pay the ~80MB cost.
        try:
            from livekit.plugins.turn_detector.multilingual import MultilingualModel
            turn_detector = MultilingualModel()
            session_kwargs["turn_handling"] = {
                "turn_detection": turn_detector,
                "endpointing": turn_cfg.get("endpointing") or {},
                "interruption": turn_cfg.get("interruption") or {},
                "user_turn_limit": _filter_nulls(turn_cfg.get("user_turn_limit") or {}),
                "preemptive_generation": turn_cfg.get("preemptive_generation") or {},
            }
            logger.info(f"[agent] turn_detection=multilingual for {cfg['name']}")
        except Exception as e:
            # Defensive fallback: if the model files aren't on disk (e.g.
            # pre-download was skipped), degrade to VAD so the session still
            # works instead of crashing the call.
            logger.warning(
                f"[agent] MultilingualModel unavailable ({type(e).__name__}: {e}); "
                f"falling back to VAD for {cfg['name']}. "
                f"Rebuild the agent image to bake in the model."
            )
            from livekit.plugins import silero
            session_kwargs["vad"] = silero.VAD.load()
            session_kwargs["turn_handling"] = {
                "turn_detection": "vad",
                "endpointing": turn_cfg.get("endpointing") or {},
                "interruption": turn_cfg.get("interruption") or {},
                "user_turn_limit": _filter_nulls(turn_cfg.get("user_turn_limit") or {}),
                "preemptive_generation": turn_cfg.get("preemptive_generation") or {},
            }
    elif turn_mode == "vad":
        # VAD-only mode: load Silero. Doesn't need STT.
        from livekit.plugins import silero
        session_kwargs["vad"] = silero.VAD.load()
        session_kwargs["turn_handling"] = {
            "turn_detection": "vad",
            "endpointing": turn_cfg.get("endpointing") or {},
            "interruption": turn_cfg.get("interruption") or {},
            "user_turn_limit": _filter_nulls(turn_cfg.get("user_turn_limit") or {}),
            "preemptive_generation": turn_cfg.get("preemptive_generation") or {},
        }
        logger.info(f"[agent] turn_detection=vad for {cfg['name']}")
    elif turn_mode:
        # Explicit mode string (e.g. "stt" or "manual")
        session_kwargs["turn_handling"] = {
            "turn_detection": turn_mode,
            "endpointing": turn_cfg.get("endpointing") or {},
            "interruption": turn_cfg.get("interruption") or {},
            "user_turn_limit": _filter_nulls(turn_cfg.get("user_turn_limit") or {}),
            "preemptive_generation": turn_cfg.get("preemptive_generation") or {},
        }
        logger.info(f"[agent] turn_detection={turn_mode} for {cfg['name']}")
    elif turn_cfg:
        # No explicit turn_detection but other sub-configs set
        session_kwargs["turn_handling"] = {
            "endpointing": turn_cfg.get("endpointing") or {},
            "interruption": turn_cfg.get("interruption") or {},
            "user_turn_limit": _filter_nulls(turn_cfg.get("user_turn_limit") or {}),
            "preemptive_generation": turn_cfg.get("preemptive_generation") or {},
        }
        logger.info(f"[agent] turn_handling (auto mode) for {cfg['name']}")
    else:
        # Legacy behavior — no config at all
        session_kwargs["turn_detection"] = "stt"
        logger.info(f"[agent] turn_detection=stt (legacy default) for {cfg['name']}")

    session = AgentSession(**session_kwargs)

    # Flag set when a voicemail has already been detected so we don't fire twice.
    _voicemail_hangup_triggered = [False]

    # Flag so we only write sessions.customer_spoke=true once per call.
    _customer_spoke_marked = [False]

    # Capture transcript events
    @session.on("user_speech_committed")
    def _on_user_speech(ev: object) -> None:
        # livekit-agents 1.5: event has .user_transcript or .transcript or .message
        text = (
            getattr(ev, "user_transcript", None)
            or getattr(ev, "transcript", None)
            or getattr(ev, "text", None)
        )
        if not (text and str(text).strip()):
            return
        text_str = str(text).strip()
        agent.add_transcript("Cliente", text_str)

        # ── AMD signal: a real human responded ───────────────────────────────
        # Only counts if it doesn't look like a voicemail/IVR prompt — those get
        # transcribed too but shouldn't make the dialer think a person answered.
        if not _customer_spoke_marked[0] and not _looks_like_voicemail(text_str):
            _customer_spoke_marked[0] = True
            asyncio.get_event_loop().run_in_executor(None, _mark_customer_spoke_sync, session_id)

        # ── Real-time voicemail detection ────────────────────────────────────
        # The SIP leg sometimes connects to a voicemail box instead of a human.
        # When Deepgram transcribes the voicemail greeting (e.g. "Pulse cualquier
        # tecla para detener la grabación") it's tagged as "[Cliente]" because it
        # comes down the phone line.  As soon as we see such a phrase, interrupt
        # the agent immediately and close the room — no point burning STT/LLM/TTS
        # cost talking to an answering machine.
        if not _voicemail_hangup_triggered[0] and _looks_like_voicemail(text_str):
            _voicemail_hangup_triggered[0] = True
            logger.info(f"[voicemail] Frase de buzón detectada en tiempo real: {text_str!r}")
            # Interrupt any in-flight agent response so it doesn't start talking
            try:
                session.interrupt()
            except Exception:
                pass
            # Schedule the room teardown on the event loop (this callback is sync).
            # Small delay lets the interrupt settle before closing — without it the
            # in-flight LLM/TTS response may still play a word or two.
            async def _close_voicemail_call() -> None:
                await asyncio.sleep(0.8)
                try:
                    await ctx.delete_room(room_name)
                except Exception as exc:
                    logger.warning(f"[voicemail] Error al cerrar la sala: {exc}")
            asyncio.ensure_future(_close_voicemail_call())

    @session.on("agent_speech_committed")
    def _on_agent_speech(ev: object) -> None:
        text = (
            getattr(ev, "agent_transcript", None)
            or getattr(ev, "transcript", None)
            or getattr(ev, "text", None)
        )
        if text and str(text).strip():
            agent.add_transcript(cfg["name"], str(text).strip())

    @session.on("metrics_collected")
    def _on_metrics(ev: object) -> None:
        """Route per-provider usage metrics to the cost logger as they stream in.

        `metrics_collected` fires once per STT/LLM/TTS turn with a typed
        `.metrics` payload (see livekit.agents.metrics.base) — this is the
        only place real token/audio/character usage is observable, so it's
        the source of truth for the cost dashboard.
        """
        metrics = getattr(ev, "metrics", None)
        if isinstance(metrics, LLMMetrics):
            cost_logger.log_openai(cfg["llm_model"], metrics.prompt_tokens, metrics.completion_tokens)
        elif isinstance(metrics, STTMetrics):
            if cfg["stt_provider"] == "inworld":
                cost_logger.log_inworld_stt(cfg["stt_model"], metrics.audio_duration)
            else:
                cost_logger.log_deepgram(cfg["stt_model"], metrics.audio_duration)
        elif isinstance(metrics, TTSMetrics):
            if cfg["tts_provider"] == "inworld":
                cost_logger.log_inworld_tts(cfg["tts_model"], metrics.characters_count)
            else:
                cost_logger.log_elevenlabs(cfg["tts_model"], metrics.characters_count)
        else:
            # Every session in the DB so far has total_cost_usd = 0 — if this fires
            # with an unrecognized type, that's the smoking gun for why costs never
            # accrue (e.g. a plugin-specific Metrics subclass that doesn't match
            # LLMMetrics/STTMetrics/TTSMetrics from livekit.agents.metrics).
            logger.warning(f"[cost] Unhandled metrics type: {type(metrics).__name__} = {metrics!r}")

    # The SIP participant typically disconnects (and is removed from
    # `room.remote_participants`) before the room's `disconnected` event
    # fires — so `_get_twilio_call_sid(ctx.room)` runs too late and finds
    # nothing. Capture the CallSid the moment the SIP participant joins,
    # while its `sip.*` attributes are still attached.
    _captured_twilio_sid: list[str | None] = [None]

    def _try_capture_sid(attrs: dict, source: str) -> None:
        if _captured_twilio_sid[0]:
            return
        sid = _extract_twilio_sid_from_attrs(attrs)
        if sid:
            _captured_twilio_sid[0] = sid
            logger.info(f"[recording] Captured Twilio CallSid via {source}: {sid}")
        elif attrs:
            logger.info(f"[recording] {source} attributes={attrs!r}")

    # Captures *why* the phone/SIP leg left the room, so we can tell apart
    # "the customer hung up" (CLIENT_INITIATED) from us ending the call
    # normally or the carrier dropping it. Populated on `participant_disconnected`
    # since `disconnect_reason` is only set once the participant has left.
    _phone_disconnect_reason: list[int | None] = [None]

    def _is_phone_participant(attrs: dict) -> bool:
        return bool(attrs.get("sip.callID") or attrs.get("sip.phoneNumber"))

    # ── Session-save plumbing ────────────────────────────────────────────────
    # Defined here (before any `ctx.room.on(...)` handlers are registered)
    # because `_on_participant_disconnected` below calls `_do_save_and_signal`.
    # If the SIP participant disconnects/reconnects very early — e.g. during
    # the `await session.start()` / greeting below, before this function had
    # been defined — Python 3.11 raises a NameError ("cannot access free
    # variable ... where it is not associated with a value in enclosing
    # scope") because the closure's cell isn't bound yet. That NameError is
    # swallowed by the SDK's event emitter (logged as ERROR, not raised), so
    # the call would silently never get its session/transcript/recording
    # saved. Defining everything up-front avoids the race entirely.

    # Holds references to fire-and-forget background tasks spawned from the
    # sync `disconnected` callback below — without this, asyncio may garbage
    # collect a task mid-flight (see asyncio docs on create_task references).
    _background_tasks: set[asyncio.Task] = set()

    # Set when the call is definitively over (phone participant left OR room
    # closed) so the entrypoint can block until _save_session_to_db completes.
    _shutdown_event = asyncio.Event()
    # Guard that ensures we write to Supabase exactly once, no matter whether
    # _on_participant_disconnected or _on_disconnect fires first.
    _session_saved = [False]
    # Per-session tool-call audit trail. Each entry is appended by the webhook
    # tool's _call() wrapper and read by the post-call webhook delivery task
    # so the receiver can see the full sequence (name, args, response, latency).
    _tool_calls_log: list[dict] = []
    # Reassigned further down (only if idle_timeout_seconds is configured)
    # once the idle-nudge watcher task is created; _do_save_and_signal cancels
    # it on shutdown if it's been set.
    _idle_task: asyncio.Task | None = None

    def _do_save_and_signal() -> None:
        """Schedule _save_session_to_db exactly once and unblock the entrypoint.

        Called from both _on_participant_disconnected (phone hung up) and
        _on_disconnect (room closed) so whichever fires first wins.  The guard
        _session_saved[0] prevents a double write.
        """
        if _session_saved[0]:
            _shutdown_event.set()
            return
        _session_saved[0] = True
        if _idle_task and not _idle_task.done():
            _idle_task.cancel()
        summary = cost_logger.session_summary()
        logger.info(f"Sesión terminada: {summary}")
        twilio_sid = _captured_twilio_sid[0] or _get_twilio_call_sid(ctx.room)
        logger.info(f"[recording] Twilio CallSid: {twilio_sid}")
        end_reason = _classify_end_reason(_phone_disconnect_reason[0], agent.transcript)
        logger.info(f"[disposition] end_reason={end_reason}")
        # `disconnected` handlers run synchronously on the event loop — saving
        # the session involves a multi-retry, up-to-30s Twilio poll plus DB
        # writes, none of which may block the loop (it would stall every other
        # concurrent call this worker is handling). Schedule it as a task so
        # the handler returns immediately.
        try:
            task = asyncio.create_task(
                _save_session_to_db(session_id, summary, ctx.room.name, agent.transcript, twilio_sid, agent_id, end_reason)
            )
            _background_tasks.add(task)
            task.add_done_callback(_background_tasks.discard)
        except RuntimeError as e:
            # Defensive: if the worker's event loop is already closing/closed
            # (shutdown race), log instead of letting the callback raise.
            logger.warning(f"[recording] Could not schedule session save (loop closing?): {e}")

        # Persist the tool-calls log so the dashboard can replay the full
        # call sequence. Cheap to write (one row) and not on the hot path.
        try:
            from supabase import create_client
            _db = create_client(
                os.getenv("SUPABASE_URL", ""),
                os.getenv("SUPABASE_SERVICE_ROLE_KEY", ""),
            )
            _db.table("sessions").update(
                {"tool_calls_log": list(_tool_calls_log)}
            ).eq("id", session_id).execute()
        except Exception as e:
            logger.warning(f"[webhook] Could not persist tool_calls_log: {e}")

        # Post-call webhook (VAPI-style end-of-call report). Fire-and-forget
        # so a slow webhook doesn't block other concurrent calls. The receiver
        # is the per-agent `webhook_url` with HMAC-SHA256 signing + 3 retries
        # with exponential backoff (2s, 4s, 8s). Failures are logged to
        # `webhook_deliveries` so the dashboard can show + retry them.
        try:
            webhook_url, webhook_secret = _lookup_agent_webhook_config(agent_id)
            if webhook_url:
                _payload_ctx = {
                    "agent_id": agent_id,
                    "agent_name": agent.name if hasattr(agent, "name") else None,
                    "session_id": session_id,
                    "room_name": ctx.room.name,
                    "webhook_url": webhook_url,
                    "webhook_secret": webhook_secret,
                    "transcript": agent.transcript,
                    "twilio_call_sid": twilio_sid,
                    "end_reason": end_reason,
                    "summary": summary,
                    "tool_calls_log": list(_tool_calls_log),
                    "started_at": None,
                    "ended_at": None,
                }
                _wh_task = asyncio.create_task(_deliver_post_call_webhook(_payload_ctx))
                _background_tasks.add(_wh_task)
                _wh_task.add_done_callback(_background_tasks.discard)
        except Exception as e:
            logger.warning(f"[webhook] Could not schedule post-call delivery: {e}")

        _shutdown_event.set()

    @ctx.room.on("disconnected")
    def _on_disconnect(*_: object) -> None:
        _do_save_and_signal()

    @ctx.room.on("participant_connected")
    def _on_participant_connected(participant: object) -> None:
        _try_capture_sid(getattr(participant, "attributes", {}) or {}, "participant_connected")

    # LiveKit's SIP bridge often attaches `sip.*` attributes *after* the
    # participant first joins (once the SIP leg is fully established), so the
    # `participant_connected` snapshot may still be empty — this event fires
    # whenever attributes are updated and is the more reliable capture point.
    @ctx.room.on("participant_attributes_changed")
    def _on_participant_attrs_changed(changed_attributes: dict, participant: object) -> None:
        _try_capture_sid(getattr(participant, "attributes", {}) or changed_attributes or {}, "participant_attributes_changed")

    @ctx.room.on("participant_disconnected")
    def _on_participant_disconnected(participant: object) -> None:
        attrs = getattr(participant, "attributes", {}) or {}
        if not _is_phone_participant(attrs):
            return
        reason = getattr(participant, "disconnect_reason", None)
        if reason is None:
            return
        reason_code = int(reason)
        _phone_disconnect_reason[0] = reason_code
        logger.info(
            f"[disposition] Phone participant left: "
            f"{_DISCONNECT_REASON_NAMES.get(reason_code, reason_code)}"
        )
        # Kick off the DB write immediately — campaign workers may exit before
        # the room's `disconnected` event fires (SDK marks the job done once
        # the entrypoint returns unless we keep it alive, but as a belt-and-
        # suspenders measure we also trigger here so the save races ahead).
        _do_save_and_signal()

    # Race guard: the SIP participant may have joined (with attributes already
    # attached) before these handlers were registered — scan whoever's here now.
    for _p in getattr(ctx.room, "remote_participants", {}).values():
        _try_capture_sid(getattr(_p, "attributes", {}) or {}, "remote_participants snapshot")

    @session.on("conversation_item_added")
    def _on_item_added(ev: object) -> None:
        """Catch-all for any message added to conversation."""
        role = getattr(ev, "role", None) or getattr(getattr(ev, "item", None), "role", None)
        content = getattr(ev, "content", None) or getattr(getattr(ev, "item", None), "content", None)
        # `content` can be a list of text chunks (e.g. ['some text']) rather than
        # a plain string — str()'ing a list literally produces "['some text']" in
        # the saved transcript, so flatten it to its text first.
        if isinstance(content, (list, tuple)):
            text = " ".join(str(c).strip() for c in content if str(c).strip())
        else:
            text = str(content).strip() if content else ""
        if role and text:
            speaker = cfg["name"] if role == "assistant" else "Cliente"
            agent.add_transcript(speaker, text)

    await session.start(
        agent=agent,
        room=ctx.room,
        room_input_options=RoomInputOptions(
            close_on_disconnect=False,  # Don't close if SIP participant temporarily disconnects
        ),
    )

    # Small pause to let the SIP participant fully connect and audio pipeline stabilize
    await asyncio.sleep(1.0)

    await session.say(cfg["greeting"])
    agent.add_transcript(cfg["name"], cfg["greeting"])

    # ── Idle nudge + voicemail fast-hangup ───────────────────────────────────
    # If the customer goes silent for `idle_timeout_seconds`, proactively say
    # `idle_message` (e.g. "¿sigues ahí?") so the call doesn't stall in dead
    # air. Configured per-agent from the admin panel; disabled by default.
    #
    # Voicemail shortcut: if the customer NEVER spoke at all (no user speech
    # committed since the greeting) and the first idle timeout fires, we skip
    # the "¿sigues ahí?" nudge and hang up immediately.  This cuts voicemail
    # calls from ~80s down to ~idle_timeout seconds.
    idle_timeout = cfg.get("idle_timeout_seconds")
    if idle_timeout and idle_timeout > 0:
        _last_user_activity = [asyncio.get_event_loop().time()]
        _idle_nudge_count = [0]
        _customer_ever_spoke = [False]  # True once any user_speech_committed fires
        _MAX_IDLE_NUDGES = 2  # after this many unanswered nudges, end the call rather than loop forever
        _GOODBYE_MESSAGE = "Como no logro escucharlo, voy a finalizar la llamada. ¡Que tenga un buen día!"

        @session.on("user_speech_committed")
        def _on_first_speech(ev: object) -> None:
            # Mark that a real human uttered something (voicemail check uses this)
            _customer_ever_spoke[0] = True

        @session.on("user_state_changed")
        def _on_user_state_changed(ev: object) -> None:
            if getattr(ev, "new_state", None) == "speaking":
                _last_user_activity[0] = asyncio.get_event_loop().time()
                # Real engagement detected — forgive past unanswered nudges so a
                # customer who goes quiet again later gets the full grace period.
                _idle_nudge_count[0] = 0

        @session.on("agent_state_changed")
        def _on_agent_state_changed(ev: object) -> None:
            # Reset the silence clock the moment the agent stops talking — the
            # countdown to "¿sigues ahí?" should measure silence *after* the
            # agent finished its turn, not from whenever the customer last
            # spoke (which could be well before a long agent monologue ended,
            # causing an immediate false-positive nudge as soon as the agent
            # goes quiet).
            if getattr(ev, "old_state", None) == "speaking" and getattr(ev, "new_state", None) != "speaking":
                _last_user_activity[0] = asyncio.get_event_loop().time()

        async def _idle_watcher() -> None:
            idle_message = cfg.get("idle_message") or "¿Sigues ahí?"
            loop = asyncio.get_event_loop()
            try:
                while True:
                    await asyncio.sleep(1.0)
                    silent_for = loop.time() - _last_user_activity[0]
                    if silent_for < idle_timeout:
                        continue
                    if getattr(session, "agent_state", None) == "speaking":
                        continue

                    # ── Voicemail backup close ────────────────────────────────
                    # If the real-time voicemail detector already fired
                    # (_voicemail_hangup_triggered) but ctx.delete_room() was
                    # delayed or failed, this idle tick is the safety net.
                    # Hang up silently without any nudge message.
                    if _voicemail_hangup_triggered[0]:
                        logger.info(
                            f"[voicemail] Idle backup: cerrando sala por buzón ya detectado."
                        )
                        try:
                            await ctx.delete_room(room_name)
                        except Exception as e:
                            logger.warning(f"[voicemail] Backup room delete failed: {e}")
                        return

                    _idle_nudge_count[0] += 1

                    # ── Voicemail fast-hangup (customer never spoke) ──────────
                    # If this is the very first nudge and the human side NEVER
                    # produced any speech, it's a voicemail/machine — skip the
                    # "¿sigues ahí?" loop and hang up immediately.
                    if _idle_nudge_count[0] == 1 and not _customer_ever_spoke[0]:
                        logger.info(
                            f"[voicemail] Cliente nunca habló tras {silent_for:.0f}s — "
                            f"colgando (buzón de voz o línea muerta)."
                        )
                        await session.say(_GOODBYE_MESSAGE)
                        agent.add_transcript(cfg["name"], _GOODBYE_MESSAGE)
                        await asyncio.sleep(0.5)
                        try:
                            await ctx.delete_room(room_name)
                        except Exception as e:
                            logger.warning(f"[voicemail] Failed to end voicemail call: {e}")
                        return

                    if _idle_nudge_count[0] > _MAX_IDLE_NUDGES:
                        # No one's there — saying "¿sigues ahí?" forever just burns
                        # money on a dead line (or voicemail). Say goodbye and hang up.
                        logger.info(
                            f"[idle] Sin respuesta tras {_MAX_IDLE_NUDGES} avisos — finalizando la llamada."
                        )
                        await session.say(_GOODBYE_MESSAGE)
                        agent.add_transcript(cfg["name"], _GOODBYE_MESSAGE)
                        await asyncio.sleep(0.5)
                        try:
                            await ctx.delete_room(room_name)
                        except Exception as e:
                            logger.warning(f"[idle] Failed to end stalled call: {e}")
                        return

                    logger.info(
                        f"[idle] {silent_for:.0f}s sin escuchar al cliente — diciendo: {idle_message!r} "
                        f"(aviso {_idle_nudge_count[0]}/{_MAX_IDLE_NUDGES})"
                    )
                    await session.say(idle_message)
                    agent.add_transcript(cfg["name"], idle_message)
                    # Reset the clock so we wait a full timeout before nudging again
                    _last_user_activity[0] = loop.time()
            except asyncio.CancelledError:
                pass

        _idle_task = asyncio.create_task(_idle_watcher())
        _background_tasks.add(_idle_task)
        _idle_task.add_done_callback(_background_tasks.discard)

    # ── Keep entrypoint alive until the session DB write finishes ────────────
    # Without this `await`, the SDK considers the job done as soon as the
    # entrypoint returns and may exit the worker process while
    # _save_session_to_db is still mid-flight (Twilio recording poll + Supabase
    # write can take up to ~35s). This was the root cause of campaign sessions
    # staying "en curso" — the phone participant disconnected, _do_save_and_signal
    # was never awaited, and the process exited before the DB write landed.
    try:
        await asyncio.wait_for(_shutdown_event.wait(), timeout=7200.0)  # 2h hard cap
    except asyncio.TimeoutError:
        logger.warning("[entrypoint] 2h safety timeout — forcing session save now")
        _do_save_and_signal()

    # Drain pending background tasks — mainly the session DB write.
    # We give 15s: enough for Phase 1 (core Supabase write, ~2s) to complete
    # before the SDK's own ~18s entrypoint timeout fires and forcibly cancels us.
    # Phase 2 (Twilio recording poll) may be cut short — that's acceptable because
    # the core session row (transcript + end_reason) is already persisted by then.
    # The idle watcher was already cancelled by _do_save_and_signal.
    pending = [t for t in list(_background_tasks) if not t.done()]
    if pending:
        try:
            await asyncio.wait_for(asyncio.gather(*pending, return_exceptions=True), timeout=15.0)
        except asyncio.TimeoutError:
            logger.info("[entrypoint] 15s drain timeout — core DB write already done, recording fetch may still be in-flight")
    logger.info("[entrypoint] Session persisted — worker may now exit.")


def _twilio_accounts() -> list[tuple[str, str]]:
    """
    Return list of (account_sid, auth_token) pairs for all configured Twilio accounts.
    Tries the Panama (_PA) account first since that's the active outbound trunk,
    then falls back to the main account.
    """
    accounts = []
    for suffix in ("_PA", ""):
        sid = os.getenv(f"TWILIO_ACCOUNT_SID{suffix}", "")
        token = os.getenv(f"TWILIO_AUTH_TOKEN{suffix}", "")
        if sid and token:
            accounts.append((sid, token))
    return accounts


async def _fetch_twilio_recording(call_sid: str, retries: int = 6) -> str | None:
    """
    Poll Twilio for the recording of a given call SID.
    Recordings may take 10-30s to appear after the call ends.
    Returns the mp3 URL or None.

    Tries all configured Twilio accounts (PA first, then main) so that
    calls made via the Panama SIP trunk are found correctly.
    """
    import urllib.request
    import base64

    accounts = _twilio_accounts()
    if not accounts:
        logger.warning("[recording] No TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN configured")
        return None

    def _fetch_once(account_sid: str, auth_token: str) -> tuple[list[dict], str]:
        credentials = base64.b64encode(f"{account_sid}:{auth_token}".encode()).decode()
        url = f"https://api.twilio.com/2010-04-01/Accounts/{account_sid}/Recordings.json?CallSid={call_sid}"
        req = urllib.request.Request(url, headers={"Authorization": f"Basic {credentials}"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
            return data.get("recordings", []), account_sid

    for attempt in range(retries):
        for account_sid, auth_token in accounts:
            try:
                recordings, found_in = await asyncio.to_thread(_fetch_once, account_sid, auth_token)
                if recordings:
                    sid = recordings[0]["sid"]
                    mp3_url = f"https://api.twilio.com/2010-04-01/Accounts/{found_in}/Recordings/{sid}.mp3"
                    logger.info(f"[recording] Found recording in account {found_in[:8]}…: {mp3_url}")
                    return mp3_url
            except Exception as e:
                logger.warning(f"[recording] Attempt {attempt + 1} / account {account_sid[:8]}… failed: {e}")
        # Wait longer between retries: 5s, 10s, 15s, 20s, 25s, 30s.
        await asyncio.sleep(5 * (attempt + 1))

    logger.warning(f"[recording] No recording found after {retries} attempts for {call_sid}")
    return None


def _lookup_agent_webhook_config(agent_id: str | None) -> tuple[str | None, str | None]:
    """Fetch the agent's webhook_url + webhook_secret in one call. Returns
    (url, secret) — both None if the agent has no webhook configured."""
    if not agent_id:
        return (None, None)
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        return (None, None)
    try:
        from supabase import create_client
        db = create_client(url, key)
        result = (
            db.table("agents")
            .select("webhook_url,webhook_secret")
            .eq("id", agent_id)
            .single()
            .execute()
        )
        if not result.data:
            return (None, None)
        return (result.data.get("webhook_url"), result.data.get("webhook_secret"))
    except Exception as e:
        logger.warning(f"[webhook] webhook config lookup failed: {e}")
        return (None, None)


async def _generate_call_summary(transcript: str, agent_name: str) -> str:
    """Ask GPT-4o-mini for a 2-3 sentence call summary. Falls back to an
    extractive first+last-N-chars summary if the LLM call fails or times
    out — better to have a partial summary than to lose the call entirely."""
    if not transcript or len(transcript.strip()) < 30:
        return "(transcript too short for summary)"
    safe_name = agent_name or "desconocido"
    safe_transcript = transcript[:6000]
    prompt = (
        "Eres un asistente que resume llamadas. Devuelve EXCLUSIVAMENTE un JSON "
        'válido con esta forma: {"summary": "<2-3 oraciones en español>", '
        '"category": "<vendor|client|insurance|spam|other>", '
        '"urgency": "<low|medium|high>"}. '
        "El transcript es de una llamada al agente "
        f"{safe_name}:\n\n{safe_transcript}"
    )
    try:
        from livekit.plugins import openai as lkopenai
        llm = lkopenai.LLM(model="gpt-4o-mini", temperature=0.3)
        result = await asyncio.wait_for(
            llm.chat(
                chat_ctx=lkopenai.ChatContext().append(
                    role="user", text=prompt
                ),
                timeout=10,
            ),
        )
        text = (result.choices[0].message.content or "").strip()
        # Strip code-fence wrappers in case the model returned ```json ... ```
        if text.startswith("```"):
            text = text.strip("`").split(chr(10), 1)[-1]
            if text.startswith("json"):
                text = text.split(chr(10), 1)[-1]
        parsed = json.loads(text)
        summary = parsed.get("summary", "").strip()
        return summary or text
    except (asyncio.TimeoutError, Exception) as e:
        logger.warning(f"[summary] LLM failed/timeout, using extractive fallback: {e}")
        # Extractive fallback: first 200 + ellipsis + last 200 chars
        t = transcript.strip()
        if len(t) <= 400:
            return t
        return f"{t[:200]}... {t[-200:]}"


def _sign_webhook_payload(payload_bytes: bytes, secret: str) -> str:
    """HMAC-SHA256 signature in the format GitHub/Stripe webhooks use:
    `sha256=<hex_digest>`. The receiver verifies by recomputing the same
    HMAC with the shared secret and constant-time-comparing the result."""
    import hashlib
    import hmac as _hmac
    digest = _hmac.new(secret.encode("utf-8"), payload_bytes, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


async def _deliver_post_call_webhook(ctx: dict) -> None:
    """Fire the VAPI-style end-of-call report to the agent's configured
    webhook URL. Includes transcript, call summary, tool calls, and metadata.
    HMAC-SHA256 signs the body when a secret is configured. 3 retries with
    exponential backoff (2s, 4s, 8s) — final failure logged to webhook_deliveries
    so the admin can see + retry it from the dashboard."""
    import aiohttp as _aiohttp
    import time as _time

    session_id = ctx["session_id"]
    agent_id = ctx["agent_id"]
    webhook_url = ctx["webhook_url"]
    webhook_secret = ctx.get("webhook_secret")
    transcript = ctx.get("transcript") or ""
    tool_calls_log = ctx.get("tool_calls_log") or []
    summary_costs = ctx.get("summary") or {}

    # Phase 1: generate summary (LLM call, ~500ms typical, 10s timeout)
    summary_text = await _generate_call_summary(transcript, ctx.get("agent_name") or "")

    # Phase 2: persist summary in DB (so the dashboard can show it)
    try:
        from supabase import create_client
        db = create_client(
            os.getenv("SUPABASE_URL", ""),
            os.getenv("SUPABASE_SERVICE_ROLE_KEY", ""),
        )
        db.table("sessions").update({"call_summary": summary_text}).eq("id", session_id).execute()
    except Exception as e:
        logger.warning(f"[webhook] Could not persist call_summary: {e}")

    # Phase 3: build the payload
    from datetime import datetime, timezone as _tz
    payload = {
        "event": "end-of-call",
        "version": "1.0",
        "agent_id": agent_id,
        "agent_name": ctx.get("agent_name"),
        "session_id": session_id,
        "call": {
            "room_name": ctx.get("room_name"),
            "twilio_call_sid": ctx.get("twilio_call_sid"),
            "end_reason": ctx.get("end_reason"),
        },
        "costs": summary_costs,
        "summary": summary_text,
        "transcript": transcript,
        "tools": tool_calls_log,
    }
    payload_json = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    headers = {"Content-Type": "application/json"}
    if webhook_secret:
        headers["X-Webhook-Signature"] = _sign_webhook_payload(payload_json, webhook_secret)

    # Phase 4: deliver with retries
    last_error: str | None = None
    last_http: int | None = None
    last_body: str | None = None
    delivered = False

    for attempt in range(1, 4):
        start = _time.monotonic()
        try:
            async with _aiohttp.ClientSession(timeout=_aiohttp.ClientTimeout(total=30)) as session:
                async with session.post(webhook_url, data=payload_json, headers=headers) as resp:
                    text = (await resp.text())[:1000]
                    last_http = resp.status
                    last_body = text
                    if 200 <= resp.status < 300:
                        delivered = True
                        logger.info(
                            f"[webhook] delivered session={session_id[:8]}... "
                            f"attempt={attempt} status={resp.status} "
                            f"latency={int((_time.monotonic() - start) * 1000)}ms"
                        )
                        break
                    last_error = f"HTTP {resp.status}"
                    logger.warning(
                        f"[webhook] attempt {attempt} returned {resp.status}: {text[:200]}"
                    )
        except Exception as e:
            last_error = f"{type(e).__name__}: {str(e)[:200]}"
            logger.warning(f"[webhook] attempt {attempt} error: {last_error}")
        # Backoff: 2s, 4s, 8s (only if not delivered)
        if not delivered and attempt < 3:
            await asyncio.sleep(2 ** attempt)

    # Phase 5: audit log (always log, even on failure)
    try:
        from supabase import create_client
        db = create_client(
            os.getenv("SUPABASE_URL", ""),
            os.getenv("SUPABASE_SERVICE_ROLE_KEY", ""),
        )
        db.table("webhook_deliveries").insert({
            "session_id": session_id,
            "agent_id": agent_id,
            "webhook_url": webhook_url,
            "status": "delivered" if delivered else "failed",
            "http_status": last_http,
            "latency_ms": int((_time.monotonic() - start) * 1000) if not delivered else None,
            "attempts": attempt,
            "response_body": last_body,
            "last_error": last_error,
        }).execute()
    except Exception as e:
        logger.warning(f"[webhook] Could not log delivery: {e}")


async def _save_session_to_db(
    session_id: str,
    summary: dict,
    room_name: str = "",
    transcript: str = "",
    twilio_call_sid: str | None = None,
    agent_id: str | None = None,
    end_reason: str | None = None,
) -> None:
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        return
    try:
        from supabase import create_client
        db = create_client(url, key)
        ended_at = datetime.now(timezone.utc).isoformat()

        # ── Phase 1: Write core session data immediately (no recording URL yet) ──
        # This must complete before the SDK's ~18s entrypoint timeout fires.
        # `_create_session_row` already inserted this row at call start (real
        # `started_at`, FK target for mid-call `api_usage` writes) — fill in
        # the final outcome here rather than inserting a duplicate row.
        def _write_core() -> None:
            db.table("sessions").update({
                "total_cost_usd": summary["total_usd"],
                "cost_by_provider": summary["by_provider"],
                "ended_at": ended_at,
                "transcript": transcript or None,
                "twilio_call_sid": twilio_call_sid,
                "end_reason": end_reason,
            }).eq("id", session_id).execute()
            # Update call_queue transcript immediately too
            if room_name and transcript:
                db.table("call_queue").update({"transcript": transcript}).eq("room_name", room_name).execute()

        await asyncio.to_thread(_write_core)
        logger.info(f"[db] Session {session_id[:8]}… core data written (transcript + end_reason)")

        # ── Phase 2: Fetch Twilio recording and update (slow, up to ~35s) ──
        # This may be cancelled if the SDK kills the process before it completes —
        # that's acceptable because the core session row is already persisted above.
        if twilio_call_sid:
            recording_url = await _fetch_twilio_recording(twilio_call_sid)
            if recording_url:
                def _write_recording() -> None:
                    db.table("sessions").update({"recording_url": recording_url}).eq("id", session_id).execute()
                    if room_name:
                        db.table("call_queue").update({"recording_url": recording_url}).eq("room_name", room_name).execute()
                await asyncio.to_thread(_write_recording)
                logger.info(f"[db] Session {session_id[:8]}… recording URL updated")

    except Exception as e:
        logger.error(f"Failed to save session: {e}")


if __name__ == "__main__":
    # S1.2 — fail-fast if LiveKit credentials are missing. The previous
    # `devkey`/`secret` fallbacks silently ran the worker against publicly-
    # known credentials; the agent registers itself with the LiveKit server
    # on startup, so a missing env means refuse-to-start rather than silently
    # spawn a worker the LiveKit server would happily accept but anyone else
    # could impersonate.
    _lk_key = os.getenv("LIVEKIT_API_KEY")
    _lk_secret = os.getenv("LIVEKIT_API_SECRET")
    if not _lk_key or not _lk_secret:
        raise RuntimeError(
            "LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set. "
            "Refusing to start the voice agent with default credentials."
        )

    # S5 — start the health HTTP server BEFORE cli.run_app so Docker's
    # healthcheck can hit it the moment the container is up. The server
    # is a daemon thread; cli.run_app blocks forever, so we need it to
    # run in the background.
    _start_health_server()

    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            agent_name="voice-agent",
            ws_url=os.getenv("LIVEKIT_URL", "ws://localhost:7880"),
            api_key=_lk_key,
            api_secret=_lk_secret,
        )
    )
