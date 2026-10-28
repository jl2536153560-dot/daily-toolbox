export const DOUYIN_SELECTORS = {
  commentContainers: [
    '[data-e2e="comment-list"]',
    '[data-e2e="comment-list-container"]',
    '[data-e2e="feed-comment-list"]',
    '[data-e2e="comment-panel"]',
    '[data-testid="comment-list"]',
    '[aria-label*="评论列表"]',
    'div[class*="comment-list"]',
    'div[class*="CommentList"]',
    'div[class*="commentList"]',
    'div[class*="comment-container"]',
    'div[class*="CommentContainer"]'
  ],
  commentItems: [
    '[data-e2e="comment-item"]',
    '[data-e2e="comment-item-container"]',
    '[data-testid="comment-item"]',
    '[data-testid*="comment-item"]',
    '[role="listitem"][data-e2e*="comment"]',
    'div[class*="comment-item"]',
    'div[class*="CommentItem"]',
    'div[class*="commentItem"]'
  ],
  commentText: [
    '[data-e2e="comment-level-1"]',
    '[data-e2e="comment-content"]',
    '[data-testid="comment-content"]',
    '[class*="comment-text"]',
    '[class*="CommentText"]',
    '[class*="commentContent"]'
  ],
  author: [
    '[data-e2e="comment-user-name"]',
    '[data-e2e="comment-author"]',
    '[data-testid="comment-author"]',
    'a[href*="/user/"]'
  ],
  likeCount: [
    '[data-e2e="comment-like-count"]',
    '[data-testid="comment-like-count"]',
    '[aria-label*="点赞"]',
    '[aria-label*="赞"]',
    '[title*="点赞"]',
    '[class*="comment-like"]',
    '[class*="CommentLike"]'
  ],
  replyCount: [
    '[data-e2e="comment-reply-count"]',
    '[data-testid="comment-reply-count"]',
    '[aria-label*="条回复"]',
    '[class*="reply-count"]',
    '[class*="ReplyCount"]'
  ],
  publishTime: [
    '[data-e2e="comment-time"]',
    '[data-testid="comment-time"]',
    'time',
    '[class*="comment-time"]',
    '[class*="CommentTime"]'
  ]
} as const;
