import { decide } from "../shared/decide";
import { fnv1a } from "../shared/hash";
import { OBSTRUCTION_LABELS } from "../shared/questions";
import type {
  Answers,
  CandidateSource,
  CandidateWhere,
  ClassifyResponse,
  ItemReport,
  ItemState,
  MarkupSignal,
  ObstructionKind,
  RuntimeMessage,
  Settings,
  TabMessage,
} from "../shared/types";
import {
  FLOATING_AD_SELECTOR,
  findCandidates,
  hasAdLikeName,
  iframeHost,
  isAdFrame,
  isAdIframe,
  isCandidateSize,
  SLOT_SELECTOR,
  VIDEO_AD_PLAYER_SELECTOR,
  videoAdHost,
} from "./detect";
import { extract, extractLanding, extractText, MIN_TEXT_CHARS, UI_ATTR } from "./extract";
import { MarkerLayer, showToast, type MarkerEntry, type MarkerTone } from "./markers";
import {
  classifyFixed,
  coverage,
  findFixedRoot,
  isAdDominated,
  isForcedAdText,
  MAX_PLAYER_CHARS,
  OVERLAY_COVERAGE,
  scrollLock,
} from "./obstruction";
import { clear, DISPLAY_ATTR, render, STATE_ATTR, uiOf } from "./overlay";

/** 1 フレームで判定する広告の上限(無限スクロール等での使いすぎ防止) */
export const MAX_JUDGE_PER_FRAME = 120;
/** 同じ要素の中身が変わったときに再判定する上限と最短間隔 */
const MAX_REJUDGE = 4;
const REJUDGE_INTERVAL_MS = 2000;
const MIN_SCAN_DELAY_MS = 400;
const MAX_SCAN_DELAY_MS = 4000;
/** 固定表示の広告は、クラスの付け替え等で後から現れるので定期的にも確認する */
const OBSTRUCTION_INTERVAL_MS = 2000;
/** popup からの番号表示の知らせが途切れてから消すまで */
const MARKER_TTL_MS = 2500;
/**
 * 広告の視聴を求めるダイアログとみなす最小の大きさ(画面に占める割合)。
 * 文言の条件が厳しいので小さめでよい(中央の 460×180 程度のダイアログで画面の 7% ほど)
 */
const FORCED_MIN_COVERAGE = 0.02;

/** html に付けると、既知の広告枠を判定前からぼかす(CSS はビルド時に生成) */
export const PREBLUR_ATTR = "data-ks-preblur";
/** 画面妨害として止めた入れ物に付ける(CSS で非表示) */
export const OBSTRUCT_ATTR = "data-ks-obstruct";
/** 妨害広告がスクロールを止めていたときに html へ付け、スクロールを戻す */
export const UNLOCK_ATTR = "data-ks-unlock";

export interface SentinelEnv {
  doc: Document;
  isTop: boolean;
  send: (msg: RuntimeMessage) => Promise<unknown>;
  settings: Settings;
  /** 判定失敗の再試行を待つ基準の時間(テストで短くする) */
  retryBaseMs?: number;
}

/**
 * 判定に失敗したときの再試行。キャッシュが空の状態で多くの広告を一度に判定すると、
 * 一部がタイムアウトや混雑で失敗することがある。一時的な失敗だけ、少し待ってやり直す
 */
const MAX_RETRIES = 2;
const RETRYABLE = new Set(["timeout", "network", "server", "overloaded", "rate_limit", "cooldown", "invalid_response"]);
/** 混雑・回数制限のときは background のクールダウン(30 秒)が明けるのを待つ */
const RETRY_AFTER_COOLDOWN_MS = 31_000;

interface Tracked {
  id: string;
  el: Element;
  source: CandidateSource;
  where: CandidateWhere;
  state: ItemState | "new";
  hash: string;
  excerpt: string;
  domain: string | null;
  markup: MarkupSignal[];
  answers: Answers | null;
  mock: boolean;
  judgedAt: number;
  judgeCount: number;
  seq: number;
  revealed: boolean;
  warnDismissed: boolean;
  retries: number;
}

type DisplayBackup = { value: string; priority: string } | null;

/** 画面妨害として止めたもの。overlay/sticky/video は入れ物ごと非表示、autoplay は消音・停止 */
interface Obstruction {
  id: string;
  kind: ObstructionKind;
  /** overlay/sticky は固定表示の入れ物、video は動画広告の入れ物、autoplay は動画・音声要素 */
  root: Element;
  revealed: boolean;
  excerpt: string;
  domain: string | null;
  /** 隠す前の要素の style 属性の display(戻すときに使う) */
  prevDisplay: DisplayBackup;
  /** 一緒に隠す要素(広告の視聴を求めるダイアログとは別要素の、暗い背景など)。一覧には出さない */
  extras: { el: Element; prevDisplay: DisplayBackup }[];
}

function backupDisplay(el: Element): DisplayBackup {
  return el instanceof HTMLElement
    ? { value: el.style.getPropertyValue("display"), priority: el.style.getPropertyPriority("display") }
    : null;
}

function restoreDisplay(el: Element, prev: DisplayBackup): void {
  if (!(el instanceof HTMLElement)) return;
  if (prev?.value) el.style.setProperty("display", prev.value, prev.priority);
  else el.style.removeProperty("display");
}

let frameToken = Math.random().toString(36).slice(2, 8);

