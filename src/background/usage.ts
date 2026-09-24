import type { Usage } from "../shared/types";
import type { KV } from "./kv";

const USAGE_KEY = "usage";

export function today(now: number = Date.now()): string {
  const d = new Date(now);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function emptyUsage(date: string): Usage {
  return { date, requests: 0, inputTokens: 0, cacheHits: 0, errors: 0, demoRequests: 0 };
}

/** 当日の使用量。書き込みはまとめて行う(広告ごとに storage へ書かない) */
export class UsageTracker {
  private usage: Usage | null = null;
  private loading: Promise<Usage> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly kv: KV,
    private readonly now: () => number = Date.now,
    private readonly flushDelayMs = 1000,
  ) {}

  async get(): Promise<Usage> {
    const u = await this.load();
    const date = today(this.now());
    if (u.date !== date) Object.assign(u, emptyUsage(date));
    return { ...u };
  }

  async add(delta: Partial<Omit<Usage, "date">>): Promise<void> {
    const u = await this.load();
    const date = today(this.now());
    if (u.date !== date) Object.assign(u, emptyUsage(date));
    for (const [k, v] of Object.entries(delta) as [keyof Omit<Usage, "date">, number][]) {
      u[k] += v;
    }
    this.scheduleFlush();
  }

  private load(): Promise<Usage> {
    if (this.usage) return Promise.resolve(this.usage);
    this.loading ??= this.kv.get(USAGE_KEY).then((r) => {
      const stored = r[USAGE_KEY] as Partial<Usage> | undefined;
      const base = emptyUsage(today(this.now()));
      this.usage = stored && typeof stored.date === "string" ? { ...base, ...stored } : base;
      return this.usage;
    });
    return this.loading;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.usage) void this.kv.set({ [USAGE_KEY]: this.usage });
    }, this.flushDelayMs);
  }
}
