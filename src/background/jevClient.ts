import { JEV_ENDPOINT, QUESTIONS, QUESTION_KEYS } from "../shared/questions";
import type { Answers, JevErrorCode } from "../shared/types";

export class JevError extends Error {
  constructor(
    readonly code: JevErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "JevError";
  }
}

export interface JevResult {
  answers: Answers;
  model: string;
  inputTokens: number | null;
  ms: number;
}

export interface EvaluateOptions {
  apiKey: string;
  model: string;
  state: Record<string, unknown>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  endpoint?: string;
}

const STATUS_CODES: Record<number, JevErrorCode> = {
  401: "auth",
  403: "auth",
  422: "bad_request",
  400: "bad_request",
  429: "rate_limit",
  529: "overloaded",
};

const ERROR_MESSAGES: Record<JevErrorCode, string> = {
  auth: "APIキーが無効か、権限がありません",
  rate_limit: "リクエストが多すぎます(429)",
  overloaded: "jev が混雑しています(529)",
  bad_request: "リクエスト形式が受け付けられませんでした",
  server: "jev サーバーでエラーが発生しました",
  timeout: "応答がタイムアウトしました",
  network: "jev に接続できませんでした",
  invalid_response: "jev の応答形式が想定と異なります",
};

/** 1問分の回答から Yes 確率を取り出す。仕様上は `noul` フィールド */
function readProbability(answer: unknown): number | null {
  if (!answer || typeof answer !== "object") return null;
  const a = answer as Record<string, unknown>;
  if (a.type !== "noul") return null;
  const p = typeof a.noul === "number" ? a.noul : a.probability;
  return typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1 ? p : null;
}

/** 応答を検証し、全質問の確率が揃っているときだけ Answers を返す */
export function parseResponse(body: unknown): { answers: Answers; model: string; inputTokens: number | null } {
  if (!body || typeof body !== "object") {
    throw new JevError("invalid_response", ERROR_MESSAGES.invalid_response);
  }
  const b = body as Record<string, unknown>;
  const raw = b.answers;
  if (!raw || typeof raw !== "object") {
    throw new JevError("invalid_response", ERROR_MESSAGES.invalid_response);
  }
  const answers = {} as Answers;
  for (const key of QUESTION_KEYS) {
    const p = readProbability((raw as Record<string, unknown>)[key]);
    if (p === null) {
      throw new JevError("invalid_response", `${ERROR_MESSAGES.invalid_response}(${key})`);
    }
    answers[key] = p;
  }
  const usage = b.usage as Record<string, unknown> | undefined;
  const inputTokens = typeof usage?.input_tokens === "number" ? usage.input_tokens : null;
  return { answers, model: typeof b.model === "string" ? b.model : "", inputTokens };
}

/** TypeSafe の System One API に 6 問を並列で問い合わせる */
export async function evaluateJev(opts: EvaluateOptions): Promise<JevResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 6000);
  const t0 = performance.now();

  let res: Response;
  try {
    res = await fetchImpl(opts.endpoint ?? JEV_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: opts.model, state: opts.state, questions: QUESTIONS }),
      signal: controller.signal,
      // 認証は Authorization ヘッダだけで行い、Cookie 等は送らない
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted) throw new JevError("timeout", ERROR_MESSAGES.timeout);
    throw new JevError("network", `${ERROR_MESSAGES.network}: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    if (!res.ok) {
      const code = STATUS_CODES[res.status] ?? (res.status >= 500 ? "server" : "bad_request");
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 200);
      } catch {
        // 本文が読めなくてもステータスだけで十分
      }
      throw new JevError(code, `${ERROR_MESSAGES[code]}(HTTP ${res.status})${detail ? `: ${detail}` : ""}`, res.status);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new JevError("invalid_response", ERROR_MESSAGES.invalid_response);
    }
    const parsed = parseResponse(body);
    return { ...parsed, ms: Math.round(performance.now() - t0) };
  } catch (err) {
    if (err instanceof JevError) throw err;
    if (controller.signal.aborted) throw new JevError("timeout", ERROR_MESSAGES.timeout);
    throw new JevError("network", ERROR_MESSAGES.network);
  } finally {
    clearTimeout(timer);
  }
}
