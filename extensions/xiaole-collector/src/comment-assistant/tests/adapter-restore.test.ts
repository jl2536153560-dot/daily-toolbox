// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DouyinAdapter } from "../src/adapters/douyin/DouyinAdapter";

function url(id = "123456") {
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(`https://www.douyin.com/video/${id}`);
}
function comment(id: string, text: string, likes = "10") {
  const node = document.createElement("div"); node.dataset.e2e = "comment-item"; node.dataset.commentId = id;
  const author = document.createElement("a"); author.dataset.e2e = "comment-user-name"; author.href = `/user/author-${id}`; author.textContent = `作者${id}`;
  const body = document.createElement("p"); body.dataset.e2e = "comment-level-1"; body.textContent = text;
  const vote = document.createElement("button"); vote.dataset.e2e = "comment-like-count"; vote.textContent = likes; vote.setAttribute("aria-label", `点赞 ${likes}`);
  const time = document.createElement("span"); time.dataset.e2e = "comment-time"; time.textContent = "1天前";
  node.append(author, body, vote, time); return node;
}
function page(...nodes: Element[]) {
  const box = document.createElement("section"); box.dataset.e2e = "comment-list"; box.append(...nodes); document.body.replaceChildren(box); return box;
}
beforeEach(() => {
  url(); document.head.innerHTML = '<meta property="og:title" content="恢复采集测试">'; document.body.replaceChildren();
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{ width: 300, height: 50 }] as unknown as DOMRectList);
});
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); document.head.replaceChildren(); });

describe("恢复缓存后继续采集", () => {
  it("刷新仅加载首批DOM时保留全部旧正文，不重新保存未变化行", () => {
    page(comment("a", "第一条完整正文"), comment("b", "第二条完整正文，已经滚出页面"));
    const first = new DouyinAdapter(); const saved = first.scan().comments;
    expect(first.drainChanges()).toHaveLength(2);
    const restored = new DouyinAdapter(); restored.restore("123456", saved);
    expect(restored.drainChanges()).toEqual([]);
    page(comment("a", "第一条完整正文"));
    expect(restored.scan().comments.map(item => item.text)).toEqual(["第一条完整正文", "第二条完整正文，已经滚出页面"]);
    expect(restored.drainChanges()).toEqual([]);
  });

  it("恢复后只保存点赞变更与新增行，不丢首次读取顺序", () => {
    page(comment("a", "第一条完整正文"), comment("b", "第二条完整正文"));
    const first = new DouyinAdapter(); const saved = first.scan().comments;
    const restored = new DouyinAdapter(); restored.restore("123456", saved);
    page(comment("a", "第一条完整正文", "25"), comment("c", "第三条新增正文"));
    const result = restored.scan(); const delta = restored.drainChanges();
    expect(result.comments.map(item => item.nativeId)).toEqual(["a", "b", "c"]);
    expect(delta.map(item => [item.nativeId, item.originalIndex, item.likeCount])).toEqual([["a", 0, 25], ["c", 2, 10]]);
    restored.scan(); expect(restored.drainChanges()).toEqual([]);
  });

  it("加载中容器暂时消失不会清空恢复的评论", () => {
    page(comment("a", "加载前的完整正文")); const first = new DouyinAdapter(); const saved = first.scan().comments;
    const restored = new DouyinAdapter(); restored.restore("123456", saved); document.body.replaceChildren();
    expect(restored.scan().comments[0]?.text).toBe("加载前的完整正文");
    expect(restored.drainChanges()).toEqual([]);
  });

  it("恢复时去重并拒绝其它视频的正文", () => {
    page(comment("a", "本视频正文")); const original = new DouyinAdapter().scan().comments[0]!;
    const restored = new DouyinAdapter(); restored.restore("123456", [original, { ...original, text: "重复副本" }, { ...original, id: "other", videoId: "999999", text: "其它视频" }]);
    document.body.replaceChildren();
    expect(restored.scan().comments.map(item => item.text)).toEqual(["本视频正文"]);
  });

  it("失败批次回放不会覆盖随后已读取的新点赞数据", () => {
    page(comment("a", "完整正文", "10")); const adapter = new DouyinAdapter(); adapter.scan(); const failed = adapter.drainChanges();
    page(comment("a", "完整正文", "30")); adapter.scan(); adapter.retainChanges(failed);
    const next = adapter.drainChanges(); expect(next).toHaveLength(1); expect(next[0]?.likeCount).toBe(30);
    adapter.retainChanges(next); expect(adapter.drainChanges()[0]?.likeCount).toBe(30);
  });

  it("视频切换会清空恢复数据与尚未保存的增量", () => {
    page(comment("a", "旧视频正文")); const old = new DouyinAdapter().scan().comments;
    const restored = new DouyinAdapter(); restored.restore("123456", old);
    page(comment("b", "旧视频后加载正文")); restored.scan();
    url("654321"); page(comment("a", "新视频正文，同原生评论ID也不能混用"));
    const result = restored.scan(); expect(result.comments).toHaveLength(1);
    expect(result.comments[0]).toMatchObject({ videoId: "654321", text: "新视频正文，同原生评论ID也不能混用", originalIndex: 0 });
    expect(restored.drainChanges().map(item => item.videoId)).toEqual(["654321"]);
  });
});
