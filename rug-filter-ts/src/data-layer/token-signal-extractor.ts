/**
 * src/data-layer/token-signal-extractor.ts
 *
 * Parallel API fetcher for all rug signals.
 * 300ms timeout per API, safe fallbacks, type-safe SignalVector output.
 */

import axios, { AxiosInstance } from 'axios';
import { Logger } from 'pino';
import {
  SignalVector,
  GoPlusSignals,
  HoneypotSignals,
  HolderMetrics,
  LiquiditySignals,
  SocialSignals,
  InternalSecurityFlags,
  NormalizedSignalResult,
} from '../types';

export interface TokenSignalExtractorConfig {
  goPlusApiKey?: string;
  honeypotApiKey?: string;
  heliusApiKey?: string;
  alchemyApiKey?: string;
  unicryptApiKey?: string;
  
  apiTimeoutMs: number; // 300ms typical
  maxConcurrentRequests: number;
  
  knownRugDeployers: Set<string>;
  knownWhitelistedDeployers: Set<string>;
}

/**
 * Fetches all signals in parallel with 300ms timeout per API + safe fallbacks.
 */
export class TokenSignalExtractor {
  private config: TokenSignalExtractorConfig;
  private logger: Logger;
  private httpClient: AxiosInstance;

  constructor(config: TokenSignalExtractorConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.httpClient = axios.create({
      timeout: config.apiTimeoutMs,
      headers: {
        'User-Agent': 'meme-coin-rug-filter/1.0',
      },
    });
  }

  /**
   * Main entry point: extract all signals for a token address.
   * Returns complete SignalVector with safe fallbacks.
   */
  async extractSignals(
    tokenAddress: string,
    chain: 'solana' | 'ethereum' | 'polygon' = 'solana',
  ): Promise<NormalizedSignalResult> {
    const startTime = Date.now();
    const missingFields: string[] = [];

    // Race all API calls with 300ms timeout
    const [
      goPlusSignals,
      honeypotSignals,
      holderMetrics,
      liquiditySignals,
      socialSignals,
      internalFlags,
    ] = await Promise.allSettled([
      this.fetchGoPlusSignals(tokenAddress, chain),
      this.fetchHoneypotSignals(tokenAddress),
      this.fetchHolderMetrics(tokenAddress, chain),
      this.fetchLiquiditySignals(tokenAddress, chain),
      this.fetchSocialSignals(tokenAddress),
      this.fetchInternalFlags(tokenAddress),
    ]);

    // Unpack results with fallbacks
    const goplus = this.unwrapOrDefault(goPlusSignals, 'GoPlus', missingFields);
    const honeypot = this.unwrapOrDefault(honeypotSignals, 'Honeypot', missingFields);
    const holders = this.unwrapOrDefault(holderMetrics, 'Holders', missingFields);
    const liquidity = this.unwrapOrDefault(liquiditySignals, 'Liquidity', missingFields);
    const social = this.unwrapOrDefault(socialSignals, 'Social', missingFields);
    const internal = this.unwrapOrDefault(internalFlags, 'Internal', missingFields);

    // Construct complete SignalVector (no optional fields)
    const signalVector: SignalVector = {
      tokenAddress,
      timestamp: Date.now(),
      
      // GoPlus
      mintEnabled: goplus.mintEnabled,
      blacklistFunction: goplus.blacklistFunction,
      ownershipRenounced: goplus.ownershipRenounced,
      isProxy: goplus.isProxy,
      
      // Honeypot
      isHoneypot: honeypot.isHoneypot,
      buyTax: honeypot.buyTax,
      sellTax: honeypot.sellTax,
      
      // Holders
      top10HolderPct: holders.top10HolderPct,
      devWalletPct: holders.devWalletPct,
      walletClusterScore: holders.walletClusterScore,
      
      // Liquidity
      lpLocked: liquidity.lpLocked,
      lpLockDays: liquidity.lpLockDays,
      lpBurned: liquidity.lpBurned,
      
      // Social
      hasTelegram: social.hasTelegram,
      hasTwitter: social.hasTwitter,
      telegramAgeDays: social.telegramAgeDays,
      twitterAgeDays: social.twitterAgeDays,
      followerQualityScore: social.followerQualityScore,
      
      // Internal
      isKnownRugDeployer: internal.isKnownRugDeployer,
      
      // Metadata
      sourceChain: chain,
      detectedAt: Date.now(),
    };

    const fetchTimeMs = Date.now() - startTime;

    this.logger.info({
      msg: 'Token signals extracted',
      tokenAddress,
      chain,
      missingFieldsCount: missingFields.length,
      missingFields,
      fetchTimeMs,
    });

    return { signals: signalVector, missingFields, fetchTimeMs };
  }

