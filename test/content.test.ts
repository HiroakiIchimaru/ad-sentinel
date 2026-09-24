import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findCandidates, isAdFrame, splitCards } from "../src/content/detect";
import { extractLanding, extractMarkup, extractText, landingOf } from "../src/content/extract";
import { uiOf } from "../src/content/overlay";
import { Sentinel } from "../src/content/sentinel";
import { mockAnswers } from "../src/background/mock";
import { normalizeSettings } from "../src/shared/settings";
import type { ClassifyResponse, FrameReportRequest, RuntimeMessage, Settings } from "../src/shared/types";

/** happy-dom はレイアウトしないので、observe した要素をすぐ「画面内」と報告する IntersectionObserver に差し替える */
class ImmediateIO {
  constructor(private readonly cb: IntersectionObserverCallback) {}
  observe(target: Element) {
    queueMicrotask(() =>
      this.cb([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver),
    );
  }
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  document.body.innerHTML = "";
  (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = ImmediateIO;
});

describe("extractText", () => {
  it("script・style・入力欄は読まず、画像の alt は読む", () => {
    document.body.innerHTML = `<div id="ad">
      <script>var secret = 1;</script><style>.x{}</style>
      <img alt="限定セール"><span>ＡＢＣ　100％</span>
      <input value="パスワード"><textarea>メモ</textarea>
      <div contenteditable="true">下書き</div>
    </div>`;
    const t = extractText(document.getElementById("ad")!);
    expect(t).toBe("限定セール ABC 100%");
  });

  it("600 文字で切る", () => {
    document.body.innerHTML = `<div id="ad">${"あ".repeat(900)}</div>`;
    expect(extractText(document.getElementById("ad")!).length).toBe(600);
  });
});

describe("extractLanding", () => {
  it("クリック計測 URL から遷移先を取り出し、クエリと自サイトは除く", () => {
    document.body.innerHTML = `<div id="ad">
      <a href="https://www.googleadservices.com/pagead/aclk?sa=L&adurl=https%3A%2F%2Fshop.example.jp%2Flp%2Fdiet%3Fid%3D1">a</a>
      <a href="/local">b</a>
      <a href="https://evil.example.net/x?token=secret">c</a>
      <a href="javascript:void(0)">d</a>
    </div>`;
    const ds = extractLanding(document.getElementById("ad")!, location.hostname);
    expect(ds).toEqual(["shop.example.jp/lp/diet", "evil.example.net/x"]);
  });

  it("パスは先頭 2 段まで、ID らしい断片は落とす", () => {
    expect(landingOf(new URL("https://a.example.com/c/8f7a6b5c4d3e2f1a/offer/x/y#top"))).toBe("a.example.com/c/offer");
    expect(landingOf(new URL("https://a.example.com/"))).toBe("a.example.com");
    expect(landingOf(new URL("https://a.example.com/item/12345678"))).toBe("a.example.com/item");
  });
});

describe("extractMarkup(HTML の特徴)", () => {
  const markupOf = (html: string) => {
    document.body.innerHTML = `<div id="ad">${html}</div>`;
    const el = document.getElementById("ad")!;
    return extractMarkup(el, extractText(el)).sort();
  };

  it("入力欄の種類を見分ける(値は読まない)", () => {
    expect(markupOf(`<input type="password" value="secret">`)).toEqual(["password_field"]);
    expect(markupOf(`<input name="cc-number" autocomplete="cc-number">`)).toEqual(["card_field"]);
    expect(markupOf(`<input type="email"><input placeholder="お名前">`)).toEqual(["personal_field"]);
    expect(markupOf(`<input type="hidden" name="password"><button>送信</button>`)).toEqual([]);
  });

  it("カウントダウン・新しいウィンドウ・自動再生", () => {
    expect(markupOf(`<span>残り58秒</span>`)).toEqual(["countdown"]);
    expect(markupOf(`<div class="countdown-box"></div>`)).toEqual(["countdown"]);
    expect(markupOf(`<a href="https://x.example.com" target="_blank">見る</a>`)).toEqual(["new_window"]);
    expect(markupOf(`<video autoplay src="a.mp4"></video>`)).toEqual(["autoplay_media"]);
  });

  it("普通の広告には特徴なし", () => {
    expect(markupOf(`<a href="https://shop.example.com">秋の新作コート 最大30%OFF</a>`)).toEqual([]);
  });
});

describe("findCandidates", () => {
  it("既知の広告枠を見つける", () => {
    document.body.innerHTML = `<ins class="adsbygoogle" id="a">秋の新作コート 最大30%OFF コトバ百貨店</ins>`;
    const cs = findCandidates(document);
    expect(cs.map((c) => [c.el.id, c.source])).toEqual([["a", "selector"]]);
  });

  it("「PR」表記のカードを、リンクを含むカード単位で見つける", () => {
    document.body.innerHTML = `<ul class="feed">
      <li id="news"><a href="/n1">秋の紅葉が各地で見頃に、週末は混雑の予想</a></li>
      <li id="pr"><span class="tag">PR</span><a href="https://x.example.com">アカウントが停止されました。本人確認のため再登録を</a></li>
    </ul>`;
    const cs = findCandidates(document);
    expect(cs.map((c) => [c.el.id, c.source])).toEqual([["pr", "label"]]);
  });

  it("【PR】のように括弧つきでも表記とみなす。PR TIMES のような文は対象外", () => {
    document.body.innerHTML = `
      <div id="a"><em>【PR】</em><a href="https://y.example.com">週末限定 北海道うまいもの市 送料無料</a></div>
      <div id="b"><span>PR TIMES</span><a href="/p">新製品を発表しました、詳しくはこちらをご覧ください</a></div>`;
    expect(findCandidates(document).map((c) => c.el.id)).toEqual(["a"]);
  });

  it("注意喚起の記事は広告枠でなければ候補にしない", () => {
    document.body.innerHTML = `<article id="news"><h2>「必ず儲かる」投資広告に注意</h2>
      <p>元本保証をうたう広告や、LINE登録に誘導する手口が増えています。</p></article>`;
    expect(findCandidates(document)).toEqual([]);
  });

  it("おすすめ記事ウィジェットはカードに分割する", () => {
    document.body.innerHTML = `<div class="trc_rbox_container" id="w">
      <div class="card" id="c1"><a href="https://a.example.com"><img alt=""><span>元本保証で月利20%の自動売買</span></a><span>Sponsored</span></div>
      <div class="card" id="c2"><a href="https://b.example.com"><img alt=""><span>北海道うまいもの市 送料無料キャンペーン</span></a></div>
    </div>`;
    expect(splitCards(document.getElementById("w")!).map((e) => e.id)).toEqual(["c1", "c2"]);
    expect(findCandidates(document).map((c) => c.el.id).sort()).toEqual(["c1", "c2"]);
  });

  it("文字のない画像広告は読み取れず、iframe だけの枠はフレーム側に任せる", () => {
    document.body.innerHTML = `
      <div class="ad-slot" id="img"><a href="https://z.example.com"><img src="x.png" alt=""></a></div>
      <div class="ad-slot" id="frame"><iframe src="about:blank"></iframe></div>`;
    const cs = findCandidates(document);
    expect(cs.map((c) => [c.el.id, c.readable])).toEqual([["img", false]]);
  });

  it("広告枠と表記が重なったら内側だけを残す", () => {
    document.body.innerHTML = `<div class="ad-wrapper" id="outer"><div class="ad" id="inner">
      <span>広告</span><a href="https://q.example.com">秋の新作コート 最大30%OFF コトバ百貨店</a></div></div>`;
    expect(findCandidates(document).map((c) => c.el.id)).toEqual(["inner"]);
  });

  it("大きすぎる要素(記事全体の誤検出)は除く", () => {
    document.body.innerHTML = `<div class="sponsored" id="big">${"本文".repeat(1500)}</div>`;
    expect(findCandidates(document)).toEqual([]);
  });
});

describe("isAdFrame", () => {
  it("広告配信ドメイン・広告フレーム名なら true、トップは常に false", () => {
    expect(isAdFrame(false, "tpc.googlesyndication.com", "")).toBe(true);
    expect(isAdFrame(false, "example.com", "google_ads_iframe_/123/top_0")).toBe(true);
    expect(isAdFrame(false, "example.com", "aswift_1")).toBe(true);
    expect(isAdFrame(false, "www.youtube.com", "")).toBe(false);
    expect(isAdFrame(true, "tpc.googlesyndication.com", "")).toBe(false);
  });
});

describe("Sentinel(content script の統合)", () => {
  // テストごとに作った Sentinel は、次のテストの DOM に反応しないよう終わったら止める
  const running: Sentinel[] = [];
  afterEach(() => {
    for (const s of running.splice(0)) s.halt();
  });

  function run(settings: Partial<Settings> = {}, respond?: (text: string) => ClassifyResponse) {
    const sent: RuntimeMessage[] = [];
    const send = vi.fn(async (msg: RuntimeMessage) => {
      sent.push(msg);
      if (msg.type === "classify") {
        return respond
          ? respond(msg.text)
          : ({ ok: true, answers: mockAnswers(msg.text, msg.landing, msg.markup), mock: true, cached: false, ms: 1 } as ClassifyResponse);
      }
      return { ok: true };
    });
    const sentinel = new Sentinel({ doc: document, isTop: true, send, settings: normalizeSettings(settings) });
    sentinel.start();
    running.push(sentinel);
    return { sentinel, sent, send };
  }

  const flush = () => new Promise((r) => setTimeout(r, 20));

  const page = () => {
    document.body.innerHTML = `
      <ins class="adsbygoogle" id="bad">【警告】お使いのiPhoneがウイルスに感染しています(4件検出)。今すぐ修復してください</ins>
      <ins class="adsbygoogle" id="good">秋の新作コート 最大30%OFF|コトバ百貨店オンラインストア</ins>`;
  };

  it("悪質な広告だけをぼかし、普通の広告には触らない", async () => {
    page();
    const { sentinel } = run();
    await flush();
    const bad = document.getElementById("bad")!;
    const good = document.getElementById("good")!;
    expect(bad.getAttribute("data-ks-state")).toBe("block");
    expect(uiOf(bad)?.kind).toBe("cover");
    expect(uiOf(bad)?.root.textContent).toContain("偽の警告・当選通知");
    expect(good.getAttribute("data-ks-state")).toBe("ok");
    expect(uiOf(good)).toBeNull();
    sentinel.stop();
    expect(bad.hasAttribute("data-ks-state")).toBe(false);
    expect(uiOf(bad)).toBeNull();
  });

  it("jev に送るのは広告の文面だけで、ページ本文は送らない", async () => {
    document.body.innerHTML = `<p>非公開の記事本文 SECRET-BODY</p>` + `<ins class="adsbygoogle">秋の新作コート 最大30%OFF コトバ百貨店</ins>`;
    const { sent } = run();
    await flush();
    const classify = sent.filter((m) => m.type === "classify");
    expect(classify).toHaveLength(1);
    expect(JSON.stringify(classify)).not.toContain("SECRET-BODY");
  });

  it("判定に失敗したらぼかしを外して通常表示に戻す(フェイルオープン)", async () => {
    page();
    run({}, () => ({ ok: false, code: "network", error: "down" }));
    await flush();
    const bad = document.getElementById("bad")!;
    expect(bad.getAttribute("data-ks-state")).toBe("error");
    expect(uiOf(bad)).toBeNull();
  });

  it("表示方法を「隠す」に変えると API を呼び直さずに畳む", async () => {
    page();
    const { sentinel, send } = run();
    await flush();
    const calls = send.mock.calls.filter(([m]) => m.type === "classify").length;
    sentinel.updateSettings(normalizeSettings({ display: "hide" }));
    const bad = document.getElementById("bad")!;
    expect(bad.getAttribute("data-ks-display")).toBe("hide");
    expect(uiOf(bad)?.kind).toBe("placeholder");
    expect(bad.previousElementSibling?.hasAttribute("data-ad-sentinel-ui")).toBe(true);
    expect(send.mock.calls.filter(([m]) => m.type === "classify").length).toBe(calls);
  });

  it("しきい値を上げると隠していた広告が戻る", async () => {
    page();
    const { sentinel } = run();
    await flush();
    sentinel.updateSettings(normalizeSettings({ blockThreshold: 0.99, warnThreshold: 0.99 }));
    expect(document.getElementById("bad")!.getAttribute("data-ks-state")).toBe("ok");
  });

  it("ページのスクリプトが合成したクリックでは「表示する」が動かない", async () => {
    page();
    run();
    await flush();
    const bad = document.getElementById("bad")!;
    const btn = uiOf(bad)!.root.querySelector<HTMLButtonElement>('[data-act="reveal"]')!;
    btn.click();
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(bad.getAttribute("data-ks-state")).toBe("block");
  });

  it("popup 用の報告には状態と冒頭 60 文字だけを載せる", async () => {
    page();
    const { sentinel, sent } = run();
    await flush();
    sentinel.report(true);
    const reports = sent.filter((m): m is FrameReportRequest => m.type === "frameReport");
    const last = reports.at(-1)!;
    expect(last.isTop).toBe(true);
    const states = last.items.map((i) => i.state).sort();
    expect(states).toEqual(["block", "ok"]);
    for (const i of last.items) expect(i.excerpt.length).toBeLessThanOrEqual(60);
  });

  it("後から追加された広告も判定する", async () => {
    document.body.innerHTML = `<main id="m"></main>`;
    run();
    await flush();
    document.getElementById("m")!.innerHTML =
      `<div class="ad" id="late">元本保証!放置で稼ぐAI自動売買。LINE登録で無料プレゼント</div>`;
    await new Promise((r) => setTimeout(r, 600));
    expect(document.getElementById("late")!.getAttribute("data-ks-state")).toBe("block");
  });
});
