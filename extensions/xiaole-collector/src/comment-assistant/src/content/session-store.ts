import { MAX_COLLECTED_COMMENTS } from "../shared/constants";
import type { CommentItem, SortMode } from "../shared/types";

export type CollectionSessionState = "running" | "paused" | "stopped" | "completed";
export interface SessionLease { sessionKey: string; videoId: string; runId: string }
export interface SessionMetadata extends SessionLease {
  state: CollectionSessionState;
  target: number;
  exportAfter: boolean;
  sort: SortMode;
  scrollTop: number;
  count: number;
  updatedAt: number;
}
export interface SavedCollectionSession { metadata: SessionMetadata; comments: CommentItem[] }
export interface SessionOptions { target: number; exportAfter: boolean; sort: SortMode; scrollTop?: number }
interface StoredComment extends CommentItem { sessionKey: string }
interface StoreOptions { indexedDB?: IDBFactory; databaseName?: string; maxComments?: number }

const DATABASE_NAME = "xiaole-comment-sessions-v1";
const SESSIONS = "sessions";
const COMMENTS = "comments";
const SESSION_INDEX = "session";
const scopeKey = (sessionKey: string, videoId: string): IDBValidKey => [sessionKey, videoId];
const clampScroll = (value: number | undefined): number => Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;

/** Pick only public comment fields: DOM nodes and accidental controller data never enter IndexedDB. */
function snapshot(comment: CommentItem): CommentItem {
  return {
    id: comment.id, nativeId: comment.nativeId, videoId: comment.videoId, videoUrl: comment.videoUrl,
    videoTitle: comment.videoTitle, authorName: comment.authorName, authorUrl: comment.authorUrl,
    text: comment.text, likeCount: comment.likeCount, likeCountRaw: comment.likeCountRaw,
    replyCount: comment.replyCount, replyCountRaw: comment.replyCountRaw,
    replyCountEstimated: comment.replyCountEstimated, publishTimeText: comment.publishTimeText,
    ipLocationText: comment.ipLocationText, originalIndex: comment.originalIndex,
    scannedAt: comment.scannedAt, parseWarnings: [...comment.parseWarnings]
  };
}

/**
 * One tab/video owns one session. A fresh lease invalidates old asynchronous saves.
 * Comments are incremental rows; progress never serializes a 100,000-row JSON blob.
 */
