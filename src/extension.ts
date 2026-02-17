/**
 * CraftLog VSCode拡張
 * プログラマーの制作過程を同一時間軸のログとして記録
 */

import * as vscode from 'vscode';
import {
  CraftLogConfig,
  SessionState,
  SessionStartEvent,
  SessionEndEvent,
  NoteEvent,
  SessionPauseEvent,
  SessionResumeEvent,
  SavedSessionInfo
} from './types';
import {
  LogWriter,
  generateSessionId,
  generateWorkspaceId,
  getLogDirectory,
  generateLogFilePath
} from './logWriter';
import { EditTracker } from './editTracker';
import { AIPromptHandler } from './aiPromptHandler';
import { SnapshotHandler } from './snapshotHandler';
import { FileWatcher } from './fileWatcher';

let extensionContext: vscode.ExtensionContext;
let statusBarItem: vscode.StatusBarItem;

// グローバル状態
let sessionState: SessionState | null = null;
let logWriter: LogWriter | null = null;
let editTracker: EditTracker | null = null;
let aiPromptHandler: AIPromptHandler | null = null;
let snapshotHandler: SnapshotHandler | null = null;
let fileWatcher: FileWatcher | null = null;

/**
 * 拡張機能のアクティベーション
 */
export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;

  // ステータスバーアイテムを作成
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = 'craftlog.toggleLogging';
  context.subscriptions.push(statusBarItem);
  updateStatusBar();
  statusBarItem.show();

  // コマンドを登録
  context.subscriptions.push(
    vscode.commands.registerCommand('craftlog.startSession', startSession),
    vscode.commands.registerCommand('craftlog.stopSession', stopSession),
    vscode.commands.registerCommand('craftlog.toggleLogging', toggleLogging),
    vscode.commands.registerCommand('craftlog.markAIPrompt', markAIPrompt),
    vscode.commands.registerCommand('craftlog.addNote', addNote),
    vscode.commands.registerCommand('craftlog.pauseSession', pauseSession),
    vscode.commands.registerCommand('craftlog.resumeSession', resumeSession)
  );

  // 設定変更の監視
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(handleConfigChange)
  );

  // 保存されたセッションがあれば復元を提案
  checkSavedSession();

  console.log('CraftLog: 拡張機能がアクティベートされました');
}

/**
 * 拡張機能のデアクティベーション
 */
export async function deactivate() {
  if (sessionState?.isLogging) {
    // VSCode終了時は自動的に一時停止として保存
    await pauseSession();
  }
}

/**
 * 設定を読み込み
 */
function loadConfig(): CraftLogConfig {
  const config = vscode.workspace.getConfiguration('craftlog');

  return {
    storePromptText: config.get<boolean>('storePromptText', false),
    logDirectory: config.get<string>('logDirectory', ''),
    snapshotIntervalMs: config.get<number>('snapshotIntervalMs', 10000),
    pasteLikeThreshold: config.get<number>('pasteLikeThreshold', 80),
    excludePatterns: config.get<string[]>('excludePatterns', [
      '**/.env',
      '**/.env.*',
      '**/secrets.*',
      '**/*.pem',
      '**/id_rsa',
      '**/id_rsa.*',
      '**/*.key',
      '**/keychain',
      '**/node_modules/**',
      '**/.git/**'
    ]),
    targetExtensions: config.get<string[]>('targetExtensions', [
      'js', 'ts', 'jsx', 'tsx', 'py', 'cpp', 'c', 'h', 'hpp',
      'java', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'scala', 'cs',
      'vue', 'svelte', 'html', 'css', 'scss', 'less', 'json', 'yaml', 'yml', 'md', 'sql'
    ]),
    maxFileSizeMB: config.get<number>('maxFileSizeMB', 50)
  };
}

/**
 * ワークスペースパスを取得
 */
function getWorkspacePath(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  return folders?.[0]?.uri.fsPath;
}

/**
 * セッションを開始
 */
