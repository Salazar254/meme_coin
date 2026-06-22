"""
backtest/metrics.py — PnL metrics, Sharpe ratio, drawdown, and reporting.

Computes key performance indicators from backtest results and provides
formatted output for analysis.
"""

import numpy as np
from typing import Dict, Any, List
from rich.console import Console
from rich.table import Table

console = Console()


def compute_metrics(
    trades: List[Dict[str, Any]],
    equity_curve: List[Dict[str, Any]],
    initial_bankroll: float,
) -> Dict[str, Any]:
    """
    Compute comprehensive backtest metrics.

    Args:
        trades: List of closed trade dicts
        equity_curve: List of {time, equity} dicts
        initial_bankroll: Starting capital in SOL

    Returns:
        Dict with all computed metrics
    """
    if not trades:
        return _empty_metrics()

    # ── Basic stats ──
    pnls = [t.get("pnl_sol", 0) for t in trades]
    pnl_pcts = [t.get("pnl_pct", 0) for t in trades]

    total_trades = len(trades)
    winning = [p for p in pnls if p > 0]
    losing = [p for p in pnls if p < 0]

    win_rate = len(winning) / total_trades if total_trades > 0 else 0
    avg_win = np.mean(winning) if winning else 0
    avg_loss = np.mean(losing) if losing else 0

    total_pnl = sum(pnls)
    total_pnl_pct = total_pnl / initial_bankroll if initial_bankroll > 0 else 0

    # ── Equity curve analysis ──
    equities = [e["equity"] for e in equity_curve]
    peak = equities[0]
    max_drawdown = 0
    max_drawdown_pct = 0

    for eq in equities:
        if eq > peak:
            peak = eq
        dd = peak - eq
        dd_pct = dd / peak if peak > 0 else 0
        if dd_pct > max_drawdown_pct:
            max_drawdown = dd
            max_drawdown_pct = dd_pct

    # ── Sharpe ratio (annualized, assuming ~365 trading days) ──
    if len(pnl_pcts) > 1:
        returns = np.array(pnl_pcts)
        sharpe = (np.mean(returns) / np.std(returns)) * np.sqrt(365) if np.std(returns) > 0 else 0
    else:
        sharpe = 0

    # ── Profit factor ──
    gross_profit = sum(winning)
    gross_loss = abs(sum(losing))
    profit_factor = gross_profit / gross_loss if gross_loss > 0 else float("inf")

    # ── Expectancy ──
    expectancy = np.mean(pnls) if pnls else 0

    final_equity = equities[-1] if equities else initial_bankroll

    return {
        "total_trades": total_trades,
        "winning_trades": len(winning),
        "losing_trades": len(losing),
        "win_rate": win_rate,
        "total_pnl_sol": total_pnl,
        "total_pnl_pct": total_pnl_pct,
        "avg_win_sol": avg_win,
        "avg_loss_sol": avg_loss,
        "max_drawdown_sol": max_drawdown,
        "max_drawdown_pct": max_drawdown_pct,
        "sharpe_ratio": sharpe,
        "profit_factor": profit_factor,
        "expectancy_sol": expectancy,
        "initial_bankroll": initial_bankroll,
        "final_equity": final_equity,
    }


def _empty_metrics() -> Dict[str, Any]:
    return {
        "total_trades": 0, "winning_trades": 0, "losing_trades": 0,
        "win_rate": 0, "total_pnl_sol": 0, "total_pnl_pct": 0,
        "avg_win_sol": 0, "avg_loss_sol": 0, "max_drawdown_sol": 0,
        "max_drawdown_pct": 0, "sharpe_ratio": 0, "profit_factor": 0,
        "expectancy_sol": 0, "initial_bankroll": 0, "final_equity": 0,
    }


def print_metrics(results: Dict[str, Any]):
    """Pretty-print backtest results using Rich tables."""
    metrics = results.get("metrics", {})
    trades = results.get("trades", [])

    if not metrics or metrics.get("total_trades", 0) == 0:
        console.print("\n[yellow]⚠️  No trades executed during backtest.[/yellow]\n")
        return

    # ── Summary table ──
    table = Table(title="📊 Backtest Results", show_header=True, header_style="bold cyan")
    table.add_column("Metric", style="dim")
    table.add_column("Value", justify="right")

    table.add_row("Total Trades", str(metrics["total_trades"]))
    table.add_row("Win / Loss", f"{metrics['winning_trades']} / {metrics['losing_trades']}")
    table.add_row("Win Rate", f"{metrics['win_rate']*100:.1f}%")
    table.add_row("", "")
    table.add_row("Total PnL (SOL)", f"{metrics['total_pnl_sol']:+.4f}")
    table.add_row("Total PnL (%)", f"{metrics['total_pnl_pct']*100:+.1f}%")
    table.add_row("Avg Win (SOL)", f"{metrics['avg_win_sol']:+.4f}")
    table.add_row("Avg Loss (SOL)", f"{metrics['avg_loss_sol']:+.4f}")
    table.add_row("", "")
    table.add_row("Sharpe Ratio", f"{metrics['sharpe_ratio']:.2f}")
    table.add_row("Profit Factor", f"{metrics['profit_factor']:.2f}")
    table.add_row("Expectancy (SOL)", f"{metrics['expectancy_sol']:+.4f}")
    table.add_row("", "")
    table.add_row("Max Drawdown (SOL)", f"{metrics['max_drawdown_sol']:.4f}")
    table.add_row("Max Drawdown (%)", f"{metrics['max_drawdown_pct']*100:.1f}%")
    table.add_row("", "")
    table.add_row("Initial Bankroll", f"{metrics['initial_bankroll']:.4f} SOL")
    table.add_row("Final Equity", f"{metrics['final_equity']:.4f} SOL")

    console.print()
    console.print(table)
    console.print()

    # ── Save equity curve plot if matplotlib available ──
    try:
        _plot_equity_curve(results.get("equity_curve", []))
    except ImportError:
        console.print("[dim]Install matplotlib to see equity curve plots[/dim]")


def _plot_equity_curve(equity_curve: List[Dict[str, Any]]):
    """Save an equity curve plot to the data/ directory."""
    if not equity_curve or len(equity_curve) < 2:
        return

    import matplotlib.pyplot as plt
    import matplotlib.dates as mdates
    from datetime import datetime

    times = [datetime.fromtimestamp(e["time"]) for e in equity_curve]
    equities = [e["equity"] for e in equity_curve]

    fig, ax = plt.subplots(figsize=(12, 5))
    ax.plot(times, equities, linewidth=1.5, color="#00d4aa")
    ax.fill_between(times, equities, alpha=0.1, color="#00d4aa")
    ax.set_title("Equity Curve", fontsize=14, fontweight="bold")
    ax.set_xlabel("Time")
    ax.set_ylabel("Equity (SOL)")
    ax.grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("data/equity_curve.png", dpi=150)
    plt.close()

    console.print("[green]📈 Equity curve saved to data/equity_curve.png[/green]")
