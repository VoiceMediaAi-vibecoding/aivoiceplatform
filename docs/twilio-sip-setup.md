# Twilio + LiveKit SIP Setup

Corre estos pasos UNA SOLA VEZ para configurar el trunk.

## Pre-requisitos
- Cuenta Twilio con Elastic SIP Trunking habilitado
- Twilio CLI instalado (`brew install twilio`)
- Número de teléfono Twilio comprado
- LiveKit `lk` CLI autenticado

---

## Paso 1: Crear SIP Trunk en Twilio

```bash
twilio api trunking v1 trunks create \
  --friendly-name "LiveKit AI Agent" \
  --domain-name "livekit-ai-agent.pstn.twilio.com"
```

Guarda el `SID` del trunk (empieza con `TK...`).

---

## Paso 2: Configurar origination URI (inbound — Twilio → tu SIP server)

Reemplaza `YOUR_TRUNK_SID` y `52.88.93.10` con tu IP:

```bash
twilio api trunking v1 trunks origination-urls create \
  --trunk-sid YOUR_TRUNK_SID \
  --friendly-name "LiveKit SIP Server" \
  --sip-url "sip:52.88.93.10:5060;transport=tcp" \
  --weight 1 --priority 1 --enabled
```

---

## Paso 3: Configurar outbound credentials (LiveKit → Twilio)

1. Ve a [Twilio Console → Voice → Credential Lists](https://console.twilio.com/us1/develop/voice/credentials/credential-lists)
2. Crea una credential list con usuario y contraseña (guárdalos)
3. En **Elastic SIP Trunking → Trunks → [tu trunk] → Termination → Authentication** agrega esa credential list
4. En **Termination SIP URI** pon: `livekit-ai-agent.pstn.twilio.com`

---

## Paso 4: Asociar número de teléfono al trunk

```bash
# Listar números disponibles
twilio phone-numbers list

# Listar trunks
twilio api trunking v1 trunks list

# Asociar (reemplaza los SIDs)
twilio api trunking v1 trunks phone-numbers create \
  --trunk-sid YOUR_TRUNK_SID \
  --phone-number-sid YOUR_PHONE_NUMBER_SID
```

---

## Paso 5: Crear InboundTrunk en LiveKit

```bash
lk sip inbound create '{
  "name": "Twilio Inbound",
  "numbers": ["+1XXXXXXXXXX"]
}'
```

Guarda el `inbound_trunk_id` del output.

---

## Paso 6: Crear OutboundTrunk en LiveKit

```bash
lk sip outbound create '{
  "name": "Twilio Outbound",
  "address": "livekit-ai-agent.pstn.twilio.com",
  "numbers": ["+1XXXXXXXXXX"],
  "auth_username": "TU_USUARIO_DE_CREDENTIALS",
  "auth_password": "TU_PASSWORD_DE_CREDENTIALS"
}'
```

Guarda el `outbound_trunk_id` — ponlo en `.env`:
```
LIVEKIT_SIP_OUTBOUND_TRUNK_ID=ST_xxxxxxxx
```

---

## Paso 7: Crear Dispatch Rule (routing inbound → agente)

```bash
lk sip dispatch create '{
  "name": "AI Agent Rule",
  "rule": {
    "dispatchRuleIndividual": {
      "roomPrefix": "call-"
    }
  },
  "roomConfig": {
    "agents": [
      { "agentName": "voice-agent" }
    ]
  }
}'
```

---

## Paso 8: Desplegar en el servidor AWS

```bash
# En 52.88.93.10:
git clone <tu-repo> LiveKit
cd LiveKit
cp .env.example .env
# editar .env con las keys
docker compose up -d
```

**Asegúrate de abrir estos puertos en el Security Group de AWS:**
- TCP 7880 (LiveKit WebSocket)
- TCP 5060 (SIP signaling)
- UDP 10000-20000 (RTP media)
- TCP 8000 (API)
- TCP 3000 (Dashboard)

---

## Prueba de llamada inbound

1. Corre el agente: `docker compose logs -f agent`
2. Llama al número Twilio desde tu teléfono
3. El agente debe contestar en ~3 segundos

## Prueba de llamada outbound

```bash
curl -X POST http://52.88.93.10:8002/calls/outbound \
  -H "Content-Type: application/json" \
  -d '{"to_number": "+521234567890"}'
```

O usa el dashboard en `http://52.88.93.10:3000/calls`.
