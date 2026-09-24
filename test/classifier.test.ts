import { describe, expect, it, vi } from "vitest";
import { AnswerCache, CACHE_MAX_ENTRIES, CACHE_TTL_MS } from "../src/background/cache";
import { Classifier, COOLDOWN_MS, sanitizeInput } from "../src/background/classifier";
import { JevError, type evaluateJev } from "../src/background/jevClient";
import { MemoryKV } from "../src/background/kv";
import { Limiter } from "../src/background/limiter";
import { mockAnswers } from "../src/background/mock";
import { UsageTracker } from "../src/background/usage";
import type { Answers } from "../src/shared/types";

const ANSWERS: Answers = { is_ad: 0.9, scam: 0.8, fake_alert: 0.1, phishing: 0.1, misleading: 0.1, inappropriate: 0.05 };

function setup(apiKey = "key", evaluate?: typeof evaluateJev) {
  let now = 1_000_000;
  const clock = () => now;
  const kv = new MemoryKV();
  const cache = new AnswerCache(kv, clock);
  const usage = new UsageTracker(kv, clock, 0);
  const evalFn =
    evaluate ??
    (vi.fn(async () => ({ answers: ANSWERS, model: "jev-1.13.0", inputTokens: 500, ms: 90 })) as unknown as typeof evaluateJev);
  const classifier = new Classifier({
    cache,
    usage,
    getConfig: async () => ({ apiKey, model: "jev-1.13.0" }),
    evaluate: evalFn,
    now: clock,
  });
  return { classifier, evalFn, kv, cache, usage, advance: (ms: number) => (now += ms) };
}

describe("Classifier", () => {
  it("APIキーがなければデモ判定し、本番キャッシュには保存しない", async () => {
    const { classifier, evalFn, kv } = setup("");
    const r = await classifier.classify("【警告】ウイルスに感染しています。今すぐ修復してください", [], []);
    expect(r.ok && r.mock).toBe(true);
    expect(evalFn).not.toHaveBeenCalled();
    expect([...kv.data.keys()].some((k) => k.startsWith("c:"))).toBe(false);
    expect(await classifier.status()).toBe("demo");
  });

  it("同じ広告文は 1 回だけ jev に問い合わせ、2 回目はキャッシュ", async () => {
    const { classifier, evalFn } = setup();
    const text = "元本保証で月利20%の自動売買";
    const [a, b] = await Promise.all([classifier.classify(text, [], []), classifier.classify(text, [], [])]);
    expect(a.ok && b.ok).toBe(true);
    const c = await classifier.classify(text, [], []);
    expect(c.ok && c.cached).toBe(true);
    expect(evalFn).toHaveBeenCalledTimes(1);
  });

  it("jev に送る state は広告文・リンク先・HTML の特徴だけ(特徴は英語の説明に置き換える)", async () => {
    const { classifier, evalFn } = setup();
    await classifier.classify(
      "  ポイントの有効期限\n が近づいています  ",
      ["Shop.Example.com/lp", "bad host", "shop.example.com/lp", "x.example.com/a?token=1"],
      ["password_field", "evil<script>", "countdown"],
    );
    const arg = (evalFn as unknown as { mock: { calls: [{ state: unknown }][] } }).mock.calls[0]![0];
    expect(arg.state).toEqual({
      ad_text: "ポイントの有効期限 が近づいています",
      landing_pages: ["shop.example.com/lp"],
      markup: ["shows a countdown timer", "contains a password input field"],
    });
  });

  it("HTML の特徴が違えば別の判定としてキャッシュする", async () => {
    const { classifier, evalFn } = setup();
    await classifier.classify("ログインして確認してください", [], []);
    await classifier.classify("ログインして確認してください", [], ["password_field"]);
    expect(evalFn).toHaveBeenCalledTimes(2);
  });

  it("401 の後はキーが変わるまで呼ばない", async () => {
    const evalFn = vi.fn(async () => {
      throw new JevError("auth", "bad key", 401);
    }) as unknown as typeof evaluateJev;
    const { classifier } = setup("bad", evalFn);
    const r1 = await classifier.classify("広告その1のテキストです", [], []);
    const r2 = await classifier.classify("広告その2のテキストです", [], []);
    expect(r1).toMatchObject({ ok: false, code: "auth" });
    expect(r2).toMatchObject({ ok: false, code: "auth" });
    expect(evalFn).toHaveBeenCalledTimes(1);
    expect(await classifier.status()).toBe("auth_error");
    classifier.resetErrors();
    expect(await classifier.status()).toBe("live");
  });

  it("429 の後は 30 秒間クールダウンする", async () => {
    let fail = true;
    const evalFn = vi.fn(async () => {
      if (fail) throw new JevError("rate_limit", "too many", 429);
      return { answers: ANSWERS, model: "jev-1.13.0", inputTokens: 1, ms: 1 };
    }) as unknown as typeof evaluateJev;
    const { classifier, advance } = setup("key", evalFn);
    await classifier.classify("広告その1のテキストです", [], []);
    fail = false;
    expect(await classifier.classify("広告その2のテキストです", [], [])).toMatchObject({ ok: false, code: "cooldown" });
    expect(await classifier.status()).toBe("cooldown");
    advance(COOLDOWN_MS + 1);
    expect(await classifier.classify("広告その2のテキストです", [], [])).toMatchObject({ ok: true });
    expect(evalFn).toHaveBeenCalledTimes(2);
  });

  it("使用量を数える", async () => {
    const { classifier, usage } = setup();
    await classifier.classify("広告その1のテキストです", [], []);
    await classifier.classify("広告その1のテキストです", [], []);
    await new Promise((r) => setTimeout(r, 5));
    const u = await usage.get();
    expect(u.requests).toBe(1);
    expect(u.inputTokens).toBe(500);
    expect(u.cacheHits).toBe(1);
  });
});

