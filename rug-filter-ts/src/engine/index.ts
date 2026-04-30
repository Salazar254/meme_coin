/**
 * engine/index.ts
 *
 * Barrel export for the high-throughput memecoin trading engine.
 *
 * Pipeline:
 *   TokenSignals → HardFilter → OpportunityRanker → RegimeDetector →
 *   DynamicSizer → RiskManager → ExecutionRouter → FeedbackLoop → Retrain
 */

// Core types
export * from './types';

// Pipeline components
export { HardFilter } from './hard-filter';
export type { HardFilterConfig, HardFilterWeights } from './hard-filter';

export { MLOpportunityRanker } from './ml-ranker';
export type { MLRankerConfig, RankWeights } from './ml-ranker';

export { TradingRegimeDetector } from './regime-detector';
export type { RegimeDetectorConfig } from './regime-detector';

export { DynamicSizer } from './dynamic-sizer';
export type { DynamicSizerConfig, BucketConfig } from './dynamic-sizer';

export { RiskManager } from './risk-manager';

export { ExecutionRouter } from './execution-router';
export type { ExecutionRouterConfig } from './execution-router';

export { FeedbackLoop } from './feedback-loop';
export type { FeedbackLoopConfig, RetrainReport, PerformanceBySetup } from './feedback-loop';

// Orchestrator
export { TradingPipeline } from './pipeline';
export type { PipelineConfig } from './pipeline';

export { TradingEngineOrchestrator } from './trading-engine-orchestrator';
export type { TradingEngineConfig } from './trading-engine-orchestrator';

// Testing
export { ScenarioTester, SCENARIOS } from './scenario-tester';

// Reporting
export { SummaryReportGenerator } from './summary-report';
