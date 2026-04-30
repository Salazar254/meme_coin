/**
 * src/persistence/feedback-logger.ts
 *
 * SQLite-backed feedback persistence.
 * Logs every decision + 48h outcome for continual learning.
 * Computes rich reward signals.
 */

import Database from 'better-sqlite3';
import { Logger } from 'pino';
import { FeedbackRecord, RugFilterDecision, SignalVector } from '../types';

/**
 * Feedback logger: persists decisions to SQLite
 */
export class FeedbackLogger {
  private db: Database.Database;
  private logger: Logger;

  constructor(dbPath: string, logger: Logger) {
    this.logger = logger;
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initializeSchema();
  }

  /**
   * Initialize or migrate database schema
   */
  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS feedback_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        address TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        
        -- Decision details
        decision_str TEXT NOT NULL,
        position_size REAL NOT NULL,
        risk_level TEXT NOT NULL,
        score REAL NOT NULL,
        
        -- Signal vector (stored as JSON)
        signal_vector_json TEXT NOT NULL,
        
        -- Outcome (labeled 48h later)
        outcome TEXT,
        price_48h_later REAL,
        price_peak REAL,
        price_peak_time INTEGER,
        
        -- Reward signal
        reward_signal REAL,
        
        -- Label status
        labeled INTEGER DEFAULT 0,
        labeled_at INTEGER,
        
