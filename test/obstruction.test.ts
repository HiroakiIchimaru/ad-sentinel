import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockAnswers } from "../src/background/mock";
import { TabStore } from "../src/background/tabStore";
import { findCandidates, hasAdLabelInside, hasAdLikeName, isAdLabel } from "../src/content/detect";
import { extractLanding, sameSite } from "../src/content/extract";
import { classifyFixed, coverage, isForcedAdText } from "../src/content/obstruction";
import { OBSTRUCT_ATTR, PREBLUR_ATTR, Sentinel, UNLOCK_ATTR } from "../src/content/sentinel";
import { normalizeSettings } from "../src/shared/settings";
import type { ClassifyResponse, FrameReportRequest, ItemReport, RuntimeMessage } from "../src/shared/types";

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

const VW = 1024;
const VH = 768;

beforeEach(() => {
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("style");
  document.body.removeAttribute("style");
  for (const a of [PREBLUR_ATTR, UNLOCK_ATTR, "data-ks-state"]) document.documentElement.removeAttribute(a);
  (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = ImmediateIO;
  Object.defineProperty(window, "innerWidth", { value: VW, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: VH, configurable: true });
});

/** happy-dom はレイアウトしないので、要素の位置を与える */
function place(id: string, rect: { top: number; left: number; width: number; height: number }) {
  const el = document.getElementById(id)!;
  el.getBoundingClientRect = () =>
    ({ ...rect, x: rect.left, y: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height, toJSON() {} }) as DOMRect;
}

/** テストごとに作った Sentinel。次のテストの DOM に反応しないよう、終わったら止める */
const running: Sentinel[] = [];
afterEach(() => {
  for (const s of running.splice(0)) s.halt();
});

function run(settings: Record<string, unknown> = {}) {
  const sent: RuntimeMessage[] = [];
  const send = vi.fn(async (msg: RuntimeMessage) => {
    sent.push(msg);
    if (msg.type === "classify") {
      return { ok: true, answers: mockAnswers(msg.text, msg.landing, msg.markup), mock: true, cached: false, ms: 1 } as ClassifyResponse;
    }
    return { ok: true };
  });
  const sentinel = new Sentinel({ doc: document, isTop: true, send, settings: normalizeSettings(settings) });
  sentinel.start();
  running.push(sentinel);
  const lastItems = (): ItemReport[] => {
    sentinel.report(true);
    const reports = sent.filter((m): m is FrameReportRequest => m.type === "frameReport");
    return reports.at(-1)?.items ?? [];
  };
  return { sentinel, sent, lastItems };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

describe("coverage / classifyFixed", () => {
  it("画面の 4 割以上を覆えば overlay、帯状なら sticky、小さければ対象外", () => {
    expect(classifyFixed({ top: 0, left: 0, width: VW, height: VH }, VW, VH)).toBe("overlay");
    expect(classifyFixed({ top: VH - 90, left: 0, width: VW, height: 90 }, VW, VH)).toBe("sticky");
    expect(classifyFixed({ top: VH - 40, left: VW - 40, width: 36, height: 36 }, VW, VH)).toBeNull();
  });
  it("画面外の部分は数えない", () => {
    expect(coverage({ top: -500, left: 0, width: VW, height: 600 }, VW, VH)).toBeCloseTo(100 / VH);
  });
});

describe("画面をふさぐ広告の自動ブロック", () => {
  const interstitial = () => {
    document.documentElement.style.overflow = "hidden";
    document.body.innerHTML = `
      <p>本文の段落です。</p>
      <div id="inter" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%">
        <ins class="adsbygoogle" id="ad">新型SUV「コトバ・クロス」誕生 試乗予約受付中</ins>
        <button>閉じる(5秒後)</button>
      </div>`;
    place("inter", { top: 0, left: 0, width: VW, height: VH });
  };

  it("全画面の広告を入れ物ごと消し、止められていたスクロールを戻す", async () => {
    interstitial();
    const { lastItems } = run();
    await flush();
    const inter = document.getElementById("inter")!;
    expect(inter.getAttribute(OBSTRUCT_ATTR)).toBe("overlay");
    expect(document.documentElement.getAttribute(UNLOCK_ATTR)).toContain("overflow");
    const items = lastItems();
    // 中の広告は入れ物の 1 件にまとめる
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ state: "obstruct", obstruction: "overlay", onPage: false, where: "fixed" });
    expect(items[0]!.excerpt).toContain("コトバ・クロス");
  });

  it("popup の「表示」で元に戻し、スクロールの解除も外す", async () => {
    interstitial();
    const { sentinel, lastItems } = run();
    await flush();
    const id = lastItems()[0]!.id;
    sentinel.handleTabMessage({ type: "reveal", id, reveal: true });
    expect(document.getElementById("inter")!.hasAttribute(OBSTRUCT_ATTR)).toBe(false);
    expect(document.documentElement.hasAttribute(UNLOCK_ATTR)).toBe(false);
    expect(lastItems()[0]).toMatchObject({ state: "revealed", onPage: true });
    // 一度戻したものは再び消さない
    sentinel.checkObstructions();
    expect(document.getElementById("inter")!.hasAttribute(OBSTRUCT_ATTR)).toBe(false);
  });

  it("画面下に貼り付く広告は sticky として消す", async () => {
    document.body.innerHTML = `<div id="anchor" style="position: fixed; bottom: 0; left: 0; width: 100%; height: 90px">
      <ins class="adsbygoogle">住宅ローン 金利0.3%〜 コトバ銀行</ins></div>`;
    place("anchor", { top: VH - 90, left: 0, width: VW, height: 90 });
    const { lastItems } = run();
    await flush();
    expect(document.getElementById("anchor")!.getAttribute(OBSTRUCT_ATTR)).toBe("sticky");
    expect(lastItems()[0]).toMatchObject({ obstruction: "sticky" });
  });

  it("種類ごとに切れる。切ると止めていたものを戻す", async () => {
    document.body.innerHTML = `<div id="anchor" style="position: fixed; bottom: 0; left: 0; width: 100%; height: 90px">
      <ins class="adsbygoogle">住宅ローン 金利0.3%〜 コトバ銀行</ins></div>`;
    place("anchor", { top: VH - 90, left: 0, width: VW, height: 90 });
    const { sentinel } = run();
    await flush();
    sentinel.updateSettings(normalizeSettings({ obstruction: { sticky: false } }));
    expect(document.getElementById("anchor")!.hasAttribute(OBSTRUCT_ATTR)).toBe(false);
  });

  it("サイト自体の固定ヘッダー(「PR」リンクを含む)は消さない", async () => {
    document.body.innerHTML = `<header id="hdr" style="position: fixed; top: 0; left: 0; width: 100%; height: 80px">
      <nav><a href="/">トップ</a><a href="/news">ニュース</a><a href="/biz">経済</a><a href="/life">くらし</a></nav>
      <div><span>PR</span><a href="https://x.example.com">秋の新作コート 最大30%OFF コトバ百貨店</a></div>
    </header>`;
    place("hdr", { top: 0, left: 0, width: VW, height: 80 });
    run();
    await flush();
    expect(document.getElementById("hdr")!.hasAttribute(OBSTRUCT_ATTR)).toBe(false);
  });

  it("広告側が style 属性に display:block !important を書いて出し直しても、隠したままにする", async () => {
    document.body.innerHTML = `<div id="anchor" style="position: fixed; bottom: 0; left: 0; width: 100%; height: 90px">
      <ins class="adsbygoogle">住宅ローン 金利0.3%〜 コトバ銀行</ins></div>`;
    place("anchor", { top: VH - 90, left: 0, width: VW, height: 90 });
    const { sentinel, lastItems } = run();
    await flush();
    const anchor = document.getElementById("anchor")!;
    expect(anchor.style.getPropertyValue("display")).toBe("none");
    // Google のサイドレールと同じ出し直し方
    anchor.style.setProperty("display", "block", "important");
    await flush();
    expect(anchor.style.getPropertyValue("display")).toBe("none");
    expect(anchor.style.getPropertyPriority("display")).toBe("important");
    // 「表示」で戻したら、元の style に戻し、以後は書き直さない
    sentinel.handleTabMessage({ type: "reveal", id: lastItems()[0]!.id, reveal: true });
    expect(anchor.style.getPropertyValue("display")).toBe("");
    anchor.style.setProperty("display", "block", "important");
    await flush();
    expect(anchor.style.getPropertyValue("display")).toBe("block");
  });

  it("Google の浮動広告(検索チップ・サイドレール)は、小さくても・表示前でも止める", async () => {
    document.body.innerHTML = `<p>本文</p>`;
    document.documentElement.insertAdjacentHTML(
      "beforeend",
      `<div id="google-anno-sa" style="position: fixed; right: 16px; bottom: 16px">オンライン コミュニティ</div>
       <ins class="adsbygoogle" id="rail" data-side-rail-status="idle" style="position: fixed; left: 0; top: 0"></ins>`,
    );
    place("google-anno-sa", { top: VH - 60, left: VW - 300, width: 280, height: 40 });
    const { lastItems } = run();
    await flush();
    expect(document.getElementById("google-anno-sa")!.getAttribute(OBSTRUCT_ATTR)).toBe("sticky");
    expect(document.getElementById("rail")!.getAttribute(OBSTRUCT_ATTR)).toBe("sticky");
    expect(lastItems().filter((i) => i.obstruction === "sticky")).toHaveLength(2);
    document.getElementById("google-anno-sa")!.remove();
    document.getElementById("rail")!.remove();
  });

  it("小さな固定ボタン程度の広告は対象外", async () => {
    document.body.innerHTML = `<div id="fab" class="ad" style="position: fixed; right: 8px; bottom: 8px">広告 コトバ家計簿 無料で試す</div>`;
    place("fab", { top: VH - 44, left: VW - 120, width: 112, height: 36 });
    run();
    await flush();
    expect(document.getElementById("fab")!.hasAttribute(OBSTRUCT_ATTR)).toBe(false);
  });

  it("広告内の音声付き自動再生を消音して止める", async () => {
    document.body.innerHTML = `<div class="ad-slot" id="slot"><p>今なら聴き放題 3か月無料 コトバミュージック</p>
      <audio id="au" autoplay src="jingle.wav"></audio></div>`;
    const au = document.getElementById("au") as HTMLAudioElement;
    const pause = vi.spyOn(au, "pause");
    const { lastItems } = run();
    await flush();
    expect(au.muted).toBe(true);
    expect(pause).toHaveBeenCalled();
    const item = lastItems().find((i) => i.obstruction === "autoplay");
    expect(item).toBeTruthy();
    // 消音だけなので、広告自体の判定結果の行に印を付ける
    expect(item!.state).not.toBe("obstruct");
  });

  it("広告の文面が後から入っても、自動再生を止めた行の番号(id)を引き継ぐ", async () => {
    document.body.innerHTML = `<div class="ad-slot" id="slot"><audio id="au" autoplay src="jingle.wav"></audio></div>`;
    const { sentinel, lastItems } = run();
    await flush();
    const first = lastItems();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ obstruction: "autoplay", where: "media" });
    document.getElementById("slot")!.insertAdjacentHTML("afterbegin", "<p>今なら聴き放題 3か月無料 コトバミュージック</p>");
    sentinel.scan();
    await flush();
    const after = lastItems();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: first[0]!.id, obstruction: "autoplay", where: "slot", state: "ok" });
  });

  it("記事内の動画(広告ではない)には触らない", async () => {
    document.body.innerHTML = `<article><p>記事の動画です</p><video id="v" autoplay src="news.mp4"></video></article>`;
    run();
    await flush();
    expect((document.getElementById("v") as HTMLVideoElement).muted).toBe(false);
  });
});

