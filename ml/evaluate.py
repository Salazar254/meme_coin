"""
ml/evaluate.py — Anti-overfitting evaluation module.

Computes metrics for in-sample vs. out-of-sample performance,
detects overfitting, and generates diagnostic plots.

Key checks:
  1. Compare train vs. val/test metrics (Sharpe, AUC, win-rate)
  2. Noise sensitivity test (add small noise → compare performance drop)
  3. Visual diagnostics (PnL curves, metric comparison charts)
"""

import os
import logging
import numpy as np
from typing import Dict, Any, Optional

logger = logging.getLogger("ml.evaluate")


def evaluate_model(
    model,
    X_train: np.ndarray,
    y_train: np.ndarray,
    X_val: np.ndarray,
    y_val: np.ndarray,
    X_test: np.ndarray = None,
    y_test: np.ndarray = None,
    model_name: str = "Model",
) -> Dict[str, float]:
    """
    Compute comprehensive metrics for train, validation, and test sets.

    Returns dict with keys like train_auc, val_auc, test_auc, etc.
    """
    from sklearn.metrics import roc_auc_score, accuracy_score, precision_score, recall_score

    metrics = {}

    for split_name, X, y in [
        ("train", X_train, y_train),
        ("val", X_val, y_val),
        ("test", X_test, y_test),
    ]:
        if X is None or len(X) == 0:
            continue

        preds = model.predict_batch(X)
        binary_preds = (preds >= 0.5).astype(int)

        # AUC
        try:
            auc = roc_auc_score(y, preds) if len(np.unique(y)) > 1 else 0.5
        except Exception:
            auc = 0.5

        # Accuracy
        acc = accuracy_score(y, binary_preds)

        # Precision & Recall
        try:
            prec = precision_score(y, binary_preds, zero_division=0)
            rec = recall_score(y, binary_preds, zero_division=0)
        except Exception:
            prec = rec = 0

        # Win rate (of predicted positives)
        predicted_positive = binary_preds.sum()
        if predicted_positive > 0:
            win_rate = (y[binary_preds == 1] == 1).mean()
        else:
            win_rate = 0

        metrics[f"{split_name}_auc"] = auc
        metrics[f"{split_name}_accuracy"] = acc
        metrics[f"{split_name}_precision"] = prec
        metrics[f"{split_name}_recall"] = rec
        metrics[f"{split_name}_win_rate"] = win_rate
        metrics[f"{split_name}_n"] = len(X)

        logger.info(
            f"  [{model_name}] {split_name:5s} | AUC={auc:.4f} | Acc={acc:.4f} | "
            f"Prec={prec:.4f} | Rec={rec:.4f} | n={len(X)}"
        )

    # ── Noise sensitivity test ──
    noise_drop = _noise_sensitivity_test(model, X_val, y_val)
    metrics["noise_sensitivity"] = noise_drop
    logger.info(f"  [{model_name}] Noise sensitivity: AUC drop = {noise_drop:.4f}")

    return metrics


