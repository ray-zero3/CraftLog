/**
 * CraftLog ファイルシステムウォッチャー
 * ファイルの作成・削除をリアルタイムで検知
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { FileCreateEvent, FileDeleteEvent, CraftLogConfig, SessionState, FileInfo } from './types';
import { LogWriter } from './logWriter';
import { minimatch } from './minimatch';

export class FileWatcher implements vscode.Disposable {
  private config: CraftLogConfig;
  private sessionState: SessionState;
  private logWriter: LogWriter;
  private workspacePath: string;
  private watcher: vscode.FileSystemWatcher | null = null;
  private disposables: vscode.Disposable[] = [];

  // 削除されたファイルの統計をキャッシュ（削除前に取得しておく）
  private fileStatsCache: Map<string, { loc: number; bytes: number }> = new Map();

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

    this.setupWatcher();
  }

  /**
   * FileSystemWatcherをセットアップ
   */
  private setupWatcher(): void {
    // **/* で全ファイルを監視
    this.watcher = vscode.workspace.createFileSystemWatcher('**/*');

    this.disposables.push(
      this.watcher.onDidCreate(uri => this.handleCreate(uri)),
      this.watcher.onDidDelete(uri => this.handleDelete(uri)),
      this.watcher
    );
  }

  /**
   * ファイル作成イベントハンドラ
   */
  private async handleCreate(uri: vscode.Uri): Promise<void> {
    if (!this.sessionState.isLogging) {
      return;
    }

    // ファイルスキーマチェック
    if (uri.scheme !== 'file') {
      return;
    }

    const relativePath = this.getRelativePath(uri.fsPath);

    // 除外パターンチェック
    if (this.shouldExclude(relativePath)) {
      return;
    }

    // 対象拡張子チェック
    const ext = path.extname(uri.fsPath).slice(1).toLowerCase();
    if (!this.config.targetExtensions.includes(ext)) {
      return;
    }

    // ディレクトリの場合はスキップ
    try {
      const stat = await fs.promises.stat(uri.fsPath);
      if (stat.isDirectory()) {
        return;
      }
    } catch {
      return;
    }

    // ファイル統計を取得
    const stats = await this.getFileStats(uri.fsPath);
    if (!stats) {
      return;
    }

    // ファイル情報を構築
    const fileInfo: FileInfo = {
      path: relativePath,
      lang: this.getLanguageId(uri.fsPath),
      scheme: uri.scheme
    };

    const event: FileCreateEvent = {
      ts: Date.now(),
      session_id: this.sessionState.sessionId,
      workspace_id: this.sessionState.workspaceId,
      event: 'file_create',
      vscode_version: vscode.version,
      file: fileInfo,
      stats
    };

    this.logWriter.write(event);

    // キャッシュに追加（将来の削除検知用）
    this.fileStatsCache.set(uri.fsPath, stats);
  }

  /**
   * ファイル削除イベントハンドラ
   */
  private async handleDelete(uri: vscode.Uri): Promise<void> {
    if (!this.sessionState.isLogging) {
      return;
    }

    if (uri.scheme !== 'file') {
      return;
    }

    const relativePath = this.getRelativePath(uri.fsPath);

    // 除外パターンチェック
    if (this.shouldExclude(relativePath)) {
      return;
    }

    // 対象拡張子チェック
    const ext = path.extname(uri.fsPath).slice(1).toLowerCase();
    if (!this.config.targetExtensions.includes(ext)) {
      return;
    }

    // ファイル情報を構築
    const fileInfo: FileInfo = {
      path: relativePath,
      lang: this.getLanguageId(uri.fsPath),
      scheme: uri.scheme
    };

    // キャッシュから統計を取得（あれば）
    const cachedStats = this.fileStatsCache.get(uri.fsPath);
    this.fileStatsCache.delete(uri.fsPath);

    const event: FileDeleteEvent = {
      ts: Date.now(),
      session_id: this.sessionState.sessionId,
      workspace_id: this.sessionState.workspaceId,
      event: 'file_delete',
      vscode_version: vscode.version,
      file: fileInfo,
      stats: cachedStats
    };

    this.logWriter.write(event);
  }

  /**
   * ファイル統計を取得
   */
  private async getFileStats(filePath: string): Promise<{ loc: number; bytes: number } | null> {
    try {
      const stat = await fs.promises.stat(filePath);
      const content = await fs.promises.readFile(filePath, 'utf8');
      const loc = (content.match(/\n/g) || []).length + 1;

      return {
        loc,
        bytes: stat.size
      };
    } catch {
      return null;
    }
  }

  /**
   * 相対パスを取得
   */
  private getRelativePath(absolutePath: string): string {
    if (this.workspacePath && absolutePath.startsWith(this.workspacePath)) {
      return path.relative(this.workspacePath, absolutePath);
    }
    return path.basename(absolutePath);
  }

  /**
   * 言語IDを推定
   */
  private getLanguageId(filePath: string): string {
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const langMap: Record<string, string> = {
      'js': 'javascript',
      'ts': 'typescript',
      'jsx': 'javascriptreact',
      'tsx': 'typescriptreact',
      'py': 'python',
      'rb': 'ruby',
      'go': 'go',
      'rs': 'rust',
      'java': 'java',
      'cpp': 'cpp',
      'c': 'c',
      'h': 'c',
      'hpp': 'cpp',
      'cs': 'csharp',
      'php': 'php',
      'swift': 'swift',
      'kt': 'kotlin',
      'scala': 'scala',
      'vue': 'vue',
      'svelte': 'svelte',
      'html': 'html',
      'css': 'css',
      'scss': 'scss',
      'less': 'less',
      'json': 'json',
      'yaml': 'yaml',
      'yml': 'yaml',
      'md': 'markdown',
      'sql': 'sql'
    };
    return langMap[ext] || ext;
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

  /**
   * 現在のワークスペースの全ファイル統計をキャッシュに追加
   * セッション開始時に呼び出す
   */
  public async initializeCache(): Promise<void> {
    try {
      const excludePattern = '**/node_modules/**';
      const files = await vscode.workspace.findFiles('**/*', excludePattern);

      for (const uri of files) {
        const relativePath = this.getRelativePath(uri.fsPath);

        if (this.shouldExclude(relativePath)) {
          continue;
        }

        const ext = path.extname(uri.fsPath).slice(1).toLowerCase();
        if (!this.config.targetExtensions.includes(ext)) {
          continue;
        }

        const stats = await this.getFileStats(uri.fsPath);
        if (stats) {
          this.fileStatsCache.set(uri.fsPath, stats);
        }
      }
    } catch (error) {
      console.error('CraftLog: Failed to initialize file cache', error);
    }
  }

  /**
   * 設定を更新
   */
  public updateConfig(config: CraftLogConfig): void {
    this.config = config;
  }

  public dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
    this.fileStatsCache.clear();
  }
}