describe("「PR」表記からの推定が大きな入れ物を選ばない", () => {
  it("見出しの「スポンサー」から、サイドバー全体(記事リンクが多数)を広告とみなさない", () => {
    // 実サイトの「スポンサードリンク」見出しは「スポンサー」と「ドリンク」の 2 つの文字ノードに分かれていた
    document.body.innerHTML = `<div id="side">
      <div id="float"><div class="sidetitle"><a href="/sp">スポンサー<span>ドリンク</span></a></div></div>
      <div class="popular">
        <a href="/a1">人気記事その1の見出しがここに入ります</a><a href="/a2">人気記事その2の見出し</a>
        <a href="/a3">人気記事その3の見出し</a><a href="/a4">人気記事その4の見出し</a>
      </div></div>`;
    expect(findCandidates(document)).toEqual([]);
  });

  it("見出しの下の広告が iframe なら、見出しの入れ物は候補にしない(iframe 側で判定する)", () => {
    document.body.innerHTML = `<div id="box"><p>スポンサー</p><iframe src="about:blank"></iframe><a href="https://x.example.com">詳しく見る 公式サイトはこちら</a></div>`;
    expect(findCandidates(document)).toEqual([]);
  });
});

describe("実サイトで見つかった表記・ウィジェット・全画面広告の形", () => {
  it("リンクの文字全体が「広告」(辞書の見出し語リンク)や見出しの「PR」は表記とみなさない", () => {
    document.body.innerHTML = `
      <p id="p1">ウィキメディア・コモンズには、<a href="/w/ad">広告</a>に関連するメディアがあります。<a href="/x">詳細</a></p>
      <section id="s1"><h3>PR</h3><a href="https://x.example.com">秋の新作コート 最大30%OFF コトバ百貨店</a></section>`;
    expect(findCandidates(document)).toEqual([]);
  });

  it("「PR(広告主名)」の表記を広告表記とみなす(UZOU 等)", () => {
    document.body.innerHTML = `<div id="card"><a href="https://lp.example.com/x">まじか…「飲むだけでスッキリ」衝撃の便通改善法 <span>PR(コトバ製薬株式会社)</span></a></div>`;
    expect(isAdLabel("PR(コトバ製薬株式会社)")).toBe(true);
    expect(isAdLabel("PR（株式会社 ルックルック）")).toBe(true);
    expect(isAdLabel("広告:コトバ銀行")).toBe(true);
    expect(isAdLabel("PR TIMES")).toBe(false);
    expect(findCandidates(document).map((c) => c.source)).toEqual(["label"]);
  });

  it("UZOU の「おすすめ」枠をカードに分け、広告らしさが低いカード(記事の推薦)は記事として扱う", async () => {
    document.body.innerHTML = `<div class="__uz__widget"><div class="__uz__articles-area">
      <div class="__uz__article" id="u1"><a href="https://lp.example.com/a">飲むだけで1ヶ月-12kg!?医師も驚いた“奇跡の酵素” <span>PR(株式会社キセキ)</span></a></div>
      <div class="__uz__article" id="u2"><a href="/news/1">横川尚隆、デカすぎ二の腕にあ然「かっこよすぎ」</a></div>
    </div></div>`;
    run();
    await flush();
    expect(document.getElementById("u1")!.getAttribute("data-ks-state")).toBe("block");
    // 自サイトの記事へのリンクだけのカード(記事の推薦)は、jev に送らず判定もしない
    expect(document.getElementById("u2")!.hasAttribute("data-ks-state")).toBe(false);
  });

  it("Taboola のカード内の「PR」表記ではなく、カード全体(広告の見出し込み)を判定する(tenki.jp 型)", () => {
    document.body.innerHTML = `<div class="trc_rbox_container">
      <div class="videoCube" id="c1">
        <a class="item-thumbnail-href" href="https://lp.example.com/toshiba"><img alt=""></a>
        <a class="item-label-href" href="https://lp.example.com/toshiba"><span class="video-title">脱炭素を支える次世代の電池技術とは</span></a>
        <span class="branding">株式会社東芝 | <span>PR</span></span>
      </div>
      <div class="videoCube" id="c2">
        <a class="item-label-href" href="/forecast/typhoon"><span class="video-title">【速報】台風26号が発生 26日頃には沖縄の南へ</span></a>
      </div>
    </div>`;
    const cs = findCandidates(document);
    // c1 は「| PR」表記のある広告。c2 は自サイトの記事(台風情報)へのリンクだけなので記事の推薦として判定しない
    expect(cs.map((c) => [c.el.id, c.source]).sort()).toEqual([["c1", "selector"]]);
  });

  it("おすすめ枠のカード: PR 表記あり=広告 / 自サイト宛てだけ=記事の推薦(判定しない) / それ以外=広告らしさ次第", () => {
    // 実サイトと同じ形: 広告は UZOU のクリック計測(speee-ad.jp)を経由し、記事の推薦は自サイトへ直接リンク
    const click = "https://ad.speee-ad.jp/v1/click?url=" + encodeURIComponent(location.href) +
      "&redirect_url=" + encodeURIComponent("https://lp.kotoba-pharma.example.jp/lp/benpi?x=1");
    document.body.innerHTML = `<div class="__uz__widget"><div class="__uz__articles-area">
      <div class="__uz__article" id="ad"><a href="${click}">「飲むだけでスッキリ」衝撃の便通改善法</a><div class="__uz__sponsor">PR(コトバ製薬株式会社)</div></div>
      <div class="__uz__article" id="news"><a href="/2024/09/1.html">ネット通販のトラブルが急増 悪質業者の手口に注意</a></div>
      <div class="__uz__article" id="other"><a href="https://takarakuji.example.jp/halloween">1等・前後賞あわせて4億円のチャンス! 宝くじ</a></div>
    </div></div>`;
    expect(hasAdLabelInside(document.getElementById("ad")!)).toBe(true);
    expect(hasAdLabelInside(document.getElementById("news")!)).toBe(false);
    const cs = Object.fromEntries(findCandidates(document).map((c) => [c.el.id, c.source]));
    expect(cs).toEqual({ ad: "selector", other: "widget" });
    // UZOU のクリック計測 URL から、掲載ページ(url=)ではなく広告主(redirect_url=)を取り出す
    expect(extractLanding(document.getElementById("ad")!, location.hostname)).toEqual(["lp.kotoba-pharma.example.jp/lp/benpi"]);
  });

  it("同じサイトかの判定(www の有無・サブドメイン)", () => {
    expect(sameSite("www.example-news.jp", "example-news.jp")).toBe(true);
    expect(sameSite("news.example-news.jp", "www.example-news.jp")).toBe(true);
    expect(sameSite("speee-ad.jp", "example-news.jp")).toBe(false);
    expect(sameSite("notexample-news.jp", "example-news.jp")).toBe(false);
  });

  it("配信ドメイン不明の iframe でも、入れ物の名前が広告らしい全画面表示は止める(ProFitX 型)", async () => {
    document.body.innerHTML = `<p>本文</p>
      <div id="pfx" class="ca_profitx_ad_container" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%">
        <div class="ca_profitx_ad"><iframe class="profitx-ad-frame-markup" src="about:blank"></iframe></div>
      </div>
      <div id="lightbox" class="video-lightbox" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%">
        <iframe src="about:blank" title="動画"></iframe>
      </div>`;
    place("pfx", { top: 0, left: 0, width: VW, height: VH });
    place("lightbox", { top: 0, left: 0, width: VW, height: VH });
    run();
    await flush();
    expect(document.getElementById("pfx")!.getAttribute(OBSTRUCT_ATTR)).toBe("overlay");
    // 広告らしい名前のない全画面表示(サイトの動画ライトボックス等)は止めない
    expect(document.getElementById("lightbox")!.hasAttribute(OBSTRUCT_ATTR)).toBe(false);
  });

  it("html を position:fixed にするスクロール停止は、広告の要素が消えても解除し続ける(html 固定型)", async () => {
    document.body.innerHTML = `<p>本文</p><div id="gn" class="ad-interstitial" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%">
      <ins class="adsbygoogle">新型SUV 試乗予約受付中 コトバ自動車</ins></div>`;
    place("gn", { top: 0, left: 0, width: VW, height: VH });
    document.documentElement.style.position = "fixed";
    const { sentinel } = run();
    await flush();
    expect(document.documentElement.getAttribute(UNLOCK_ATTR)).toContain("fixed");
    document.getElementById("gn")!.remove();
    sentinel.checkObstructions();
    expect(document.documentElement.getAttribute(UNLOCK_ATTR)).toContain("fixed");
    // ページ側が停止をやめたら、解除も外す
    document.documentElement.style.position = "";
    sentinel.checkObstructions();
    expect(document.documentElement.hasAttribute(UNLOCK_ATTR)).toBe(false);
  });

  it("広告らしい名前の判定(語単位)", () => {
    const el = (id: string, cls: string) => Object.assign(document.createElement("div"), { id, className: cls });
    expect(hasAdLikeName(el("adPcFootBnrWrp", ""), el("", ""))).toBe(true);
    expect(hasAdLikeName(el("", "ca_profitx_ad_container"), el("", ""))).toBe(true);
    expect(hasAdLikeName(el("gn_interstitial_outer", ""), el("", ""))).toBe(true);
    expect(hasAdLikeName(el("header", "shadow loader"), el("", ""))).toBe(false);
  });
});