def check_overfit(
    metrics: Dict[str, float],
    model_name: str = "Model",
    auc_gap_threshold: float = 0.15,
    noise_sensitivity_threshold: float = 0.1,
) -> Dict[str, Any]:
    """
    Check for signs of overfitting.

    Flags:
      1. Large gap between train and val/test AUC
      2. High noise sensitivity (small noise causes big performance drop)
      3. Val/test AUC below random (0.5)

    Args:
        metrics: Output from evaluate_model()
        auc_gap_threshold: Flag if train-val AUC gap exceeds this
        noise_sensitivity_threshold: Flag if noise causes AUC drop > this

    Returns:
        Dict with warning messages and severity level
    """
    warnings = []
    severity = "OK"

    train_auc = metrics.get("train_auc", 0.5)
    val_auc = metrics.get("val_auc", 0.5)
    test_auc = metrics.get("test_auc", 0.5)
    noise_sens = metrics.get("noise_sensitivity", 0)

    # Check 1: Train vs. Validation gap
    train_val_gap = train_auc - val_auc
    if train_val_gap > auc_gap_threshold:
        warnings.append(
            f"⚠️  Train-Val AUC gap: {train_val_gap:.4f} (threshold: {auc_gap_threshold}). "
            f"Model may be memorizing training data."
        )
        severity = "WARNING"

    # Check 2: Train vs. Test gap (even more serious)
    if test_auc > 0:
        train_test_gap = train_auc - test_auc
        if train_test_gap > auc_gap_threshold * 1.5:
            warnings.append(
                f"🔴 Train-Test AUC gap: {train_test_gap:.4f}. "
                f"Strong overfitting detected!"
            )
            severity = "CRITICAL"

    # Check 3: Noise sensitivity
    if noise_sens > noise_sensitivity_threshold:
        warnings.append(
            f"⚠️  Noise sensitivity: {noise_sens:.4f} AUC drop. "
            f"Model is fragile to small input perturbations."
        )
        if severity == "OK":
            severity = "WARNING"

    # Check 4: Below-random performance
    if val_auc < 0.5:
        warnings.append(
            f"🔴 Val AUC ({val_auc:.4f}) is below random (0.5). "
            f"Model is worse than random guessing!"
        )
        severity = "CRITICAL"

    # Print results
    if warnings:
        for w in warnings:
            logger.warning(f"  [{model_name}] {w}")
    else:
        logger.info(f"  [{model_name}] ✅ No overfitting detected (severity: {severity})")

    return {
        "severity": severity,
        "warning": " | ".join(warnings) if warnings else "",
        "train_auc": train_auc,
        "val_auc": val_auc,
        "test_auc": test_auc,
        "noise_sensitivity": noise_sens,
        "train_val_gap": train_val_gap,
    }


def _noise_sensitivity_test(
    model,
    X: np.ndarray,
    y: np.ndarray,
    noise_std: float = 0.05,
    n_trials: int = 5,
) -> float:
    """
    Test model sensitivity to small random noise in features.

    Adds Gaussian noise and measures AUC drop. High sensitivity suggests
    the model is fitting to specific feature values rather than patterns.

    Returns:
        Mean AUC drop (positive = worse with noise)
    """
    from sklearn.metrics import roc_auc_score
    from ml.features import add_noise

    if X is None or len(X) == 0 or len(np.unique(y)) < 2:
        return 0.0

    # Baseline AUC
    baseline_preds = model.predict_batch(X)
    try:
        baseline_auc = roc_auc_score(y, baseline_preds)
    except Exception:
        return 0.0

    # Noisy AUCs
    noisy_aucs = []
    for _ in range(n_trials):
        X_noisy = add_noise(X, noise_std)
        noisy_preds = model.predict_batch(X_noisy)
        try:
            noisy_auc = roc_auc_score(y, noisy_preds)
            noisy_aucs.append(noisy_auc)
        except Exception:
            pass

    if not noisy_aucs:
        return 0.0

    mean_noisy_auc = np.mean(noisy_aucs)
    return max(0, baseline_auc - mean_noisy_auc)


# ─── Plotting utilities ───

