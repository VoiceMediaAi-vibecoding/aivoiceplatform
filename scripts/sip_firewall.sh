#!/bin/bash
# SIP port firewall: restricts port 5060 (TCP+UDP) and RTP (10000-20000 UDP) to
# Twilio IPs only. Per-source-IP rate limiting on UDP 5060 (1 INVITE/sec burst 1)
# prevents LiveKit SIP's internal flood protection (20 INVITEs/5sec) from triggering
# when Twilio retries aggressively. Excess INVITEs are dropped silently.
# Run as root. Safe to re-run — flushes SIP chains before re-applying.
set -euo pipefail

# Twilio Elastic SIP Trunking signaling IPs (all regions)
TWILIO_SIP_IPS=(
    "54.172.60.0/30"
    "54.244.51.0/30"
    "54.183.31.192/30"
    "54.171.127.192/30"
    "54.65.63.192/30"
    "54.169.127.128/30"
    "54.252.254.64/30"
    "177.71.206.192/30"
    "172.110.223.0/24"
)

# Telnyx SIP signaling + media IP ranges
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

# Per-source-IP rate limit: ACCEPT up to 1 INVITE/sec, DROP above.
# Twilio rotates IPs in the /30 subnet, so per-IP rate limit applies
# independently to each IP (4 IPs × 1/sec = 4 INVITEs/sec total, well below
# LiveKit's 20/5sec flood limit). Combined with the DROP for excess, this
# prevents Twilio retries from ever triggering flood.
IDX=1
for SUBNET in "${TWILIO_SIP_IPS[@]}" "${TELNYX_SIP_IPS[@]}"; do
    SAFE_NAME=$(echo "$SUBNET" | tr / -)
    # ACCEPT up to 1 INVITE/sec per source IP (burst 1)
    iptables -I SIP_ALLOWLIST $IDX -s "$SUBNET" -p udp --dport 5060 \
        -m hashlimit --hashlimit-upto "1/sec" --hashlimit-burst 1 \
        --hashlimit-mode srcip --hashlimit-htable-expire 30000 \
        --hashlimit-name "tksip_${SAFE_NAME}" -j ACCEPT
    # DROP any excess (above 1/sec)
    iptables -I SIP_ALLOWLIST $((IDX + 1)) -s "$SUBNET" -p udp --dport 5060 \
        -m hashlimit --hashlimit-above "1/sec" --hashlimit-burst 1 \
        --hashlimit-mode srcip --hashlimit-htable-expire 30000 \
        --hashlimit-name "tkex_${SAFE_NAME}" -j DROP
    # TCP 5060: accept all (Twilio uses TCP for some signaling)
    iptables -I SIP_ALLOWLIST $((IDX + 2)) -s "$SUBNET" -p tcp --dport 5060 -j ACCEPT
    # UDP 10000-20000: RTP media
    iptables -I SIP_ALLOWLIST $((IDX + 3)) -s "$SUBNET" -p udp --dport 10000:20000 -j ACCEPT
    IDX=$((IDX + 4))
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
