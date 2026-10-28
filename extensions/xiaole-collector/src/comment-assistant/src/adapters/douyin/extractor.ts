import { parseCountDetailed } from "../../utils/parse-count";
import { findFirst } from "./detector";
import { DOUYIN_SELECTORS } from "./selectors";

const REPLY_COUNT_PATTERN =
  /(?:展开|共|查看|还有)?\s*([\d.,]+\s*[万亿wW]?\+?)\s*条?\s*回复/iu;
const TIME_PATTERN =
  /(?:刚刚|昨天|\d+\s*(?:秒|分钟|小时|天|周|月|年)前|\d{1,4}[-/.]\d{1,2}[-/.]\d{1,2})/u;
const ACTION_ONLY_PATTERN =
  /^(?:回复|评论|分享|转发|收藏|赞|点赞|举报|删除|置顶|作者赞过|收起回复)$/u;

function cleanText(value: string | null | undefined): string {
  return (value ?? "").replaceAll(/\s+/g, " ").trim();
}

function ownText(element: Element): string {
  return cleanText(
    Array.from(element.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? "")
      .join(" ")
  );
}

function getElementLabel(element: Element): string {
  return cleanText(
    [
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      ownText(element),
      element.textContent
    ]
      .filter(Boolean)
      .join(" ")
  );
}

function isAfter(element: Element, reference: Element): boolean {
  return Boolean(
    reference.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING
  );
}

function isBefore(element: Element, reference: Element): boolean {
  return Boolean(
    element.compareDocumentPosition(reference) & Node.DOCUMENT_POSITION_FOLLOWING
  );
}

function isInteractionOnlyText(text: string): boolean {
  const compact = text
    .replaceAll(/\s+/g, "")
    .replaceAll(/[·•|｜/\\:：,，。;；()（）\[\]【】]/g, "");
  return /^(?:(?:\d+(?:\.\d+)?[万亿wW]?\+?)|回复|评论|分享|转发|收藏|赞|点赞|举报|删除|置顶|作者赞过|收起回复)+$/u.test(
    compact
  );
}

function meaningfulCommentText(text: string, authorName: string): boolean {
  if (!text || text === authorName || text.length > 2400) return false;
  if (ACTION_ONLY_PATTERN.test(text)) return false;
  if (isInteractionOnlyText(text)) return false;
  if (REPLY_COUNT_PATTERN.test(text)) return false;
  if (TIME_PATTERN.test(text) && text.length <= 40) return false;
  if (/^IP(?:属地)?\s*[:：]?/u.test(text)) return false;
  if (/^[\d.,]+\s*[万亿wW]?\+?$/u.test(text)) return false;
  return !/^(?:回复|分享|点赞)\s*[\d.,万亿wW+]*$/u.test(text);
}

export function findActionRow(node: Element): Element | null {
  const candidates = Array.from(
    node.querySelectorAll<HTMLElement>(
      'button, [role="button"], div, span'
    )
  ).filter((element) => {
    const text = ownText(element) || cleanText(element.textContent);
    const label = cleanText(element.getAttribute("aria-label"));
    return (
      text === "回复" ||
      text === "评论" ||
      label === "回复" ||
      label === "评论"
    );
  });

  for (const candidate of candidates) {
    let current: Element | null = candidate;
    for (let level = 0; current && level < 5; level += 1) {
      const text = cleanText(current.textContent);
      const controls = current.querySelectorAll(
        'button, [role="button"], svg'
      ).length;
      if ((text.includes("分享") && controls >= 2) || controls >= 3) {
        return current;
      }
      current = current.parentElement;
      if (current === node.parentElement) break;
    }
  }
  return candidates[0]?.parentElement ?? null;
}

