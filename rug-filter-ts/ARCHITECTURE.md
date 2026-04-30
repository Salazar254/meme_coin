# Architecture Summary

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     RUG FILTER ML ORCHESTRATOR                              │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                        SIGNAL EXTRACTION LAYER                         │ │
│  │                                                                        │ │
│  │  GoPlus(300ms) │ Honeypot(300ms) │ Helius(300ms) │ Unicrypt(300ms)  │ │
│  │        ↓              ↓                 ↓              ↓              │ │
│  │        └──────────────┬──────────────┬──────────────┘              │ │
│  │                       ↓              ↓                              │ │
│  │              SignalVector (fully typed)                             │ │
│  │         [all fields non-optional, never undefined]                │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                            ↓                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                    PARALLEL ANALYSIS LAYER                            │ │
│  │                                                                        │ │
│  │  ┌─────────────────────────┐    ┌──────────────────────────────────┐ │ │
│  │  │  ANOMALY DETECTOR       │    │   SPECIALIST ENSEMBLE (PARALLEL) │ │ │
│  │  │  ─────────────────────  │    │   ─────────────────────────────  │ │ │
│  │  │  Autoencoder inference  │    │                                  │ │ │
│  │  │  reconstructionError    │    │  Contract (0.35) ─── XGBoost    │ │ │
│  │  │  isAnomaly > 0.7        │    │  Wallet   (0.30) ─── XGBoost    │ │ │
│  │  │                         │    │  Liquidity(0.25) ─── XGBoost    │ │ │
│  │  │  Catches novel patterns │    │  Social   (0.10) ─── XGBoost    │ │ │
│  │  │  not in training data   │    │                                  │ │ │
│  │  │                         │    │  Confidence decay per model      │ │ │
│  │  │                         │    │  based on 7-day accuracy delta   │ │ │
│  │  └─────────────────────────┘    └──────────────────────────────────┘ │ │
│  │           ↓                                 ↓                          │ │
│  │    anomalyScore              ensembleResult {score, confidence,      │ │
│  │    {error, isAnomaly}        conflictFlag?, specialistPreds[]}       │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                 ↓                                    ↓                       │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                      RULE-BASED FLOOR (HARD RULES)                    │  │
│  │                       ─────────────────────────────                   │  │
│  │  INSTANT REJECT if any:                                              │  │
│  │    • mintEnabled === true                                            │  │
│  │    • isHoneypot === true                                             │  │
│  │    • isKnownRugDeployer === true                                     │  │
│  │    • !lpLocked && !lpBurned                                          │  │
│  │    • sellTax > 15%                                                   │  │
│  │    • !ownershipRenounced                                             │  │
│  │                                                                       │  │
│  │  Blend: finalScore = (ruleScore * 0.6) + (ensembleScore*100 * 0.4) │  │
│  │  ML can ONLY raise the floor, never lower                           │  │
│  │                                                                       │  │
│  │  Output: finalScore (0-100)                                          │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│              ↓                                                               │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                     REGIME DETECTOR (PARALLEL)                        │  │
│  │                     ─────────────────────────                         │  │
│  │  Tracks rolling 48h miss rate (rugs that bypassed filter)            │  │
│  │  Tracks per-signal information gain decay                            │  │
│  │  If missRate increase > 15% vs week: REGIME_SHIFT event             │  │
│  │  Suggests retraining + weight adjustments                            │  │
│  │                                                                       │  │
│  │  Output: regimeState {currentRegime, missRate, decayingSignals}    │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│              ↓                                                               │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                  CONFIDENCE CALIBRATOR + POSITION SIZER               │  │
│  │                  ──────────────────────────────────────                │  │
│  │                                                                       │  │
│  │  Score bins (0-20 vs 21-40 vs 41-60 vs 61-79 vs 80-100)            │  │
│  │       ↓         ↓         ↓          ↓          ↓                    │  │
│  │     BUY(1.0)  BUY(0.6)  SMALL(0.25) SKIP(0)  REJECT(0)             │  │
│  │                                                                       │  │
│  │  Adjustments:                                                        │  │
│  │  • Conflict penalty: if models disagree > 30pts → half positionSize │  │
│  │  • DD-linked: if DD > 20% → multiply positionSize by 0.5           │  │
│  │  • Maintains max DD at 30-35%                                        │  │
│  │                                                                       │  │
│  │  Output: decision {REJECT/SKIP/SMALL/BUY, positionSize, riskLevel} │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│              ↓                                                               │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                       FEEDBACK LOGGER (SQLite)                        │  │
│  │                       ──────────────────────                          │  │
│  │  Persists every decision for continual learning                      │  │
│  │  Checks outcome 48h later                                            │  │
│  │  Computes rich reward signal (not binary: -1.0 to +1.0)            │  │
│  │                                                                       │  │
│  │  Output: FeedbackRecord {decision, timestamp, outcome?, reward}     │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│              ↓                                                               │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                  CONTINUAL LEARNER (EWC) - WEEKLY                     │  │
│  │                  ──────────────────────────────────                   │  │
│  │                                                                       │  │
│  │  1. Collect labeled feedback (last 30 days)                         │  │
│  │  2. Compute Fisher Information Matrix (weight importance)           │  │
│  │  3. Retrain each specialist with EWC regularization                 │  │
│  │     L_new = L_train + (λ/2) * Σ F_i * (θ_i - θ_old_i)^2           │  │
│  │  4. Validate on time-split data (not random split)                  │  │
│  │  5. Deploy only if accuracy >= previous - 3%                       │  │
│  │                                                                       │  │
│  │  Prevents catastrophic forgetting while enabling adaptation         │  │
│  │                                                                       │  │
│  │  Output: RetrainReport {accuracyBefore, accuracyAfter, deployed}   │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│              ↓                                                               │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                      3-TIER MEMORY ARCHITECTURE                       │  │
│  │                      ───────────────────────────                      │  │
│  │                                                                       │  │
│  │  Long-Term Memory (LTM):                                             │  │
│  │    • Fundamental signals: mint, honeypot, LP lock                    │  │
│  │    • High EWC protection (~90 days frozen)                           │  │
│  │    • Almost never updated                                            │  │
│  │                                                                       │  │
│  │  Medium-Term Memory (MTM):                                           │  │
│  │    • Holder patterns, deployer clusters                              │  │
│  │    • Monthly retraining cycle                                        │  │
│  │    • Moderate EWC protection                                         │  │
│  │                                                                       │  │
│  │  Short-Term Memory (STM):                                            │  │
│  │    • Emerging bad clusters, recent rug wallets                       │  │
│  │    • Real-time updates, no retraining                                │  │
│  │    • Can override MTM/LTM decisions                                  │  │
│  │    • 24h TTL (reset daily)                                           │  │
│  │                                                                       │  │
│  │  Query precedence: STM > MTM > LTM                                   │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Signal Vector (Complete)

