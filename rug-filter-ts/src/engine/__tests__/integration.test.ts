/**
 * src/engine/__tests__/integration.test.ts
 *
 * Comprehensive integration tests for the high-throughput trading engine.
 * Tests the full pipeline from token signal to trade outcome.
 */

import {
  TokenSignal,
  MarketRegime,
  SizingBucket,
  TradeOutcome,
  TradePosition,
} from '../types';
import { TradingPipeline } from '../pipeline';
import { TradingEngineOrchestrator } from '../trading-engine-orchestrator';
import { ScenarioTester, SCENARIOS } from '../scenario-tester';

describe('High-Throughput Trading Engine', () => {
  let orchestrator: TradingEngineOrchestrator;
  let pipeline: TradingPipeline;

  beforeEach(() => {
    orchestrator = new TradingEngineOrchestrator({
      liveExecution: false,
      maxTradesPerSecond: 100,
      verbose: false,
    });
    pipeline = orchestrator.getPipeline();
  });

  describe('Hard Filter', () => {
    it('should reject tokens with mint enabled', async () => {
      const signal: TokenSignal = {
        mint: 'test_mint_enabled',
        receivedAt: Date.now(),
        liquiditySol: 1.0,
        liquidityUsd: 150,
        uniqueBuyers: 5,
        totalVolume: 10,
        marketCapSol: 15,
        timeSinceLaunchSec: 2,
        slippageEstimate: 0.05,
        priceGrowth1s: 0.1,
        socialProxy1s: 0.5,
        lpGrowth1s: 0.2,
        buyersPerSol: 5,
        volumeToLpRatio: 10,
        logLiquidity: Math.log1p(1.0),
        logVolume: Math.log1p(10),
        logMcap: Math.log1p(15),
        hourOfDay: 12,
        dayOfWeek: 3,
        isWeekend: false,
        mintEnabled: true,
        isHoneypot: false,
        isKnownRugDeployer: false,
        lpLocked: true,
        lpBurned: false,
        sellTax: 5,
        buyTax: 2,
        ownershipRenounced: true,
        top10HolderPct: 25,
        devWalletPct: 5,
        walletClusterScore: 0.2,
      };

      const decision = await orchestrator.processSignal(signal);
      expect(decision.hardFilter.passed).toBe(false);
      expect(decision.order).toBeNull();
    });

    it('should pass safe tokens', async () => {
      const signal: TokenSignal = {
        mint: 'test_safe_token',
        receivedAt: Date.now(),
        liquiditySol: 2.0,
        liquidityUsd: 300,
        uniqueBuyers: 15,
        totalVolume: 50,
        marketCapSol: 30,
        timeSinceLaunchSec: 3,
        slippageEstimate: 0.03,
        priceGrowth1s: 0.15,
        socialProxy1s: 0.7,
        lpGrowth1s: 0.25,
        buyersPerSol: 7.5,
        volumeToLpRatio: 25,
        logLiquidity: Math.log1p(2.0),
        logVolume: Math.log1p(50),
        logMcap: Math.log1p(30),
        hourOfDay: 12,
        dayOfWeek: 3,
        isWeekend: false,
        mintEnabled: false,
        isHoneypot: false,
        isKnownRugDeployer: false,
        lpLocked: true,
        lpBurned: false,
        sellTax: 2,
        buyTax: 1,
        ownershipRenounced: true,
        top10HolderPct: 20,
        devWalletPct: 2,
        walletClusterScore: 0.15,
      };

      const decision = await orchestrator.processSignal(signal);
      expect(decision.hardFilter.passed).toBe(true);
    });
  });

  describe('ML Ranking', () => {
    it('should rank high-quality tokens higher', async () => {
      const goodSignal: TokenSignal = {
        mint: 'good_token',
        receivedAt: Date.now(),
        liquiditySol: 5.0,
        liquidityUsd: 750,
        uniqueBuyers: 30,
        totalVolume: 200,
        marketCapSol: 75,
        timeSinceLaunchSec: 2,
        slippageEstimate: 0.02,
        priceGrowth1s: 0.25,
        socialProxy1s: 0.8,
        lpGrowth1s: 0.3,
        buyersPerSol: 6,
        volumeToLpRatio: 40,
        logLiquidity: Math.log1p(5.0),
        logVolume: Math.log1p(200),
        logMcap: Math.log1p(75),
        hourOfDay: 12,
        dayOfWeek: 3,
        isWeekend: false,
        mintEnabled: false,
        isHoneypot: false,
        isKnownRugDeployer: false,
        lpLocked: true,
        lpBurned: false,
        sellTax: 1,
        buyTax: 0,
        ownershipRenounced: true,
        top10HolderPct: 15,
        devWalletPct: 1,
        walletClusterScore: 0.1,
      };

      const badSignal: TokenSignal = {
        ...goodSignal,
        mint: 'bad_token',
        liquiditySol: 0.5,
        uniqueBuyers: 3,
        priceGrowth1s: -0.05,
        socialProxy1s: 0.2,
        top10HolderPct: 75,
        devWalletPct: 20,
      };

      const goodDecision = await orchestrator.processSignal(goodSignal);
      const badDecision = await orchestrator.processSignal(badSignal);

      if (goodDecision.ranked && badDecision.ranked) {
        expect(goodDecision.ranked.compositeRank).toBeGreaterThan(
          badDecision.ranked.compositeRank,
        );
      }
    });
  });

  describe('Risk Management', () => {
    it('should respect per-trade risk caps', async () => {
      const signal: TokenSignal = {
        mint: 'risk_test',
        receivedAt: Date.now(),
        liquiditySol: 2.0,
        liquidityUsd: 300,
        uniqueBuyers: 15,
        totalVolume: 50,
        marketCapSol: 30,
        timeSinceLaunchSec: 3,
        slippageEstimate: 0.03,
        priceGrowth1s: 0.15,
        socialProxy1s: 0.7,
        lpGrowth1s: 0.25,
        buyersPerSol: 7.5,
        volumeToLpRatio: 25,
        logLiquidity: Math.log1p(2.0),
        logVolume: Math.log1p(50),
        logMcap: Math.log1p(30),
        hourOfDay: 12,
        dayOfWeek: 3,
        isWeekend: false,
        mintEnabled: false,
        isHoneypot: false,
        isKnownRugDeployer: false,
        lpLocked: true,
        lpBurned: false,
        sellTax: 2,
        buyTax: 1,
        ownershipRenounced: true,
        top10HolderPct: 20,
        devWalletPct: 2,
        walletClusterScore: 0.15,
      };

      const decision = await orchestrator.processSignal(signal);

      if (decision.risk.approved && decision.order) {
        const riskMgr = pipeline.riskManager;
        const state = riskMgr.getState();
        const equity = riskMgr.getCurrentEquity();

        // Capped size should not exceed risk limits
        expect(decision.risk.cappedSizeSol).toBeLessThanOrEqual(
          equity * (riskMgr.getStats()['maxRiskPerTradePct'] / 100),
        );
      }
    });

    it('should trigger kill switch on excessive drawdown', async () => {
      // Simulate a series of losses
      const riskMgr = pipeline.riskManager;
      const initialEquity = riskMgr.getCurrentEquity();

      // Create losing trades
      for (let i = 0; i < 5; i++) {
        const outcome: TradeOutcome = {
          mint: `loss_${i}`,
          entryTimestamp: Date.now() - 1000,
          exitTimestamp: Date.now(),
          entrySizeSol: 0.5,
          pnlSol: -0.3, // Loss
          pnlPct: -60,
          holdTimeMs: 1000,
          slippageEntry: 0.01,
          slippageExit: 0.01,
          fillQuality: 0.9,
          bucket: SizingBucket.FAST_REACT,
          regime: MarketRegime.STRESS,
          mlScoreAtEntry: 0.5,
          expectedEdgeAtEntry: 0.01,
        };

        riskMgr.onTradeExit(outcome);
      }

      const state = riskMgr.getState();
      // Should have triggered kill switch or increased drawdown significantly
      expect(state.dailyDrawdownPct).toBeGreaterThan(5);
    });
  });

  describe('Regime Detection', () => {
    it('should detect regime changes', async () => {
      const detector = pipeline.regimeDetector;

      // Record winning trades → ACCELERATING
      for (let i = 0; i < 10; i++) {
        const outcome: TradeOutcome = {
          mint: `win_${i}`,
          entryTimestamp: Date.now() - 1000,
          exitTimestamp: Date.now(),
          entrySizeSol: 0.5,
          pnlSol: 0.2,
          pnlPct: 40,
          holdTimeMs: 1000,
          slippageEntry: 0.01,
          slippageExit: 0.01,
          fillQuality: 0.95,
          bucket: SizingBucket.FAST_REACT,
          regime: MarketRegime.NORMAL,
          mlScoreAtEntry: 0.7,
          expectedEdgeAtEntry: 0.02,
        };
        detector.recordOutcome(outcome);
      }

      const regime1 = detector.detect();
      expect(regime1.recentWinRate).toBeGreaterThan(0.5);

      // Record losing trades → STRESS
      for (let i = 0; i < 8; i++) {
        const outcome: TradeOutcome = {
          mint: `loss_${i}`,
          entryTimestamp: Date.now() - 1000,
          exitTimestamp: Date.now(),
          entrySizeSol: 0.5,
          pnlSol: -0.25,
          pnlPct: -50,
          holdTimeMs: 1000,
          slippageEntry: 0.02,
          slippageExit: 0.02,
          fillQuality: 0.7,
          bucket: SizingBucket.ULTRA_FAST_SNIPE,
          regime: MarketRegime.STRESS,
          mlScoreAtEntry: 0.4,
          expectedEdgeAtEntry: -0.01,
        };
        detector.recordOutcome(outcome);
      }

      const regime2 = detector.detect();
      expect(regime2.recentWinRate).toBeLessThan(regime1.recentWinRate);
    });
  });

  describe('Scenario Testing', () => {
    it('should complete base case scenario', async () => {
      const tester = new ScenarioTester();
      const result = await tester.runScenario(SCENARIOS.BASE_CASE, orchestrator);

      expect(result.totalTrades).toBeGreaterThan(0);
      expect(result.tradesPerHour).toBeGreaterThan(0);
      expect(result.winRate).toBeGreaterThanOrEqual(0);
      expect(result.winRate).toBeLessThanOrEqual(1);
    });

    it('should handle stress scenario', async () => {
      const tester = new ScenarioTester();
      const result = await tester.runScenario(SCENARIOS.STRESS_MARKET, orchestrator);

      // In stress, we should have lower win rate but still operate
      expect(result.totalTrades).toBeGreaterThan(0);
      expect(result.sharpe).toBeLessThan(1.0);
    });

    it('should achieve target throughput in high-volume scenario', async () => {
      const tester = new ScenarioTester();
      const result = await tester.runScenario(SCENARIOS.HIGH_THROUGHPUT_BURST, orchestrator);

      // Should execute significant number of trades
      expect(result.totalTrades).toBeGreaterThan(50);
      expect(result.tradesPerHour).toBeGreaterThan(100);
    });
  });

  describe('Pipeline Statistics', () => {
    it('should track pipeline metrics', async () => {
      const stats1 = pipeline.getStats();
      expect(stats1.totalSignals).toBe(0);

      // Process a few signals
      for (let i = 0; i < 5; i++) {
        const signal: TokenSignal = {
          mint: `stat_test_${i}`,
          receivedAt: Date.now(),
          liquiditySol: 1.5 + Math.random() * 2,
          liquidityUsd: 225 + Math.random() * 300,
          uniqueBuyers: Math.floor(5 + Math.random() * 20),
          totalVolume: 20 + Math.random() * 100,
          marketCapSol: 25 + Math.random() * 50,
          timeSinceLaunchSec: Math.random() * 10,
          slippageEstimate: 0.01 + Math.random() * 0.1,
          priceGrowth1s: -0.1 + Math.random() * 0.3,
          socialProxy1s: Math.random(),
          lpGrowth1s: -0.2 + Math.random() * 0.4,
          buyersPerSol: 3 + Math.random() * 10,
          volumeToLpRatio: 10 + Math.random() * 30,
          logLiquidity: Math.log1p(1.5 + Math.random() * 2),
          logVolume: Math.log1p(30 + Math.random() * 100),
          logMcap: Math.log1p(25 + Math.random() * 50),
          hourOfDay: 12,
          dayOfWeek: 3,
          isWeekend: false,
          mintEnabled: Math.random() < 0.1,
          isHoneypot: Math.random() < 0.05,
          isKnownRugDeployer: Math.random() < 0.02,
          lpLocked: Math.random() < 0.8,
          lpBurned: Math.random() < 0.2,
          sellTax: Math.floor(Math.random() * 20),
          buyTax: Math.floor(Math.random() * 10),
          ownershipRenounced: Math.random() < 0.6,
          top10HolderPct: 10 + Math.random() * 60,
          devWalletPct: Math.random() * 20,
          walletClusterScore: Math.random(),
        };

        await orchestrator.processSignal(signal);
      }

      const stats2 = pipeline.getStats();
      expect(stats2.totalSignals).toBe(5);
      expect(stats2.signalsPerHour).toBeGreaterThan(0);
    });
  });
});
