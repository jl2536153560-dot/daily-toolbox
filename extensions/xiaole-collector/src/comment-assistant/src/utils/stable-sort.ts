import type { CommentItem, SortMode } from "../shared/types";

function compareNumberDesc(left: number, right: number): number {
  return right - left;
}

export function stableSortComments(
  comments: readonly CommentItem[],
  mode: SortMode
): CommentItem[] {
  return comments
    .map((comment, stableIndex) => ({ comment, stableIndex }))
    .sort((left, right) => {
      const a = left.comment;
      const b = right.comment;
      let result = 0;

      if (mode === "likes") {
        result =
          compareNumberDesc(a.likeCount, b.likeCount) ||
          compareNumberDesc(a.replyCount, b.replyCount);
      } else if (mode === "replies") {
        result =
          compareNumberDesc(a.replyCount, b.replyCount) ||
          compareNumberDesc(a.likeCount, b.likeCount);
      }

      return (
        result ||
        a.originalIndex - b.originalIndex ||
        left.stableIndex - right.stableIndex
      );
    })
    .map(({ comment }) => comment);
}