```typescript
interface SignalVector {
  tokenAddress: string
  timestamp: number
  detectedAt: number
  sourceChain: 'solana' | 'ethereum' | 'polygon'
  
  // Contract security (GoPlus)
  mintEnabled: boolean
  blacklistFunction: boolean
  ownershipRenounced: boolean
  isProxy: boolean
  
  // Honeypot & taxes (honeypot.is)
  isHoneypot: boolean
  buyTax: number (0-100 bps)
  sellTax: number (0-100 bps)
  
  // Holder distribution (Helius/Alchemy)
  top10HolderPct: number (0-100%)
  devWalletPct: number (0-100%)
  walletClusterScore: number (0-1: 0=unique, 1=concentrated)
  
  // Liquidity (Unicrypt/DappRadar)
  lpLocked: boolean
  lpLockDays: number
  lpBurned: boolean
  
  // Community (Metadata + scraper)
  hasTelegram: boolean
  hasTwitter: boolean
  telegramAgeDays: number
  twitterAgeDays: number
  followerQualityScore: number (0-1: 0=bots, 1=organic)
  
  // Internal tracking
  isKnownRugDeployer: boolean
}
```

## Decision Output

```typescript
interface RugFilterDecision {
  tokenAddress: string
  timestamp: number
  
  // Scoring components
  hardRuleScore: number (0-100)
  ensembleScore: number (0-100)
  anomalyScore: number (0-1)
  finalScore: number (0-100)
  
  // Decision
  decision: 'REJECT' | 'SKIP' | 'SMALL' | 'BUY'
  riskLevel: 'REJECT' | 'HIGH' | 'MEDIUM' | 'LOW_MEDIUM' | 'LOW'
  positionSize: number (0-1.0 fraction)
  
  // Metadata
  conflictFlag?: boolean (models disagreed > 30pts)
  anomalyFlag?: boolean (novel pattern detected)
  regimeShiftFlag?: boolean (rug-meta shifting)
  confidence: number (0-1)
  
  // Debug
  signalVector: SignalVector
  ensemble: EnsembleResult
}
```

## Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. TOKEN DETECTED in Solana/EVM event stream                   │
└──────────────────────────────┬──────────────────────────────────┘
                               ↓
