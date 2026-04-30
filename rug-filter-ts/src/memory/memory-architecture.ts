/**
 * src/memory/memory-architecture.ts
 *
 * Three-tier memory system matching human expert learning:
 *
 * Long-Term Memory (LTM):
 *   - Fundamental signals: mint, honeypot, LP lock
 *   - Trained once, high EWC protection
 *   - Almost never updated
 *
 * Medium-Term Memory (MTM):
 *   - Holder patterns, deployer clusters
 *   - Monthly retraining cycle
 *   - Moderate EWC protection
 *
 * Short-Term Memory (STM):
 *   - Emerging bad clusters, recent rug wallet list
 *   - Real-time updates, no retraining
 *   - Can override MTM/LTM
 */

import { Logger } from 'pino';
import {
  LongTermMemory,
  MediumTermMemory,
  ShortTermMemory,
} from '../types';

/**
 * Memory tier coordinator
 */
export class MemoryArchitecture {
  private ltm: LongTermMemory;
  private mtm: MediumTermMemory;
  private stm: ShortTermMemory;
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;

    // Initialize each tier
    this.ltm = {
      contractModelWeights: {},
      honeypotDetectionThreshold: 0.8,
      lpLockMinDays: 30,
      lastUpdateTimestamp: Date.now(),
    };

    this.mtm = {
      knownRugDeployers: new Set(),
      knownWhitelisted: new Set(),
      lastUpdateTimestamp: Date.now(),
      retrainCycle: 0,
    };

