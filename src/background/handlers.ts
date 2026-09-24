import { buildState } from "../shared/questions";
import type {
  ClassifyResponse,
  RuntimeMessage,
  TabStateResponse,
  TestConnectionResponse,
  Usage,
} from "../shared/types";
import type { AnswerCache } from "./cache";
import type { Classifier } from "./classifier";
import { evaluateJev, JevError } from "./jevClient";
import type { TabStore } from "./tabStore";
import type { UsageTracker } from "./usage";

export interface Sender {
  tabId?: number;
  frameId?: number;
  url?: string;
}

export interface HandlerDeps {
  classifier: Classifier;
  tabs: TabStore;
  usage: UsageTracker;
  cache: AnswerCache;
  evaluate?: typeof evaluateJev;
  /** 保存済みのキーと既定モデル。接続テストで入力が空欄のときのフォールバック */
  getConfig?: () => Promise<{ apiKey: string; model: string }>;
}

/** 接続テストに使う固定の偽警告広告 */
export const TEST_AD_TEXT =
  "【警告】お使いのスマートフォンがウイルスに感染しています(4件検出)。今すぐ無料アプリをインストールして修復してください。";

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** background のメッセージ処理(テストでは依存を差し替える) */
export function createHandler(deps: HandlerDeps) {
  const evaluate = deps.evaluate ?? evaluateJev;

  return async function handle(msg: RuntimeMessage, sender: Sender): Promise<unknown> {
    switch (msg.type) {
      case "classify": {
        const res: ClassifyResponse = await deps.classifier.classify(msg.text, msg.landing, msg.markup);
        return res;
      }
      case "frameReport": {
        if (sender.tabId === undefined || sender.tabId < 0) return { ok: false };
        const isTop = msg.isTop === true;
        // items の中身の検証は tabStore.report(sanitizeItems)が行う
        await deps.tabs.report(sender.tabId, sender.frameId ?? 0, isTop, isTop ? hostOf(sender.url) : null, msg.items);
        return { ok: true };
      }
      case "getTabState": {
        const res: TabStateResponse = {
          state: await deps.tabs.get(msg.tabId),
          apiStatus: await deps.classifier.status(),
          usage: await deps.usage.get(),
        };
        return res;
      }
      case "getUsage": {
        const usage: Usage = await deps.usage.get();
        return usage;
      }
      case "testConnection": {
        // 入力が空欄なら、保存済みのキーを試す
        const apiKey = msg.apiKey || (deps.getConfig ? (await deps.getConfig()).apiKey : "");
        if (!apiKey) return { ok: false, error: "APIキーを入力してください" } satisfies TestConnectionResponse;
        try {
          const r = await evaluate({
            apiKey,
            model: msg.model,
            state: buildState(TEST_AD_TEXT, [], []),
            timeoutMs: 8000,
          });
          deps.classifier.resetErrors();
          return { ok: true, ms: r.ms, model: r.model || msg.model, answers: r.answers } satisfies TestConnectionResponse;
        } catch (err) {
          const error = err instanceof JevError ? err.message : String(err);
          return { ok: false, error } satisfies TestConnectionResponse;
        }
      }
      case "clearCache": {
        await deps.cache.clear();
        return { ok: true };
      }
      default:
        return { ok: false, error: "unknown message" };
    }
  };
}