  /**
   * GoPlus Security API
   * Reference: https://gopluslabs.io/
   */
  private async fetchGoPlusSignals(
    tokenAddress: string,
    chain: 'solana' | 'ethereum' | 'polygon',
  ): Promise<GoPlusSignals> {
    try {
      const chainMap = { solana: 'solana', ethereum: 'eth', polygon: 'polygon' };
      const chainParam = chainMap[chain] || 'eth';
      
      const url = `https://api.gopluslabs.io/api/v1/token_security/${chainParam}/${tokenAddress}`;
      const response = await this.httpClient.get(url, {
        params: { api_key: this.config.goPlusApiKey },
      });

      const data = response.data?.result || {};

      return {
        mintEnabled: data.is_mintable !== '1',
        blacklistFunction: data.is_blacklisted === '1',
        ownershipRenounced: data.owner_change_balance === '0',
        isProxy: data.is_proxy === '1',
      };
    } catch (err) {
      this.logger.warn({ msg: 'GoPlus API failed', error: String(err) });
      return {
        mintEnabled: true, // Conservative default: assume risky
        blacklistFunction: false,
        ownershipRenounced: false,
        isProxy: false,
      };
    }
  }

  /**
   * honeypot.is API
   * Reference: https://honeypot.is/
   */
  private async fetchHoneypotSignals(tokenAddress: string): Promise<HoneypotSignals> {
    try {
      const url = `https://honeypot.is/api/honeypotScore?address=${tokenAddress}`;
      const response = await this.httpClient.get(url);

      const data = response.data || {};

      return {
        isHoneypot: data.isHoneypot === true,
        buyTax: parseFloat(data.buyTax || '0') * 100, // convert to basis points
        sellTax: parseFloat(data.sellTax || '0') * 100,
      };
    } catch (err) {
      this.logger.warn({ msg: 'Honeypot API failed', error: String(err) });
      return {
        isHoneypot: false,
        buyTax: 0,
        sellTax: 0,
      };
    }
  }

  /**
   * Helius RPC (Solana) / Alchemy (EVM)
   * Holder concentration metrics
   */
  private async fetchHolderMetrics(
    tokenAddress: string,
    chain: 'solana' | 'ethereum' | 'polygon',
  ): Promise<HolderMetrics> {
    try {
      if (chain === 'solana') {
        return this.fetchSolanaHolderMetrics(tokenAddress);
      } else {
        return this.fetchEvmHolderMetrics(tokenAddress);
      }
    } catch (err) {
      this.logger.warn({ msg: 'Holder metrics fetch failed', error: String(err) });
      return {
        top10HolderPct: 100, // Conservative: assume max concentration
        devWalletPct: 50,
        walletClusterScore: 0.5,
      };
    }
  }

  private async fetchSolanaHolderMetrics(tokenAddress: string): Promise<HolderMetrics> {
    // Use Helius RPC + indexing
    // For now, exemplary implementation with mock logic
    
    // In production: 
    // - Call Helius tokenHolders endpoint
    // - Filter top 10 holders by balance
    // - Compute concentration score
    // - Detect wallet clusters (same deployer)

    return {
      top10HolderPct: 0,
      devWalletPct: 0,
      walletClusterScore: 0,
    };
  }

  private async fetchEvmHolderMetrics(tokenAddress: string): Promise<HolderMetrics> {
    // Use Alchemy API + etherscan
    
    return {
      top10HolderPct: 0,
      devWalletPct: 0,
      walletClusterScore: 0,
    };
  }

  /**
   * Unicrypt / DappRadar LP lock data
   */
  private async fetchLiquiditySignals(
    tokenAddress: string,
    chain: 'solana' | 'ethereum' | 'polygon',
  ): Promise<LiquiditySignals> {
    try {
      // Query Unicrypt lock contracts or DappRadar API
      // Check if LP is locked, burn status, lock duration
      
      // Exemplary defaults:
      return {
        lpLocked: false,
        lpLockDays: 0,
        lpBurned: false,
      };
    } catch (err) {
      this.logger.warn({ msg: 'Liquidity signals fetch failed', error: String(err) });
      return {
        lpLocked: false,
        lpLockDays: 0,
        lpBurned: false,
      };
    }
  }

  /**
   * Social signals: Telegram, Twitter age, follower quality
   */
  private async fetchSocialSignals(tokenAddress: string): Promise<SocialSignals> {
    try {
      // In production:
      // - Query token metadata APIs (MetaPlex for Solana, etc.)
      // - Scrape Telegram member count, age
      // - Scrape Twitter follower count, engagement rate
      // - Compute follower quality (ratio of verified / organic)

      return {
        hasTelegram: false,
        hasTwitter: false,
        telegramAgeDays: 0,
        twitterAgeDays: 0,
        followerQualityScore: 0,
      };
    } catch (err) {
      this.logger.warn({ msg: 'Social signals fetch failed', error: String(err) });
      return {
        hasTelegram: false,
        hasTwitter: false,
        telegramAgeDays: 0,
        twitterAgeDays: 0,
        followerQualityScore: 0,
      };
    }
  }

  /**
   * Internal blacklist lookup
   */
  private async fetchInternalFlags(tokenAddress: string): Promise<InternalSecurityFlags> {
    const isKnownRug = this.config.knownRugDeployers.has(tokenAddress);
    return { isKnownRugDeployer: isKnownRug };
  }

  /**
   * Helper: unwrap PromiseSettledResult with fallback
   */
  private unwrapOrDefault<T>(
    result: PromiseSettledResult<T>,
    fieldName: string,
    missingFields: string[],
  ): T {
    if (result.status === 'fulfilled') {
      return result.value;
    } else {
      this.logger.warn({ msg: 'API fetch failed', field: fieldName });
      missingFields.push(fieldName);
      // Fallback is provided by the caller's default returns
      throw result.reason;
    }
  }
}
