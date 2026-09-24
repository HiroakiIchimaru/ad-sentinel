import { CONTACT_HANDLE, CONTACT_URL } from "../shared/branding";
import { percent } from "../shared/decide";
import {
  CATEGORY_DESCRIPTIONS,
  CATEGORY_LABELS,
  OBSTRUCTION_DESCRIPTIONS,
  OBSTRUCTION_LABELS,
  USD_PER_INPUT_TOKEN,
} from "../shared/questions";
import { API_KEY_KEY, normalizeHost, normalizeSettings, SETTINGS_KEY } from "../shared/settings";
import { OBSTRUCTION_KINDS, RISK_CATEGORIES } from "../shared/types";
import type { DisplayMode, Settings, TestConnectionResponse, Usage } from "../shared/types";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** innerHTML に埋め込む外部由来の文字列(API 応答など)のエスケープ */
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

let settings: Settings = normalizeSettings(undefined);
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function toast(text: string): void {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1600);
}

async function save(patch: Partial<Settings>, message = "保存しました"): Promise<void> {
  const next = normalizeSettings({ ...settings, ...patch });
  try {
    // sync には容量の上限(項目あたり約8KB)があり、無効サイトが多いと失敗しうる
    await chrome.storage.sync.set({ [SETTINGS_KEY]: next });
  } catch (err) {
    fill();
    toast(`保存できませんでした: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  settings = next;
  fill();
  toast(message);
}

function showResult(kind: "ok" | "error" | "info", html: string): void {
  const el = $("apiResult");
  el.hidden = false;
  el.className = `result ${kind}`;
  el.innerHTML = html;
}

function fill(): void {
  $<HTMLInputElement>("model").value = settings.model;
  $<HTMLInputElement>("blockThreshold").value = String(settings.blockThreshold);
  $<HTMLInputElement>("warnThreshold").value = String(settings.warnThreshold);
  $("blockOut").textContent = percent(settings.blockThreshold);
  $("warnOut").textContent = percent(settings.warnThreshold);
  for (const c of RISK_CATEGORIES) {
    const input = document.querySelector<HTMLInputElement>(`input[data-category="${c}"]`);
    if (input) input.checked = settings.categories[c];
  }
  for (const k of OBSTRUCTION_KINDS) {
    const input = document.querySelector<HTMLInputElement>(`input[data-obstruction="${k}"]`);
    if (input) input.checked = settings.obstruction[k];
  }
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="display"]')) {
    r.checked = r.value === settings.display;
  }
  $<HTMLInputElement>("pendingBlur").checked = settings.pendingBlur;
  $<HTMLInputElement>("showWarnBadge").checked = settings.showWarnBadge;
  const ta = $<HTMLTextAreaElement>("disabledSites");
  if (document.activeElement !== ta) ta.value = settings.disabledSites.join("\n");
}

async function loadUsage(): Promise<void> {
  const u = (await chrome.runtime.sendMessage({ type: "getUsage" })) as Usage | undefined;
  if (!u) return;
  const usd = u.inputTokens * USD_PER_INPUT_TOKEN;
  $("usage").textContent =
    `本日(${u.date}): jev ${u.requests}回 · 入力 ${u.inputTokens.toLocaleString()} トークン · 約 $${usd.toFixed(5)}` +
    ` · キャッシュ利用 ${u.cacheHits}回 · エラー ${u.errors}回 · 簡易判定 ${u.demoRequests}回`;
}

function buildCategories(): void {
  $("categories").innerHTML = RISK_CATEGORIES.map(
    (c) => `<label class="check"><input type="checkbox" data-category="${c}" />
      <span><b>${CATEGORY_LABELS[c]}</b><small>${CATEGORY_DESCRIPTIONS[c]}</small></span></label>`,
  ).join("");
  $("obstructionKinds").innerHTML = OBSTRUCTION_KINDS.map(
    (k) => `<label class="check"><input type="checkbox" data-obstruction="${k}" />
      <span><b>${OBSTRUCTION_LABELS[k]}</b><small>${OBSTRUCTION_DESCRIPTIONS[k]}</small></span></label>`,
  ).join("");
}

async function init(): Promise<void> {
  $("version").textContent = chrome.runtime.getManifest().version;
  buildCategories();

  // 連絡先は branding.ts を唯一の情報源にする
  const contact = $<HTMLAnchorElement>("contactLink");
  contact.href = CONTACT_URL;
  contact.textContent = CONTACT_HANDLE;

  const [s, l] = await Promise.all([chrome.storage.sync.get(SETTINGS_KEY), chrome.storage.local.get(API_KEY_KEY)]);
  settings = normalizeSettings(s[SETTINGS_KEY]);
  const key = typeof l[API_KEY_KEY] === "string" ? (l[API_KEY_KEY] as string) : "";
  $<HTMLInputElement>("apiKey").value = key;
  fill();
  if (!key) showResult("info", "APIキーが未設定のため、<b>簡易判定</b>(固定キーワードの照合)で動作しています。");
  void loadUsage();

  $("toggleKey").addEventListener("click", () => {
    const input = $<HTMLInputElement>("apiKey");
    input.type = input.type === "password" ? "text" : "password";
    $("toggleKey").textContent = input.type === "password" ? "表示" : "隠す";
  });

  $("saveKey").addEventListener("click", async () => {
    const apiKey = $<HTMLInputElement>("apiKey").value.trim();
    await chrome.storage.local.set({ [API_KEY_KEY]: apiKey });
    await save({ model: $<HTMLInputElement>("model").value }, apiKey ? "APIキーを保存しました" : "保存しました");
    if (apiKey) showResult("info", "保存しました。「接続テスト」で動作を確認できます。");
  });

  $("clearKey").addEventListener("click", async () => {
    await chrome.storage.local.remove(API_KEY_KEY);
    $<HTMLInputElement>("apiKey").value = "";
    showResult("info", "APIキーを削除しました。簡易判定に戻ります。");
    toast("APIキーを削除しました");
  });

  $("testKey").addEventListener("click", async () => {
    const apiKey = $<HTMLInputElement>("apiKey").value.trim();
    const model = $<HTMLInputElement>("model").value.trim() || settings.model;
    showResult("info", "テスト用の偽警告広告を jev に送信しています…");
    const res = (await chrome.runtime.sendMessage({ type: "testConnection", apiKey, model })) as TestConnectionResponse;
    if (res.ok) {
      const rows = RISK_CATEGORIES.map((c) => `${CATEGORY_LABELS[c]} ${percent(res.answers[c])}`).join(" / ");
      showResult(
        "ok",
        `接続できました(${res.ms}ms · ${esc(res.model)})。<br>テスト広告の判定: 広告らしさ ${percent(res.answers.is_ad)} / ${rows}`,
      );
    } else {
      showResult("error", `接続できませんでした: ${esc(res.error)}`);
    }
  });

  const slider = (id: "blockThreshold" | "warnThreshold") => {
    const input = $<HTMLInputElement>(id);
    input.addEventListener("input", () => {
      $(id === "blockThreshold" ? "blockOut" : "warnOut").textContent = percent(Number(input.value));
    });
    input.addEventListener("change", () => void save({ [id]: Number(input.value) }));
  };
  slider("blockThreshold");
  slider("warnThreshold");

  $("categories").addEventListener("change", (e) => {
    const t = e.target as HTMLInputElement;
    const c = t.dataset.category as (typeof RISK_CATEGORIES)[number] | undefined;
    if (c) void save({ categories: { ...settings.categories, [c]: t.checked } });
  });

  $("obstructionKinds").addEventListener("change", (e) => {
    const t = e.target as HTMLInputElement;
    const k = t.dataset.obstruction as (typeof OBSTRUCTION_KINDS)[number] | undefined;
    if (k) void save({ obstruction: { ...settings.obstruction, [k]: t.checked } });
  });

  $("displayModes").addEventListener("change", (e) => {
    const t = e.target as HTMLInputElement;
    if (t.name === "display") void save({ display: t.value as DisplayMode });
  });

  $("pendingBlur").addEventListener("change", (e) => void save({ pendingBlur: (e.target as HTMLInputElement).checked }));
  $("showWarnBadge").addEventListener("change", (e) =>
    void save({ showWarnBadge: (e.target as HTMLInputElement).checked }),
  );

  $("disabledSites").addEventListener("change", (e) => {
    const lines = (e.target as HTMLTextAreaElement).value.split(/\r?\n/);
    const invalid = lines.filter((l) => l.trim() && normalizeHost(l) === null);
    void save({ disabledSites: lines }, invalid.length ? `無効な行を除外しました: ${invalid.join(", ")}` : "保存しました");
  });

  $("clearCache").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "clearCache" });
    toast("キャッシュを削除しました");
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && SETTINGS_KEY in changes) {
      settings = normalizeSettings(changes[SETTINGS_KEY]!.newValue);
      fill();
    }
  });
}

void init();