describe("動画広告の自動ブロック", () => {
  it("広告枠の中の動画は、広告枠ごと隠して止める", async () => {
    document.body.innerHTML = `<div class="ad-slot" id="slot"><video id="v" autoplay muted></video><a href="https://game.example.com">新作ゲーム PV 公開中</a></div>`;
    const v = document.getElementById("v") as HTMLVideoElement;
    const pause = vi.spyOn(v, "pause");
    const { lastItems } = run();
    await flush();
    expect(document.getElementById("slot")!.getAttribute(OBSTRUCT_ATTR)).toBe("video");
    expect(pause).toHaveBeenCalled();
    expect(lastItems()).toEqual([expect.objectContaining({ state: "obstruct", obstruction: "video", where: "media" })]);
  });

  it("浮かぶ動画広告プレーヤー(AdPushup・truvid 型)は、広告らしい名前の最も外側の入れ物ごと隠す", async () => {
    document.body.innerHTML = `<div id="cont"><p>${"本文です。".repeat(60)}</p>
      <div id="apex" class="_ap_apex_ad"><div><div id="videoWrapperDiv" style="position: fixed; right: 0; bottom: 0">
        <div id="ap-player" class="video-js"><video src="blob:https://example.com/x"></video>
          <div class="ima-ad-container"><video></video></div></div></div></div></div>
      <div class="truvid_placeholder_8409" id="trv"><div class="trvd_video_player trvdfloater"><video></video></div></div></div>`;
    run();
    await flush();
    expect(document.getElementById("apex")!.getAttribute(OBSTRUCT_ATTR)).toBe("video");
    expect(document.getElementById("trv")!.getAttribute(OBSTRUCT_ATTR)).toBe("video");
    // 本文を含む入れ物までは広げない
    expect(document.getElementById("cont")!.hasAttribute(OBSTRUCT_ATTR)).toBe(false);
  });

  it("動画広告の配信元から届く動画・iframe は、目印がなくても隠す", async () => {
    document.body.innerHTML = `<article><p>${"本文です。".repeat(60)}</p>
      <div id="w1"><video src="https://gcdn.2mdn.net/videoplayback/id/7/file.mp4"></video></div>
      <div id="w2"><iframe src="https://s8t.teads.tv/page/123/tag"></iframe></div></article>`;
    run();
    await flush();
    expect(document.getElementById("w1")!.getAttribute(OBSTRUCT_ATTR)).toBe("video");
    expect(document.getElementById("w2")!.getAttribute(OBSTRUCT_ATTR)).toBe("video");
  });

  it("video.js の操作ボタンの隠し文字(400 字超)があっても、広告の入れ物(_ap_apex_ad)まで隠す", async () => {
    const controls = "Video Player is loading. Play Next Unmute Current Time 0:02 Duration 1:37 Loaded : 37.09% Stream Type LIVE Seek to live, currently behind live Remaining Time 1:35 1x Playback Rate Chapters Chapters Descriptions descriptions off , selected Subtitles subtitles settings , opens subtitles settings dialog subtitles off , selected Audio Track Ladin , selected Fullscreen Backward Skip 10s Play Video Pause Video Forward Skip 10s";
    document.body.innerHTML = `<div id="cont"><p>${"本文です。".repeat(80)}</p>
      <div id="apex" class="_ap_apex_ad"><div id="mid"><div id="wrap"><div id="ap-player" class="video-js">
        <video id="v" src="blob:https://example.com/x"></video><div class="vjs-control-bar">${controls}</div>
      </div></div></div></div></div>`;
    place("v", { top: 100, left: 100, width: 300, height: 169 });
    place("ap-player", { top: 100, left: 100, width: 300, height: 169 });
    place("wrap", { top: 100, left: 100, width: 300, height: 191 });
    place("mid", { top: 90, left: 90, width: 420, height: 236 });
    place("apex", { top: 60, left: 60, width: 738, height: 356 });
    place("cont", { top: 0, left: 0, width: 790, height: 5000 });
    run();
    await flush();
    expect(document.getElementById("apex")!.getAttribute(OBSTRUCT_ATTR)).toBe("video");
    expect(document.getElementById("cont")!.hasAttribute(OBSTRUCT_ATTR)).toBe(false);
  });

  it("【回帰】Google の画像広告の iframe は動画広告とみなさず、html 直下の iframe でページ全体を隠さない", async () => {
    document.body.innerHTML = `<p>本文</p><ins class="adsbygoogle" id="ins"><iframe name="aswift_1" src="https://googleads.g.doubleclick.net/pagead/ads?x=1"></iframe></ins>`;
    // 実サイトで見つかった、html 直下に置かれる Google の補助 iframe
    const esf = document.createElement("iframe");
    esf.id = "google_esf";
    esf.src = "https://googleads.g.doubleclick.net/pagead/html/esf.html";
    document.documentElement.appendChild(esf);
    const { lastItems } = run();
    await flush();
    expect(document.documentElement.hasAttribute(OBSTRUCT_ATTR)).toBe(false);
    expect(document.body.hasAttribute(OBSTRUCT_ATTR)).toBe(false);
    expect(document.getElementById("ins")!.getAttribute(OBSTRUCT_ATTR)).not.toBe("video");
    expect(lastItems().filter((i) => i.obstruction === "video")).toHaveLength(0);
    esf.remove();
  });

  it("【回帰】body 直下の動画広告は、body ではなく動画だけを隠す", async () => {
    document.body.innerHTML = `<p>本文</p><video id="v" src="https://gcdn.2mdn.net/videoplayback/id/7/file.mp4"></video>`;
    run();
    await flush();
    expect(document.body.hasAttribute(OBSTRUCT_ATTR)).toBe(false);
    expect(document.getElementById("v")!.getAttribute(OBSTRUCT_ATTR)).toBe("video");
  });

  it("GliaCloud の深い入れ子(動画から 9 段上が広告の入れ物)も入れ物ごと隠す", async () => {
    let inner = `<video src="https://gnetwork.gliastudios.com/gnetwork/v.mp4"></video>`;
    for (let i = 0; i < 8; i++) inner = `<div class="InstreamDom_layer_${i}">${inner}</div>`;
    // 実物と同じく、プレーヤーの操作ボタンの文字が 200 字を超える
    inner += `<div class="controls">close Advertisements sample dict (custom chain)-20260923-09:53 arrow_forward_ios もっとみる
      CANCEL NEXT VIDEO pause volume_mute AD Pause Play 00:00 00:18 01:16 Unmute Mute Play play_arrow volume_mute AD
      Powered by GliaStudios settings fullscreen picture_in_picture closed_caption replay skip_next</div>`;
    document.body.innerHTML = `<div id="cont"><p>${"本文です。".repeat(60)}</p>
      <div id="gliacloud-video-ad" class="gliaplayer-container">${inner}</div></div>`;
    run();
    await flush();
    expect(document.getElementById("gliacloud-video-ad")!.getAttribute(OBSTRUCT_ATTR)).toBe("video");
    expect(document.getElementById("cont")!.hasAttribute(OBSTRUCT_ATTR)).toBe(false);
  });

  it("記事の動画プレーヤー(広告のしるしがない)には触らない", async () => {
    document.body.innerHTML = `<article><figure class="article-video" id="fig"><video id="v" src="https://news.example.com/movie.mp4" controls></video>
      <figcaption>現地の様子(動画)</figcaption></figure></article>`;
    run();
    await flush();
    expect(document.getElementById("fig")!.hasAttribute(OBSTRUCT_ATTR)).toBe(false);
  });

  it("設定で切ると隠さない", async () => {
    document.body.innerHTML = `<div class="ad-slot" id="slot"><video></video><a href="https://game.example.com">新作ゲーム PV 公開中</a></div>`;
    run({ obstruction: { video: false } });
    await flush();
    expect(document.getElementById("slot")!.hasAttribute(OBSTRUCT_ATTR)).toBe(false);
  });
});

