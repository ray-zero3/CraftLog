/**
 * CraftLog スナップショットハンドラ
 * ワークスペースの状態を定期的に記録
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SnapshotEvent, WorkspaceDiffEvent, CraftLogConfig, SessionState, WorkspaceInfo, GitInfo } from './types';
import { LogWriter } from './logWriter';
import { minimatch } from './minimatch';
import { calculateElapsedMs } from './extension';

// 個別ファイルの統計
interface SingleFileStats {
  loc: number;
  bytes: number;
}

// ワークスペース全体の統計
interface WorkspaceStats {
  files: number;
  loc: number;
  bytes: number;
  fileMap: Map<string, SingleFileStats>;
}

// キャッシュ用
interface CachedStats {
  stats: WorkspaceStats;
  timestamp: number;
}

export class SnapshotHandler implements vscode.Disposable {
  private config: CraftLogConfig;
  private sessionState: SessionState;
  private logWriter: LogWriter;
  private workspacePath: string;
  private snapshotTimer: NodeJS.Timeout | null = null;
  private statsCache: CachedStats | null = null;
  private cacheValidityMs = 5000; // キャッシュ有効期間

  // 前回のスナップショット時のファイル一覧（workspace_diff 計算用）
  private previousWorkspaceFiles: Map<string, SingleFileStats> = new Map();

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
  }

  /**
   * 定期スナップショットを開始
   */
  public startPeriodicSnapshots(): void {
    this.stopPeriodicSnapshots();

    this.snapshotTimer = setInterval(
      () => this.takeSnapshot(),
      this.config.snapshotIntervalMs
    );
  }

  /**
   * 定期スナップショットを停止
   */
  public stopPeriodicSnapshots(): void {
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
  }

  /**
   * スナップショットを取得して記録
   */
  public async takeSnapshot(): Promise<void> {
    if (!this.sessionState.isLogging) {
      return;
    }

    try {
      const workspaceStats = await this.collectWorkspaceStatsWithFileMap();
      const gitInfo = await this.collectGitInfo();

      // snapshot イベントを出力
      const snapshotEvent: SnapshotEvent = {
        ts: Date.now(),
        elapsed_ms: calculateElapsedMs(),
        session_id: this.sessionState.sessionId,
        workspace_id: this.sessionState.workspaceId,
        event: 'snapshot',
        vscode_version: vscode.version,
        workspace: {
          files_count: workspaceStats.files,
          total_loc: workspaceStats.loc,
          total_bytes: workspaceStats.bytes
        },
        git: gitInfo
      };

      this.logWriter.write(snapshotEvent);

      // workspace_diff を計算して出力
      await this.emitWorkspaceDiff(workspaceStats.fileMap);

      // 現在のファイルマップを保存（次回のdiff計算用）
      this.previousWorkspaceFiles = new Map(workspaceStats.fileMap);
    } catch (error) {
      console.error('CraftLog: Failed to take snapshot', error);
    }
  }

  /**
   * workspace_diff イベントを計算して出力
   */
  private async emitWorkspaceDiff(currentFileMap: Map<string, SingleFileStats>): Promise<void> {
    // 初回は前回データがないのでスキップ
    if (this.previousWorkspaceFiles.size === 0) {
      return;
    }

    const addedPaths: string[] = [];
    const removedPaths: string[] = [];
    let addedLoc = 0;
    let removedLoc = 0;
    let addedBytes = 0;
    let removedBytes = 0;

    // 新規追加されたファイル
    for (const [filePath, stats] of currentFileMap) {
      if (!this.previousWorkspaceFiles.has(filePath)) {
        addedPaths.push(filePath);
        addedLoc += stats.loc;
        addedBytes += stats.bytes;
      } else {
        // 既存ファイルのLOC/bytes変化
        const prevStats = this.previousWorkspaceFiles.get(filePath)!;
        const locDiff = stats.loc - prevStats.loc;
        const bytesDiff = stats.bytes - prevStats.bytes;

        if (locDiff > 0) {
          addedLoc += locDiff;
        } else if (locDiff < 0) {
          removedLoc += Math.abs(locDiff);
        }

        if (bytesDiff > 0) {
          addedBytes += bytesDiff;
        } else if (bytesDiff < 0) {
          removedBytes += Math.abs(bytesDiff);
        }
      }
    }

    // 削除されたファイル
    for (const [filePath, stats] of this.previousWorkspaceFiles) {
      if (!currentFileMap.has(filePath)) {
        removedPaths.push(filePath);
        removedLoc += stats.loc;
        removedBytes += stats.bytes;
      }
    }

    // 差分がある場合のみイベントを出力
    if (addedPaths.length > 0 || removedPaths.length > 0 ||
        addedLoc > 0 || removedLoc > 0 || addedBytes > 0 || removedBytes > 0) {
      const diffEvent: WorkspaceDiffEvent = {
        ts: Date.now(),
        elapsed_ms: calculateElapsedMs(),
        session_id: this.sessionState.sessionId,
        workspace_id: this.sessionState.workspaceId,
        event: 'workspace_diff',
        vscode_version: vscode.version,
        added_files: addedPaths.length,
        removed_files: removedPaths.length,
        added_loc: addedLoc,
        removed_loc: removedLoc,
        added_bytes: addedBytes,
        removed_bytes: removedBytes,
        added_paths: addedPaths,
        removed_paths: removedPaths
      };

      this.logWriter.write(diffEvent);
    }
  }

  /**
   * ワークスペースの統計情報をファイルマップ付きで収集
   */
  private async collectWorkspaceStatsWithFileMap(): Promise<WorkspaceStats> {
    // キャッシュが有効ならそれを返す
    if (this.statsCache && Date.now() - this.statsCache.timestamp < this.cacheValidityMs) {
      return this.statsCache.stats;
    }

    const stats = await this.calculateStatsWithFileMap();

    // キャッシュを更新
    this.statsCache = {
      stats,
      timestamp: Date.now()
    };

    return stats;
  }

  /**
   * vscode.workspace.findFiles を使用してファイル一覧を取得し統計を計算
   */
  private async calculateStatsWithFileMap(): Promise<WorkspaceStats> {
    let files = 0;
    let loc = 0;
    let bytes = 0;
    const fileMap = new Map<string, SingleFileStats>();

    try {
      // 除外パターンを構築（node_modules, .git は必ず除外）
      const excludePattern = '{**/node_modules/**,**/.git/**}';

      // 対象拡張子のパターンを構築
      const extensions = this.config.targetExtensions.join(',');
      const includePattern = `**/*.{${extensions}}`;

      const uris = await vscode.workspace.findFiles(includePattern, excludePattern);

      for (const uri of uris) {
        const relativePath = path.relative(this.workspacePath, uri.fsPath);

        // 追加の除外パターンチェック
        if (this.shouldExclude(relativePath)) {
          continue;
        }

        try {
          const stat = await fs.promises.stat(uri.fsPath);
          if (!stat.isFile()) {
            continue;
          }

          const content = await fs.promises.readFile(uri.fsPath, 'utf8');
          const lineCount = (content.match(/\n/g) || []).length + 1;

          files++;
          loc += lineCount;
          bytes += stat.size;

          fileMap.set(relativePath, {
            loc: lineCount,
            bytes: stat.size
          });
        } catch {
          // ファイル読み込みエラーは無視
        }
      }
    } catch (error) {
      console.error('CraftLog: Failed to calculate workspace stats', error);
    }

    return { files, loc, bytes, fileMap };
  }

  /**
   * ワークスペースの統計情報を収集（後方互換性のため残す）
   */
  private async collectWorkspaceStats(): Promise<WorkspaceInfo> {
    const stats = await this.collectWorkspaceStatsWithFileMap();
    return {
      files_count: stats.files,
      total_loc: stats.loc,
      total_bytes: stats.bytes
    };
  }

  /**
   * Git情報を収集
   */
  private async collectGitInfo(): Promise<GitInfo | undefined> {
    const gitDir = path.join(this.workspacePath, '.git');

    try {
      const stat = await fs.promises.stat(gitDir);
      if (!stat.isDirectory()) {
        return { is_repo: false, head: null };
      }

      // HEADを読み取り
      const headPath = path.join(gitDir, 'HEAD');
      const headContent = await fs.promises.readFile(headPath, 'utf8');

      let head: string | null = null;

      if (headContent.startsWith('ref: ')) {
        // ブランチ参照の場合
        const refPath = headContent.slice(5).trim();
        const refFullPath = path.join(gitDir, refPath);

        try {
          head = (await fs.promises.readFile(refFullPath, 'utf8')).trim().substring(0, 8);
        } catch {
          // パックされたrefsの場合などは省略
          head = refPath.split('/').pop() || null;
        }
      } else {
        // 直接コミットハッシュの場合
        head = headContent.trim().substring(0, 8);
      }

      return {
        is_repo: true,
        head
      };
    } catch {
      return { is_repo: false, head: null };
    }
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
   * キャッシュを無効化
   */
  public invalidateCache(): void {
    this.statsCache = null;
  }

  /**
   * 設定を更新
   */
  public updateConfig(config: CraftLogConfig): void {
    const intervalChanged = this.config.snapshotIntervalMs !== config.snapshotIntervalMs;
    this.config = config;

    if (intervalChanged && this.snapshotTimer) {
      this.startPeriodicSnapshots();
    }
  }

  public dispose(): void {
    this.stopPeriodicSnapshots();
  }
}
