/**
 * src/components/confidence-calibrator.ts
 *
 * Converts finalScore (0-100) to decision + positionSize + riskLevel.
 * Also applies DD-linked sizing to keep max DD around 30-35%.
 */

import { Logger } from 'pino';
import { CalibrationResult, PortfolioContext } from '../types';

export interface CalibrationThresholds {
  // Score bins
  buyLowThreshold: number; // 0-20
  buyHighThreshold: number; // 21-40
  smallThreshold: number; // 41-60
  skipThreshold: number; // 61-79
  rejectThreshold: number; // 80-100
  
  // Position sizes
  buyLowPositionSize: number;
  buyHighPositionSize: number;
  smallPositionSize: number;
  
  // DD thresholds for position reduction
  ddMediumThreshold: number; // 10%
  ddHighThreshold: number; // 20%
  ddMultiplierMedium: number; // 1.0
  ddMultiplierHigh: number; // 0.5
}

export const DEFAULT_CALIBRATION_THRESHOLDS: CalibrationThresholds = {
  buyLowThreshold: 20,
  buyHighThreshold: 40,
  smallThreshold: 60,
  skipThreshold: 79,
  rejectThreshold: 100,
  
  buyLowPositionSize: 1.0,
  buyHighPositionSize: 0.6,
  smallPositionSize: 0.25,
  
  ddMediumThreshold: 10,
  ddHighThreshold: 20,
  ddMultiplierMedium: 1.0,
  ddMultiplierHigh: 0.5,
};

/**
 * Calibrator: score → decision + position size + risk level
 */
export class ConfidenceCalibrator {
  private thresholds: CalibrationThresholds;
  private logger: Logger;

  constructor(thresholds?: CalibrationThresholds, logger?: Logger) {
    this.thresholds = thresholds || DEFAULT_CALIBRATION_THRESHOLDS;
    this.logger = logger || require('pino')();
  }

  /**
   * Main calibration: score → decision
   */
  calibrate(
    finalScore: number,
    portfolio?: PortfolioContext,
    conflictFlag?: boolean,
  ): CalibrationResult {
    // Base calibration from score
    const baseResult = this.scoreToDecision(finalScore);

    // Apply DD-linked reduction if portfolio provided
    let positionSize = baseResult.positionSize;
    if (portfolio) {
      const ddReduction = this.getDrawdownReduction(portfolio.currentDrawdownPct);
      positionSize *= ddReduction;
    }

    // Apply conflict penalty: halve position on disagreement
    if (conflictFlag) {
      positionSize *= 0.5;
    }

    return {
      decision: baseResult.decision,
      positionSize: Math.max(0, positionSize),
      riskLevel: baseResult.riskLevel,
      scoreRange: baseResult.scoreRange,
    };
  }

  /**
   * Score → decision mapping
   */
  private scoreToDecision(
    score: number,
  ): Omit<CalibrationResult, 'conflictFlag' | 'anomalyFlag'> {
    if (score <= this.thresholds.buyLowThreshold) {
      return {
        decision: 'BUY',
        positionSize: this.thresholds.buyLowPositionSize,
        riskLevel: 'LOW',
        scoreRange: [0, this.thresholds.buyLowThreshold],
      };
    }
    if (score <= this.thresholds.buyHighThreshold) {
      return {
        decision: 'BUY',
        positionSize: this.thresholds.buyHighPositionSize,
        riskLevel: 'LOW_MEDIUM',
        scoreRange: [
          this.thresholds.buyLowThreshold + 1,
          this.thresholds.buyHighThreshold,
        ],
      };
    }
    if (score <= this.thresholds.smallThreshold) {
      return {
        decision: 'SMALL',
        positionSize: this.thresholds.smallPositionSize,
        riskLevel: 'MEDIUM',
        scoreRange: [
          this.thresholds.buyHighThreshold + 1,
          this.thresholds.smallThreshold,
        ],
      };
    }
    if (score <= this.thresholds.skipThreshold) {
      return {
        decision: 'SKIP',
        positionSize: 0,
        riskLevel: 'HIGH',
        scoreRange: [
          this.thresholds.smallThreshold + 1,
          this.thresholds.skipThreshold,
        ],
      };
    }
    return {
      decision: 'REJECT',
      positionSize: 0,
      riskLevel: 'REJECT',
      scoreRange: [
        this.thresholds.skipThreshold + 1,
        this.thresholds.rejectThreshold,
      ],
    };
  }

  /**
   * DD-linked position reduction
   * If DD > 20% → multiply positionSize by 0.5
   * If DD > 10% → use full positionSize (no reduction)
   * Otherwise → use full positionSize
   */
  private getDrawdownReduction(currentDD: number): number {
    if (currentDD > this.thresholds.ddHighThreshold) {
      return this.thresholds.ddMultiplierHigh;
    }
    if (currentDD > this.thresholds.ddMediumThreshold) {
      return this.thresholds.ddMultiplierMedium;
    }
    return 1.0;
  }

  /**
   * Explain decision reasoning
   */
  explainDecision(score: number): string {
    if (score <= this.thresholds.buyLowThreshold) {
      return `Score ${score.toFixed(1)}: Excellent safety profile. BUY 100% position.`;
    }
    if (score <= this.thresholds.buyHighThreshold) {
      return `Score ${score.toFixed(1)}: Good safety profile. BUY 60% position.`;
    }
    if (score <= this.thresholds.smallThreshold) {
      return `Score ${score.toFixed(1)}: Moderate risk. SMALL 25% position.`;
    }
    if (score <= this.thresholds.skipThreshold) {
      return `Score ${score.toFixed(1)}: High risk. SKIP position.`;
    }
    return `Score ${score.toFixed(1)}: Extreme risk. REJECT position.`;
  }
}