describe("sanitizeInput", () => {
  it("空文字・非文字列は拒否", () => {
    expect(sanitizeInput("   ", [], [])).toBeNull();
    expect(sanitizeInput(123, [], [])).toBeNull();
  });
  it("600 文字・リンク先 3 件に切り詰める", () => {
    const r = sanitizeInput("あ".repeat(1000), ["a.com", "b.com/x", "c.com/x/y", "d.com"], []);
    expect(r?.text.length).toBe(600);
    expect(r?.landing).toEqual(["a.com", "b.com/x", "c.com/x/y"]);
  });
  it("リンク先はクエリ・3段以上のパス・空白を含むものを拒否する", () => {
    const r = sanitizeInput("テスト広告の文面です", ["a.com/x?y=1", "a.com/x/y/z", "a.com/x y", "a.com/%E3%81%82"], []);
    expect(r?.landing).toEqual(["a.com/%E3%81%82"]);
  });
  it("HTML の特徴は許可したキーだけ", () => {
    const r = sanitizeInput("テスト広告の文面です", [], ["card_field", "__proto__", 1, "card_field"]);
    expect(r?.markup).toEqual(["card_field"]);
  });
});

describe("AnswerCache", () => {
  it("期限切れは返さない", async () => {
    let now = 0;
    const cache = new AnswerCache(new MemoryKV(), () => now);
    await cache.set("k", ANSWERS, true);
    now = CACHE_TTL_MS - 1;
    expect(await cache.get("k")).toEqual(ANSWERS);
    now = CACHE_TTL_MS + 1;
    expect(await cache.get("k")).toBeNull();
  });

  it("上限を超えた分を古い順に消す", async () => {
    let now = 0;
    const kv = new MemoryKV();
    const cache = new AnswerCache(kv, () => now);
    for (let i = 0; i < CACHE_MAX_ENTRIES + 5; i++) {
      now = i;
      await kv.set({ [`c:${i}`]: { a: ANSWERS, t: i } });
    }
    const removed = await cache.prune();
    expect(removed).toBe(5);
    expect(kv.data.has("c:0")).toBe(false);
    expect(kv.data.has(`c:${CACHE_MAX_ENTRIES + 4}`)).toBe(true);
  });

  it("clear は判定キャッシュだけを消す", async () => {
    const kv = new MemoryKV();
    await kv.set({ "c:1": { a: ANSWERS, t: Date.now() }, usage: { date: "x" } });
    await new AnswerCache(kv).clear();
    expect([...kv.data.keys()]).toEqual(["usage"]);
  });
});

describe("Limiter", () => {
  it("同時実行数を守る", async () => {
    const limiter = new Limiter<number>(2);
    let running = 0;
    let peak = 0;
    const task = async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return 1;
    };
    await Promise.all(Array.from({ length: 6 }, (_, i) => limiter.run(String(i), task)));
    expect(peak).toBe(2);
  });
});

describe("mockAnswers(デモ判定)", () => {
  it("偽警告・詐欺・個人情報要求・誇大表示をそれぞれ高く出す", () => {
    expect(mockAnswers("【警告】お使いのiPhoneがウイルスに感染しています。今すぐ修復").fake_alert).toBeGreaterThan(0.7);
    expect(mockAnswers("元本保証!放置で稼ぐAI自動売買。LINE登録で無料").scam).toBeGreaterThan(0.7);
    expect(mockAnswers("アカウントが停止されました。本人確認のためカード番号を再登録").phishing).toBeGreaterThan(0.7);
    expect(mockAnswers("飲むだけで1ヶ月-12kg!医師も驚いた奇跡の酵素").misleading).toBeGreaterThan(0.7);
  });

  it("子供に不適切な表現(性的・暴力的・カジノ)を高く出す", () => {
    expect(mockAnswers("【R18】過激すぎる大人の漫画が今なら無料で読み放題").inappropriate).toBeGreaterThan(0.7);
    expect(mockAnswers("【閲覧注意】血まみれの惨劇…残虐すぎる描写で話題のホラーゲーム").inappropriate).toBeGreaterThan(0.7);
    expect(mockAnswers("初回入金ボーナス!オンラインカジノで今すぐプレイ").inappropriate).toBeGreaterThan(0.4);
    expect(mockAnswers("秋の新作コート 最大30%OFF|コトバ百貨店").inappropriate).toBeLessThan(0.1);
  });

  it("普通の広告はどのリスクも低い", () => {
    const a = mockAnswers("秋の新作コート 最大30%OFF|コトバ百貨店オンラインストア");
    expect(Math.max(a.scam, a.fake_alert, a.phishing, a.misleading)).toBeLessThan(0.4);
    expect(a.is_ad).toBeGreaterThan(0.5);
  });

  it("HTML にパスワード欄があれば個人情報の要求を強める", () => {
    const text = "コトバポイントの有効期限が近づいています。ログインして確認";
    expect(mockAnswers(text).phishing).toBeLessThan(0.7);
    expect(mockAnswers(text, [], ["password_field"]).phishing).toBeGreaterThan(0.7);
  });

  it("同じ入力には同じ値(乱数を使わない)", () => {
    expect(mockAnswers("テスト広告")).toEqual(mockAnswers("テスト広告"));
  });
});
