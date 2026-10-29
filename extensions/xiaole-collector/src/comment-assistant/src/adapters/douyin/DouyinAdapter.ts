import { LOW_PARSE_SUCCESS_RATE, MAX_COLLECTED_COMMENTS } from "../../shared/constants";
import type {
  CommentItem,
  PageStatus,
  ScanResult,
  SelectorDiagnostics
} from "../../shared/types";
import { deduplicateComments } from "../../utils/deduplicate";
import { hasCommentText } from "../../utils/comment-content";
import { createFallbackCommentId } from "../../utils/hash";
import {
  findCommentContainer,
  getPageStatus,
  getVideoContext
} from "./detector";
import {
  extractAuthor,
  extractCommentText,
  extractIpLocation,
  extractLikeCount,
  extractNativeId,
  extractPublishTime,
  extractReplyCount,
  findActionRow
} from "./extractor";
import { DOUYIN_SELECTORS } from "./selectors";

interface NodeSelection {
  nodes: Element[];
  selector: string | null;
}

export interface ReorderResult {
  movedCount: number;
  groupCount: number;
  message: string;
}

function cleanText(value: string | null | undefined): string {
  return (value ?? "").replaceAll(/\s+/g, " ").trim();
}

function isVisible(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return true;
  const style = getComputedStyle(element);
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    element.getClientRects().length > 0
  );
}

function selectLargestCandidateSet(root: ParentNode): NodeSelection {
  let best: NodeSelection = { nodes: [], selector: null };
  for (const selector of DOUYIN_SELECTORS.commentItems) {
    const nodes = Array.from(root.querySelectorAll(selector)).filter(isVisible);
    if (nodes.length > best.nodes.length) best = { nodes, selector };
  }
  return best;
}

function authorElements(root: ParentNode): Element[] {
  const found = new Set<Element>();
  for (const selector of DOUYIN_SELECTORS.author) {
    root.querySelectorAll(selector).forEach((element) => found.add(element));
  }
  return Array.from(found).filter(isVisible);
}

function scoreCommentRoot(candidate: Element, author: Element): number {
  const text = cleanText(candidate.textContent);
  if (text.length < 5 || text.length > 6000 || /全部评论/u.test(text)) {
    return -1;
  }
  const authorCount = authorElements(candidate).length;
  if (authorCount === 0 || authorCount > 4) return -1;

  let score = 0;
  if (candidate.contains(author)) score += 3;
  if (authorCount === 1) score += 4;
  if (findActionRow(candidate)) score += 6;
  if (
    /(?:刚刚|昨天|\d+\s*(?:秒|分钟|小时|天|周|月|年)前|\d{1,4}[-/.]\d{1,2})/u.test(
      text
    )
  ) {
    score += 4;
  }
  if (/(?:展开|查看|共|还有)\s*[\d.,万亿wW+]+\s*条?\s*回复/u.test(text)) {
    score += 2;
  }
  if (candidate.querySelector('button, [role="button"], svg')) score += 2;
  if (text.length >= 12) score += 1;
  return score;
}

function semanticCommentNodes(root: Element): Element[] {
  const found = new Set<Element>();
  const scoredAncestors = new WeakMap<Element, { score: number; length: number }>();
  for (const author of authorElements(root)) {
    let current = author.parentElement;
    let best: { node: Element; score: number; length: number } | null = null;
    for (let level = 0; current && level < 9; level += 1) {
      if (!root.contains(current)) break;
      let scored = scoredAncestors.get(current);
      if (!scored) {
        scored = { score: scoreCommentRoot(current, author), length: cleanText(current.textContent).length };
        scoredAncestors.set(current, scored);
      }
      const { score, length } = scored;
      if (
        score >= 7 &&
        (!best ||
          score > best.score ||
          (score === best.score && length < best.length))
      ) {
        best = { node: current, score, length };
      }
      if (current === root) break;
      current = current.parentElement;
    }
    if (best) found.add(best.node);
  }
  return Array.from(found);
}