describe("広告の閲覧を強制する全画面表示", () => {
  const gate = (text: string) => {
    document.body.style.overflow = "hidden";
    document.body.innerHTML = `<main><p>記事の本文</p></main>
      <div id="backdrop" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%"></div>
      <div id="gate" role="dialog" style="position: fixed; top: 20%; left: 25%; width: 50%; height: 40%">
        <p>${text}</p><button>広告を見る</button><button>閉じる</button></div>`;
    place("backdrop", { top: 0, left: 0, width: VW, height: VH });
    place("gate", { top: VH * 0.2, left: VW * 0.25, width: VW * 0.5, height: VH * 0.4 });
  };

  it("「広告を見て続きを読む」ダイアログを、暗い背景ごと隠してスクロールを戻す", async () => {
    gate("この記事の続きを読むには、短い動画広告をご覧ください");
    const { sentinel, lastItems } = run();
    await flush();
    expect(document.getElementById("gate")!.getAttribute(OBSTRUCT_ATTR)).toBe("overlay");
    expect(document.getElementById("backdrop")!.getAttribute(OBSTRUCT_ATTR)).toBe("overlay");
    expect(document.documentElement.getAttribute(UNLOCK_ATTR)).toContain("overflow");
    // 背景は一覧に出さず、ダイアログの 1 行だけ
    const items = lastItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ obstruction: "overlay", state: "obstruct" });
    // 「表示」で戻すと、背景も戻る
    sentinel.handleTabMessage({ type: "reveal", id: items[0]!.id, reveal: true });
    expect(document.getElementById("backdrop")!.hasAttribute(OBSTRUCT_ATTR)).toBe(false);
    expect(document.getElementById("backdrop")!.style.display).toBe("");
  });

  it.each([
    ["有料会員限定の記事です。続きを読むにはログインしてください", "ペイウォール"],
    ["広告ブロッカーを無効にしてください", "広告ブロッカーへの警告"],
    ["当サイトは Cookie を使用します。同意しますか?", "同意画面"],
  ])("「%s」(%s)は止めない", async (text) => {
    gate(text);
    run();
    await flush();
    expect(document.getElementById("gate")!.hasAttribute(OBSTRUCT_ATTR)).toBe(false);
  });

  it("文言の判定", () => {
    expect(isForcedAdText("広告を視聴すると記事の続きが読めます")).toBe(true);
    expect(isForcedAdText("動画を最後まで見ると特典が受け取れます")).toBe(true);
    expect(isForcedAdText("Watch a short ad to continue reading")).toBe(true);
    expect(isForcedAdText("広告 · 5秒後に閉じられます")).toBe(true);
    expect(isForcedAdText("パーソナライズされた広告を表示します")).toBe(false);
  });
});