export class Sentinel {
  private readonly tracked = new Map<Element, Tracked>();
  private readonly obstructions = new Map<Element, Obstruction>();
  /** 利用者が自分で再生・消音解除した(直前の操作つきの)動画・音声。消音の対象にしない */
  private readonly userPlayed = new WeakSet<HTMLMediaElement>();
  /** extras(一緒に隠した背景など)から、持ち主の Obstruction を引く */
  private readonly extraOwners = new Map<Element, Obstruction>();
  /** 止めている全画面広告の id。要素がページから消えても、利用者が「表示」で戻すまで残す */
  private readonly overlayHolds = new Set<string>();
  private settings: Settings;
  private running = false;
  private counter = 0;
  private judged = 0;
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private scanDelay = MIN_SCAN_DELAY_MS;
  private reportTimer: ReturnType<typeof setTimeout> | null = null;
  private obstructionTimer: ReturnType<typeof setInterval> | null = null;
  private scrollTimer: ReturnType<typeof setTimeout> | null = null;
  private lastReport = "";
  private mo: MutationObserver | null = null;
  /** 隠した広告の style 属性を見張る(広告側が display:block !important で出し直してくるため) */
  private styleMo: MutationObserver | null = null;
  private io: IntersectionObserver | null = null;
  private readonly markers: MarkerLayer;
  private readonly frameMode: boolean;
  private readonly pageHost: string;
  private readonly domReady: Promise<void>;

  constructor(private readonly env: SentinelEnv) {
    this.settings = env.settings;
    const loc = env.doc.location;
    this.pageHost = loc?.hostname ?? "";
    const win = env.doc.defaultView;
    this.frameMode = isAdFrame(env.isTop, this.pageHost, win?.name ?? "");
    this.markers = new MarkerLayer(env.doc);
    // 読み込み途中の要素は文面が欠けているので、判定は DOM の組み立てが終わってから
    this.domReady =
      env.doc.readyState === "loading"
        ? new Promise((r) => env.doc.addEventListener("DOMContentLoaded", () => r(), { once: true }))
        : Promise.resolve();
  }

  get isRunning(): boolean {
    return this.running;
  }

  get isAdFrame(): boolean {
    return this.frameMode;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const doc = this.env.doc;
    const view = doc.defaultView;
    this.applyPreblur();
    if (view && "IntersectionObserver" in view) {
      this.io = new view.IntersectionObserver((entries) => this.onIntersect(entries), { rootMargin: "300px 0px" });
    }
    this.mo = new MutationObserver((records) => {
      if (records.every((r) => isOwnMutation(r))) return;
      this.scheduleScan();
    });
    this.mo.observe(doc.documentElement, { childList: true, subtree: true, characterData: true });
    this.styleMo = new MutationObserver((records) => {
      for (const r of records) {
        const target = r.target as Element;
        const o = this.obstructions.get(target) ?? this.extraOwners.get(target);
        if (o && o.kind !== "autoplay" && !o.revealed) enforceHidden(target);
      }
    });
    doc.addEventListener("play", this.onMedia, true);
    doc.addEventListener("volumechange", this.onMedia, true);
    view?.addEventListener("scroll", this.onScroll, { passive: true });
    view?.addEventListener("resize", this.onScroll, { passive: true });
    this.obstructionTimer = setInterval(() => {
      if (doc.visibilityState !== "hidden") this.checkObstructions();
    }, OBSTRUCTION_INTERVAL_MS);
    this.scan();
    // トップフレームは候補がなくても報告し、background にホスト名を知らせる
    if (this.env.isTop) this.report(true);
  }

  /** 無効化時: 監視を止め、加えた UI・属性をすべて外す */
  stop(): void {
    if (!this.running) return;
    this.teardown();
    const doc = this.env.doc;
    for (const t of this.tracked.values()) clear(t.el);
    this.tracked.clear();
    for (const o of this.obstructions.values()) this.showRoot(o);
    this.obstructions.clear();
    this.extraOwners.clear();
    this.overlayHolds.clear();
    for (const el of doc.querySelectorAll(`[${STATE_ATTR}="skip"]`)) el.removeAttribute(STATE_ATTR);
    doc.documentElement.removeAttribute(PREBLUR_ATTR);
    doc.documentElement.removeAttribute(UNLOCK_ATTR);
    this.markers.hide();
    this.report(true);
  }

  /**
   * 拡張機能との接続を失ったとき(再読み込み・更新・削除): 監視とタイマーだけを止める。
   * 背景とはもう通信できないので報告はしない。ページの表示は再読み込みまでそのまま残す。
   */
  halt(): void {
    if (!this.running) return;
    this.teardown();
    if (this.reportTimer) clearTimeout(this.reportTimer);
    this.reportTimer = null;
    this.markers.hide();
  }

  private teardown(): void {
    this.running = false;
    const doc = this.env.doc;
    this.mo?.disconnect();
    this.styleMo?.disconnect();
    this.io?.disconnect();
    this.mo = null;
    this.styleMo = null;
    this.io = null;
    doc.removeEventListener("play", this.onMedia, true);
    doc.removeEventListener("volumechange", this.onMedia, true);
    doc.defaultView?.removeEventListener("scroll", this.onScroll);
    doc.defaultView?.removeEventListener("resize", this.onScroll);
    for (const t of [this.scanTimer, this.scrollTimer]) if (t) clearTimeout(t);
    if (this.obstructionTimer) clearInterval(this.obstructionTimer);
    this.scanTimer = this.scrollTimer = this.obstructionTimer = null;
  }

  updateSettings(settings: Settings): void {
    const prev = this.settings;
    this.settings = settings;
    if (this.running) this.applyPreblur();
    for (const t of this.tracked.values()) {
      if (t.answers) this.applyAnswers(t);
      else this.paint(t);
    }
    // 種類ごとの自動ブロックを切ったら、止めていたものを戻す
    for (const [key, o] of this.obstructions) {
      if (!settings.obstruction[o.kind] && prev.obstruction[o.kind]) {
        this.showRoot(o);
        this.obstructions.delete(key);
        this.overlayHolds.delete(o.id);
      }
    }
    this.updateUnlock();
    if (this.running) this.checkObstructions();
    this.scheduleReport();
  }

