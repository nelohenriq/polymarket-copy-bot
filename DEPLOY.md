# GCP VM Deployment Guide

Deploy the Polymarket copy-trading bot to a Google Cloud Platform VM instance. The bot runs headless (no display needed) as a Docker container with automatic restarts.

## Prerequisites

1. **GCP Account** with billing enabled → [console.cloud.google.com](https://console.cloud.google.com)
2. **gcloud CLI** installed → [Install guide](https://cloud.google.com/sdk/docs/install)
3. **Docker** (for local testing) → [docker.com](https://www.docker.com/)

## Quick Start (Automated)

```bash
# 1. Configure your bot
cp .env.example .env
# Edit .env with your PRIVATE_KEY, API keys, etc.

# 2. Set your GCP project
export GCP_PROJECT_ID="your-project-id"

# 3. Deploy
chmod +x deploy-gcp.sh
./deploy-gcp.sh
```

The script creates a `e2-micro` VM (~$5/month) in `europe-west1` (Belgium), installs Docker, uploads your bot, builds the image, and starts it.

## Manual Step-by-Step

### 1. Create a GCP VM

```bash
# Set project
gcloud config set project YOUR_PROJECT_ID

# Create VM (e2-micro = ~$5/month, sufficient for this bot)
gcloud compute instances create polymarket-bot \
  --zone=europe-west1-b \
  --machine-type=e2-micro \
  --image-family=ubuntu-2204-lts \
  --image-project=ubuntu-os-cloud \
  --boot-disk-size=10GB \
  --tags=polymarket-bot

# SSH into the VM
gcloud compute ssh polymarket-bot --zone=europe-west1-b
```

### 2. Install Docker on the VM

```bash
# Install Docker
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-plugin
sudo systemctl enable docker
sudo systemctl start docker

# Add yourself to docker group (no sudo needed for docker commands)
sudo usermod -aG docker $USER
newgrp docker
```

### 3. Upload Bot Files

From your local machine (in the `polymarket-copy-bot` directory):

```bash
# Create directory on VM
gcloud compute ssh polymarket-bot --zone=europe-west1-b --command="mkdir -p ~/polymarket-bot"

# Copy files
gcloud compute scp --zone=europe-west1-b --recurse \
  src/ package.json package-lock.json tsconfig.json \
  Dockerfile docker-compose.yml .env \
  polymarket-bot:~/polymarket-bot/
```

### 4. Build and Run

On the VM:

```bash
cd ~/polymarket-bot
docker compose build
docker compose up -d

# Check logs
docker compose logs -f
```

### 5. Verify It's Working

```bash
# Watch the logs (Ctrl+C to exit)
docker compose logs -f

# You should see:
#   🤖 Polymarket Copy-Trading Bot v1.0
#   📋 Configuration: ...
#   ✅ CLOB client ready
#   ✅ Bot is running! Monitoring target wallets...
```

## Managing the Bot

| Command | Description |
|---------|-------------|
| `docker compose logs -f` | Follow live logs |
| `docker compose logs --tail=100` | Last 100 lines |
| `docker compose restart` | Restart the bot |
| `docker compose down` | Stop the bot |
| `docker compose up -d` | Start the bot |
| `docker compose ps` | Check container status |

## Updating the Bot

When you make code changes, redeploy:

```bash
# From your local machine
./deploy-gcp.sh
```

Or manually:

```bash
# Upload new source files
gcloud compute scp --zone=europe-west1-b --recurse src/ polymarket-bot:~/polymarket-bot/

# Rebuild and restart on VM
gcloud compute ssh polymarket-bot --zone=europe-west1-b --command="
  cd ~/polymarket-bot && docker compose build && docker compose up -d
"
```

## Updating .env Configuration

```bash
# Upload new .env
gcloud compute scp --zone=europe-west1-b .env polymarket-bot:~/polymarket-bot/.env

# Restart to pick up changes
gcloud compute ssh polymarket-bot --zone=europe-west1-b --command="
  cd ~/polymarket-bot && docker compose restart
"
```

## Cost Estimate

| VM Type | vCPUs | RAM | Monthly Cost | Notes |
|---------|-------|-----|-------------|-------|
| `e2-micro` | 0.25 | 1 GB | ~$5 | Sufficient for this bot |
| `e2-small` | 0.5 | 2 GB | ~$10 | If you need more headroom |
| `e2-medium` | 1 | 4 GB | ~$20 | Overkill for this bot |

**Tip:** Use `europe-west1` (Belgium) for lowest latency to Polymarket's EU servers and to avoid Portugal's ISP filtering.

**Free tier:** GCP offers a free `e2-micro` VM in `us-central1`, `us-west1`, or `us-east1` (1 instance/month). However, these US regions may have higher latency to Polymarket.

## Alternative: Run Without Docker

If you prefer running directly on the VM without Docker:

```bash
# SSH into VM
gcloud compute ssh polymarket-bot --zone=europe-west1-b

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs

# Clone/upload bot files
mkdir -p ~/polymarket-bot
# ... upload files ...

# Install and build
cd ~/polymarket-bot
npm ci
npm run build

# Create systemd service
sudo tee /etc/systemd/system/polymarket-bot.service << 'EOF'
[Unit]
Description=Polymarket Copy-Trading Bot
After=network.target

[Service]
Type=simple
User=YOUR_USERNAME
WorkingDirectory=/home/YOUR_USERNAME/polymarket-bot
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable polymarket-bot
sudo systemctl start polymarket-bot

# Check status
sudo systemctl status polymarket-bot
journalctl -u polymarket-bot -f
```

## Monitoring

### View logs remotely (from local machine)

```bash
gcloud compute ssh polymarket-bot --zone=europe-west1-b --command="cd ~/polymarket-bot && docker compose logs -f"
```

### Set up log-based alerts (optional)

In GCP Console → Logging → Create alert:
- Resource: GCE VM Instance
- Filter: `resource.type="gce_instance" AND textPayload:"Fatal error"`
- Notification: Email / Slack

### Auto-restart on crash

Docker's `restart: unless-stopped` policy handles this automatically. The bot also handles `SIGTERM` gracefully (prints final report before exiting).

## Security Notes

- **Never commit `.env` to git** — it contains your private key
- The Docker container runs as a non-root user
- Consider using [GCP Secret Manager](https://cloud.google.com/secret-manager) for production secrets
- Restrict VM firewall to only allow SSH (port 22) from your IP
