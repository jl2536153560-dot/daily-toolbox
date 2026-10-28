import type { CommentItem } from "../src/shared/types";

export function makeComment(
  overrides: Partial<CommentItem> = {}
): CommentItem {
  return {
    id: "comment-1",
    nativeId: "comment-1",
    videoId: "video-1",
    videoUrl: "https://www.douyin.com/video/video-1",
    videoTitle: "示例视频",
    authorName: "示例作者",
    authorUrl: null,
    text: "示例评论",
    likeCount: 10,
    likeCountRaw: "10",
    replyCount: 2,
    replyCountRaw: "2条回复",
    replyCountEstimated: false,
    publishTimeText: "1天前",
    ipLocationText: null,
    originalIndex: 0,
    scannedAt: "2026-07-29T00:00:00.000Z",
    parseWarnings: [],
    ...overrides
  };
}