  /** popup からの操作(番号表示・その広告へ移動・表示/非表示) */
  handleTabMessage(msg: TabMessage): void {
    switch (msg.type) {
      case "requestReport":
        this.report(true);
        return;
      case "markers": {
        const entries: MarkerEntry[] = [];
        let focusEl: Element | null = null;
        for (const { id, n } of msg.items) {
          const found = this.findById(id);
          if (!found) continue;
          const el = this.locateTarget(found);
          if (!el) continue;
          entries.push({ el, n, tone: this.toneOf(found) });
          if (id === msg.focus) focusEl = el;
        }
        if (entries.length > 0) this.markers.show(entries, focusEl, MARKER_TTL_MS);
        else if (this.markers.visible) this.markers.hide();
        return;
      }
      case "locate": {
        const found = this.findById(msg.id);
        const el = found ? this.locateTarget(found) : null;
        if (!el) return;
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        this.markers.flash(el, MARKER_TTL_MS + 1000);
        return;
      }
      case "reveal": {
        const found = this.findById(msg.id);
        if (!found) return;
        if (found.kind === "obstruction") this.setObstructionRevealed(found.o, msg.reveal);
        else {
          found.t.revealed = msg.reveal;
          this.applyAnswers(found.t);
          this.scheduleReport();
        }
        return;
      }
    }
  }

  /** 候補の検出と、既存候補の変化・消失の確認 */
  scan(): void {
    if (!this.running) return;
    const t0 = performance.now();
    const doc = this.env.doc;

    for (const [el, t] of this.tracked) {
      if (!el.isConnected) {
        clear(el);
        this.io?.unobserve(el);
        this.tracked.delete(el);
        continue;
      }
      if (t.state === "new" || t.state === "pending") continue;
      if (!isCandidateSize(el, t.source)) {
        // 中身が増えて広告 1 件分を超えた(サイドバー全体など)。候補から外す
        this.drop(t);
        continue;
      }
      const text = extractText(el);
      if (fnv1a(text) !== t.hash && t.judgeCount < MAX_REJUDGE && Date.now() - t.judgedAt > REJUDGE_INTERVAL_MS) {
        // 広告の差し替え(ローテーション)。新しい中身で判定し直す
        t.revealed = false;
        t.warnDismissed = false;
        void this.judge(t);
      }
    }

    if (this.frameMode) {
      const root = doc.documentElement;
      if (doc.body && !this.tracked.has(root)) this.track(root, "frame", "frame");
    } else {
      // HTML の組み立て途中は要素の大きさが確定しないので、「PR」表記からの推定は完了後に行う
      for (const c of findCandidates(doc, { labels: doc.readyState !== "loading" })) {
        if (this.tracked.has(c.el)) continue;
        // 先に「PR」表記から拾った小さな候補の外側に、既知の広告枠・カードが後から現れたら入れ替える
        if (c.source !== "label") {
          for (const t of [...this.tracked.values()]) if (t.source === "label" && c.el.contains(t.el)) this.drop(t);
        }
        if (this.overlapsTracked(c.el)) continue;
        this.track(c.el, c.source, c.where);
      }
    }

    // 判定しない広告枠(入れ物・空枠・iframe だけの枠)は、判定前ぼかしを外す
    for (const el of doc.querySelectorAll(SLOT_SELECTOR)) {
      if (!el.hasAttribute(STATE_ATTR) && !this.tracked.has(el)) el.setAttribute(STATE_ATTR, "skip");
    }

    this.checkObstructions();

    const cost = performance.now() - t0;
    this.scanDelay = Math.min(MAX_SCAN_DELAY_MS, Math.max(MIN_SCAN_DELAY_MS, cost * 25));
    this.scheduleReport();
  }

  /** popup を開いたとき・SPA 遷移後に background から求められたら、すぐ状態を送る */
  report(force = false): void {
    const items = this.snapshot();
    const key = JSON.stringify(items);
    if (!force && key === this.lastReport) return;
    // 子フレームは何も持っていなければ、以前に送った分を消すときだけ送る
    if (!this.env.isTop && items.length === 0 && this.lastReport === "" && !force) return;
    this.lastReport = key;
    try {
      void this.env.send({ type: "frameReport", isTop: this.env.isTop, items }).catch(() => {});
    } catch {
      // 拡張機能との接続が切れている(index.ts の send が halt を呼ぶ)
    }
  }

  // ---- 画面妨害 ----

