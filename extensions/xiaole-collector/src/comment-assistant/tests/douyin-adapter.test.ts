// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DouyinAdapter } from "../src/adapters/douyin/DouyinAdapter";
import { stableSortComments } from "../src/utils/stable-sort";

interface FixtureComment {
  id: string;
  author: string;
  text: string;
  likes: string;
  replies?: string;
  time?: string;
  ip?: string;
  depth?: 0 | 1;
}

function setPageUrl(url: string): void {
  const happyWindow = window as unknown as {
    happyDOM: { setURL: (nextUrl: string) => void };
  };
  happyWindow.happyDOM.setURL(url);
}

function appendMetaTitle(title: string): void {
  const meta = document.createElement("meta");
  meta.setAttribute("property", "og:title");
  meta.setAttribute("content", title);
  document.head.append(meta);
}

function createFixtureComment(input: FixtureComment): HTMLElement {
  const item = document.createElement("div");
  item.dataset.e2e = "comment-item";
  item.dataset.commentId = input.id;

  const author = document.createElement("a");
  author.dataset.e2e = "comment-user-name";
  author.href = `/user/${input.author}`;
  author.textContent = input.author;

  const text = document.createElement("p");
  text.dataset.e2e =
    input.depth === 1 ? "comment-level-2" : "comment-level-1";
  text.textContent = input.text;

  const like = document.createElement("button");
  like.dataset.e2e = "comment-like-count";
  like.setAttribute("aria-label", `点赞 ${input.likes}`);
  like.textContent = input.likes;

  item.append(author, text, like);

  if (input.replies !== undefined) {
    const replies = document.createElement("button");
    replies.dataset.e2e = "comment-reply-count";
    replies.textContent = input.replies;
    item.append(replies);
  }
  if (input.time) {
    const time = document.createElement("span");
    time.dataset.e2e = "comment-time";
    time.textContent = input.time;
    item.append(time);
  }
  if (input.ip) {
    const ip = document.createElement("span");
    ip.textContent = `IP属地：${input.ip}`;
    item.append(ip);
  }
  return item;
}

function setupStructuredFixture(): HTMLElement {
  setPageUrl("https://www.douyin.com/video/123456");
  appendMetaTitle("评论解析测试视频");

  const container = document.createElement("section");
  container.dataset.e2e = "comment-list";

  const first = createFixtureComment({
    id: "c1",
    author: "用户甲",
    text: "点赞很多的评论",
    likes: "1.2万",
    replies: "展开 3 条回复",
    time: "2天前",
    ip: "北京"
  });
  first.append(
    createFixtureComment({
      id: "c1r1",
      author: "用户乙",
      text: "这是已加载的子回复",
      likes: "8",
      time: "1天前",
      depth: 1
    })
  );

  const second = createFixtureComment({
    id: "c2",
    author: "用户丙",
    text: "回复讨论很多的评论",
    likes: "900",
    replies: "共 12 条回复",
    time: "3小时前"
  });

  container.append(first, second);
  document.body.append(container);
  return container;
}

