import { buildState, QUESTIONS, QUESTION_SET_VERSION } from "../shared/questions";
import { sha256Hex } from "../shared/hash";
import { MARKUP_SIGNALS } from "../shared/types";
import type { ApiStatus, ClassifyResponse, MarkupSignal } from "../shared/types";
import type { AnswerCache } from "./cache";
import { JevError, type evaluateJev } from "./jevClient";
import { Limiter } from "./limiter";
import { mockAnswers } from "./mock";
import type { UsageTracker } from "./usage";

export const MAX_TEXT_CHARS = 600;
export const MAX_DOMAINS = 3;
export const COOLDOWN_MS = 30_000;
const CONCURRENCY = 4;

export interface ClassifierDeps {
  cache: AnswerCache;
  usage: UsageTracker;
  getConfig: () => Promise<{ apiKey: string; model: string }>;
  evaluate: typeof evaluateJev;
  now?: () => number;
  /** デモ判定にも実機に近い待ち時間をつける(判定中のぼかしが見えるように) */
  demoDelay?: () => Promise<void>;
}

/**
 * 質問定義そのものの指紋。キャッシュキーに含めるので、質問文や判定基準を変えると
 * (QUESTION_SET_VERSION の上げ忘れがあっても)古い確率は自動的に使われなくなる。
 * 版番号は、state の形(buildState)の変更など質問文以外の変更のために残す。
 */
const QUESTIONS_FINGERPRINT = JSON.stringify(QUESTIONS);

/** 「ドメイン/パス」。クエリ・フラグメント・空白は含まない */
const LANDING_RE = /^(?=[^/]{1,253}(\/|$))[a-z0-9-]+(\.[a-z0-9-]+)+(\/[^\s?#/]{1,40}){0,2}$/;
const MARKUP_KEYS = new Set(Object.keys(MARKUP_SIGNALS));

export interface SanitizedInput {
  text: string;
  landing: string[];
  markup: MarkupSignal[];
}

/** content script から来た入力を background 側でも検証し直す(ページ側が改ざんしていても変な値を送らない) */
export function sanitizeInput(text: unknown, landing: unknown, markup: unknown): SanitizedInput | null {
  if (typeof text !== "string") return null;
  const t = text.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS);
  if (!t) return null;
  const ls = Array.isArray(landing)
    ? [
        ...new Set(
          landing
            .filter((d): d is string => typeof d === "string")
            .map((d) => d.replace(/^([^/]+)/, (h) => h.toLowerCase())),
        ),
      ]
        .filter((d) => LANDING_RE.test(d))
        .slice(0, MAX_DOMAINS)
    : [];
  const ms = Array.isArray(markup)
    ? [...new Set(markup.filter((m): m is MarkupSignal => typeof m === "string" && MARKUP_KEYS.has(m)))].sort()
    : [];
  return { text: t, landing: ls, markup: ms };
}

export class Classifier {
  private readonly limiter = new Limiter<ClassifyResponse>(CONCURRENCY);
  private cooldownUntil = 0;
  /** 401/403 を受けたキー。キーが変わるまでは呼ばずに失敗を返す */
  private rejectedKey: string | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: ClassifierDeps) {
    this.now = deps.now ?? Date.now;
  }

  async status(): Promise<ApiStatus> {
    const { apiKey } = await this.deps.getConfig();
    if (!apiKey) return "demo";
    if (this.rejectedKey === apiKey) return "auth_error";
    if (this.now() < this.cooldownUntil) return "cooldown";
    return "live";
  }

  async classify(rawText: unknown, rawLanding: unknown, rawMarkup: unknown): Promise<ClassifyResponse> {
    const input = sanitizeInput(rawText, rawLanding, rawMarkup);
    if (!input) return { ok: false, code: "bad_request", error: "判定できる文面がありません" };

    const { apiKey, model } = await this.deps.getConfig();
    const live = apiKey.length > 0;
    const key = await sha256Hex(
      [
        QUESTION_SET_VERSION,
        QUESTIONS_FINGERPRINT,
        live ? model : "demo",
        input.landing.join(","),
        input.markup.join(","),
        input.text,
      ].join("\n"),
    );

    const cached = await this.deps.cache.get(key);
    if (cached) {
      void this.deps.usage.add({ cacheHits: 1 });
      return { ok: true, answers: cached, mock: !live, cached: true, ms: 0 };
    }

    if (!live) {
      return this.limiter.run(key, async () => {
        const t0 = this.now();
        await this.deps.demoDelay?.();
        const answers = mockAnswers(input.text, input.landing, input.markup);
        await this.deps.cache.set(key, answers, false);
        void this.deps.usage.add({ demoRequests: 1 });
        return { ok: true, answers, mock: true, cached: false, ms: this.now() - t0 };
      });
    }

    if (this.rejectedKey === apiKey) {
      return { ok: false, code: "auth", error: "APIキーが無効か、権限がありません" };
    }
    if (this.now() < this.cooldownUntil) {
      return { ok: false, code: "cooldown", error: "混雑・通信エラーのため一時停止中です" };
    }

    return this.limiter.run(key, async () => {
      try {
        const result = await this.deps.evaluate({
          apiKey,
          model,
          state: buildState(input.text, input.landing, input.markup),
        });
        await this.deps.cache.set(key, result.answers, true);
        void this.deps.usage.add({ requests: 1, inputTokens: result.inputTokens ?? 0 });
        return { ok: true, answers: result.answers, mock: false, cached: false, ms: result.ms };
      } catch (err) {
        const e = err instanceof JevError ? err : new JevError("network", String(err));
        void this.deps.usage.add({ errors: 1 });
        if (e.code === "auth") this.rejectedKey = apiKey;
        if (e.code === "rate_limit" || e.code === "overloaded" || e.code === "network" || e.code === "server") {
          this.cooldownUntil = this.now() + COOLDOWN_MS;
        }
        return { ok: false, code: e.code, error: e.message };
      }
    });
  }

  /** APIキーやモデルが変わったら、認証エラーとクールダウンを解除する */
  resetErrors(): void {
    this.rejectedKey = null;
    this.cooldownUntil = 0;
  }
}