async function startSession() {
  if (sessionState?.isLogging) {
    vscode.window.showWarningMessage('CraftLog: セッションは既に開始されています');
    return;
  }

  const workspacePath = getWorkspacePath();
  if (!workspacePath) {
    vscode.window.showErrorMessage('CraftLog: ワークスペースフォルダを開いてください');
    return;
  }

  const config = loadConfig();
  const sessionId = generateSessionId();
  const workspaceId = generateWorkspaceId(workspacePath);
  const logDirectory = getLogDirectory(config, workspacePath);
  const logFilePath = generateLogFilePath(logDirectory, sessionId);

  // セッション状態を初期化
  sessionState = {
    sessionId,
    workspaceId,
    isLogging: true,
    isPaused: false,
    logFilePath,
    startTime: Date.now()
  };

  // ログライターを作成
  logWriter = new LogWriter(logFilePath, config);

  // セッション開始イベントを記録
  const startEvent: SessionStartEvent = {
    ts: Date.now(),
    session_id: sessionId,
    workspace_id: workspaceId,
    event: 'session_start',
    vscode_version: vscode.version,
    ext_version: extensionContext.extension.packageJSON.version
  };
  logWriter.write(startEvent);

  // 各ハンドラを初期化
  editTracker = new EditTracker(config, sessionState, logWriter, workspacePath);
  aiPromptHandler = new AIPromptHandler(config, sessionState, logWriter);
  snapshotHandler = new SnapshotHandler(config, sessionState, logWriter, workspacePath);
  fileWatcher = new FileWatcher(config, sessionState, logWriter, workspacePath);

  // ファイルウォッチャーのキャッシュを初期化
  await fileWatcher.initializeCache();

  // 定期スナップショットを開始
  snapshotHandler.startPeriodicSnapshots();

  // 初回スナップショットを取得
  await snapshotHandler.takeSnapshot();

  extensionContext.subscriptions.push(editTracker, snapshotHandler, fileWatcher);

  updateStatusBar();

  vscode.window.showInformationMessage(
    `CraftLog: セッションを開始しました（${sessionId.substring(0, 16)}...）`
  );
}

/**
 * セッションを停止（完全終了）
 */
async function stopSession() {
  if (!sessionState || (!sessionState.isLogging && !sessionState.isPaused)) {
    // 保存されたセッションがある場合はそれもクリア
    const savedInfo = extensionContext.workspaceState.get<SavedSessionInfo>('craftlog.savedSession');
    if (savedInfo) {
      await extensionContext.workspaceState.update('craftlog.savedSession', undefined);
      vscode.window.showInformationMessage('CraftLog: 保存されたセッションを終了しました');
      updateStatusBar();
      return;
    }
    vscode.window.showWarningMessage('CraftLog: セッションは開始されていません');
    return;
  }

  // セッション終了イベントを記録
  if (logWriter) {
    const endEvent: SessionEndEvent = {
      ts: Date.now(),
      session_id: sessionState.sessionId,
      workspace_id: sessionState.workspaceId,
      event: 'session_end',
      vscode_version: vscode.version
    };
    logWriter.write(endEvent);
    await logWriter.forceFlush();
  }

  // 各ハンドラを破棄
  editTracker?.dispose();
  snapshotHandler?.dispose();
  fileWatcher?.dispose();
  if (logWriter) {
    await logWriter.dispose();
  }

  const logPath = sessionState.logFilePath;
  const sessionId = sessionState.sessionId;

  // 状態をクリア
  sessionState = null;
  logWriter = null;
  editTracker = null;
  aiPromptHandler = null;
  snapshotHandler = null;
  fileWatcher = null;

  // 保存されたセッション情報もクリア
  await extensionContext.workspaceState.update('craftlog.savedSession', undefined);

  updateStatusBar();

  vscode.window.showInformationMessage(
    `CraftLog: セッションを終了しました\nログ: ${logPath}`,
    'ログを開く'
  ).then(selection => {
    if (selection === 'ログを開く') {
      vscode.workspace.openTextDocument(logPath).then(doc => {
        vscode.window.showTextDocument(doc);
      });
    }
  });
}

/**
 * ロギングの切り替え
 */
async function toggleLogging() {
  if (sessionState?.isLogging) {
    await pauseSession();
  } else if (sessionState?.isPaused || extensionContext.workspaceState.get<SavedSessionInfo>('craftlog.savedSession')) {
    await resumeSession();
  } else {
    await startSession();
  }
}

/**
 * AIプロンプトをマーク
 */
async function markAIPrompt() {
  if (!aiPromptHandler) {
    vscode.window.showWarningMessage('CraftLog: セッションを開始してください');
    return;
  }

  await aiPromptHandler.markAIPrompt();

  // スナップショットを取得（重要イベント後）
  if (snapshotHandler) {
    snapshotHandler.invalidateCache();
    await snapshotHandler.takeSnapshot();
  }
}

