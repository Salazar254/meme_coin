import type { MemeAlphaConfig } from "../config.ts";
import type { TokenLaunchEvent } from "../token_risk_scorer.ts";

export interface AntiRugAuditResult {
  accepted: boolean;
  elapsedMs: number;
  budgetExceeded: boolean;
  riskScore: number;
  reasons: string[];
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

export class AntiRugGuard {
  config: MemeAlphaConfig;

  constructor(config: MemeAlphaConfig) {
    this.config = config;
  }

  audit(event: TokenLaunchEvent): AntiRugAuditResult {
    const started = performance.now();
    const reasons: string[] = [];
    const chain = event.chain || "solana";

    if (chain === "solana") {
      if (this.config.requireMintAuthorityRenounced && !event.mintAuthorityRenounced) {
        reasons.push("mint_authority_active");
      }
      if (this.config.requireFreezeAuthorityRenounced && !event.freezeAuthorityRenounced) {
        reasons.push("freeze_authority_active");
      }
    }

    if (chain === "base") {
      if (event.ownerRenounced === false) {
        reasons.push("owner_authority_active");
      }
      if (event.proxyContract) {
        reasons.push("proxy_contract");
      }
      if (event.blacklistFunction) {
        reasons.push("blacklist_function");
      }
      if (event.tradingPaused) {
        reasons.push("trading_paused");
      }
    }

    if (event.topHolderPct > this.config.maxTopHolderPct) {
      reasons.push("top_holder_concentration");
    }
    if ((event.top10HolderPct ?? event.topHolderPct) > this.config.maxTop10HolderPct) {
      reasons.push("top10_holder_concentration");
    }
    if (event.devHoldPct > this.config.maxDevHoldPct) {
      reasons.push("dev_holder_concentration");
    }

    const elapsedMs = performance.now() - started;
    const budgetExceeded = elapsedMs > this.config.auditBudgetMs;
    if (budgetExceeded && this.config.blockOnAuditBudgetOverrun) {
      reasons.push("audit_budget_exceeded");
    }

    return {
      accepted: reasons.length === 0,
      elapsedMs,
      budgetExceeded,
      riskScore: this.riskScore(event, reasons),
      reasons
    };
  }

  riskScore(event: TokenLaunchEvent, reasons: string[]): number {
    const authorityRisk = Number(!event.mintAuthorityRenounced) * 0.24 + Number(!event.freezeAuthorityRenounced) * 0.2;
    const concentrationRisk = clamp01(event.topHolderPct / Math.max(this.config.maxTopHolderPct, 1e-9)) * 0.22
      + clamp01((event.top10HolderPct ?? event.topHolderPct) / Math.max(this.config.maxTop10HolderPct, 1e-9)) * 0.16
      + clamp01(event.devHoldPct / Math.max(this.config.maxDevHoldPct, 1e-9)) * 0.14;
    const evmRisk = Number(event.proxyContract) * 0.12 + Number(event.blacklistFunction) * 0.18 + Number(event.ownerRenounced === false) * 0.14;
    return clamp01(authorityRisk + concentrationRisk + evmRisk + Math.min(reasons.length, 4) * 0.04);
  }
}
