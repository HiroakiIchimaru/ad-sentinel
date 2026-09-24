import { CONTACT_URL, PRODUCT_NAME } from "../shared/branding";
import { CATEGORY_LABELS, MARKUP_LABELS, OBSTRUCTION_LABELS, WHERE_LABELS } from "../shared/questions";
import { percent } from "../shared/decide";
import { isSiteDisabled, normalizeSettings, SETTINGS_KEY, siteKey } from "../shared/settings";
import type { DisplayMode, ItemReport, Settings, TabMessage, TabStateResponse } from "../shared/types";

/** 判定の強さのプリセット(遮蔽しきい値 / 注意しきい値) */
export const PRESETS = [
  { id: "low", label: "控えめ", block: 0.85, warn: 0.55 },
  { id: "mid", label: "標準", block: 0.7, warn: 0.4 },
  { id: "high", label: "強め", block: 0.55, warn: 0.3 },
] as const;

const DISPLAY_LABELS: Record<DisplayMode, string> = { blur: "ぼかす", hide: "隠す", label: "ラベルのみ" };

const STATE_LABELS: Record<ItemReport["state"], string> = {
  block: "隠した",
  obstruct: "妨害ブロック",
  revealed: "表示中",
  warn: "注意",
  ok: "問題なし",
  content: "記事と判断",
  pending: "判定中",
  unreadable: "読み取れず",
  error: "判定失敗",
};

const SHIELD =
  '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Zm-1.2 13.6-3.5-3.5 1.4-1.4 2.1 2.1 4.9-4.9 1.4 1.4-6.3 6.3Z"/></svg>';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface PopupDeps {
  getActiveTabId(): Promise<number | null>;
  send(msg: unknown): Promise<unknown>;
  /** 対象タブの全フレームへ送る(番号表示・移動・表示切替) */
  sendToTab(tabId: number, msg: TabMessage): Promise<void>;
  requestReport(tabId: number): Promise<void>;
  openOptions(): void;
}

function statusLine(res: TabStateResponse | null, settings: Settings): { text: string; tone: string } {
  if (!settings.enabled) return { text: "停止中", tone: "muted" };
  switch (res?.apiStatus) {
    case "live":
      return { text: "有効 · jev で判定中", tone: "ok" };
    case "demo":
      return { text: "簡易判定モード(APIキーなし)", tone: "warn" };
    case "auth_error":
      return { text: "APIキーが無効です", tone: "error" };
    case "cooldown":
      return { text: "混雑・通信エラーのため一時停止中", tone: "warn" };
    default:
      return { text: "読み込み中…", tone: "muted" };
  }
}

/** 行の右端に出す操作(隠した広告を見る・戻す) */
function actionOf(item: ItemReport): { label: string; reveal: boolean } | null {
  if (item.state === "block" || item.state === "obstruct") return { label: "表示", reveal: true };
  if (item.state === "revealed") return { label: "隠す", reveal: false };
  return null;
}

function itemRow(item: ItemReport): string {
  const p = item.top?.p ?? 0;
  const judged = item.answers !== null && item.state !== "content";
  const reason = item.obstruction && item.state !== "ok" && item.state !== "warn"
    ? OBSTRUCTION_LABELS[item.obstruction]
    : judged && item.top
      ? `${CATEGORY_LABELS[item.top.category]} ${percent(p)}`
      : "";
  const meta = [
    WHERE_LABELS[item.where],
    item.domain ?? "",
    item.obstruction === "autoplay" && item.state !== "obstruct" ? "自動再生を停止" : "",
    ...item.markup.map((m) => `HTML: ${MARKUP_LABELS[m]}`),
  ].filter(Boolean);
  const action = actionOf(item);
  return `<li class="item s-${item.state}" data-id="${esc(item.id)}" data-onpage="${item.onPage ? 1 : 0}" tabindex="0"
      title="${item.onPage ? "クリックでページ上のこの広告へ移動" : "ページ上では非表示です"}">
    <span class="num">#${item.n ?? "?"}</span>
    <div class="body">
      <div class="item-head">
        <span class="pill s-${item.state}">${STATE_LABELS[item.state]}</span>
        <span class="reason">${esc(reason)}</span>
        ${item.mock ? '<span class="demo">簡易</span>' : ""}
      </div>
      ${judged && !item.obstruction ? `<div class="bar"><i style="width:${Math.round(p * 100)}%"></i></div>` : ""}
      <div class="excerpt">${item.excerpt ? esc(item.excerpt) : "(文字なし)"}</div>
      <div class="meta">${meta.map((m) => `<span>${esc(m)}</span>`).join("")}${item.onPage ? "" : '<span class="hidden-note">ページ上では非表示</span>'}</div>
    </div>
    ${action ? `<button type="button" class="act" data-reveal="${action.reveal ? 1 : 0}">${action.label}</button>` : ""}
  </li>`;
}