  /** 画面に固定された広告の入れ物を探し、覆い方に応じて止める */
  checkObstructions(): void {
    if (!this.running) return;
    const doc = this.env.doc;
    const view = doc.defaultView;
    if (!view) return;

    for (const [key, o] of this.obstructions) {
      if (!o.root.isConnected) this.obstructions.delete(key);
    }

    const s = this.settings.obstruction;
    if ((s.overlay || s.sticky) && !this.frameMode) {
      const targets = new Set<Element>();
      for (const t of this.tracked.values()) {
        // 「PR」表記からの推定は、jev が広告と判断したものだけ(サイトの固定ヘッダーを誤って消さない)
        if (t.source === "selector" || (t.source === "label" && (t.answers?.is_ad ?? 0) >= 0.6)) targets.add(t.el);
      }
      for (const el of doc.querySelectorAll(SLOT_SELECTOR)) targets.add(el);
      // 既知の配信ドメインでない iframe も、入れ物までに広告らしい名前があれば対象にする(下で確かめる)
      const unknownFrames = new Set<Element>();
      for (const f of doc.querySelectorAll("iframe")) {
        targets.add(f);
        if (!isAdIframe(f)) unknownFrames.add(f);
      }

      for (const target of targets) {
        if (this.insideHiddenObstruction(target)) continue;
        const root = findFixedRoot(target);
        if (!root || this.obstructions.has(root) || !isAdDominated(root, target)) continue;
        if (unknownFrames.has(target) && !hasAdLikeName(target, root)) continue;
        const kind = classifyFixed(root.getBoundingClientRect(), view.innerWidth, view.innerHeight);
        if (!kind || !s[kind]) continue;
        this.blockFixed(root, kind, target);
      }

      // 広告配信側が画面に浮かせる既知の要素(Google のアンカー・サイドレール・検索チップ)は、
      // 大きさに関係なく止める。表示前(大きさ 0)の段階でも止めておく
      for (const el of doc.querySelectorAll(FLOATING_AD_SELECTOR)) {
        if (this.obstructions.has(el) || this.insideHiddenObstruction(el)) continue;
        if (view.getComputedStyle(el).position !== "fixed") continue;
        const kind = classifyFixed(el.getBoundingClientRect(), view.innerWidth, view.innerHeight) ?? "sticky";
        if (s[kind]) this.blockFixed(el, kind, el);
      }
    }

    if (s.overlay && !this.frameMode) this.checkForcedAdOverlays(view);
    if (s.video) this.checkVideoAds();
    if (s.autoplay) {
      for (const m of doc.querySelectorAll("video, audio")) this.checkMedia(m as HTMLMediaElement);
    }
    this.updateUnlock();
  }

  /**
   * 広告の視聴を求める全画面表示・ダイアログ(「広告を見て続きを読む」など)を、全画面広告として止める。
   * 広告枠の目印がなくても文言で見分ける。ダイアログと別要素の暗い背景も一緒に隠す。
   */
  private checkForcedAdOverlays(view: Window): void {
    const doc = this.env.doc;
    const vw = view.innerWidth;
    const vh = view.innerHeight;
    // 全画面表示はふつう body・html の直下(かその 1 段下)か、ダイアログとして置かれる
    const candidates = new Set<Element>(
      doc.querySelectorAll('body > *, html > *, body > * > *, [role="dialog"], [aria-modal="true"], dialog[open]'),
    );
    for (const el of candidates) {
      if (el.hasAttribute(UI_ATTR) || this.obstructions.has(el) || this.insideHiddenObstruction(el)) continue;
      const cs = view.getComputedStyle(el);
      if (cs.position !== "fixed" || cs.display === "none" || cs.visibility === "hidden") continue;
      if (coverage(el.getBoundingClientRect(), vw, vh) < FORCED_MIN_COVERAGE) continue;
      const text = extractText(el, 400);
      if (!isForcedAdText(text)) continue;
      // いちばん外側の固定表示の要素ごと隠す
      let root: Element = el;
      while (root.parentElement && root.parentElement !== doc.body && root.parentElement !== doc.documentElement) {
        if (view.getComputedStyle(root.parentElement).position !== "fixed") break;
        root = root.parentElement;
      }
      if (this.obstructions.has(root)) continue;
      // 同じ階層にある、文字のない画面全体の固定表示(暗い背景)も一緒に隠す
      const extras = [...(root.parentElement?.children ?? [])].filter((sib) => {
        if (sib === root || sib.hasAttribute(UI_ATTR) || this.obstructions.has(sib)) return false;
        const scs = view.getComputedStyle(sib);
        if (scs.position !== "fixed" || scs.display === "none") return false;
        return coverage(sib.getBoundingClientRect(), vw, vh) >= OVERLAY_COVERAGE && extractText(sib, 40).length <= 20;
      });
      this.blockFixed(root, "overlay", root, extras, "広告の視聴を求める全画面表示");
    }
  }

  /** 動画広告を入れ物ごと隠す(広告枠・広告フレーム内の動画、動画広告の配信元、動画広告プレーヤー) */
  private checkVideoAds(): void {
    const doc = this.env.doc;
    if (this.frameMode) {
      // 広告フレームの中の動画は動画広告。フレームの中身ごと隠す(iframe の枠自体は親ページのもの)
      const media = doc.querySelector("video") ?? [...doc.querySelectorAll("iframe")].find((f) => videoAdHost(f));
      const body = doc.body;
      if (media && body && !this.obstructions.has(body)) this.blockVideo(body, media);
      return;
    }
    for (const media of doc.querySelectorAll("video, iframe")) {
      if (media.tagName === "IFRAME" && !videoAdHost(media)) continue;
      if (this.insideHiddenObstruction(media)) continue;
      const container = this.videoAdContainer(media);
      if (!container || this.obstructions.has(container)) continue;
      this.blockVideo(container, media);
    }
  }

