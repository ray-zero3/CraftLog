/**
 * CraftLog イベント型定義
 */

// 共通ヘッダー（全イベント必須）
export interface EventHeader {
  ts: number;                    // UNIX epoch ms
  session_id: string;            // 制作セッションID
  workspace_id: string;          // ワークスペース識別（パスをハッシュ化）
  event: EventType;              // イベント種別
  vscode_version?: string;       // 任意
  ext_version?: string;          // 任意
}

export type EventType = 'edit' | 'ai_prompt' | 'snapshot' | 'note' | 'session_start' | 'session_end' | 'session_pause' | 'session_resume' | 'file_create' | 'file_delete' | 'workspace_diff';

// ファイル情報
export interface FileInfo {
  path: string;                  // workspace相対パス
  lang: string;                  // 言語ID
  scheme: string;                // 例: file
}

// 差分情報
export interface DeltaInfo {
  added_chars: number;
  deleted_chars: number;
  added_lines: number;
  deleted_lines: number;
}

// フラグ情報
export interface EditFlags {
  is_paste_like: boolean;        // 閾値で推定
  is_undo_like: boolean;         // 推定
  is_redo_like: boolean;         // 推定
}

// カーソル位置
export interface CursorPosition {
  line: number;
  character: number;
}

// 5.1 edit イベント
export interface EditEvent extends EventHeader {
  event: 'edit';
  file: FileInfo;
  delta: DeltaInfo;
  flags: EditFlags;
  cursor?: CursorPosition;       // 任意
  change_count?: number;         // 任意
}

// プロンプト情報
export interface PromptInfo {
  length: number;                // 文字数
  hash: string;                  // SHA-256
  stored: boolean;               // 本文を保存したか
  text?: string;                 // 本文（オプション）
}

// 5.2 ai_prompt イベント
export interface AIPromptEvent extends EventHeader {
  event: 'ai_prompt';
  prompt: PromptInfo;
  mode: string;                  // copilot_chat / agent / unknown
  note: string;                  // 任意。自己申告メモ
}

// ワークスペース情報
export interface WorkspaceInfo {
  files_count: number;           // 対象ファイル数
  total_loc: number;             // 総行数
  total_bytes?: number;          // 任意
}

// Git情報
export interface GitInfo {
  is_repo: boolean;
  head: string | null;
}

// 5.3 snapshot イベント
export interface SnapshotEvent extends EventHeader {
  event: 'snapshot';
  workspace: WorkspaceInfo;
  git?: GitInfo;                 // 任意
}

// note イベント
export interface NoteEvent extends EventHeader {
  event: 'note';
  content: string;
}

// session_start イベント
export interface SessionStartEvent extends EventHeader {
  event: 'session_start';
}

// session_end イベント
export interface SessionEndEvent extends EventHeader {
  event: 'session_end';
}

// session_pause イベント
export interface SessionPauseEvent extends EventHeader {
  event: 'session_pause';
}

// session_resume イベント
export interface SessionResumeEvent extends EventHeader {
  event: 'session_resume';
}

// file_create イベント
export interface FileCreateEvent extends EventHeader {
  event: 'file_create';
  file: FileInfo;
  stats: {
    loc: number;
    bytes: number;
  };
}

// file_delete イベント
export interface FileDeleteEvent extends EventHeader {
  event: 'file_delete';
  file: FileInfo;
  stats?: {
    loc: number;
    bytes: number;
  };
}

// workspace_diff イベント
export interface WorkspaceDiffEvent extends EventHeader {
  event: 'workspace_diff';
  added_files: number;
  removed_files: number;
  added_loc: number;
  removed_loc: number;
  added_bytes: number;
  removed_bytes: number;
  added_paths: string[];
  removed_paths: string[];
}

// 全イベント型
export type CraftLogEvent =
  | EditEvent
  | AIPromptEvent
  | SnapshotEvent
  | NoteEvent
  | SessionStartEvent
  | SessionEndEvent
  | SessionPauseEvent
  | SessionResumeEvent
  | FileCreateEvent
  | FileDeleteEvent
  | WorkspaceDiffEvent;

// 設定
export interface CraftLogConfig {
  storePromptText: boolean;
  logDirectory: string;
  snapshotIntervalMs: number;
  pasteLikeThreshold: number;
  excludePatterns: string[];
  targetExtensions: string[];
  maxFileSizeMB: number;
}

// セッション状態
export interface SessionState {
  sessionId: string;
  workspaceId: string;
  isLogging: boolean;
  isPaused: boolean;
  logFilePath: string;
  startTime: number;
}

// 永続化用のセッション情報
export interface SavedSessionInfo {
  sessionId: string;
  workspaceId: string;
  logFilePath: string;
  startTime: number;
  pausedAt: number;
}
