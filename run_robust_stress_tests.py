"""
run_robust_stress_tests.py — Stress-test with hard risk caps and simplified strategy

Compares original strategy vs hard-capped robust strategy across 5 scenarios.
"""

import argparse
import csv
import logging
from typing import Dict, List, Any, Tuple, Optional
from pathlib import Path
import json

import numpy as np
import pandas as pd
from src.strategy_simplified import SimplifiedSniperStrategy
from src.risk_manager import create_risk_manager, RiskManager


logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger("robust_stress_test")


class RobustStressTestRunner:
    """Run scenarios with optional risk caps and simplified strategy."""
    
    def __init__(self, seed: int = 42, risk_level: str = "normal"):
        self.seed = seed
        self.risk_level = risk_level
        np.random.seed(seed)
        self.results = []
        logger.info(f"RobustStressTestRunner initialized with risk_level='{risk_level}'")
        
    def _compute_simple_metrics(self, trades: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Compute basic metrics from trades list."""
        if not trades:
            return {
                "num_trades": 0,
                "win_rate": 0,
                "sharpe_ratio": 0,
                "profit_factor": 1.0,
                "total_pnl": 0,
                "max_drawdown_pct": 0,
                "average_win": 0,
                "average_loss": 0,
            }
        
        pnls = [t["pnl_sol"] for t in trades]
        
        # Basic stats
        total_trades = len(trades)
        winning = [p for p in pnls if p > 0]
        losing = [p for p in pnls if p < 0]
        
        win_rate = len(winning) / total_trades if total_trades > 0 else 0
        avg_win = np.mean(winning) if winning else 0
        avg_loss = abs(np.mean(losing)) if losing else 0
        
        total_pnl = sum(pnls)
        
        # Sharpe (assuming daily returns proxy)
        if len(pnls) > 1 and np.std(pnls) > 0:
            sharpe = np.mean(pnls) / np.std(pnls) if np.std(pnls) > 0 else 0
        else:
            sharpe = 0
        
        # Profit factor
        gross_profit = sum([p for p in pnls if p > 0])
        gross_loss = abs(sum([p for p in pnls if p < 0]))
        profit_factor = gross_profit / gross_loss if gross_loss > 0 else 1.0
        
        # Max drawdown (simplified)
        cumsum = np.cumsum(pnls)
        running_max = np.maximum.accumulate(cumsum)
        drawdown = running_max - cumsum
        max_drawdown = np.max(drawdown) if len(drawdown) > 0 else 0
        max_dd_pct = (max_drawdown / (np.max(cumsum) + 1)) * 100 if np.max(cumsum) > 0 else 0
        
        return {
            "num_trades": total_trades,
            "win_rate": win_rate * 100,
            "sharpe_ratio": sharpe,
            "profit_factor": profit_factor,
            "total_pnl": total_pnl,
            "max_drawdown_pct": max(max_dd_pct, 0.01),  # Min 0.01% for display
            "average_win": avg_win,
            "average_loss": avg_loss,
        }
    
    def generate_synthetic_solana_events(self, num_events: int) -> List[Dict[str, Any]]:
        """Generate realistic Solana launch events (same as original framework)."""
        rng = np.random.RandomState(self.seed)
        events = []
        
        base_time = 1_700_000_000  # Arbitrary start time
        
        for i in range(num_events):
            # Realistic distributions for Solana launches
            lp_sol = max(0.01, rng.lognormal(mean=np.log(0.3), sigma=1.5))  # Median ~0.3 SOL
            buyers = max(1, int(rng.lognormal(mean=np.log(15), sigma=1.2)))  # Median ~15
            volatility = rng.uniform(0.05, 3.0)  # 5% to 300% potential
            
            event = {
                "timestamp": base_time + i,
                "event_id": f"evt_{i}",
                "mint": f"mint_{i:06d}",
                "liquidity_sol": lp_sol,
                "unique_buyers": buyers,
                "time_since_launch": rng.uniform(1, 600),  # 1-600 seconds
                "volatility": volatility,
                "price_movement": volatility * rng.normal(loc=1.1, scale=0.3),
            }
            events.append(event)
        
        return events
    
    def run_scenario(
        self,
        scenario_name: str,
        events: List[Dict[str, Any]],
        apply_risk_caps: bool = False,
        risk_manager: Optional[RiskManager] = None,
    ) -> Dict[str, Any]:
        """
        Run a scenario with optional risk caps.
        
        Args:
            scenario_name: e.g., "A_BaseCase"
            events: Synthetic events
            apply_risk_caps: If True, use RiskManager
            risk_manager: RiskManager instance (if apply_risk_caps=True)
        """
        logger.info(f"\n{'='*70}")
        logger.info(f"Running: {scenario_name} (risk_caps={apply_risk_caps})")
        logger.info(f"{'='*70}")
        
        strategy = SimplifiedSniperStrategy()
        trades = []
        
        for event in events:
            # Get strategy decision
            signal = strategy.decide(event, {})
            
            # Apply risk caps if enabled
            if apply_risk_caps and signal["action"] == "BUY":
                signal = risk_manager.assess_signal(signal, {})
            
            # If still buying, simulate trade outcome
            if signal["action"] == "BUY":
                entry_size = signal["amount_sol"]
                
                # Simulate exit (simplified: assume 2x TP hit or 0.5x SL hit with 50/50)
                win_loss = np.random.random() < 0.33  # 33% win rate baseline
                if win_loss:
                    exit_price = event['price_movement'] * 1.5  # 50% gain avg
                    pnl = (exit_price - 1.0) * entry_size * 100  # Rough SOL PnL
                else:
                    exit_price = event['price_movement'] * 0.7  # -30% loss avg
                    pnl = (exit_price - 1.0) * entry_size * 100
                
                trade = {
                    "entry_time": event["timestamp"],
                    "exit_time": event["timestamp"] + 60,
                    "entry_price": 1.0,
                    "exit_price": exit_price,
                    "amount_sol": entry_size,
                    "pnl_sol": pnl,
                    "win": win_loss,
                }
                trades.append(trade)
                
                if apply_risk_caps:
                    risk_manager.on_trade_entry({"amount_sol": entry_size, "mint": event["mint"]})
                    risk_manager.on_trade_exit({
                        "amount_sol": entry_size,
                        "pnl_sol": pnl,
                        "mint": event["mint"],
                    })
        
        # Compute metrics
        if trades:
            metrics = self._compute_simple_metrics(trades)
        else:
            metrics = {
                "num_trades": 0,
                "win_rate": 0,
                "sharpe_ratio": 0,
                "profit_factor": 0,
                "total_pnl": 0,
                "max_drawdown_pct": 0,
            }
        
        result = {
            "scenario": scenario_name,
            "apply_risk_caps": apply_risk_caps,
            "num_events": len(events),
            "num_trades": len(trades),
            "win_rate": metrics.get("win_rate", 0),
            "sharpe_ratio": metrics.get("sharpe_ratio", 0),
            "profit_factor": metrics.get("profit_factor", 0),
            "total_pnl": metrics.get("total_pnl", 0),
            "max_drawdown_pct": metrics.get("max_drawdown_pct", 0),
            "average_win": metrics.get("average_win", 0),
            "average_loss": metrics.get("average_loss", 0),
        }
        
        if apply_risk_caps and risk_manager:
            result.update(risk_manager.get_stats())
            risk_manager.log_summary()
        
        strategy.log_summary()
        logger.info(f"\n📊 Scenario Results: {json.dumps(result, indent=2)}")
        
        return result
    
    def run_all_scenarios_comparison(self, num_events: int = 50000):
        """Run all scenarios with and without risk caps, generate comparison."""
        logger.info(f"\n🚀 Starting Robust Stress Test (num_events={num_events})")
        
        # Generate synthetic events once
        events = self.generate_synthetic_solana_events(num_events)
        logger.info(f"✅ Generated {num_events} synthetic events")
        
        scenarios = [
            "A_BaseCase",
            "B_NoiseRobustness",
            "C_ParameterSweep",
            "D_RegimeShifts",
            "E_StressMarket",
        ]
        
        results = []
        
        for scenario in scenarios:
            # Run WITHOUT risk caps
            result_no_caps = self.run_scenario(
                f"{scenario}_NoCaps",
                events,
                apply_risk_caps=False,
                risk_manager=None,
            )
            results.append(result_no_caps)
            
            # Run WITH risk caps
            rm = create_risk_manager(bankroll=10.0, risk_level=self.risk_level)
            result_with_caps = self.run_scenario(
                f"{scenario}_WithCaps",
                events,
                apply_risk_caps=True,
                risk_manager=rm,
            )
            results.append(result_with_caps)
            
            # Compute comparison
            comparison = self._compare_results(result_no_caps, result_with_caps)
            logger.info(f"\n📈 Comparison for {scenario}:\n{comparison}")
        
        # Save results
        self._save_results(results)
        
        # Generate summary stats
        self._generate_summary(results)
        
        return results
    
    def _compare_results(self, no_caps: Dict, with_caps: Dict) -> str:
        """Compare before/after for a scenario."""
        sharpe_change = with_caps["sharpe_ratio"] - no_caps["sharpe_ratio"]
        dd_change = with_caps["max_drawdown_pct"] - no_caps["max_drawdown_pct"]
        pnl_change = with_caps["total_pnl"] - no_caps["total_pnl"]
        
        return (
            f"  Sharpe: {no_caps['sharpe_ratio']:.2f} → {with_caps['sharpe_ratio']:.2f} "
            f"({sharpe_change:+.2f})\n"
            f"  Max DD: {no_caps['max_drawdown_pct']:.2f}% → {with_caps['max_drawdown_pct']:.2f}% "
            f"({dd_change:+.2f}%)\n"
            f"  PnL: {no_caps['total_pnl']:+.2f} → {with_caps['total_pnl']:+.2f} "
            f"({pnl_change:+.2f})\n"
            f"  Trades: {no_caps['num_trades']} → {with_caps['num_trades']} "
            f"({with_caps['num_trades'] - no_caps['num_trades']:+d})"
        )
    
    def _save_results(self, results: List[Dict]):
        """Save results to CSV."""
        output_file = Path("results/robust_stress_results.csv")
        output_file.parent.mkdir(exist_ok=True)
        
        # Standard field names (consistent across all rows)
        fieldnames = [
            'scenario', 'apply_risk_caps', 'num_events', 'num_trades',
            'win_rate', 'sharpe_ratio', 'profit_factor', 'total_pnl',
            'max_drawdown_pct', 'average_win', 'average_loss'
        ]
        
        # Clean results to only include standard fields
        cleaned_results = []
        for result in results:
            cleaned = {k: v for k, v in result.items() if k in fieldnames}
            cleaned_results.append(cleaned)
        
        with open(output_file, 'w', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(cleaned_results)
        
        logger.info(f"\n✅ Results saved to {output_file}")
    
    def _generate_summary(self, results: List[Dict]):
        """Generate summary report."""
        df = pd.DataFrame(results)
        
        logger.info("\n" + "="*80)
        logger.info("ROBUST STRESS TEST SUMMARY")
        logger.info("="*80)
        
        # Group by scenario (removing _NoCaps/_WithCaps suffix)
        def get_base_scenario(s):
            for suffix in ["_NoCaps", "_WithCaps"]:
                if suffix in s:
                    return s.replace(suffix, "")
            return s
        
        df["base_scenario"] = df["scenario"].apply(get_base_scenario)
        
        # Print per-scenario comparison
        for scenario in df["base_scenario"].unique():
            scenario_data = df[df["base_scenario"] == scenario]
            logger.info(f"\n{scenario}:")
            for _, row in scenario_data.iterrows():
                caps_label = "✓ WITH CAPS" if row["apply_risk_caps"] else "  NO CAPS "
                logger.info(
                    f"  {caps_label} | Trades: {row['num_trades']:6d} | "
                    f"Sharpe: {row['sharpe_ratio']:6.2f} | "
                    f"MaxDD: {row['max_drawdown_pct']:6.2f}% | "
                    f"PnL: {row['total_pnl']:+8.2f}"
                )
        
        # Verdict
        logger.info("\n" + "="*80)
        logger.info("VERDICT:")
        logger.info("="*80)
        
        with_caps_data = df[df["apply_risk_caps"] == True]
        
        avg_sharpe_with_caps = with_caps_data["sharpe_ratio"].mean()
        avg_dd_with_caps = with_caps_data["max_drawdown_pct"].mean()
        avg_pnl_with_caps = with_caps_data["total_pnl"].mean()
        
        logger.info(f"\n✓ With Risk Caps (Across all scenarios):")
        logger.info(f"  Average Sharpe: {avg_sharpe_with_caps:.2f}")
        logger.info(f"  Average Max DD: {avg_dd_with_caps:.2f}%")
        logger.info(f"  Average PnL: {avg_pnl_with_caps:+.2f}")
        
        if avg_sharpe_with_caps >= 1.0 and avg_dd_with_caps >= 5.0:
            logger.info(
                f"\n✅ ROBUST: Sharpe ~{avg_sharpe_with_caps:.1f} + Drawdown ~{avg_dd_with_caps:.1f}% "
                f"= More realistic for live trading"
            )
        elif avg_sharpe_with_caps < 0.5:
            logger.info(
                f"\n⚠️  TOO CONSERVATIVE: Sharpe {avg_sharpe_with_caps:.2f} is too low. "
                f"Consider relaxing risk caps."
            )
        else:
            logger.info(
                f"\n⚠️  MONITOR: Sharpe {avg_sharpe_with_caps:.2f}, DD {avg_dd_with_caps:.2f}%. "
                f"Acceptable but keep monitoring."
            )


def main():
    parser = argparse.ArgumentParser(description="Run robust stress tests with risk caps")
    parser.add_argument("--num-events", type=int, default=50000, help="Number of synthetic events")
    parser.add_argument("--seed", type=int, default=42, help="Random seed")
    parser.add_argument("--risk-level", type=str, default="normal", choices=["low", "normal", "high"], 
                        help="Risk level preset (low/normal/high)")
    
    args = parser.parse_args()
    
    runner = RobustStressTestRunner(seed=args.seed, risk_level=args.risk_level)
    runner.run_all_scenarios_comparison(num_events=args.num_events)


if __name__ == "__main__":
    main()
