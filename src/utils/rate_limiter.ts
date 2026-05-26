export class TokenBucket {
  capacity: number;
  refillPerMs: number;
  tokens: number;
  updatedAt: number;

  constructor(capacity: number, refillPerSecond: number) {
    this.capacity = capacity;
    this.refillPerMs = refillPerSecond / 1000;
    this.tokens = capacity;
    this.updatedAt = Date.now();
  }

  take(cost = 1): boolean {
    this.refill();
    if (this.tokens < cost) {
      return false;
    }
    this.tokens -= cost;
    return true;
  }

  async wait(cost = 1): Promise<void> {
    while (!this.take(cost)) {
      const missing = Math.max(cost - this.tokens, 0);
      const delay = Math.max(1, Math.ceil(missing / this.refillPerMs));
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  refill(): void {
    const now = Date.now();
    const elapsed = now - this.updatedAt;
    this.updatedAt = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
  }
}
