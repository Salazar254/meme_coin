"""
quick_test.py — Smoke test with small event count to verify setup

Run this first to ensure everything works before running full 1M+ tests.
"""

import sys
import os
import logging

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def run_quick_test():
    """Run a quick smoke test with 5K events."""
    logger.info("🧪 Starting quick smoke test…")
    
    try:
        # Import the scenario runner
        from run_million_scenario_tests import (
            EventDataGenerator,
            HighVolumeScenarioRunner,
            ScenarioConfig,
        )
        
        logger.info("✅ Imports successful")
        
        # Generate small event set
        logger.info("📊 Generating 5,000 synthetic events…")
        gen = EventDataGenerator(seed=42)
        events = gen.generate_events(5000)
        logger.info(f"✅ {len(events)} events generated")
        
        # Run quick scenarios
        runner = HighVolumeScenarioRunner(seed=42)
        
        # Scenario A: Base case (minimal)
        logger.info("\n🎯 Running Scenario A (base case) on 5K events…")
        scenario_a = ScenarioConfig(
            name="A_QuickTest",
            description="Quick smoke test",
        )
        runner.run_scenario(events, scenario_a)
        
        # Save results
        logger.info("\n💾 Saving results…")
        df = runner.save_results("results/quick_test_results.csv")
        
        logger.info("\n📊 Quick Test Results:")
        logger.info(df.to_string())
        
        # Verify metrics are computed
        if len(df) > 0:
            first_row = df.iloc[0]
            logger.info(f"\n✅ Metrics computed successfully:")
            logger.info(f"   Trades: {first_row['num_trades']}")
            logger.info(f"   Sharpe: {first_row['sharpe_ratio']:.2f}")
            logger.info(f"   Win Rate: {first_row['win_rate']:.1%}")
            logger.info(f"   Daily PnL: {first_row['daily_pnl_sol']:.2f} SOL")
        
        logger.info("\n✅ Smoke test PASSED!")
        logger.info("\n🚀 Ready to run full tests:")
        logger.info("   python run_million_scenario_tests.py --num-events 100000 --scenarios A,B,C,D,E")
        
        return True
        
    except Exception as e:
        logger.error(f"❌ Smoke test FAILED: {e}", exc_info=True)
        return False


if __name__ == "__main__":
    success = run_quick_test()
    sys.exit(0 if success else 1)
