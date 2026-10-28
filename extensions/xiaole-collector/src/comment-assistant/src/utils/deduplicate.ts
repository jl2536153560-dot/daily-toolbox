import type { CommentItem } from "../shared/types";

export interface DeduplicateResult {
  comments: CommentItem[];
  duplicateCount: number;
}

export function deduplicateComments(
  comments: readonly CommentItem[]
): DeduplicateResult {
  const seen = new Set<string>();
  const unique: CommentItem[] = [];
  let duplicateCount = 0;

  for (const comment of comments) {
    const key = `${comment.videoId}\u001f${comment.id}`;
    if (seen.has(key)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(key);
    unique.push(comment);
  }

  return { comments: unique, duplicateCount };
}
