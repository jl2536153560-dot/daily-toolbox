"use strict";
(() => {
  // src/shared/constants.ts
  var OBSERVER_DEBOUNCE_MS = 450;
  var LOW_PARSE_SUCCESS_RATE = 0.45;
  var MAX_COLLECTED_COMMENTS = 1e5;

  // src/utils/deduplicate.ts
  function deduplicateComments(comments) {
    const seen = /* @__PURE__ */ new Set();
    const unique = [];
    let duplicateCount = 0;
    for (const comment of comments) {
      const key = `${comment.videoId}${comment.id}`;
      if (seen.has(key)) {
        duplicateCount += 1;
        continue;
      }
      seen.add(key);
      unique.push(comment);
    }
    return { comments: unique, duplicateCount };
  }

  // src/utils/hash.ts
  function fnv1a(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }
  function createFallbackCommentId(input) {
    const source = [
      input.videoId,
      input.authorName.trim(),
      input.text.trim(),
      input.publishTimeText ?? ""
    ].join("");
    return `fallback_${fnv1a(source)}`;
  }

  // src/adapters/douyin/selectors.ts
  var DOUYIN_SELECTORS = {
    commentContainers: [
      '[data-e2e="comment-list"]',
      '[data-e2e="comment-list-container"]',
      '[data-e2e="feed-comment-list"]',
      '[data-e2e="comment-panel"]',
      '[data-testid="comment-list"]',
      '[aria-label*="\u8BC4\u8BBA\u5217\u8868"]',
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
      '[aria-label*="\u70B9\u8D5E"]',
      '[aria-label*="\u8D5E"]',
      '[title*="\u70B9\u8D5E"]',
      '[class*="comment-like"]',
      '[class*="CommentLike"]'
    ],
    replyCount: [
      '[data-e2e="comment-reply-count"]',
      '[data-testid="comment-reply-count"]',
      '[aria-label*="\u6761\u56DE\u590D"]',
      '[class*="reply-count"]',
      '[class*="ReplyCount"]'
    ],
    publishTime: [
      '[data-e2e="comment-time"]',
      '[data-testid="comment-time"]',
      "time",
      '[class*="comment-time"]',
      '[class*="CommentTime"]'
    ]
  };

  // src/adapters/douyin/detector.ts
  function cleanText(value) {
    return (value ?? "").replaceAll(/\s+/g, " ").trim();
  }
  function isVisible(element) {
    if (!(element instanceof HTMLElement)) return true;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
  }
  function ownText(element) {
    return cleanText(
      Array.from(element.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent ?? "").join(" ")
    );
  }
  function findFirst(root, selectors) {
    for (const selector of selectors) {
      const element = Array.from(root.querySelectorAll(selector)).find(isVisible);
      if (element) return { element, selector };
    }
    return { element: null, selector: null };
  }
  function isDouyinPage(url = location.href) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:" && parsed.hostname === "www.douyin.com";
    } catch {
      return false;
    }
  }
  function getVideoContext() {
    const videoUrl = location.href;
    const parsed = new URL(videoUrl);
    const pathMatch = parsed.pathname.match(/\/video\/(\d+)/);
    const queryId = parsed.searchParams.get("modal_id") ?? parsed.searchParams.get("video_id") ?? "";
    const activeVideoLink = document.querySelector(
      'a[href*="/video/"][aria-current="true"], a[href*="/video/"][data-e2e*="active"]'
    );
    const activeMatch = activeVideoLink?.href.match(/\/video\/(\d+)/);
    const videoId = pathMatch?.[1] || queryId || activeMatch?.[1] || "";
    const metaTitle = document.querySelector('meta[property="og:title"]')?.content.trim() ?? "";
    const headingTitle = document.querySelector(
      '[data-e2e="video-desc"], [data-testid="video-title"], h1'
    )?.textContent?.trim() ?? "";
    const documentTitle = document.title.replace(/\s*[-_｜|]\s*抖音.*$/u, "").trim();
    return {
      videoId,
      videoUrl,
      videoTitle: metaTitle || headingTitle || documentTitle || "\u672A\u8BFB\u53D6\u5230\u89C6\u9891\u6807\u9898"
    };
  }
  function findCommentHeader() {
    const elements = Array.from(
      document.querySelectorAll("h1, h2, h3, div, span, p")
    ).slice(0, 12e3);
    return elements.find((element) => {
      if (!isVisible(element)) return false;
      const text = ownText(element) || cleanText(element.textContent);
      return /^全部评论\s*[（(]?\s*[\d,.万亿wW+]+/u.test(text);
    }) ?? null;
  }
  function findCommentInput() {
    return document.querySelector(
      'textarea[placeholder*="\u8BC4\u8BBA"], input[placeholder*="\u8BC4\u8BBA"], [contenteditable="true"][data-placeholder*="\u8BC4\u8BBA"], [contenteditable="true"][aria-label*="\u8BC4\u8BBA"]'
    );
  }
  function smallestSharedAncestor(first, second) {
    let current = first;
    for (let level = 0; current && level < 12; level += 1) {
      const text = cleanText(current.textContent);
      const userCount = current.querySelectorAll('a[href*="/user/"]').length;
      const containsSecond = !second || current.contains(second);
      if (containsSecond && userCount > 0 && text.length >= 10 && text.length <= 2e5) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }
  function findSemanticCommentContainer() {
    const header = findCommentHeader();
    const input = findCommentInput();
    if (header) {
      const shared = smallestSharedAncestor(header, input);
      if (shared) {
        return { element: shared, selector: "\u8BED\u4E49\uFF1A\u5168\u90E8\u8BC4\u8BBA\u6807\u9898\u4E0E\u8BC4\u8BBA\u8F93\u5165\u6846" };
      }
    }
    if (input) {
      let current = input;
      for (let level = 0; current && level < 12; level += 1) {
        const userCount = current.querySelectorAll('a[href*="/user/"]').length;
        if (userCount >= 2) {
          return { element: current, selector: "\u8BED\u4E49\uFF1A\u8BC4\u8BBA\u8F93\u5165\u6846\u4E0E\u4F5C\u8005\u94FE\u63A5" };
        }
        current = current.parentElement;
      }
    }
    return { element: null, selector: null };
  }
  function findCommentContainer() {
    const explicit = findFirst(document, DOUYIN_SELECTORS.commentContainers);
    return explicit.element ? explicit : findSemanticCommentContainer();
  }
  function findToolbarAnchor(container) {
    const localElements = Array.from(
      container.querySelectorAll("h1, h2, h3, div, span, p")
    ).slice(0, 3e3);
    return localElements.find((element) => {
      const text = ownText(element) || cleanText(element.textContent);
      return /^全部评论\s*[（(]?\s*[\d,.万亿wW+]+/u.test(text);
    }) ?? null;
  }
  function isScrollable(element) {
    const style = getComputedStyle(element);
    return /(?:auto|scroll|overlay)/u.test(style.overflowY) && element.scrollHeight > element.clientHeight + 24;
  }
  function findCommentScroller() {
    const container = findCommentContainer().element;
    if (!container) return null;
    const descendant = Array.from(
      container.querySelectorAll("div, section")
    ).filter(
      (element) => isVisible(element) && isScrollable(element) && element.querySelector('a[href*="/user/"]')
    ).sort(
      (left, right) => right.scrollHeight - right.clientHeight - (left.scrollHeight - left.clientHeight)
    )[0];
    if (descendant) return descendant;
    let current = container;
    for (let level = 0; current && level < 10; level += 1) {
      if (isScrollable(current)) return current;
      current = current.parentElement;
    }
    const page = document.scrollingElement;
    if (page && page.scrollHeight > page.clientHeight + 24 && page.contains(container)) return page;
    return null;
  }
  function getCommentLoadState() {
    const container = findCommentContainer().element;
    if (!container) return { available: false, loading: false, atEnd: false, atBottom: false };
    const scroller = findCommentScroller();
    const frame = scroller ?? container;
    const atBottom = frame.clientHeight > 0 && frame.scrollHeight - frame.scrollTop - frame.clientHeight <= 8;
    const candidates = /* @__PURE__ */ new Set([
      ...container.querySelectorAll('[aria-busy="true"], [role="status"], [class*="loading"], [class*="Loading"], [class*="load-more"], [class*="end"], [data-e2e*="end"]'),
      ...Array.from(container.querySelectorAll("span, p, div")).slice(-120)
    ]);
    const commentSelector = [...DOUYIN_SELECTORS.commentItems, ...DOUYIN_SELECTORS.commentText, "[data-comment-id]", "[data-cid]", '[data-e2e="comment-level-2"]', '[class*="reply"]'].join(",");
    let loading = container.getAttribute("aria-busy") === "true";
    let atEnd = false;
    for (const node of candidates) {
      if (!isVisible(node) || node.closest(commentSelector)) continue;
      let row = node.parentElement;
      let inComment = false;
      for (let level = 0; row && row !== container && level < 3; level++, row = row.parentElement) {
        if (row.querySelector('a[href*="/user/"]') && row.querySelector('button, [role="button"]')) {
          inComment = true;
          break;
        }
      }
      if (inComment) continue;
      const text = ownText(node);
      if (node.getAttribute("aria-busy") === "true" || /^(?:正在加载|加载中|加载更多中|正在获取)(?:评论)?[.。…\s]*$/u.test(text)) loading = true;
      const hint = String(node.className || "");
      if (!text && /loading|Loading/u.test(hint) && node.getBoundingClientRect().height > 0) loading = true;
      if (/^(?:没有更多(?:评论)?了?|暂无更多评论|已加载全部评论|全部评论已加载|已显示全部评论|暂时没有更多评论)[.。!！\s]*$/u.test(text)) atEnd = true;
    }
    return {
      available: true,
      loading,
      atEnd,
      atBottom: Boolean(scroller) && atBottom,
      position: frame.scrollTop,
      extent: frame.scrollHeight
    };
  }
  function getPageStatus() {
    const video = getVideoContext();
    if (!isDouyinPage()) {
      return {
        state: "not-douyin",
        message: "\u8BF7\u5148\u6253\u5F00\u6296\u97F3\u7F51\u9875\u7248\u89C6\u9891\u9875\u9762\u3002",
        isDouyin: false,
        hasCommentArea: false,
        ...video
      };
    }
    const container = findCommentContainer();
    if (!container.element) {
      return {
        state: "comment-area-missing",
        message: "\u6682\u672A\u68C0\u6D4B\u5230\u8BC4\u8BBA\u533A\uFF0C\u8BF7\u5148\u6253\u5F00\u89C6\u9891\u8BC4\u8BBA\u533A\u3002",
        isDouyin: true,
        hasCommentArea: false,
        ...video
      };
    }
    return {
      state: "ready",
      message: "\u5DF2\u68C0\u6D4B\u5230\u6296\u97F3\u8BC4\u8BBA\u533A\u3002",
      isDouyin: true,
      hasCommentArea: true,
      ...video
    };
  }

  // src/utils/parse-count.ts
  var MULTIPLIERS = {
    \u4E07: 1e4,
    w: 1e4,
    W: 1e4,
    \u4EBF: 1e8
  };
  function parseCountDetailed(input) {
    const raw = typeof input === "string" ? input : input == null ? "" : String(input);
    const normalized = raw.trim().replaceAll(/\s+/g, "").replaceAll(",", "").replace(/^(点赞|获赞|赞同|回复|评论|共|查看|展开|还有)/, "").replace(/(条)?(回复|评论)$/, "").replace(/\+$/, "");
    if (!normalized || normalized === "\u8D5E" || normalized === "\u6536\u8D77\u56DE\u590D") {
      return { value: 0, raw, parsed: normalized === "" || normalized === "\u8D5E" };
    }
    const match = normalized.match(/^(-?\d+(?:\.\d+)?)(万|亿|w|W)?$/);
    if (!match) return { value: 0, raw, parsed: false };
    const numeric = Number(match[1]);
    const unit = match[2] ?? "";
    if (!Number.isFinite(numeric) || numeric < 0) {
      return { value: 0, raw, parsed: false };
    }
    const multiplier = unit ? MULTIPLIERS[unit] ?? 1 : 1;
    const value = Math.round(numeric * multiplier);
    return {
      value: Number.isSafeInteger(value) ? value : Number.MAX_SAFE_INTEGER,
      raw,
      parsed: true
    };
  }

  // src/adapters/douyin/extractor.ts
  var REPLY_COUNT_PATTERN = /(?:展开|共|查看|还有)?\s*([\d.,]+\s*[万亿wW]?\+?)\s*条?\s*回复/iu;
  var TIME_PATTERN = /(?:刚刚|昨天|\d+\s*(?:秒|分钟|小时|天|周|月|年)前|\d{1,4}[-/.]\d{1,2}[-/.]\d{1,2})/u;
  var ACTION_ONLY_PATTERN = /^(?:回复|评论|分享|转发|收藏|赞|点赞|举报|删除|置顶|作者赞过|收起回复)$/u;
  function cleanText2(value) {
    return (value ?? "").replaceAll(/\s+/g, " ").trim();
  }
  function ownText2(element) {
    return cleanText2(
      Array.from(element.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent ?? "").join(" ")
    );
  }
  function getElementLabel(element) {
    return cleanText2(
      [
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        ownText2(element),
        element.textContent
      ].filter(Boolean).join(" ")
    );
  }
  function isAfter(element, reference) {
    return Boolean(
      reference.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING
    );
  }
  function isBefore(element, reference) {
    return Boolean(
      element.compareDocumentPosition(reference) & Node.DOCUMENT_POSITION_FOLLOWING
    );
  }
  function isInteractionOnlyText(text) {
    const compact = text.replaceAll(/\s+/g, "").replaceAll(/[·•|｜/\\:：,，。;；()（）\[\]【】]/g, "");
    return /^(?:(?:\d+(?:\.\d+)?[万亿wW]?\+?)|回复|评论|分享|转发|收藏|赞|点赞|举报|删除|置顶|作者赞过|收起回复)+$/u.test(
      compact
    );
  }
  function meaningfulCommentText(text, authorName) {
    if (!text || text === authorName || text.length > 2400) return false;
    if (ACTION_ONLY_PATTERN.test(text)) return false;
    if (isInteractionOnlyText(text)) return false;
    if (REPLY_COUNT_PATTERN.test(text)) return false;
    if (TIME_PATTERN.test(text) && text.length <= 40) return false;
    if (/^IP(?:属地)?\s*[:：]?/u.test(text)) return false;
    if (/^[\d.,]+\s*[万亿wW]?\+?$/u.test(text)) return false;
    return !/^(?:回复|分享|点赞)\s*[\d.,万亿wW+]*$/u.test(text);
  }
  function findActionRow(node) {
    const candidates = Array.from(
      node.querySelectorAll(
        'button, [role="button"], div, span'
      )
    ).filter((element) => {
      const text = ownText2(element) || cleanText2(element.textContent);
      const label = cleanText2(element.getAttribute("aria-label"));
      return text === "\u56DE\u590D" || text === "\u8BC4\u8BBA" || label === "\u56DE\u590D" || label === "\u8BC4\u8BBA";
    });
    for (const candidate of candidates) {
      let current = candidate;
      for (let level = 0; current && level < 5; level += 1) {
        const text = cleanText2(current.textContent);
        const controls = current.querySelectorAll(
          'button, [role="button"], svg'
        ).length;
        if (text.includes("\u5206\u4EAB") && controls >= 2 || controls >= 3) {
          return current;
        }
        current = current.parentElement;
        if (current === node.parentElement) break;
      }
    }
    return candidates[0]?.parentElement ?? null;
  }
  function extractAuthor(node) {
    const candidates = /* @__PURE__ */ new Set();
    for (const selector of DOUYIN_SELECTORS.author) {
      node.querySelectorAll(selector).forEach((element2) => {
        candidates.add(element2);
      });
    }
    const elements = Array.from(candidates);
    const element = elements.find((candidate) => {
      const text = cleanText2(candidate.textContent);
      return text.length > 0 && text.length <= 100;
    }) ?? findFirst(node, DOUYIN_SELECTORS.author).element;
    const anchor = element instanceof HTMLAnchorElement ? element : element?.closest("a[href]");
    return {
      name: cleanText2(element?.textContent),
      url: anchor?.href ?? null,
      element
    };
  }
  function extractCommentText(node, authorName, authorElement) {
    const actionRow = findActionRow(node);
    const explicit = findFirst(node, DOUYIN_SELECTORS.commentText).element;
    const explicitText = cleanText2(explicit?.textContent);
    const explicitIsSeparateFromActions = !explicit || !actionRow || !actionRow.contains(explicit) && !explicit.contains(actionRow);
    if (explicitIsSeparateFromActions && meaningfulCommentText(explicitText, authorName)) {
      return { text: explicitText, foundBySelector: true };
    }
    const elements = Array.from(
      node.querySelectorAll("div, span, p")
    ).slice(0, 500);
    const scored = [];
    const directPieces = [];
    for (const element of elements) {
      if (actionRow && (actionRow === element || actionRow.contains(element))) {
        continue;
      }
      if (authorElement && !isAfter(element, authorElement)) continue;
      if (actionRow && !isBefore(element, actionRow)) continue;
      if (element.querySelector('a[href*="/user/"]')) continue;
      const direct = ownText2(element);
      const full = direct || (element.childElementCount <= 6 ? cleanText2(element.textContent) : "");
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
    const text = combined.length > best.length && combined.length <= 2400 && directPieces.length <= 30 ? combined : best;
    return { text, foundBySelector: false };
  }
  function extractLikeCount(node) {
    const actionRow = findActionRow(node);
    const searchRoot = actionRow ?? node;
    const explicit = findFirst(searchRoot, DOUYIN_SELECTORS.likeCount).element;
    const explicitLabel = explicit ? getElementLabel(explicit) : "";
    const explicitRaw = explicitLabel.match(/([\d.,]+\s*[万亿wW]?\+?)/u)?.[1] ?? (explicitLabel === "\u8D5E" ? "\u8D5E" : "");
    if (explicitRaw) {
      const parsed2 = parseCountDetailed(explicitRaw);
      return { value: parsed2.value, raw: explicitRaw, parsed: parsed2.parsed };
    }
    const numericCandidates = Array.from(
      searchRoot.querySelectorAll(
        'button, [role="button"], span, div'
      )
    ).map((element, index) => {
      const text = ownText2(element) || cleanText2(element.textContent);
      const raw2 = text.match(/^([\d.,]+\s*[万亿wW]?\+?)$/u)?.[1] ?? "";
      const hint = `${element.className} ${element.getAttribute("aria-label") ?? ""}`.toLocaleLowerCase();
      return {
        raw: raw2,
        index,
        score: /(like|digg|赞|heart)/u.test(hint) ? 1e3 + index : index
      };
    }).filter((candidate) => candidate.raw).sort((left, right) => right.score - left.score);
    const raw = numericCandidates[0]?.raw ?? "";
    if (!raw) return { value: 0, raw: "", parsed: false };
    const parsed = parseCountDetailed(raw);
    return { value: parsed.value, raw, parsed: parsed.parsed };
  }
  function extractReplyCount(node) {
    const explicit = findFirst(node, DOUYIN_SELECTORS.replyCount).element;
    const candidates = [
      explicit ? getElementLabel(explicit) : "",
      ...Array.from(node.querySelectorAll("button, span, div")).slice(0, 500).map((element) => ownText2(element)).filter(Boolean),
      cleanText2(node.textContent)
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
  function extractPublishTime(node) {
    const explicit = findFirst(node, DOUYIN_SELECTORS.publishTime).element;
    const explicitText = cleanText2(explicit?.textContent);
    if (explicitText && TIME_PATTERN.test(explicitText)) return explicitText;
    const pieces = Array.from(
      node.querySelectorAll("time, span, div")
    ).slice(0, 500).map((element) => ownText2(element) || cleanText2(element.textContent)).filter((text) => text.length <= 80);
    return pieces.find((text) => TIME_PATTERN.test(text)) ?? null;
  }
  function extractIpLocation(node) {
    const pieces = Array.from(
      node.querySelectorAll("time, span, div, p")
    ).slice(0, 500).map((element) => ownText2(element)).filter((text) => text.length > 0 && text.length <= 80);
    for (const text of pieces) {
      const explicit = text.match(
        /IP(?:属地)?\s*[:：]?\s*([^\s·|]{1,20})$/u
      );
      if (explicit) return explicit[0].trim();
      const timeAndLocation = text.match(
        /(?:刚刚|昨天|\d+\s*(?:秒|分钟|小时|天|周|月|年)前|\d{1,4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?)\s*[·・|]\s*([^\s·|]{1,20})$/u
      );
      if (timeAndLocation?.[1]) {
        return `IP\u5C5E\u5730\uFF1A${timeAndLocation[1]}`;
      }
    }
    return null;
  }
  function extractNativeId(node) {
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
    const link = node.querySelector(
      'a[href*="comment_id="], a[href*="commentId="], a[href*="cid="]'
    );
    if (!link) return null;
    const parsed = new URL(link.href, location.href);
    return parsed.searchParams.get("comment_id") ?? parsed.searchParams.get("commentId") ?? parsed.searchParams.get("cid");
  }

  // src/adapters/douyin/DouyinAdapter.ts
  function cleanText3(value) {
    return (value ?? "").replaceAll(/\s+/g, " ").trim();
  }
  function isVisible2(element) {
    if (!(element instanceof HTMLElement)) return true;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
  }
  function selectLargestCandidateSet(root) {
    let best = { nodes: [], selector: null };
    for (const selector of DOUYIN_SELECTORS.commentItems) {
      const nodes = Array.from(root.querySelectorAll(selector)).filter(isVisible2);
      if (nodes.length > best.nodes.length) best = { nodes, selector };
    }
    return best;
  }
  function authorElements(root) {
    const found = /* @__PURE__ */ new Set();
    for (const selector of DOUYIN_SELECTORS.author) {
      root.querySelectorAll(selector).forEach((element) => found.add(element));
    }
    return Array.from(found).filter(isVisible2);
  }
  function scoreCommentRoot(candidate, author) {
    const text = cleanText3(candidate.textContent);
    if (text.length < 5 || text.length > 6e3 || /全部评论/u.test(text)) {
      return -1;
    }
    const authorCount = authorElements(candidate).length;
    if (authorCount === 0 || authorCount > 4) return -1;
    let score = 0;
    if (candidate.contains(author)) score += 3;
    if (authorCount === 1) score += 4;
    if (findActionRow(candidate)) score += 6;
    if (/(?:刚刚|昨天|\d+\s*(?:秒|分钟|小时|天|周|月|年)前|\d{1,4}[-/.]\d{1,2})/u.test(
      text
    )) {
      score += 4;
    }
    if (/(?:展开|查看|共|还有)\s*[\d.,万亿wW+]+\s*条?\s*回复/u.test(text)) {
      score += 2;
    }
    if (candidate.querySelector('button, [role="button"], svg')) score += 2;
    if (text.length >= 12) score += 1;
    return score;
  }
  function semanticCommentNodes(root) {
    const found = /* @__PURE__ */ new Set();
    const scoredAncestors = /* @__PURE__ */ new WeakMap();
    for (const author of authorElements(root)) {
      let current = author.parentElement;
      let best = null;
      for (let level = 0; current && level < 9; level += 1) {
        if (!root.contains(current)) break;
        let scored = scoredAncestors.get(current);
        if (!scored) {
          scored = { score: scoreCommentRoot(current, author), length: cleanText3(current.textContent).length };
          scoredAncestors.set(current, scored);
        }
        const { score, length } = scored;
        if (score >= 7 && (!best || score > best.score || score === best.score && length < best.length)) {
          best = { node: current, score, length };
        }
        if (current === root) break;
        current = current.parentElement;
      }
      if (best) found.add(best.node);
    }
    return Array.from(found);
  }
  function nearestCandidateParent(node, candidateSet) {
    let parent = node.parentElement;
    while (parent && parent !== document.body) {
      if (candidateSet.has(parent)) return parent;
      parent = parent.parentElement;
    }
    return null;
  }
  function elementStructureHint(element) {
    return [
      element.id,
      element.className,
      element.getAttribute("data-e2e"),
      element.getAttribute("data-testid"),
      element.getAttribute("data-comment-level"),
      element.getAttribute("aria-label")
    ].filter(Boolean).join(" ").toLocaleLowerCase();
  }
  function hasExplicitReplyStructure(node, container) {
    const levelOne = node.querySelector('[data-e2e="comment-level-1"]');
    const levelTwo = node.querySelector('[data-e2e="comment-level-2"]');
    if (levelTwo && !levelOne) return true;
    let current = node;
    for (let level = 0; current && level < 12; level += 1) {
      if (/reply[-_]?(?:item|list|container|comment)|comment[-_]?reply|sub[-_]?(?:comment|reply)|comment[-_]?level[-_]?2|level[-_]?2/iu.test(
        elementStructureHint(current)
      )) {
        return true;
      }
      if (current === container) break;
      current = current.parentElement;
    }
    return false;
  }
  function collapseCommentThreads(nodes, container) {
    if (!container || nodes.length < 2) {
      return { nodes, filteredReplies: 0 };
    }
    const parentGroups = /* @__PURE__ */ new Map();
    for (const node of nodes) {
      let branch = node;
      let parent = node.parentElement;
      for (let level = 0; parent && level < 14; level += 1) {
        if (!container.contains(parent) && parent !== container) break;
        const branches = parentGroups.get(parent) ?? /* @__PURE__ */ new Map();
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
    })).filter(({ branches }) => branches.size >= 2).sort(
      (left, right) => right.coverage - left.coverage || right.branches.size - left.branches.size
    );
    const best = candidates[0];
    if (!best || best.coverage < Math.ceil(nodes.length * 0.6)) {
      return { nodes, filteredReplies: 0 };
    }
    const selected = /* @__PURE__ */ new Set();
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
  function mainLevelNodes(nodes, container) {
    const withoutExplicitReplies = nodes.filter(
      (node) => !hasExplicitReplyStructure(node, container)
    );
    const explicitReplyCount = nodes.length - withoutExplicitReplies.length;
    const collapsed = collapseCommentThreads(
      withoutExplicitReplies,
      container
    );
    const candidateSet = new Set(collapsed.nodes);
    const leftValues = collapsed.nodes.map((node) => node.getBoundingClientRect().left).filter((value) => Number.isFinite(value) && value > 0);
    const minLeft = leftValues.length ? leftValues.reduce((minimum, value) => Math.min(minimum, value), Infinity) : 0;
    const main = [];
    let filteredReplies = explicitReplyCount + collapsed.filteredReplies;
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
  function diagnosticRate(success, total) {
    return total === 0 ? 0 : success / total;
  }
  function selectMovableNodes(nodes, container) {
    const groups = /* @__PURE__ */ new Map();
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
    const selected = /* @__PURE__ */ new Map();
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
  var DouyinAdapter = class {
    originalIndices = /* @__PURE__ */ new Map();
    moveNodeByCommentId = /* @__PURE__ */ new Map();
    commentsById = /* @__PURE__ */ new Map();
    changedComments = /* @__PURE__ */ new Map();
    nextOriginalIndex = 0;
    videoKey = "";
    getPageStatus() {
      return getPageStatus();
    }
    clear() {
      this.originalIndices.clear();
      this.moveNodeByCommentId.clear();
      this.commentsById.clear();
      this.changedComments.clear();
      this.nextOriginalIndex = 0;
      this.videoKey = "";
    }
    restore(videoKey, comments) {
      this.clear();
      this.videoKey = videoKey;
      for (const comment of comments.slice(0, MAX_COLLECTED_COMMENTS)) {
        if (comment.videoId !== videoKey || this.commentsById.has(comment.id)) continue;
        const restored = { ...comment, originalIndex: this.nextOriginalIndex++ };
        this.commentsById.set(comment.id, restored);
        this.originalIndices.set(comment.id, restored.originalIndex);
      }
    }
    drainChanges() {
      const changed = Array.from(this.changedComments.values());
      this.changedComments.clear();
      return changed;
    }
    retainChanges(comments) {
      for (const comment of comments) if (!this.changedComments.has(comment.id)) this.changedComments.set(comment.id, comment);
    }
    scan() {
      const startedAt = performance.now();
      const initialStatus = getPageStatus();
      const video = getVideoContext();
      const nextVideoKey = video.videoId || video.videoUrl;
      if (this.videoKey && this.videoKey !== nextVideoKey) this.clear();
      this.videoKey = nextVideoKey;
      const containerMatch = findCommentContainer();
      const container = containerMatch.element;
      const warnings = [];
      let selected = { nodes: [], selector: null };
      if (container) {
        const semanticNodes = semanticCommentNodes(container);
        if (semanticNodes.length > 0) {
          selected = {
            nodes: semanticNodes,
            selector: "\u8BED\u4E49\uFF1A\u4F5C\u8005\u3001\u65F6\u95F4\u4E0E\u8BC4\u8BBA\u64CD\u4F5C\u533A"
          };
        } else {
          selected = selectLargestCandidateSet(container);
          if (selected.nodes.length > 0) {
            warnings.push("\u672A\u5F62\u6210\u8BED\u4E49\u8BC4\u8BBA\u8FB9\u754C\uFF0C\u5DF2\u4F7F\u7528\u5019\u9009\u8BC4\u8BBA\u8282\u70B9\u3002");
          }
        }
      }
      const visibleNodes = selected.nodes.filter(isVisible2);
      const levelResult = mainLevelNodes(visibleNodes, container);
      const mainNodes = levelResult.main;
      const movableNodes = container ? selectMovableNodes(mainNodes, container) : /* @__PURE__ */ new Map();
      const rawComments = [];
      this.moveNodeByCommentId.clear();
      let textParseSuccess = 0;
      let authorParseSuccess = 0;
      let likeParseSuccess = 0;
      let replyParseSuccess = 0;
      let filteredNodeCount = selected.nodes.length - visibleNodes.length + levelResult.filteredReplies;
      for (const node of mainNodes) {
        const author = extractAuthor(node);
        const textResult = extractCommentText(
          node,
          author.name,
          author.element
        );
        if (!textResult.text) {
          filteredNodeCount += 1;
          continue;
        }
        const like = extractLikeCount(node);
        const reply = extractReplyCount(node);
        const publishTimeText = extractPublishTime(node);
        const nativeId = extractNativeId(node);
        const id = nativeId !== null ? `native_${nativeId}` : createFallbackCommentId({
          videoId: video.videoId,
          authorName: author.name,
          text: textResult.text,
          publishTimeText
        });
        const parseWarnings = [];
        if (!author.name) parseWarnings.push("\u672A\u8BFB\u53D6\u5230\u4F5C\u8005");
        if (!like.parsed) parseWarnings.push("\u70B9\u8D5E\u6570\u672A\u660E\u786E\u5C55\u793A\u6216\u65E0\u6CD5\u89E3\u6790");
        if (!reply.parsed) parseWarnings.push("\u56DE\u590D\u6570\u672A\u660E\u786E\u5C55\u793A");
        if (!textResult.foundBySelector) {
          parseWarnings.push("\u8BC4\u8BBA\u6B63\u6587\u7531\u8BED\u4E49\u89C4\u5219\u8BC6\u522B");
        }
        let originalIndex = this.originalIndices.get(id);
        if (originalIndex === void 0) {
          if (this.nextOriginalIndex >= MAX_COLLECTED_COMMENTS) continue;
          originalIndex = this.nextOriginalIndex;
          this.originalIndices.set(id, originalIndex);
          this.nextOriginalIndex += 1;
        }
        const comment = {
          id,
          nativeId,
          videoId: video.videoId,
          videoUrl: video.videoUrl,
          videoTitle: video.videoTitle,
          authorName: author.name || "\u672A\u8BFB\u53D6\u5230\u4F5C\u8005",
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
          scannedAt: (/* @__PURE__ */ new Date()).toISOString(),
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
      const collectedComments = Array.from(this.commentsById.values());
      const diagnostics = {
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
      let pageStatus = initialStatus;
      if (initialStatus.state === "ready" && collectedComments.length === 0) {
        pageStatus = {
          ...initialStatus,
          state: selected.nodes.length ? "structure-changed" : "comments-empty",
          message: selected.nodes.length ? "\u627E\u5230\u4E86\u8BC4\u8BBA\u533A\u57DF\uFF0C\u4F46\u6CA1\u6709\u6210\u529F\u8BFB\u53D6\u8BC4\u8BBA\u6B63\u6587\u3002" : "\u8BC4\u8BBA\u533A\u5DF2\u6253\u5F00\uFF0C\u4F46\u5F53\u524D\u6CA1\u6709\u8BFB\u53D6\u5230\u5DF2\u52A0\u8F7D\u8BC4\u8BBA\u3002"
        };
      } else if (mainNodes.length > 0 && diagnosticRate(textParseSuccess, mainNodes.length) < LOW_PARSE_SUCCESS_RATE) {
        pageStatus = {
          ...initialStatus,
          state: "structure-changed",
          message: "\u8BC4\u8BBA\u6B63\u6587\u8BC6\u522B\u7387\u504F\u4F4E\uFF0C\u8BF7\u91CD\u65B0\u626B\u63CF\u6216\u590D\u5236\u8BCA\u65AD\u4FE1\u606F\u3002"
        };
        diagnostics.warnings.push("\u8BC4\u8BBA\u6B63\u6587\u8BC6\u522B\u7387\u504F\u4F4E\u3002");
      }
      const htmlContainer = container;
      const likelyHasUnloadedComments = Boolean(
        htmlContainer && (htmlContainer.scrollHeight > htmlContainer.clientHeight || /(?:展开|查看|还有)\s*[\d.,万亿wW+]*\s*条?\s*回复/u.test(
          htmlContainer.innerText
        ))
      ) || collectedComments.length > 0;
      return {
        pageStatus,
        comments: collectedComments,
        mainCommentCount: collectedComments.length,
        scannedAt: (/* @__PURE__ */ new Date()).toISOString(),
        likelyHasUnloadedComments,
        diagnostics
      };
    }
    reorder(comments, label) {
      if (this.moveNodeByCommentId.size > 2e3) {
        return { movedCount: 0, groupCount: 0, message: `\u5DF2\u9009\u62E9${label}\uFF0C\u5BFC\u51FA\u65F6\u5E94\u7528\u6392\u5E8F\uFF1B\u5F53\u524D\u7F51\u9875\u8BC4\u8BBA\u8F83\u591A\uFF0C\u4FDD\u7559\u9875\u9762\u987A\u5E8F\u4EE5\u907F\u514D\u5361\u987F\u3002` };
      }
      const groups = /* @__PURE__ */ new Map();
      for (const comment of comments) {
        const moveNode = this.moveNodeByCommentId.get(comment.id);
        const parent = moveNode?.parentElement;
        if (!moveNode?.isConnected || !parent) continue;
        const units = groups.get(parent) ?? /* @__PURE__ */ new Set();
        units.add(moveNode);
        groups.set(parent, units);
      }
      let movedCount = 0;
      let groupCount = 0;
      for (const [parent, unitSet] of groups) {
        const units = Array.from(unitSet);
        if (units.length < 2) continue;
        const currentUnits = Array.from(parent.children).filter(
          (child) => unitSet.has(child)
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
        message: movedCount > 0 ? `\u5DF2\u6309${label}\u8C03\u6574${movedCount}\u6761\u4E3B\u8BC4\u8BBA\u3002` : "\u5F53\u524D\u8BC4\u8BBA\u8282\u70B9\u65E0\u6CD5\u5B89\u5168\u8C03\u6574\uFF0C\u8BF7\u6EDA\u52A8\u8BC4\u8BBA\u533A\u540E\u91CD\u65B0\u626B\u63CF\u3002"
      };
    }
  };

  // src/shared/messages.ts
  function isActivateToolbarRequest(value) {
    if (!value || typeof value !== "object") return false;
    const candidate = value;
    return candidate.type === "DCS_ACTIVATE_TOOLBAR";
  }

  // src/utils/debounce.ts
  function debounce(callback, waitMs) {
    let timer;
    const debounced = ((...args) => {
      if (timer !== void 0) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = void 0;
        callback(...args);
      }, waitMs);
    });
    debounced.cancel = () => {
      if (timer !== void 0) clearTimeout(timer);
      timer = void 0;
    };
    return debounced;
  }

  // src/utils/export-csv.ts
  var HEADERS = [
    "\u6392\u540D",
    "\u8BC4\u8BBA\u5185\u5BB9",
    "\u4F5C\u8005",
    "\u70B9\u8D5E\u6570",
    "\u56DE\u590D\u6570",
    "\u53D1\u5E03\u65F6\u95F4"
  ];
  var TIME_PATTERN2 = /(?:刚刚|昨天|\d+\s*(?:秒|分钟|小时|天|周|月|年)前|\d{1,4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?)/u;
  function protectSpreadsheetFormula(value) {
    return /^[\s\uFEFF]*[=+\-@]|^[\t\r\n]/.test(value) ? `'${value}` : value;
  }
  function csvCell(value) {
    const stringValue = protectSpreadsheetFormula(
      value == null ? "" : String(value)
    );
    return `"${stringValue.replaceAll('"', '""')}"`;
  }
  function formatPublishInfo(comment) {
    const rawTime = comment.publishTimeText?.trim() ?? "";
    const time = rawTime.match(TIME_PATTERN2)?.[0]?.replaceAll(/\s+/g, "") ?? "";
    const locationFromTime = rawTime.match(/[·・|]\s*([^\s·・|]{1,20})\s*$/u)?.[1] ?? "";
    const location2 = (comment.ipLocationText ?? "").replace(/^IP(?:属地)?\s*[:：]?\s*/u, "").trim() || locationFromTime;
    if (time && location2) return `${time}\xB7${location2}`;
    return time || location2;
  }
  function exportCommentsCsv(comments) {
    const rows = comments.map((comment, index) => {
      return [
        index + 1,
        comment.text,
        comment.authorName,
        comment.parseWarnings.includes("\u70B9\u8D5E\u6570\u672A\u660E\u786E\u5C55\u793A\u6216\u65E0\u6CD5\u89E3\u6790") ? "" : comment.likeCount,
        comment.parseWarnings.includes("\u56DE\u590D\u6570\u672A\u660E\u786E\u5C55\u793A") ? "" : comment.replyCount,
        formatPublishInfo(comment)
      ];
    });
    return `\uFEFF${[HEADERS, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
  }

  // src/utils/stable-sort.ts
  function compareNumberDesc(left, right) {
    return right - left;
  }
  function stableSortComments(comments, mode) {
    return comments.map((comment, stableIndex) => ({ comment, stableIndex })).sort((left, right) => {
      const a = left.comment;
      const b = right.comment;
      let result = 0;
      if (mode === "likes") {
        result = compareNumberDesc(a.likeCount, b.likeCount) || compareNumberDesc(a.replyCount, b.replyCount);
      } else if (mode === "replies") {
        result = compareNumberDesc(a.replyCount, b.replyCount) || compareNumberDesc(a.likeCount, b.likeCount);
      }
      return result || a.originalIndex - b.originalIndex || left.stableIndex - right.stableIndex;
    }).map(({ comment }) => comment);
  }

  // src/content/collection.ts
  var COLLECTION_LIMITS = [100, 200, 500, 1e3, 5e3, 1e4, 5e4, MAX_COLLECTED_COMMENTS];
  var DEFAULT_PREFERENCES = { target: MAX_COLLECTED_COMMENTS, autoStart: false };
  function normalizePreferences(value) {
    return { target: COLLECTION_LIMITS.includes(value?.target) ? Number(value?.target) : DEFAULT_PREFERENCES.target, autoStart: value?.autoStart === true };
  }
  async function collectComments(driver) {
    const initialIdentity = driver.identity();
    const target = Math.min(MAX_COLLECTED_COMMENTS, Math.max(1, Math.floor(driver.target) || DEFAULT_PREFERENCES.target));
    const now = driver.now ?? (() => performance.now());
    const settleMs = Math.max(0, driver.settleMs ?? 3e4);
    const idleTimeoutMs = Math.max(settleMs, driver.idleTimeoutMs ?? 12e4);
    const maxRounds = driver.maxRounds ?? Number.POSITIVE_INFINITY;
    let result = null;
    let rounds = 0;
    let previousCount = -1;
    let previousState = null;
    let lastProgressAt = now();
    let previousTick = lastProgressAt;
    let bottomStableSince = null;
    let wasSuspended = false;
    for (; ; ) {
      if (driver.signal.aborted) return { scan: result, reason: "cancelled" };
      if (driver.identity() !== initialIdentity) return { scan: null, reason: "video-changed" };
      if (driver.blocked()) return { scan: result, reason: "blocked" };
      const time = now();
      const suspended = driver.suspended?.() === true;
      if (suspended || wasSuspended) {
        const pausedFor = Math.max(0, time - previousTick);
        lastProgressAt += pausedFor;
        if (bottomStableSince !== null) bottomStableSince += pausedFor;
      }
      previousTick = time;
      wasSuspended = suspended;
      if (suspended) {
        await driver.wait();
        continue;
      }
      const state = driver.pageState?.() ?? { available: true, loading: false, atEnd: false, atBottom: false };
      if (state.available) {
        result = driver.scan();
        await driver.progress(result, rounds);
        if (driver.signal.aborted) return { scan: result, reason: "cancelled" };
        if (driver.identity() !== initialIdentity) return { scan: null, reason: "video-changed" };
        if (driver.blocked()) return { scan: result, reason: "blocked" };
        if (driver.suspended?.()) continue;
        const count = result.comments.length;
        if (count >= target) return { scan: result, reason: "target" };
        const countAdvanced = count > previousCount;
        const positionAdvanced = Number.isFinite(state.position) && Number.isFinite(previousState?.position) && state.position > previousState.position + 1;
        const extentAdvanced = Number.isFinite(state.extent) && Number.isFinite(previousState?.extent) && state.extent > previousState.extent + 1;
        if (countAdvanced || positionAdvanced || extentAdvanced || previousState?.available === false) lastProgressAt = time;
        const geometryChanged = state.position !== previousState?.position || state.extent !== previousState?.extent;
        if (!state.loading && state.atEnd) return { scan: result, reason: "end" };
        if (state.atBottom && !state.loading) {
          if (bottomStableSince === null || countAdvanced || geometryChanged) bottomStableSince = time;
          if (time - bottomStableSince >= settleMs) return { scan: result, reason: "end" };
        } else bottomStableSince = null;
        previousCount = count;
      } else bottomStableSince = null;
      previousState = state;
      if (time - lastProgressAt >= idleTimeoutMs) return { scan: result, reason: "paused" };
      if (rounds >= maxRounds) return { scan: result, reason: "round-limit" };
      if (state.available && (!state.loading || !state.atBottom) && driver.scroll()) rounds += 1;
      await driver.wait();
    }
  }
  var STOP_MESSAGES = {
    target: "\u5DF2\u8FBE\u5230\u672C\u6B21\u91C7\u96C6\u4E0A\u9650\uFF0C\u53EF\u6392\u5E8F\u6216\u5BFC\u51FA\u3002",
    end: "\u8BC4\u8BBA\u5DF2\u52A0\u8F7D\u5230\u5E95\uFF0C\u672C\u6B21\u91C7\u96C6\u5B8C\u6210\uFF0C\u53EF\u6392\u5E8F\u6216\u5BFC\u51FA\u3002",
    paused: "\u7F51\u9875\u957F\u65F6\u95F4\u6CA1\u6709\u52A0\u8F7D\u8FDB\u5C55\uFF0C\u5DF2\u4FDD\u5B58\u8FDB\u5EA6\uFF1B\u9875\u9762\u6062\u590D\u540E\u53EF\u4EE5\u7EE7\u7EED\u91C7\u96C6\u3002",
    "round-limit": "\u5DF2\u8FBE\u5230\u672C\u6B21\u6EDA\u52A8\u4FDD\u62A4\u4E0A\u9650\uFF0C\u8FDB\u5EA6\u5DF2\u4FDD\u7559\uFF0C\u53EF\u4EE5\u7EE7\u7EED\u91C7\u96C6\u3002",
    blocked: "\u68C0\u6D4B\u5230\u767B\u5F55\u6216\u9A8C\u8BC1\u63D0\u793A\uFF0C\u5DF2\u6682\u505C\u5E76\u4FDD\u7559\u8FDB\u5EA6\u3002\u8BF7\u5728\u7F51\u9875\u5B8C\u6210\u9A8C\u8BC1\u540E\u7EE7\u7EED\u3002",
    cancelled: "\u5DF2\u505C\u6B62\uFF0C\u5DF2\u6536\u96C6\u7684\u8BC4\u8BBA\u4ECD\u53EF\u5BFC\u51FA\u3002",
    "video-changed": "\u89C6\u9891\u5DF2\u5207\u6362\uFF0C\u4E0A\u4E00\u6B21\u91C7\u96C6\u5DF2\u53D6\u6D88\u3002"
  };

  // node_modules/@phosphor-icons/core/assets/regular/arrows-clockwise.svg
  var arrows_clockwise_default = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><path d="M224,48V96a8,8,0,0,1-8,8H168a8,8,0,0,1,0-16h28.69L182.06,73.37a79.56,79.56,0,0,0-56.13-23.43h-.45A79.52,79.52,0,0,0,69.59,72.71,8,8,0,0,1,58.41,61.27a96,96,0,0,1,135,.79L208,76.69V48a8,8,0,0,1,16,0ZM186.41,183.29a80,80,0,0,1-112.47-.66L59.31,168H88a8,8,0,0,0,0-16H40a8,8,0,0,0-8,8v48a8,8,0,0,0,16,0V179.31l14.63,14.63A95.43,95.43,0,0,0,130,222.06h.53a95.36,95.36,0,0,0,67.07-27.33,8,8,0,0,0-11.18-11.44Z"/></svg>';

  // node_modules/@phosphor-icons/core/assets/regular/copy.svg
  var copy_default = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><path d="M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z"/></svg>';

  // node_modules/@phosphor-icons/core/assets/regular/download-simple.svg
  var download_simple_default = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><path d="M224,144v64a8,8,0,0,1-8,8H40a8,8,0,0,1-8-8V144a8,8,0,0,1,16,0v56H208V144a8,8,0,0,1,16,0Zm-101.66,5.66a8,8,0,0,0,11.32,0l40-40a8,8,0,0,0-11.32-11.32L136,124.69V32a8,8,0,0,0-16,0v92.69L93.66,98.34a8,8,0,0,0-11.32,11.32Z"/></svg>';

  // node_modules/@phosphor-icons/core/assets/regular/stop-circle.svg
  var stop_circle_default = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216ZM160,88H96a8,8,0,0,0-8,8v64a8,8,0,0,0,8,8h64a8,8,0,0,0,8-8V96A8,8,0,0,0,160,88Zm-8,64H104V104h48Z"/></svg>';

  // src/content/sticky-toolbar.ts
  var TOOLBAR_HOST_ID = "xl-comment-toolbar";
  function el(tag, className = "", text = "") {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }
  function button(label, className, handler, svg) {
    const node = el("button", className);
    node.type = "button";
    node.title = label;
    node.setAttribute("aria-label", label);
    if (svg) {
      const icon = el("span", "icon");
      icon.innerHTML = svg.trim();
      icon.setAttribute("aria-hidden", "true");
      node.append(icon);
    }
    node.append(el("span", "label", label));
    node.addEventListener("click", handler);
    return node;
  }
  var CSS = `
:host{display:block;width:100%;color:#24231f;font:13px/1.5 "Microsoft YaHei","PingFang SC",system-ui,sans-serif}
*{box-sizing:border-box}button,select,input{font:inherit}button{cursor:pointer}button:disabled,select:disabled{opacity:.45;cursor:not-allowed}[hidden]{display:none!important}
.content{position:relative;background:#f5f2e9;border:1px solid #292821;border-radius:3px;box-shadow:3px 4px 0 #26251c26;padding:14px;background-image:radial-gradient(#a19a8015 .5px,transparent .5px);background-size:5px 5px}
.masthead{display:flex;align-items:center;justify-content:space-between;gap:10px;padding-bottom:10px;border-bottom:1px solid #25241c;margin-bottom:12px}
.brand{font-weight:900;font-size:19px;letter-spacing:-.7px;white-space:nowrap}.brand em{font-style:normal;color:#f34b30}.edition{font:9px/1.4 ui-monospace,monospace;letter-spacing:1px;text-align:right;white-space:pre-line}.badge{background:#ffe83b;transform:rotate(-4deg);font-size:11px;font-weight:800;padding:2px 7px;border:1px solid #292821;white-space:nowrap}
.bar{display:flex;gap:5px;align-items:center;flex-wrap:wrap}button{display:inline-flex;justify-content:center;align-items:center;gap:5px;min-height:34px;padding:6px 10px;border:1px solid #bdb8aa;border-radius:2px;background:#faf8f0;color:#24231f;white-space:nowrap;font-size:12px;transition:background .12s,transform .12s}button:hover{background:#ffe83b;border-color:#292821}button:active{transform:translateY(1px)}button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid #f34b30;outline-offset:2px}
.sort{flex:1}.sort.active{background:#25241f;color:#fff;border-color:#25241f}.refresh{padding:6px 8px}.refresh .label{display:none}.icon{display:inline-flex;width:16px;height:16px;flex:none}.icon svg{width:100%;height:100%}
.collect-row{display:flex;align-items:center;gap:7px;margin-top:9px;flex-wrap:wrap}.target-label{font-size:11px;color:#676254;display:flex;align-items:center;gap:5px}select{max-width:104px;min-height:35px;border:1px solid #bdb8aa;background:#fffdf7;color:#292821;border-radius:2px;padding:4px}.collect{background:#f34b30;color:white;border-color:#cf3c26;font-weight:700;flex:1}.collect:hover{background:#db3c23;color:white}.stop{background:#ffe83b;border-color:#292821;flex:1;font-weight:700}
.export-wrap{position:relative}.export-toggle{min-height:35px}.export-menu{position:absolute;right:0;top:calc(100% + 6px);background:#faf8f0;border:1px solid #292821;padding:5px;min-width:245px;z-index:9;box-shadow:3px 4px 0 #29282135;display:grid;gap:4px}.export-menu button{justify-content:flex-start;width:100%;border:0;padding:10px;font-size:12px;white-space:normal;text-align:left}
.options-row{display:flex;justify-content:space-between;gap:8px;align-items:center;margin-top:10px}.auto{display:flex;align-items:center;gap:5px;font-size:11px;color:#5b574d;cursor:pointer}.auto input{accent-color:#f34b30;width:14px;height:14px;margin:0}.count{font:700 13px ui-monospace,monospace;color:#f34b30}.count small{font-weight:400;color:#756f61}
progress{display:block;width:100%;height:5px;margin-top:10px;border:0;border-radius:0;accent-color:#f34b30}progress::-webkit-progress-bar{background:#ded9ca}progress::-webkit-progress-value{background:#f34b30}
.status-row{display:flex;gap:6px;align-items:center;margin-top:8px}.status{font-size:11px;color:#6b6556;overflow-wrap:anywhere;flex:1}.status.error{color:#ad3021}.diagnostics{font-size:10px;min-height:26px;padding:3px 5px}.footnote{font-size:9px;letter-spacing:.3px;color:#928a78;margin-top:6px}.pulse{animation:pulse .7s ease}@keyframes pulse{50%{box-shadow:0 0 0 5px #ffe83b88}}@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;
  var StickyCommentToolbar = class {
    constructor(callbacks) {
      this.callbacks = callbacks;
    }
    host = null;
    shadow = null;
    container = null;
    mode = "original";
    count = 0;
    message = "\u6253\u5F00\u8BC4\u8BBA\u533A\u540E\uFF0C\u70B9\u51FB\u81EA\u52A8\u91C7\u96C6\u3002";
    error = false;
    collecting = false;
    menuOpen = false;
    preferences = { ...DEFAULT_PREFERENCES };
    mount(container, anchor) {
      if (this.host?.isConnected && this.container === container) return;
      this.unmount();
      this.container = container;
      document.getElementById(TOOLBAR_HOST_ID)?.remove();
      this.host = el("div");
      this.host.id = TOOLBAR_HOST_ID;
      this.host.dataset.xlUi = "toolbar";
      if (anchor?.parentElement === container) anchor.insertAdjacentElement("afterend", this.host);
      else container.prepend(this.host);
      this.shadow = this.host.attachShadow({ mode: "open" });
      const style = el("style");
      style.textContent = CSS;
      this.shadow.append(style);
      this.render();
    }
    update(mode, count, message, isError = false) {
      this.mode = mode;
      this.count = count;
      this.message = message;
      this.error = isError;
      this.menuOpen = false;
      this.render();
    }
    updateCount(count) {
      if (this.count === count) return;
      this.count = count;
      this.render();
    }
    setPreferences(value) {
      this.preferences = { ...value };
      this.render();
    }
    setCollectionState(collecting, count, message) {
      this.collecting = collecting;
      this.count = count;
      this.message = message;
      this.error = false;
      this.menuOpen = false;
      this.render();
    }
    showError(status, diagnostics) {
      this.update(this.mode, this.count, status.message + (diagnostics?.candidateNodeCount ? ` \u53D1\u73B0 ${diagnostics.candidateNodeCount} \u4E2A\u5019\u9009\u8282\u70B9\u3002` : ""), true);
    }
    reveal() {
      this.host?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      this.shadow?.querySelector(".content")?.classList.add("pulse");
    }
    unmount() {
      this.host?.remove();
      this.host = null;
      this.shadow = null;
      this.container = null;
    }
    destroy() {
      this.unmount();
    }
    render() {
      if (!this.shadow) return;
      this.shadow.querySelector(".content")?.remove();
      const content = el("section", "content");
      content.setAttribute("aria-label", "\u5C0F\u4E50\u6536\u96C6\u8BC4\u8BBA\u52A9\u624B");
      const head = el("div", "masthead");
      const brand = el("div", "brand", "\u5C0F\u4E50\u6536\u96C6 ");
      brand.append(el("em", "", "/"));
      head.append(brand, el("span", "badge", "\u8BC4\u8BBA\u52A9\u624B"), el("span", "edition", "COLLECT\nNO. 02"));
      const bar = el("div", "bar");
      bar.setAttribute("role", "group");
      bar.setAttribute("aria-label", "\u6392\u5E8F\u65B9\u5F0F");
      for (const [mode, label2] of [["original", "\u9875\u9762\u987A\u5E8F"], ["likes", "\u70B9\u8D5E\u6700\u591A"], ["replies", "\u56DE\u590D\u6700\u591A"]]) {
        const b = button(label2, `sort${mode === this.mode ? " active" : ""}`, () => this.callbacks.onSort(mode));
        b.setAttribute("aria-pressed", String(mode === this.mode));
        b.disabled = this.collecting;
        bar.append(b);
      }
      const refresh = button("\u5237\u65B0\u5E76\u91CD\u6392", "refresh", this.callbacks.onRefresh, arrows_clockwise_default);
      refresh.disabled = this.collecting;
      bar.append(refresh);
      const row = el("div", "collect-row");
      const label = el("label", "target-label", "\u76EE\u6807");
      const select = el("select");
      select.setAttribute("aria-label", "\u91C7\u96C6\u76EE\u6807\u6570\u91CF");
      for (const limit of COLLECTION_LIMITS) {
        const option = el("option", "", limit === 1e5 ? "\u91C7\u96C6\u5230\u5E95" : `${limit} \u6761`);
        option.title = limit === 1e5 ? "\u91C7\u96C6\u5230\u5E95\uFF0C\u6700\u591A100000\u6761" : `${limit} \u6761`;
        option.value = String(limit);
        option.selected = limit === this.preferences.target;
        select.append(option);
      }
      select.disabled = this.collecting;
      select.addEventListener("change", () => this.callbacks.onPreferences({ ...this.preferences, target: Number(select.value) }));
      label.append(select);
      row.append(label, this.collecting ? button("\u505C\u6B62\u91C7\u96C6", "stop", this.callbacks.onCancelCollection, stop_circle_default) : button("\u81EA\u52A8\u91C7\u96C6", "collect", this.callbacks.onCollect));
      const wrap = el("div", "export-wrap");
      const toggle = button("\u5BFC\u51FA", "export-toggle", () => {
        this.menuOpen = !this.menuOpen;
        this.render();
      }, download_simple_default);
      toggle.disabled = this.collecting;
      toggle.setAttribute("aria-expanded", String(this.menuOpen));
      wrap.append(toggle);
      if (this.menuOpen && !this.collecting) {
        const menu = el("div", "export-menu");
        for (const [title, handler] of [["\u5BFC\u51FA\u5DF2\u6536\u96C6\u7684\u5168\u90E8\u4E3B\u8BC4\u8BBA CSV", this.callbacks.onExportCurrent], [`\u6309\u5F53\u524D\u6392\u5E8F\u5BFC\u51FA\u524D ${this.preferences.target} \u6761 CSV`, this.callbacks.onExportTop], [`\u81EA\u52A8\u91C7\u96C6\u5E76\u5BFC\u51FA\u524D ${this.preferences.target} \u6761 CSV`, this.callbacks.onCollectAndExport]]) {
          menu.append(button(title, "", () => {
            this.menuOpen = false;
            this.render();
            handler();
          }));
        }
        wrap.append(menu);
      }
      row.append(wrap);
      const options = el("div", "options-row");
      const auto = el("label", "auto");
      const check = el("input");
      check.type = "checkbox";
      check.checked = this.preferences.autoStart;
      check.addEventListener("change", () => this.callbacks.onPreferences({ ...this.preferences, autoStart: check.checked }));
      auto.append(check, document.createTextNode("\u6253\u5F00\u8BC4\u8BBA\u533A\u540E\u81EA\u52A8\u91C7\u96C6"));
      const count = el("span", "count", String(this.count));
      count.append(el("small", "", ` / ${this.preferences.target}`));
      options.append(auto, count);
      const progress = el("progress");
      progress.max = this.preferences.target;
      progress.value = Math.min(this.count, this.preferences.target);
      progress.setAttribute("aria-label", `\u5DF2\u6536\u96C6 ${this.count} \u6761\uFF0C\u76EE\u6807 ${this.preferences.target} \u6761`);
      const status = el("div", "status-row");
      const text = el("span", `status${this.error ? " error" : ""}`, this.message);
      text.setAttribute("role", "status");
      status.append(text);
      status.append(button("\u590D\u5236\u8BCA\u65AD", "diagnostics", this.callbacks.onCopyDiagnostics, copy_default));
      content.append(head, bar, row, options, progress, status, el("div", "footnote", "\u4EC5\u6536\u96C6\u7F51\u9875\u5B9E\u9645\u52A0\u8F7D\u7684\u4E3B\u8BC4\u8BBA \xB7 \u4E0D\u542B\u697C\u4E2D\u697C \xB7 \u4E0D\u4FDD\u8BC1\u5168\u91CF"));
      this.shadow.append(content);
    }
  };

  // src/content/session-store.ts
  var DATABASE_NAME = "xiaole-comment-sessions-v1";
  var SESSIONS = "sessions";
  var COMMENTS = "comments";
  var SESSION_INDEX = "session";
  var scopeKey = (sessionKey, videoId) => [sessionKey, videoId];
  var clampScroll = (value) => Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
  function snapshot(comment) {
    return {
      id: comment.id,
      nativeId: comment.nativeId,
      videoId: comment.videoId,
      videoUrl: comment.videoUrl,
      videoTitle: comment.videoTitle,
      authorName: comment.authorName,
      authorUrl: comment.authorUrl,
      text: comment.text,
      likeCount: comment.likeCount,
      likeCountRaw: comment.likeCountRaw,
      replyCount: comment.replyCount,
      replyCountRaw: comment.replyCountRaw,
      replyCountEstimated: comment.replyCountEstimated,
      publishTimeText: comment.publishTimeText,
      ipLocationText: comment.ipLocationText,
      originalIndex: comment.originalIndex,
      scannedAt: comment.scannedAt,
      parseWarnings: [...comment.parseWarnings]
    };
  }
  var CommentSessionStore = class {
    factory;
    databaseName;
    maxComments;
    opening = null;
    queue = Promise.resolve();
    constructor(options = {}) {
      this.factory = options.indexedDB ?? globalThis.indexedDB;
      this.databaseName = options.databaseName ?? DATABASE_NAME;
      this.maxComments = Math.min(MAX_COLLECTED_COMMENTS, Math.max(1, Math.floor(options.maxComments ?? MAX_COLLECTED_COMMENTS)));
    }
    serial(operation) {
      const result = this.queue.then(operation);
      this.queue = result.catch(() => void 0);
      return result;
    }
    database() {
      if (this.opening) return this.opening;
      if (!this.factory) return Promise.reject(new Error("\u6D4F\u89C8\u5668\u4E0D\u652F\u6301\u4FDD\u5B58\u8BC4\u8BBA\u8FDB\u5EA6\uFF0C\u8BF7\u68C0\u67E5\u7F51\u7AD9\u5B58\u50A8\u8BBE\u7F6E\u3002"));
      this.opening = new Promise((resolve, reject) => {
        let failed = false;
        const request = this.factory.open(this.databaseName, 1);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(SESSIONS)) database.createObjectStore(SESSIONS, { keyPath: ["sessionKey", "videoId"] });
          if (!database.objectStoreNames.contains(COMMENTS)) {
            const comments = database.createObjectStore(COMMENTS, { keyPath: ["sessionKey", "videoId", "id"] });
            comments.createIndex(SESSION_INDEX, ["sessionKey", "videoId"], { unique: false });
          }
        };
        request.onsuccess = () => {
          const database = request.result;
          if (failed) {
            database.close();
            return;
          }
          database.onversionchange = () => {
            database.close();
            this.opening = null;
          };
          resolve(database);
        };
        request.onerror = () => {
          failed = true;
          reject(request.error ?? new Error("\u65E0\u6CD5\u6253\u5F00\u8BC4\u8BBA\u8FDB\u5EA6\u5B58\u50A8\u3002"));
        };
        request.onblocked = () => {
          failed = true;
          reject(new Error("\u8BC4\u8BBA\u8FDB\u5EA6\u5B58\u50A8\u88AB\u65E7\u9875\u9762\u5360\u7528\uFF0C\u8BF7\u5173\u95ED\u65E7\u9875\u9762\u540E\u91CD\u8BD5\u3002"));
        };
      }).catch((error) => {
        this.opening = null;
        throw error;
      });
      return this.opening;
    }
    transaction(database, mode, body) {
      return new Promise((resolve, reject) => {
        const transaction = database.transaction([SESSIONS, COMMENTS], mode);
        let result;
        let assigned = false;
        transaction.oncomplete = () => assigned ? resolve(result) : reject(new Error("\u8BC4\u8BBA\u8FDB\u5EA6\u5B58\u50A8\u672A\u5B8C\u6210\u3002"));
        transaction.onabort = () => reject(transaction.error ?? new Error("\u4FDD\u5B58\u8BC4\u8BBA\u8FDB\u5EA6\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u78C1\u76D8\u7A7A\u95F4\u548C\u7F51\u7AD9\u5B58\u50A8\u6743\u9650\u3002"));
        transaction.onerror = () => {
        };
        try {
          body(transaction, (value) => {
            result = value;
            assigned = true;
          });
        } catch (error) {
          transaction.abort();
          reject(error);
        }
      });
    }
    load(sessionKey, videoId) {
      return this.serial(async () => this.transaction(await this.database(), "readonly", (transaction, finish) => {
        const session = transaction.objectStore(SESSIONS).get(scopeKey(sessionKey, videoId));
        session.onsuccess = () => {
          const metadata = session.result;
          if (!metadata) {
            finish(null);
            return;
          }
          const rows = transaction.objectStore(COMMENTS).index(SESSION_INDEX).getAll(scopeKey(sessionKey, videoId));
          rows.onsuccess = () => {
            const comments = rows.result.map(snapshot).sort((left, right) => left.originalIndex - right.originalIndex);
            finish({ metadata: { ...metadata, count: comments.length }, comments });
          };
        };
      }));
    }
    begin(sessionKey, videoId, options) {
      if (!sessionKey || !videoId) return Promise.reject(new Error("\u4FDD\u5B58\u91C7\u96C6\u8FDB\u5EA6\u9700\u8981\u660E\u786E\u7684\u89C6\u9891\u7F16\u53F7\u3002"));
      const lease = { sessionKey, videoId, runId: crypto.randomUUID() };
      return this.serial(async () => this.transaction(await this.database(), "readwrite", (transaction, finish) => {
        const sessions = transaction.objectStore(SESSIONS);
        const existing = sessions.get(scopeKey(sessionKey, videoId));
        existing.onsuccess = () => {
          const old = existing.result;
          const count = transaction.objectStore(COMMENTS).index(SESSION_INDEX).count(scopeKey(sessionKey, videoId));
          count.onsuccess = () => {
            sessions.put({
              ...lease,
              state: "running",
              target: Math.min(this.maxComments, Math.max(1, Math.floor(options.target) || this.maxComments)),
              exportAfter: options.exportAfter === true,
              sort: ["original", "likes", "replies"].includes(options.sort) ? options.sort : "original",
              scrollTop: options.scrollTop === void 0 ? clampScroll(old?.scrollTop) : clampScroll(options.scrollTop),
              count: count.result,
              updatedAt: Date.now()
            });
            finish(lease);
          };
        };
      }));
    }
    checkpoint(lease, comments, position = {}) {
      const updates = /* @__PURE__ */ new Map();
      for (const comment of comments) {
        if (comment.videoId === lease.videoId && comment.id) updates.set(comment.id, snapshot(comment));
      }
      return this.serial(async () => this.transaction(await this.database(), "readwrite", (transaction, finish) => {
        const sessions = transaction.objectStore(SESSIONS);
        const existing = sessions.get(scopeKey(lease.sessionKey, lease.videoId));
        existing.onsuccess = () => {
          const metadata = existing.result;
          if (!metadata || metadata.runId !== lease.runId || metadata.state !== "running") {
            finish({ accepted: false, count: metadata?.count ?? 0 });
            return;
          }
          const store = transaction.objectStore(COMMENTS);
          let count = metadata.count;
          let pending = updates.size;
          const saved = () => {
            sessions.put({ ...metadata, count, scrollTop: position.scrollTop === void 0 ? metadata.scrollTop : clampScroll(position.scrollTop), updatedAt: Date.now() });
            finish({ accepted: true, count });
          };
          if (!pending) {
            saved();
            return;
          }
          for (const comment of updates.values()) {
            const request = store.get([lease.sessionKey, lease.videoId, comment.id]);
            request.onsuccess = () => {
              try {
                const previous = request.result;
                if (previous || count < this.maxComments) {
                  if (!previous) count += 1;
                  store.put({ ...comment, originalIndex: previous?.originalIndex ?? comment.originalIndex, sessionKey: lease.sessionKey });
                }
                pending -= 1;
                if (pending === 0) saved();
              } catch {
                transaction.abort();
              }
            };
          }
        };
      }));
    }
    setState(lease, state) {
      return this.serial(async () => this.transaction(await this.database(), "readwrite", (transaction, finish) => {
        const sessions = transaction.objectStore(SESSIONS);
        const request = sessions.get(scopeKey(lease.sessionKey, lease.videoId));
        request.onsuccess = () => {
          const metadata = request.result;
          if (!metadata || metadata.runId !== lease.runId || ["stopped", "completed"].includes(metadata.state) && metadata.state !== state) {
            finish(false);
            return;
          }
          sessions.put({ ...metadata, state, updatedAt: Date.now() });
          finish(true);
        };
      }));
    }
    clear(sessionKey, videoId) {
      return this.serial(async () => this.transaction(await this.database(), "readwrite", (transaction, finish) => {
        transaction.objectStore(SESSIONS).delete(scopeKey(sessionKey, videoId));
        const cursor = transaction.objectStore(COMMENTS).index(SESSION_INDEX).openCursor(scopeKey(sessionKey, videoId));
        cursor.onsuccess = () => {
          if (!cursor.result) {
            finish(void 0);
            return;
          }
          cursor.result.delete();
          cursor.result.continue();
        };
      }));
    }
    async close() {
      await this.queue;
      const opening = this.opening;
      this.opening = null;
      if (opening) (await opening).close();
    }
  };

  // src/content/index.ts
  var PREFERENCES_KEY = "xiaoleCommentPreferencesV1";
  var CONTINUOUS_KEY = "xiaoleCommentContinuousV2";
  var CLAIM_EVENT = "xiaole-comment-controller-claim";
  var OWNER_ATTRIBUTE = "data-xiaole-comment-owner";
  var contentWindow = window;
  function downloadCsv(content, videoId, count) {
    const now = /* @__PURE__ */ new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `\u5C0F\u4E50\u6536\u96C6-\u6296\u97F3\u8BC4\u8BBA-${videoId || "\u5F53\u524D\u89C6\u9891"}-${count}\u6761-${date}.csv`;
    link.style.display = "none";
    document.documentElement.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1e3);
  }
  function visible(element) {
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
  }
  function hasBlockingPrompt() {
    return Array.from(document.querySelectorAll('[role="dialog"], [class*="captcha"], [id*="captcha"], [class*="verify"], [id*="verify"], [class*="login-mask"], [class*="login-panel"]')).slice(0, 200).some((element) => visible(element) && /验证码|安全验证|操作频繁|访问异常|请先登录|登录后|扫码登录|手机号登录/u.test(element.textContent ?? ""));
  }
  function videoIdentity() {
    const context = getVideoContext();
    if (context.videoId) return context.videoId;
    const videos = Array.from(document.querySelectorAll("video")).filter(visible);
    const active = videos.find((video) => !video.paused) ?? videos[0];
    return `${location.origin}${location.pathname}|${active?.currentSrc || active?.src || context.videoTitle}`;
  }
  function commentFingerprint() {
    const container = findCommentContainer().element;
    const ids = Array.from(container?.querySelectorAll("[data-comment-id], [data-cid], [data-id]") ?? []).slice(0, 12).map((node2) => node2.getAttribute("data-comment-id") || node2.getAttribute("data-cid") || node2.getAttribute("data-id")).join("|");
    if (!container) return "";
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, { acceptNode: (node2) => node2.parentElement?.closest("#xl-comment-toolbar") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    let text = "";
    let node;
    while (text.length < 1200 && (node = walker.nextNode())) text += node.textContent || "";
    return ids + "::" + text.trim().slice(0, 1200);
  }
  function stopIntent(identity, value) {
    const key = `xiaole-comment-stopped:${identity}`;
    try {
      if (value === true) sessionStorage.setItem(key, "1");
      if (value === false) sessionStorage.removeItem(key);
      return sessionStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  }
  function wait(ms, signal) {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const finish = () => {
        window.clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = window.setTimeout(finish, ms);
      signal.addEventListener("abort", finish, { once: true });
    });
  }
  var ContentController = class {
    controllerId = crypto.randomUUID();
    adapter = new DouyinAdapter();
    ui;
    observer;
    afterMutation;
    currentSort = "original";
    lastScan = null;
    lastError = "";
    identity = videoIdentity();
    urlTimer = null;
    run = null;
    generation = 0;
    destroyed = false;
    preferences = { ...DEFAULT_PREFERENCES };
    preferencesLoaded = false;
    autoStartedFor = "";
    transitionUntil = 0;
    staleFingerprint = null;
    lastCommentFingerprint = "";
    sessions = new CommentSessionStore();
    sessionKey = "";
    sessionReady = false;
    lease = null;
    resumePending = false;
    resumeExport = false;
    resumeAfter = 0;
    sessionSuppressed = false;
    saving = Promise.resolve();
    storageFailure = "";
    backgroundPaused = false;
    constructor() {
      this.ui = new StickyCommentToolbar({
        onSort: (mode) => this.scanAndApply(mode),
        onRefresh: () => this.scanAndApply(this.currentSort),
        onExportCurrent: () => this.exportComments(),
        onExportTop: () => this.exportComments(this.preferences.target),
        onCollect: () => {
          void this.collect(false);
        },
        onCollectAndExport: () => {
          void this.collect(true);
        },
        onCancelCollection: () => this.cancelCollection(),
        onCopyDiagnostics: () => {
          void this.copyDiagnostics();
        },
        onPreferences: (value) => {
          void this.savePreferences(value);
        }
      });
      this.afterMutation = debounce(() => {
        this.checkVideo();
        this.ensureToolbar();
        this.scanAndUpdateCount();
      }, OBSERVER_DEBOUNCE_MS);
      this.observer = new MutationObserver((mutations) => {
        if (mutations.some((m) => m.addedNodes.length || m.removedNodes.length || m.type === "characterData")) this.afterMutation();
      });
    }
    start() {
      document.addEventListener(CLAIM_EVENT, this.handleClaim);
      document.documentElement.setAttribute(OWNER_ATTRIBUTE, this.controllerId);
      document.dispatchEvent(new Event(CLAIM_EVENT));
      this.ensureToolbar();
      this.observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      chrome.runtime.onMessage.addListener(this.handleMessage);
      window.addEventListener("pagehide", this.handlePageHide, { once: true });
      this.urlTimer = window.setInterval(() => {
        this.checkVideo();
        this.ensureToolbar();
        this.scanAndUpdateCount();
      }, 1e3);
      document.addEventListener("visibilitychange", this.handleVisibility);
      window.addEventListener("online", this.handleVisibility);
      void this.loadPreferences();
    }
    activate() {
      this.ensureToolbar();
      this.scanAndApply(this.currentSort);
      this.ui.reveal();
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.generation += 1;
      this.run?.abort();
      this.run = null;
      this.observer.disconnect();
      this.afterMutation.cancel();
      if (this.urlTimer !== null) window.clearInterval(this.urlTimer);
      try {
        chrome.runtime.onMessage.removeListener(this.handleMessage);
      } catch {
      }
      document.removeEventListener(CLAIM_EVENT, this.handleClaim);
      window.removeEventListener("pagehide", this.handlePageHide);
      document.removeEventListener("visibilitychange", this.handleVisibility);
      window.removeEventListener("online", this.handleVisibility);
      if (document.documentElement.getAttribute(OWNER_ATTRIBUTE) === this.controllerId) document.documentElement.removeAttribute(OWNER_ATTRIBUTE);
      this.ui.destroy();
      this.adapter.clear();
      if (contentWindow.__XIAOLE_COMMENTS__ === this) delete contentWindow.__XIAOLE_COMMENTS__;
    }
    handleMessage = (message, sender, sendResponse) => {
      if (sender.id !== chrome.runtime.id || !isActivateToolbarRequest(message)) return false;
      this.activate();
      sendResponse({ ok: true });
      return false;
    };
    handlePageHide = () => this.destroy();
    handleVisibility = () => {
      if (!document.hidden) this.maybeAutoStart();
    };
    handleClaim = () => {
      if (document.documentElement.getAttribute(OWNER_ATTRIBUTE) !== this.controllerId) this.destroy();
    };
    ensureToolbar() {
      const match = findCommentContainer();
      if (match.element) this.ui.mount(match.element, findToolbarAnchor(match.element));
    }
    checkVideo() {
      const next = videoIdentity();
      if (next === this.identity) return;
      const oldLease = this.lease;
      if (oldLease && this.run) void this.saveProgress(oldLease).then(() => this.sessions.setState(oldLease, "paused")).catch(() => void 0);
      this.stopScrolling();
      this.generation += 1;
      this.run?.abort();
      this.run = null;
      this.identity = next;
      this.autoStartedFor = "";
      this.staleFingerprint = this.lastCommentFingerprint || null;
      this.transitionUntil = Date.now() + 1e3;
      this.lastScan = null;
      this.currentSort = "original";
      this.adapter.clear();
      this.ui.unmount();
      this.ui.setCollectionState(false, 0, "\u89C6\u9891\u5DF2\u5207\u6362\uFF0C\u7B49\u5F85\u65B0\u8BC4\u8BBA\u52A0\u8F7D\u3002");
      this.ui.update("original", 0, "\u89C6\u9891\u5DF2\u5207\u6362\uFF0C\u7B49\u5F85\u65B0\u8BC4\u8BBA\u52A0\u8F7D\u3002");
      this.lease = null;
      this.sessionReady = false;
      this.resumePending = false;
      this.sessionSuppressed = false;
      if (this.preferencesLoaded) void this.restoreSession();
    }
    canScan() {
      this.checkVideo();
      if (this.destroyed || Date.now() < this.transitionUntil) return false;
      const fingerprint = commentFingerprint();
      if (this.staleFingerprint && fingerprint === this.staleFingerprint) return false;
      this.staleFingerprint = null;
      this.lastCommentFingerprint = fingerprint;
      return true;
    }
    async loadPreferences() {
      try {
        const saved = await chrome.storage.local.get([PREFERENCES_KEY, CONTINUOUS_KEY]);
        this.preferences = normalizePreferences(saved[PREFERENCES_KEY]);
        if (!saved[CONTINUOUS_KEY]) {
          this.preferences.target = 1e5;
          await chrome.storage.local.set({ [PREFERENCES_KEY]: this.preferences, [CONTINUOUS_KEY]: true });
        }
        const response = await chrome.runtime.sendMessage({ type: "XIAOLE_COMMENT_SESSION" });
        if (!response?.ok || typeof response.key !== "string") throw new Error("\u65E0\u6CD5\u5EFA\u7ACB\u5F53\u524D\u6807\u7B7E\u9875\u7684\u91C7\u96C6\u8FDB\u5EA6\u3002");
        this.sessionKey = response.key;
      } catch {
        this.ui.update(this.currentSort, 0, "\u65E0\u6CD5\u8BFB\u53D6\u504F\u597D\u8BBE\u7F6E\uFF0C\u6682\u4F7F\u7528\u672C\u9875\u9ED8\u8BA4\u8BBE\u7F6E\u3002", true);
      }
      this.preferencesLoaded = true;
      this.ui.setPreferences(this.preferences);
      await this.restoreSession();
    }
    async restoreSession() {
      const generation = this.generation;
      const identity = this.identity;
      this.sessionReady = false;
      try {
        if (!this.sessionKey) throw new Error("\u65E0\u6CD5\u4FDD\u5B58\u8FDB\u5EA6\uFF0C\u8BF7\u5237\u65B0\u9875\u9762\u91CD\u8BD5\u3002");
        const saved = await this.sessions.load(this.sessionKey, identity);
        if (this.destroyed || generation !== this.generation) return;
        const manuallyStopped = stopIntent(identity);
        this.sessionSuppressed = manuallyStopped;
        if (saved) {
          this.adapter.restore(identity, saved.comments);
          this.currentSort = saved.metadata.sort;
          this.resumePending = !manuallyStopped && (saved.metadata.state === "running" || saved.metadata.state === "paused");
          this.sessionSuppressed = !this.resumePending;
          if (manuallyStopped && (saved.metadata.state === "running" || saved.metadata.state === "paused")) {
            await this.sessions.setState(saved.metadata, "stopped");
            if (this.destroyed || generation !== this.generation) return;
          }
          this.resumeExport = saved.metadata.exportAfter;
          if (this.resumePending) this.preferences.target = saved.metadata.target;
          this.ui.setPreferences(this.preferences);
          this.ui.update(this.currentSort, saved.comments.length, this.resumePending ? `\u5DF2\u6062\u590D ${saved.comments.length} \u6761\u8BC4\u8BBA\uFF0C\u7B49\u5F85\u8BC4\u8BBA\u533A\u52A0\u8F7D\u540E\u7EE7\u7EED\u3002` : saved.metadata.state === "completed" ? `\u4E0A\u6B21\u91C7\u96C6\u5DF2\u5B8C\u6210\uFF0C\u5DF2\u6062\u590D ${saved.comments.length} \u6761\u8BC4\u8BBA\u3002` : `\u5DF2\u6062\u590D ${saved.comments.length} \u6761\u8BC4\u8BBA\uFF1B\u4E0A\u6B21\u5DF2\u624B\u52A8\u505C\u6B62\u3002`);
        }
        this.storageFailure = "";
      } catch (error) {
        if (generation !== this.generation) return;
        this.storageFailure = error instanceof Error ? error.message : "\u65E0\u6CD5\u8BFB\u53D6\u91C7\u96C6\u8FDB\u5EA6";
        this.ui.update(this.currentSort, 0, this.storageFailure, true);
      } finally {
        if (!this.destroyed && generation === this.generation) {
          this.sessionReady = true;
          this.scanAndUpdateCount();
        }
      }
    }
    saveProgress(lease) {
      const changes = this.adapter.drainChanges();
      if (!changes.length) return this.saving;
      const scrollTop = findCommentScroller()?.scrollTop || 0;
      const pending = this.saving.then(async () => {
        const result = await this.sessions.checkpoint(lease, changes, { scrollTop });
        if (!result.accepted && this.lease?.runId === lease.runId && this.run && !this.run.signal.aborted) throw new Error("\u91C7\u96C6\u4EFB\u52A1\u5DF2\u7531\u53E6\u4E00\u9875\u9762\u66F4\u65B0\uFF0C\u8BF7\u91CD\u65B0\u5F00\u59CB\u3002");
      });
      this.saving = pending.catch((error) => {
        if (this.identity === lease.videoId && this.lease?.runId === lease.runId) {
          this.adapter.retainChanges(changes);
          this.storageFailure = "\u4FDD\u5B58\u8FDB\u5EA6\u5931\u8D25\uFF0C\u5DF2\u6682\u505C\uFF1B\u8BF7\u5148\u5BFC\u51FA\u5F53\u524D\u8BC4\u8BBA\uFF0C\u518D\u91CD\u8BD5\u3002";
          this.run?.abort();
        }
        this.lastError = error instanceof Error ? error.message : "\u4FDD\u5B58\u8FDB\u5EA6\u5931\u8D25";
      });
      return pending;
    }
    async finishSession(lease, state) {
      await this.saveProgress(lease);
      await this.sessions.setState(lease, state);
    }
    async savePreferences(value) {
      const wasEnabled = this.preferences.autoStart;
      this.preferences = normalizePreferences(value);
      this.ui.setPreferences(this.preferences);
      if (!this.preferences.autoStart && this.run) this.cancelCollection();
      try {
        await chrome.storage.local.set({ [PREFERENCES_KEY]: this.preferences });
      } catch {
        this.ui.update(this.currentSort, this.lastScan?.comments.length ?? 0, "\u8BBE\u7F6E\u4EC5\u5728\u5F53\u524D\u9875\u9762\u751F\u6548\uFF0C\u65E0\u6CD5\u5199\u5165\u6D4F\u89C8\u5668\u5B58\u50A8\u3002", true);
      }
      if (!wasEnabled && this.preferences.autoStart) {
        this.autoStartedFor = "";
        this.sessionSuppressed = false;
        stopIntent(this.identity, false);
      }
      this.maybeAutoStart();
    }
    maybeAutoStart() {
      if (!this.preferencesLoaded || !this.sessionReady || this.storageFailure || this.run || this.destroyed || this.sessionSuppressed || stopIntent(this.identity) || document.hidden || Date.now() < this.resumeAfter) return;
      if (!this.resumePending && (!this.preferences.autoStart || this.autoStartedFor === this.identity)) return;
      if (!findCommentContainer().element || !this.canScan() || hasBlockingPrompt() || !navigator.onLine) return;
      void this.collect(this.resumePending ? this.resumeExport : false, true);
    }
    scanAndApply(mode) {
      if (this.run || !this.sessionReady || !this.canScan()) return;
      this.currentSort = mode;
      this.ensureToolbar();
      try {
        const result = this.adapter.scan();
        this.lastScan = result;
        this.lastError = "";
        if (!result.comments.length) return this.ui.showError(result.pageStatus, result.diagnostics);
        const reordered = this.adapter.reorder(stableSortComments(result.comments, mode), this.sortLabel(mode));
        this.ui.update(mode, result.comments.length, reordered.message);
      } catch (error) {
        this.showError(error);
      }
    }
    exportComments(limit) {
      if (this.run || !this.sessionReady || !this.canScan()) return;
      try {
        const result = this.adapter.scan();
        this.lastScan = result;
        if (!result.comments.length) return this.ui.showError(result.pageStatus, result.diagnostics);
        const sorted = stableSortComments(result.comments, this.currentSort);
        const exported = limit ? sorted.slice(0, limit) : sorted;
        downloadCsv(exportCommentsCsv(exported), result.pageStatus.videoId, exported.length);
        this.ui.update(this.currentSort, result.comments.length, `\u5DF2\u6309\u5F53\u524D\u6392\u5E8F\u5BFC\u51FA ${exported.length} \u6761\u4E3B\u8BC4\u8BBA\u3002`);
      } catch (error) {
        this.showError(error);
      }
    }
    async collect(exportAfter, automatic = false) {
      if (this.run || !this.sessionReady || !this.canScan()) return;
      if (!this.sessionKey || this.storageFailure) {
        this.ui.update(this.currentSort, this.lastScan?.comments.length || 0, this.storageFailure || "\u6B63\u5728\u51C6\u5907\u8FDB\u5EA6\u5B58\u50A8\uFF0C\u8BF7\u5237\u65B0\u91CD\u8BD5\u3002", true);
        return;
      }
      this.ensureToolbar();
      this.autoStartedFor = this.identity;
      const run = new AbortController();
      this.run = run;
      const generation = this.generation;
      const identity = this.identity;
      const keepPosition = automatic && this.resumePending && this.lease?.videoId === identity;
      this.lease = null;
      if (!automatic) stopIntent(identity, false);
      this.sessionSuppressed = false;
      this.resumePending = false;
      this.backgroundPaused = false;
      this.ui.setCollectionState(true, this.lastScan?.comments.length ?? 0, automatic ? "\u6B63\u5728\u6062\u590D\u91C7\u96C6\uFF0C\u5DF2\u8BFB\u8BC4\u8BBA\u4F1A\u81EA\u52A8\u53BB\u91CD\u2026\u2026" : "\u6B63\u5728\u4ECE\u8BC4\u8BBA\u533A\u5F00\u5934\u91C7\u96C6\uFF0C\u5237\u65B0\u540E\u53EF\u81EA\u52A8\u7EE7\u7EED\u2026\u2026");
      try {
        const lease = await this.sessions.begin(this.sessionKey, identity, { target: this.preferences.target, exportAfter, sort: this.currentSort });
        if (generation !== this.generation || this.destroyed) {
          await this.sessions.setState(lease, "paused");
          return;
        }
        this.lease = lease;
        if (run.signal.aborted) {
          await this.finishSession(lease, "stopped");
          if (generation === this.generation && !this.destroyed) this.ui.setCollectionState(false, this.lastScan?.comments.length || 0, STOP_MESSAGES.cancelled);
          return;
        }
        await this.saveProgress(lease);
        if (generation !== this.generation || this.destroyed || videoIdentity() !== identity) return;
        if (run.signal.aborted) {
          await this.finishSession(lease, "stopped");
          this.ui.setCollectionState(false, this.lastScan?.comments.length || 0, STOP_MESSAGES.cancelled);
          return;
        }
        if (!keepPosition) findCommentScroller()?.scrollTo({ top: 0, behavior: "instant" });
        await wait(500, run.signal);
        const outcome = await collectComments({
          target: this.preferences.target,
          signal: run.signal,
          identity: videoIdentity,
          blocked: () => hasBlockingPrompt(),
          pageState: getCommentLoadState,
          suspended: () => {
            const paused = document.hidden || !navigator.onLine;
            if (paused && !this.backgroundPaused) this.ui.setCollectionState(true, this.lastScan?.comments.length || 0, "\u91C7\u96C6\u6682\u6302\uFF0C\u56DE\u5230\u672C\u9875\u6216\u7F51\u7EDC\u6062\u590D\u540E\u81EA\u52A8\u7EE7\u7EED\u3002");
            this.backgroundPaused = paused;
            return paused;
          },
          scan: () => this.adapter.scan(),
          scroll: () => {
            const scroller = findCommentScroller();
            if (!scroller) return false;
            const distance = Math.max(480, Math.round(scroller.clientHeight * 0.82));
            const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 8;
            if (atBottom && getCommentLoadState().loading) return false;
            if (atBottom) scroller.scrollBy({ top: -2, behavior: "instant" });
            scroller.scrollTo({ top: Math.min(scroller.scrollHeight, scroller.scrollTop + distance), behavior: "instant" });
            return true;
          },
          wait: () => wait(1500, run.signal),
          progress: async (scan) => {
            if (this.generation !== generation) return;
            this.lastScan = scan;
            this.lastCommentFingerprint = commentFingerprint();
            await this.saveProgress(lease);
            if (this.generation === generation && !run.signal.aborted) this.ui.setCollectionState(true, scan.comments.length, `\u6B63\u5728\u91C7\u96C6 ${scan.comments.length} / ${this.preferences.target} \u6761\u4E3B\u8BC4\u8BBA\uFF0C\u8FDB\u5EA6\u5DF2\u4FDD\u5B58\u3002`);
          }
        });
        if (this.destroyed || this.generation !== generation || videoIdentity() !== identity) {
          this.checkVideo();
          return;
        }
        this.lastScan = outcome.scan ?? this.lastScan;
        const completed = outcome.reason === "end" || outcome.reason === "target";
        const stopped = outcome.reason === "cancelled";
        this.resumePending = !completed && !stopped;
        this.resumeExport = exportAfter;
        this.sessionSuppressed = completed || stopped;
        this.resumeAfter = Date.now() + 15e3;
        await this.finishSession(lease, completed ? "completed" : stopped ? "stopped" : "paused");
        if (this.destroyed || generation !== this.generation || videoIdentity() !== identity) return;
        if (run.signal.aborted && !stopped) {
          this.ui.setCollectionState(false, this.lastScan?.comments.length || 0, STOP_MESSAGES.cancelled);
          return;
        }
        let message = STOP_MESSAGES[outcome.reason];
        const count = this.lastScan?.comments.length ?? 0;
        if (outcome.scan && completed) {
          const sorted = stableSortComments(outcome.scan.comments, this.currentSort);
          this.adapter.reorder(sorted, this.sortLabel(this.currentSort));
          if (exportAfter && sorted.length) {
            const exported = sorted.slice(0, this.preferences.target);
            downloadCsv(exportCommentsCsv(exported), outcome.scan.pageStatus.videoId, exported.length);
            message += ` \u5DF2\u5BFC\u51FA ${exported.length} \u6761\u3002`;
          }
        }
        this.ui.setCollectionState(false, count, message);
      } catch (error) {
        if (this.generation === generation && !this.destroyed) {
          this.resumePending = !this.sessionSuppressed && !this.storageFailure;
          this.resumeAfter = Date.now() + 15e3;
          if (this.lease) await this.sessions.setState(this.lease, this.sessionSuppressed ? "stopped" : "paused").catch(() => void 0);
          if (this.destroyed || generation !== this.generation || videoIdentity() !== identity) return;
          this.ui.setCollectionState(false, this.lastScan?.comments.length ?? 0, this.storageFailure || "\u91C7\u96C6\u6682\u65F6\u4E2D\u65AD\uFF0C\u5DF2\u4FDD\u5B58\u8FDB\u5EA6\uFF0C\u9875\u9762\u6062\u590D\u540E\u4F1A\u7EE7\u7EED\u3002");
          this.lastError = error instanceof Error ? error.message : "\u91C7\u96C6\u6682\u65F6\u4E2D\u65AD";
        }
      } finally {
        if (this.run === run) this.run = null;
      }
    }
    stopScrolling() {
      const scroller = findCommentScroller();
      scroller?.scrollTo({ top: scroller.scrollTop, behavior: "instant" });
    }
    cancelCollection() {
      stopIntent(this.identity, true);
      this.autoStartedFor = this.identity;
      this.resumePending = false;
      this.sessionSuppressed = true;
      this.run?.abort();
      this.stopScrolling();
      if (this.lease) void this.finishSession(this.lease, "stopped").catch(() => void 0);
    }
    scanAndUpdateCount() {
      if (this.run || !this.sessionReady || !this.canScan()) return;
      try {
        this.lastScan = this.adapter.scan();
        this.ui.updateCount(this.lastScan.comments.length);
        this.maybeAutoStart();
      } catch {
      }
    }
    async copyDiagnostics() {
      const status = this.adapter.getPageStatus();
      const scroller = findCommentScroller();
      const text = JSON.stringify({
        tool: "\u5C0F\u4E50\u6536\u96C6 \xB7 \u8BC4\u8BBA\u52A9\u624B",
        pageUrl: location.href,
        pageState: status.state,
        message: status.message,
        error: this.lastError || null,
        loadState: getCommentLoadState(),
        scroller: scroller ? { tag: scroller.tagName, className: scroller.className, scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight } : null,
        diagnostics: this.lastScan?.diagnostics ?? null,
        copiedAt: (/* @__PURE__ */ new Date()).toISOString()
      }, null, 2);
      let copied = false;
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.cssText = "position:fixed;opacity:0";
        document.documentElement.append(textarea);
        textarea.select();
        copied = typeof document.execCommand === "function" && document.execCommand("copy");
        textarea.remove();
      }
      this.ui.update(this.currentSort, this.lastScan?.comments.length ?? 0, copied ? "\u8BCA\u65AD\u4FE1\u606F\u5DF2\u590D\u5236\uFF0C\u4E0D\u5305\u542B\u8BC4\u8BBA\u6B63\u6587\u3002" : "\u590D\u5236\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5\u3002", !copied);
    }
    showError(error) {
      this.lastError = error instanceof Error ? error.message : "\u672A\u77E5\u9519\u8BEF";
      this.ui.showError({ ...this.adapter.getPageStatus(), state: "structure-changed", message: "\u8BFB\u53D6\u8BC4\u8BBA\u65F6\u51FA\u73B0\u5F02\u5E38\uFF0C\u8BF7\u5237\u65B0\u91CD\u8BD5\u6216\u590D\u5236\u8BCA\u65AD\u3002" }, this.lastScan?.diagnostics ?? null);
    }
    sortLabel(mode) {
      return mode === "likes" ? "\u70B9\u8D5E\u4ECE\u9AD8\u5230\u4F4E" : mode === "replies" ? "\u56DE\u590D\u4ECE\u9AD8\u5230\u4F4E" : "\u9996\u6B21\u8BFB\u53D6\u987A\u5E8F";
    }
  };
  try {
    contentWindow.__XIAOLE_COMMENTS__?.destroy();
  } catch {
    delete contentWindow.__XIAOLE_COMMENTS__;
  }
  var controller = new ContentController();
  contentWindow.__XIAOLE_COMMENTS__ = controller;
  controller.start();
})();
