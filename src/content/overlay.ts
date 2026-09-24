import { PRODUCT_NAME } from "../shared/branding";
import { CATEGORY_LABELS } from "../shared/questions";
import { percent } from "../shared/decide";
import type { DisplayMode, ItemState, RiskCategory } from "../shared/types";
import { UI_ATTR } from "./extract";

export const STATE_ATTR = "data-ks-state";
export const DISPLAY_ATTR = "data-ks-display";
const POS_ATTR = "data-ks-pos";

export interface RenderInfo {
  state: ItemState;
  top: { category: RiskCategory; p: number } | null;
  mock: boolean;
  display: DisplayMode;
  showWarnBadge: boolean;
  warnDismissed: boolean;
  pendingBlur: boolean;
}

export interface RenderActions {
  reveal(): void;
  hide(): void;
  dismissWarn(): void;
}

type UiKind = "cover" | "badge" | "placeholder";

interface UiHandle {
  host: HTMLElement;
  root: ShadowRoot;
  kind: UiKind;
  key: string;
}

const handles = new WeakMap<Element, UiHandle>();

const SHIELD_SVG =
  '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Zm0 2.2 6 2.2V11c0 3.9-2.5 7.4-6 8.8-3.5-1.4-6-4.9-6-8.8V6.4l6-2.2Zm-1 3.8v6h2V8h-2Zm0 8v2h2v-2h-2Z"/></svg>';

const BASE_CSS = `
:host { all: initial !important; }
* { box-sizing: border-box; }
.wrap { font-family: system-ui, -apple-system, "Hiragino Sans", "Yu Gothic UI", "Meiryo", sans-serif; }
button { font: inherit; cursor: pointer; }
`;

const COVER_CSS = `
:host { position: absolute !important; inset: 0 !important; z-index: 2147483646 !important; display: block !important; container-type: size !important; }
:host(.ks-frame) { position: fixed !important; }
.wrap { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; overflow: hidden;
  color: #f8fafc; background: rgba(17, 24, 39, .74); backdrop-filter: blur(18px) saturate(.35); -webkit-backdrop-filter: blur(18px) saturate(.35);
  border-radius: 6px; outline: 1px solid rgba(251, 146, 60, .55); outline-offset: -1px; }
.panel { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 10px 12px; text-align: center; max-width: 100%; }
.icon { color: #fb923c; display: flex; }
.title { font-size: 13px; font-weight: 700; line-height: 1.35; }
.chip { font-size: 11px; line-height: 1.2; color: #fed7aa; background: rgba(234, 88, 12, .22); border: 1px solid rgba(251, 146, 60, .6); border-radius: 999px; padding: 3px 9px; white-space: nowrap; }
.meta { font-size: 10px; opacity: .7; }
.btn { font-size: 11px; color: #fff; background: rgba(255, 255, 255, .12); border: 1px solid rgba(255, 255, 255, .35); border-radius: 999px; padding: 4px 12px; }
.btn:hover { background: rgba(255, 255, 255, .22); }
@container (max-height: 120px) {
  .panel { flex-direction: row; flex-wrap: wrap; justify-content: center; gap: 6px 8px; padding: 4px 8px; }
  .meta { display: none; }
}
@container (max-height: 64px) {
  .title, .icon { display: none; }
}
@container (max-width: 200px) {
  .title { font-size: 11px; }
  .meta { display: none; }
}
`;

const BADGE_CSS = `
:host { position: absolute !important; top: 4px !important; left: 4px !important; z-index: 2147483646 !important; display: block !important; max-width: calc(100% - 8px) !important; }
:host(.ks-frame) { position: fixed !important; }
.wrap { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; font-size: 11px; font-weight: 600; line-height: 1.2;
  padding: 3px 4px 3px 8px; border-radius: 999px; box-shadow: 0 1px 4px rgba(0, 0, 0, .25); white-space: nowrap; }
.wrap.warn { color: #92400e; background: #fffbeb; border: 1px solid #fbbf24; }
.wrap.block { color: #9a3412; background: #fff7ed; border: 1px solid #fb923c; }
.text { overflow: hidden; text-overflow: ellipsis; }
.btn { font-size: 11px; font-weight: 600; color: inherit; background: rgba(0, 0, 0, .06); border: 0; border-radius: 999px; padding: 2px 8px; }
.btn:hover { background: rgba(0, 0, 0, .12); }
`;

