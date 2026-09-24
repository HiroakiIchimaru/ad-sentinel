import { UI_ATTR } from "./extract";

export type MarkerTone = "block" | "warn" | "ok" | "muted";

export interface MarkerEntry {
  el: Element;
  n: number;
  tone: MarkerTone;
}

const LAYER_CSS = `
:host { all: initial !important; position: fixed !important; inset: 0 !important; pointer-events: none !important;
  z-index: 2147483647 !important; display: block !important; }
.box { position: absolute; box-sizing: border-box; border: 2px dashed var(--c); border-radius: 6px; transition: box-shadow .2s; }
.box.focus { border: 3px solid var(--c); box-shadow: 0 0 0 5px var(--glow), 0 0 24px var(--glow); }
.box.flash { animation: flash 0.6s ease-in-out 3; }
@keyframes flash { 50% { box-shadow: 0 0 0 10px var(--glow); } }
.num { position: absolute; top: 0; right: 0; background: var(--c); color: #fff; border-radius: 0 3px 0 6px;
  font: 700 12px/1 system-ui, -apple-system, "Hiragino Sans", "Yu Gothic UI", sans-serif; padding: 4px 7px; white-space: nowrap; }
.box.focus .num { font-size: 13px; padding: 5px 9px; }
.block { --c: #ea580c; --glow: rgba(234, 88, 12, .35); }
.warn { --c: #d97706; --glow: rgba(217, 119, 6, .35); }
.ok { --c: #059669; --glow: rgba(5, 150, 105, .35); }
.muted { --c: #6b7280; --glow: rgba(107, 114, 128, .35); }
`;

/**
 * popup の一覧と対応する番号を、ページ上の広告に重ねて表示する層。
 * 広告要素そのものは変更せず、画面に固定した透明な層に枠と番号を描く(スクロールに追従)。
 * 番号は右上に置く(左上は広告内の「注意」「悪質の疑い」バッジの位置なので重ねない)。
 * popup からの知らせが途切れたら(=popup を閉じたら)自動で消える。
 */
export class MarkerLayer {
  private host: HTMLElement | null = null;
  private root: ShadowRoot | null = null;
  private readonly boxes = new Map<number, HTMLElement>();
  private entries: MarkerEntry[] = [];
  private focusEl: Element | null = null;
  private flashEl: Element | null = null;
  private expires = 0;
  private raf = 0;

  constructor(private readonly doc: Document) {}

  get visible(): boolean {
    return this.host !== null;
  }

  show(entries: MarkerEntry[], focusEl: Element | null, ttlMs: number): void {
    this.entries = entries;
    this.focusEl = focusEl;
    this.expires = Date.now() + ttlMs;
    this.ensureHost();
    if (!this.raf) this.tick();
  }

  /** 指定の広告へスクロールし、枠を点滅させる */
  flash(el: Element, ttlMs: number): void {
    this.flashEl = el;
    this.expires = Math.max(this.expires, Date.now() + ttlMs);
    this.ensureHost();
    if (!this.raf) this.tick();
    setTimeout(() => {
      if (this.flashEl === el) this.flashEl = null;
    }, 2000);
  }

  hide(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.host?.remove();
    this.host = null;
    this.root = null;
    this.boxes.clear();
  }