  /**
   * 動画が広告なら、隠す入れ物を返す(広告でなければ null)。
   * 広告のしるし: 広告枠・判定中の広告の中 / 広告らしい名前の祖先 / 動画広告プレーヤー / 動画広告の配信元。
   * 入れ物は、広告以外の文字やサイトの構造を含まない範囲で、しるしのある最も外側の祖先。
   */
  private videoAdContainer(media: Element): Element | null {
    const doc = this.env.doc;
    const isPage = (el: Element | null) => el === doc.body || el === doc.documentElement;
    let adSignal = videoAdHost(media) !== null;
    let best: Element | null = null;
    const player = playerRootOf(media, isPage);
    // 動画広告プレーヤーは入れ子が深い(GliaCloud は動画から 9 段上が広告の入れ物)
    for (let el = media.parentElement, depth = 0; el && !isPage(el) && depth < 12; el = el.parentElement, depth++) {
      // プレーヤーの操作ボタンの文字(画面読み上げ用の隠し文字を含む)は、広告以外の文字として数えない。
      // プレーヤーの外枠の内側は確かめず、外側ではプレーヤーを除いた文字の量で判断する
      const insidePlayer = player !== media && player.contains(el);
      if (!insidePlayer && !isAdDominated(el, el.contains(player) ? player : media, MAX_PLAYER_CHARS)) break;
      if (el.matches(SLOT_SELECTOR) || el.matches(VIDEO_AD_PLAYER_SELECTOR) || this.tracked.has(el) || hasAdLikeName(el, el)) {
        best = el;
        adSignal = true;
      }
    }
    if (!adSignal) return null;
    if (best) return best;
    // 目印のある入れ物がなければ、すぐ外側のプレーヤーの枠。ページそのもの(body・html)は選ばない
    const parent = media.parentElement;
    return parent && !isPage(parent) ? parent : media;
  }

  private blockVideo(container: Element, media: Element): void {
    for (const v of container.querySelectorAll("video")) {
      v.muted = true;
      v.pause();
    }
    this.blockFixed(container, "video", media);
  }

  private blockFixed(root: Element, kind: ObstructionKind, target: Element, extraEls: Element[] = [], note = ""): void {
    const doc = this.env.doc;
    // 安全装置: ページそのもの(html、トップの body)や、画面より大きな要素は決して隠さない。
    // 広告フレームの中の body だけは、動画広告のときにフレームの中身として隠してよい
    if (root === doc.documentElement || (root === doc.body && !(this.frameMode && kind === "video"))) return;
    if (!this.frameMode && isLargerThanScreen(root)) return;
    const member = this.trackedInside(root);
    const text = extractText(root).slice(0, 60);
    const isFrame = target.tagName === "IFRAME";
    const o: Obstruction = {
      // 中の広告がすでに一覧に出ていれば、その id(=番号)を引き継ぐ。以後この id は変えない
      id: member?.id ?? `${frameToken}-o${++this.counter}`,
      kind,
      root,
      revealed: false,
      excerpt:
        member?.excerpt ||
        text ||
        (kind === "video" ? "(動画広告)" : isFrame ? "(広告フレーム)" : ""),
      domain:
        member?.domain ??
        (kind === "video" ? videoAdHost(target) : null) ??
        (isFrame ? iframeHost(target) : (extractLanding(root, this.pageHost)[0]?.split("/")[0] ?? null)),
      prevDisplay: backupDisplay(root),
      extras: extraEls.map((el) => ({ el, prevDisplay: backupDisplay(el) })),
    };
    this.obstructions.set(root, o);
    for (const x of o.extras) this.extraOwners.set(x.el, o);
    this.hideRoot(o);
    if (kind === "overlay") this.overlayHolds.add(o.id);
    showToast(this.env.doc, `${note || OBSTRUCTION_LABELS[kind]}をブロックしました`, {
      label: "元に戻す",
      fn: () => this.setObstructionRevealed(o, true),
    });
    this.scheduleReport();
  }

  private readonly onMedia = (e: Event): void => {
    if (e.target instanceof HTMLMediaElement) this.checkMedia(e.target, true);
  };

  private readonly onScroll = (): void => {
    if (this.scrollTimer) clearTimeout(this.scrollTimer);
    this.scrollTimer = setTimeout(() => {
      this.scrollTimer = null;
      this.checkObstructions();
    }, 300);
  };

  /** 広告内の動画・音声が音付きで再生されていたら、消音して止める */
  private checkMedia(m: HTMLMediaElement, viaEvent = false): void {
    if (!this.running || !this.settings.obstruction.autoplay) return;
    if (this.userPlayed.has(m)) return;
    const existing = this.obstructions.get(m);
    if (existing?.revealed) return;
    const audible = !m.muted && m.volume > 0;
    const playing = !m.paused || m.autoplay;
    if (!audible || !playing || !this.inAdContext(m)) return;

    // 利用者が広告内の動画を自分で再生・消音解除した場合(play/volumechange が直前の
    // クリック等の操作つきで届いた場合)は、自動再生ではないので止めない
    if (viaEvent && this.env.doc.defaultView?.navigator.userActivation?.isActive) {
      this.userPlayed.add(m);
      return;
    }

    m.muted = true;
    m.pause();
    if (existing) return;
    const member = [...this.tracked.values()].find((t) => t.el.contains(m));
    const o: Obstruction = {
      id: `${frameToken}-o${++this.counter}`,
      kind: "autoplay",
      root: m,
      revealed: false,
      excerpt: member?.excerpt || extractText(m.parentElement ?? m).slice(0, 60),
      domain: member?.domain ?? null,
      prevDisplay: null,
      extras: [],
    };
    this.obstructions.set(m, o);
    showToast(this.env.doc, `広告の${OBSTRUCTION_LABELS.autoplay}を止めました`, {
      label: "元に戻す",
      fn: () => this.setObstructionRevealed(o, true),
    });
    this.scheduleReport();
  }

  private inAdContext(el: Element): boolean {
    if (this.frameMode) return true;
    if (el.closest(SLOT_SELECTOR)) return true;
    for (const t of this.tracked.values()) if (t.el.contains(el)) return true;
    for (const o of this.obstructions.values()) if (o.kind !== "autoplay" && o.root.contains(el)) return true;
    return false;
  }

