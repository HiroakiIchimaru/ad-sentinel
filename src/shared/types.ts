/**
 * 悪質さのカテゴリ(jev への質問キーと一致)。
 * inappropriate は「子供に見せるのに不適切な表現(性的・暴力的など)」
 */
export const RISK_CATEGORIES = ["scam", "fake_alert", "phishing", "misleading", "inappropriate"] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];

/** jev に聞く質問キー。is_ad はリスクではなく「記事本文との区別」に使う */
export type QuestionKey = "is_ad" | RiskCategory;

/** 各質問の Yes 確率(0〜1) */
export type Answers = Record<QuestionKey, number>;

/**
 * 広告候補をどう見つけたか。label は「PR」等の表記からの推定で、記事本文の可能性が残る。
 * widget は「おすすめ記事」枠のカードで、広告と記事の推薦が混在する
 */
export const CANDIDATE_SOURCES = ["selector", "label", "widget", "frame"] as const;
export type CandidateSource = (typeof CANDIDATE_SOURCES)[number];

/** ページ上のどこにある広告か(popup の一覧で「どの広告か」を示すため) */
export const CANDIDATE_WHERES = ["slot", "widget", "label", "frame", "fixed", "media"] as const;
export type CandidateWhere = (typeof CANDIDATE_WHERES)[number];

/**
 * 画面をふさぐ動作の種類。意味の判定(jev)とは別に、端末内のルールで即座に止める。
 * overlay/sticky/video は入れ物ごと非表示、autoplay は消音・停止
 */
export const OBSTRUCTION_KINDS = ["overlay", "sticky", "video", "autoplay"] as const;
export type ObstructionKind = (typeof OBSTRUCTION_KINDS)[number];

/**
 * 広告の HTML から取り出す構造上の特徴。jev には英語の説明文に変換して渡す。
 * 入力欄の値や生の HTML は送らない(キーの一覧で許可したものだけ)。
 */
export const MARKUP_SIGNALS = {
  password_field: "contains a password input field",
  card_field: "contains a credit card number input field",
  personal_field: "contains input fields for personal information (name, email, phone or address)",
  countdown: "shows a countdown timer",
  new_window: "opens its link in a new window",
  autoplay_media: "autoplays audio or video",
} as const;
export type MarkupSignal = keyof typeof MARKUP_SIGNALS;

export type DisplayMode = "blur" | "hide" | "label";

export interface Settings {
  enabled: boolean;
  model: string;
  blockThreshold: number;
  warnThreshold: number;
  categories: Record<RiskCategory, boolean>;
  display: DisplayMode;
  /** 判定が終わるまで広告を薄くぼかす */
  pendingBlur: boolean;
  /** 注意しきい値を超えた広告に小さなバッジを出す */
  showWarnBadge: boolean;
  /** 画面をふさぐ広告を自動でブロックする(種類ごと) */
  obstruction: Record<ObstructionKind, boolean>;
  /** 無効にするサイトのホスト名(サブドメインも対象) */
  disabledSites: string[];
}

/** 判定の最終結果 */
export type VerdictLevel = "ok" | "warn" | "block" | "content";

export interface Verdict {
  level: VerdictLevel;
  /** 有効カテゴリのうち最も確率が高いもの */
  top: { category: RiskCategory; p: number } | null;
}

/** content script 上の広告候補の状態。obstruct は画面妨害として止めたもの */
export const ITEM_STATES = [
  "pending",
  "ok",
  "warn",
  "block",
  "obstruct",
  "revealed",
  "content",
  "unreadable",
  "error",
] as const;
export type ItemState = (typeof ITEM_STATES)[number];

/** popup に表示する 1 件分(広告文は冒頭のみ) */
export interface ItemReport {
  id: string;
  /** タブ内の通し番号。background が付け、ページ上の番号表示と対応する */
  n?: number;
  state: ItemState;
  excerpt: string;
  source: CandidateSource;
  where: CandidateWhere;
  /** 広告のリンク先(またはフレームの配信元)のドメイン */
  domain: string | null;
  top: { category: RiskCategory; p: number } | null;
  answers: Answers | null;
  markup: MarkupSignal[];
  obstruction: ObstructionKind | null;
  /** ページ上で見える位置にあるか(畳んだ・妨害として消した場合は false) */
  onPage: boolean;
  mock: boolean;
}

export type ApiStatus = "live" | "demo" | "auth_error" | "cooldown";

export interface ClassifyRequest {
  type: "classify";
  text: string;
  /** リンク先の「ドメイン/パス」(クエリと ID らしき部分は除く) */
  landing: string[];
  markup: MarkupSignal[];
}

/** popup → content script(タブ内の全フレーム) */
export type TabMessage =
  | { type: "requestReport" }
  | { type: "markers"; items: { id: string; n: number }[]; focus: string | null }
  | { type: "locate"; id: string }
  | { type: "reveal"; id: string; reveal: boolean };

export type ClassifyResponse =
  | { ok: true; answers: Answers; mock: boolean; cached: boolean; ms: number }
  | { ok: false; error: string; code: JevErrorCode | "cooldown" | "no_key" };

export type JevErrorCode =
  | "auth"
  | "rate_limit"
  | "overloaded"
  | "bad_request"
  | "server"
  | "timeout"
  | "network"
  | "invalid_response";

export interface FrameReportRequest {
  type: "frameReport";
  isTop: boolean;
  items: ItemReport[];
}

export interface GetTabStateRequest {
  type: "getTabState";
  tabId: number;
}

export interface TabState {
  host: string;
  items: ItemReport[];
}

export interface TabStateResponse {
  state: TabState;
  apiStatus: ApiStatus;
  usage: Usage;
}

export interface TestConnectionRequest {
  type: "testConnection";
  apiKey: string;
  model: string;
}

export type TestConnectionResponse =
  | { ok: true; ms: number; model: string; answers: Answers }
  | { ok: false; error: string };

export interface ClearCacheRequest {
  type: "clearCache";
}

export interface GetUsageRequest {
  type: "getUsage";
}

export type RuntimeMessage =
  | ClassifyRequest
  | FrameReportRequest
  | GetTabStateRequest
  | TestConnectionRequest
  | ClearCacheRequest
  | GetUsageRequest;

/** 当日の使用量(日付が変わったらリセット) */
export interface Usage {
  date: string;
  requests: number;
  inputTokens: number;
  cacheHits: number;
  errors: number;
  demoRequests: number;
}
