import { describe, expect, it } from "vitest";
import { stableSortComments } from "../src/utils/stable-sort";
import { makeComment } from "./fixtures";

describe("stableSortComments", () => {
  const comments = [
    makeComment({
      id: "a",
      likeCount: 10,
      replyCount: 1,
      originalIndex: 0
    }),
    makeComment({
      id: "b",
      likeCount: 10,
      replyCount: 3,
      originalIndex: 1
    }),
    makeComment({
      id: "c",
      likeCount: 20,
      replyCount: 0,
      originalIndex: 2
    })
  ];

  it("按点赞数排序并用回复数打破平局", () => {
    expect(stableSortComments(comments, "likes").map(({ id }) => id)).toEqual([
      "c",
      "b",
      "a"
    ]);
  });

  it("按回复数排序并用点赞数打破平局", () => {
    expect(
      stableSortComments(
        [...comments, makeComment({ id: "d", replyCount: 3, likeCount: 30 })],
        "replies"
      ).map(({ id }) => id)
    ).toEqual(["d", "b", "a", "c"]);
  });

  it("排序值完全相同时保持原始顺序", () => {
    const tied = [
      makeComment({ id: "late", originalIndex: 4 }),
      makeComment({ id: "early", originalIndex: 2 })
    ];
    expect(stableSortComments(tied, "likes").map(({ id }) => id)).toEqual([
      "early",
      "late"
    ]);
  });
});