  private setObstructionRevealed(o: Obstruction, reveal: boolean): void {
    o.revealed = reveal;
    if (o.kind === "autoplay") {
      const m = o.root as HTMLMediaElement;
      m.muted = !reveal;
      if (reveal) void m.play().catch(() => {});
      else m.pause();
    } else if (reveal) {
      this.showRoot(o);
      this.overlayHolds.delete(o.id);
    } else {
      this.hideRoot(o);
      if (o.kind === "overlay") this.overlayHolds.add(o.id);
    }
    this.updateUnlock();
    this.scheduleReport();
  }

  /**
   * 入れ物を隠す。CSS(属性)だけでは、広告側が style 属性に display:block !important を
   * 書くと負けるので、style 属性にも !important で書き、書き換えられたら書き直す。
   */
  private hideRoot(o: Obstruction): void {
    if (o.kind === "autoplay") return;
    for (const el of [o.root, ...o.extras.map((x) => x.el)]) {
      el.setAttribute(OBSTRUCT_ATTR, o.kind);
      enforceHidden(el);
      this.styleMo?.observe(el, { attributes: true, attributeFilter: ["style"] });
    }
  }

  /** 隠す前の表示に戻す(style 属性の display も元の値に戻す) */
  private showRoot(o: Obstruction): void {
    if (o.kind === "autoplay") return;
    o.root.removeAttribute(OBSTRUCT_ATTR);
    restoreDisplay(o.root, o.prevDisplay);
    for (const x of o.extras) {
      x.el.removeAttribute(OBSTRUCT_ATTR);
      restoreDisplay(x.el, x.prevDisplay);
    }
  }

  /**
   * 全画面広告を止めている間、広告がかけたスクロール停止を解除する。
   * - 停止の仕方は広告ごとに違う(html/body の overflow:hidden、body や html の position:fixed)
   * - 広告の要素がページから消えても停止は残ることがある(広告自身の「閉じる」処理が動かないため)
   * そこで、止めた全画面広告が 1 つでもある間は、毎回「自分の解除を外した状態」で停止の有無を調べ直す。
   * 属性の付け外しは同じ処理の中で行い、その間に描画は挟まらないので画面は点滅しない。
   */
  private updateUnlock(): void {
    const html = this.env.doc.documentElement;
    if (this.overlayHolds.size === 0) {
      if (html.hasAttribute(UNLOCK_ATTR)) html.removeAttribute(UNLOCK_ATTR);
      return;
    }
    const prev = html.getAttribute(UNLOCK_ATTR);
    if (prev !== null) html.removeAttribute(UNLOCK_ATTR);
    const lock = scrollLock(this.env.doc);
    const value = [lock.overflow ? "overflow" : "", lock.fixed ? "fixed" : ""].filter(Boolean).join(" ");
    if (value) html.setAttribute(UNLOCK_ATTR, value);
  }

  private insideHiddenObstruction(el: Element): boolean {
    for (const o of this.obstructions.values()) {
      if (o.kind !== "autoplay" && o.root.contains(el)) return true;
    }
    return false;
  }

  private trackedInside(root: Element): Tracked | undefined {
    for (const t of this.tracked.values()) if (root.contains(t.el)) return t;
    return undefined;
  }

  // ---- 判定 ----

  private applyPreblur(): void {
    const html = this.env.doc.documentElement;
    if (this.settings.pendingBlur) html.setAttribute(PREBLUR_ATTR, "");
    else html.removeAttribute(PREBLUR_ATTR);
  }

  private overlapsTracked(el: Element): boolean {
    for (const t of this.tracked.keys()) {
      if (t.contains(el) || el.contains(t)) return true;
    }
    return false;
  }

  private track(el: Element, source: CandidateSource, where: CandidateWhere): void {
    // 以前「判定しない枠」とした空枠に中身が入った場合は、判定前ぼかしに戻す
    if (el.getAttribute(STATE_ATTR) === "skip") el.removeAttribute(STATE_ATTR);
    // 先に自動再生だけを止めて一覧に出していた広告なら、その行の id(=番号)を引き継ぐ
    const muted = [...this.obstructions.values()].find((o) => o.kind === "autoplay" && el.contains(o.root));
    const t: Tracked = {
      id: muted?.id ?? `${frameToken}-${++this.counter}`,
      el,
      source,
      where,
      state: "new",
      hash: "",
      excerpt: "",
      domain: null,
      markup: [],
      answers: null,
      mock: false,
      judgedAt: 0,
      judgeCount: 0,
      seq: 0,
      revealed: false,
      warnDismissed: false,
      retries: 0,
    };
    this.tracked.set(el, t);
    // 画面に近づいた広告だけを判定する(見ない広告に API を使わない)
    if (this.io && el !== this.env.doc.documentElement) this.io.observe(el);
    else void this.judge(t);
  }

