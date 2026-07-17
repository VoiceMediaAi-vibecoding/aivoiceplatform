# Monitoring VM — AWS + GoDaddy setup

Same VPC, GoDaddy DNS, no vendors beyond AWS.

## 1. Provision the EC2 instance

- **AMI**: Ubuntu 24.04
- **Type**: t3.micro (or t4g.small for ARM — cheaper)
- **VPC**: same as your prod VM
- **Subnet**: can be public OR private (public is simpler)
- **Elastic IP**: allocate and attach. Note the public IP and the **private IP** (visible in the EC2 console under "Networking").
- **Security group** (create one called `monitoring-vm-sg`):
  - Inbound:
    - TCP 22 from your IP (SSH)
    - TCP 80 from 0.0.0.0/0 (Let's Encrypt HTTP challenge)
    - TCP 443 from 0.0.0.0/0 (Grafana)
    - TCP 9090 from `prod-vm-sg` security group (Prometheus, **private only**)
  - Outbound:
    - All traffic (default)

Then **edit the prod VM's security group** to allow TCP 9090 outbound to `monitoring-vm-sg`. Actually, outbound is allowed by default — only inbound matters for the monitoring Prometheus.

## 2. Install Docker

SSH to the new VM:
```bash
ssh ubuntu@<monitoring-public-ip>
curl -fsSL https://get.docker.com | bash
sudo usermod -aG docker $USER
# log out and back in
```

## 3. GoDaddy DNS

In GoDaddy → DNS management for `voicemedia.ai`:
- Add **A record**:
  - Name: `monitoring`
  - Value: `<monitoring-public-ip>` (the Elastic IP)
  - TTL: 600

Wait ~2 min for propagation. Verify:
```bash
dig monitoring.voicemedia.ai +short
# Should return your Elastic IP
```

## 4. Deploy the monitoring stack

From your Mac:
```bash
scp -r -i VM_Devs.pem LiveKit/monitoring/vm-monitor ubuntu@<monitoring-public-ip>:~/stack/

ssh -i VM_Devs.pem ubuntu@<monitoring-public-ip>
cd ~/stack

# Set the env vars
cp .env.example .env
nano .env   # set GF_ADMIN_PASSWORD (20+ chars from password manager)
chmod 600 .env

# Update Caddyfile with your real email for Let's Encrypt
sed -i '' 's|admin@example.com|your-real-email@voicemedia.ai|g' Caddyfile

# Bring up the stack
docker compose up -d
docker compose ps
```

After ~30s, Caddy will:
1. Get a Let's Encrypt cert via HTTP-01 challenge
2. Start serving https://monitoring.voicemedia.ai

Verify:
```bash
# From anywhere on the internet:
curl -I https://monitoring.voicemedia.ai/api/health
# → 200 OK
```

## 5. Wire the prod Prometheus

```bash
# From your Mac, sync the updated prometheus.yml:
scp -i VM_Devs.pem monitoring/prometheus.yml ubuntu@44.247.225.191:~/LiveKit/monitoring/

# On the prod VM, edit the URL to the monitoring VM's PRIVATE IP:
ssh -i VM_Devs.pem ubuntu@44.247.225.191
nano ~/LiveKit/monitoring/prometheus.yml
# Change the remote_write URL to:
#   url: http://10.0.0.<monitoring-private-ip>:9090/api/v1/write
# (Remove the Cloudflare headers block — no longer needed.)

cd ~/LiveKit
docker compose up -d prometheus
docker logs --tail 30 livekit-prometheus-1 | grep -i remote
```

Look for `remote_write: posting to http://10.0.0.X:9090/api/v1/write` with no error.

## 6. Verify

- Open https://monitoring.voicemedia.ai from your browser
- Login with `admin` / your `.env` password
- **Explore** → query `up` → should see `voicemedia-api` job from prod

## 7. (Optional) Provision alerts + dashboards

```bash
scp -r -i VM_Devs.pem monitoring/grafana/provisioning/alerting \
    ubuntu@<monitoring-public-ip>:~/stack/grafana/provisioning/
scp -i VM_Devs.pem monitoring/grafana/provisioning/dashboards/livekit-api.json \
    ubuntu@<monitoring-public-ip>:~/stack/grafana/dashboards/

ssh -i VM_Devs.pem ubuntu@<monitoring-public-ip> 'cd ~/stack && docker compose restart grafana'
```

## Security model — what you're trading off

| Surface | Exposure | Auth |
|---|---|---|
| Grafana (`https://monitoring.voicemedia.ai`) | Public internet | HTTPS + Grafana user system (+ optional basic_auth via Caddy) |
| Prometheus `:9090` | VPC private only | Security group restricts to prod VM |
| SSH `:22` | Public internet | Your SSH key (consider replacing with AWS SSM later) |

For Grafana, the default (HTTPS + Grafana auth) is fine for solo/small team. To tighten further:
1. Add basic_auth in Caddy (uncomment the block in Caddyfile, generate a hash with `caddy hash-password`)
2. Restrict port 443 to specific IPs in the security group (your home/office + VPN)
3. Set up Cloudflare in front of monitoring.voicemedia.ai later (gives you WAF + DDoS protection for free if you ever need it)

## Costs

| Item | Cost |
|------|------|
| EC2 t3.micro (or t4g.small ~30% cheaper) | ~$8/mo (or ~$5 with t4g) |
| Elastic IP (attached) | free |
| Data transfer (small, mostly Grafana dashboard reads) | <$1/mo |
| GoDaddy DNS (existing) | free |
| Let's Encrypt cert | free |
| **Total** | **~$5-8/mo** |

## What's next after this is live

- **Add Loki** to monitoring VM for centralized logs
- **Add Tempo** for distributed tracing
- **Migrate agent + sip healthchecks** so they're visible in this Grafana
- **Status page** (Instatus free tier, queryable from Grafana)
- **Move prod VM SSH behind AWS SSM** so you can remove the public SSH surface

## Why this beats Cloudflare/Tailscale for your case

- **Cloudflare**: best if you don't have a domain or want CDN/DDoS protection from day 1
- **Tailscale**: best if you don't want ANY public surface (but then nobody else can see Grafana)
- **AWS + GoDaddy (this)**: best if you already have AWS + a domain, want HTTPS, and want to use AWS-native networking for the prod→monitoring hop
