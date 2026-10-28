import { afterEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { CommentSessionStore, type SessionOptions } from "../src/content/session-store";
import { makeComment } from "./fixtures";

const video = "video-1";
const options: SessionOptions = { target: 100000, exportAfter: false, sort: "likes" };
const stores: CommentSessionStore[] = [];
function create(factory = new IDBFactory(), maxComments?: number) {
  const store = new CommentSessionStore({ indexedDB: factory, maxComments }); stores.push(store); return store;
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(stores.splice(0).map(store => store.close())); });

describe("刷新后恢复评论采集进度", () => {
  it("刷新创建新实例后恢复运行状态、滚动位置和已收集评论", async () => {
    const factory = new IDBFactory(); const old = create(factory);
    const lease = await old.begin("tab-1", video, options);
    await old.checkpoint(lease, [makeComment({ id: "first", originalIndex: 0 }), makeComment({ id: "second", originalIndex: 1 })], { scrollTop: 2400 });
    await old.close();
    const fresh = create(factory); const restored = await fresh.load("tab-1", video);
    expect(restored?.metadata).toMatchObject({ state: "running", count: 2, scrollTop: 2400, target: 100000, sort: "likes" });
    expect(restored?.comments.map(comment => comment.id)).toEqual(["first", "second"]);
    const next = await fresh.begin("tab-1", video, options);
    expect(next.runId).not.toBe(lease.runId);
    await fresh.checkpoint(next, [makeComment({ id: "third", originalIndex: 2 })]);
    expect((await fresh.load("tab-1", video))?.metadata).toMatchObject({ count: 3, scrollTop: 2400 });
  });

  it("不同视频或不同标签页的数据与运行状态互不混用", async () => {
    const store = create();
    const a = await store.begin("tab-1", video, options);
    const b = await store.begin("tab-2", video, options);
    const c = await store.begin("tab-1", "video-2", options);
    await store.checkpoint(a, [makeComment({ text: "甲" })]);
    await store.checkpoint(b, [makeComment({ text: "乙" })]);
    await store.checkpoint(c, [makeComment({ videoId: "video-2", text: "丙" }), makeComment({ text: "错误的视频" })]);
    expect((await store.load("tab-1", video))?.comments[0]?.text).toBe("甲");
    expect((await store.load("tab-2", video))?.comments[0]?.text).toBe("乙");
    expect((await store.load("tab-1", "video-2"))?.comments.map(comment => comment.text)).toEqual(["丙"]);
  });

  it("已停止会话不会被迟到的保存或同一旧任务复活", async () => {
    const store = create(); const lease = await store.begin("tab-1", video, options);
    const firstSave = store.checkpoint(lease, [makeComment()]);
    const stop = store.setState(lease, "stopped");
    const staleSave = store.checkpoint(lease, [makeComment({ id: "late" })]);
    expect(await firstSave).toEqual({ accepted: true, count: 1 }); expect(await stop).toBe(true);
    expect(await staleSave).toEqual({ accepted: false, count: 1 });
    expect(await store.setState(lease, "running")).toBe(false);
    expect((await store.load("tab-1", video))?.metadata.state).toBe("stopped");
  });

  it("新运行接管后旧实例的保存和停止均不影响新运行", async () => {
    const factory = new IDBFactory(); const first = create(factory); const second = create(factory);
    const old = await first.begin("tab-1", video, options);
    await first.checkpoint(old, [makeComment()]);
    const current = await second.begin("tab-1", video, { ...options, exportAfter: true });
    expect((await first.checkpoint(old, [makeComment({ id: "stale" })])).accepted).toBe(false);
    expect(await first.setState(old, "completed")).toBe(false);
    await second.checkpoint(current, [makeComment({ id: "current", originalIndex: 1 })]);
    expect((await second.load("tab-1", video))?.metadata).toMatchObject({ state: "running", count: 2, exportAfter: true, runId: current.runId });
  });

  it("暂停可恢复，完成只能显式开始新运行且保留原评论", async () => {
    const store = create(); const lease = await store.begin("tab-1", video, options);
    await store.checkpoint(lease, [makeComment()]);
    expect(await store.setState(lease, "paused")).toBe(true);
    expect((await store.checkpoint(lease, [makeComment({ id: "paused" })])).accepted).toBe(false);
    expect(await store.setState(lease, "running")).toBe(true);
    expect(await store.setState(lease, "completed")).toBe(true);
    expect(await store.setState(lease, "running")).toBe(false);
    await store.begin("tab-1", video, options);
    expect((await store.load("tab-1", video))?.metadata).toMatchObject({ state: "running", count: 1 });
  });

  it("每批只写入增量行，同ID更新去重并保留首次顺序", async () => {
    const store = create(); const lease = await store.begin("tab-1", video, options);
    await store.checkpoint(lease, [makeComment({ id: "a", originalIndex: 0 }), makeComment({ id: "b", originalIndex: 1 }), makeComment({ id: "c", originalIndex: 2 })]);
    const put = vi.spyOn(IDBObjectStore.prototype, "put");
    await store.checkpoint(lease, [makeComment({ id: "b", originalIndex: 99, likeCount: 25 }), makeComment({ id: "b", originalIndex: 99, likeCount: 30 })]);
    expect(put.mock.calls.filter(call => "id" in (call[0] as object))).toHaveLength(1);
    const restored = await store.load("tab-1", video);
    expect(restored?.comments.map(comment => comment.id)).toEqual(["a", "b", "c"]);
    expect(restored?.comments[1]).toMatchObject({ originalIndex: 1, likeCount: 30 });
    expect(restored?.metadata.count).toBe(3);
  });

  it("达到存储上限后仍可更新已有行，但不新增超限记录", async () => {
    const store = create(new IDBFactory(), 3); const lease = await store.begin("tab-1", video, options);
    expect((await store.load("tab-1", video))?.metadata.target).toBe(3);
    const saved = await store.checkpoint(lease, Array.from({ length: 5 }, (_, index) => makeComment({ id: String(index), originalIndex: index })));
    expect(saved).toEqual({ accepted: true, count: 3 });
    await store.checkpoint(lease, [makeComment({ id: "1", likeCount: 50 }), makeComment({ id: "new" })]);
    const loaded = await store.load("tab-1", video);
    expect(loaded?.comments).toHaveLength(3); expect(loaded?.comments[1]?.likeCount).toBe(50);
  });

  it("显式挑选可序列化公开字段，不存DOM或额外控制器属性", async () => {
    const store = create(); const lease = await store.begin("tab-1", video, options);
    const comment = Object.assign(makeComment(), { node: () => "不可序列化", unrelated: { credential: "not-comment-data" } });
    await store.checkpoint(lease, [comment]);
    const loaded = await store.load("tab-1", video);
    expect(loaded?.comments[0]).toEqual(makeComment());
  });

  it("清理只删除当前标签页的视频，旧保存不会重新创建它", async () => {
    const store = create(); const a = await store.begin("tab-1", video, options); const b = await store.begin("tab-2", video, options);
    await store.checkpoint(a, [makeComment()]); await store.checkpoint(b, [makeComment()]);
    await store.clear("tab-1", video);
    expect(await store.load("tab-1", video)).toBeNull();
    expect((await store.checkpoint(a, [makeComment()])).accepted).toBe(false);
    expect((await store.load("tab-2", video))?.metadata.count).toBe(1);
  });

  it("读取不存在的视频返回空，不凭空开始采集", async () => {
    expect(await create().load("tab-1", video)).toBeNull();
  });

  it("失败批次原子回滚，后续保存仍可重试且不会错计数量", async () => {
    const store = create(); const lease = await store.begin("tab-1", video, options);
    const corrupt = makeComment({ id: "bad", parseWarnings: [(() => undefined) as unknown as string] });
    await expect(store.checkpoint(lease, [makeComment(), corrupt])).rejects.toThrow();
    expect((await store.load("tab-1", video))?.metadata.count).toBe(0);
    expect((await store.load("tab-1", video))?.comments).toHaveLength(0);
    expect(await store.checkpoint(lease, [makeComment()])).toEqual({ accepted: true, count: 1 });
  });
});
