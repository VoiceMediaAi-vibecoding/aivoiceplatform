#!/bin/bash
# SIP port firewall: restricts port 5060 (TCP+UDP) and RTP (10000-20000 UDP) to
# Twilio + Telnyx SIP IPs only. Anything else gets dropped silently.
#
# Run as root. Safe to re-run — flushes SIP chains before re-applying.
#
# IMPORTANT — keep this in sync with the LiveKit SIP server's internal flood
# protection. LiveKit SIP rejects calls with 486 BUSY when it sees more than
# ~20 INVITEs/5sec TOTAL across all sources. Two things affect that counter:
#   1. Legitimate Twilio retries (when a call fails, Twilio sends 2-4 INVITEs
#      in quick succession).
#   2. Scanner abuse from random IPs trying to INVITE garbage users
#      (8888888, 1111111, etc.).
# We block (2) at iptables so it never reaches LiveKit. We do NOT add a
# per-source rate limit on Twilio's own IPs — Twilio's retry pattern is
# bursty (multiple INVITEs within a second on failed calls) and a per-IP
# hashlimit of even 5/sec would drop legitimate Twilio retries and
# trigger LiveKit's flood protection anyway.
#
# KNOWN FOOTGUN (fixed 2026-07): 172.110.223.0/24 was previously listed as
# "Twilio" but is NOT a Twilio range — SIP scanners/abusers use it to flood
# port 5060 with junk INVITEs. With it in the allowlist, the scanners reach
# LiveKit SIP and trigger its internal flood protection, which then ALSO
# rejects legitimate Twilio calls with 486 BUSY. Removed.
set -euo pipefail

# Twilio Elastic SIP Trunking signaling IPs (all regions).
TWILIO_SIP_IPS=(
    "54.172.60.0/30"
    "54.244.51.0/30"
    "54.183.31.192/30"
    "54.171.127.192/30"
    "54.65.63.192/30"
    "54.169.127.128/30"
    "54.252.254.64/30"
    "177.71.206.192/30"
)

# Telnyx SIP signaling + media IP ranges (in case you switch carriers).
TELNYX_SIP_IPS=(
    "192.76.120.0/23"
    "185.246.40.0/24"
    "185.246.41.0/24"
    "185.246.42.0/24"
    "185.246.43.0/24"
    "64.16.250.0/24"
    "64.16.249.0/24"
)

echo "[sip_firewall] Applying SIP allowlist rules..."

# Remove old jumps and chain
for target in udp tcp; do
    for port in 5060 10000:20000; do
        iptables -D INPUT -p "$target" --dport "$port" -j SIP_ALLOWLIST 2>/dev/null || true
    done
done
iptables -F SIP_ALLOWLIST 2>/dev/null || true
iptables -X SIP_ALLOWLIST 2>/dev/null || true

# Create dedicated chain
iptables -N SIP_ALLOWLIST 2>/dev/null || iptables -F SIP_ALLOWLIST

# ACCEPT TCP 5060 (signaling) from each carrier subnet
for SUBNET in "${TWILIO_SIP_IPS[@]}" "${TELNYX_SIP_IPS[@]}"; do
    iptables -A SIP_ALLOWLIST -s "$SUBNET" -p tcp --dport 5060 -j ACCEPT
done

# ACCEPT UDP 5060 (signaling) — no per-source rate limit, see header comment
for SUBNET in "${TWILIO_SIP_IPS[@]}" "${TELNYX_SIP_IPS[@]}"; do
    iptables -A SIP_ALLOWLIST -s "$SUBNET" -p udp --dport 5060 -j ACCEPT
done

# ACCEPT UDP 10000-20000 (RTP media)
for SUBNET in "${TWILIO_SIP_IPS[@]}" "${TELNYX_SIP_IPS[@]}"; do
    iptables -A SIP_ALLOWLIST -s "$SUBNET" -p udp --dport 10000:20000 -j ACCEPT
done

# Drop everything else (silent drop)
iptables -A SIP_ALLOWLIST -p udp --dport 5060 -j DROP
iptables -A SIP_ALLOWLIST -p tcp --dport 5060 -j DROP

# Re-add jumps
iptables -I INPUT 1 -p udp --dport 5060 -j SIP_ALLOWLIST
iptables -I INPUT 2 -p tcp --dport 5060 -j SIP_ALLOWLIST
iptables -I INPUT 3 -p udp --dport 10000:20000 -j SIP_ALLOWLIST

echo "[sip_firewall] Rules applied."
echo ""
echo "[sip_firewall] Verify the rules:"
iptables -L SIP_ALLOWLIST -n | head -10

# Persist rules
if command -v netfilter-persistent &>/dev/null; then
    netfilter-persistent save
    echo "[sip_firewall] Rules persisted via netfilter-persistent"
elif command -v iptables-save &>/dev/null; then
    iptables-save > /etc/iptables/rules.v4 2>/dev/null || echo "[sip_firewall] WARN: cannot persist rules"
fi
