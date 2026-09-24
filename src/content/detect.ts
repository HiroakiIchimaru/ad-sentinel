import type { CandidateSource, CandidateWhere } from "../shared/types";
import { extractText, linksOnlyToSite, MIN_TEXT_CHARS, normalizeText, UI_ATTR } from "./extract";
import selectors from "./selectors.json";

/**
 * 既知の広告枠。EasyList の要素隠しルールから、誤検出の少ない語単位のものを選んだ小さな部分集合。
 * `[class*="ad-"]` のような部分一致は "head-nav" 等に当たるので使わない。
 * 同じ一覧から、判定前に広告枠をぼかす CSS もビルド時に生成する(scripts/build.mjs)。
 */
export const AD_SELECTORS: readonly string[] = selectors.adSelectors;

/** 複数の広告カードが並ぶ「おすすめ記事」型ウィジェット。カードごとに分割して判定する */
export const WIDGET_SELECTORS: readonly string[] = selectors.widgetSelectors;

/** 広告枠・ウィジェットのどちらかに当たるセレクタ(判定前ぼかしの解除や妨害検出に使う) */
export const SLOT_SELECTOR = [...AD_SELECTORS, ...WIDGET_SELECTORS].join(",");

/**
 * 広告配信側が画面に浮かせる既知の要素(Google 自動広告のアンカー・サイドレール・全画面広告、
 * 検索キーワードのチップ)。画面妨害として大きさに関係なく止める。
 */
export const FLOATING_AD_SELECTOR: string = selectors.floatingAdSelectors.join(",");

/** 動画広告プレーヤー(記事の途中や画面の隅に出る、広告のための動画プレーヤー) */
export const VIDEO_AD_PLAYER_SELECTOR: string = selectors.videoAdPlayerSelectors.join(",");

/**
 * 動画広告の配信元。<video> の動画ファイルの配信元と、iframe で動画広告プレーヤーを配る配信元を分ける。
 * doubleclick.net や googlesyndication.com は動画ファイルなら動画広告だが、iframe は普通の画像広告にも
 * 使われるので iframe 側には含めない(含めると画像広告まで「動画広告」として消してしまう)
 */
export const VIDEO_AD_SRC_HOSTS: readonly string[] = selectors.videoAdSrcHosts;
export const VIDEO_AD_FRAME_HOSTS: readonly string[] = selectors.videoAdFrameHosts;

