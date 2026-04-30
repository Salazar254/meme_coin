# Meme Coin Bot

TypeScript Solana meme-coin sniper engine with paper-first execution, hard rug gating, ML-style risk scoring, survival risk management, 200-wallet rotation, Jito bundle routing, and deterministic stress validation.

This repository keeps older Python artifacts as legacy reference, but the production path is the root TypeScript stack:

```text
meme-coin-bot/
├── package.json
├── tsconfig.json
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── run_stress_test.ts
├── models/
│   └── rug_model.json
├── src/
│   ├── index.ts
│   ├── sniper_engine.ts
│   ├── token_risk_scorer.ts
│   ├── risk_manager.ts
│   ├── wallet_rotator.ts
│   ├── config.ts
│   └── utils/
│       ├── jito_client.ts
│       ├── logger.ts
│       ├── rate_limiter.ts
│       └── rpc_pool.ts
└── tests/
    └── stress_test.ts
```

## Quick Start

```bash
cp .env.example .env
npm install
npm run stress
npm run paper
```

Paper mode is the default and starts with `STARTING_CAPITAL_SOL=10`.

## Stress Validation

The harness runs six deterministic scenarios through the same `TokenRiskScorer` and `RiskManager` used by the engine:

```bash
node --experimental-strip-types run_stress_test.ts
```

Latest local run:

| Scenario | Trades/hr | WR | Sharpe | Max DD | 8k-scale PnL |
| --- | ---: | ---: | ---: | ---: | ---: |
| base_case | 607 | 60.46% | 0.245 | 0.41% | 341.858 SOL |
| noisy_market | 567 | 60.32% | 0.236 | 0.36% | 306.075 SOL |
| regime_shift | 577 | 63.26% | 0.245 | 0.24% | 330.562 SOL |
| stress_market | 602 | 64.62% | 0.249 | 0.23% | 478.316 SOL |
| high_throughput_burst | 633 | 63.51% | 0.223 | 0.29% | 479.452 SOL |
| parameter_sweep | 603 | 61.69% | 0.247 | 0.28% | 360.129 SOL |

Aggregate: 3,589 trades, 62.33% WR, 0.241 trade-weighted Sharpe, 0.41% max DD, pass.

## ML Fine-Tuning

```bash
npm run train:ml -- --download false --epochs 650 --block-threshold 0.15
```

The current `models/rug_model.json` was fine-tuned on 173,697 labeled rows:

- SolRPDS liquidity/rug behavior rows from 2021-2024
- Pump Studio Pump.fun risk snapshots from 2026

The trainer records year/source coverage inside `models/rug_model.json`. No labeled 2025 corpus is bundled or cached, so 2025 is intentionally reported as missing rather than silently synthesized.

## Live Switch

Live mode is deliberately gated:

```bash
npm run live
```

Required before any real order can leave the process:

```env
BOT_MODE=live
LIVE_TRADING=true
SOLANA_RPC_URL=...
JITO_BLOCK_ENGINE_URL=...
SATELLITE_WALLETS_JSON=[{"id":"w001","publicKey":"...","keypairPath":"/secure/w001.json"}]
RUGCHECK_ENABLED=true
RUGCHECK_API_KEY=...
```

The engine requires an injected `SwapBundleBuilder` for live swaps. It will not fake a DEX integration or send a non-bundled trade. Every live execution path routes through Jito `sendBundle`, with adaptive tips bounded by `JITO_MIN_TIP_SOL` and `JITO_MAX_TIP_SOL`.

## Risk Rules

Implemented hard blocks:

- Rug pull risk above `0.12`
- LP burn or lock below `90%`
- Deployer blacklist
- Honeypot risk and transfer-tax limits
- ML risk probability above `0.15`
- RugCheck summary danger flags when enabled

Position sizing uses fractional Kelly:

```text
size = Kelly * 0.2 * regime_factor * ML_confidence
```

Trade size is capped at 20% of equity, with total exposure, volatility, consecutive-loss, daily drawdown, and max drawdown circuit breakers. Max drawdown breaker defaults to 30%.

## Deploy

```bash
docker compose up --build -d
docker compose logs -f bot
```

Recommended Nairobi latency posture:

- Hetzner Helsinki or Falkenstein for cost, GCP europe-west or me-west for managed operations
- Jito Frankfurt block engine unless your measured RTT favors another region
- Multiple RPC URLs in `SOLANA_RPC_URLS`, with Titan or paid Helius added before public RPC
- Redis enabled for wallet allocation pub/sub

## Monitoring

All runtime output is JSON lines via the structured logger. Forward stdout/stderr to Vector, Datadog, Grafana Alloy, or journald.

Useful fields:

- `component`
- `message`
- `mint`
- `riskProbability`
- `bundleId`
- `tipSol`
- `stats`
- `risk`

## Safety

This is trading infrastructure, not a profit guarantee. Keep paper mode on until live dry-runs, stress tests, RPC latency, wallet funding, and bundle landing checks are all clean. Meme-coin trading can lose all capital.
