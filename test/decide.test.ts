import { describe, expect, it } from "vitest";
import { decide, IS_AD_GATE } from "../src/shared/decide";
import { DEFAULT_SETTINGS, isSiteDisabled, normalizeHost, normalizeSettings } from "../src/shared/settings";
import type { Answers } from "../src/shared/types";

const answers = (patch: Partial<Answers> = {}): Answers => ({
  is_ad: 0.9,
  scam: 0.05,
  fake_alert: 0.05,
  phishing: 0.05,
  misleading: 0.05,
  inappropriate: 0.05,
  ...patch,
});

describe("decide", () => {
  it("遮蔽しきい値以上なら block、最も高いカテゴリを理由にする", () => {
    const v = decide(answers({ fake_alert: 0.93, scam: 0.8 }), DEFAULT_SETTINGS, "selector");
    expect(v.level).toBe("block");
    expect(v.top).toEqual({ category: "fake_alert", p: 0.93 });
  });

  it("注意しきい値と遮蔽しきい値の間なら warn", () => {
    expect(decide(answers({ misleading: 0.5 }), DEFAULT_SETTINGS, "selector").level).toBe("warn");
  });

  it("どれも低ければ ok", () => {
    expect(decide(answers(), DEFAULT_SETTINGS, "selector").level).toBe("ok");
  });

  it("しきい値ちょうどは上の段階に入る", () => {
    expect(decide(answers({ scam: 0.7 }), DEFAULT_SETTINGS, "selector").level).toBe("block");
    expect(decide(answers({ scam: 0.4 }), DEFAULT_SETTINGS, "selector").level).toBe("warn");
  });

  it("無効にしたカテゴリは理由にも判定にも使わない", () => {
    const s = normalizeSettings({ categories: { misleading: false } });
    const v = decide(answers({ misleading: 0.99, scam: 0.2 }), s, "selector");
    expect(v.level).toBe("ok");
    expect(v.top?.category).toBe("scam");
  });

  it("全カテゴリを無効にすると ok で理由なし", () => {
    const s = normalizeSettings({
      categories: { scam: false, fake_alert: false, phishing: false, misleading: false, inappropriate: false },
    });
    expect(decide(answers({ scam: 1 }), s, "selector")).toEqual({ level: "ok", top: null });
  });

  it("おすすめ枠の表記なしカードは、広告らしさが 0.6 未満なら記事として扱う", () => {
    const a = answers({ is_ad: 0.5, fake_alert: 0.47 });
    expect(decide(a, DEFAULT_SETTINGS, "widget").level).toBe("content");
    // 同じ確率でも「PR」表記からの推定(0.35)なら判定する
    expect(decide(a, DEFAULT_SETTINGS, "label").level).toBe("warn");
    expect(decide(answers({ is_ad: 0.7, scam: 0.9 }), DEFAULT_SETTINGS, "widget").level).toBe("block");
  });

  it("子供に不適切な表現のカテゴリで隠し、切れば隠さない", () => {
    const a = answers({ inappropriate: 0.88 });
    expect(decide(a, DEFAULT_SETTINGS, "selector")).toEqual({ level: "block", top: { category: "inappropriate", p: 0.88 } });
    const off = normalizeSettings({ categories: { inappropriate: false } });
    expect(decide(a, off, "selector").level).toBe("ok");
  });

  it("以前の保存値(カテゴリ 4 つ)を読んでも、新しいカテゴリは既定でオン", () => {
    const s = normalizeSettings({ categories: { scam: true, fake_alert: false, phishing: true, misleading: true } });
    expect(s.categories.inappropriate).toBe(true);
    expect(s.categories.fake_alert).toBe(false);
  });

  it("表記から推定した候補は、広告らしさが低ければ記事本文として扱う", () => {
    const a = answers({ is_ad: IS_AD_GATE - 0.01, scam: 0.95 });
    expect(decide(a, DEFAULT_SETTINGS, "label").level).toBe("content");
    // 既知の広告枠なら広告らしさに関係なく判定する
    expect(decide(a, DEFAULT_SETTINGS, "selector").level).toBe("block");
  });
});

describe("settings", () => {
  it("壊れた保存値でも既定値で補う", () => {
    const s = normalizeSettings({ blockThreshold: "x", display: "explode", categories: null, disabledSites: "a" });
    expect(s.blockThreshold).toBe(DEFAULT_SETTINGS.blockThreshold);
    expect(s.display).toBe("blur");
    expect(s.categories).toEqual(DEFAULT_SETTINGS.categories);
    expect(s.disabledSites).toEqual([]);
  });

  it("注意しきい値は遮蔽しきい値を超えない", () => {
    const s = normalizeSettings({ blockThreshold: 0.6, warnThreshold: 0.8 });
    expect(s.warnThreshold).toBe(0.6);
  });

  it("しきい値を 0〜1 に収める", () => {
    expect(normalizeSettings({ blockThreshold: 3 }).blockThreshold).toBe(1);
    expect(normalizeSettings({ warnThreshold: -1 }).warnThreshold).toBe(0);
  });

  it("無効サイトはホスト名に正規化し、重複と不正な行を除く", () => {
    const s = normalizeSettings({ disabledSites: ["https://Example.com/path", "example.com", "", "not a host", "news.example.jp"] });
    expect(s.disabledSites).toEqual(["example.com", "news.example.jp"]);
  });

  it("normalizeHost", () => {
    expect(normalizeHost("WWW.Example.COM")).toBe("www.example.com");
    expect(normalizeHost("http://a.b.c:8080/x?y")).toBe("a.b.c");
    expect(normalizeHost("localhost")).toBe("localhost");
    expect(normalizeHost("foo")).toBeNull();
    expect(normalizeHost(42)).toBeNull();
  });

  it("サブドメインも無効サイトの対象、似た名前は対象外", () => {
    expect(isSiteDisabled("news.example.com", ["example.com"])).toBe(true);
    expect(isSiteDisabled("example.com", ["example.com"])).toBe(true);
    expect(isSiteDisabled("badexample.com", ["example.com"])).toBe(false);
  });
});