const PLACEHOLDER_CSS = `
:host { display: block !important; position: static !important; margin: 4px 0 !important; }
.wrap { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; line-height: 1.4; color: #9a3412;
  background: #fff7ed; border: 1px dashed #fb923c; border-radius: 6px; padding: 6px 10px; }
.icon { display: flex; color: #ea580c; }
.text { flex: 1 1 auto; min-width: 0; }
.btn { font-size: 11px; color: #9a3412; background: #ffedd5; border: 1px solid #fdba74; border-radius: 999px; padding: 2px 10px; }
`;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function reason(top: RenderInfo["top"]): string {
  return top ? `${CATEGORY_LABELS[top.category]} ${percent(top.p)}` : "";
}

/** 本拡張の UI 上の操作をページ側へ伝えない(広告のクリック計測やリンク遷移を起こさない) */
function isolateEvents(host: HTMLElement): void {
  for (const type of ["click", "auxclick", "mousedown", "mouseup", "pointerdown", "pointerup", "touchstart", "touchend", "contextmenu"]) {
    host.addEventListener(type, (e) => {
      e.stopPropagation();
      if (type === "click" || type === "auxclick") e.preventDefault();
    });
  }
}

function isFrameRoot(el: Element): boolean {
  return el === el.ownerDocument.documentElement;
}

function ensurePositioned(el: Element): void {
  if (isFrameRoot(el) || !(el instanceof HTMLElement)) return;
  const view = el.ownerDocument.defaultView;
  if (view && view.getComputedStyle(el).position === "static") {
    el.style.setProperty("position", "relative");
    el.setAttribute(POS_ATTR, "1");
  }
}

function restorePosition(el: Element): void {
  if (el.getAttribute(POS_ATTR) === "1" && el instanceof HTMLElement) {
    el.style.removeProperty("position");
    el.removeAttribute(POS_ATTR);
  }
}

function removeUi(el: Element): void {
  const h = handles.get(el);
  if (!h) return;
  h.host.remove();
  handles.delete(el);
  restorePosition(el);
}