function srcHost(src: string | null | undefined, base: string): string | null {
  if (!src) return null;
  try {
    const url = new URL(src, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.hostname : null;
  } catch {
    return null;
  }
}

/** 動画・iframe の配信元が動画広告の配信元なら、そのホスト名 */
export function videoAdHost(media: Element): string | null {
  const base = media.ownerDocument.baseURI;
  const isFrame = media.tagName === "IFRAME";
  const candidates = isFrame
    ? [media.getAttribute("src")]
    : [(media as HTMLMediaElement).currentSrc, media.getAttribute("src"), ...[...media.querySelectorAll("source")].map((s) => s.getAttribute("src"))];
  const hosts = isFrame ? VIDEO_AD_FRAME_HOSTS : VIDEO_AD_SRC_HOSTS;
  for (const src of candidates) {
    const host = srcHost(src, base);
    if (host && hostMatches(host, hosts)) return host;
  }
  return null;
}

/** 広告表記として扱う短い文字列(前後の括弧は除いて比較) */
const LABEL_RE =
  /^(広告|PR|AD|Ad|Ads|Sponsored|スポンサー|スポンサーリンク|プロモーション|Promoted|Promotion|Advertisement|提供)$/;

/** 広告主名つきの表記(例: 「PR(コトバ製薬株式会社)」「広告:〇〇」「Sponsored by 〇〇」) */
const LABEL_WITH_ADVERTISER_RE =
  /^(PR|広告|AD|Ad|Sponsored|スポンサー|提供)\s*(?:[(]\s*[^()]{1,30}\s*[)]|[:|]\s*\S.{0,29}|by\s+\S.{0,29})$/;

export function isAdLabel(text: string): boolean {
  const t = normalizeText(text).replace(/^[\[【(〔<「]\s*|\s*[\]】)〕>」]$/g, "");
  return LABEL_RE.test(t) || LABEL_WITH_ADVERTISER_RE.test(normalizeText(text));
}

/** 広告配信ドメインのフレームは、フレーム全体を 1 つの広告として扱う */
export const AD_FRAME_HOSTS: readonly string[] = selectors.adFrameHosts;

const AD_FRAME_NAME_RE = /^(google_ads_iframe|aswift_\d|google_ads_frame|ad[_-]?frame|adsframe)/i;

/** 候補にしない要素(中身を持たない・フレーム側で扱う) */
const NON_CONTAINER = new Set(["IMG", "IFRAME", "VIDEO", "AUDIO", "SCRIPT", "STYLE", "LINK", "META", "INPUT", "BR", "HR", "SVG"]);

/** 広告枠とみなすには大きすぎる文字数(記事セクション全体を誤検出した可能性) */
export const MAX_CANDIDATE_CHARS = 2000;
/** 「PR」表記から広告カードをたどるときの上限(これより大きい要素はサイドバー等の入れ物) */
export const MAX_LABEL_CONTAINER_CHARS = 1200;
export const MAX_LABEL_CONTAINER_LINKS = 3;

export interface Candidate {
  el: Element;
  source: CandidateSource;
  where: CandidateWhere;
  /** 判定できる文字量があるか。false は画像だけの広告など */
  readable: boolean;
}

export function hostMatches(host: string, list: readonly string[]): boolean {
  const h = host.toLowerCase();
  return list.some((d) => h === d || h.endsWith(`.${d}`));
}

/** このフレーム自体が広告か(トップフレームは常に false) */
export function isAdFrame(isTop: boolean, hostname: string, frameName: string): boolean {
  if (isTop) return false;
  return hostMatches(hostname, AD_FRAME_HOSTS) || AD_FRAME_NAME_RE.test(frameName);
}

/** 親ページ側から見て、この iframe 要素が広告フレームか(名前か配信元ドメインで判断) */
export function isAdIframe(iframe: Element): boolean {
  if (iframe.tagName !== "IFRAME") return false;
  if (AD_FRAME_NAME_RE.test(iframe.getAttribute("name") ?? "") || AD_FRAME_NAME_RE.test(iframe.id)) return true;
  const src = iframe.getAttribute("src");
  if (!src) return false;
  try {
    return hostMatches(new URL(src, iframe.ownerDocument.baseURI).hostname, AD_FRAME_HOSTS);
  } catch {
    return false;
  }
}

/** iframe の配信元ドメイン(popup に「どの広告か」を示すため) */
export function iframeHost(iframe: Element): string | null {
  const src = iframe.getAttribute("src");
  if (!src) return null;
  try {
    const url = new URL(src, iframe.ownerDocument.baseURI);
    return url.protocol.startsWith("http") ? url.hostname : null;
  } catch {
    return null;
  }
}

function isOurUi(el: Element): boolean {
  return el.closest(`[${UI_ATTR}]`) !== null;
}

function textLength(el: Element): number {
  return extractText(el, MAX_CANDIDATE_CHARS + 1).length;
}

/** リンクそのものか、リンクを含むか(リンクの内側の小さな要素では見出しが欠けるので不可) */
function containsLink(el: Element): boolean {
  return el.matches("a[href]") || el.querySelector("a[href]") !== null;
}

/**
 * ウィジェットをリンク先ごとのカードに分割する。
 * 各リンクから親をたどり、別のリンク先を含まない最大の要素をカードとする。
 */
export function splitCards(container: Element): Element[] {
  const anchors = [...container.querySelectorAll("a[href]")].filter(
    (a) => textLength(a) >= 4 || a.querySelector("img") !== null,
  );
  const hrefs = new Set(anchors.map((a) => a.getAttribute("href")));
  if (hrefs.size < 2) return [container];

  const sameHrefOnly = (el: Element, href: string | null): boolean =>
    [...el.querySelectorAll("a[href]")].every((a) => a.getAttribute("href") === href);

  const cards: Element[] = [];
  for (const a of anchors) {
    const href = a.getAttribute("href");
    let card: Element = a;
    while (card.parentElement && card.parentElement !== container && sameHrefOnly(card.parentElement, href)) {
      card = card.parentElement;
    }
    if (!cards.some((c) => c === card || c.contains(card))) {
      for (let i = cards.length - 1; i >= 0; i--) if (card.contains(cards[i]!)) cards.splice(i, 1);
      cards.push(card);
    }
  }
  return cards;
}

/** 「PR」「広告」表記の要素から、その広告カード全体にあたる要素を探す */
function containerForLabel(label: Element, labelLength: number): Element | null {
  let el: Element | null = label.parentElement;
  for (let depth = 0; el && depth < 6; depth++, el = el.parentElement) {
    if (/^(BODY|HTML|MAIN)$/.test(el.tagName)) return null;
    // 祖先ほど大きくなるので、1 件の広告の入れ物でなくなった時点でたどるのをやめる
    if (!isLabelContainer(el)) return null;
    if (containsLink(el) && textLength(el) - labelLength >= MIN_TEXT_CHARS) return el;
  }
  return null;
}

/** リンク先の種類の数(1 件の広告なら画像と見出しで同じ先を指すので 1〜2 程度) */
function distinctLinks(el: Element): number {
  const hrefs = new Set<string | null>();
  if (el.matches("a[href]")) hrefs.add(el.getAttribute("href"));
  for (const a of el.querySelectorAll("a[href]")) hrefs.add(a.getAttribute("href"));
  return hrefs.size;
}

/**
 * 「PR」表記から見て、1 件の広告カードの入れ物と言えるか。
 * - 広告 iframe や既知の広告枠を含む: その広告は別に判定される(見出し「スポンサー」の付いた枠など)
 * - リンク先が 4 種類以上: 記事一覧やサイドバーなど、複数の項目の入れ物
 * - 文字が多すぎる: 記事セクションなど
 */
export function isLabelContainer(el: Element): boolean {
  if (el.querySelector("iframe") || el.querySelector(SLOT_SELECTOR)) return false;
  if (distinctLinks(el) > MAX_LABEL_CONTAINER_LINKS) return false;
  return textLength(el) <= MAX_LABEL_CONTAINER_CHARS;
}

/**
 * 表記ではない「広告」「PR」の文字を除く。
 * - リンクの文字全体がその語だけ(辞書の見出し語へのリンク、フッターの「PR」カテゴリなど)
 * - 見出し(h1〜h6)の中(記事や辞書の見出しの「広告」)
 */
function isLabelLike(el: Element, text: string): boolean {
  if (el.closest("h1, h2, h3, h4, h5, h6")) return false;
  const link = el.closest("a[href]");
  if (link && normalizeText(link.textContent ?? "") === normalizeText(text)) return false;
  return true;
}

/** 要素の中に広告表記(「PR」「PR(広告主名)」「広告」「Sponsored」など)の文字があるか */
export function hasAdLabelInside(el: Element): boolean {
  const walker = el.ownerDocument.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const raw = n.nodeValue ?? "";
    if (raw.length <= 48 && isAdLabel(raw)) return true;
  }
  return false;
}

