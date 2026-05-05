export interface TradeRecord {
  mint: string;
  openedAt: number;
  closedAt: number;
  amountSol: number;
  pnlSol: number;
  returnPct: number;
  exitReason: string;
  cluster?: string;
}

export interface BacktestMetrics {
  trades: number;
  winRate: number;
  pnlSol: number;
  sharpe: number;
  maxDrawdownPct: number;
  profitFactor: number;
  expectancyPct: number;
}

export const computeMetrics = (trades: TradeRecord[], startingCapitalSol: number): BacktestMetrics => {
  const returns = trades.map((trade) => trade.returnPct);
  const pnlSol = trades.reduce((sum, trade) => sum + trade.pnlSol, 0);
  const wins = trades.filter((trade) => trade.pnlSol > 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.pnlSol, 0);
  const grossLoss = Math.abs(trades.filter((trade) => trade.pnlSol < 0).reduce((sum, trade) => sum + trade.pnlSol, 0));
  return {
    trades: trades.length,
    winRate: trades.length > 0 ? wins.length / trades.length : 0,
    pnlSol,
    sharpe: sharpeRatio(returns),
    maxDrawdownPct: maxDrawdownPct(equityCurve(trades, startingCapitalSol)),
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : 0,
    expectancyPct: returns.length > 0 ? returns.reduce((sum, value) => sum + value, 0) / returns.length : 0
  };
};

export const equityCurve = (trades: TradeRecord[], startingCapitalSol: number): number[] => {
  const curve = [startingCapitalSol];
  let equity = startingCapitalSol;
  for (const trade of trades) {
    equity += trade.pnlSol;
    curve.push(equity);
  }
  return curve;
};

export const sharpeRatio = (returns: number[]): number => {
  if (returns.length < 2) {
    return 0;
  }
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length;
  const std = Math.sqrt(variance);
  return std > 0 ? mean / std : 0;
};

export const maxDrawdownPct = (equity: number[]): number => {
  let peak = equity[0] || 0;
  let maxDrawdown = 0;
  for (const value of equity) {
    peak = Math.max(peak, value);
    if (peak > 0) {
      maxDrawdown = Math.max(maxDrawdown, (peak - value) / peak);
    }
  }
  return maxDrawdown * 100;
};

export const monteCarloTradeOrder = (trades: TradeRecord[], startingCapitalSol: number, iterations = 100, seed = 7): Array<BacktestMetrics & { iteration: number }> => {
  const rng = new Prng(seed);
  const results: Array<BacktestMetrics & { iteration: number }> = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const shuffled = [...trades];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(rng.next() * (index + 1));
      [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
    }
    results.push({ iteration, ...computeMetrics(shuffled, startingCapitalSol) });
  }
  return results;
};

class Prng {
  state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state += 0x6d2b79f5;
    let value = this.state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  }
}
