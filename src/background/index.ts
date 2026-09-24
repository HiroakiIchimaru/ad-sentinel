import { API_KEY_KEY, normalizeSettings, SETTINGS_KEY } from "../shared/settings";
import type { RuntimeMessage } from "../shared/types";
import { AnswerCache } from "./cache";
import { Classifier } from "./classifier";
import { createHandler } from "./handlers";
import { evaluateJev } from "./jevClient";
import type { KV } from "./kv";
import { blockedCount, TabStore } from "./tabStore";
import { UsageTracker } from "./usage";

// APIキーを置く local 領域は拡張機能内(background/popup/options)だけに公開する。
// 設定は sync、判定一覧は session に置き、content script からは local を読ませない。
void chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});

const local = chrome.storage.local as unknown as KV;
const session = chrome.storage.session as unknown as KV;

let config: Promise<{ apiKey: string; model: string }> | null = null;
function getConfig(): Promise<{ apiKey: string; model: string }> {
  config ??= Promise.all([chrome.storage.local.get(API_KEY_KEY), chrome.storage.sync.get(SETTINGS_KEY)]).then(
    ([l, s]) => ({
      apiKey: typeof l[API_KEY_KEY] === "string" ? (l[API_KEY_KEY] as string).trim() : "",
      model: normalizeSettings(s[SETTINGS_KEY]).model,
    }),
  );
  return config;
}

const cache = new AnswerCache(local);
const usage = new UsageTracker(local);
const classifier = new Classifier({
  cache,
  usage,
  getConfig,
  evaluate: evaluateJev,
  demoDelay: () => new Promise((r) => setTimeout(r, 60 + Math.random() * 90)),
});
const tabs = new TabStore(session, (tabId, state) => {
  const n = blockedCount(state);
  void chrome.action.setBadgeText({ tabId, text: n > 0 ? String(n) : "" }).catch(() => {});
});
const handle = createHandler({ classifier, tabs, usage, cache, getConfig });

void chrome.action.setBadgeBackgroundColor({ color: "#c2410c" });
void chrome.action.setBadgeTextColor?.({ color: "#ffffff" });

chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === "local" && API_KEY_KEY in changes) || (area === "sync" && SETTINGS_KEY in changes)) {
    config = null;
    if (area === "local") classifier.resetErrors();
  }
});

/** content script に許すのは判定依頼と状態報告だけ。一覧の取得や設定系は拡張機能のページから */
const CONTENT_ALLOWED = new Set<RuntimeMessage["type"]>(["classify", "frameReport"]);

chrome.runtime.onMessage.addListener((msg: RuntimeMessage, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg || typeof msg !== "object") return false;
  const fromExtensionPage = (sender.url ?? "").startsWith(chrome.runtime.getURL(""));
  if (!fromExtensionPage && !CONTENT_ALLOWED.has(msg.type)) return false;

  handle(msg, { tabId: sender.tab?.id, frameId: sender.frameId, url: sender.url }).then(sendResponse, (err) =>
    sendResponse({ ok: false, error: String(err) }),
  );
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== "loading") return;
  tabs.reset(tabId);
  // 同一ドキュメント内の遷移(SPA)では content script が残っているので、状態を送り直してもらう
  setTimeout(() => {
    void chrome.tabs.sendMessage(tabId, { type: "requestReport" }).catch(() => {});
  }, 1500);
});

chrome.tabs.onRemoved.addListener((tabId) => tabs.remove(tabId));

// キャッシュの掃除(期限切れ・上限超過の削除)。ブラウザを長期間閉じない使い方でも
// 溜まり続けないよう、起動時だけでなく 1 日 1 回も行う
const PRUNE_ALARM = "prune-cache";

chrome.runtime.onInstalled.addListener((details) => {
  void cache.prune();
  void chrome.alarms.create(PRUNE_ALARM, { periodInMinutes: 24 * 60 });
  if (details.reason === "install") void chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(() => {
  void cache.prune();
  void chrome.alarms.create(PRUNE_ALARM, { periodInMinutes: 24 * 60 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PRUNE_ALARM) void cache.prune();
});
