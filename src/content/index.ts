import { isSiteDisabled, normalizeSettings, SETTINGS_KEY } from "../shared/settings";
import type { RuntimeMessage, Settings, TabMessage } from "../shared/types";
import { isAdFrame } from "./detect";
import { STATE_ATTR } from "./overlay";
import { PREBLUR_ATTR, Sentinel } from "./sentinel";

/** 子フレームでも「どのサイトを見ているか」で無効サイト判定をする(ancestorOrigins の最上位) */
function topHost(): string {
  if (window.top === window) return location.hostname;
  const ao = location.ancestorOrigins;
  if (ao && ao.length > 0) {
    try {
      return new URL(ao[ao.length - 1]!).hostname;
    } catch {
      // 取れなければ自フレームのホストで代用
    }
  }
  return location.hostname;
}

/**
 * 拡張機能が再読み込み・更新・削除されると、すでに開いているタブの content script は
 * 拡張機能との接続を失い、sendMessage が同期的に "Extension context invalidated" を投げる。
 */
function contextAlive(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

let onContextLost: () => void = () => {};

function send(msg: RuntimeMessage): Promise<unknown> {
  if (!contextAlive()) {
    onContextLost();
    return Promise.reject(new Error("extension context invalidated"));
  }
  try {
    return chrome.runtime.sendMessage(msg);
  } catch (err) {
    onContextLost();
    return Promise.reject(err);
  }
}

/**
 * document_start で動く。HTML が DOM に組み立てられる最中から広告枠を捕まえるため、
 * 設定の読み込みを待たずに「判定前ぼかし」を先に有効にしておき、無効サイトなら後で外す。
 */
async function main(): Promise<void> {
  // HTML 以外(XML・SVG 文書など)や、すでに動いている場合は何もしない
  const html = document.documentElement;
  if (!(html instanceof HTMLElement)) return;
  const w = window as unknown as { __adSentinel?: boolean };
  if (w.__adSentinel) return;
  w.__adSentinel = true;

  const isTop = window.top === window;
  const adFrame = isAdFrame(isTop, location.hostname, window.name);
  html.setAttribute(PREBLUR_ATTR, "");
  // 広告フレームは中身が描かれる前から全体をぼかしておく
  if (adFrame) html.setAttribute(STATE_ATTR, "pending");

  const host = topHost();
  const stored = await chrome.storage.sync.get(SETTINGS_KEY).catch(() => ({}) as Record<string, unknown>);
  let settings: Settings = normalizeSettings((stored as Record<string, unknown>)[SETTINGS_KEY]);

  const sentinel = new Sentinel({ doc: document, isTop, send, settings });
  // 接続を失ったら、監視とタイマーだけを止めて静かに終わる(隠した広告はページを再読み込みするまでそのまま)
  onContextLost = () => sentinel.halt();
  const active = (s: Settings) => s.enabled && !isSiteDisabled(host, s.disabledSites);
  if (active(settings)) {
    sentinel.start();
  } else {
    html.removeAttribute(PREBLUR_ATTR);
    if (adFrame) html.removeAttribute(STATE_ATTR);
    if (isTop) sentinel.report(true);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !(SETTINGS_KEY in changes)) return;
    settings = normalizeSettings(changes[SETTINGS_KEY]!.newValue);
    if (!active(settings)) {
      sentinel.stop();
    } else if (!sentinel.isRunning) {
      sentinel.updateSettings(settings);
      sentinel.start();
    } else {
      sentinel.updateSettings(settings);
    }
  });

  chrome.runtime.onMessage.addListener((msg: TabMessage) => {
    if (msg && typeof msg === "object" && sentinel.isRunning) sentinel.handleTabMessage(msg);
    else if (msg?.type === "requestReport") sentinel.report(true);
    return false;
  });

  // iframe が消えるときは、そのフレームの一覧を空にしておく
  if (!isTop) addEventListener("pagehide", () => (contextAlive() ? sentinel.stop() : sentinel.halt()));
}

void main();
