/**
 * engine/summary-report.ts
 *
 * Summary report generator that produces daily trading summaries,
 * performance analytics, and system health reports.
 */

import {
  DailySummary,
  MarketRegime,
  TradeOutcome,
  SizingBucket,
} from './types';
import { TradingPipeline } from './pipeline';

// ─── Report Generator ────────────────────────────────────────────────

export class SummaryReportGenerator {
  /**
   * Generate a daily summary from pipeline stats and trade outcomes.
   */
  static generateDailySummary(
    pipeline: TradingPipeline,
    outcomes: TradeOutcome[],
    solPriceUsd: number = 150,
  ): DailySummary {
    const stats = pipeline.getStats() as Record<string, any>;
    const riskStats = stats.riskManager as Record<string, any>;

    const wins = outcomes.filter((o) => o.pnlSol > 0);
    const grossPnl = outcomes.reduce((s, o) => s + Math.max(0, o.pnlSol), 0);
    const netPnl = outcomes.reduce((s, o) => s + o.pnlSol, 0);

    // Sharpe
    const returns = outcomes.map((o) => o.pnlPct);
    let sharpe = 0;
    if (returns.length > 2) {
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
      const std = Math.sqrt(variance);
      sharpe = std > 1e-10 ? (mean / std) * Math.sqrt(252) : 0;
    }

    // Max drawdown
    let maxDD = 0;
    let equity = riskStats?.currentEquity ?? 10;
    let peak = equity;
    for (const o of outcomes) {
      equity += o.pnlSol;
      peak = Math.max(peak, equity);
      maxDD = Math.max(maxDD, peak > 0 ? ((peak - equity) / peak) * 100 : 0);
    }

    // Latency
    const executionStats = stats.executionRouter as Record<string, any>;

    // Regime breakdown
    const regimeBreakdown: Record<MarketRegime, number> = {
      [MarketRegime.ACCELERATING]: 0,
      [MarketRegime.NORMAL]: 0,
      [MarketRegime.FRAGILE]: 0,
      [MarketRegime.STRESS]: 0,
    };
    for (const o of outcomes) {
      regimeBreakdown[o.regime]++;
    }

    return {
      date: new Date().toISOString().split('T')[0],
      totalSignals: stats.totalSignals ?? 0,
      hardFilterRejects: stats.totalFiltered ?? 0,
      mlRanked: stats.totalRanked ?? 0,
      tradesExecuted: outcomes.length,
      grossPnlSol: grossPnl,
      netPnlSol: netPnl,
      grossPnlUsd: grossPnl * solPriceUsd,
      netPnlUsd: netPnl * solPriceUsd,
      winRate: outcomes.length > 0 ? wins.length / outcomes.length : 0,
      sharpe,
      maxDrawdownPct: maxDD,
      avgLatencyMs: executionStats?.avgLatencyMs ?? 0,
      regimeBreakdown,
      tradingHours: 24,
      throughputPerHour: outcomes.length / 24,
      riskMode: riskStats?.riskMode ?? 'NORMAL',
      killSwitchEvents: riskStats?.killSwitch ? 1 : 0,
    };
  }

