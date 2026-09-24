import { RISK_CATEGORIES } from "./types";
import type { Answers, CandidateSource, Settings, Verdict } from "./types";

/** 「PR」表記から推定した候補は、is_ad がこれ未満なら広告ではない(記事)とみなす */
export const IS_AD_GATE = 0.35;

/**
 * おすすめ記事枠の、広告表記のないカード(記事の推薦が多い)は、より強く広告らしいときだけ判定する。
 * 実サイトで、詐欺被害を扱う自社記事の推薦に「偽の警告」の注意が付いたため
 */
export const WIDGET_IS_AD_GATE = 0.6;

/**
 * jev の確率と利用者の設定から最終判定を決める。
 * 確率はキャッシュされるので、設定変更時は API を呼ばずにこれだけ再実行すればよい。
 */
export function decide(answers: Answers, settings: Settings, source: CandidateSource): Verdict {
  let top: Verdict["top"] = null;
  for (const category of RISK_CATEGORIES) {
    if (!settings.categories[category]) continue;
    const p = answers[category];
    if (top === null || p > top.p) top = { category, p };
  }

  const gate = source === "label" ? IS_AD_GATE : source === "widget" ? WIDGET_IS_AD_GATE : null;
  if (gate !== null && answers.is_ad < gate) {
    return { level: "content", top };
  }
  if (top === null) return { level: "ok", top };
  if (top.p >= settings.blockThreshold) return { level: "block", top };
  if (top.p >= settings.warnThreshold) return { level: "warn", top };
  return { level: "ok", top };
}

/** 確率の表示用(例: 0.934 → "93%") */
export function percent(p: number): string {
  return `${Math.round(p * 100)}%`;
}