        -- Timestamps
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        
        UNIQUE(address, timestamp)
      );

      CREATE INDEX IF NOT EXISTS idx_feedback_address ON feedback_records(address);
      CREATE INDEX IF NOT EXISTS idx_feedback_labeled ON feedback_records(labeled);
      CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback_records(created_at);

      CREATE TABLE IF NOT EXISTS regime_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        miss_rate_48h REAL NOT NULL,
        miss_rate_week REAL NOT NULL,
        regime TEXT NOT NULL,
        decaying_signals_json TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_regime_timestamp ON regime_history(timestamp);
    `);
  }

  /**
   * Log a decision
   */
  logDecision(
    signalVector: SignalVector,
    decision: RugFilterDecision,
  ): FeedbackRecord {
    const now = Date.now();
    const feedbackRecord: FeedbackRecord = {
      tokenAddress: decision.tokenAddress,
      timestamp: decision.timestamp,
      signalVector,
      decision,
      outcome: undefined,
      labeled: false,
      createdAt: now,
    };

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO feedback_records (
        address, timestamp, decision_str, position_size, risk_level, score,
        signal_vector_json, labeled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `);

    stmt.run(
      decision.tokenAddress,
      decision.timestamp,
      decision.decision,
      decision.positionSize,
      decision.riskLevel,
      decision.finalScore,
      JSON.stringify(signalVector),
      now,
      now,
    );

    this.logger.debug({
      msg: 'Decision logged',
      tokenAddress: decision.tokenAddress,
      decision: decision.decision,
      score: decision.finalScore.toFixed(1),
    });

    return feedbackRecord;
  }

  /**
   * Get unlabeled decisions (waiting for 48h outcomes)
   */
  getUnlabeledDecisions(limitMs: number = 48 * 60 * 60 * 1000): FeedbackRecord[] {
    const since = Date.now() - limitMs;

    const stmt = this.db.prepare(`
      SELECT 
        id, address as tokenAddress, timestamp, decision_str, position_size,
        risk_level, score, signal_vector_json, created_at as createdAt
      FROM feedback_records
      WHERE labeled = 0 AND created_at > ?
      ORDER BY created_at DESC
      LIMIT 1000
    `);

    const rows = stmt.all(since) as any[];

    return rows.map((row) => ({
      id: row.id,
      tokenAddress: row.tokenAddress,
      timestamp: row.timestamp,
      signalVector: JSON.parse(row.signal_vector_json),
      decision: {
        tokenAddress: row.tokenAddress,
        timestamp: row.timestamp,
        decision: row.decision_str,
        positionSize: row.position_size,
        riskLevel: row.risk_level,
        finalScore: row.score,
        hardRuleScore: 0,
        ensembleScore: 0,
        anomalyScore: 0,
        confidence: 0,
        signalVector: JSON.parse(row.signal_vector_json),
        ensemble: {} as any,
      },
      labeled: false,
      createdAt: row.createdAt,
    }));
  }

  /**
   * Label outcome for a decision
   * Computes rich reward signal
   */
  labelOutcome(
    tokenAddress: string,
    timestamp: number,
    outcome: 'RUG' | 'DUMP_60' | 'STABLE' | 'MOONSHOT',
    price48hLater?: number,
    pricePeak?: number,
    pricePeakTime?: number,
  ): void {
    const now = Date.now();

    // Get decision record
    const getStmt = this.db.prepare(`
      SELECT decision_str, position_size FROM feedback_records
      WHERE address = ? AND timestamp = ?
    `);
    const record = getStmt.get(tokenAddress, timestamp) as any;

    if (!record) {
      this.logger.warn({ msg: 'Feedback record not found', tokenAddress, timestamp });
      return;
    }

    // Compute reward signal
    const rewardSignal = this.computeRewardSignal(record.decision_str, outcome);

    // Update record
    const updateStmt = this.db.prepare(`
      UPDATE feedback_records
      SET outcome = ?, price_48h_later = ?, price_peak = ?, price_peak_time = ?,
          reward_signal = ?, labeled = 1, labeled_at = ?, updated_at = ?
      WHERE address = ? AND timestamp = ?
    `);

    updateStmt.run(
      outcome,
      price48hLater || null,
      pricePeak || null,
      pricePeakTime || null,
      rewardSignal,
      now,
      now,
      tokenAddress,
      timestamp,
    );

    this.logger.info({
      msg: 'Outcome labeled',
      tokenAddress,
      outcome,
      rewardSignal: rewardSignal.toFixed(3),
    });
  }

  /**
   * Compute rich reward signal (not binary)
   */
  private computeRewardSignal(decision: string, outcome: string): number {
    if (outcome === 'RUG') {
      // Penalty for buying/small on rug
      if (decision === 'BUY') return -0.5;
      if (decision === 'SMALL') return -0.1;
      // Reward for skipping/rejecting rug
      if (decision === 'SKIP' || decision === 'REJECT') return 0.5;
    }

    if (outcome === 'DUMP_60') {
      if (decision === 'BUY') return -0.5;
      if (decision === 'SMALL') return -0.1;
      if (decision === 'SKIP' || decision === 'REJECT') return 0.5;
    }

    if (outcome === 'STABLE') {
      // Small reward for buying
      if (decision === 'BUY') return 0.3;
      if (decision === 'SMALL') return 0.1;
      // Slight penalty for being too conservative
      if (decision === 'SKIP' || decision === 'REJECT') return -0.2;
    }

    if (outcome === 'MOONSHOT') {
      // Reward for buying, penalty for skipping
      if (decision === 'BUY') return 1.0;
      if (decision === 'SMALL') return 0.5;
      // Big penalty for missing moonshot
      if (decision === 'SKIP' || decision === 'REJECT') return -0.3;
    }

    return 0;
  }

  /**
   * Get labeled feedback for training
   * Time-split: all records before 'beforeTimestamp'
   */
  getLabeledFeedback(beforeTimestamp?: number, limit: number = 10000): FeedbackRecord[] {
    const before = beforeTimestamp || Date.now();

    const stmt = this.db.prepare(`
      SELECT 
        address as tokenAddress, timestamp, decision_str, position_size,
        risk_level, score, signal_vector_json, outcome, reward_signal,
        created_at as createdAt, labeled_at as labeledAt
      FROM feedback_records
      WHERE labeled = 1 AND created_at < ?
      ORDER BY created_at DESC
      LIMIT ?
    `);

    const rows = stmt.all(before, limit) as any[];

    return rows.map((row) => ({
      tokenAddress: row.tokenAddress,
      timestamp: row.timestamp,
      signalVector: JSON.parse(row.signal_vector_json),
      decision: {
        tokenAddress: row.tokenAddress,
        timestamp: row.timestamp,
        decision: row.decision_str,
        positionSize: row.position_size,
        riskLevel: row.risk_level,
        finalScore: row.score,
        hardRuleScore: 0,
        ensembleScore: 0,
        anomalyScore: 0,
        confidence: 0,
        signalVector: JSON.parse(row.signal_vector_json),
        ensemble: {} as any,
      },
      outcome: row.outcome,
      rewardSignal: row.reward_signal,
      labeled: true,
      createdAt: row.createdAt,
      labeledAt: row.labeledAt,
    }));
  }

  /**
   * Get statistics on feedback data
   */
  getStatistics(): {
    totalDecisions: number;
    labeledDecisions: number;
    unlabeledDecisions: number;
    avgRewardSignal: number;
    outcomeCounts: Record<string, number>;
  } {
    const totalStmt = this.db.prepare('SELECT COUNT(*) as cnt FROM feedback_records');
    const total = (totalStmt.get() as any).cnt;

    const labeledStmt = this.db.prepare('SELECT COUNT(*) as cnt FROM feedback_records WHERE labeled = 1');
    const labeled = (labeledStmt.get() as any).cnt;

    const avgRewardStmt = this.db.prepare(
      'SELECT AVG(reward_signal) as avg FROM feedback_records WHERE labeled = 1',
    );
    const avgReward = ((avgRewardStmt.get() as any).avg || 0) as number;

    const outcomesStmt = this.db.prepare(`
      SELECT outcome, COUNT(*) as cnt FROM feedback_records
      WHERE labeled = 1
      GROUP BY outcome
    `);
    const outcomes = outcomesStmt.all() as any[];
    const outcomeCounts: Record<string, number> = {};
    outcomes.forEach((row) => {
      outcomeCounts[row.outcome] = row.cnt;
    });

    return {
      totalDecisions: total,
      labeledDecisions: labeled,
      unlabeledDecisions: total - labeled,
      avgRewardSignal: avgReward,
      outcomeCounts,
    };
  }

  /**
   * Persist regime history
   */
  logRegimeState(
    missRate48h: number,
    missRateWeek: number,
    regime: string,
    decayingSignals?: string[],
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO regime_history (
        timestamp, miss_rate_48h, miss_rate_week, regime, decaying_signals_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    const now = Date.now();
    stmt.run(
      now,
      missRate48h,
      missRateWeek,
      regime,
      JSON.stringify(decayingSignals || []),
      now,
    );
  }

  /**
   * Close database
   */
  close(): void {
    this.db.close();
  }
}
