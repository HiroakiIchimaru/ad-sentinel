/**
 * 同時実行数の上限つきキュー。同じキーの処理が実行中・待機中なら、その Promise を共有する
 * (同じ広告が複数フレーム・複数タブに出ても API は 1 回)。
 */
export class Limiter<T> {
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly inflight = new Map<string, Promise<T>>();

  constructor(private readonly concurrency: number) {}

  run(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = this.schedule(task).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  get pending(): number {
    return this.running + this.waiting.length;
  }

  private async schedule(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.concurrency) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.running++;
    try {
      return await task();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
}
