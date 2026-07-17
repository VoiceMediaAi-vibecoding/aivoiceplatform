"""
add_sip_number.py — Add a phone number to a LiveKit voice agent with full automation.

What it does (idempotent — safe to re-run):
  1. Verifies the agent exists in Supabase
  2. Checks if the number is already in an inbound trunk
  3. Creates a SIP inbound trunk if missing
  4. Checks if a dispatch rule exists for that trunk
  5. Creates a dispatch rule with metadata={agent_id: ...} if missing
  6. Reports what was created vs skipped

Usage:
  uv run --with livekit-api --with supabase --with python-dotenv \
    python scripts/add_sip_number.py --agent <AGENT_UUID> --number +16089461249

  # Optional trunk display name
  ... --name "Camila - NJ office"
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os

from livekit import api
from dotenv import load_dotenv


async def add_number(agent_id: str, number: str, trunk_name: str | None = None) -> None:
    load_dotenv()

    lkapi = api.LiveKitAPI(
        url=os.getenv("LIVEKIT_URL", "http://localhost:7880"),
        api_key=os.getenv("LIVEKIT_API_KEY"),
        api_secret=os.getenv("LIVEKIT_API_SECRET"),
    )

    # 1. Verify the agent exists (FK-style guard — fail loud if the UUID is wrong)
    from supabase import create_client
    db = create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_SERVICE_ROLE_KEY"))
    agent = db.table("agents").select("id, name").eq("id", agent_id).single().execute()
    if not agent.data:
        print(f"❌ agent {agent_id} not found in Supabase")
        return
    print(f"✅ agent: {agent.data['name']} ({agent_id})")

    # 2. Look for the number in any existing inbound trunk (idempotent)
    existing = lkapi.sip.list_sip_inbound_trunk(api.ListSIPInboundTrunkRequest())
    trunk_id = None
    for t in existing.items:
        if number in (t.numbers or []):
            print(f"  ↪ number already in trunk {t.sip_trunk_id} ({t.name})")
            trunk_id = t.sip_trunk_id
            break

    if not trunk_id:
        trunk = await lkapi.sip.create_sip_inbound_trunk(api.CreateSIPInboundTrunkRequest(
            trunk=api.SIPInboundTrunkInfo(
                name=trunk_name or f"Trunk for {agent.data['name']} - {number}",
                numbers=[number],
            ),
        ))
        trunk_id = trunk.sip_trunk_id
        print(f"✅ inbound trunk created: {trunk_id} ({trunk.name})")

    # 3. Check if a dispatch rule already attaches to this trunk
    rules = lkapi.sip.list_sip_dispatch_rule(api.ListSIPDispatchRuleRequest())
    for r in rules.items:
        if r.trunk_ids and trunk_id in r.trunk_ids:
            print(f"  ↪ dispatch rule {r.sip_dispatch_rule_id} already attached")
            print(f"\n🎉 ready — call {number} to reach {agent.data['name']}")
            await lkapi.aclose()
            return

    # 4. Create the dispatch rule, with metadata pointing to this agent's persona
    rule = await lkapi.sip.create_sip_dispatch_rule(api.CreateSIPDispatchRuleRequest(
        rule=api.SIPDispatchRule(
            dispatch_rule_individual=api.SIPDispatchRuleIndividual(room_prefix="call-"),
            trunk_ids=[trunk_id],
        ),
        room_config=api.RoomConfiguration(
            agents=[api.RoomAgentDispatch(
                agent_name="voice-agent",
                metadata=json.dumps({"agent_id": agent_id}),
            )],
        ),
        name=f"Dispatch {agent.data['name']} - {number}",
    ))
    print(f"✅ dispatch rule created: {rule.sip_dispatch_rule_id}")
    print(f"\n🎉 ready — call {number} to reach {agent.data['name']}")

    await lkapi.aclose()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Add a phone number to a LiveKit voice agent (idempotent).",
    )
    parser.add_argument("--agent", required=True, help="Agent UUID from the agents table")
    parser.add_argument("--number", required=True, help="Phone number in E.164 format (e.g. +16089461249)")
    parser.add_argument("--name", help="Optional display name for the inbound trunk")
    args = parser.parse_args()

    asyncio.run(add_number(args.agent, args.number, args.name))


if __name__ == "__main__":
    main()