describe("判定に失敗したときの再試行", () => {
  const ad = () => {
    document.body.innerHTML = `<ins class="adsbygoogle" id="bad">【警告】お使いのiPhoneがウイルスに感染しています(4件検出)。今すぐ修復</ins>`;
  };
  const sentinelWith = (responses: ClassifyResponse[]) => {
    let call = 0;
    const send = vi.fn(async (msg: RuntimeMessage) => {
      if (msg.type !== "classify") return { ok: true };
      return responses[Math.min(call++, responses.length - 1)];
    });
    const s = new Sentinel({ doc: document, isTop: true, send, settings: normalizeSettings({}), retryBaseMs: 10 });
    s.start();
    running.push(s);
    return send;
  };
  const okAnswer = (text: string): ClassifyResponse => ({ ok: true, answers: mockAnswers(text), mock: true, cached: false, ms: 1 });

  it("タイムアウトで失敗しても、少し待って再判定する", async () => {
    ad();
    const send = sentinelWith([{ ok: false, code: "timeout", error: "t" }, okAnswer("【警告】ウイルスに感染しています。今すぐ修復")]);
    await flush();
    await new Promise((r) => setTimeout(r, 60));
    expect(document.getElementById("bad")!.getAttribute("data-ks-state")).toBe("block");
    expect(send.mock.calls.filter(([m]) => m.type === "classify")).toHaveLength(2);
  });

  it("再試行は 2 回まで", async () => {
    ad();
    const send = sentinelWith([{ ok: false, code: "network", error: "n" }]);
    await new Promise((r) => setTimeout(r, 150));
    expect(document.getElementById("bad")!.getAttribute("data-ks-state")).toBe("error");
    expect(send.mock.calls.filter(([m]) => m.type === "classify")).toHaveLength(3);
  });

  it("APIキーが無効なときは再試行しない", async () => {
    ad();
    const send = sentinelWith([{ ok: false, code: "auth", error: "a" }]);
    await new Promise((r) => setTimeout(r, 100));
    expect(send.mock.calls.filter(([m]) => m.type === "classify")).toHaveLength(1);
  });
});

