function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function createFallbackCommentId(input: {
  videoId: string;
  authorName: string;
  text: string;
  publishTimeText: string | null;
}): string {
  const source = [
    input.videoId,
    input.authorName.trim(),
    input.text.trim(),
    input.publishTimeText ?? ""
  ].join("\u001f");
  return `fallback_${fnv1a(source)}`;
}
