// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findCommentScroller, getCommentLoadState } from "../src/adapters/douyin/detector";

function geometry(element: HTMLElement, { height = 800, client = 200, top = 600 } = {}): void {
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: height },
    clientHeight: { configurable: true, value: client },
    scrollTop: { configurable: true, writable: true, value: top }
  });
}
function container({ scrollable = true, height = 800, client = 200, top = 600 } = {}): HTMLElement {
  const section = document.createElement("section"); section.dataset.e2e = "comment-list";
  section.style.overflowY = scrollable ? "auto" : "visible";
  geometry(section, { height, client, top }); document.body.append(section);
  return section;
}
function comment(markup = '<p data-e2e="comment-level-1">测试评论</p>'): HTMLElement {
  const row = document.createElement("div"); row.dataset.e2e = "comment-item";
  row.innerHTML = '<a href="/user/author">作者</a>' + markup;
  return row;
}
function footer(text = "没有更多评论"): HTMLElement {
  const node = document.createElement("div"); node.className = "comment-end"; node.textContent = text;
  return node;
}

describe("comment loading/end evidence", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    geometry(document.documentElement,{height:0,client:0,top:0});
    (window as unknown as {happyDOM:{setURL:(url:string)=>void}}).happyDOM.setURL("https://www.douyin.com/video/123456");
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) {
      for (let node: HTMLElement | null = this; node; node = node.parentElement) {
        if (node.hidden || node.style.display === "none" || node.style.visibility === "hidden") return [] as unknown as DOMRectList;
      }
      return [new DOMRect(0, 0, 300, 40)] as unknown as DOMRectList;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 300, 40));
  });
  afterEach(() => vi.restoreAllMocks());

  it("reports a missing comment region as temporarily unavailable", () => {
    expect(getCommentLoadState()).toEqual({available:false,loading:false,atEnd:false,atBottom:false});
  });
  it("reads the replacement region instead of retaining a detached scroller", () => {
    const first = container(); first.append(comment());
    expect(getCommentLoadState().position).toBe(600);
    first.remove(); const replacement = container({height:1200,top:100}); replacement.append(comment());
    expect(getCommentLoadState()).toMatchObject({available:true,position:100,extent:1200,atBottom:false});
  });
  it("ignores a hidden old container when the refreshed visible container has the same selector", () => {
    const old = container(); old.style.display = "none"; old.append(comment(),footer());
    const refreshed = container({top:100}); refreshed.append(comment());
    expect(getCommentLoadState()).toMatchObject({available:true,atEnd:false,position:100});
  });
  it("uses the internal scrolling list rather than the outer comment panel", () => {
    const outer = container({scrollable:false,height:1000,client:1000,top:0});
    const inner = document.createElement("div"); inner.style.overflowY = "auto";
    geometry(inner,{height:2400,client:300,top:2100}); inner.append(comment()); outer.append(inner);
    expect(findCommentScroller()).toBe(inner);
    expect(getCommentLoadState()).toMatchObject({available:true,atBottom:true,position:2100,extent:2400});
  });
  it("can scroll the document when the comment list has no internal scroller", () => {
    const outer = container({scrollable:false,height:600,client:600,top:0}); outer.append(comment());
    const page = document.documentElement; geometry(page,{height:3000,client:800,top:2200});
    vi.spyOn(document,"scrollingElement","get").mockReturnValue(page);
    expect(findCommentScroller()).toBe(page);
    expect(getCommentLoadState()).toMatchObject({atBottom:true,position:2200,extent:3000});
  });
  it("recognizes the real comment footer even if recommended content continues lower on the document", () => {
    const outer = container({scrollable:false,height:600,client:600,top:0}); outer.append(comment(),footer());
    const page = document.documentElement; geometry(page,{height:3000,client:800,top:1000});
    vi.spyOn(document,"scrollingElement","get").mockReturnValue(page);
    expect(getCommentLoadState()).toMatchObject({available:true,atEnd:true,atBottom:false});
  });
  it("does not infer completion for a short unscrollable list without a footer", () => {
    const outer = container({scrollable:false,height:100,client:100,top:0}); outer.append(comment());
    expect(getCommentLoadState()).toMatchObject({available:true,atEnd:false,atBottom:false});
  });
  it("recognizes a footer for a small list that never needed scrolling", () => {
    const outer = container({scrollable:false,height:100,client:100,top:0}); outer.append(comment(),footer("已加载全部评论"));
    expect(getCommentLoadState()).toMatchObject({available:true,atEnd:true});
  });
  it("keeps a visible loading marker even when many comments follow it", () => {
    const outer = container(); const loading = document.createElement("div"); loading.setAttribute("aria-busy","true");
    outer.append(loading,...Array.from({length:150},()=>comment()));
    expect(getCommentLoadState().loading).toBe(true);
  });
  it("recognizes a visible spinner without text", () => {
    const outer = container(); const loading = document.createElement("div"); loading.className = "loading-spinner";
    outer.append(comment(),loading); expect(getCommentLoadState().loading).toBe(true);
  });
  it("ignores hidden spinners and hidden footer text, including a hidden parent", () => {
    const outer = container(); const hidden = document.createElement("div"); hidden.style.display = "none";
    hidden.innerHTML = '<span class="loading-spinner">加载中…</span><p>没有更多评论</p>';
    const direct = document.createElement("span"); direct.className = "loading-spinner"; direct.style.visibility = "hidden";
    outer.append(comment(),hidden,direct);
    expect(getCommentLoadState()).toMatchObject({loading:false,atEnd:false});
  });
  it.each([
    ['e2e', '<div data-e2e="comment-item"><a href="/user/a">甲</a><p>没有更多评论</p></div>'],
    ['testid', '<div data-testid="comment-item"><a href="/user/a">甲</a><p>没有更多评论</p></div>'],
    ['class', '<div class="comment-item"><a href="/user/a">甲</a><p>没有更多评论</p></div>'],
    ['text-selector', '<div><a href="/user/a">甲</a><p data-e2e="comment-content">没有更多评论</p></div>'],
    ['semantic-row', '<div><a href="/user/a">甲</a><p>没有更多评论</p><button>点赞 1</button></div>'],
    ['reply', '<div class="reply-item"><a href="/user/a">甲</a><p>没有更多评论</p></div>']
  ])("never interprets a %s comment body as the footer", (_name, markup) => {
    const outer = container(); outer.innerHTML = markup;
    expect(getCommentLoadState().atEnd).toBe(false);
  });
  it("ignores a comment saying loading and reads the real footer following it", () => {
    const outer = container(); outer.append(comment('<p data-e2e="comment-content">加载中…</p>'),footer());
    expect(getCommentLoadState()).toMatchObject({loading:false,atEnd:true});
  });
});