/**
 * メモを追加
 */
async function addNote() {
  if (!sessionState?.isLogging || !logWriter) {
    vscode.window.showWarningMessage('CraftLog: セッションを開始してください');
    return;
  }

  const note = await vscode.window.showInputBox({
    placeHolder: 'メモを入力してください',
    prompt: '制作過程に関するメモを記録します',
    title: 'CraftLog: Add Note'
  });

  if (note === undefined || note.trim() === '') {
    return;
  }

  const noteEvent: NoteEvent = {
    ts: Date.now(),
    session_id: sessionState.sessionId,
    workspace_id: sessionState.workspaceId,
    event: 'note',
    vscode_version: vscode.version,
    content: note.trim()
  };

  logWriter.write(noteEvent);
  vscode.window.showInformationMessage('CraftLog: メモを記録しました');
}

/**
 * ステータスバーを更新
 */
function updateStatusBar() {
  if (sessionState?.isLogging) {
    const shortId = sessionState.sessionId.substring(0, 12);
    statusBarItem.text = `$(record) CraftLog: ${shortId}`;
    statusBarItem.tooltip = `CraftLog: ログ記録中\nセッション: ${sessionState.sessionId}\nクリックで一時停止`;
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    statusBarItem.command = 'craftlog.pauseSession';
  } else if (sessionState?.isPaused) {
    const shortId = sessionState.sessionId.substring(0, 12);
    statusBarItem.text = `$(debug-pause) CraftLog: ${shortId}`;
    statusBarItem.tooltip = `CraftLog: 一時停止中\nセッション: ${sessionState.sessionId}\nクリックで再開`;
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    statusBarItem.command = 'craftlog.resumeSession';
  } else {
    // 保存されたセッションがあるか確認
    const savedInfo = extensionContext.workspaceState.get<SavedSessionInfo>('craftlog.savedSession');
    if (savedInfo) {
      statusBarItem.text = `$(history) CraftLog: 再開可能`;
      statusBarItem.tooltip = `CraftLog: 一時停止中のセッションがあります\nクリックで再開`;
      statusBarItem.backgroundColor = undefined;
      statusBarItem.command = 'craftlog.resumeSession';
    } else {
      statusBarItem.text = '$(circle-outline) CraftLog: OFF';
      statusBarItem.tooltip = 'CraftLog: ログ記録停止中\nクリックで開始';
      statusBarItem.backgroundColor = undefined;
      statusBarItem.command = 'craftlog.startSession';
    }
  }
}

/**
 * 設定変更ハンドラ
 */
function handleConfigChange(event: vscode.ConfigurationChangeEvent) {
  if (!event.affectsConfiguration('craftlog')) {
    return;
  }

  const config = loadConfig();

  if (aiPromptHandler) {
    aiPromptHandler.updateConfig(config);
  }

  if (snapshotHandler) {
    snapshotHandler.updateConfig(config);
  }

  if (fileWatcher) {
    fileWatcher.updateConfig(config);
  }

  console.log('CraftLog: 設定が更新されました');
}

/**
 * セッションを一時停止
 */
async function pauseSession() {
  if (!sessionState?.isLogging) {
    vscode.window.showWarningMessage('CraftLog: セッションは開始されていません');
    return;
  }

  if (sessionState.isPaused) {
    vscode.window.showWarningMessage('CraftLog: セッションは既に一時停止中です');
    return;
  }

  // 一時停止イベントを記録
  if (logWriter) {
    const pauseEvent: SessionPauseEvent = {
      ts: Date.now(),
      session_id: sessionState.sessionId,
      workspace_id: sessionState.workspaceId,
      event: 'session_pause',
      vscode_version: vscode.version
    };
    logWriter.write(pauseEvent);
    await logWriter.forceFlush();
  }

  // 定期スナップショットを停止
  snapshotHandler?.stopPeriodicSnapshots();

  // セッション情報を永続化
  const savedInfo: SavedSessionInfo = {
    sessionId: sessionState.sessionId,
    workspaceId: sessionState.workspaceId,
    logFilePath: sessionState.logFilePath,
    startTime: sessionState.startTime,
    pausedAt: Date.now()
  };
  await extensionContext.workspaceState.update('craftlog.savedSession', savedInfo);

  // 状態を更新
  sessionState.isLogging = false;
  sessionState.isPaused = true;

  // ハンドラを破棄（再開時に再作成）
  editTracker?.dispose();
  snapshotHandler?.dispose();
  fileWatcher?.dispose();
  if (logWriter) {
    await logWriter.dispose();
  }
  editTracker = null;
  snapshotHandler = null;
  aiPromptHandler = null;
  fileWatcher = null;
  logWriter = null;

  updateStatusBar();

  vscode.window.showInformationMessage(
    `CraftLog: セッションを一時停止しました（${sessionState.sessionId.substring(0, 16)}...）\n後日「Resume Session」で再開できます`
  );
}