  private onIntersect(entries: IntersectionObserverEntry[]): void {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const t = this.tracked.get(e.target);
      this.io?.unobserve(e.target);
      if (t && t.state === "new") void this.judge(t);
    }
  }

  private async judge(t: Tracked): Promise<void> {
    await this.domReady;
    if (!this.running || !this.tracked.has(t.el)) return;
    if (!isCandidateSize(t.el, t.source)) {
      this.drop(t);
      return;
    }
    const { text, landing, markup } = extract(t.el, this.pageHost);
    t.hash = fnv1a(text);
    t.excerpt = text.slice(0, 60);
    t.markup = markup;
    t.domain = landing[0]?.split("/")[0] ?? (this.frameMode ? this.pageHost || null : null);
    t.judgedAt = Date.now();

    if (text.length < MIN_TEXT_CHARS) {
      // 画像だけの広告。フレームで中に iframe があるなら、内側のフレームが判定する
      const nested = t.el.querySelector("iframe") !== null;
      if (t.source === "frame" && nested) {
        this.untrack(t);
        return;
      }
      if (!t.el.querySelector("img")) {
        if (t.source === "frame") {
          // 中身がまだない広告フレーム(読み込み前の about:blank など)。一覧には出さず、
          // 判定前ぼかしは残したまま中身が入るのを待つ(次の走査で再び拾う)
          this.tracked.delete(t.el);
        } else {
          // 空の広告枠(まだ読み込まれていない)。中身が入ったら再判定する
          this.untrack(t);
        }
        return;
      }
      t.state = "unreadable";
      this.paint(t);
      this.scheduleReport();
      return;
    }

    if (this.judged >= MAX_JUDGE_PER_FRAME) {
      this.untrack(t);
      return;
    }
    this.judged++;
    t.judgeCount++;
    const seq = ++t.seq;
    t.state = "pending";
    this.paint(t);
    this.scheduleReport();

    let res: ClassifyResponse;
    try {
      res = (await this.env.send({ type: "classify", text, landing, markup })) as ClassifyResponse;
    } catch {
      res = { ok: false, code: "network", error: "拡張機能と通信できません" };
    }
    if (seq !== t.seq || !this.running || !this.tracked.has(t.el)) return;

    if (!res || !res.ok) {
      // 失敗時はフェイルオープン(ぼかしを外して通常表示)し、一時的な失敗なら少し待ってやり直す
      t.state = "error";
      t.answers = null;
      this.paint(t);
      this.scheduleRetry(t, res && !res.ok ? res.code : "network");
    } else {
      t.answers = res.answers;
      t.mock = res.mock;
      this.applyAnswers(t);
    }
    this.scheduleReport();
  }

  private scheduleRetry(t: Tracked, code: string): void {
    if (!RETRYABLE.has(code) || t.retries >= MAX_RETRIES) return;
    t.retries++;
    const waitCooldown = code === "cooldown" || code === "rate_limit" || code === "overloaded";
    const delay = waitCooldown
      ? (this.env.retryBaseMs ?? RETRY_AFTER_COOLDOWN_MS)
      : (this.env.retryBaseMs ?? 4000) * t.retries;
    setTimeout(() => {
      if (this.running && this.tracked.get(t.el) === t && t.state === "error") void this.judge(t);
    }, delay);
  }

  /** 広告ではなかった候補。加えた表示・属性を外して追跡をやめる */
  private drop(t: Tracked): void {
    clear(t.el);
    this.tracked.delete(t.el);
    this.io?.unobserve(t.el);
    this.scheduleReport();
  }

  /** 判定をやめる要素。判定前ぼかしが残らないよう「判定しない」印を付ける */
  private untrack(t: Tracked): void {
    this.tracked.delete(t.el);
    this.io?.unobserve(t.el);
    if (!t.el.hasAttribute(STATE_ATTR) && t.el !== this.env.doc.documentElement) t.el.setAttribute(STATE_ATTR, "skip");
    if (t.el === this.env.doc.documentElement) t.el.removeAttribute(STATE_ATTR);
  }

  private applyAnswers(t: Tracked): void {
    if (!t.answers) return;
    const v = decide(t.answers, this.settings, t.source);
    t.state = v.level === "block" && t.revealed ? "revealed" : v.level;
    this.paint(t);
  }

  private paint(t: Tracked): void {
    if (t.state === "new") return;
    const v = t.answers ? decide(t.answers, this.settings, t.source) : null;
    render(
      t.el,
      {
        state: t.state,
        top: v?.top ?? null,
        mock: t.mock,
        display: this.settings.display,
        showWarnBadge: this.settings.showWarnBadge,
        warnDismissed: t.warnDismissed,
        pendingBlur: this.settings.pendingBlur,
      },
      {
        reveal: () => {
          t.revealed = true;
          this.applyAnswers(t);
          this.scheduleReport();
        },
        hide: () => {
          t.revealed = false;
          this.applyAnswers(t);
          this.scheduleReport();
        },
        dismissWarn: () => {
          t.warnDismissed = true;
          this.paint(t);
        },
      },
    );
  }

  // ---- popup との対応付け ----

  /**
   * 一覧の id から対象を探す。画面妨害で消した入れ物の中の広告は、一覧では入れ物の 1 行に
   * まとめて広告自身の id を使うので(番号を変えないため)、その id は入れ物の操作に読み替える。
   */
  private findById(
    id: string,
  ): { kind: "tracked"; t: Tracked } | { kind: "obstruction"; o: Obstruction } | null {
    for (const t of this.tracked.values()) {
      if (t.id !== id) continue;
      for (const o of this.obstructions.values()) {
        if (o.kind !== "autoplay" && o.root.contains(t.el)) return { kind: "obstruction", o };
      }
      return { kind: "tracked", t };
    }
    for (const o of this.obstructions.values()) if (o.id === id) return { kind: "obstruction", o };
    return null;
  }

  /** ページ上で番号を重ねる・スクロールする先。見えないもの(妨害として消した)は null */
  private locateTarget(found: { kind: "tracked"; t: Tracked } | { kind: "obstruction"; o: Obstruction }): Element | null {
    if (found.kind === "obstruction") {
      const o = found.o;
      if (o.kind === "autoplay") return o.root.parentElement ?? o.root;
      return o.revealed ? o.root : null;
    }
    const { el } = found.t;
    if (this.insideHiddenObstruction(el)) return null;
    // 「隠す」表示で畳んだ広告は、代わりに出している1行の案内を指す
    if (el.getAttribute(DISPLAY_ATTR) === "hide") return uiOf(el)?.host ?? null;
    return el;
  }

  private toneOf(found: { kind: "tracked"; t: Tracked } | { kind: "obstruction"; o: Obstruction }): MarkerTone {
    const state = found.kind === "obstruction" ? "block" : found.t.state;
    if (state === "block" || state === "revealed" || state === "obstruct") return "block";
    if (state === "warn") return "warn";
    if (state === "ok" || state === "content") return "ok";
    return "muted";
  }

  private itemOf(t: Tracked): ItemReport {
    const v = t.answers ? decide(t.answers, this.settings, t.source) : null;
    return {
      id: t.id,
      state: t.state as ItemState,
      excerpt: t.excerpt,
      source: t.source,
      where: t.where,
      domain: t.domain,
      top: v?.top ?? null,
      answers: t.answers,
      markup: t.markup,
      obstruction: null,
      onPage: this.locateTarget({ kind: "tracked", t }) !== null,
      mock: t.mock,
    };
  }

  /**
   * 画面妨害として止めたもの自体の 1 件。中の広告があれば、その判定結果を引き継ぐ。
   * id は止めた時点で決めたもの(先に一覧に出ていた広告なら同じ番号のまま「妨害ブロック」に変わる)。
   */
  private obstructionItem(o: Obstruction, member: Tracked | undefined): ItemReport {
    const base = member && member.state !== "new" ? this.itemOf(member) : null;
    return {
      id: o.id,
      state: o.revealed ? "revealed" : "obstruct",
      excerpt: base?.excerpt || o.excerpt,
      source: member?.source ?? "selector",
      where: o.kind === "autoplay" || o.kind === "video" ? "media" : "fixed",
      domain: base?.domain ?? o.domain,
      top: base?.top ?? null,
      answers: base?.answers ?? null,
      markup: base?.markup ?? [],
      obstruction: o.kind,
      onPage: o.kind === "autoplay" || o.revealed,
      mock: base?.mock ?? false,
    };
  }

  /**
   * popup 用の一覧。画面妨害で消した入れ物の中の広告は、その入れ物の 1 件にまとめる
   * (同じ広告が 2 行に出ないように)。消音だけの広告は、広告自体の行に印を付ける。
   */
  private snapshot(): ItemReport[] {
    const out: ItemReport[] = [];
    const merged = new Set<Tracked>();
    const mutedIn = new Set<Tracked>();

    for (const o of this.obstructions.values()) {
      if (o.kind === "autoplay") {
        // 広告の行があればそこに印を付ける(判定待ちでも単独の行は作らない。番号が飛ぶため)
        const member = [...this.tracked.values()].find((t) => t.el.contains(o.root));
        if (member) mutedIn.add(member);
        else out.push(this.obstructionItem(o, undefined));
        continue;
      }
      const members = [...this.tracked.values()].filter((t) => o.root.contains(t.el));
      for (const m of members) merged.add(m);
      out.push(this.obstructionItem(o, members.find((m) => m.answers) ?? members[0]));
    }

    for (const t of this.tracked.values()) {
      if (t.state === "new" || merged.has(t)) continue;
      const item = this.itemOf(t);
      if (mutedIn.has(t)) item.obstruction = "autoplay";
      out.push(item);
    }
    return out;
  }

  private scheduleScan(): void {
    if (this.scanTimer || !this.running) return;
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      this.scan();
    }, this.scanDelay);
  }

  private scheduleReport(): void {
    if (this.reportTimer) return;
    this.reportTimer = setTimeout(() => {
      this.reportTimer = null;
      this.report();
    }, 250);
  }
}

