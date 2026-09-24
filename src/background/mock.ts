import type { Answers, MarkupSignal, QuestionKey } from "../shared/types";

/**
 * デモモード(APIキー未設定)の疑似判定。固定キーワードの一致だけで確率らしき値を作る。
 * 文の意味は理解しないので、実際の判定精度の目安にはならない。UI では必ず「デモ判定」と表示する。
 */
type Rule = [pattern: RegExp, weight: number];

const RULES: Record<QuestionKey, Rule[]> = {
  is_ad: [
    [/広告|スポンサー|sponsored|promoted|\bPR\b|プロモーション/i, 0.5],
    [/今すぐ|詳しくは|こちら|購入|申し込|登録|無料|キャンペーン|限定|OFF|割引|送料|セール|お試し/i, 0.45],
    [/[¥￥]\s?\d|\d+円|\d+%/, 0.3],
    [/インストール|ダウンロード|アプリ|click|shop|buy|sale/i, 0.25],
  ],
  scam: [
    [/元本保証|必ず儲|絶対に儲|確実に稼|放置で稼|寝ながら稼|誰でも簡単に稼/, 0.75],
    [/月利|日給|月収\s?\d|年収\s?\d|億り人|配当|利回り\s?\d{2,}/, 0.45],
    [/自動売買|FX|仮想通貨|暗号資産|バイナリー|投資家が(明か|暴露)/, 0.35],
    [/LINE(登録|追加|で受け取)|友だち追加/, 0.35],
    [/(秘密|裏技|極秘)の?(方法|手法|ノウハウ)|暴露/, 0.3],
    [/guaranteed (profit|return)|get rich|passive income|earn \$\d/i, 0.6],
  ],
  fake_alert: [
    [/ウイルス|ウィルス|マルウェア|感染/, 0.6],
    [/検出されました|\d+件検出|損傷|破損|ハッキング|不正アクセスを検知|危険にさらされ/, 0.45],
    [/(警告|緊急|注意)[】!！:：]|システム警告/, 0.3],
    [/当選|選ばれました|プレゼントに選/, 0.55],
    [/今すぐ.{0,12}(修復|スキャン|削除|インストール|受け取|手続)|残り\d+(秒|分)|\d+秒以内/, 0.4],
    [/your (device|phone|computer) (is|has been) (infected|hacked)|virus(es)? detected|congratulations.*(winner|won)/i, 0.7],
  ],
  phishing: [
    [/パスワード|暗証番号|セキュリティコード|カード番号/, 0.5],
    [/アカウント(が|を)?(停止|凍結|ロック|制限)|利用停止/, 0.5],
    [/本人確認|再登録|情報を?更新|認証してください|ログインして(確認|解除)/, 0.4],
    [/verify your (account|identity)|account (suspended|locked)|update your payment/i, 0.65],
  ],
  misleading: [
    [/飲むだけで|塗るだけで|貼るだけで|着るだけで|置くだけで/, 0.5],
    [/[-−ー]\s?\d+\s?(kg|キロ)|痩せ|ダイエット/, 0.35],
    [/シミ|シワ|薄毛|白髪|たるみ/, 0.2],
    [/(消え|治っ|若返っ|生え)た|完治|奇跡|医師も(驚|絶句)|衝撃の/, 0.45],
    [/(100|99)[%％].*(効果|満足|実感)|効果には個人差がありますが/, 0.3],
    [/miracle|doctors (hate|are shocked)|lose \d+ ?(lbs|kg)/i, 0.6],
  ],
  inappropriate: [
    [/エロ|アダルト|R-?18|18禁|成人向け|人妻|巨乳|セフレ|風俗|出会い系?|大人の(漫画|マンガ|動画|関係)/, 0.6],
    [/過激|セクシー|官能|濡れ場|脱(が|ぎ)/, 0.35],
    [/血まみれ|流血|惨殺|殺戮|残虐|拷問|死体|グロ/, 0.55],
    [/閲覧注意|ホラー|惨劇|戦慄/, 0.35],
    [/オンラインカジノ|カジノ|ベット(して|で)/, 0.5],
    [/adult|xxx|nsfw|hook ?up|gore|online casino/i, 0.6],
  ],
};

const BASE: Record<QuestionKey, number> = {
  is_ad: 0.2,
  scam: 0.03,
  fake_alert: 0.02,
  phishing: 0.02,
  misleading: 0.04,
  inappropriate: 0.02,
};

/** 広告の HTML の特徴による上乗せ(入力欄は個人情報の要求、カウントダウンは偽警告の強い手がかり) */
const MARKUP_RULES: Partial<Record<MarkupSignal, Partial<Record<QuestionKey, number>>>> = {
  password_field: { phishing: 0.6 },
  card_field: { phishing: 0.6 },
  personal_field: { phishing: 0.3 },
  countdown: { fake_alert: 0.3, scam: 0.1 },
};

/** 一致したキーワードの重みを確率的に合成する(1 - Π(1 - w)) */
export function mockAnswers(text: string, landing: readonly string[] = [], markup: readonly MarkupSignal[] = []): Answers {
  const haystack = `${text} ${landing.join(" ")}`.normalize("NFKC");
  const answers = {} as Answers;
  for (const key of Object.keys(RULES) as QuestionKey[]) {
    let miss = 1 - BASE[key];
    for (const [pattern, weight] of RULES[key]) {
      if (pattern.test(haystack)) miss *= 1 - weight;
    }
    for (const m of markup) {
      const w = MARKUP_RULES[m]?.[key];
      if (w) miss *= 1 - w;
    }
    answers[key] = Math.round((1 - miss) * 1000) / 1000;
  }
  return answers;
}