/**
 * セッションを再開
 */
async function resumeSession() {
  // 一時停止中のセッションがあるか確認
  const savedInfo = extensionContext.workspaceState.get<SavedSessionInfo>('craftlog.savedSession');

  if (!savedInfo) {
    vscode.window.showWarningMessage('CraftLog: 再開できるセッションがありません');
    return;
  }

  if (sessionState?.isLogging) {
    vscode.window.showWarningMessage('CraftLog: 別のセッションが進行中です。先に停止してください');
    return;
  }

  const workspacePath = getWorkspacePath();
  if (!workspacePath) {
    vscode.window.showErrorMessage('CraftLog: ワークスペースフォルダを開いてください');
    return;
  }

  const config = loadConfig();

  // セッション状態を復元
  sessionState = {
    sessionId: savedInfo.sessionId,
    workspaceId: savedInfo.workspaceId,
    isLogging: true,
    isPaused: false,
    logFilePath: savedInfo.logFilePath,
    startTime: savedInfo.startTime
  };

  // ログライターを作成（既存ファイルに追記）
  logWriter = new LogWriter(savedInfo.logFilePath, config);

  // 再開イベントを記録
  const resumeEvent: SessionResumeEvent = {
    ts: Date.now(),
    session_id: sessionState.sessionId,
    workspace_id: sessionState.workspaceId,
    event: 'session_resume',
    vscode_version: vscode.version,
    ext_version: extensionContext.extension.packageJSON.version
  };
  logWriter.write(resumeEvent);

  // 各ハンドラを再初期化
  editTracker = new EditTracker(config, sessionState, logWriter, workspacePath);
  aiPromptHandler = new AIPromptHandler(config, sessionState, logWriter);
  snapshotHandler = new SnapshotHandler(config, sessionState, logWriter, workspacePath);
  fileWatcher = new FileWatcher(config, sessionState, logWriter, workspacePath);

  // ファイルウォッチャーのキャッシュを初期化
  await fileWatcher.initializeCache();

  // 定期スナップショットを開始
  snapshotHandler.startPeriodicSnapshots();

  // 再開後スナップショットを取得
  await snapshotHandler.takeSnapshot();

  extensionContext.subscriptions.push(editTracker, snapshotHandler, fileWatcher);

  // 保存されたセッション情報をクリア
  await extensionContext.workspaceState.update('craftlog.savedSession', undefined);

  updateStatusBar();

  const pauseDuration = Math.round((Date.now() - savedInfo.pausedAt) / 1000 / 60);
  vscode.window.showInformationMessage(
    `CraftLog: セッションを再開しました（${pauseDuration}分ぶり）`
  );
}

/**
 * 保存されたセッションを確認して復元を提案
 */
async function checkSavedSession() {
  const savedInfo = extensionContext.workspaceState.get<SavedSessionInfo>('craftlog.savedSession');

  if (!savedInfo) {
    return;
  }

  const pausedAt = new Date(savedInfo.pausedAt);
  const pauseDuration = Math.round((Date.now() - savedInfo.pausedAt) / 1000 / 60);

  const selection = await vscode.window.showInformationMessage(
    `CraftLog: 一時停止中のセッションがあります（${pauseDuration}分前に停止）`,
    '再開する',
    '破棄する'
  );

  if (selection === '再開する') {
    await resumeSession();
  } else if (selection === '破棄する') {
    await extensionContext.workspaceState.update('craftlog.savedSession', undefined);
    vscode.window.showInformationMessage('CraftLog: 保存されたセッションを破棄しました');
  }
}