function nearestCandidateParent(
  node: Element,
  candidateSet: Set<Element>
): Element | null {
  let parent = node.parentElement;
  while (parent && parent !== document.body) {
    if (candidateSet.has(parent)) return parent;
    parent = parent.parentElement;
  }
  return null;
}

function elementStructureHint(element: Element): string {
  return [
    element.id,
    element.className,
    element.getAttribute("data-e2e"),
    element.getAttribute("data-testid"),
    element.getAttribute("data-comment-level"),
    element.getAttribute("aria-label")
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
}

function hasExplicitReplyStructure(
  node: Element,
  container: Element | null
): boolean {
  const levelOne = node.querySelector('[data-e2e="comment-level-1"]');
  const levelTwo = node.querySelector('[data-e2e="comment-level-2"]');
  if (levelTwo && !levelOne) return true;

  let current: Element | null = node;
  for (let level = 0; current && level < 12; level += 1) {
    if (
      /reply[-_]?(?:item|list|container|comment)|comment[-_]?reply|sub[-_]?(?:comment|reply)|comment[-_]?level[-_]?2|level[-_]?2/iu.test(
        elementStructureHint(current)
      )
    ) {
      return true;
    }
    if (current === container) break;
    current = current.parentElement;
  }
  return false;
}

function collapseCommentThreads(
  nodes: Element[],
  container: Element | null
): { nodes: Element[]; filteredReplies: number } {
  if (!container || nodes.length < 2) {
    return { nodes, filteredReplies: 0 };
  }

  const parentGroups = new Map<
    Element,
    Map<Element, Element[]>
  >();
  for (const node of nodes) {
    let branch = node;
    let parent = node.parentElement;
    for (let level = 0; parent && level < 14; level += 1) {
      if (!container.contains(parent) && parent !== container) break;
      const branches = parentGroups.get(parent) ?? new Map();
      const groupedNodes = branches.get(branch) ?? [];
      groupedNodes.push(node);
      branches.set(branch, groupedNodes);
      parentGroups.set(parent, branches);
      if (parent === container) break;
      branch = parent;
      parent = parent.parentElement;
    }
  }

  const candidates = Array.from(parentGroups, ([parent, branches]) => ({
    parent,
    branches,
    coverage: Array.from(branches.values()).reduce(
      (total, groupedNodes) => total + groupedNodes.length,
      0
    )
  }))
    .filter(({ branches }) => branches.size >= 2)
    .sort(
      (left, right) =>
        right.coverage - left.coverage ||
        right.branches.size - left.branches.size
    );
  const best = candidates[0];
  if (!best || best.coverage < Math.ceil(nodes.length * 0.6)) {
    return { nodes, filteredReplies: 0 };
  }

  const selected = new Set<Element>();
  for (const groupedNodes of best.branches.values()) {
    const first = groupedNodes[0];
    if (first) selected.add(first);
  }
  for (const node of nodes) {
    if (!best.parent.contains(node)) selected.add(node);
  }

  const collapsed = nodes.filter((node) => selected.has(node));
  return {
    nodes: collapsed,
    filteredReplies: nodes.length - collapsed.length
  };
}

function mainLevelNodes(
  nodes: Element[],
  container: Element | null
): {
  main: Element[];
  filteredReplies: number;
} {
  const withoutExplicitReplies = nodes.filter(
    (node) => !hasExplicitReplyStructure(node, container)
  );
  const explicitReplyCount = nodes.length - withoutExplicitReplies.length;
  const collapsed = collapseCommentThreads(
    withoutExplicitReplies,
    container
  );
  const candidateSet = new Set(collapsed.nodes);
  const leftValues = collapsed.nodes
    .map((node) => node.getBoundingClientRect().left)
    .filter((value) => Number.isFinite(value) && value > 0);
  const minLeft = leftValues.length ? leftValues.reduce((minimum, value) => Math.min(minimum, value), Infinity) : 0;
  const main: Element[] = [];
  let filteredReplies =
    explicitReplyCount + collapsed.filteredReplies;

  for (const node of collapsed.nodes) {
    const nested = Boolean(nearestCandidateParent(node, candidateSet));
    const left = node.getBoundingClientRect().left;
    const indented = minLeft > 0 && left > minLeft + 36;
    if (nested || indented) {
      filteredReplies += 1;
    } else {
      main.push(node);
    }
  }
  return { main, filteredReplies };
}

function diagnosticRate(success: number, total: number): number {
  return total === 0 ? 0 : success / total;
}

function selectMovableNodes(
  nodes: readonly Element[],
  container: Element
): Map<Element, Element> {
  const groups = new Map<
    Element,
    Array<{ commentNode: Element; unit: Element; level: number }>
  >();

  for (const commentNode of nodes) {
    let unit = commentNode;
    for (let level = 0; level < 10; level += 1) {
      const parent = unit.parentElement;
      if (!parent || !container.contains(parent)) break;
      const entries = groups.get(parent) ?? [];
      entries.push({ commentNode, unit, level });
      groups.set(parent, entries);
      if (parent === container) break;
      unit = parent;
    }
  }

  const selected = new Map<
    Element,
    { unit: Element; level: number }
  >();
  for (const entries of groups.values()) {
    if (entries.length < 2) continue;
    const uniqueUnits = new Set(entries.map(({ unit }) => unit));
    if (uniqueUnits.size !== entries.length) continue;
    for (const entry of entries) {
      const previous = selected.get(entry.commentNode);
      if (!previous || entry.level < previous.level) {
        selected.set(entry.commentNode, {
          unit: entry.unit,
          level: entry.level
        });
      }
    }
  }

  return new Map(
    Array.from(selected, ([commentNode, selection]) => [
      commentNode,
      selection.unit
    ])
  );
}

export class DouyinAdapter {
  private readonly originalIndices = new Map<string, number>();
  private readonly moveNodeByCommentId = new Map<string, Element>();
  private readonly commentsById = new Map<string, CommentItem>();
  private readonly changedComments = new Map<string, CommentItem>();
  private nextOriginalIndex = 0;
  private videoKey = "";

  public getPageStatus(): PageStatus {
    return getPageStatus();
  }

  public clear(): void {
    this.originalIndices.clear();
    this.moveNodeByCommentId.clear();
    this.commentsById.clear();
    this.changedComments.clear();
    this.nextOriginalIndex = 0;
    this.videoKey = "";
  }

  public restore(videoKey: string, comments: readonly CommentItem[]): void {
    this.clear(); this.videoKey = videoKey;
    for (const comment of comments.filter(item => hasCommentText(item.text)).slice(0, MAX_COLLECTED_COMMENTS)) {
      if (comment.videoId !== videoKey || this.commentsById.has(comment.id)) continue;
      const restored = { ...comment, originalIndex: this.nextOriginalIndex++ };
      this.commentsById.set(comment.id, restored);
      this.originalIndices.set(comment.id, restored.originalIndex);
    }
  }

  public drainChanges(): CommentItem[] {
    const changed = Array.from(this.changedComments.values());
    this.changedComments.clear(); return changed;
  }

  public retainChanges(comments: readonly CommentItem[]): void {
    for (const comment of comments) if (!this.changedComments.has(comment.id)) this.changedComments.set(comment.id, comment);
  }

  public scan(): ScanResult {
    const startedAt = performance.now();
    const initialStatus = getPageStatus();
    const video = getVideoContext();
    const nextVideoKey = video.videoId || video.videoUrl;
    if (this.videoKey && this.videoKey !== nextVideoKey) this.clear();
    this.videoKey = nextVideoKey;

    const containerMatch = findCommentContainer();
    const container = containerMatch.element;
    const warnings: string[] = [];
    let selected: NodeSelection = { nodes: [], selector: null };

    if (container) {
      const semanticNodes = semanticCommentNodes(container);
      if (semanticNodes.length > 0) {
        selected = {
          nodes: semanticNodes,
          selector: "语义：作者、时间与评论操作区"
        };
      } else {
        selected = selectLargestCandidateSet(container);
        if (selected.nodes.length > 0) {
          warnings.push("未形成语义评论边界，已使用候选评论节点。");
        }
      }
    }

    const visibleNodes = selected.nodes.filter(isVisible);
    const levelResult = mainLevelNodes(visibleNodes, container);
    const mainNodes = levelResult.main;
    const movableNodes = container
      ? selectMovableNodes(mainNodes, container)
      : new Map<Element, Element>();
    const rawComments: CommentItem[] = [];
    this.moveNodeByCommentId.clear();

    let textParseSuccess = 0;
    let authorParseSuccess = 0;
    let likeParseSuccess = 0;
    let replyParseSuccess = 0;
    let nonTextCount = 0;
    let filteredNodeCount =
      selected.nodes.length - visibleNodes.length + levelResult.filteredReplies;

    for (const node of mainNodes) {
      const author = extractAuthor(node);
      const textResult = extractCommentText(
        node,
        author.name,
        author.element
      );
      if (!hasCommentText(textResult.text)) {
        filteredNodeCount += 1;
        if (textResult.foundBySelector || textResult.text || node.querySelector('img, [data-e2e*="sticker"]')) nonTextCount += 1;
        continue;
      }

      const like = extractLikeCount(node);
      const reply = extractReplyCount(node);
      const publishTimeText = extractPublishTime(node);
      const nativeId = extractNativeId(node);
      const id =
        nativeId !== null
          ? `native_${nativeId}`
          : createFallbackCommentId({
              videoId: video.videoId,
              authorName: author.name,
              text: textResult.text,
              publishTimeText
            });
      const parseWarnings: string[] = [];
      if (!author.name) parseWarnings.push("未读取到作者");
      if (!like.parsed) parseWarnings.push("点赞数未明确展示或无法解析");
      if (!reply.parsed) parseWarnings.push("回复数未明确展示");
      if (!textResult.foundBySelector) {
        parseWarnings.push("评论正文由语义规则识别");
      }

      let originalIndex = this.originalIndices.get(id);
      if (originalIndex === undefined) {
        if (this.nextOriginalIndex >= MAX_COLLECTED_COMMENTS) continue;
        originalIndex = this.nextOriginalIndex;
        this.originalIndices.set(id, originalIndex);
        this.nextOriginalIndex += 1;
      }

      const comment: CommentItem = {
        id,
        nativeId,
        videoId: video.videoId,
        videoUrl: video.videoUrl,
        videoTitle: video.videoTitle,
        authorName: author.name || "未读取到作者",
        authorUrl: author.url,
        text: textResult.text,
        likeCount: like.value,
        likeCountRaw: like.raw,
        replyCount: reply.value,
        replyCountRaw: reply.raw,
        replyCountEstimated: reply.estimated,
        publishTimeText,
        ipLocationText: extractIpLocation(node),
        originalIndex,
        scannedAt: new Date().toISOString(),
        parseWarnings
      };

      textParseSuccess += 1;
      if (author.name) authorParseSuccess += 1;
      if (like.parsed) likeParseSuccess += 1;
      if (reply.parsed) replyParseSuccess += 1;
      rawComments.push(comment);
      const moveNode = movableNodes.get(node);
      if (moveNode) this.moveNodeByCommentId.set(id, moveNode);
    }

    const deduplicated = deduplicateComments(rawComments);
    for (const comment of deduplicated.comments) {
      const previous = this.commentsById.get(comment.id);
      if (!previous || JSON.stringify({ ...previous, scannedAt: "" }) !== JSON.stringify({ ...comment, scannedAt: "" })) {
        this.changedComments.set(comment.id, comment);
      }
      this.commentsById.set(comment.id, comment);
    }
    // Map insertion order is the first-seen order; updates keep their position.
    const collectedComments = Array.from(this.commentsById.values());
    const diagnostics: SelectorDiagnostics = {
      commentContainerFound: Boolean(container),
      commentContainerSelector: containerMatch.selector,
      commentItemSelector: selected.selector,
      candidateNodeCount: selected.nodes.length,
      commentItemCount: collectedComments.length,
      textParseSuccess,
      authorParseSuccess,
      likeParseSuccess,
      replyParseSuccess,
      filteredNodeCount,
      duplicateCount: deduplicated.duplicateCount,
      elapsedMs: Math.round(performance.now() - startedAt),
      warnings
    };

    if (nonTextCount) warnings.push(`本批已跳过 ${nonTextCount} 条纯表情、图片或符号评论。`);
    let pageStatus = initialStatus;
    if (initialStatus.state === "ready" && collectedComments.length === 0) {
      pageStatus = {
        ...initialStatus,
        state: selected.nodes.length && nonTextCount < mainNodes.length ? "structure-changed" : "comments-empty",
        message: nonTextCount === mainNodes.length && nonTextCount > 0
          ? "本批评论只有表情、图片或符号，已跳过；自动采集会继续加载后面的文字评论。"
          : selected.nodes.length
          ? "找到了评论区域，但没有成功读取评论正文。"
          : "评论区已打开，但当前没有读取到已加载评论。"
      };
    } else if (
      mainNodes.length > nonTextCount &&
      diagnosticRate(textParseSuccess, mainNodes.length - nonTextCount) <
        LOW_PARSE_SUCCESS_RATE
    ) {
      pageStatus = {
        ...initialStatus,
        state: "structure-changed",
        message: "评论正文识别率偏低，请重新扫描或复制诊断信息。"
      };
      diagnostics.warnings.push("评论正文识别率偏低。");
    }

    const htmlContainer = container as HTMLElement | null;
    const likelyHasUnloadedComments =
      Boolean(
        htmlContainer &&
          (htmlContainer.scrollHeight > htmlContainer.clientHeight ||
            /(?:展开|查看|还有)\s*[\d.,万亿wW+]*\s*条?\s*回复/u.test(
              htmlContainer.innerText
            ))
      ) || collectedComments.length > 0;

    return {
      pageStatus,
      observedCommentSignature: mainNodes.length ? JSON.stringify([mainNodes.length, ...[mainNodes[0]!, mainNodes[mainNodes.length - 1]!].map(node => extractNativeId(node) ?? cleanText(node.textContent).slice(0, 600))]) : "",
      comments: collectedComments,
      mainCommentCount: collectedComments.length,
      scannedAt: new Date().toISOString(),
      likelyHasUnloadedComments,
      diagnostics
    };
  }

  public reorder(
    comments: readonly CommentItem[],
    label: string
  ): ReorderResult {
    if (this.moveNodeByCommentId.size > 2000) {
      return { movedCount: 0, groupCount: 0, message: `已选择${label}，导出时应用排序；当前网页评论较多，保留页面顺序以避免卡顿。` };
    }
    const groups = new Map<Element, Set<Element>>();
    for (const comment of comments) {
      const moveNode = this.moveNodeByCommentId.get(comment.id);
      const parent = moveNode?.parentElement;
      if (!moveNode?.isConnected || !parent) continue;
      const units = groups.get(parent) ?? new Set<Element>();
      units.add(moveNode);
      groups.set(parent, units);
    }

    let movedCount = 0;
    let groupCount = 0;
    for (const [parent, unitSet] of groups) {
      const units = Array.from(unitSet);
      if (units.length < 2) continue;
      const currentUnits = Array.from(parent.children).filter((child) =>
        unitSet.has(child)
      );
      if (currentUnits.length !== units.length) continue;
      const markers = currentUnits.map((unit) => {
        const marker = document.createComment("dcs-comment-sort-position");
        parent.insertBefore(marker, unit);
        return marker;
      });
      units.forEach((unit, index) => {
        const marker = markers[index];
        if (marker) parent.insertBefore(unit, marker);
      });
      markers.forEach((marker) => marker.remove());
      movedCount += units.length;
      groupCount += 1;
    }

    return {
      movedCount,
      groupCount,
      message:
        movedCount > 0
          ? `已按${label}调整${movedCount}条主评论。`
          : "当前评论节点无法安全调整，请滚动评论区后重新扫描。"
    };
  }

}
