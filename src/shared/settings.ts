import { DEFAULT_MODEL } from "./questions";
import { OBSTRUCTION_KINDS, RISK_CATEGORIES } from "./types";
import type { DisplayMode, ObstructionKind, RiskCategory, Settings } from "./types";

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  model: DEFAULT_MODEL,
  blockThreshold: 0.7,
  warnThreshold: 0.4,
  categories: { scam: true, fake_alert: true, phishing: true, misleading: true, inappropriate: true },
  display: "blur",
  pendingBlur: true,
  showWarnBadge: true,
  obstruction: { overlay: true, sticky: true, video: true, autoplay: true },
  disabledSites: [],
};

/** chrome.storage.sync のキー(APIキー以外の設定) */
export const SETTINGS_KEY = "settings";
/** chrome.storage.local のキー。local は拡張機能内だけに公開し、content script からは読めない */
export const API_KEY_KEY = "apiKey";

const DISPLAY_MODES: DisplayMode[] = ["blur", "hide", "label"];

function clamp01(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

/** 保存値を検証して既定値で補う。壊れた値や古い形式でも必ず有効な Settings を返す */
export function normalizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof Settings, unknown>>;
  const d = DEFAULT_SETTINGS;

  const rawCats = (r.categories && typeof r.categories === "object" ? r.categories : {}) as Partial<
    Record<RiskCategory, unknown>
  >;
  const categories = Object.fromEntries(
    RISK_CATEGORIES.map((c) => [c, typeof rawCats[c] === "boolean" ? rawCats[c] : d.categories[c]]),
  ) as Record<RiskCategory, boolean>;

  const rawObs = (r.obstruction && typeof r.obstruction === "object" ? r.obstruction : {}) as Partial<
    Record<ObstructionKind, unknown>
  >;
  const obstruction = Object.fromEntries(
    OBSTRUCTION_KINDS.map((k) => [k, typeof rawObs[k] === "boolean" ? rawObs[k] : d.obstruction[k]]),
  ) as Record<ObstructionKind, boolean>;

  const blockThreshold = clamp01(r.blockThreshold, d.blockThreshold);
  // 注意しきい値は遮蔽しきい値を超えない
  const warnThreshold = Math.min(clamp01(r.warnThreshold, d.warnThreshold), blockThreshold);

  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
    model: typeof r.model === "string" && r.model.trim() ? r.model.trim() : d.model,
    blockThreshold,
    warnThreshold,
    categories,
    display: DISPLAY_MODES.includes(r.display as DisplayMode) ? (r.display as DisplayMode) : d.display,
    pendingBlur: typeof r.pendingBlur === "boolean" ? r.pendingBlur : d.pendingBlur,
    showWarnBadge: typeof r.showWarnBadge === "boolean" ? r.showWarnBadge : d.showWarnBadge,
    obstruction,
    disabledSites: Array.isArray(r.disabledSites)
      ? [...new Set(r.disabledSites.map(normalizeHost).filter((h): h is string => h !== null))]
      : d.disabledSites,
  };
}

/** "https://www.Example.com/path" や "example.com" をホスト名へ正規化する。無効なら null */
export function normalizeHost(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const s = input.trim().toLowerCase();
  if (!s) return null;
  try {
    const url = new URL(s.includes("://") ? s : `https://${s}`);
    const host = url.hostname.replace(/\.$/, "");
    return host && host.includes(".") ? host : host === "localhost" ? host : null;
  } catch {
    return null;
  }
}

/** host が無効サイト一覧(サブドメイン含む)に入っているか */
export function isSiteDisabled(host: string, disabledSites: readonly string[]): boolean {
  const h = host.toLowerCase();
  return disabledSites.some((site) => h === site || h.endsWith(`.${site}`));
}

/** 一覧表示・切替用に、先頭の www. を除いたサイト名にする */
export function siteKey(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}
