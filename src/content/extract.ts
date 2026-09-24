import type { MarkupSignal } from "../shared/types";

export const MAX_TEXT_CHARS = 600;
/** これ未満の文字数は判定しない(画像だけの広告など) */
export const MIN_TEXT_CHARS = 12;
export const MAX_DOMAINS = 3;

/** 読まない要素。入力欄・編集可能領域の中身は、広告内であっても送らない */
const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "SVG",
  "CANVAS",
  "IFRAME",
  "OBJECT",
  "INPUT",
  "TEXTAREA",
  "SELECT",
  "OPTION",
]);

/** 本拡張が差し込んだ UI の印 */
export const UI_ATTR = "data-ad-sentinel-ui";

/**
 * 広告のクリック計測 URL から実際の遷移先を取り出すためのパラメータ名(前から順に試す)。
 * UZOU(speee-ad.jp)は url= に掲載ページ、redirect_url= に広告主を入れるので redirect_url を先に見る
 */
const REDIRECT_PARAMS = ["adurl", "redirect_url", "url", "u", "dest", "destination", "redirect", "lp"];
const CLICK_TRACKER_HOSTS = [
  "googleadservices.com",
  "doubleclick.net",
  "googlesyndication.com",
  "g.doubleclick.net",
  "ad.doubleclick.net",
  "clickserve.dartsearch.net",
  "speee-ad.jp",
];