export function extractAuthor(node: Element): {
  name: string;
  url: string | null;
  element: Element | null;
} {
  const candidates = new Set<Element>();
  for (const selector of DOUYIN_SELECTORS.author) {
    node.querySelectorAll(selector).forEach((element) => {
      candidates.add(element);
    });
  }
  const elements = Array.from(candidates);
  const element =
    elements.find((candidate) => {
      const text = cleanText(candidate.textContent);
      return text.length > 0 && text.length <= 100;
    }) ??
    findFirst(node, DOUYIN_SELECTORS.author).element;
  const anchor =
    element instanceof HTMLAnchorElement
      ? element
      : element?.closest<HTMLAnchorElement>("a[href]");
  return {
    name: cleanText(element?.textContent),
    url: anchor?.href ?? null,
    element
  };
}

export function extractCommentText(
  node: Element,
  authorName: string,
  authorElement: Element | null
): { text: string; foundBySelector: boolean } {
  const actionRow = findActionRow(node);
  const explicit = findFirst(node, DOUYIN_SELECTORS.commentText).element;
  const explicitText = cleanText(explicit?.textContent);
  const explicitIsSeparateFromActions =
    !explicit ||
    !actionRow ||
    (!actionRow.contains(explicit) && !explicit.contains(actionRow));
  if (
    explicitIsSeparateFromActions &&
    meaningfulCommentText(explicitText, authorName)
  ) {
    return { text: explicitText, foundBySelector: true };
  }

  const elements = Array.from(
    node.querySelectorAll<HTMLElement>("div, span, p")
  ).slice(0, 500);
  const scored: Array<{ text: string; score: number }> = [];
  const directPieces: string[] = [];

  for (const element of elements) {
    if (actionRow && (actionRow === element || actionRow.contains(element))) {
      continue;
    }
    if (authorElement && !isAfter(element, authorElement)) continue;
    if (actionRow && !isBefore(element, actionRow)) continue;
    if (element.querySelector('a[href*="/user/"]')) continue;

    const direct = ownText(element);
    const full =
      direct ||
      (element.childElementCount <= 6
        ? cleanText(element.textContent)
        : "");
    if (!meaningfulCommentText(full, authorName)) continue;

    const classHint = String(element.className).toLocaleLowerCase();
    let score = full.length;
    if (direct) score += Math.min(direct.length * 2, 400);
    if (/comment|content|text/u.test(classHint)) score += 120;
    if (element.childElementCount === 0) score += 40;
    if (/time|action|reply|like/u.test(classHint)) score -= 180;
    scored.push({ text: full, score });

    if (direct && !directPieces.includes(direct)) directPieces.push(direct);
  }

  scored.sort((left, right) => right.score - left.score);
  const best = scored[0]?.text ?? "";
  const combined = directPieces.join("\n").trim();
  const text =
    combined.length > best.length &&
    combined.length <= 2400 &&
    directPieces.length <= 30
      ? combined
      : best;
  return { text, foundBySelector: false };
}

export function extractLikeCount(node: Element): {
  value: number;
  raw: string;
  parsed: boolean;
} {
  const actionRow = findActionRow(node);
  const searchRoot = actionRow ?? node;
  const explicit = findFirst(searchRoot, DOUYIN_SELECTORS.likeCount).element;
  const explicitLabel = explicit ? getElementLabel(explicit) : "";
  const explicitRaw =
    explicitLabel.match(/([\d.,]+\s*[万亿wW]?\+?)/u)?.[1] ??
    (explicitLabel === "赞" ? "赞" : "");
  if (explicitRaw) {
    const parsed = parseCountDetailed(explicitRaw);
    return { value: parsed.value, raw: explicitRaw, parsed: parsed.parsed };
  }

  const numericCandidates = Array.from(
    searchRoot.querySelectorAll<HTMLElement>(
      'button, [role="button"], span, div'
    )
  )
    .map((element, index) => {
      const text = ownText(element) || cleanText(element.textContent);
      const raw = text.match(/^([\d.,]+\s*[万亿wW]?\+?)$/u)?.[1] ?? "";
      const hint = `${element.className} ${element.getAttribute("aria-label") ?? ""}`
        .toLocaleLowerCase();
      return {
        raw,
        index,
        score: /(like|digg|赞|heart)/u.test(hint) ? 1000 + index : index
      };
    })
    .filter((candidate) => candidate.raw)
    .sort((left, right) => right.score - left.score);

  const raw = numericCandidates[0]?.raw ?? "";
  if (!raw) return { value: 0, raw: "", parsed: false };
  const parsed = parseCountDetailed(raw);
  return { value: parsed.value, raw, parsed: parsed.parsed };
}