  private ensureHost(): void {
    if (this.host?.isConnected) return;
    const host = this.doc.createElement("ad-sentinel-ui");
    host.setAttribute(UI_ATTR, "markers");
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>${LAYER_CSS}</style>`;
    this.doc.documentElement.appendChild(host);
    this.host = host;
    this.root = root;
    this.boxes.clear();
  }

  private readonly tick = (): void => {
    if (Date.now() > this.expires) {
      this.hide();
      return;
    }
    this.draw();
    const view = this.doc.defaultView;
    this.raf = view ? view.requestAnimationFrame(this.tick) : 0;
  };

  private draw(): void {
    if (!this.root) return;
    const view = this.doc.defaultView;
    const seen = new Set<number>();
    for (const e of this.entries) {
      const isRoot = e.el === this.doc.documentElement;
      const r = isRoot
        ? { top: 0, left: 0, width: view?.innerWidth ?? 0, height: view?.innerHeight ?? 0 }
        : e.el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      seen.add(e.n);
      let box = this.boxes.get(e.n);
      if (!box) {
        box = this.doc.createElement("div");
        box.innerHTML = `<span class="num"></span>`;
        this.root.appendChild(box);
        this.boxes.set(e.n, box);
      }
      const focus = e.el === this.focusEl || e.el === this.flashEl;
      const cls = `box ${e.tone}${focus ? " focus" : ""}${e.el === this.flashEl ? " flash" : ""}`;
      if (box.className !== cls) box.className = cls;
      const label = focus ? `#${e.n} この広告` : `#${e.n}`;
      const num = box.firstElementChild as HTMLElement;
      if (num.textContent !== label) num.textContent = label;
      // 枠線が広告の外側に来るよう少し広げる
      box.style.top = `${r.top - 3}px`;
      box.style.left = `${r.left - 3}px`;
      box.style.width = `${r.width + 6}px`;
      box.style.height = `${r.height + 6}px`;
    }
    for (const [n, box] of this.boxes) {
      if (!seen.has(n)) {
        box.remove();
        this.boxes.delete(n);
      }
    }
  }
}

const TOAST_CSS = `
:host { all: initial !important; position: fixed !important; left: 16px !important; bottom: 16px !important;
  z-index: 2147483647 !important; display: block !important; max-width: calc(100vw - 32px) !important; }
.wrap { display: flex; align-items: center; gap: 10px; padding: 10px 12px 10px 14px; border-radius: 10px;
  background: #1f2250; color: #f8fafc; box-shadow: 0 8px 24px rgba(0, 0, 0, .3);
  font: 13px/1.4 system-ui, -apple-system, "Hiragino Sans", "Yu Gothic UI", "Meiryo", sans-serif; animation: in .2s ease-out; }
@keyframes in { from { transform: translateY(12px); opacity: 0; } }
.icon { color: #fb923c; display: flex; }
button { font: inherit; font-size: 12px; font-weight: 700; color: #1f2250; background: #fed7aa; border: 0; border-radius: 999px;
  padding: 4px 12px; cursor: pointer; white-space: nowrap; }
`;

let toastHost: HTMLElement | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

/** 画面下に短い知らせを出す(妨害広告を止めたとき)。「元に戻す」は実際のクリックでだけ動く */
export function showToast(doc: Document, text: string, action: { label: string; fn: () => void } | null, ms = 6000): void {
  toastHost?.remove();
  if (toastTimer) clearTimeout(toastTimer);
  const host = doc.createElement("ad-sentinel-ui");
  host.setAttribute(UI_ATTR, "toast");
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>${TOAST_CSS}</style>
    <div class="wrap" role="status">
      <span class="icon"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Zm-1.2 13.6-3.5-3.5 1.4-1.4 2.1 2.1 4.9-4.9 1.4 1.4-6.3 6.3Z"/></svg></span>
      <span class="text"></span>
      ${action ? '<button type="button"></button>' : ""}
    </div>`;
  (root.querySelector(".text") as HTMLElement).textContent = text;
  const btn = root.querySelector("button");
  if (btn && action) {
    btn.textContent = action.label;
    btn.addEventListener("click", (e) => {
      if (!e.isTrusted) return;
      action.fn();
      host.remove();
    });
  }
  for (const type of ["click", "mousedown", "pointerdown", "touchstart"]) host.addEventListener(type, (e) => e.stopPropagation());
  doc.documentElement.appendChild(host);
  toastHost = host;
  toastTimer = setTimeout(() => host.remove(), ms);
}
