"""
Run this ONCE on the server after docker compose up to configure LiveKit SIP trunks.
Usage: uv run python scripts/setup_sip_trunks.py
"""
import asyncio
import os
from dotenv import load_dotenv

load_dotenv()

from livekit import api

LIVEKIT_URL = os.getenv("LIVEKIT_URL", "ws://localhost:7880")
API_KEY = os.getenv("LIVEKIT_API_KEY", "devkey")
API_SECRET = os.getenv("LIVEKIT_API_SECRET", "secret")

# Your Twilio SIP trunk domain (created earlier)
SIP_TRUNK_DOMAIN = "livekit-agent-ac710ccc4d.pstn.twilio.com"

# Your phone numbers
PHONE_NUMBERS = ["+18782849980", "+19893345446"]

# Your Twilio outbound credentials (set these in .env or hardcode for one-time setup)
SIP_AUTH_USER = os.getenv("TWILIO_SIP_AUTH_USER", "testing")
SIP_AUTH_PASS = os.getenv("TWILIO_SIP_AUTH_PASS", "")


async def main():
    lkapi = api.LiveKitAPI(url=LIVEKIT_URL, api_key=API_KEY, api_secret=API_SECRET)

    # 1. Create InboundTrunk
    print("Creating InboundTrunk...")
    inbound = await lkapi.sip.create_sip_inbound_trunk(
        api.CreateSIPInboundTrunkRequest(
            trunk=api.SIPInboundTrunkInfo(
                name="Twilio Inbound",
                numbers=PHONE_NUMBERS,
            )
        )
    )
    print(f"  ✅ InboundTrunk: {inbound.sip_trunk_id}")

    # 2. Create OutboundTrunk
    print("Creating OutboundTrunk...")
    outbound = await lkapi.sip.create_sip_outbound_trunk(
        api.CreateSIPOutboundTrunkRequest(
            trunk=api.SIPOutboundTrunkInfo(
                name="Twilio Outbound",
                address=SIP_TRUNK_DOMAIN,
                numbers=PHONE_NUMBERS,
                auth_username=SIP_AUTH_USER,
                auth_password=SIP_AUTH_PASS,
            )
        )
    )
    print(f"  ✅ OutboundTrunk: {outbound.sip_trunk_id}")

    # 3. Create Dispatch Rule (routes inbound calls → voice-agent)
    print("Creating SIP Dispatch Rule...")
    dispatch = await lkapi.sip.create_sip_dispatch_rule(
        api.CreateSIPDispatchRuleRequest(
            rule=api.SIPDispatchRule(
                dispatch_rule_individual=api.SIPDispatchRuleIndividual(
                    room_prefix="call-",
                ),
            ),
            room_config=api.RoomConfiguration(
                agents=[api.RoomAgentDispatch(agent_name="voice-agent")]
            ),
            name="AI Agent Dispatch",
        )
    )
    print(f"  ✅ DispatchRule: {dispatch.sip_dispatch_rule_id}")

    # 4. Save outbound trunk ID to .env hint
    print(f"\n📋 Add this to your .env:")
    print(f"LIVEKIT_SIP_OUTBOUND_TRUNK_ID={outbound.sip_trunk_id}")

    await lkapi.aclose()
    print("\n✅ SIP setup complete!")


if __name__ == "__main__":
    asyncio.run(main())
