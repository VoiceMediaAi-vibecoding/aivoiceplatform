#!/bin/bash
# Run this on the AWS server (44.247.225.191) as ubuntu user
# Usage: bash deploy_server.sh

set -e

echo "=== LiveKit Platform Deploy ==="

# 1. Install Docker if not present
if ! command -v docker &> /dev/null; then
  echo "Installing Docker..."
  curl -fsSL https://get.docker.com | bash
  sudo usermod -aG docker ubuntu
  echo "Docker installed. Re-login if needed."
fi

# 2. Install uv (Python package manager)
if ! command -v uv &> /dev/null; then
  echo "Installing uv..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi

# 3. Clone or pull repo
if [ -d "$HOME/LiveKit" ]; then
  echo "Updating existing repo..."
  cd "$HOME/LiveKit" && git pull
else
  echo "Cloning repo..."
  # Change this URL to your actual repo
  git clone https://github.com/YOUR_USER/LiveKit.git "$HOME/LiveKit"
fi

cd "$HOME/LiveKit"

# 4. Copy .env (you must do this manually first time)
if [ ! -f .env ]; then
  echo "ERROR: .env not found. Copy it to $HOME/LiveKit/.env first."
  exit 1
fi

# 5. Open required ports (if ufw is active)
if command -v ufw &> /dev/null && sudo ufw status | grep -q "active"; then
  sudo ufw allow 7880/tcp   # LiveKit WebSocket
  sudo ufw allow 5060/tcp   # SIP signaling
  sudo ufw allow 10000:20000/udp  # RTP media
  sudo ufw allow 8000/tcp   # API
  sudo ufw allow 3000/tcp   # Dashboard
  echo "Firewall ports opened."
fi

# 6. Start all services
echo "Starting Docker services..."
docker compose pull
docker compose up -d

echo "Waiting for services to start..."
sleep 5
docker compose ps

# S4.6 — apply the SIP firewall whitelist (Twilio IPs only). The script is
# idempotent; running it on every deploy keeps the iptables rules in sync
# with the current Twilio IP allowlist. Without this, port 5060 is open to
# the world, which is how SIP scanners find and attack the trunk.
if [ -x "$HOME/LiveKit/scripts/sip_firewall.sh" ]; then
  echo ""
  echo "=== Applying SIP firewall whitelist (Twilio IPs) ==="
  bash "$HOME/LiveKit/scripts/sip_firewall.sh" || \
    echo "WARNING: sip_firewall.sh failed — port 5060 may be open to the world"
else
  echo "WARNING: scripts/sip_firewall.sh not found or not executable."
fi

# 7. Run SIP trunk setup
echo ""
echo "=== Setting up SIP trunks ==="
cd services/agent
export PATH="$HOME/.local/bin:$PATH"
uv run python ../scripts/setup_sip_trunks.py

echo ""
echo "=== Deploy complete! ==="
echo "Dashboard: http://44.247.225.191:3000"
echo "API:       http://44.247.225.191:8000"