function mountUi(el: Element, kind: UiKind, key: string, css: string, html: string): ShadowRoot {
  const existing = handles.get(el);
  if (existing && existing.kind === kind && existing.key === key && existing.host.isConnected) return existing.root;
  removeUi(el);

  const doc = el.ownerDocument;
  const host = doc.createElement("ad-sentinel-ui");
  host.setAttribute(UI_ATTR, kind);
  const frame = isFrameRoot(el);
  if (frame) host.classList.add("ks-frame");
  // closed: ページのスクリプトから UI を読んだり操作したりできないようにする
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>${BASE_CSS}${css}</style>${html}`;
  isolateEvents(host);

  if (kind === "placeholder") {
    el.before(host);
  } else {
    ensurePositioned(el);
    (frame ? (doc.body ?? doc.documentElement) : el).appendChild(host);
  }
  handles.set(el, { host, root, kind, key });
  return root;
}

/** ボタン操作を登録する。ページが合成したクリック(isTrusted=false)では動かない */
function onButton(root: ShadowRoot, selector: string, fn: () => void): void {
  root.querySelector(selector)?.addEventListener("click", (e) => {
    if (e.isTrusted) fn();
  });
}

function renderCover(el: Element, info: RenderInfo, actions: RenderActions): void {
  const key = `cover|${reason(info.top)}|${info.mock}`;
  const root = mountUi(
    el,
    "cover",
    key,
    COVER_CSS,
    `<div class="wrap" role="note" aria-label="${PRODUCT_NAME}">
      <div class="panel">
        <div class="icon">${SHIELD_SVG}</div>
        <div class="title">悪質な可能性が高い広告を隠しました</div>
        <div class="chip">${escapeHtml(reason(info.top))}</div>
        <div class="meta">${info.mock ? "簡易判定(キーワード照合)" : "jev による判定"}</div>
        <button class="btn" type="button" data-act="reveal">表示する</button>
      </div>
    </div>`,
  );
  onButton(root, '[data-act="reveal"]', actions.reveal);
}

function renderBadge(el: Element, info: RenderInfo, tone: "warn" | "block", text: string, button: { label: string; fn: () => void } | null): void {
  const key = `badge|${tone}|${text}|${button?.label ?? ""}`;
  const root = mountUi(
    el,
    "badge",
    key,
    BADGE_CSS,
    `<div class="wrap ${tone}" role="note">
      <span class="text">${escapeHtml(text)}</span>
      ${button ? `<button class="btn" type="button" data-act="badge">${escapeHtml(button.label)}</button>` : ""}
    </div>`,
  );
  if (button) onButton(root, '[data-act="badge"]', button.fn);
}

function renderPlaceholder(el: Element, info: RenderInfo, actions: RenderActions): void {
  const key = `placeholder|${reason(info.top)}|${info.mock}`;
  const root = mountUi(
    el,
    "placeholder",
    key,
    PLACEHOLDER_CSS,
    `<div class="wrap" role="note">
      <span class="icon">${SHIELD_SVG}</span>
      <span class="text">悪質な可能性が高い広告を非表示にしました(${escapeHtml(reason(info.top))}${info.mock ? "・簡易判定" : ""})</span>
      <button class="btn" type="button" data-act="reveal">表示する</button>
    </div>`,
  );
  onButton(root, '[data-act="reveal"]', actions.reveal);
}

/** 判定状態を DOM に反映する。同じ状態なら何もしない(MutationObserver のループを避ける) */
export function render(el: Element, info: RenderInfo, actions: RenderActions): void {
  // 判定中のぼかしを切っている場合は、CSS の当たらない別名にする
  const stateAttr = info.state === "pending" && !info.pendingBlur ? "waiting" : info.state;
  if (el.getAttribute(STATE_ATTR) !== stateAttr) el.setAttribute(STATE_ATTR, stateAttr);

  const hideMode = info.state === "block" && info.display === "hide" && !isFrameRoot(el);
  if (hideMode) el.setAttribute(DISPLAY_ATTR, "hide");
  else el.removeAttribute(DISPLAY_ATTR);

  switch (info.state) {
    case "block":
      if (info.display === "label") {
        renderBadge(el, info, "block", `悪質の疑い · ${reason(info.top)}`, null);
      } else if (hideMode) {
        renderPlaceholder(el, info, actions);
      } else {
        renderCover(el, info, actions);
      }
      return;
    case "revealed":
      renderBadge(el, info, "block", `悪質の疑い · ${reason(info.top)}`, { label: "隠す", fn: actions.hide });
      return;
    case "warn":
      if (info.showWarnBadge && !info.warnDismissed) {
        renderBadge(el, info, "warn", `注意 · ${reason(info.top)}`, { label: "×", fn: actions.dismissWarn });
      } else {
        removeUi(el);
      }
      return;
    default:
      removeUi(el);
  }
}

/** テスト用: 要素に付けた UI の種類と(closed の)Shadow Root を返す */
export function uiOf(el: Element): { kind: UiKind; root: ShadowRoot; host: HTMLElement } | null {
  const h = handles.get(el);
  return h ? { kind: h.kind, root: h.root, host: h.host } : null;
}

/** 本拡張が加えた属性・UI をすべて外す */
export function clear(el: Element): void {
  removeUi(el);
  el.removeAttribute(STATE_ATTR);
  el.removeAttribute(DISPLAY_ATTR);
}
