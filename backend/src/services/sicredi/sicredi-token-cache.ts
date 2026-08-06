import type { SicrediCachedToken } from '../../types/sicredi.types.js';

let cached: SicrediCachedToken | null = null;
let inflight: Promise<SicrediCachedToken> | null = null;
let refreshCount = 0;

export class SicrediTokenCache {
  get(): SicrediCachedToken | null {
    if (!cached) return null;
    if (Date.now() >= cached.expiresAt) {
      cached = null;
      return null;
    }
    return cached;
  }

  set(token: SicrediCachedToken): void {
    cached = token;
  }

  clear(): void {
    cached = null;
    inflight = null;
  }

  getRefreshCount(): number {
    return refreshCount;
  }

  resetRefreshCount(): void {
    refreshCount = 0;
  }

  async getOrFetch(fetcher: () => Promise<SicrediCachedToken>): Promise<SicrediCachedToken> {
    const existing = this.get();
    if (existing) return existing;

    if (inflight) return inflight;

    inflight = fetcher()
      .then((token) => {
        refreshCount += 1;
        this.set(token);
        return token;
      })
      .finally(() => {
        inflight = null;
      });

    return inflight;
  }
}

export const sicrediTokenCache = new SicrediTokenCache();