┌──────────────────────────────────────────────────────────────────┐
│ 2. EXTRACT SIGNALS (parallel Promise.all, 300ms timeout/API)   │
│    GoPlus + Honeypot + Helius + Unicrypt + Internal            │
└──────────────────────────────┬──────────────────────────────────┘
                               ↓
┌──────────────────────────────────────────────────────────────────┐
│ 3. ANOMALY DETECTION + ENSEMBLE (parallel)                      │
│    • Autoencoder: reconstruction error                          │
│    • 4 Specialists: contract, wallet, liquidity, social        │
│    Runs concurrently for latency optimization                   │
└──────────────────────────────┬──────────────────────────────────┘
                               ↓
┌──────────────────────────────────────────────────────────────────┐
│ 4. APPLY HARD RULES (instant floor)                            │
│    If violation → score = 100, decision = REJECT               │
├──────────────────────────────────────────────────────────────────┤
│ 5. CHECK REGIME STATE (async, parallel)                        │
│    Detects meta shift, suggests weight adjustments             │
└──────────────────────────────┬──────────────────────────────────┘
                               ↓
┌──────────────────────────────────────────────────────────────────┐
│ 6. CALIBRATE DECISION (score → decision + sizing)              │
│    Apply conflict penalty, DD reduction, etc.                  │
└──────────────────────────────┬──────────────────────────────────┘
                               ↓
┌──────────────────────────────────────────────────────────────────┐
│ 7. LOG DECISION (SQLite)                                        │
│    RugFilterDecision + SignalVector stored for analysis        │
└──────────────────────────────┬──────────────────────────────────┘
                               ↓
┌──────────────────────────────────────────────────────────────────┐
│ 8. EXECUTE TRADE (if decision != REJECT/SKIP)                  │
│    Position size = baseSize * decision.positionSize            │
│    Place order...                                               │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ├─ Store decision ID  
                               │
                    ┌──────────────────────┐
                    │   WAIT 48 HOURS      │
                    └──────────────────────┘
                               ↓
┌──────────────────────────────────────────────────────────────────┐
│ 9. LABEL OUTCOME (48h later)                                    │
│    • Fetch current price                                        │
│    • Determine outcome: RUG vs DUMP_60 vs STABLE vs MOONSHOT   │
│    • Compute reward signal (rich, continuous)                  │
│    • Update feedback record in SQLite                           │
└──────────────────────────────┬──────────────────────────────────┘
                               ↓
        ┌──────────────────────────────────────────────────────┐
        │  CONTINUAL LEARNING (WEEKLY)                         │
        │  • Collect all labeled feedback (30-day window)      │
        │  • Train with EWC (prevent forgetting)              │
        │  • Validate on time-split                            │
        │  • Deploy if accuracy >= prev - 3%                  │
        │  • Log accuracy delta per specialist                 │
        └──────────────────────────────────────────────────────┘
```

## Performance Profile

| Operation | Latency | Notes |
|-----------|---------|-------|
| API Extraction | 300ms × 4 + fallback | Parallel, with safe defaults |
| Anomaly Detection | 100-200ms | Autoencoder inference |
| Ensemble (4 specialists) | 300-500ms | Parallel XGBoost models |
| Hard Rules Check | < 1ms | Simple boolean checks |
| Regime Detection | < 50ms | Cached, checked async |
| Calibration | < 5ms | Lookup table + simple math |
| Total Pipeline | **1.0-1.5s** | End-to-end evaluation |
| SQLite Persist | 20-50ms | Batch write async |
| **Full Decision Cycle** | **~2s** | Includes all parallel ops |

## Integration Points

1. **Bot Trade Flow**: Call `rugFilter.evaluateToken()` before placing order
2. **48h Outcome Tracking**: Call `rugFilter.labelOutcome()` after market close
3. **Weekly Retraining**: `npm run retrain` scheduled via cron or APScheduler
4. **Real-time Regime Monitoring**: Listen to `regime-shift` event
5. **Feedback Analysis**: `npm run analyze-feedback` for model performance review

## Deployment Checklist

- [ ] TypeScript compiled to `dist/`
- [ ] Python model server running (if HTTP mode)
- [ ] SQLite DB initialized at `feedbackDbPath`
- [ ] API keys in `.env` (GoPlus, Honeypot, Helius)
- [ ] Model paths verified in `.env`
- [ ] Test evaluation: `npm run dev`
- [ ] Integrated into bot trade flow
- [ ] Weekly retrain scheduled
- [ ] Outcome labeling 48h post-trade
- [ ] Monitoring dashboard wired up
- [ ] Stress test suite runs with filter enabled

---

**Estimated Impact**: Sharpe +0.4–0.6, DD reduction of 5–10%, false positive rate < 5%.