describe("拡張機能との接続が切れたとき(再読み込み・更新)", () => {
  it("送信が同期的に例外を投げても、止まるだけで例外を外に出さない", async () => {
    document.body.innerHTML = `<ins class="adsbygoogle">秋の新作コート 最大30%OFF コトバ百貨店</ins>`;
    const send = vi.fn((_msg: RuntimeMessage): Promise<unknown> => {
      throw new Error("Extension context invalidated.");
    });
    const sentinel = new Sentinel({ doc: document, isTop: true, send, settings: normalizeSettings({}) });
    expect(() => sentinel.start()).not.toThrow();
    await flush();
    sentinel.halt();
    expect(sentinel.isRunning).toBe(false);
    // 止まった後はページの変化に反応しない
    document.body.insertAdjacentHTML("beforeend", `<ins class="adsbygoogle">別の広告の文面がここに入ります</ins>`);
    await new Promise((r) => setTimeout(r, 500));
    expect(send.mock.calls.filter(([m]) => m.type === "classify").length).toBeLessThanOrEqual(1);
  });
});

describe("HTML の組み立て途中に選んだ候補", () => {
  it("組み立て途中は「PR」表記からの推定をしない", () => {
    document.body.innerHTML = `<div id="card"><span>PR</span><a href="https://x.example.com">秋の新作コート 最大30%OFF コトバ百貨店</a></div>`;
    expect(findCandidates(document, { labels: false })).toEqual([]);
    expect(findCandidates(document).map((c) => c.el.id)).toEqual(["card"]);
  });

  it("判定の直前に大きくなっていたら(サイドバー全体など)候補から外し、何も付けない", async () => {
    document.body.innerHTML = `<div id="side"><span>PR</span><a href="https://x.example.com">秋の新作コート 最大30%OFF コトバ百貨店</a></div>`;
    const { sent } = run();
    // 候補に選ばれた後、判定が始まる前に中身が増える(HTML の続きが届いた状態)
    document.getElementById("side")!.insertAdjacentHTML("beforeend", `<p>${"人気記事の見出し。".repeat(200)}</p>`);
    await flush();
    const side = document.getElementById("side")!;
    expect(side.hasAttribute("data-ks-state")).toBe(false);
    expect(side.hasAttribute("data-ks-pos")).toBe(false);
    expect(sent.filter((m) => m.type === "classify")).toHaveLength(0);
  });
});

