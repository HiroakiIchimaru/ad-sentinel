import { mountPopup } from "./view";

const root = document.getElementById("app");
if (root) {
  mountPopup(root, {
    async getActiveTabId() {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab?.id ?? null;
    },
    send: (msg) => chrome.runtime.sendMessage(msg),
    async sendToTab(tabId, msg) {
      await chrome.tabs.sendMessage(tabId, msg).catch(() => {});
    },
    async requestReport(tabId) {
      await chrome.tabs.sendMessage(tabId, { type: "requestReport" }).catch(() => {});
      // 各フレームの報告が background に届くのを少し待つ
      await new Promise((r) => setTimeout(r, 150));
    },
    openOptions: () => void chrome.runtime.openOptionsPage(),
  });
}
