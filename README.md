# 🤖 Polymarket Copy-Trading Bot

Automated copy-trading bot for [Polymarket](https://polymarket.com) — monitors top-performing wallets and mirrors their trades with AI-powered filtering and multi-layer risk management.

## Features

- **🔍 Auto-Discovery** — Automatically finds top traders via the Polymarket leaderboard API (no manual wallet configuration needed)
- **🤖 AI Trade Filter** — Uses GPT-4, Claude, or any OpenAI-compatible LLM to estimate true probability before copying trades
- **📊 Ensemble Consensus** — Optionally run two LLMs and combine estimates via confidence-weighted averaging
- **🛡️ Risk Management** — 4-layer protection: session caps, per-market limits, daily loss, drawdown halt
- **📝 Paper Trading** — Simulated execution with virtual money for backtesting and live dry-run
- **📈 Performance Metrics** — Sharpe ratio, max drawdown, win rate, Calmar ratio, portfolio snapshots
- **📓 Trade Journal** — Full trade recording with CSV/JSON export
- **🔄 Proxy Support** — Route traffic through SOCKS5/HTTP proxy to bypass ISP filtering (e.g. Portugal, France)
- **🚀 GCP Deployment** — One-command deployment to Google Cloud VM with Docker
- **⚡ WebSocket + REST** — Real-time WebSocket updates with REST polling fallback

## How It Works

```
┌──────────────────┐     ┌───────────────┐     ┌──────────────┐
│  Leaderboard API  │────▶│  Auto-Discover │────▶│  Target List  │
│  /leaderboard     │     │  Top Traders   │     │  (wallets)    │
└──────────────────┘     └───────────────┘     └──────┬────────┘
                                                       │
┌──────────────────┐     ┌───────────────┐     ┌──────▼────────┐
│  Polymarket       │────▶│  Trade Monitor │────▶│   AI Filter   │
│  Data API         │     │  (poll + WS)   │     │  (LLM eval)   │
│  /activity        │     └───────────────┘     └──────┬────────┘
└──────────────────┘                                    │ approved?
                                                        ▼
┌──────────────────┐     ┌───────────────┐     ┌──────────────┐
│  Your Wallet      │◀───│  CLOB Client   │◀───│  Risk Manager │
│  (Polygon)        │     │  (EIP-712)     │     │  (4-layer)    │
└──────────────────┘     └───────────────┘     └──────────────┘
```

## Quick Start

### Prerequisites

- **Node.js** ≥ 18 ([download](https://nodejs.org))
- **Polygon wallet** with USDC.e (for trading) and POL (for gas, ~$1-5)
- **Polygon RPC endpoint** (QuickNode, Alchemy, or Chainstack)
- **(Optional)** LLM API key for AI filtering (OpenAI, Anthropic, OpenRouter, or custom)

### Installation

```bash
git clone https://github.com/YOUR_USERNAME/polymarket-copy-bot.git
cd polymarket-copy-bot
npm install
cp .env.example .env
```

### Configuration

Edit `.env` with your credentials:

```env
# Your wallet private key (from MetaMask export)
PRIVATE_KEY=0xYourPrivateKeyHere

# Polygon RPC (dedicated node recommended)
RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY

# Option A: Manual target wallets (find at polymarket.com/leaderboard)
TARGET_WALLETS=0xTopTrader1,0xTopTrader2

# Option B: Auto-discover top traders (recommended)
AUTO_DISCOVER_WALLETS=true
LEADERBOARD_TIME_PERIOD=WEEK
LEADERBOARD_MIN_PNL=500
LEADERBOARD_MIN_WIN_RATE=0.6
LEADERBOARD_MAX_WALLETS=5

# Position sizing (start conservative)
POSITION_MULTIPLIER=0.1
MAX_TRADE_SIZE=50
DRY_RUN=true
```

### (Optional) Enable AI Trade Filter

```env
AI_FILTER_ENABLED=true

# Built-in providers:
AI_FILTER_PROVIDER=openai       # openai | anthropic | openrouter | custom
AI_FILTER_API_KEY=sk-your-key
AI_FILTER_MODEL=gpt-4o

# Custom OpenAI-compatible provider (Ollama, LM Studio, vLLM, etc.):
# AI_FILTER_PROVIDER=custom
# AI_FILTER_BASE_URL=http://localhost:11434/v1
# AI_FILTER_MODEL=llama3

# Consensus: optional second model for ensemble
AI_FILTER_SECOND_MODEL=claude-sonnet-4-20250514

# Thresholds
AI_FILTER_MIN_CONFIDENCE=0.6
AI_FILTER_MIN_EDGE=0.05
AI_FILTER_FAIL_OPEN=true
```

### (Optional) Proxy for Blocked Regions

If Polymarket is blocked in your country (Portugal, France, etc.):

```env
PROXY_URL=socks5://127.0.0.1:1080
```

Supports SOCKS5, HTTP, and HTTPS proxies. See `DEPLOY.md` for deploying to a GCP VM instead.

### Running

```bash
# Development (hot reload)
npm run dev

# Production
npm run build
npm start
```

**⚠️ Always start with `DRY_RUN=true` to verify the bot works before using real money.**

## Architecture

| File | Purpose |
|------|---------|
| `src/index.ts` | Main orchestrator — wires everything together |
| `src/config.ts` | Environment variable loading & validation |
| `src/client.ts` | CLOB client init (EIP-712 auth, API key derivation) |
| `src/monitor.ts` | Trade discovery (Data API polling + WebSocket) |
| `src/ai-filter.ts` | AI-powered trade filtering with LLM ensemble |
| `src/leaderboard.ts` | Auto-discover top traders from leaderboard API |
| `src/risk.ts` | 4-layer risk management system |
| `src/executor.ts` | Order execution with retry logic |
| `src/paper-executor.ts` | Simulated paper trading engine |
| `src/historical-monitor.ts` | Historical trade replay for backtesting |
| `src/metrics.ts` | Performance analytics (Sharpe, drawdown, win rate) |
| `src/journal.ts` | Trade journal with CSV/JSON export |
| `src/positions.ts` | Position tracking & exposure calculation |
| `src/proxy.ts` | SOCKS5/HTTP proxy support |
| `src/logger.ts` | Configurable log levels |
| `src/types.ts` | TypeScript type definitions |
| `src/paper-executor.ts` | Simulated paper trading engine |

### Risk Management (4-Layer Protection)

| Layer | Default | Action |
|-------|---------|--------|
| **Session Cap** | $1,000 | Block trades |
| **Per-Market Cap** | $200 | Block trades |
| **Daily Loss** | 5% of capital | Pause trading |
| **Drawdown** | 25% from peak | Pause trading |
| **Total Loss** | 40% | **Permanent halt** |

### AI Trade Filter

The AI filter evaluates each trade signal before copying:

1. Fetches market context from Gamma API (question, prices, volume)
2. Sends structured prompt to LLM requesting probability estimate
3. (Optional) Runs second LLM for ensemble consensus
4. Calculates edge: `AI_probability - market_price`
5. Approves only if confidence ≥ threshold AND edge ≥ threshold
6. Caches results to avoid redundant API calls

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PRIVATE_KEY` | ✅ | — | EOA wallet private key |
| `TARGET_WALLETS` | * | — | Comma-separated addresses (or use auto-discovery) |
| `AUTO_DISCOVER_WALLETS` | — | `false` | Auto-discover top traders from leaderboard |
| `RPC_URL` | — | `https://polygon-rpc.com` | Polygon RPC endpoint |
| `POSITION_MULTIPLIER` | — | `0.1` | Size relative to target (0.1 = 10%) |
| `MAX_TRADE_SIZE` | — | `100` | Max single trade in USDC |
| `MIN_TRADE_SIZE` | — | `1` | Min trade size in USDC |
| `ORDER_TYPE` | — | `FOK` | Order type (FOK/GTC/FAK) |
| `SLIPPAGE_TOLERANCE` | — | `0.02` | Slippage tolerance (2%) |
| `MAX_SESSION_NOTIONAL` | — | `1000` | Max total session volume |
| `MAX_PER_MARKET_NOTIONAL` | — | `200` | Max exposure per market |
| `DAILY_LOSS_LIMIT` | — | `0.05` | Daily loss limit (5%) |
| `MAX_DRAWDOWN` | — | `0.25` | Max drawdown from peak (25%) |
| `TOTAL_LOSS_LIMIT` | — | `0.40` | Permanent halt threshold (40%) |
| `AI_FILTER_ENABLED` | — | `false` | Enable AI trade filtering |
| `AI_FILTER_PROVIDER` | — | `openai` | LLM provider (openai/anthropic/openrouter/custom) |
| `AI_FILTER_API_KEY` | — | — | LLM API key |
| `AI_FILTER_MODEL` | — | `gpt-4o` | Primary LLM model |
| `AI_FILTER_BASE_URL` | — | — | Custom provider URL (required when provider=custom) |
| `AI_FILTER_SECOND_MODEL` | — | — | Second model for ensemble consensus |
| `PROXY_URL` | — | — | SOCKS5/HTTP proxy for blocked regions |
| `LEADERBOARD_TIME_PERIOD` | — | `WEEK` | Time period (DAY/WEEK/MONTH/ALL) |
| `LEADERBOARD_MIN_PNL` | — | `500` | Minimum P&L to qualify as top trader |
| `LEADERBOARD_MIN_WIN_RATE` | — | `0.6` | Minimum win rate (0.6 = 60%) |
| `LEADERBOARD_MAX_WALLETS` | — | `5` | Max wallets to copy-trade |
| `DRY_RUN` | — | `true` | Simulation mode (no real orders) |
| `LOG_LEVEL` | — | `info` | Log level (debug/info/warn/error) |

See `.env.example` for the full list with documentation.

## Deployment

### GCP VM (Recommended)

```bash
# Set your GCP project
export GCP_PROJECT_ID="your-project-id"

# Deploy (creates VM, installs Docker, builds & starts bot)
chmod +x deploy-gcp.sh
./deploy-gcp.sh
```

Cost: ~$5/month on `e2-micro` in `europe-west1` (Belgium). See `DEPLOY.md` for full instructions.

### Docker (Any Cloud)

```bash
docker compose build
docker compose up -d
docker compose logs -f
```

## Recommended Testing Path

```
Day 1-2:  DRY_RUN=true,  CAPITAL=$50     → Verify bot logic works
Day 3-9:  DRY_RUN=false, CAPITAL=$50     → Live test with small capital
Day 10+:  DRY_RUN=false, CAPITAL=$250    → Scale up if profitable
```

## Disclaimer

⚠️ **This bot is for educational purposes. Trading prediction markets involves significant financial risk.**

- Past performance of target wallets does not guarantee future results
- Automated trading can amplify losses quickly
- Always start with dry-run mode and small capital
- Never invest more than you can afford to lose
- Ensure compliance with Polymarket's Terms of Service for your jurisdiction

## License

MIT