/** 同じサイトのホストか(www. の有無やサブドメインの違いは同じとみなす) */
export function sameSite(a: string, b: string): boolean {
  const x = a.toLowerCase().replace(/^www\./, "");
  const y = b.toLowerCase().replace(/^www\./, "");
  return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`);
}

/**
 * 要素内のリンクがすべて掲載サイト自身を指すか(リンクが 1 つ以上ある場合)。
 * おすすめ枠で、自サイトの記事の推薦を広告と見分けるのに使う
 */
export function linksOnlyToSite(root: Element, pageHost: string): boolean {
  const base = root.ownerDocument.baseURI || "https://invalid.invalid/";
  const anchors = [...(root.matches("a[href]") ? [root] : []), ...root.querySelectorAll("a[href]")];
  if (anchors.length === 0 || !pageHost) return false;
  return anchors.every((a) => {
    const url = resolveLanding(a.getAttribute("href") ?? "", base);
    return url !== null && sameSite(url.hostname, pageHost);
  });
}

export interface Extracted {
  text: string;
  /** リンク先の「ドメイン/パス」 */
  landing: string[];
  markup: MarkupSignal[];
}

function skip(el: Element): boolean {
  if (SKIP_TAGS.has(el.tagName.toUpperCase())) return true;
  if (el.hasAttribute(UI_ATTR)) return true;
  if (el.getAttribute("aria-hidden") === "true" && !el.querySelector("img[alt]")) return true;
  const ce = el.getAttribute("contenteditable");
  return ce !== null && ce !== "false";
}

export function normalizeText(s: string): string {
  return s.normalize("NFKC").replace(/\s+/g, " ").trim();
}

/**
 * 要素内の文字を集める。レイアウトに依存しない(innerText を使わない)ので、
 * ぼかしや非表示にした後も同じ結果になり、変化検知に使える。
 */
export function extractText(root: Element, maxChars = MAX_TEXT_CHARS): string {
  const parts: string[] = [];
  let length = 0;

  const walk = (node: Node): void => {
    if (length >= maxChars) return;
    if (node.nodeType === 3) {
      const t = node.nodeValue ?? "";
      if (t.trim()) {
        parts.push(t);
        length += t.length;
      }
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    if (skip(el)) return;
    // 画像広告の alt / title は文面として扱う
    if (el.tagName === "IMG" || el.getAttribute("role") === "img") {
      const alt = el.getAttribute("alt") || el.getAttribute("aria-label") || el.getAttribute("title");
      if (alt && alt.trim()) {
        parts.push(` ${alt} `);
        length += alt.length;
      }
      return;
    }
    // ブロック境界で単語がくっつかないよう区切る
    parts.push(" ");
    for (let c = el.firstChild; c; c = c.nextSibling) walk(c);
    parts.push(" ");
  };

  // documentElement を渡された場合(広告 iframe 全体)は body 以下だけを見る
  const start = root.tagName === "HTML" ? (root.ownerDocument.body ?? root) : root;
  walk(start);
  return normalizeText(parts.join("")).slice(0, maxChars);
}

/** クリック計測 URL なら実際の遷移先 URL を返す */
function resolveLanding(href: string, base: string): URL | null {
  try {
    const url = new URL(href, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    if (CLICK_TRACKER_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
      for (const p of REDIRECT_PARAMS) {
        const v = url.searchParams.get(p);
        if (v && /^https?:\/\//i.test(v)) return resolveLanding(v, base) ?? url;
      }
    }
    return url;
  } catch {
    return null;
  }
}

/** 計測 ID らしいパスの断片(長い16進・長い数字・長い英数字記号の羅列) */
function looksLikeId(segment: string): boolean {
  return /^[0-9a-f]{12,}$/i.test(segment) || /^\d{6,}$/.test(segment) || (segment.length >= 20 && /^[\w=-]+$/.test(segment));
}

/**
 * 「ドメイン/パス」に縮める。クエリ・フラグメント・ID らしい断片は落とし、パスは先頭 2 段まで。
 * 例: https://kiseki.example.org/lp/diet/?gclid=xxx → kiseki.example.org/lp/diet
 */
export function landingOf(url: URL): string {
  const segments = url.pathname
    .split("/")
    .filter((s) => s && !looksLikeId(s))
    .slice(0, 2)
    .map((s) => s.slice(0, 40));
  return url.hostname.toLowerCase() + (segments.length ? `/${segments.join("/")}` : "");
}

/** 広告のリンク先を集める(自サイトへのリンクは除く) */
export function extractLanding(root: Element, pageHost: string): string[] {
  const base = root.ownerDocument.baseURI || "https://invalid.invalid/";
  const anchors: Element[] = [];
  if (root.tagName === "A") anchors.push(root);
  const closest = root.closest("a[href]");
  if (closest && closest !== root) anchors.push(closest);
  anchors.push(...root.querySelectorAll("a[href], area[href]"));

  const out: string[] = [];
  for (const a of anchors) {
    const href = a.getAttribute("href");
    if (!href) continue;
    const url = resolveLanding(href, base);
    if (!url || sameSite(url.hostname, pageHost)) continue;
    const landing = landingOf(url);
    if (out.includes(landing)) continue;
    out.push(landing);
    if (out.length >= MAX_DOMAINS) break;
  }
  return out;
}

const COUNTDOWN_RE = /(^|[^\d])\d{1,2}:\d{2}([^\d]|$)|残り\s?\d+\s?(秒|分)|\d+\s?秒(以内|後)|あと\s?\d+\s?(秒|分)|seconds? left|countdown/i;

/** 入力欄を「何を入れさせる欄か」で分類する。値は読まない */
function fieldKind(el: Element): MarkupSignal | null {
  const type = (el.getAttribute("type") ?? "").toLowerCase();
  if (["hidden", "submit", "button", "checkbox", "radio", "image", "reset"].includes(type)) return null;
  const hints = ["name", "id", "autocomplete", "placeholder", "aria-label"]
    .map((a) => el.getAttribute(a) ?? "")
    .join(" ")
    .toLowerCase();
  if (type === "password" || /pass|パスワード|暗証/.test(hints)) return "password_field";
  if (/cc-|card|カード|cvv|cvc|セキュリティコード|有効期限/.test(hints)) return "card_field";
  if (["email", "tel"].includes(type) || /mail|tel|phone|電話|氏名|名前|住所|郵便|zip|birth|生年月日|name/.test(hints)) {
    return "personal_field";
  }
  return null;
}

/**
 * 広告の HTML から構造上の特徴を取り出す(jev の判定材料)。
 * レイアウトに依存しないので、判定の再現性とキャッシュが保たれる。
 */
export function extractMarkup(root: Element, text: string): MarkupSignal[] {
  const scope = root.tagName === "HTML" ? root.ownerDocument : root;
  const out = new Set<MarkupSignal>();
  for (const field of scope.querySelectorAll("input, select, textarea")) {
    const kind = fieldKind(field);
    if (kind) out.add(kind);
  }
  if (COUNTDOWN_RE.test(text) || scope.querySelector('[class*="countdown"], [id*="countdown"], [class*="timer"]')) {
    out.add("countdown");
  }
  const selfLink = root.closest("a[href]");
  if (
    scope.querySelector('a[target="_blank"], [onclick*="window.open"]') ||
    (selfLink && selfLink.getAttribute("target") === "_blank")
  ) {
    out.add("new_window");
  }
  if (scope.querySelector("video[autoplay], audio[autoplay]")) out.add("autoplay_media");
  return [...out];
}

export function extract(root: Element, pageHost: string): Extracted {
  const text = extractText(root);
  return { text, landing: extractLanding(root, pageHost), markup: extractMarkup(root, text) };
}
