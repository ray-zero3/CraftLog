/**
 * CraftLog ログライター
 * Write Streamを使用した低メモリフットプリント実装
 * イベントは即座にファイルに書き込まれ、メモリにはバッファリングしない
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { CraftLogEvent, CraftLogConfig } from './types';

export class LogWriter {
  private writeStream: fs.WriteStream | null = null;
  private logFilePath: string;
  private config: CraftLogConfig;
  private currentFileSize: number = 0;
  private fileIndex: number = 0;
  private baseLogPath: string;
  private pendingWrites: number = 0;
  private pendingResolvers: Array<() => void> = [];
  private drainPromise: Promise<void> | null = null;
  private drainResolve: (() => void) | null = null;

  constructor(logFilePath: string, config: CraftLogConfig) {
    this.logFilePath = logFilePath;
    this.baseLogPath = logFilePath;
    this.config = config;
    this.ensureLogDirectory();
    this.updateCurrentFileSize();
    this.openStream();
  }

  private ensureLogDirectory(): void {
    const dir = path.dirname(this.logFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private updateCurrentFileSize(): void {
    try {
      if (fs.existsSync(this.logFilePath)) {
        const stats = fs.statSync(this.logFilePath);
        this.currentFileSize = stats.size;
      } else {
        this.currentFileSize = 0;
      }
    } catch {
      this.currentFileSize = 0;
    }
  }

  /**
   * Write Streamを開く
   */
  private openStream(): void {
    this.closeStream();
    this.writeStream = fs.createWriteStream(this.logFilePath, {
      flags: 'a',           // append mode
      encoding: 'utf8',
      autoClose: true,
      highWaterMark: 16 * 1024  // 16KB internal buffer (Node.js default)
    });

    this.writeStream.on('error', (error) => {
      console.error('CraftLog: Write stream error', error);
    });

    this.writeStream.on('drain', () => {
      if (this.drainResolve) {
        this.drainResolve();
        this.drainResolve = null;
        this.drainPromise = null;
      }
    });
  }

  /**
   * Write Streamを閉じる（同期版 - ローテーション用）
   */
  private closeStream(): void {
    if (this.writeStream) {
      this.writeStream.end();
      this.writeStream = null;
    }
  }

  /**
   * Write Streamを閉じる（非同期版 - 完了を待つ）
   */
  private async closeStreamAsync(): Promise<void> {
    if (this.writeStream) {
      await new Promise<void>((resolve, reject) => {
        if (!this.writeStream) {
          resolve();
          return;
        }
        this.writeStream.once('finish', resolve);
        this.writeStream.once('error', reject);
        this.writeStream.end();
      });
      this.writeStream = null;
    }
  }

  /**
   * ファイルローテーション
   */
  private rotateIfNeeded(): void {
    const maxBytes = this.config.maxFileSizeMB * 1024 * 1024;
    if (this.currentFileSize >= maxBytes) {
      this.closeStream();
      this.fileIndex++;
      const ext = path.extname(this.baseLogPath);
      const base = this.baseLogPath.slice(0, -ext.length);
      this.logFilePath = `${base}_${this.fileIndex}${ext}`;
      this.currentFileSize = 0;
      this.openStream();
    }
  }

  /**
   * イベントを即座にファイルに書き込み
   * メモリにはバッファリングせず、Node.jsのストリームバッファに委譲
   */
  public write(event: CraftLogEvent): void {
    if (!this.writeStream) {
      this.openStream();
    }

    this.rotateIfNeeded();

    const line = JSON.stringify(event) + '\n';
    const bytesToWrite = Buffer.byteLength(line, 'utf8');

    this.pendingWrites++;
    const canContinue = this.writeStream!.write(line, 'utf8', (err) => {
      this.pendingWrites--;
      if (err) {
        console.error('CraftLog: Failed to write event', err);
      }
      // pendingWritesが0になったら、待機中のresolverを全て呼び出す
      if (this.pendingWrites === 0 && this.pendingResolvers.length > 0) {
        const resolvers = this.pendingResolvers.splice(0);
        resolvers.forEach(resolve => resolve());
      }
    });

    this.currentFileSize += bytesToWrite;

    // バックプレッシャー: ストリームバッファがいっぱいになった場合
    if (!canContinue && !this.drainPromise) {
      this.drainPromise = new Promise<void>((resolve) => {
        this.drainResolve = resolve;
      });
    }
  }

  /**
   * 強制フラッシュ（すべての書き込みが完了するまで待機）
   */
  public async forceFlush(): Promise<void> {
    // drainを待つ
    if (this.drainPromise) {
      await this.drainPromise;
    }

    // pending writesが完了するまで待つ
    if (this.pendingWrites > 0) {
      await new Promise<void>((resolve) => {
        this.pendingResolvers.push(resolve);
      });
    }

    // ストリームを同期的にフラッシュ（Node.js 内部バッファをOSに送る）
    if (this.writeStream && this.writeStream.writable) {
      // ストリームのcork/uncorkでバッファを強制フラッシュ
      this.writeStream.cork();
      this.writeStream.uncork();
    }
  }

  /**
   * ログファイルパスを取得
   */
  public getLogFilePath(): string {
    return this.logFilePath;
  }

  /**
   * リソースをクリーンアップ（非同期 - すべての書き込みを待ってから閉じる）
   */
  public async dispose(): Promise<void> {
    await this.forceFlush();
    await this.closeStreamAsync();
  }
}

/**
 * ユーティリティ関数
 */

/**
 * ワークスペースパスをハッシュ化してworkspace_idを生成
 */
export function generateWorkspaceId(workspacePath: string): string {
  const hash = crypto.createHash('sha256').update(workspacePath).digest('hex');
  return `W_${hash.substring(0, 8)}`;
}

/**
 * セッションIDを生成
 */
export function generateSessionId(): string {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const random = crypto.randomBytes(4).toString('hex');
  return `S_${dateStr}_${random}`;
}

/**
 * 文字列のSHA-256ハッシュを生成
 */
export function hashString(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * ログディレクトリパスを決定
 */
export function getLogDirectory(
  config: CraftLogConfig,
  workspacePath: string | undefined
): string {
  if (config.logDirectory) {
    return config.logDirectory;
  }

  if (workspacePath) {
    return path.join(workspacePath, '.craftlog');
  }

  // フォールバック: ホームディレクトリ
  const homeDir = process.env.HOME || process.env.USERPROFILE || '.';
  return path.join(homeDir, 'CraftLogs');
}

/**
 * ログファイルパスを生成
 */
export function generateLogFilePath(logDirectory: string, sessionId: string): string {
  return path.join(logDirectory, `${sessionId}.jsonl`);
}
