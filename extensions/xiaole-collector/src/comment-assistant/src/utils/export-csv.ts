import type { CommentItem } from "../shared/types";
import { hasCommentText } from "./comment-content";

const HEADERS = [
  "排名",
  "评论内容",
  "作者",
  "点赞数",
  "回复数",
  "发布时间"
] as const;

const TIME_PATTERN =
  /(?:刚刚|昨天|\d+\s*(?:秒|分钟|小时|天|周|月|年)前|\d{1,4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?)/u;

function protectSpreadsheetFormula(value: string): string {
  return /^[\s\uFEFF]*[=+\-@]|^[\t\r\n]/.test(value) ? `'${value}` : value;
}

function csvCell(value: unknown): string {
  const stringValue = protectSpreadsheetFormula(
    value == null ? "" : String(value)
  );
  return `"${stringValue.replaceAll('"', '""')}"`;
}

function formatPublishInfo(comment: CommentItem): string {
  const rawTime = comment.publishTimeText?.trim() ?? "";
  const time = rawTime.match(TIME_PATTERN)?.[0]?.replaceAll(/\s+/g, "") ?? "";
  const locationFromTime =
    rawTime.match(/[·・|]\s*([^\s·・|]{1,20})\s*$/u)?.[1] ?? "";
  const location =
    (comment.ipLocationText ?? "")
      .replace(/^IP(?:属地)?\s*[:：]?\s*/u, "")
      .trim() || locationFromTime;
  if (time && location) return `${time}·${location}`;
  return time || location;
}

export function exportCommentsCsv(
  comments: readonly CommentItem[]
): string {
  const rows = comments.filter(comment => hasCommentText(comment.text)).map((comment, index) => {
    return [
      index + 1,
      comment.text,
      comment.authorName,
      comment.parseWarnings.includes("点赞数未明确展示或无法解析") ? "" : comment.likeCount,
      comment.parseWarnings.includes("回复数未明确展示") ? "" : comment.replyCount,
      formatPublishInfo(comment)
    ];
  });

  return `\uFEFF${[HEADERS, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n")}`;
}