/** popup の画面。chrome API は deps 経由で使う(テストで差し替えるため) */
export function mountPopup(root: HTMLElement, deps: PopupDeps): () => void {
  let settings: Settings = normalizeSettings(undefined);
  let tabId: number | null = null;
  let last: TabStateResponse | null = null;
  let lastHtml = "";
  let focusId: string | null = null;
  let saveError = false;

  const listed = () => (last?.state.items ?? []).filter((i) => i.state !== "pending" && i.n !== undefined).slice(0, 60);

  /** ページ上の広告に番号を重ねる。popup が開いている間だけ(知らせが途切れると消える) */
  const sendMarkers = () => {
    if (tabId === null || !settings.enabled) return;
    const items = listed().map((i) => ({ id: i.id, n: i.n! }));
    void deps.sendToTab(tabId, { type: "markers", items, focus: focusId }).catch(() => {});
  };

  const save = async (patch: Partial<Settings>) => {
    const prev = settings;
    settings = normalizeSettings({ ...settings, ...patch });
    try {
      // sync には容量の上限があり、保存に失敗しうる。失敗したら元の設定に戻して知らせる
      await chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
      saveError = false;
    } catch {
      settings = prev;
      saveError = true;
    }
    draw();
  };

  const draw = () => {
    const host = last?.state.host ?? "";
    const site = host ? siteKey(host) : "";
    const siteOff = host ? isSiteDisabled(host, settings.disabledSites) : false;
    const items = last?.state.items ?? [];
    const count = (...s: ItemReport["state"][]) => items.filter((i) => s.includes(i.state)).length;
    const st = statusLine(last, settings);
    const preset = PRESETS.find((p) => p.block === settings.blockThreshold && p.warn === settings.warnThreshold);
    const usage = last?.usage;
    const rows = listed();
    const pending = count("pending");

    const html = `
      <header class="top">
        <div class="brand"><span class="logo">${SHIELD}</span>
          <div><div class="name">${PRODUCT_NAME}</div><div class="status t-${st.tone}">${esc(st.text)}</div></div>
        </div>
        <label class="switch" title="全体の有効/無効"><input type="checkbox" data-act="enabled" ${settings.enabled ? "checked" : ""}><span></span></label>
      </header>
      <section class="site ${settings.enabled ? "" : "dim"}">
        ${
          host
            ? `<div class="site-row"><span class="host" title="${esc(host)}">${esc(site)}</span>
               <label class="mini-switch"><input type="checkbox" data-act="site" ${siteOff ? "" : "checked"}><span></span>このサイトで有効</label></div>`
            : `<div class="site-row"><span class="host muted">このページでは動作しません</span></div>`
        }
        <div class="tiles">
          <div class="tile t-block"><b>${count("block")}</b><span>隠した</span></div>
          <div class="tile t-block"><b>${count("obstruct")}</b><span>妨害ブロック</span></div>
          <div class="tile t-warn"><b>${count("warn")}</b><span>注意</span></div>
          <div class="tile"><b>${count("ok", "content", "revealed")}</b><span>表示中</span></div>
          <div class="tile t-muted"><b>${count("unreadable", "error")}</b><span>読取不可</span></div>
        </div>
      </section>
      <section class="list ${settings.enabled ? "" : "dim"}">
        <h2>このページの判定 <small>${pending ? `判定中 ${pending}件` : ""}</small></h2>
        ${
          rows.length
            ? `<p class="hint">番号はページ上の広告にも表示しています。行をクリックするとその広告へ移動します。</p><ul>${rows.map(itemRow).join("")}</ul>`
            : `<p class="empty">${host && !siteOff && settings.enabled ? "広告はまだ見つかっていません。画面に近づいた広告から順に判定します。" : "—"}</p>`
        }
      </section>
      <section class="controls ${settings.enabled ? "" : "dim"}">
        <div class="ctl"><span>判定の強さ</span><div class="seg">
          ${PRESETS.map((p) => `<button type="button" data-preset="${p.id}" class="${preset?.id === p.id ? "on" : ""}">${p.label}</button>`).join("")}
        </div></div>
        <div class="ctl"><span>表示方法</span><div class="seg">
          ${(Object.keys(DISPLAY_LABELS) as DisplayMode[])
            .map((d) => `<button type="button" data-display="${d}" class="${settings.display === d ? "on" : ""}">${DISPLAY_LABELS[d]}</button>`)
            .join("")}
        </div></div>
      </section>
      ${saveError ? '<p class="save-error">設定を保存できませんでした。設定画面から無効サイトの数を減らすなどして、やり直してください。</p>' : ""}
      <footer class="foot">
        <span>${
          usage
            ? last?.apiStatus === "demo"
              ? `簡易判定 本日${usage.demoRequests}回`
              : `本日 判定${usage.requests}回 · キャッシュ${usage.cacheHits}回`
            : ""
        }</span>
        <span class="foot-links">
          <a class="link" href="${esc(CONTACT_URL)}" target="_blank" rel="noopener" title="不具合・誤判定の報告(X)">連絡先</a>
          <button type="button" class="link" data-act="options">設定</button>
        </span>
      </footer>`;

    if (html !== lastHtml) {
      // 一覧のスクロール位置を保つ
      const scroll = root.querySelector(".list ul")?.scrollTop ?? 0;
      root.innerHTML = html;
      const ul = root.querySelector(".list ul");
      if (ul) ul.scrollTop = scroll;
      lastHtml = html;
    }
  };

  root.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const preset = t.closest<HTMLElement>("[data-preset]")?.dataset.preset;
    const display = t.closest<HTMLElement>("[data-display]")?.dataset.display as DisplayMode | undefined;
    const row = t.closest<HTMLElement>("li.item");
    const act = t.closest<HTMLElement>("button.act");
    if (preset) {
      const p = PRESETS.find((x) => x.id === preset);
      if (p) void save({ blockThreshold: p.block, warnThreshold: p.warn });
    } else if (display) {
      void save({ display });
    } else if (act && row && tabId !== null) {
      void deps.sendToTab(tabId, { type: "reveal", id: row.dataset.id!, reveal: act.dataset.reveal === "1" });
      setTimeout(refresh, 300);
    } else if (row && tabId !== null) {
      if (row.dataset.onpage === "1") void deps.sendToTab(tabId, { type: "locate", id: row.dataset.id! });
    } else if (t.closest('[data-act="options"]')) {
      deps.openOptions();
    }
  });

  root.addEventListener("keydown", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("li.item");
    if (row && (e.key === "Enter" || e.key === " ") && tabId !== null && row.dataset.onpage === "1") {
      e.preventDefault();
      void deps.sendToTab(tabId, { type: "locate", id: row.dataset.id! });
    }
  });

  // 行にマウスを乗せる・フォーカスすると、ページ上の同じ番号の広告を強調する
  const setFocus = (id: string | null) => {
    if (id === focusId) return;
    focusId = id;
    sendMarkers();
  };
  root.addEventListener("mouseover", (e) => setFocus((e.target as HTMLElement).closest<HTMLElement>("li.item")?.dataset.id ?? null));
  root.addEventListener("mouseleave", () => setFocus(null));
  root.addEventListener("focusin", (e) => setFocus((e.target as HTMLElement).closest<HTMLElement>("li.item")?.dataset.id ?? null));

  root.addEventListener("change", (e) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset.act === "enabled") void save({ enabled: t.checked });
    if (t.dataset.act === "site" && last?.state.host) {
      const site = siteKey(last.state.host);
      const rest = settings.disabledSites.filter((s) => s !== site && !isSiteDisabled(last!.state.host, [s]));
      void save({ disabledSites: t.checked ? rest : [...rest, site] });
    }
  });

  async function refresh(): Promise<void> {
    if (tabId === null) return;
    try {
      last = (await deps.send({ type: "getTabState", tabId })) as TabStateResponse;
    } catch {
      last = null;
    }
    draw();
    sendMarkers();
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  void (async () => {
    const stored = await chrome.storage.sync.get(SETTINGS_KEY);
    settings = normalizeSettings(stored[SETTINGS_KEY]);
    tabId = await deps.getActiveTabId();
    draw();
    if (tabId !== null) {
      await deps.requestReport(tabId).catch(() => {});
      await refresh();
      timer = setInterval(refresh, 1000);
    }
  })();

  const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === "sync" && SETTINGS_KEY in changes) {
      settings = normalizeSettings(changes[SETTINGS_KEY]!.newValue);
      draw();
    }
  };
  chrome.storage.onChanged.addListener(onChanged);

  return () => {
    if (timer) clearInterval(timer);
    chrome.storage.onChanged.removeListener(onChanged);
  };
}