export function extractReplyCount(node: Element): {
  value: number;
  raw: string;
  estimated: boolean;
  parsed: boolean;
} {
  const explicit = findFirst(node, DOUYIN_SELECTORS.replyCount).element;
  const candidates = [
    explicit ? getElementLabel(explicit) : "",
    ...Array.from(node.querySelectorAll<HTMLElement>("button, span, div"))
      .slice(0, 500)
      .map((element) => ownText(element))
      .filter(Boolean),
    cleanText(node.textContent)
  ];

  for (const text of candidates) {
    const match = text.match(REPLY_COUNT_PATTERN);
    if (!match) continue;
    const parsed = parseCountDetailed(match[1] ?? "");
    if (parsed.parsed) {
      return {
        value: parsed.value,
        raw: match[0],
        estimated: false,
        parsed: true
      };
    }
  }
  return { value: 0, raw: "", estimated: true, parsed: false };
}

export function extractPublishTime(node: Element): string | null {
  const explicit = findFirst(node, DOUYIN_SELECTORS.publishTime).element;
  const explicitText = cleanText(explicit?.textContent);
  if (explicitText && TIME_PATTERN.test(explicitText)) return explicitText;

  const pieces = Array.from(
    node.querySelectorAll<HTMLElement>("time, span, div")
  )
    .slice(0, 500)
    .map((element) => ownText(element) || cleanText(element.textContent))
    .filter((text) => text.length <= 80);
  return pieces.find((text) => TIME_PATTERN.test(text)) ?? null;
}

export function extractIpLocation(node: Element): string | null {
  const pieces = Array.from(
    node.querySelectorAll<HTMLElement>("time, span, div, p")
  )
    .slice(0, 500)
    .map((element) => ownText(element))
    .filter((text) => text.length > 0 && text.length <= 80);

  for (const text of pieces) {
    const explicit = text.match(
      /IP(?:属地)?\s*[:：]?\s*([^\s·|]{1,20})$/u
    );
    if (explicit) return explicit[0].trim();
    const timeAndLocation = text.match(
      /(?:刚刚|昨天|\d+\s*(?:秒|分钟|小时|天|周|月|年)前|\d{1,4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?)\s*[·・|]\s*([^\s·|]{1,20})$/u
    );
    if (timeAndLocation?.[1]) {
      return `IP属地：${timeAndLocation[1]}`;
    }
  }
  return null;
}

export function extractNativeId(node: Element): string | null {
  const idAttributes = [
    "data-comment-id",
    "data-commentid",
    "data-cid",
    "data-item-id"
  ];
  for (const attribute of idAttributes) {
    const ownValue = node.getAttribute(attribute);
    if (ownValue?.trim()) return ownValue.trim();
    const nested = node.querySelector(`[${attribute}]`)?.getAttribute(attribute);
    if (nested?.trim()) return nested.trim();
  }
  const link = node.querySelector<HTMLAnchorElement>(
    'a[href*="comment_id="], a[href*="commentId="], a[href*="cid="]'
  );
  if (!link) return null;
  const parsed = new URL(link.href, location.href);
  return (
    parsed.searchParams.get("comment_id") ??
    parsed.searchParams.get("commentId") ??
    parsed.searchParams.get("cid")
  );
}