def plot_training_curves(history: Dict[str, list], model_name: str = "NN"):
    """Plot training and validation loss curves."""
    try:
        import matplotlib.pyplot as plt

        fig, axes = plt.subplots(1, 2, figsize=(14, 5))

        # Loss
        if "train_loss" in history and history["train_loss"]:
            axes[0].plot(history["train_loss"], label="Train Loss", color="#ff6b6b")
        if "val_loss" in history and history["val_loss"]:
            axes[0].plot(history["val_loss"], label="Val Loss", color="#4ecdc4")
        axes[0].set_title(f"{model_name} — Loss")
        axes[0].set_xlabel("Epoch")
        axes[0].set_ylabel("Loss")
        axes[0].legend()
        axes[0].grid(True, alpha=0.3)

        # AUC
        if "val_auc" in history and history["val_auc"]:
            axes[1].plot(history["val_auc"], label="Val AUC", color="#45b7d1")
        axes[1].set_title(f"{model_name} — Validation AUC")
        axes[1].set_xlabel("Epoch")
        axes[1].set_ylabel("AUC")
        axes[1].legend()
        axes[1].grid(True, alpha=0.3)
        axes[1].axhline(y=0.5, color="gray", linestyle="--", alpha=0.5, label="Random")

        plt.tight_layout()
        os.makedirs("data", exist_ok=True)
        plt.savefig(f"data/{model_name.lower()}_training_curves.png", dpi=150)
        plt.close()
        logger.info(f"📈 Training curves saved: data/{model_name.lower()}_training_curves.png")

    except ImportError:
        logger.warning("matplotlib not installed — skipping training curve plot")


def plot_feature_importance(importance: Dict[str, float]):
    """Plot XGBoost feature importance as a horizontal bar chart."""
    try:
        import matplotlib.pyplot as plt

        if not importance:
            return

        sorted_feats = sorted(importance.items(), key=lambda x: x[1], reverse=True)
        names = [f[0] for f in sorted_feats]
        values = [f[1] for f in sorted_feats]

        fig, ax = plt.subplots(figsize=(10, 6))
        colors = plt.cm.viridis(np.linspace(0.3, 0.9, len(names)))
        ax.barh(names, values, color=colors)
        ax.set_title("XGBoost Feature Importance", fontsize=14, fontweight="bold")
        ax.set_xlabel("Importance")
        ax.invert_yaxis()
        ax.grid(True, alpha=0.3, axis="x")

        plt.tight_layout()
        os.makedirs("data", exist_ok=True)
        plt.savefig("data/feature_importance.png", dpi=150)
        plt.close()
        logger.info("📊 Feature importance saved: data/feature_importance.png")

    except ImportError:
        logger.warning("matplotlib not installed — skipping feature importance plot")


def compare_in_out_sample(nn_metrics: Dict, xgb_metrics: Dict):
    """Plot side-by-side comparison of in-sample vs out-of-sample performance."""
    try:
        import matplotlib.pyplot as plt

        fig, ax = plt.subplots(figsize=(10, 6))

        splits = ["train", "val", "test"]
        nn_aucs = [nn_metrics.get(f"{s}_auc", 0) for s in splits]
        xgb_aucs = [xgb_metrics.get(f"{s}_auc", 0) for s in splits]

        x = np.arange(len(splits))
        width = 0.35

        bars1 = ax.bar(x - width / 2, nn_aucs, width, label="Neural Network", color="#ff6b6b", alpha=0.8)
        bars2 = ax.bar(x + width / 2, xgb_aucs, width, label="XGBoost", color="#4ecdc4", alpha=0.8)

        ax.set_ylabel("AUC")
        ax.set_title("In-Sample vs Out-of-Sample Performance", fontsize=14, fontweight="bold")
        ax.set_xticks(x)
        ax.set_xticklabels(["Train", "Validation", "Test"])
        ax.legend()
        ax.axhline(y=0.5, color="gray", linestyle="--", alpha=0.5, label="Random baseline")
        ax.set_ylim(0, 1)
        ax.grid(True, alpha=0.3, axis="y")

        # Value labels
        for bars in [bars1, bars2]:
            for bar in bars:
                height = bar.get_height()
                ax.annotate(f'{height:.3f}', xy=(bar.get_x() + bar.get_width() / 2, height),
                            xytext=(0, 3), textcoords="offset points", ha='center', va='bottom', fontsize=9)

        plt.tight_layout()
        os.makedirs("data", exist_ok=True)
        plt.savefig("data/in_vs_out_sample.png", dpi=150)
        plt.close()
        logger.info("📊 In vs. out sample comparison saved: data/in_vs_out_sample.png")

    except ImportError:
        logger.warning("matplotlib not installed — skipping comparison plot")