/** 本文中の短い広告表記を探す */
function findLabels(doc: Document): Element[] {
  const body = doc.body;
  if (!body) return [];
  const out: Element[] = [];
  const walker = doc.createTreeWalker(body, 4 /* NodeFilter.SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const raw = n.nodeValue ?? "";
    if (raw.length > 48 || !isAdLabel(raw)) continue;
    const parent = n.parentElement;
    if (parent && !isOurUi(parent) && isLabelLike(parent, raw)) out.push(parent);
  }
  return out;
}

/**
 * 候補が今も広告 1 件分の大きさか。HTML の組み立て途中に選んだ候補は、あとで中身が増えて
 * サイドバー全体のような大きな要素になっていることがあるので、判定の直前に確かめ直す。
 */
export function isCandidateSize(el: Element, source: CandidateSource): boolean {
  if (source === "frame") return true;
  if (source === "label") return isLabelContainer(el);
  return textLength(el) <= MAX_CANDIDATE_CHARS;
}

/** 広告を表す id・class の語(ad-slot / adPcFoot / ca_profitx_ad / gn_interstitial など) */
const AD_NAME_TOKENS = new Set(["ad", "ads", "adv", "advert", "adverts", "advertising", "advertisement", "interstitial", "vignette", "sponsor", "sponsored"]);

function nameTokens(el: Element): string[] {
  const raw = `${el.id} ${typeof el.className === "string" ? el.className : ""}`;
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * iframe から固定表示の入れ物までの間に、広告らしい名前(id・class の語)の要素があるか。
 * 既知の配信ドメインでない iframe(自社配信の全画面広告など)を、画面妨害の対象に加えるため。
 */
export function hasAdLikeName(from: Element, to: Element): boolean {
  for (let el: Element | null = from; el; el = el.parentElement) {
    if (nameTokens(el).some((t) => AD_NAME_TOKENS.has(t))) return true;
    if (el === to) break;
  }
  return false;
}

/**
 * ページ内の広告候補を列挙する。判定できるものは内側(より具体的な要素)を優先する。
 * labels=false は「PR」表記からの推定をしない(HTML の組み立て途中は要素の大きさが確定しないため)。
 */
export function findCandidates(doc: Document, options: { labels?: boolean } = {}): Candidate[] {
  const raw = new Map<Element, { source: CandidateSource; where: CandidateWhere }>();
  const add = (el: Element, source: CandidateSource, where: CandidateWhere) => {
    if (NON_CONTAINER.has(el.tagName.toUpperCase()) || isOurUi(el)) return;
    if (!raw.has(el)) raw.set(el, { source, where });
  };

  const pageHost = doc.location?.hostname ?? "";
  for (const w of doc.querySelectorAll(WIDGET_SELECTORS.join(","))) {
    // 記事の推薦と広告が混ざる。「PR(広告主名)」「| PR」などの表記があるカードは広告として判定する。
    // 表記がなく、リンクがすべて掲載サイト自身を指すカードは記事の推薦なので判定しない(jev に送らない)。
    // それ以外の表記のないカードは、jev が広告らしいと強く判断したものだけを対象にする
    for (const card of splitCards(w)) {
      if (hasAdLabelInside(card)) add(card, "selector", "widget");
      else if (!linksOnlyToSite(card, pageHost)) add(card, "widget", "widget");
    }
  }
  for (const el of doc.querySelectorAll(AD_SELECTORS.join(","))) add(el, "selector", "slot");
  for (const label of options.labels === false ? [] : findLabels(doc)) {
    const labelLength = normalizeText(label.textContent ?? "").length;
    const c = containerForLabel(label, labelLength);
    if (c) add(c, "label", "label");
  }

  const readable: Candidate[] = [];
  const unreadable: Candidate[] = [];
  for (const [el, { source, where }] of raw) {
    const len = textLength(el);
    if (len > MAX_CANDIDATE_CHARS) continue;
    if (len >= MIN_TEXT_CHARS) readable.push({ el, source, where, readable: true });
    // 文字のない枠: iframe を含むならフレーム側で判定されるので除外。画像があれば「読み取れず」
    else if (el.querySelector("img") && !el.querySelector("iframe")) unreadable.push({ el, source, where, readable: false });
  }

  // 既知の広告枠・ウィジェットのカードの中で見つけた「PR」表記の候補は捨てる。
  // 表記からたどると「株式会社東芝 | PR」の行だけのような小さな要素になり、広告の見出しが判定から漏れるため
  const known = readable.filter((c) => c.source !== "label");
  const withoutInnerLabels = readable.filter(
    (c) => c.source !== "label" || !known.some((k) => k.el !== c.el && k.el.contains(c.el)),
  );
  // 判定できる候補を別の判定できる候補が含むなら、外側を捨てる(カード分割・ラベルと枠の重複)
  const kept = withoutInnerLabels.filter((a) => !withoutInnerLabels.some((b) => b !== a && a.el.contains(b.el)));
  const overlaps = (c: Candidate) =>
    kept.some((k) => k.el.contains(c.el) || c.el.contains(k.el)) || known.some((k) => k.el.contains(c.el));
  const keptUnreadable = unreadable.filter(
    (a) => !overlaps(a) && !unreadable.some((b) => b !== a && b.el.contains(a.el)),
  );
  return [...kept, ...keptUnreadable];
}