describe("DouyinAdapter评论DOM适配", () => {
  beforeEach(() => {
    document.head.replaceChildren();
    document.body.replaceChildren();
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue(
      [new DOMRect(0, 0, 100, 40)] as unknown as DOMRectList
    );
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn()
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("读取主评论、子回复、互动数量和视频信息", () => {
    setupStructuredFixture();
    const adapter = new DouyinAdapter();
    const result = adapter.scan();

    expect(result.pageStatus.state).toBe("ready");
    expect(result.pageStatus.videoId).toBe("123456");
    expect(result.pageStatus.videoTitle).toBe("评论解析测试视频");
    expect(result.mainCommentCount).toBe(2);
    expect(result.comments).toHaveLength(2);

    const first = result.comments.find(({ nativeId }) => nativeId === "c1");
    expect(first).toMatchObject({
      authorName: "用户甲",
      text: "点赞很多的评论",
      likeCount: 12_000,
      replyCount: 3,
      replyCountEstimated: false,
      publishTimeText: "2天前",
      ipLocationText: "IP属地：北京"
    });

    expect(
      result.comments.some(({ nativeId }) => nativeId === "c1r1")
    ).toBe(false);
    expect(result.diagnostics.commentContainerFound).toBe(true);
    expect(result.diagnostics.filteredNodeCount).toBeGreaterThan(0);
  });

  it("楼中楼与主评论左侧位置相同时仍只统计主评论", () => {
    setPageUrl("https://www.douyin.com/video/223344");
    appendMetaTitle("主评论线程测试");
    const container = document.createElement("section");
    container.dataset.e2e = "comment-list";

    const firstThread = document.createElement("div");
    const firstMain = createFixtureComment({
      id: "main-1",
      author: "主评论用户甲",
      text: "第一条主评论",
      likes: "88",
      replies: "展开1条回复",
      time: "2天前"
    });
    const replyArea = document.createElement("div");
    replyArea.className = "hashed-child-area";
    const childReply = createFixtureComment({
      id: "reply-1",
      author: "回复用户",
      text: "这是楼中楼回复",
      likes: "6",
      time: "1天前"
    });
    childReply
      .querySelector('[data-e2e="comment-level-1"]')
      ?.removeAttribute("data-e2e");
    replyArea.append(childReply);
    firstThread.append(firstMain, replyArea);

    const secondThread = document.createElement("div");
    secondThread.append(
      createFixtureComment({
        id: "main-2",
        author: "主评论用户乙",
        text: "第二条主评论",
        likes: "33",
        replies: "0条回复",
        time: "刚刚"
      })
    );
    container.append(firstThread, secondThread);
    document.body.append(container);

    const result = new DouyinAdapter().scan();
    expect(result.comments.map(({ nativeId }) => nativeId)).toEqual([
      "main-1",
      "main-2"
    ]);
    expect(result.mainCommentCount).toBe(2);
  });

  it("不会把数字、分享和评论操作栏当成评论正文", () => {
    setPageUrl("https://www.douyin.com/video/556677");
    appendMetaTitle("操作栏过滤测试");
    const container = document.createElement("section");
    container.dataset.e2e = "comment-list";
    const card = document.createElement("article");
    card.dataset.e2e = "comment-item";
    card.dataset.commentId = "action-only";
    const author = document.createElement("a");
    author.dataset.e2e = "comment-user-name";
    author.href = "/user/action-only";
    author.textContent = "操作栏用户";
    const actions = document.createElement("div");
    actions.className = "commentContent";
    for (const label of ["0", "分享", "评论"]) {
      const span = document.createElement("span");
      span.textContent = label;
      actions.append(span);
    }
    for (let index = 0; index < 3; index += 1) {
      actions.append(document.createElement("button"));
    }
    const time = document.createElement("span");
    time.dataset.e2e = "comment-time";
    time.textContent = "7月前";
    card.append(author, actions, time);
    container.append(card);
    document.body.append(container);

    expect(new DouyinAdapter().scan().comments).toHaveLength(0);
  });

  it("点赞排序和回复排序使用解析后的数值", () => {
    setupStructuredFixture();
    const comments = new DouyinAdapter().scan().comments;

    expect(
      stableSortComments(comments, "likes").map(({ nativeId }) => nativeId)
    ).toEqual(["c1", "c2"]);
    expect(
      stableSortComments(comments, "replies").map(({ nativeId }) => nativeId)
    ).toEqual(["c2", "c1"]);
  });

  it("滚动加载新评论时增量合并并去重", () => {
    const container = setupStructuredFixture();
    const adapter = new DouyinAdapter();
    const firstScan = adapter.scan();
    expect(firstScan.comments).toHaveLength(2);

    container.firstElementChild?.remove();
    container.append(
      createFixtureComment({
        id: "c3",
        author: "用户丁",
        text: "滚动后新加载的评论",
        likes: "66",
        replies: "0条回复",
        time: "刚刚"
      })
    );

    const incremental = adapter.scan();
    expect(incremental.comments.map(({ nativeId }) => nativeId)).toEqual([
      "c1",
      "c2",
      "c3"
    ]);
  });

  it("页面持续保留旧节点时不会在前2000条截断", () => {
    setPageUrl("https://www.douyin.com/video/665544");
    const container = document.createElement("section");
    container.dataset.e2e = "comment-list";
    const fragment = document.createDocumentFragment();
    for (let index = 1; index <= 2001; index++) {
      fragment.append(createFixtureComment({id: `large-${index}`, author: `用户${index}`, text: `这是第${index}条主评论`, likes: "1", time: "1天前"}));
    }
    container.append(fragment); document.body.append(container);
    const adapter = new DouyinAdapter();
    const result = adapter.scan();
    expect(result.comments).toHaveLength(2001);
    expect(result.comments.at(-1)?.nativeId).toBe("large-2001");
    expect(adapter.reorder([...result.comments].reverse(), "点赞从高到低")).toMatchObject({ movedCount: 0 });
    expect((container.firstElementChild as HTMLElement).dataset.commentId).toBe("large-1");
  }, 30000);

  it("直接调整原生主评论节点并能恢复首次顺序", () => {
    const container = setupStructuredFixture();
    const adapter = new DouyinAdapter();
    const comments = adapter.scan().comments;

    const sorted = stableSortComments(comments, "replies");
    expect(adapter.reorder(sorted, "回复数从高到低").movedCount).toBe(2);
    expect(
      Array.from(container.children).map(
        (element) => (element as HTMLElement).dataset.commentId
      )
    ).toEqual(["c2", "c1"]);

    adapter.scan();
    expect(
      adapter.reorder(
        stableSortComments(comments, "original"),
        "首次读取的页面顺序"
      ).movedCount
    ).toBe(2);
    expect(
      Array.from(container.children).map(
        (element) => (element as HTMLElement).dataset.commentId
      )
    ).toEqual(["c1", "c2"]);
  });

  it("候选选择器失效时使用语义回退并给出诊断", () => {
    setPageUrl("https://www.douyin.com/video/987654");
    appendMetaTitle("语义回退测试");
    const container = document.createElement("section");
    container.dataset.e2e = "comment-list";
    const card = document.createElement("article");
    const author = document.createElement("a");
    author.href = "/user/fallback-user";
    author.textContent = "回退用户";
    const text = document.createElement("p");
    text.textContent = "这条评论没有固定的评论节点属性";
    const like = document.createElement("button");
    like.setAttribute("aria-label", "点赞 88");
    like.textContent = "赞 88";
    const reply = document.createElement("button");
    reply.textContent = "查看 5 条回复";
    card.append(author, text, like, reply);
    container.append(card);
    document.body.append(container);

    const result = new DouyinAdapter().scan();
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]).toMatchObject({
      authorName: "回退用户",
      text: "这条评论没有固定的评论节点属性",
      likeCount: 88,
      replyCount: 5
    });
    expect(result.diagnostics.commentItemSelector).toContain("语义");
  });

  it("识别哈希类名和评论操作行中的点赞数", () => {
    setPageUrl(
      "https://www.douyin.com/user/example?modal_id=7666795779407260145"
    );
    appendMetaTitle("弹窗评论测试");
    const container = document.createElement("section");
    container.dataset.e2e = "comment-list";
    const header = document.createElement("div");
    header.textContent = "全部评论(13554)";
    const card = document.createElement("article");
    card.className = "a1b2c3";
    const author = document.createElement("a");
    author.href = "/user/commenter";
    author.textContent = "徐钊寒";
    const text = document.createElement("div");
    text.className = "x9_content";
    text.textContent = "接受所有的关系都是流动的\n保留证据，捍卫权益";
    const meta = document.createElement("span");
    meta.textContent = "2天前·四川";
    const actions = document.createElement("div");
    const reply = document.createElement("span");
    reply.textContent = "回复";
    const share = document.createElement("span");
    share.textContent = "分享";
    const like = document.createElement("span");
    like.textContent = "160";
    actions.append(reply, share, like);
    for (let index = 0; index < 3; index += 1) {
      actions.append(document.createElement("button"));
    }
    const replies = document.createElement("button");
    replies.textContent = "展开5条回复";
    card.append(author, text, meta, actions, replies);
    container.append(header, card);
    document.body.append(container);

    const result = new DouyinAdapter().scan();
    expect(result.pageStatus.videoId).toBe("7666795779407260145");
    expect(result.comments[0]).toMatchObject({
      authorName: "徐钊寒",
      text: "接受所有的关系都是流动的 保留证据，捍卫权益",
      likeCount: 160,
      replyCount: 5,
      publishTimeText: "2天前·四川",
      ipLocationText: "IP属地：四川"
    });
  });
});
