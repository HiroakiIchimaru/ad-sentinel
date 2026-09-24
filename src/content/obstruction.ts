import type { ObstructionKind } from "../shared/types";
import { extractText } from "./extract";

/** 画面の何割を覆ったら「画面を覆う広告」とみなすか */
export const OVERLAY_COVERAGE = 0.4;
/** 固定表示の広告として止める最小の面積比(小さな「PR」ボタン等は対象外) */
export const STICKY_MIN_COVERAGE = 0.03;
/** 固定表示の要素に、広告以外の文字がこれ以上あれば広告の入れ物ではない(サイトのヘッダー等) */
const MAX_EXTRA_CHARS = 150;
/**
 * 動画プレーヤーの入れ物に許す文字数。操作ボタンの文字(「volume_mute」「NEXT VIDEO」など)で
 * 200 字を超えることがある(GliaCloud のプレーヤーで 220 字)
 */
export const MAX_PLAYER_CHARS = 400;

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** 画面(ビューポート)に占める面積の比率 */
export function coverage(rect: Rect, vw: number, vh: number): number {
  if (vw <= 0 || vh <= 0) return 0;
  const x = Math.max(0, Math.min(rect.left + rect.width, vw) - Math.max(rect.left, 0));
  const y = Math.max(0, Math.min(rect.top + rect.height, vh) - Math.max(rect.top, 0));
  return (x * y) / (vw * vh);
}

/** 画面に固定された広告の入れ物を、覆い方で分類する */
export function classifyFixed(rect: Rect, vw: number, vh: number): Exclude<ObstructionKind, "autoplay"> | null {
  const c = coverage(rect, vw, vh);
  if (c >= OVERLAY_COVERAGE) return "overlay";
  if (c >= STICKY_MIN_COVERAGE && rect.height >= 30 && rect.width >= 100) return "sticky";
  return null;
}

/** 要素自身か祖先のうち、position: fixed の最も近いもの(body の手前まで) */
export function findFixedRoot(el: Element): Element | null {
  const view = el.ownerDocument.defaultView;
  if (!view) return null;
  for (let cur: Element | null = el; cur && cur !== el.ownerDocument.body && cur !== el.ownerDocument.documentElement; cur = cur.parentElement) {
    if (view.getComputedStyle(cur).position === "fixed") return cur;
  }
  return null;
}

const SITE_STRUCTURE = "main, article, nav, header, footer, [role='main'], [role='navigation'], [role='banner']";

/**
 * 固定表示の入れ物が「広告のための入れ物」か。サイト自体のヘッダーやアプリ全体を固定している場合を除く。
 * 入れ物に広告以外の文字(閉じるボタン・「広告」表記程度を超える量)や、サイトの構造要素があれば false。
 */
export function isAdDominated(root: Element, target: Element, maxExtraChars = MAX_EXTRA_CHARS): boolean {
  if (root === target) return true;
  const extra = extractText(root, 4000).length - extractText(target, 4000).length;
  if (extra > maxExtraChars) return false;
  for (const s of root.querySelectorAll(SITE_STRUCTURE)) {
    if (!target.contains(s)) return false;
  }
  return true;
}

/**
 * 広告の視聴を求める文言(「広告を見て続きを読む」「動画広告をご覧ください」など)。
 * これを含む全画面表示・ダイアログは、広告の閲覧を強制するものとして全画面広告と同じく止める。
 */
const FORCED_AD_RE = new RegExp(
  [
    "(広告|動画|CM|スポンサー動画)を(最後まで)?(見|視聴|再生|ご覧)",
    "広告(を)?(視聴|閲覧)(後|で|して|すると|いただく)",
    "広告の(視聴|再生)(後|が終わる|終了)",
    "(続き|記事|全文|コンテンツ|本文)を?(読|見|閲覧|表示)(む|る|す|し)(には|ために).{0,30}広告",
    "広告(の後|のあと|終了後|視聴後)に",
    "\\d+\\s*秒後に(閉じ|スキップ|記事|ページ|続き).{0,40}広告|広告.{0,40}\\d+\\s*秒後に(閉じ|スキップ|記事|ページ|続き)",
    "watch (a|an|the) (short )?(video )?ad",
    "view (a|an) (short )?ad",
    "(continue|keep reading|unlock).{0,30}(after|by watching|with) (a|an|the) (short )?ad",
    "rewarded (video|ad)",
  ].join("|"),
  "i",
);

/**
 * 対象外の全画面表示。有料会員・ログインの案内(ペイウォール)や、広告ブロッカーへの警告、
 * Cookie・プライバシーの同意は、サイトの利用条件に関わるので止めない。
 */
const NOT_FORCED_AD_RE =
  /(広告|アド)ブロッ(ク|カー)|ブロッカー|ad ?block|有料会員|会員登録|会員限定|ログイン|購読|サブスクリプション|subscribe|subscription|sign in|log in|cookie|クッキー|同意|consent/i;

/** 広告の閲覧を強制する表示の文言か(ペイウォール・広告ブロッカー警告・同意画面は除く) */
export function isForcedAdText(text: string): boolean {
  return FORCED_AD_RE.test(text) && !NOT_FORCED_AD_RE.test(text);
}

/**
 * スクロールが止められているか。
 * - overflow: html か body が overflow: hidden
 * - fixed: body か html が position: fixed(html を固定する広告もある)
 */
export function scrollLock(doc: Document): { overflow: boolean; fixed: boolean } {
  const view = doc.defaultView;
  if (!view) return { overflow: false, fixed: false };
  const html = view.getComputedStyle(doc.documentElement);
  const body = doc.body ? view.getComputedStyle(doc.body) : null;
  const hidden = (s: CSSStyleDeclaration | null) => s !== null && (s.overflowY === "hidden" || s.overflow === "hidden");
  return {
    overflow: hidden(html) || hidden(body),
    fixed: body?.position === "fixed" || html.position === "fixed",
  };
}