export class CommentSessionStore {
  private readonly factory: IDBFactory | undefined;
  private readonly databaseName: string;
  private readonly maxComments: number;
  private opening: Promise<IDBDatabase> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: StoreOptions = {}) {
    this.factory = options.indexedDB ?? globalThis.indexedDB;
    this.databaseName = options.databaseName ?? DATABASE_NAME;
    this.maxComments = Math.min(MAX_COLLECTED_COMMENTS, Math.max(1, Math.floor(options.maxComments ?? MAX_COLLECTED_COMMENTS)));
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private database(): Promise<IDBDatabase> {
    if (this.opening) return this.opening;
    if (!this.factory) return Promise.reject(new Error("浏览器不支持保存评论进度，请检查网站存储设置。"));
    this.opening = new Promise<IDBDatabase>((resolve, reject) => {
      let failed = false;
      const request = this.factory!.open(this.databaseName, 1);
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
        if (failed) { database.close(); return; }
        database.onversionchange = () => { database.close(); this.opening = null; };
        resolve(database);
      };
      request.onerror = () => { failed = true; reject(request.error ?? new Error("无法打开评论进度存储。")); };
      request.onblocked = () => { failed = true; reject(new Error("评论进度存储被旧页面占用，请关闭旧页面后重试。")); };
    }).catch((error: unknown) => { this.opening = null; throw error; });
    return this.opening;
  }

  private transaction<T>(database: IDBDatabase, mode: IDBTransactionMode, body: (transaction: IDBTransaction, resolveResult: (value: T) => void) => void): Promise<T> {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction([SESSIONS, COMMENTS], mode);
      let result: T;
      let assigned = false;
      transaction.oncomplete = () => assigned ? resolve(result) : reject(new Error("评论进度存储未完成。"));
      transaction.onabort = () => reject(transaction.error ?? new Error("保存评论进度失败，请检查磁盘空间和网站存储权限。"));
      transaction.onerror = () => { /* The transaction abort handler reports the failure once. */ };
      try { body(transaction, value => { result = value; assigned = true; }); }
      catch (error) { transaction.abort(); reject(error); }
    });
  }

  load(sessionKey: string, videoId: string): Promise<SavedCollectionSession | null> {
    return this.serial(async () => this.transaction(await this.database(), "readonly", (transaction, finish) => {
      const session = transaction.objectStore(SESSIONS).get(scopeKey(sessionKey, videoId));
      session.onsuccess = () => {
        const metadata = session.result as SessionMetadata | undefined;
        if (!metadata) { finish(null); return; }
        const rows = transaction.objectStore(COMMENTS).index(SESSION_INDEX).getAll(scopeKey(sessionKey, videoId));
        rows.onsuccess = () => {
          const comments = (rows.result as StoredComment[]).map(snapshot).sort((left, right) => left.originalIndex - right.originalIndex);
          finish({ metadata: { ...metadata, count: comments.length }, comments });
        };
      };
    }));
  }

  begin(sessionKey: string, videoId: string, options: SessionOptions): Promise<SessionLease> {
    if (!sessionKey || !videoId) return Promise.reject(new Error("保存采集进度需要明确的视频编号。"));
    const lease: SessionLease = { sessionKey, videoId, runId: crypto.randomUUID() };
    return this.serial(async () => this.transaction(await this.database(), "readwrite", (transaction, finish) => {
      const sessions = transaction.objectStore(SESSIONS);
      const existing = sessions.get(scopeKey(sessionKey, videoId));
      existing.onsuccess = () => {
        const old = existing.result as SessionMetadata | undefined;
        const count = transaction.objectStore(COMMENTS).index(SESSION_INDEX).count(scopeKey(sessionKey, videoId));
        count.onsuccess = () => {
          sessions.put({
            ...lease, state: "running", target: Math.min(this.maxComments, Math.max(1, Math.floor(options.target) || this.maxComments)),
            exportAfter: options.exportAfter === true, sort: ["original", "likes", "replies"].includes(options.sort) ? options.sort : "original",
            scrollTop: options.scrollTop === undefined ? clampScroll(old?.scrollTop) : clampScroll(options.scrollTop),
            count: count.result, updatedAt: Date.now()
          } satisfies SessionMetadata);
          finish(lease);
        };
      };
    }));
  }

  checkpoint(lease: SessionLease, comments: readonly CommentItem[], position: { scrollTop?: number } = {}): Promise<{ accepted: boolean; count: number }> {
    // Capture the batch before it enters the queue; callers may drain or mutate their cache next.
    const updates = new Map<string, CommentItem>();
    for (const comment of comments) {
      if (comment.videoId === lease.videoId && comment.id) updates.set(comment.id, snapshot(comment));
    }
    return this.serial(async () => this.transaction(await this.database(), "readwrite", (transaction, finish) => {
      const sessions = transaction.objectStore(SESSIONS);
      const existing = sessions.get(scopeKey(lease.sessionKey, lease.videoId));
      existing.onsuccess = () => {
        const metadata = existing.result as SessionMetadata | undefined;
        if (!metadata || metadata.runId !== lease.runId || metadata.state !== "running") {
          finish({ accepted: false, count: metadata?.count ?? 0 }); return;
        }
        const store = transaction.objectStore(COMMENTS);
        let count = metadata.count;
        let pending = updates.size;
        const saved = () => {
          sessions.put({ ...metadata, count, scrollTop: position.scrollTop === undefined ? metadata.scrollTop : clampScroll(position.scrollTop), updatedAt: Date.now() });
          finish({ accepted: true, count });
        };
        if (!pending) { saved(); return; }
        for (const comment of updates.values()) {
          const request = store.get([lease.sessionKey, lease.videoId, comment.id]);
          request.onsuccess = () => {
            try {
              const previous = request.result as StoredComment | undefined;
              if (previous || count < this.maxComments) {
                if (!previous) count += 1;
                store.put({ ...comment, originalIndex: previous?.originalIndex ?? comment.originalIndex, sessionKey: lease.sessionKey } satisfies StoredComment);
              }
              pending -= 1;
              if (pending === 0) saved();
            } catch { transaction.abort(); }
          };
        }
      };
    }));
  }

  setState(lease: SessionLease, state: CollectionSessionState): Promise<boolean> {
    return this.serial(async () => this.transaction(await this.database(), "readwrite", (transaction, finish) => {
      const sessions = transaction.objectStore(SESSIONS);
      const request = sessions.get(scopeKey(lease.sessionKey, lease.videoId));
      request.onsuccess = () => {
        const metadata = request.result as SessionMetadata | undefined;
        if (!metadata || metadata.runId !== lease.runId || (["stopped", "completed"].includes(metadata.state) && metadata.state !== state)) {
          finish(false); return;
        }
        sessions.put({ ...metadata, state, updatedAt: Date.now() });
        finish(true);
      };
    }));
  }

  clear(sessionKey: string, videoId: string): Promise<void> {
    return this.serial(async () => this.transaction(await this.database(), "readwrite", (transaction, finish) => {
      transaction.objectStore(SESSIONS).delete(scopeKey(sessionKey, videoId));
      const cursor = transaction.objectStore(COMMENTS).index(SESSION_INDEX).openCursor(scopeKey(sessionKey, videoId));
      cursor.onsuccess = () => {
        if (!cursor.result) { finish(undefined); return; }
        cursor.result.delete(); cursor.result.continue();
      };
    }));
  }

  async close(): Promise<void> {
    await this.queue;
    const opening = this.opening; this.opening = null;
    if (opening) (await opening).close();
  }
}
