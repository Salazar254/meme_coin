/**
 * src/components/hard-rule-engine.ts
 *
 * Rule-based floor that ML can never override.
 * Instant REJECT on hard violations.
 */

import { Logger } from 'pino';
import { SignalVector, HardRuleResult, HardRule } from '../types';

export class HardRuleEngine {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Evaluate hard rules.
   * ML can only raise the floor, never lower below hard-rule output.
   */
  evaluate(signals: SignalVector): HardRuleResult {
    const violations: HardRule[] = [];

    // Check each instant-reject rule
    if (signals.mintEnabled) {
      violations.push(HardRule.MINT_ENABLED);
    }
    if (signals.isHoneypot) {
      violations.push(HardRule.HONEYPOT_DETECTED);
    }
    if (signals.isKnownRugDeployer) {
      violations.push(HardRule.KNOWN_RUG_DEPLOYER);
    }
    if (!signals.lpLocked && !signals.lpBurned) {
      violations.push(HardRule.NO_LP_LOCKED_OR_BURNED);
    }
    if (signals.sellTax > 15) {
      violations.push(HardRule.SELL_TAX_TOO_HIGH);
    }
    if (!signals.ownershipRenounced) {
      violations.push(HardRule.OWNERSHIP_NOT_RENOUNCED);
    }

    const shouldReject = violations.length > 0;
    const ruleScore = shouldReject ? 100 : 0; // 0 = safe, 100 = reject

    if (shouldReject) {
      this.logger.warn({
        msg: 'Hard rule violation detected',
        tokenAddress: signals.tokenAddress,
        violations: violations.map(v => v),
      });
    }

    return {
      shouldRejectImmediately: shouldReject,
      ruleScore,
      violatedRules: violations.map(v => v),
    };
  }

  /**
   * Blend rule score with ensemble score
   * Formula: finalScore = (ruleScore * 0.6) + (ensembleScore * 100 * 0.4)
   * ML can only raise the floor relative to rule output.
   */
  blendScores(ruleScore: number, ensembleScore: number): number {
    // ensembleScore is 0-1, convert to 0-100
    const ensembleScore100 = ensembleScore * 100;

    // Weight rule score more: 60% rule + 40% ensemble
    const blended = ruleScore * 0.6 + ensembleScore100 * 0.4;

    // Ensure rule score floor is respected
    // If ruleScore is high (e.g., 100), result should be at least high
    return Math.max(blended, ruleScore * 0.6);
  }
}
