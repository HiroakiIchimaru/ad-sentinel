import {
  CANDIDATE_SOURCES,
  CANDIDATE_WHERES,
  ITEM_STATES,
  MARKUP_SIGNALS,
  OBSTRUCTION_KINDS,
  RISK_CATEGORIES,
} from "../shared/types";
import type { Answers, ItemReport, MarkupSignal, QuestionKey, TabState } from "../shared/types";
import type { KV } from "./kv";

interface TabEntry {
  host: string;
  /** frameId → そのフレームの最新スナップショット */
  frames: Record<string, ItemReport[]>;
  /** 項目 id → タブ内の通し番号(一覧とページ上の番号表示を対応させる。一度付けたら変えない) */
  numbers: Record<string, number>;
  next: number;
}

const emptyEntry = (): TabEntry => ({ host: "", frames: {}, numbers: {}, next: 1 });

const MAX_ITEMS_PER_FRAME = 60;
const MAX_ID_CHARS = 32;
const MAX_EXCERPT_CHARS = 80;
const MAX_DOMAIN_CHARS = 253;

const QUESTION_KEYS: readonly QuestionKey[] = ["is_ad", ...RISK_CATEGORIES];
// `in` はプロトタイプ鎖も見る("__proto__" が通る)ので、自身のキーの集合で確かめる
const MARKUP_KEYS = new Set(Object.keys(MARKUP_SIGNALS));

function oneOf<T extends string>(v: unknown, list: readonly T[]): T | null {
  return typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : null;
}

function probability(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
}

/**
 * content script からの報告を検証し直す。content script はページと同じレンダラープロセスで
 * 動くので、そこからのメッセージは信用せず、popup に表示する値の型・値域・長さをここで確かめる。
 * id と state が正しくない項目は捨て、その他の欄は安全な値に直して受け入れる。
 */
export function sanitizeItems(raw: unknown): ItemReport[] {
  if (!Array.isArray(raw)) return [];
  const out: ItemReport[] = [];
  for (const v of raw.slice(0, MAX_ITEMS_PER_FRAME)) {
    if (!v || typeof v !== "object") continue;
    const r = v as Record<string, unknown>;
    const state = oneOf(r.state, ITEM_STATES);
    if (typeof r.id !== "string" || !r.id || r.id.length > MAX_ID_CHARS || !state) continue;

    let top: ItemReport["top"] = null;
    if (r.top && typeof r.top === "object") {
      const t = r.top as Record<string, unknown>;
      const category = oneOf(t.category, RISK_CATEGORIES);
      const p = probability(t.p);
      if (category && p !== null) top = { category, p };
    }

    let answers: Answers | null = null;
    if (r.answers && typeof r.answers === "object") {
      const a = {} as Answers;
      let ok = true;
      for (const k of QUESTION_KEYS) {
        const p = probability((r.answers as Record<string, unknown>)[k]);
        if (p === null) {
          ok = false;
          break;
        }
        a[k] = p;
      }
      if (ok) answers = a;
    }

    out.push({
      id: r.id,
      state,
      excerpt: typeof r.excerpt === "string" ? r.excerpt.slice(0, MAX_EXCERPT_CHARS) : "",
      source: oneOf(r.source, CANDIDATE_SOURCES) ?? "selector",
      where: oneOf(r.where, CANDIDATE_WHERES) ?? "slot",
      domain: typeof r.domain === "string" && r.domain ? r.domain.slice(0, MAX_DOMAIN_CHARS) : null,
      top,
      answers,
      markup: Array.isArray(r.markup)
        ? [...new Set(r.markup.filter((m): m is MarkupSignal => typeof m === "string" && MARKUP_KEYS.has(m)))]
        : [],
      obstruction: oneOf(r.obstruction, OBSTRUCTION_KINDS),
      onPage: r.onPage === true,
      mock: r.mock === true,
    });
  }
  return out;
}

/**
 * タブごとの判定一覧。各フレームの content script が送る「現在の状態のスナップショット」を保持する。
 * service worker は停止しうるので chrome.storage.session にも書く(ブラウザ終了で消える)。
 */
export class TabStore {
  private readonly tabs = new Map<number, TabEntry>();
  private readonly dirty = new Set<number>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly session: KV | null,
    private readonly onChange: (tabId: number, state: TabState) => void = () => {},
  ) {}

  async report(tabId: number, frameId: number, isTop: boolean, host: string | null, items: unknown): Promise<void> {
    const entry = await this.load(tabId);
    if (isTop && host !== null) entry.host = host;
    const clean = sanitizeItems(items);
    if (clean.length === 0) delete entry.frames[frameId];
    else entry.frames[frameId] = clean;
    // 判定が終わったものから番号を振る(判定中の段階では一覧に出さないので、番号が飛ばないように)
    for (const item of entry.frames[frameId] ?? []) {
      if (typeof item.id === "string" && item.state !== "pending" && entry.numbers[item.id] === undefined) {
        entry.numbers[item.id] = entry.next++;
      }
    }
    this.touch(tabId, entry);
  }

  /** ページ遷移の開始時に呼ぶ。前のページの一覧を消す */
  reset(tabId: number): void {
    const entry = emptyEntry();
    this.tabs.set(tabId, entry);
    this.touch(tabId, entry);
  }

  remove(tabId: number): void {
    this.tabs.delete(tabId);
    this.dirty.delete(tabId);
    void this.session?.remove(`tab:${tabId}`);
  }

  async get(tabId: number): Promise<TabState> {
    return toState(await this.load(tabId));
  }

  private async load(tabId: number): Promise<TabEntry> {
    const mem = this.tabs.get(tabId);
    if (mem) return mem;
    const stored = this.session ? (await this.session.get(`tab:${tabId}`))[`tab:${tabId}`] : undefined;
    // await 中に別の report が先に作っていたらそちらを使う
    const again = this.tabs.get(tabId);
    if (again) return again;
    const entry: TabEntry =
      stored && typeof stored === "object" && "frames" in stored
        ? { ...emptyEntry(), ...(stored as Partial<TabEntry>) }
        : emptyEntry();
    this.tabs.set(tabId, entry);
    return entry;
  }

  private touch(tabId: number, entry: TabEntry): void {
    this.onChange(tabId, toState(entry));
    if (!this.session) return;
    this.dirty.add(tabId);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const items: Record<string, unknown> = {};
      for (const id of this.dirty) {
        const e = this.tabs.get(id);
        if (e) items[`tab:${id}`] = e;
      }
      this.dirty.clear();
      void this.session?.set(items);
    }, 300);
  }
}

/**
 * 一覧の並び順は「ページ上の番号順」。状態が変わっても行が入れ替わらないので、
 * 番号を見ながら一覧とページを見比べやすい。
 */
function toState(entry: TabEntry): TabState {
  const items = Object.values(entry.frames)
    .flat()
    .map((i) => ({ ...i, n: entry.numbers[i.id] }))
    .sort((a, b) => (a.n ?? Infinity) - (b.n ?? Infinity));
  return { host: entry.host, items };
}

/** ツールバーのバッジに出す件数(隠した・止めた広告の数) */
export function blockedCount(state: TabState): number {
  return state.items.filter((i) => i.state === "block" || i.state === "obstruct").length;
}