    this.stm = {
      emergingBadClusterWallets: new Set(),
      recent24hRugs: new Map(),
      anomalyBlacklist: new Set(),
      ttlTimestamp: Date.now() + 24 * 60 * 60 * 1000, // 24h TTL
    };
  }

  /**
   * Query: Is this deployer known bad?
   * Priority: STM > MTM > LTM
   */
  isKnownBadDeployer(deployerAddress: string): boolean {
    // Check STM first (highest priority, most recent)
    if (this.stm.emergingBadClusterWallets.has(deployerAddress)) {
      return true;
    }

    // Check MTM
    if (this.mtm.knownRugDeployers.has(deployerAddress)) {
      return true;
    }

    // LTM doesn't store deployer list (too static)
    return false;
  }

  /**
   * Query: Is this deployer known good?
   */
  isKnownWhitelisted(deployerAddress: string): boolean {
    return this.mtm.knownWhitelisted.has(deployerAddress);
  }

  /**
   * Update: Add to STM (real-time blacklist)
   * Call when anomaly detected or rug confirmed
   */
  addToSTMBlacklist(address: string, anomalyType: 'cluster' | 'rug' | 'anomaly'): void {
    if (anomalyType === 'cluster') {
      this.stm.emergingBadClusterWallets.add(address);
    } else if (anomalyType === 'rug') {
      this.stm.recent24hRugs.set(address, Date.now());
    } else if (anomalyType === 'anomaly') {
      this.stm.anomalyBlacklist.add(address);
    }

    this.logger.debug({
      msg: 'Added to STM blacklist',
      address,
      type: anomalyType,
    });
  }

  /**
   * Update: Add/remove from MTM (monthly cycle)
   * Called during retraining
   */
  updateMTM(
    newRugDeployers?: string[],
    newWhitelisted?: string[],
    clusterData?: Record<string, any>,
  ): void {
    if (newRugDeployers) {
      newRugDeployers.forEach((addr) => this.mtm.knownRugDeployers.add(addr));
    }

    if (newWhitelisted) {
      newWhitelisted.forEach((addr) => this.mtm.knownWhitelisted.add(addr));
    }

    if (clusterData) {
      this.mtm.clusterData = clusterData;
    }

    this.mtm.lastUpdateTimestamp = Date.now();
    this.mtm.retrainCycle++;

    this.logger.info({
      msg: 'MTM updated',
      newRugDeployers: newRugDeployers?.length || 0,
      newWhitelisted: newWhitelisted?.length || 0,
      totalRugDeployers: this.mtm.knownRugDeployers.size,
    });
  }

  /**
   * Update: LTM (rarely called, EWC protected)
   */
  updateLTM(
    contractWeights?: Record<string, number>,
    honeypotThreshold?: number,
    lpLockDays?: number,
  ): void {
    if (contractWeights) {
      this.ltm.contractModelWeights = contractWeights;
    }

    if (honeypotThreshold) {
      this.ltm.honeypotDetectionThreshold = honeypotThreshold;
    }

    if (lpLockDays) {
      this.ltm.lpLockMinDays = lpLockDays;
    }

    this.ltm.lastUpdateTimestamp = Date.now();
    this.ltm.frozenUntil = Date.now() + 90 * 24 * 60 * 60 * 1000; // 90-day freeze

    this.logger.info({
      msg: 'LTM updated (frozen for 90 days)',
      lastUpdate: new Date(this.ltm.lastUpdateTimestamp).toISOString(),
    });
  }

  /**
   * Refresh STM: clear TTL-expired entries daily
   */
  refreshSTM(): void {
    const now = Date.now();

    if (now > this.stm.ttlTimestamp) {
      this.stm.emergingBadClusterWallets.clear();
      this.stm.recent24hRugs.clear();
      this.stm.anomalyBlacklist.clear();

      this.stm.ttlTimestamp = now + 24 * 60 * 60 * 1000;

      this.logger.debug({ msg: 'STM refreshed (daily reset)' });
    }
  }

  /**
   * Get memory stats
   */
  getStats(): {
    ltmAge: number;
    mtmAge: number;
    stmSize: number;
    stmTTLRemaining: number;
  } {
    const now = Date.now();
    return {
      ltmAge: now - this.ltm.lastUpdateTimestamp,
      mtmAge: now - this.mtm.lastUpdateTimestamp,
      stmSize:
        this.stm.emergingBadClusterWallets.size +
        this.stm.recent24hRugs.size +
        this.stm.anomalyBlacklist.size,
      stmTTLRemaining: Math.max(0, this.stm.ttlTimestamp - now),
    };
  }

  /**
   * Persist memory to disk (backup)
   */
  export(): {
    ltm: LongTermMemory;
    mtm: Omit<MediumTermMemory, 'knownRugDeployers' | 'knownWhitelisted'> & {
      knownRugDeployers: string[];
      knownWhitelisted: string[];
    };
    stm: Omit<ShortTermMemory, 'emergingBadClusterWallets' | 'recent24hRugs' | 'anomalyBlacklist'> & {
      emergingBadClusterWallets: string[];
      recent24hRugs: Array<[string, number]>;
      anomalyBlacklist: string[];
    };
  } {
    return {
      ltm: this.ltm,
      mtm: {
        ...this.mtm,
        knownRugDeployers: Array.from(this.mtm.knownRugDeployers),
        knownWhitelisted: Array.from(this.mtm.knownWhitelisted),
      },
      stm: {
        ...this.stm,
        emergingBadClusterWallets: Array.from(this.stm.emergingBadClusterWallets),
        recent24hRugs: Array.from(this.stm.recent24hRugs),
        anomalyBlacklist: Array.from(this.stm.anomalyBlacklist),
      },
    };
  }

  /**
   * Restore memory from disk
   */
  import(snapshot: any): void {
    if (snapshot.ltm) {
      this.ltm = snapshot.ltm;
    }

    if (snapshot.mtm) {
      this.mtm = {
        ...snapshot.mtm,
        knownRugDeployers: new Set(snapshot.mtm.knownRugDeployers || []),
        knownWhitelisted: new Set(snapshot.mtm.knownWhitelisted || []),
      };
    }

    if (snapshot.stm) {
      this.stm = {
        ...snapshot.stm,
        emergingBadClusterWallets: new Set(snapshot.stm.emergingBadClusterWallets || []),
        recent24hRugs: new Map(snapshot.stm.recent24hRugs || []),
        anomalyBlacklist: new Set(snapshot.stm.anomalyBlacklist || []),
      };
    }

    this.logger.info({ msg: 'Memory architecture restored from snapshot' });
  }
}
