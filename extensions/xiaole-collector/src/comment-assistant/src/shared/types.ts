export type SortMode = "original" | "likes" | "replies";
export type PageState =
  | "ready"
  | "not-douyin"
  | "comment-area-missing"
  | "comments-empty"
  | "structure-changed";

export interface CommentItem {
  id: string;
  nativeId: string | null;
  videoId: string;
  videoUrl: string;
  videoTitle: string;
  authorName: string;
  authorUrl: string | null;
  text: string;
  likeCount: number;
  likeCountRaw: string;
  replyCount: number;
  replyCountRaw: string;
  replyCountEstimated: boolean;
  publishTimeText: string | null;
  ipLocationText: string | null;
  originalIndex: number;
  scannedAt: string;
  parseWarnings: string[];
}

export interface SelectorDiagnostics {
  commentContainerFound: boolean;
  commentContainerSelector: string | null;
  commentItemSelector: string | null;
  candidateNodeCount: number;
  commentItemCount: number;
  textParseSuccess: number;
  authorParseSuccess: number;
  likeParseSuccess: number;
  replyParseSuccess: number;
  filteredNodeCount: number;
  duplicateCount: number;
  elapsedMs: number;
  warnings: string[];
}

export interface PageStatus {
  state: PageState;
  message: string;
  isDouyin: boolean;
  hasCommentArea: boolean;
  videoId: string;
  videoUrl: string;
  videoTitle: string;
}

export interface ScanResult {
  pageStatus: PageStatus;
  comments: CommentItem[];
  mainCommentCount: number;
  scannedAt: string;
  likelyHasUnloadedComments: boolean;
  diagnostics: SelectorDiagnostics;
}
