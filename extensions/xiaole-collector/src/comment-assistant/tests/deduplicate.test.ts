import { describe, expect, it } from "vitest";
import { deduplicateComments } from "../src/utils/deduplicate";
import { createFallbackCommentId } from "../src/utils/hash";
import { makeComment } from "./fixtures";

describe("评论去重", () => {
  it("相同视频和commentId去重", () => {
    const result = deduplicateComments([
      makeComment({ id: "same" }),
      makeComment({ id: "same" })
    ]);
    expect(result.comments).toHaveLength(1);
    expect(result.duplicateCount).toBe(1);
  });

  it("不同视频不去重", () => {
    const result = deduplicateComments([
      makeComment({ id: "same", videoId: "v1" }),
      makeComment({ id: "same", videoId: "v2" })
    ]);
    expect(result.comments).toHaveLength(2);
  });

  it("相同正文但不同作者生成不同fallback ID", () => {
    const base = {
      videoId: "v1",
      text: "相同正文",
      publishTimeText: "1天前"
    };
    expect(
      createFallbackCommentId({ ...base, authorName: "甲" })
    ).not.toBe(createFallbackCommentId({ ...base, authorName: "乙" }));
  });
});
