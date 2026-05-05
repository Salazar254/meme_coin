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
python -m pip install -r ml/requirements.txt
npm run train:ml -- --data-dir data/training --epochs 60
```

The new production trainer is `ml/train_rug_model.py`. It trains a PyTorch multi-task network and exports `models/rug_model.onnx` with opset 15:

- Tabular residual MLP over 14 non-leaky raw risk features
- 32-d deployer embedding and 24-hour GRU sequence embedding
- Heads for rug probability, time-to-rug hours, max drawdown, and 2x pump probability
- Temporal split: train before 2024-10-01, validation through 2024-12-31, test from 2025-01-01 onward
- 2% label-noise injection, weight decay, dropout, early stopping, 5-fold time-series CV, and permutation importance leakage flags

The direct `rugcheckScore` feature is intentionally excluded. The model uses raw RugCheck-style signals such as LP unlocked share and danger-signal counts instead. Training writes `models/rug_model_meta.json` with split metrics, feature importance, CV results, and leakage warnings. A realistic validation/test AUC should live around 0.75-0.85; perfect AUC should be treated as a leakage alarm.

## Honest Backtest

```bash
npm run backtest
npm run stress
```

`backtest/engine.ts` replaces the old clairvoyant stress loop. Launch events are decision-time state only; `futureReturnPct` and similar fields are rejected by `assertNoFutureLeakage`. Outcomes come from time-ordered OHLCV bars, constant-product AMM impact, Jito tip-floor simulation, and a real position lifecycle:

- Entry records price, pool depth, tip, and cluster.
- Holds are evaluated on hourly bars.
- Exits trigger on dynamic stop, take profit, time-to-rug prediction, or 24-hour max hold.
- Monte Carlo trade-order shuffles run 100 times per scenario to expose sequence luck.

Paper and live execution are meant to share the same position and exit decision path; only the execution backend should differ.

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
