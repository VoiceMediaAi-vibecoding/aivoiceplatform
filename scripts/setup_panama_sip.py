"""
One-shot script: sets up Panama SIP for Camila.

What it does:
  1. Creates an Elastic SIP Trunk on Twilio Account Panama
  2. Adds origination URI → LiveKit SIP (44.247.225.191) for inbound
  3. Creates SIP credentials for outbound auth
  4. Associates +5072023503 with the trunk
  5. Creates LiveKit InboundTrunk for +5072023503
  6. Creates LiveKit OutboundTrunk via the new Twilio domain
  7. Prints the values to add to .env

Usage (on the server):
    uv run python scripts/setup_panama_sip.py
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import urllib.parse
import urllib.request

from dotenv import load_dotenv

load_dotenv()

# ── Panama Twilio credentials ─────────────────────────────────────────────────
# All read from env vars so secrets stay out of git history. Add these to
# .env on the VM that runs this script:
#   TWILIO_ACCOUNT_SID_PA=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
#   TWILIO_AUTH_TOKEN_PA=your_panama_auth_token
#   TWILIO_PANAMA_PHONE=+5072023503
PA_ACCOUNT_SID = os.environ["TWILIO_ACCOUNT_SID_PA"]
PA_AUTH_TOKEN  = os.environ["TWILIO_AUTH_TOKEN_PA"]
PA_PHONE       = os.environ["TWILIO_PANAMA_PHONE"]

# ── LiveKit server ────────────────────────────────────────────────────────────
LK_URL    = os.getenv("LIVEKIT_URL", "ws://localhost:7880")
LK_KEY    = os.getenv("LIVEKIT_API_KEY")
LK_SECRET = os.getenv("LIVEKIT_API_SECRET")

# ── SIP server public IP ──────────────────────────────────────────────────────
LIVEKIT_SIP_IP = os.getenv("LIVEKIT_SIP_IP", "44.247.225.191")

# ── Outbound SIP credentials (new) ───────────────────────────────────────────
# These are credentials we provision ON Twilio for the trunk. They're not
# "secrets" per se (anyone can hit the SIP trunk with valid creds) but
# keeping them out of git avoids confusion. Set in .env:
#   SIP_AUTH_USER=livekit-pa
#   SIP_AUTH_PASS=PanamaLK2025@
SIP_AUTH_USER = os.getenv("SIP_AUTH_USER", "livekit-pa")
SIP_AUTH_PASS = os.environ["SIP_AUTH_PASS"]


# ─────────────────────────────────────────────────────────────────────────────
# Twilio helpers
# ─────────────────────────────────────────────────────────────────────────────

def _twilio(
    method: str,
    url: str,
    data: dict | None = None,
    account_sid: str = PA_ACCOUNT_SID,
    auth_token: str = PA_AUTH_TOKEN,
) -> dict:
    creds = base64.b64encode(f"{account_sid}:{auth_token}".encode()).decode()
    headers = {"Authorization": f"Basic {creds}"}
    body: bytes | None = None
    if data:
        body = urllib.parse.urlencode(data).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body_text = e.read().decode()
        raise RuntimeError(f"Twilio {method} {url} → {e.code}: {body_text}") from e


def setup_twilio_trunk() -> tuple[str, str]:
    """
    Creates Elastic SIP Trunk on the Panama Twilio account.
    Returns (trunk_domain, twilio_trunk_sid).
    """
    print("\n📡 Creating Twilio Elastic SIP Trunk (Panama account)...")

    # 1. Create trunk
    trunk = _twilio(
        "POST",
        "https://trunking.twilio.com/v1/Trunks",
        {
            "FriendlyName": "LiveKit Panama",
        },
    )
    trunk_sid = trunk["sid"]
    # domain_name may be null on creation — fetch it explicitly
    trunk_domain = trunk.get("domain_name")
    if not trunk_domain:
        details = _twilio("GET", f"https://trunking.twilio.com/v1/Trunks/{trunk_sid}")
        trunk_domain = details.get("domain_name") or f"{trunk_sid.lower()}.pstn.twilio.com"
    print(f"  ✅ Trunk SID   : {trunk_sid}")
    print(f"  ✅ Trunk domain: {trunk_domain}")

    # 2. Add origination URL (inbound: Twilio → LiveKit SIP)
    print("  Adding origination URL (inbound)...")
    _twilio(
        "POST",
        f"https://trunking.twilio.com/v1/Trunks/{trunk_sid}/OriginationUrls",
        {
            "SipUrl": f"sip:{LIVEKIT_SIP_IP}",
            "FriendlyName": "LiveKit SIP",
            "Weight": 1,
            "Priority": 1,
            "Enabled": "true",
        },
    )
    print(f"  ✅ Origination → sip:{LIVEKIT_SIP_IP}")

    # 3. Create SIP credential list for outbound termination auth
    print("  Creating SIP credential list...")
    cred_list = _twilio(
        "POST",
        f"https://api.twilio.com/2010-04-01/Accounts/{PA_ACCOUNT_SID}/SIP/CredentialLists.json",
        {"FriendlyName": "LiveKit Panama Outbound"},
    )
    cred_list_sid = cred_list["sid"]

    _twilio(
        "POST",
        f"https://api.twilio.com/2010-04-01/Accounts/{PA_ACCOUNT_SID}/SIP/CredentialLists/{cred_list_sid}/Credentials.json",
        {"Username": SIP_AUTH_USER, "Password": SIP_AUTH_PASS},
    )
    print(f"  ✅ SIP credentials: {SIP_AUTH_USER} / {SIP_AUTH_PASS}")

    # 4. Associate credential list with trunk termination
    _twilio(
        "POST",
        f"https://trunking.twilio.com/v1/Trunks/{trunk_sid}/CredentialLists",
        {"CredentialListSid": cred_list_sid},
    )
    print("  ✅ Credentials linked to trunk")

    # 5. Associate +5072023503 with trunk
    print(f"  Associating {PA_PHONE} with trunk...")
    numbers = _twilio(
        "GET",
        f"https://api.twilio.com/2010-04-01/Accounts/{PA_ACCOUNT_SID}/IncomingPhoneNumbers.json"
        f"?PhoneNumber={urllib.parse.quote(PA_PHONE)}",
    )
    phone_list = numbers.get("incoming_phone_numbers", [])
    if not phone_list:
        raise RuntimeError(
            f"Phone number {PA_PHONE} not found in Panama Twilio account. "
            "Make sure it's purchased and active."
        )
    phone_sid = phone_list[0]["sid"]
    _twilio(
        "POST",
        f"https://trunking.twilio.com/v1/Trunks/{trunk_sid}/PhoneNumbers",
        {"PhoneNumberSid": phone_sid},
    )
    print(f"  ✅ {PA_PHONE} ({phone_sid}) linked to trunk")

    return trunk_domain, trunk_sid


async def setup_livekit_trunks(trunk_domain: str) -> tuple[str, str]:
    """
    Creates LiveKit InboundTrunk + OutboundTrunk for Panama.
    Returns (inbound_trunk_id, outbound_trunk_id).
    """
    from livekit import api as lk_api

    print("\n🔌 Creating LiveKit SIP trunks...")
    lkapi = lk_api.LiveKitAPI(url=LK_URL, api_key=LK_KEY, api_secret=LK_SECRET)

    # Inbound trunk (receives calls to +5072023503)
    inbound = await lkapi.sip.create_sip_inbound_trunk(
        lk_api.CreateSIPInboundTrunkRequest(
            trunk=lk_api.SIPInboundTrunkInfo(
                name="Twilio Panama Inbound",
                numbers=[PA_PHONE],
            )
        )
    )
    print(f"  ✅ InboundTrunk : {inbound.sip_trunk_id}")

    # Outbound trunk (dials out using Panama number via Twilio trunk domain)
    outbound = await lkapi.sip.create_sip_outbound_trunk(
        lk_api.CreateSIPOutboundTrunkRequest(
            trunk=lk_api.SIPOutboundTrunkInfo(
                name="Twilio Panama Outbound",
                address=trunk_domain,
                numbers=[PA_PHONE],
                auth_username=SIP_AUTH_USER,
                auth_password=SIP_AUTH_PASS,
            )
        )
    )
    print(f"  ✅ OutboundTrunk: {outbound.sip_trunk_id}")

    await lkapi.aclose()
    return inbound.sip_trunk_id, outbound.sip_trunk_id


EXISTING_TWILIO_TRUNK_SID = "TK3e35cfc5fda0fdf07de99352d546e971"
EXISTING_LK_INBOUND_ID   = "ST_nszQrytht2B3"


async def main() -> None:
    print("=" * 60)
    print("  LiveKit Panama SIP Setup (resume)")
    print("=" * 60)

    # Twilio trunk already created — just get its domain
    print("\n📡 Fetching existing Twilio trunk domain...")
    details = _twilio("GET", f"https://trunking.twilio.com/v1/Trunks/{EXISTING_TWILIO_TRUNK_SID}")
    trunk_domain = details.get("domain_name") or f"{EXISTING_TWILIO_TRUNK_SID.lower()}.pstn.twilio.com"
    print(f"  ✅ Trunk domain: {trunk_domain}")
    print(f"  ✅ Full details: {json.dumps({k: details[k] for k in ('sid','domain_name','friendly_name') if k in details})}")

    # Only create the outbound LiveKit trunk (inbound already done)
    from livekit import api as lk_api
    print("\n🔌 Creating LiveKit OutboundTrunk...")
    lkapi = lk_api.LiveKitAPI(url=LK_URL, api_key=LK_KEY, api_secret=LK_SECRET)
    outbound = await lkapi.sip.create_sip_outbound_trunk(
        lk_api.CreateSIPOutboundTrunkRequest(
            trunk=lk_api.SIPOutboundTrunkInfo(
                name="Twilio Panama Outbound",
                address=trunk_domain,
                numbers=[PA_PHONE],
                auth_username=SIP_AUTH_USER,
                auth_password=SIP_AUTH_PASS,
            )
        )
    )
    lk_outbound_id = outbound.sip_trunk_id
    await lkapi.aclose()
    print(f"  ✅ OutboundTrunk: {lk_outbound_id}")

    lk_inbound_id = EXISTING_LK_INBOUND_ID

    # Summary
    print("\n" + "=" * 60)
    print("✅ Setup complete! Add these to .env:")
    print("=" * 60)
    print(f"TWILIO_ACCOUNT_SID_PA={PA_ACCOUNT_SID}")
    print(f"TWILIO_AUTH_TOKEN_PA={PA_AUTH_TOKEN}")
    print(f"TWILIO_PHONE_NUMBER_PA={PA_PHONE}")
    print(f"TWILIO_SIP_TRUNK_SID_PA={twilio_trunk_sid}")
    print(f"TWILIO_SIP_AUTH_USER_PA={SIP_AUTH_USER}")
    print(f"TWILIO_SIP_AUTH_PASS_PA={SIP_AUTH_PASS}")
    print(f"LIVEKIT_SIP_INBOUND_TRUNK_PA={lk_inbound_id}")
    print(f"LIVEKIT_SIP_OUTBOUND_TRUNK_PA={lk_outbound_id}")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())
