import { describe, expect, it } from "vitest";
import { blockedCount, sanitizeItems, TabStore } from "../src/background/tabStore";
import type { ItemReport } from "../src/shared/types";

/** content script が送る正しい形の 1 件 */
function validItem(over: Partial<ItemReport> = {}): ItemReport {
  return {
    id: "abc123-1",
    state: "block",
    excerpt: "今すぐ当選金を受け取る",
    source: "selector",
    where: "slot",
    domain: "example.com",
    top: { category: "scam", p: 0.9 },
    answers: { is_ad: 0.95, scam: 0.9, fake_alert: 0.1, phishing: 0.05, misleading: 0.2, inappropriate: 0.02 },
    markup: ["password_field"],
    obstruction: null,
    onPage: true,
    mock: false,
    ...over,
  };
}

describe("sanitizeItems(content script からの報告の検証)", () => {
  it("正しい項目はそのまま通す", () => {
    const item = validItem();
    expect(sanitizeItems([item])).toEqual([item]);
  });

  it("配列以外は空にする", () => {
    expect(sanitizeItems(undefined)).toEqual([]);
    expect(sanitizeItems("x")).toEqual([]);
    expect(sanitizeItems({ 0: validItem() })).toEqual([]);
  });

  it("id や state が不正な項目は捨てる", () => {
    expect(sanitizeItems([validItem({ id: "" })])).toEqual([]);
    expect(sanitizeItems([validItem({ id: "x".repeat(33) })])).toEqual([]);
    expect(sanitizeItems([{ ...validItem(), state: '"><script>' }])).toEqual([]);
    expect(sanitizeItems([{ ...validItem(), state: 123 }])).toEqual([]);
    expect(sanitizeItems([null, "x", 1])).toEqual([]);
  });

  it("未知の source・where は既定値に、未知の obstruction・markup・top は落とす", () => {
    const [r] = sanitizeItems([
      {
        ...validItem(),
        source: "evil",
        where: "evil",
        obstruction: "evil",
        markup: ["password_field", "__proto__", 1],
        top: { category: "evil", p: 0.9 },
      },
    ]);
    expect(r).toMatchObject({ source: "selector", where: "slot", obstruction: null, markup: ["password_field"], top: null });
  });

  it("長すぎる excerpt・domain は切り、boolean 以外の onPage・mock は false にする", () => {
    const [r] = sanitizeItems([
      { ...validItem(), excerpt: "あ".repeat(200), domain: "d".repeat(300), onPage: "yes", mock: 1 },
    ]);
    expect(r!.excerpt).toHaveLength(80);
    expect(r!.domain).toHaveLength(253);
    expect(r!.onPage).toBe(false);
    expect(r!.mock).toBe(false);
  });

  it("answers は全質問の確率(0〜1)が揃っているときだけ受け入れる", () => {
    expect(sanitizeItems([validItem({ answers: null })])[0]!.answers).toBeNull();
    const missing = { is_ad: 0.9, scam: 0.9 };
    expect(sanitizeItems([{ ...validItem(), answers: missing }])[0]!.answers).toBeNull();
    const outOfRange = { ...validItem().answers!, scam: 1.5 };
    expect(sanitizeItems([{ ...validItem(), answers: outOfRange }])[0]!.answers).toBeNull();
    expect(sanitizeItems([{ ...validItem(), top: { category: "scam", p: 2 } }])[0]!.top).toBeNull();
  });

  it("1 フレームの上限(60件)を超えた分は捨てる", () => {
    const many = Array.from({ length: 80 }, (_, i) => validItem({ id: `id-${i}` }));
    expect(sanitizeItems(many)).toHaveLength(60);
  });
});

describe("TabStore(検証込みの受け入れ)", () => {
  it("検証済みの項目に番号を振り、不正な項目は保存しない", async () => {
    const store = new TabStore(null);
    await store.report(1, 0, true, "news.example.jp", [
      validItem({ id: "a" }),
      { ...validItem({ id: "b" }), state: "evil" },
      validItem({ id: "c", state: "pending" }),
    ]);
    const state = await store.get(1);
    expect(state.host).toBe("news.example.jp");
    expect(state.items.map((i) => i.id)).toEqual(["a", "c"]);
    // 判定中(pending)には番号を振らない
    expect(state.items.find((i) => i.id === "a")!.n).toBe(1);
    expect(state.items.find((i) => i.id === "c")!.n).toBeUndefined();
    expect(blockedCount(state)).toBe(1);
  });

  it("配列でない items でも落ちない", async () => {
    const store = new TabStore(null);
    await store.report(1, 0, true, "news.example.jp", { evil: true });
    expect((await store.get(1)).items).toEqual([]);
  });
});