describe("判定前ぼかし(document_start)", () => {
  it("判定しない広告枠(iframe だけの入れ物)は、ぼかしを外す印を付ける。停止で全部外す", async () => {
    document.body.innerHTML = `<div class="ad-wrapper" id="w"><iframe src="about:blank"></iframe></div>`;
    const { sentinel } = run();
    await flush();
    expect(document.documentElement.hasAttribute(PREBLUR_ATTR)).toBe(true);
    expect(document.getElementById("w")!.getAttribute("data-ks-state")).toBe("skip");
    sentinel.stop();
    expect(document.documentElement.hasAttribute(PREBLUR_ATTR)).toBe(false);
    expect(document.querySelectorAll("[data-ks-state]")).toHaveLength(0);
  });

  it("判定中ぼかしを切ると、判定前ぼかしも使わない", async () => {
    run({ pendingBlur: false });
    await flush();
    expect(document.documentElement.hasAttribute(PREBLUR_ATTR)).toBe(false);
  });
});

describe("popup の一覧とページ上の広告の対応", () => {
  const page = () => {
    document.body.innerHTML = `
      <ins class="adsbygoogle" id="bad">【警告】お使いのiPhoneがウイルスに感染しています(4件検出)。今すぐ修復</ins>
      <div class="trc_rbox_container">
        <div class="c"><a href="https://a.example.com/lp"><span>北海道うまいもの市 送料無料キャンペーン</span></a></div>
        <div class="c"><a href="https://b.example.com/"><span>レシートを撮るだけの家計簿アプリ 3か月無料</span></a></div>
      </div>`;
  };

  it("一覧の各行に、場所(広告枠・おすすめ枠)とリンク先ドメインを載せる", async () => {
    page();
    const { lastItems } = run();
    await flush();
    const items = lastItems();
    const bad = items.find((i) => i.excerpt.includes("ウイルス"))!;
    const food = items.find((i) => i.excerpt.includes("北海道"))!;
    expect(bad.where).toBe("slot");
    expect(food).toMatchObject({ where: "widget", domain: "a.example.com" });
    expect(bad.onPage).toBe(true);
  });

  it("番号表示の知らせで、ページ上に番号の層を出す(知らせが途切れると消える)", async () => {
    page();
    const { sentinel, lastItems } = run();
    await flush();
    const items = lastItems();
    sentinel.handleTabMessage({ type: "markers", items: items.map((i, k) => ({ id: i.id, n: k + 1 })), focus: items[0]!.id });
    expect(document.querySelector('[data-ad-sentinel-ui="markers"]')).not.toBeNull();
    sentinel.handleTabMessage({ type: "markers", items: [], focus: null });
    expect(document.querySelector('[data-ad-sentinel-ui="markers"]')).toBeNull();
  });

  it("「移動」でその広告へスクロールする", async () => {
    page();
    const { sentinel, lastItems } = run();
    await flush();
    const bad = document.getElementById("bad")!;
    const scroll = vi.fn();
    bad.scrollIntoView = scroll;
    sentinel.handleTabMessage({ type: "locate", id: lastItems().find((i) => i.excerpt.includes("ウイルス"))!.id });
    expect(scroll).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
  });

  it("popup の「表示」「隠す」で、ぼかしを切り替える", async () => {
    page();
    const { sentinel, lastItems } = run();
    await flush();
    const id = lastItems().find((i) => i.excerpt.includes("ウイルス"))!.id;
    sentinel.handleTabMessage({ type: "reveal", id, reveal: true });
    expect(document.getElementById("bad")!.getAttribute("data-ks-state")).toBe("revealed");
    sentinel.handleTabMessage({ type: "reveal", id, reveal: false });
    expect(document.getElementById("bad")!.getAttribute("data-ks-state")).toBe("block");
  });
});

describe("TabStore の通し番号", () => {
  const item = (id: string, state: ItemReport["state"]): ItemReport => ({
    id,
    state,
    excerpt: id,
    source: "selector",
    where: "slot",
    domain: null,
    top: null,
    answers: null,
    markup: [],
    obstruction: null,
    onPage: true,
    mock: true,
  });

  it("判定が終わったものから番号を振り、状態が変わっても番号と並びは変えない", async () => {
    const store = new TabStore(null);
    await store.report(1, 0, true, "example.com", [item("a", "ok"), item("b", "pending")]);
    await store.report(1, 5, false, null, [item("f", "block")]);
    await store.report(1, 0, true, "example.com", [item("a", "block"), item("b", "warn")]);
    const s = await store.get(1);
    expect(s.items.map((i) => [i.id, i.n])).toEqual([
      ["a", 1],
      ["f", 2],
      ["b", 3],
    ]);
  });

  it("ページ遷移で番号を振り直す", async () => {
    const store = new TabStore(null);
    await store.report(1, 0, true, "example.com", [item("a", "ok")]);
    store.reset(1);
    await store.report(1, 0, true, "example.com", [item("z", "ok")]);
    expect((await store.get(1)).items[0]!.n).toBe(1);
  });
});
