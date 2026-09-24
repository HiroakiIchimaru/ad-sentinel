import type { Answers } from "../shared/types";
import type { KV } from "./kv";

const PREFIX = "c:";
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const CACHE_MAX_ENTRIES = 3000;
const MEMORY_MAX_ENTRIES = 500;

interface Entry {
  a: Answers;
  t: number;
}

function isEntry(v: unknown): v is Entry {
  return !!v && typeof v === "object" && typeof (v as Entry).t === "number" && !!(v as Entry).a;
}

/**
 * 判定確率のキャッシュ。キーは広告文の SHA-256 で、広告文そのものは保存しない。
 * 確率(設定適用前の値)を保存するので、しきい値を変えても再利用できる。
 */
export class AnswerCache {
  private readonly mem = new Map<string, Entry>();

  constructor(
    private readonly kv: KV,
    private readonly now: () => number = Date.now,
  ) {}

  async get(key: string): Promise<Answers | null> {
    const hit = this.mem.get(key);
    if (hit) {
      if (this.now() - hit.t < CACHE_TTL_MS) {
        // Map の順序を LRU として使う
        this.mem.delete(key);
        this.mem.set(key, hit);
        return hit.a;
      }
      this.mem.delete(key);
    }
    const stored = (await this.kv.get(PREFIX + key))[PREFIX + key];
    if (isEntry(stored) && this.now() - stored.t < CACHE_TTL_MS) {
      this.remember(key, stored);
      return stored.a;
    }
    return null;
  }

  /** persist=false はメモリだけに置く(デモ判定の結果を本番キャッシュに混ぜないため) */
  async set(key: string, answers: Answers, persist: boolean): Promise<void> {
    const entry: Entry = { a: answers, t: this.now() };
    this.remember(key, entry);
    if (persist) await this.kv.set({ [PREFIX + key]: entry });
  }

  /** 期限切れを消し、件数上限を超えた分を古い順に消す */
  async prune(): Promise<number> {
    const all = await this.kv.get(null);
    const entries = Object.entries(all).filter(([k]) => k.startsWith(PREFIX));
    const now = this.now();
    const expired: string[] = [];
    const alive: [string, number][] = [];
    for (const [k, v] of entries) {
      if (!isEntry(v) || now - v.t >= CACHE_TTL_MS) expired.push(k);
      else alive.push([k, v.t]);
    }
    if (alive.length > CACHE_MAX_ENTRIES) {
      alive.sort((a, b) => a[1] - b[1]);
      expired.push(...alive.slice(0, alive.length - CACHE_MAX_ENTRIES).map(([k]) => k));
    }
    if (expired.length > 0) await this.kv.remove(expired);
    return expired.length;
  }

  async clear(): Promise<void> {
    this.mem.clear();
    const all = await this.kv.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith(PREFIX));
    if (keys.length > 0) await this.kv.remove(keys);
  }

  private remember(key: string, entry: Entry): void {
    this.mem.delete(key);
    this.mem.set(key, entry);
    while (this.mem.size > MEMORY_MAX_ENTRIES) {
      const oldest = this.mem.keys().next().value;
      if (oldest === undefined) break;
      this.mem.delete(oldest);
    }
  }
}
