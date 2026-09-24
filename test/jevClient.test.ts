import { describe, expect, it, vi } from "vitest";
import { evaluateJev, JevError, parseResponse } from "../src/background/jevClient";
import { JEV_ENDPOINT, QUESTION_KEYS } from "../src/shared/questions";

const okBody = (overrides: Record<string, unknown> = {}) => ({
  model: "jev-1.13.0",
  answers: Object.fromEntries(QUESTION_KEYS.map((k, i) => [k, { type: "noul", noul: 0.1 * (i + 1) }])),
  usage: { input_tokens: 512, output_tokens: 20 },
  ...overrides,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("evaluateJev", () => {
  it("公式形式でリクエストし、noul の確率を読む", async () => {
    const fetchImpl = vi.fn(async () => json(okBody()));
    const r = await evaluateJev({
      apiKey: "key-123",
      model: "jev-1.13.0",
      state: { ad_text: "テスト" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(JEV_ENDPOINT);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer key-123");
    expect(init.credentials).toBe("omit");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("jev-1.13.0");
    expect(body.state).toEqual({ ad_text: "テスト" });
    expect(Object.keys(body.questions).sort()).toEqual([...QUESTION_KEYS].sort());
    for (const q of Object.values(body.questions) as { type: string; instructions: string }[]) {
      expect(q.type).toBe("noul");
      expect(q.instructions.length).toBeGreaterThan(10);
    }

    expect(r.answers.is_ad).toBeCloseTo(0.1);
    expect(r.answers.misleading).toBeCloseTo(0.5);
    expect(r.inputTokens).toBe(512);
    expect(r.model).toBe("jev-1.13.0");
  });

  it.each([
    [401, "auth"],
    [403, "auth"],
    [422, "bad_request"],
    [429, "rate_limit"],
    [529, "overloaded"],
    [500, "server"],
    [503, "server"],
  ])("HTTP %i は %s", async (status, code) => {
    const fetchImpl = async () => json({ error: "x" }, status);
    await expect(
      evaluateJev({ apiKey: "k", model: "m", state: {}, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ code, status });
  });

  it("通信失敗は network", async () => {
    const fetchImpl = async () => {
      throw new TypeError("Failed to fetch");
    };
    await expect(
      evaluateJev({ apiKey: "k", model: "m", state: {}, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ code: "network" });
  });

  it("応答が来なければ timeout", async () => {
    const fetchImpl = (_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    await expect(
      evaluateJev({ apiKey: "k", model: "m", state: {}, timeoutMs: 20, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("JSON でない応答は invalid_response", async () => {
    const fetchImpl = async () => new Response("<html>", { status: 200 });
    await expect(
      evaluateJev({ apiKey: "k", model: "m", state: {}, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("parseResponse", () => {
  it("質問が欠けていたら拒否する", () => {
    const body = okBody();
    delete (body.answers as Record<string, unknown>).scam;
    expect(() => parseResponse(body)).toThrow(JevError);
  });

  it.each([Number.NaN, -0.1, 1.2, "0.5", null])("範囲外・非数値の確率(%s)を拒否する", (value) => {
    const body = okBody();
    (body.answers as Record<string, unknown>).phishing = { type: "noul", noul: value };
    expect(() => parseResponse(body)).toThrow(/phishing/);
  });

  it("型が noul でなければ拒否する", () => {
    const body = okBody();
    (body.answers as Record<string, unknown>).is_ad = { type: "choice", choice: "yes" };
    expect(() => parseResponse(body)).toThrow(JevError);
  });

  it("usage がなくても読める", () => {
    const r = parseResponse(okBody({ usage: undefined }));
    expect(r.inputTokens).toBeNull();
  });
});
