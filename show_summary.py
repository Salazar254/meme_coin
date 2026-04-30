#!/usr/bin/env python3
"""Show comprehensive test summary."""

import pandas as pd
from datetime import datetime

print('='*90)
print('🎯 MEMECOIN BOT - COMPREHENSIVE TEST SUMMARY')
print('='*90)
print(f'Generated: {datetime.now().strftime("%Y-%m-%d %H:%M:%S")}')
print()

# Quick Test Results
print('📊 QUICK TEST (5,000 events)')
print('-' * 90)
quick_df = pd.read_csv('results/quick_test_results.csv')
for _, row in quick_df.iterrows():
    print(f'  Scenario: {row["scenario"]}')
    print(f'    • Trades: {int(row["num_trades"])} (Win Rate: {row["win_rate"]:.1%})')
    print(f'    • Sharpe Ratio: {row["sharpe_ratio"]:.2f}')
    print(f'    • Daily PnL: {row["daily_pnl_sol"]:.2f} SOL')
    print(f'    • Max Drawdown: {row["max_drawdown_pct"]:.2f}%')
    print(f'    • Profit Factor: {row["profit_factor"]:.2f}x')
    print()

# Robust Stress Test Results
print('💪 ROBUST STRESS TEST (50,000 events per scenario)')
print('-' * 90)
robust_df = pd.read_csv('results/robust_stress_results.csv')

# Display summary table
summary_df = robust_df[['scenario', 'num_trades', 'win_rate', 'sharpe_ratio', 'total_pnl', 'max_drawdown_pct']].copy()
summary_df['win_rate'] = summary_df['win_rate'].apply(lambda x: f'{x/100:.1%}')
summary_df['sharpe_ratio'] = summary_df['sharpe_ratio'].apply(lambda x: f'{x:.2f}')
summary_df['total_pnl'] = summary_df['total_pnl'].apply(lambda x: f'{x:,.0f}')
summary_df['max_drawdown_pct'] = summary_df['max_drawdown_pct'].apply(lambda x: f'{x:.2f}%')
print(summary_df.to_string(index=False))
print()

# Summary Statistics
print('📈 KEY METRICS SUMMARY')
print('-' * 90)
scenarios_with_caps = robust_df[robust_df['scenario'].str.contains('WithCaps')]
scenarios_no_caps = robust_df[~robust_df['scenario'].str.contains('WithCaps')]

print('With Risk Caps (Normal Operation):')
if len(scenarios_with_caps) > 0:
    avg_sharpe_caps = scenarios_with_caps['sharpe_ratio'].mean()
    avg_dd_caps = scenarios_with_caps['max_drawdown_pct'].mean()
    avg_pnl_caps = scenarios_with_caps['total_pnl'].mean()
    print(f'  • Avg Sharpe: {avg_sharpe_caps:.2f}')
    print(f'  • Avg Max DD: {avg_dd_caps:.2f}%')
    print(f'  • Avg Total PnL: {avg_pnl_caps:,.2f} SOL')
    print(f'  • Scenarios: {len(scenarios_with_caps)}')

print()
print('Without Risk Caps (Unrestricted):')
if len(scenarios_no_caps) > 0:
    avg_sharpe_nocaps = scenarios_no_caps['sharpe_ratio'].mean()
    avg_dd_nocaps = scenarios_no_caps['max_drawdown_pct'].mean()
    avg_pnl_nocaps = scenarios_no_caps['total_pnl'].mean()
    print(f'  • Avg Sharpe: {avg_sharpe_nocaps:.2f}')
    print(f'  • Avg Max DD: {avg_dd_nocaps:.2f}%')
    print(f'  • Avg Total PnL: {avg_pnl_nocaps:,.2f} SOL')
    print(f'  • Scenarios: {len(scenarios_no_caps)}')

print()
print('✅ PERFORMANCE ASSESSMENT')
print('-' * 90)

# Risk caps effectiveness
caps_df = robust_df[robust_df['scenario'].str.contains('WithCaps')]
no_caps_df = robust_df[~robust_df['scenario'].str.contains('WithCaps')]

# Match pairs
scenarios = set([s.replace('_WithCaps', '').replace('_NoCaps', '') for s in robust_df['scenario']])
print('Risk Management Effectiveness (caps vs no caps):')
for scenario_base in sorted(scenarios):
    caps_row = robust_df[robust_df['scenario'] == f'{scenario_base}_WithCaps']
    no_caps_row = robust_df[robust_df['scenario'] == f'{scenario_base}_NoCaps']
    
    if len(caps_row) > 0 and len(no_caps_row) > 0:
        caps_dd = caps_row['max_drawdown_pct'].values[0]
        no_caps_dd = no_caps_row['max_drawdown_pct'].values[0]
        caps_sharpe = caps_row['sharpe_ratio'].values[0]
        no_caps_sharpe = no_caps_row['sharpe_ratio'].values[0]
        
        dd_change = caps_dd - no_caps_dd
        sharpe_change = caps_sharpe - no_caps_sharpe
        
        print(f'  • {scenario_base}:')
        print(f'      DD: {no_caps_dd:.2f}% → {caps_dd:.2f}% ({dd_change:+.2f}pp)')
        print(f'      Sharpe: {no_caps_sharpe:.2f} → {caps_sharpe:.2f} ({sharpe_change:+.2f})')

print()
print('💎 EDGE DETECTION:')
print('-' * 90)
avg_win_rate = robust_df['win_rate'].mean()
avg_profit_factor = robust_df['profit_factor'].mean()
avg_sharpe_all = robust_df['sharpe_ratio'].mean()

print(f'  • Across all scenarios:')
print(f'      Win Rate: {avg_win_rate/100:.1%}')
print(f'      Profit Factor: {avg_profit_factor:.2f}x (edge when > 1.5x)')
print(f'      Sharpe Ratio: {avg_sharpe_all:.2f} (target: > 0.6)')
print(f'      Status: {"✅ EDGE DETECTED" if avg_profit_factor > 1.5 else "⚠️  WEAK EDGE"}')

print()
print('=' * 90)
print('Tests still running... Check log files for ongoing progress.')
print('='*90)