  /**
   * Format a daily summary as a human-readable report.
   */
  static formatDailySummary(summary: DailySummary): string {
    const lines: string[] = [
      '',
      '╔══════════════════════════════════════════════════════════════╗',
      '║           MEMECOIN SNIPER — DAILY TRADING REPORT           ║',
      `║           Date: ${summary.date}                            ║`,
      '╚══════════════════════════════════════════════════════════════╝',
      '',
      '┌── Pipeline Throughput ──────────────────────────────────────┐',
      `│  Total Signals Received:     ${padNum(summary.totalSignals)}`,
      `│  Hard Filter Rejects:        ${padNum(summary.hardFilterRejects)}`,
      `│  ML Ranked:                  ${padNum(summary.mlRanked)}`,
      `│  Trades Executed:            ${padNum(summary.tradesExecuted)}`,
      `│  Throughput/Hour:            ${summary.throughputPerHour.toFixed(1)}`,
      '└───────────────────────────────────────────────────────────────┘',
      '',
      '┌── Performance ────────────────────────────────────────────────┐',
      `│  Gross PnL:    ${fmtPnl(summary.grossPnlSol)} SOL  (${fmtPnl(summary.grossPnlUsd)} USD)`,
      `│  Net PnL:      ${fmtPnl(summary.netPnlSol)} SOL  (${fmtPnl(summary.netPnlUsd)} USD)`,
      `│  Win Rate:     ${(summary.winRate * 100).toFixed(1)}%`,
      `│  Sharpe:       ${summary.sharpe.toFixed(3)}`,
      `│  Max Drawdown: ${summary.maxDrawdownPct.toFixed(2)}%`,
      `│  Avg Latency:  ${summary.avgLatencyMs.toFixed(1)}ms`,
      '└───────────────────────────────────────────────────────────────┘',
      '',
      '┌── Risk Status ────────────────────────────────────────────────┐',
      `│  Mode:         ${summary.riskMode}`,
      `│  Kill Events:  ${summary.killSwitchEvents}`,
      '└───────────────────────────────────────────────────────────────┘',
      '',
      '┌── Regime Breakdown ───────────────────────────────────────────┐',
    ];

    for (const [regime, count] of Object.entries(summary.regimeBreakdown)) {
      lines.push(`│  ${regime.padEnd(15)} ${count} trades`);
    }

    lines.push('└───────────────────────────────────────────────────────────────┘');
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Generate a comprehensive system health report.
   */
  static generateHealthReport(pipeline: TradingPipeline): string {
    const stats = pipeline.getStats();
    const lines: string[] = [
      '',
      '╔══════════════════════════════════════════════════════════════╗',
      '║              SYSTEM HEALTH REPORT                          ║',
      `║              ${new Date().toISOString()}              ║`,
      '╚══════════════════════════════════════════════════════════════╝',
      '',
    ];

    const sections: Record<string, Record<string, unknown>> = {
      'Pipeline': {
        uptime: stats.uptime,
        totalSignals: stats.totalSignals,
        filterPassRate: stats.filterPassRate,
        fillRate: stats.fillRate,
        signalsPerHour: stats.signalsPerHour,
        tradesPerHour: stats.tradesPerHour,
      },
      'Hard Filter': stats.hardFilter as Record<string, unknown>,
      'ML Ranker': stats.mlRanker as Record<string, unknown>,
      'Dynamic Sizer': stats.dynamicSizer as Record<string, unknown>,
      'Risk Manager': stats.riskManager as Record<string, unknown>,
      'Execution Router': stats.executionRouter as Record<string, unknown>,
      'Feedback Loop': stats.feedbackLoop as Record<string, unknown>,
    };

    for (const [sectionName, sectionData] of Object.entries(sections)) {
      lines.push(`┌── ${sectionName} ${'─'.repeat(55 - sectionName.length)}┐`);
      if (sectionData && typeof sectionData === 'object') {
        for (const [key, value] of Object.entries(sectionData)) {
          const formatted = typeof value === 'number'
            ? value.toFixed(4)
            : typeof value === 'object'
              ? JSON.stringify(value).substring(0, 50)
              : String(value);
          lines.push(`│  ${key.padEnd(25)} ${formatted}`);
        }
      }
      lines.push('└───────────────────────────────────────────────────────────────┘');
      lines.push('');
    }

    return lines.join('\n');
  }
}

// ─── Formatting Helpers ──────────────────────────────────────────────

function padNum(n: number): string {
  return String(n).padStart(8);
}

function fmtPnl(n: number): string {
  const prefix = n >= 0 ? '+' : '';
  return `${prefix}${n.toFixed(4)}`.padStart(12);
}
