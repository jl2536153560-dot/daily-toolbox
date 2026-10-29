import type { PageStatus, SelectorDiagnostics, SortMode } from "../shared/types";
import { COLLECTION_LIMITS, DEFAULT_PREFERENCES, type CollectionPreferences } from "./collection";
import arrowsClockwiseIcon from "@phosphor-icons/core/regular/arrows-clockwise.svg";
import copyIcon from "@phosphor-icons/core/regular/copy.svg";
import downloadSimpleIcon from "@phosphor-icons/core/regular/download-simple.svg";
import stopCircleIcon from "@phosphor-icons/core/regular/stop-circle.svg";

const TOOLBAR_HOST_ID = "xl-comment-toolbar";
interface StickyToolbarCallbacks {
  onSort: (mode: SortMode) => void; onRefresh: () => void; onExportCurrent: () => void;
  onExportTop: () => void; onCollect: () => void; onCollectAndExport: () => void;
  onCancelCollection: () => void; onCopyDiagnostics: () => void;
  onPreferences: (preferences: CollectionPreferences) => void;
}
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
}
function button(label: string, className: string, handler: () => void, svg?: string): HTMLButtonElement {
  const node = el("button", className); node.type = "button"; node.title = label; node.setAttribute("aria-label", label);
  if (svg) { const icon = el("span", "icon"); icon.innerHTML = svg.trim(); icon.setAttribute("aria-hidden", "true"); node.append(icon); }
  node.append(el("span", "label", label)); node.addEventListener("click", handler); return node;
}
const CSS = `
:host{display:block;width:100%;color:#24231f;font:13px/1.5 "Microsoft YaHei","PingFang SC",system-ui,sans-serif}
*{box-sizing:border-box}button,select,input{font:inherit}button{cursor:pointer}button:disabled,select:disabled{opacity:.45;cursor:not-allowed}[hidden]{display:none!important}
.content{position:relative;background:#f5f2e9;border:1px solid #292821;border-radius:3px;box-shadow:3px 4px 0 #26251c26;padding:14px;background-image:radial-gradient(#a19a8015 .5px,transparent .5px);background-size:5px 5px}
.masthead{display:flex;align-items:center;justify-content:space-between;gap:10px;padding-bottom:10px;border-bottom:1px solid #25241c;margin-bottom:12px}
.brand{font-weight:900;font-size:19px;letter-spacing:-.7px;white-space:nowrap}.brand em{font-style:normal;color:#f34b30}.edition{font:9px/1.4 ui-monospace,monospace;letter-spacing:1px;text-align:right;white-space:pre-line}.badge{background:#ffe83b;transform:rotate(-4deg);font-size:11px;font-weight:800;padding:2px 7px;border:1px solid #292821;white-space:nowrap}
.bar{display:flex;gap:5px;align-items:center;flex-wrap:wrap}button{display:inline-flex;justify-content:center;align-items:center;gap:5px;min-height:34px;padding:6px 10px;border:1px solid #bdb8aa;border-radius:2px;background:#faf8f0;color:#24231f;white-space:nowrap;font-size:12px;transition:background .12s,transform .12s}button:hover{background:#ffe83b;border-color:#292821}button:active{transform:translateY(1px)}button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid #f34b30;outline-offset:2px}
.sort{flex:1}.sort.active{background:#25241f;color:#fff;border-color:#25241f}.refresh{padding:6px 8px}.refresh .label{display:none}.icon{display:inline-flex;width:16px;height:16px;flex:none}.icon svg{width:100%;height:100%}
.collect-row{display:flex;align-items:center;gap:7px;margin-top:9px;flex-wrap:wrap}.target-label{font-size:11px;color:#676254;display:flex;align-items:center;gap:5px}select{max-width:104px;min-height:35px;border:1px solid #bdb8aa;background:#fffdf7;color:#292821;border-radius:2px;padding:4px}.collect{background:#f34b30;color:white;border-color:#cf3c26;font-weight:700;flex:1}.collect:hover{background:#db3c23;color:white}.stop{background:#ffe83b;border-color:#292821;flex:1;font-weight:700}
.export-wrap{position:relative}.export-toggle{min-height:35px}.export-menu{position:absolute;right:0;top:calc(100% + 6px);background:#faf8f0;border:1px solid #292821;padding:5px;min-width:245px;z-index:9;box-shadow:3px 4px 0 #29282135;display:grid;gap:4px}.export-menu button{justify-content:flex-start;width:100%;border:0;padding:10px;font-size:12px;white-space:normal;text-align:left}
.options-row{display:flex;justify-content:space-between;gap:8px;align-items:center;margin-top:10px}.auto{display:flex;align-items:center;gap:5px;font-size:11px;color:#5b574d;cursor:pointer}.auto input{accent-color:#f34b30;width:14px;height:14px;margin:0}.count{font:700 13px ui-monospace,monospace;color:#f34b30}.count small{font-weight:400;color:#756f61}
progress{display:block;width:100%;height:5px;margin-top:10px;border:0;border-radius:0;accent-color:#f34b30}progress::-webkit-progress-bar{background:#ded9ca}progress::-webkit-progress-value{background:#f34b30}
.status-row{display:flex;gap:6px;align-items:center;margin-top:8px}.status{font-size:11px;color:#6b6556;overflow-wrap:anywhere;flex:1}.status.error{color:#ad3021}.diagnostics{font-size:10px;min-height:26px;padding:3px 5px}.footnote{font-size:9px;letter-spacing:.3px;color:#928a78;margin-top:6px}.pulse{animation:pulse .7s ease}@keyframes pulse{50%{box-shadow:0 0 0 5px #ffe83b88}}@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;
export class StickyCommentToolbar {
  private host: HTMLElement | null = null; private shadow: ShadowRoot | null = null; private container: Element | null = null;
  private mode: SortMode = "original"; private count = 0; private message = "打开评论区后，点击自动采集。";
  private error = false; private collecting = false; private menuOpen = false; private preferences = { ...DEFAULT_PREFERENCES };
  constructor(private readonly callbacks: StickyToolbarCallbacks) {}
  mount(container: Element, anchor: Element | null): void {
    if (this.host?.isConnected && this.container === container) return;
    this.unmount(); this.container = container; document.getElementById(TOOLBAR_HOST_ID)?.remove();
    this.host = el("div"); this.host.id = TOOLBAR_HOST_ID; this.host.dataset.xlUi = "toolbar";
    // Keep the toolbar inside the scroll area, including when its header is a direct child.
    if (anchor?.parentElement === container) anchor.insertAdjacentElement("afterend", this.host);
    else container.prepend(this.host);
    this.shadow = this.host.attachShadow({ mode: "open" }); const style = el("style"); style.textContent = CSS; this.shadow.append(style); this.render();
  }
  update(mode: SortMode, count: number, message: string, isError = false): void { this.mode = mode; this.count = count; this.message = message; this.error = isError; this.menuOpen = false; this.render(); }
  updateCount(count: number): void { if (this.count === count) return; this.count = count; this.render(); }
  setPreferences(value: CollectionPreferences): void { this.preferences = { ...value }; this.render(); }
  setCollectionState(collecting: boolean, count: number, message: string): void { this.collecting = collecting; this.count = count; this.message = message; this.error = false; this.menuOpen = false; this.render(); }
  showError(status: PageStatus, diagnostics: SelectorDiagnostics | null): void { this.update(this.mode, this.count, status.message + (diagnostics?.candidateNodeCount ? ` 发现 ${diagnostics.candidateNodeCount} 个候选节点。` : ""), true); }
  reveal(): void { this.host?.scrollIntoView({ behavior: "smooth", block: "nearest" }); this.shadow?.querySelector(".content")?.classList.add("pulse"); }
  unmount(): void { this.host?.remove(); this.host = null; this.shadow = null; this.container = null; }
  destroy(): void { this.unmount(); }
  private render(): void {
    if (!this.shadow) return;
    this.shadow.querySelector(".content")?.remove();
    const content = el("section", "content"); content.setAttribute("aria-label", "小乐收集评论助手");
    const head = el("div", "masthead"); const brand = el("div", "brand", "小乐收集 "); brand.append(el("em", "", "/")); head.append(brand, el("span", "badge", "评论助手"), el("span", "edition", "COLLECT\nNO. 02"));
    const bar = el("div", "bar"); bar.setAttribute("role", "group"); bar.setAttribute("aria-label", "排序方式");
    for (const [mode, label] of [["original", "页面顺序"], ["likes", "点赞最多"], ["replies", "回复最多"]] as const) { const b = button(label, `sort${mode === this.mode ? " active" : ""}`, () => this.callbacks.onSort(mode)); b.setAttribute("aria-pressed", String(mode === this.mode)); b.disabled = this.collecting; bar.append(b); }
    const refresh = button("刷新并重排", "refresh", this.callbacks.onRefresh, arrowsClockwiseIcon); refresh.disabled = this.collecting; bar.append(refresh);
    const row = el("div", "collect-row"); const label = el("label", "target-label", "目标"); const select = el("select"); select.setAttribute("aria-label", "采集目标数量");
    for (const limit of COLLECTION_LIMITS) { const option = el("option", "", limit === 100000 ? "采集到底" : `${limit} 条`); option.title = limit === 100000 ? '采集到底，最多100000条' : `${limit} 条`; option.value = String(limit); option.selected = limit === this.preferences.target; select.append(option); }
    select.disabled = this.collecting; select.addEventListener("change", () => this.callbacks.onPreferences({ ...this.preferences, target: Number(select.value) })); label.append(select);
    row.append(label, this.collecting ? button("停止采集", "stop", this.callbacks.onCancelCollection, stopCircleIcon) : button("自动采集", "collect", this.callbacks.onCollect));
    const wrap = el("div", "export-wrap"); const toggle = button("导出", "export-toggle", () => { this.menuOpen = !this.menuOpen; this.render(); }, downloadSimpleIcon); toggle.disabled = this.collecting; toggle.setAttribute("aria-expanded", String(this.menuOpen)); wrap.append(toggle);
    if (this.menuOpen && !this.collecting) { const menu = el("div", "export-menu"); for (const [title, handler] of [["导出已收集的全部主评论 CSV", this.callbacks.onExportCurrent], [`按当前排序导出前 ${this.preferences.target} 条 CSV`, this.callbacks.onExportTop], [`自动采集并导出前 ${this.preferences.target} 条 CSV`, this.callbacks.onCollectAndExport]] as const) { menu.append(button(title, "", () => { this.menuOpen = false; this.render(); handler(); })); } wrap.append(menu); } row.append(wrap);
    const options = el("div", "options-row"); const auto = el("label", "auto"); const check = el("input"); check.type = "checkbox"; check.checked = this.preferences.autoStart; check.addEventListener("change", () => this.callbacks.onPreferences({ ...this.preferences, autoStart: check.checked })); auto.append(check, document.createTextNode("打开评论区后自动采集")); const count = el("span", "count", String(this.count)); count.append(el("small", "", ` / ${this.preferences.target}`)); options.append(auto, count);
    const progress = el("progress"); progress.max = this.preferences.target; progress.value = Math.min(this.count, this.preferences.target); progress.setAttribute("aria-label", `已收集 ${this.count} 条，目标 ${this.preferences.target} 条`);
    const status = el("div", "status-row"); const text = el("span", `status${this.error ? " error" : ""}`, this.message); text.setAttribute("role", "status"); status.append(text); status.append(button("复制诊断", "diagnostics", this.callbacks.onCopyDiagnostics, copyIcon));
    content.append(head, bar, row, options, progress, status, el("div", "footnote", "仅收集网页实际加载的文字主评论 · 已过滤纯表情 · 不含楼中楼")); this.shadow.append(content);
  }
}
