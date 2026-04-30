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

  constructor(config: RpcConfig, logger: Logger) {
    this.config = config;
    this.logger = logger.child({ component: "rpc_pool" });
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
        return response.result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.failures.set(url, (this.failures.get(url) || 0) + 1);
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
    const index = this.cursor % urls.length;
    this.cursor += 1;
    return urls[index];
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
