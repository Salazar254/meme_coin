import type { RpcConfig } from "../config.ts";
import type { Logger } from "./logger.ts";

export interface RpcResponse<T> {
  jsonrpc: string;
  id: number;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export class RpcPool {
  config: RpcConfig;
  logger: Logger;
  cursor = 0;
  failures = new Map<string, number>();
  unhealthy = new Set<string>();
  latencyMs = new Map<string, number>();
  healthTimer?: NodeJS.Timeout;

  constructor(config: RpcConfig, logger: Logger) {
    this.config = config;
    this.logger = logger.child({ component: "rpc_pool" });
  }

  startHealthChecks(intervalMs = 30_000): void {
    this.healthTimer = setInterval(() => {
      void this.healthCheckOnce();
    }, intervalMs);
    void this.healthCheckOnce();
  }

  stopHealthChecks(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
  }

  async healthCheckOnce(): Promise<void> {
    await Promise.all(this.config.httpUrls.map(async (url) => {
      const started = performance.now();
      try {
        await this.post<RpcResponse<string>>(url, {
          jsonrpc: "2.0",
          id: Date.now(),
          method: "getHealth",
          params: []
        });
        this.failures.set(url, 0);
        this.unhealthy.delete(url);
        this.latencyMs.set(url, performance.now() - started);
      } catch (error) {
        const failures = (this.failures.get(url) || 0) + 1;
        this.failures.set(url, failures);
        if (failures >= 2) {
          this.unhealthy.add(url);
        }
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn({ url, failures, error: message }, "rpc_health_check_failed");
      }
    }));
  }

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      const url = this.nextUrl();
      try {
        const response = await this.post<RpcResponse<T>>(url, {
          jsonrpc: "2.0",
          id: Date.now(),
          method,
          params
        });
        if (response.error) {
          throw new Error(`${response.error.code}:${response.error.message}`);
        }
        if (response.result === undefined) {
          throw new Error("missing_rpc_result");
        }
        this.failures.set(url, 0);
        this.unhealthy.delete(url);
        return response.result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const failures = (this.failures.get(url) || 0) + 1;
        this.failures.set(url, failures);
        if (failures >= 2) {
          this.unhealthy.add(url);
        }
        this.logger.warn({ method, url, attempt, error: lastError.message }, "rpc_call_failed");
      }
    }
    throw lastError || new Error("rpc_call_failed");
  }

  nextUrl(): string {
    const urls = this.config.httpUrls;
    if (urls.length === 0) {
      throw new Error("no_rpc_urls_configured");
    }
    const healthy = urls.filter((url) => !this.unhealthy.has(url));
    const candidates = healthy.length > 0 ? healthy : urls;
    const fastest = [...candidates].sort((a, b) => (this.latencyMs.get(a) ?? Number.POSITIVE_INFINITY) - (this.latencyMs.get(b) ?? Number.POSITIVE_INFINITY));
    const rotation = fastest.some((url) => Number.isFinite(this.latencyMs.get(url) ?? Number.POSITIVE_INFINITY)) ? fastest : candidates;
    const index = this.cursor % rotation.length;
    this.cursor += 1;
    return rotation[index];
  }

  async post<T>(url: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`http_${response.status}`);
      }
      return await response.json() as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}