/**
 * 動画プレーヤーそのものの外枠(動画とほぼ同じ大きさの、いちばん外側の祖先)。
 * video.js などは操作ボタンの隠し文字が 400 字を超えるので(AdPushup のプレーヤーで 431 字)、
 * この枠の中の文字は「広告以外の文字」から除く。動画がまだ大きさを持たないときは動画自身。
 */
function playerRootOf(media: Element, isPage: (el: Element) => boolean): Element {
  const mr = media.getBoundingClientRect();
  if (mr.width <= 0 || mr.height <= 0) return media;
  let root: Element = media;
  for (let el = media.parentElement; el && !isPage(el); el = el.parentElement) {
    const r = el.getBoundingClientRect();
    if (r.width > mr.width * 1.5 || r.height > mr.height * 1.5) break;
    root = el;
  }
  return root;
}

/**
 * 画面(ビューポート)より明らかに大きい要素か。広告の入れ物を選び間違えて、
 * 記事全体やページの大枠を隠してしまわないための安全装置
 */
function isLargerThanScreen(el: Element): boolean {
  const view = el.ownerDocument.defaultView;
  if (!view) return false;
  const r = el.getBoundingClientRect();
  return r.height > view.innerHeight * 1.2 && r.width > view.innerWidth * 0.8;
}

/** style 属性に display:none !important を書く(すでにそうなら何もしない。見張りのループを避ける) */
function enforceHidden(el: Element): void {
  if (!(el instanceof HTMLElement)) return;
  if (el.style.getPropertyValue("display") === "none" && el.style.getPropertyPriority("display") === "important") return;
  el.style.setProperty("display", "none", "important");
}

/** 本拡張の UI の追加・削除だけによる変化か */
function isOwnMutation(r: MutationRecord): boolean {
  if (r.type !== "childList") return false;
  const nodes = [...r.addedNodes, ...r.removedNodes];
  return nodes.length > 0 && nodes.every((n) => n.nodeType === 1 && (n as Element).hasAttribute(UI_ATTR));
}

/** テスト用: フレーム識別子を固定する */
export function setFrameTokenForTest(token: string): void {
  frameToken = token;
}
