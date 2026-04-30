"""Display stress test results."""
import pandas as pd

df = pd.read_csv('results/scenario_results.csv')

print('\n' + '='*140)
print('📊 STRESS TEST RESULTS SUMMARY')
print('='*140)
print(df[['scenario', 'param_name', 'num_trades', 'win_rate', 'sharpe_ratio', 'profit_factor', 'pnl_pct', 'max_drawdown_pct']].to_string(index=False))

print('\n' + '='*140)
print('⚠️  OVERFITTING FLAGS DETECTED')
print('='*140)
for idx, row in df.iterrows():
    scenario = row['scenario']
    flags = row['overfitting_flags']
    if flags and pd.notna(flags):
        print(f"{scenario:30} | {flags}")

print('\n' + '='*140)
print('📈 SCENARIO COMPARISON')
print('='*140)
comparison = df.groupby('scenario')[['sharpe_ratio', 'profit_factor', 'pnl_pct', 'max_drawdown_pct']].mean()
print(comparison)

print('\n' + '='*140)
print('🎯 KEY FINDINGS')
print('='*140)
print(f"Total runs: {len(df)}")
print(f"Best Sharpe: {df['sharpe_ratio'].max():.2f} (Scenario: {df.loc[df['sharpe_ratio'].idxmax(), 'scenario']})")
print(f"Worst Sharpe: {df['sharpe_ratio'].min():.2f} (Scenario: {df.loc[df['sharpe_ratio'].idxmin(), 'scenario']})")
print(f"Best Win Rate: {df['win_rate'].max():.1%} (Scenario: {df.loc[df['win_rate'].idxmax(), 'scenario']})")
print(f"Avg PnL: {df['pnl_pct'].mean():.1%}")
print(f"Avg Max Drawdown: {df['max_drawdown_pct'].mean():.2%}")

flagged = df[df['overfitting_flags'].notna()]
if len(flagged) > 0:
    print(f"\n⚠️  🚨 {len(flagged)}/{len(df)} scenarios flagged for overfitting signals!")
    print("\nInterpretation:")
    if 'EXTREME_SHARPE_LOW_DD' in '|'.join(flagged['overfitting_flags']):
        print("  • Sharpe > 3.0 with Max DD < 5% = Suspicious/Likely overfit")
    if 'HIGH_PF_LOW_WR' in '|'.join(flagged['overfitting_flags']):
        print("  • Profit Factor > 8 with Win Rate < 40% = Few wins carry trade")
else:
    print(f"\n✅ No major overfitting flags detected!")

print('\n' + '='*140)
