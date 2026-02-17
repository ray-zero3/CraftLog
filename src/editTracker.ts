/**
 * CraftLog 編集イベントトラッカー
 * workspace.onDidChangeTextDocument を監視して差分を記録
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { EditEvent, CraftLogConfig, SessionState, DeltaInfo, EditFlags, FileInfo } from './types';
import { LogWriter } from './logWriter';
import { minimatch } from './minimatch';

export class EditTracker implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private config: CraftLogConfig;
  private sessionState: SessionState;
  private logWriter: LogWriter;
  private workspacePath: string;

  // undo/redo検出用のキャッシュ
  private lastDeletedContent: Map<string, string> = new Map();
  private lastAddedContent: Map<string, string> = new Map();

  constructor(
    config: CraftLogConfig,
    sessionState: SessionState,
    logWriter: LogWriter,
    workspacePath: string
  ) {
    this.config = config;
    this.sessionState = sessionState;
    this.logWriter = logWriter;
    this.workspacePath = workspacePath;

    // ドキュメント変更イベントの監視
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(this.handleDocumentChange.bind(this))
    );
  }

  /**
   * ドキュメント変更イベントハンドラ
   */
  private handleDocumentChange(event: vscode.TextDocumentChangeEvent): void {
    if (!this.sessionState.isLogging) {
      return;
    }

    const document = event.document;

    // スキーマチェック（file以外は除外）
    if (document.uri.scheme !== 'file') {
      return;
    }

    // 除外パターンチェック
    const relativePath = this.getRelativePath(document.uri.fsPath);
    if (this.shouldExclude(relativePath)) {
      return;
    }

    // 変更がない場合はスキップ
    if (event.contentChanges.length === 0) {
      return;
    }

    // 差分を計算
    const delta = this.calculateDelta(event.contentChanges, document);
    const flags = this.detectFlags(delta, event.contentChanges, document.uri.fsPath);

    // ファイル情報を構築
    const fileInfo: FileInfo = {
      path: relativePath,
      lang: document.languageId,
      scheme: document.uri.scheme
    };

    // カーソル位置を取得（アクティブエディタの場合）
    let cursor: { line: number; character: number } | undefined;
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && activeEditor.document.uri.toString() === document.uri.toString()) {
      const pos = activeEditor.selection.active;
      cursor = { line: pos.line, character: pos.character };
    }

    // イベントを構築
    const editEvent: EditEvent = {
      ts: Date.now(),
      session_id: this.sessionState.sessionId,
      workspace_id: this.sessionState.workspaceId,
      event: 'edit',
      vscode_version: vscode.version,
      file: fileInfo,
      delta,
      flags,
      cursor,
      change_count: event.contentChanges.length
    };

    // ログに書き込み
    this.logWriter.write(editEvent);

    // undo/redo検出用にキャッシュを更新
    this.updateContentCache(document.uri.fsPath, event.contentChanges);
  }

  /**
   * 差分を計算
   */
  private calculateDelta(
    changes: readonly vscode.TextDocumentContentChangeEvent[],
    document: vscode.TextDocument
  ): DeltaInfo {
    let addedChars = 0;
    let deletedChars = 0;
    let addedLines = 0;
    let deletedLines = 0;

    for (const change of changes) {
      // 追加された文字数と行数
      addedChars += change.text.length;
      addedLines += (change.text.match(/\n/g) || []).length;

      // 削除された文字数と行数
      deletedChars += change.rangeLength;

      // 削除された行数を計算
      const startLine = change.range.start.line;
      const endLine = change.range.end.line;
      if (endLine > startLine) {
        deletedLines += endLine - startLine;
      }
    }

    return {
      added_chars: addedChars,
      deleted_chars: deletedChars,
      added_lines: addedLines,
      deleted_lines: deletedLines
    };
  }

  /**
   * フラグを検出（paste-like, undo-like, redo-like）
   */
  private detectFlags(
    delta: DeltaInfo,
    changes: readonly vscode.TextDocumentContentChangeEvent[],
    filePath: string
  ): EditFlags {
    // paste-like: 大量の文字が追加された場合
    const isPasteLike = delta.added_chars >= this.config.pasteLikeThreshold;

    // undo-like: 以前追加された内容が削除された場合
    let isUndoLike = false;
    if (changes.length === 1 && delta.deleted_chars > 0 && delta.added_chars === 0) {
      const lastAdded = this.lastAddedContent.get(filePath);
      if (lastAdded && changes[0].rangeLength === lastAdded.length) {
        isUndoLike = true;
      }
    }

    // redo-like: 以前削除された内容が再追加された場合
    let isRedoLike = false;
    if (changes.length === 1 && delta.added_chars > 0 && delta.deleted_chars === 0) {
      const lastDeleted = this.lastDeletedContent.get(filePath);
      if (lastDeleted && changes[0].text === lastDeleted) {
        isRedoLike = true;
      }
    }

    return {
      is_paste_like: isPasteLike,
      is_undo_like: isUndoLike,
      is_redo_like: isRedoLike
    };
  }

  /**
   * undo/redo検出用のキャッシュを更新
   */
  private updateContentCache(
    filePath: string,
    changes: readonly vscode.TextDocumentContentChangeEvent[]
  ): void {
    if (changes.length !== 1) {
      // 複数の変更がある場合はキャッシュをクリア
      this.lastAddedContent.delete(filePath);
      this.lastDeletedContent.delete(filePath);
      return;
    }

    const change = changes[0];

    if (change.text.length > 0) {
      this.lastAddedContent.set(filePath, change.text);
    }

    if (change.rangeLength > 0) {
      // 削除された内容は取得できないので、rangeLength のみ記録
      // 実際の削除内容は document.getText(range) で事前に取得する必要があるが、
      // パフォーマンスの観点からここでは省略
      this.lastDeletedContent.set(filePath, '');
    }
  }

  /**
   * 相対パスを取得
   */
  private getRelativePath(absolutePath: string): string {
    if (this.workspacePath && absolutePath.startsWith(this.workspacePath)) {
      return path.relative(this.workspacePath, absolutePath);
    }
    // ワークスペース外のファイルの場合はファイル名のみ
    return path.basename(absolutePath);
  }

  /**
   * 除外パターンに一致するかチェック
   */
  private shouldExclude(relativePath: string): boolean {
    for (const pattern of this.config.excludePatterns) {
      if (minimatch(relativePath, pattern)) {
        return true;
      }
    }
    return false;
  }

  public dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
  }
}
