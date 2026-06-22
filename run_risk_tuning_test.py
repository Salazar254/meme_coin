#!/usr/bin/env python3
"""
run_risk_tuning_test.py - Test all risk levels (low/normal/high) and compare results.

This script runs the robust stress test with each risk level and produces a summary
showing how Sharpe ratio, drawdown, and PnL scale across different risk configurations.

Usage:
    python run_risk_tuning_test.py
"""

import logging
import os
import subprocess
import sys
from pathlib import Path
from typing import Dict, List

import pandas as pd

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

RISK_LEVELS = ["low", "normal", "high"]


def run_stress_test_with_level(risk_level: str) -> str:
    """Run robust stress tests with a specific risk level.
    
    Args:
        risk_level: "low", "normal", or "high"
        
    Returns:
        Path to output CSV file
    """
    logger.info(f"\n{'='*80}")
    logger.info(f"🎯 Testing risk_level='{risk_level}'")
    logger.info(f"{'='*80}\n")
    
    # Set environment variable for the risk level
    env = os.environ.copy()
    env["RISK_LEVEL"] = risk_level
    
    # Run the robust stress test with this risk level
    # (assumes run_robust_stress_tests.py can be invoked with RISK_LEVEL env var)
    cmd = [
        sys.executable,
        "run_robust_stress_tests.py",
        "--risk-level", risk_level,
    ]
    
    try:
        result = subprocess.run(
            cmd,
            env=env,
            cwd=Path(__file__).parent,
            capture_output=False,
            text=True,
            timeout=600,  # 10 minute timeout
        )
        if result.returncode != 0:
            logger.warning(f"⚠️  Stress test for risk_level='{risk_level}' exited with code {result.returncode}")
        else:
            logger.info(f"✅ Stress test for risk_level='{risk_level}' completed successfully")
    except subprocess.TimeoutExpired:
        logger.error(f"❌ Stress test for risk_level='{risk_level}' timed out after 10 minutes")
        raise
    except Exception as e:
        logger.error(f"❌ Error running stress test for risk_level='{risk_level}': {e}")
        raise
    
    return "results/robust_stress_results.csv"


def summarize_results(csv_path: str) -> Dict[str, float]:
    """Summarize results from a robust stress test CSV.
    
    Args:
        csv_path: Path to robust_stress_results.csv
        
    Returns:
        Dict with metrics: avg_sharpe, avg_dd_pct, avg_pnl_sol
    """
    df = pd.read_csv(csv_path)
    
    metrics = {
        "avg_sharpe": df["sharpe_ratio"].mean(),
        "avg_dd_pct": df["max_drawdown_pct"].mean(),
        "avg_pnl_sol": df["total_pnl"].mean(),
        "avg_profit_factor": df["profit_factor"].mean(),
        "avg_win_rate": df["win_rate"].mean() / 100.0,  # Convert from percentage
        "num_scenarios": len(df),
    }
    
    return metrics


