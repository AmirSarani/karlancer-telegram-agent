/**
 * Simple token-bucket rate limiter for Karlancer outbound reads/writes.
 */
export class RateLimiter {
  /**
   * @param {{ capacity?: number, refillPerSec?: number }} [opts]
   */
  constructor(opts = {}) {
    this.capacity = opts.capacity ?? 20;
    this.refillPerSec = opts.refillPerSec ?? 5;
    this.tokens = this.capacity;
    this.last = Date.now();
  }

  _refill() {
    const now = Date.now();
    const elapsed = (now - this.last) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    this.last = now;
  }

  /**
   * @param {number} [cost]
   * @returns {boolean}
   */
  tryTake(cost = 1) {
    this._refill();
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  async waitTake(cost = 1, maxWaitMs = 10_000) {
    const start = Date.now();
    while (!this.tryTake(cost)) {
      if (Date.now() - start > maxWaitMs) {
        const err = new Error('rate_limited_local');
        err.code = 'rate_limited';
        throw err;
      }
      await new Promise((r) => setTimeout(r, 50 + Math.floor(Math.random() * 50)));
    }
  }
}

export default RateLimiter;
