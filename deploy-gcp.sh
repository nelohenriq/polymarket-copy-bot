#!/bin/bash
# ──────────────────────────────────────────────
# GCP VM Deployment Script
# Deploys the Polymarket copy-trading bot to a GCP Compute Engine VM
#
# Prerequisites:
#   1. gcloud CLI installed and authenticated (gcloud auth login)
#   2. A GCP project with billing enabled
#   3. A .env file with your bot configuration
#
# Usage:
#   chmod +x deploy-gcp.sh
#   ./deploy-gcp.sh
#
# First run will create the VM. Subsequent runs will update the bot.
# ──────────────────────────────────────────────

set -euo pipefail

# ── Configuration (edit these) ──
PROJECT_ID="${GCP_PROJECT_ID:-your-gcp-project-id}"
VM_NAME="${VM_NAME:-polymarket-bot}"
ZONE="${GCP_ZONE:-europe-west1-b}"  # europe-west1 is in Belgium, close to Portugal
MACHINE_TYPE="${MACHINE_TYPE:-e2-micro}"  # $5/month — sufficient for this bot
IMAGE_FAMILY="${IMAGE_FAMILY:-ubuntu-2204-lts}"
IMAGE_PROJECT="${IMAGE_PROJECT:-ubuntu-os-cloud}"

echo "╔══════════════════════════════════════════════════╗"
echo "║   🚀 Polymarket Bot — GCP Deployment             ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo "  Project:  ${PROJECT_ID}"
echo "  VM:       ${VM_NAME}"
echo "  Zone:     ${ZONE}"
echo "  Machine:  ${MACHINE_TYPE}"
echo ""

# ── Check prerequisites ──
if ! command -v gcloud &> /dev/null; then
  echo "❌ gcloud CLI not found. Install it from https://cloud.google.com/sdk/docs/install"
  exit 1
fi

if [ ! -f .env ]; then
  echo "❌ .env file not found. Copy .env.example to .env and configure it first."
  exit 1
fi

# ── Set project ──
echo "── Setting GCP project..."
gcloud config set project "${PROJECT_ID}"

# ── Create VM if it doesn't exist ──
if ! gcloud compute instances describe "${VM_NAME}" --zone="${ZONE}" &> /dev/null; then
  echo "── Creating new VM instance..."
  gcloud compute instances create "${VM_NAME}" \
    --zone="${ZONE}" \
    --machine-type="${MACHINE_TYPE}" \
    --image-family="${IMAGE_FAMILY}" \
    --image-project="${IMAGE_PROJECT}" \
    --boot-disk-size=10GB \
    --boot-disk-type=pd-standard \
    --metadata=startup-script='#!/bin/bash
# Install Docker
apt-get update -qq
apt-get install -y -qq docker.io docker-compose-plugin
systemctl enable docker
systemctl start docker
# Install Node.js 22 (for direct runs without Docker)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y -qq nodejs
' \
    --tags=polymarket-bot \
    --scopes=default

  echo "✅ VM created. Waiting for startup script to finish..."
  echo "   (This takes ~2 minutes for Docker + Node.js installation)"
  sleep 120
else
  echo "── VM ${VM_NAME} already exists."
fi

# ── Open dashboard port (3456) in firewall ──
if ! gcloud compute firewall-rules describe allow-dashboard &> /dev/null; then
  echo "── Opening dashboard port (3456) in firewall..."
  gcloud compute firewall-rules create allow-dashboard \
    --allow=tcp:3456 \
    --target-tags=polymarket-bot \
    --description="Polymarket bot dashboard"
else
  echo "── Dashboard firewall rule already exists."
fi

# ── Get VM external IP ──
VM_IP=$(gcloud compute instances describe "${VM_NAME}" --zone="${ZONE}" --format='get(networkInterfaces[0].accessConfigs[0].natIP)')
echo "  VM IP: ${VM_IP}"

# ── Copy files to VM ──
echo "── Uploading bot files to VM..."
# Create directory first, then copy (avoids suppressing real errors)
gcloud compute ssh "${VM_NAME}" --zone="${ZONE}" --command="mkdir -p ~/polymarket-bot"
gcloud compute scp --zone="${ZONE}" --recurse \
  src/ package.json package-lock.json tsconfig.json Dockerfile docker-compose.yml dashboard.html .env.example .env \
  "${VM_NAME}":~/polymarket-bot/

# ── Build and start the bot ──
echo "── Building and starting the bot on VM..."
gcloud compute ssh "${VM_NAME}" --zone="${ZONE}" --command="
  cd ~/polymarket-bot && \
  echo 'Building Docker image...' && \
  sudo docker compose build && \
  echo 'Starting bot...' && \
  sudo docker compose up -d && \
  echo 'Bot started! Checking logs...' && \
  sleep 5 && \
  sudo docker compose logs --tail=30
"

echo ""
echo "═══════════════════════════════════════════════════"
echo "✅ Deployment complete!"
echo ""
echo "  View logs:    gcloud compute ssh ${VM_NAME} --zone=${ZONE} --command='cd ~/polymarket-bot && sudo docker compose logs -f'"
echo "  Stop bot:     gcloud compute ssh ${VM_NAME} --zone=${ZONE} --command='cd ~/polymarket-bot && sudo docker compose down'"
echo "  Restart bot:  gcloud compute ssh ${VM_NAME} --zone=${ZONE} --command='cd ~/polymarket-bot && sudo docker compose restart'"
echo "  SSH into VM:  gcloud compute ssh ${VM_NAME} --zone=${ZONE}"
echo "  Delete VM:    gcloud compute instances delete ${VM_NAME} --zone=${ZONE}"
echo ""  echo "  Dashboard:    http://${VM_IP}:3456"
  echo "  Monthly cost: ~\$5/month (e2-micro in europe-west1)"
echo "═══════════════════════════════════════════════════"