def main():
    """Run stress tests for all risk levels and compare results."""
    
    logger.info(f"\n{'#'*80}")
    logger.info("# 🚀 RISK LEVEL TUNING TEST SUITE")
    logger.info(f"# Testing low / normal / high on robust stress test (10 scenarios @ 50K events each)")
    logger.info(f"{'#'*80}\n")
    
    results = {}
    
    # Run tests for each risk level
    for level in RISK_LEVELS:
        logger.info(f"\n{'='*80}")
        logger.info(f"📊 Risk Level: '{level}'")
        logger.info(f"{'='*80}")
        
        try:
            csv_path = run_stress_test_with_level(level)
            metrics = summarize_results(csv_path)
            results[level] = metrics
            
            logger.info(f"\n✅ Results for risk_level='{level}':")
            logger.info(f"   Avg Sharpe Ratio:     {metrics['avg_sharpe']:.2f}")
            logger.info(f"   Avg Max Drawdown:     {metrics['avg_dd_pct']:.2f}%")
            logger.info(f"   Avg Total PnL:        {metrics['avg_pnl_sol']:,.0f} SOL")
            logger.info(f"   Avg Profit Factor:    {metrics['avg_profit_factor']:.2f}x")
            logger.info(f"   Avg Win Rate:         {metrics['avg_win_rate']:.1%}")
            logger.info(f"   Scenarios Tested:     {metrics['num_scenarios']}")
            
        except Exception as e:
            logger.error(f"❌ Failed to test risk_level='{level}': {e}")
            import traceback
            traceback.print_exc()
            # Continue to next level
            continue
    
    # Print comparison table
    logger.info(f"\n{'='*80}")
    logger.info("📈 RISK LEVEL COMPARISON")
    logger.info(f"{'='*80}\n")
    
    if not results:
        logger.error("❌ No results obtained. Tests may have failed.")
        return 1
    
    # Create comparison DataFrame
    comparison_data = []
    for level in RISK_LEVELS:
        if level in results:
            metrics = results[level]
            comparison_data.append({
                "Risk Level": level.upper(),
                "Avg Sharpe": f"{metrics['avg_sharpe']:.2f}",
                "Avg DD %": f"{metrics['avg_dd_pct']:.2f}%",
                "Avg PnL": f"{metrics['avg_pnl_sol']:,.0f} SOL",
                "Profit Factor": f"{metrics['avg_profit_factor']:.2f}x",
                "Win Rate": f"{metrics['avg_win_rate']:.1%}",
            })
    
    comparison_df = pd.DataFrame(comparison_data)
    
    print(comparison_df.to_string(index=False))
    print()
    
    # Analysis and recommendations
    logger.info(f"{'='*80}")
    logger.info("🎯 ANALYSIS & RECOMMENDATIONS")
    logger.info(f"{'='*80}\n")
    
    if "normal" in results:
        sharpe_normal = results["normal"]["avg_sharpe"]
        dd_normal = results["normal"]["avg_dd_pct"]
        pnl_normal = results["normal"]["avg_pnl_sol"]
        
        logger.info("📊 Normal Mode (Recommended for Production):")
        sharpe_msg = f"   Sharpe: {sharpe_normal:.2f}"
        if 0.6 <= sharpe_normal <= 0.8:
            sharpe_msg += " ✅ TARGET ACHIEVED"
        elif sharpe_normal < 0.6:
            sharpe_msg += " ⚠️  Below target, consider risk_level='high'"
        else:
            sharpe_msg += " 🚀 Exceeds target, consider scaling capital"
        logger.info(sharpe_msg)
        
        dd_msg = f"   DD: {dd_normal:.2f}%"
        if 25 <= dd_normal <= 35:
            dd_msg += " ✅ ACCEPTABLE"
        elif dd_normal < 25:
            dd_msg += " ✅ Conservative"
        else:
            dd_msg += " ⚠️  Higher than preferred"
        logger.info(dd_msg)
        
        logger.info(f"   PnL: {pnl_normal:,.0f} SOL")
    
    if "low" in results and "normal" in results:
        sharpe_improvement = (results["normal"]["avg_sharpe"] - results["low"]["avg_sharpe"]) / max(results["low"]["avg_sharpe"], 0.01)
        logger.info(f"📈 Improvement from Low to Normal:")
        logger.info(f"   Sharpe delta: {sharpe_improvement*100:+.1f}%")
        logger.info(f"   PnL delta: {((results['normal']['avg_pnl_sol'] - results['low']['avg_pnl_sol']) / results['low']['avg_pnl_sol'] * 100):+.1f}%\n")
    
    if "normal" in results and "high" in results:
        sharpe_increase = results["high"]["avg_sharpe"] - results["normal"]["avg_sharpe"]
        dd_increase = results["high"]["avg_dd_pct"] - results["normal"]["avg_dd_pct"]
        logger.info(f"🔥 Progressive Scaling (Normal → High):")
        logger.info(f"   Sharpe change: {sharpe_increase:+.2f}")
        logger.info(f"   DD change: {dd_increase:+.2f}pp")
        logger.info(f"   PnL change: {((results['high']['avg_pnl_sol'] - results['normal']['avg_pnl_sol']) / results['normal']['avg_pnl_sol'] * 100):+.1f}%\n")
    
    # Recommendation
    logger.info(f"{'='*80}")
    logger.info("✅ NEXT STEPS")
    logger.info(f"{'='*80}\n")
    
    if "normal" in results:
        sharpe_normal = results["normal"]["avg_sharpe"]
        dd_normal = results["normal"]["avg_dd_pct"]
        
        if 0.6 <= sharpe_normal <= 0.8 and 25 <= dd_normal <= 35:
            logger.info("✅ Your 'normal' risk_level is OPTIMIZED!")
            logger.info("   1. Deploy with risk_level='normal' to live")
            logger.info("   2. Monitor for 1-2 weeks")
            logger.info("   3. If consistent: scale capital or move to 'high'\n")
        elif sharpe_normal < 0.6:
            logger.info("⚠️  Sharpe is below target (0.6-0.8):")
            if "high" in results and results["high"]["avg_sharpe"] > 0.65:
                logger.info("   → Consider moving to risk_level='high' for better Sharpe")
            logger.info("   → Or check rug-filter accuracy / ML model training\n")
        else:
            logger.info("🚀 Sharpe exceeds target!")
            logger.info("   → Consider scaling capital while maintaining risk_level='normal'")
            logger.info("   → Or move to risk_level='high' for even more aggressive edge capture\n")
    
    # Save results to JSON for tracking
    import json
    results_file = Path("results/risk_tuning_results.json")
    with open(results_file, "w") as f:
        json.dump({k: v for k, v in results.items()}, f, indent=2, default=str)
    logger.info(f"📁 Results saved to: {results_file}\n")
    
    logger.info(f"{'='*80}")
    logger.info("✅ TUNING TEST COMPLETE")
    logger.info(f"{'='*80}\n")
    
    return 0


if __name__ == "__main__":
    sys.exit(main())
