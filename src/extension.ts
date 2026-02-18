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
  SavedSessionInfo,
  ControlMode,
  ModeChangeReason,
  ModeChangeEvent,
  PolicyViolationEvent
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
let modeStatusBarItem: vscode.StatusBarItem;  // モード表示用ステータスバー

// グローバル状態
let sessionState: SessionState | null = null;
let logWriter: LogWriter | null = null;
let editTracker: EditTracker | null = null;
let aiPromptHandler: AIPromptHandler | null = null;
let snapshotHandler: SnapshotHandler | null = null;
let fileWatcher: FileWatcher | null = null;

// Copilotコマンド抑制用のdisposables
let copilotSuppressionDisposables: vscode.Disposable[] = [];

// AIモード表示用のエディタデコレーション
let aiModeDecorationType: vscode.TextEditorDecorationType | null = null;
let codeLensProvider: AIModeCodeLensProvider | null = null;
let codeLensDisposable: vscode.Disposable | null = null;

/**
 * AIモード時にエディタ上部に「Humanモードに戻る」ボタンを表示するCodeLensプロバイダー
 */
class AIModeCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

  public refresh(): void {
    this._onDidChangeCodeLenses.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] | null {
    // セッションがアクティブでAIモードの場合のみ表示
    if (!sessionState?.isLogging || sessionState.controlMode !== 'ai') {
      return null;
    }

    // ファイルスキーマがfileの場合のみ
    if (document.uri.scheme !== 'file') {
      return null;
    }

    // ファイルの先頭（0行目）にCodeLensを配置
    const range = new vscode.Range(0, 0, 0, 0);

    const returnToHumanLens = new vscode.CodeLens(range, {
      title: '$(person) Humanモードに戻る',
      command: 'craftlog.setHumanMode',
      tooltip: 'CraftLog: Humanモードに切り替えます'
    });

    const aiModeIndicator = new vscode.CodeLens(range, {
      title: '🤖 AI MODE - AIによる編集を記録中',
      command: '',
      tooltip: 'CraftLog: 現在AIモードです。すべての編集がAI編集として記録されます。'
    });

    return [aiModeIndicator, returnToHumanLens];
  }
}

/**
 * セッション開始からの経過時間（一時停止中の時間は除外）を計算
 */
export function calculateElapsedMs(): number {
  if (!sessionState) {
    return 0;
  }
  const now = Date.now();
  let elapsed = now - sessionState.startTime - sessionState.totalPausedMs;

  // 現在一時停止中の場合、その分も差し引く
  if (sessionState.lastPauseTime !== null) {
    elapsed -= (now - sessionState.lastPauseTime);
  }

  return Math.max(0, elapsed);
}

/**
 * 現在のcontrol_modeを取得
 */
export function getControlMode(): ControlMode {
  return sessionState?.controlMode ?? 'human';
}

/**
 * control_modeを変更し、mode_changeイベントを記録
 * @param newMode 新しいモード
 * @param reason 変更理由 ('manual' または 'ai_prompt')
 */
export function setControlMode(newMode: ControlMode, reason: ModeChangeReason): void {
  if (!sessionState || !logWriter) {
    return;
  }

  const currentMode = sessionState.controlMode;

  // 同じモードの場合は何もしない
  if (currentMode === newMode) {
    return;
  }

  // mode_changeイベントを記録
  const modeChangeEvent: ModeChangeEvent = {
    ts: Date.now(),
    elapsed_ms: calculateElapsedMs(),
    session_id: sessionState.sessionId,
    workspace_id: sessionState.workspaceId,
    event: 'mode_change',
    vscode_version: vscode.version,
    from: currentMode,
    to: newMode,
    reason
  };
  logWriter.write(modeChangeEvent);

  // 状態を更新
  sessionState.controlMode = newMode;

  // ステータスバーを更新
  updateModeStatusBar();

  // AIモード視覚表示を更新
  refreshAIModeVisuals();

  console.log(`CraftLog: Mode changed from ${currentMode} to ${newMode} (reason: ${reason})`);
}

/**
 * policy_violationイベントを記録
 */
export function logPolicyViolation(kind: string, detail: string): void {
  if (!sessionState || !logWriter) {
    return;
  }

  const violationEvent: PolicyViolationEvent = {
    ts: Date.now(),
    elapsed_ms: calculateElapsedMs(),
    session_id: sessionState.sessionId,
    workspace_id: sessionState.workspaceId,
    event: 'policy_violation',
    vscode_version: vscode.version,
    kind,
    control_mode: sessionState.controlMode,
    detail
  };
  logWriter.write(violationEvent);
}

/**
 * AIモード視覚表示の初期化
 * - エディタ背景のティント（薄い色）
 * - CodeLensによる「Humanモードに戻る」ボタン
 */
function initializeAIModeVisuals(context: vscode.ExtensionContext): void {
  // AIモード時のエディタ背景デコレーションを作成
  // 薄い青紫色のティントでAIモードを視覚的に示す
  aiModeDecorationType = vscode.window.createTextEditorDecorationType({
    // エディタ全体の背景色は直接設定できないため、
    // 行ごとのデコレーションで疑似的に実現
    isWholeLine: true,
    backgroundColor: 'rgba(255, 255, 74, 0.29)', // 薄い紫（BlueViolet）
    overviewRulerColor: 'rgba(138, 43, 226, 0.6)',
    overviewRulerLane: vscode.OverviewRulerLane.Full,
    // 上部にボーダーを追加（最初の行のみ後で適用）
  });
  context.subscriptions.push(aiModeDecorationType);

  // CodeLensプロバイダーを登録
  codeLensProvider = new AIModeCodeLensProvider();
  codeLensDisposable = vscode.languages.registerCodeLensProvider(
    { scheme: 'file' },  // fileスキーマのドキュメントすべてに適用
    codeLensProvider
  );
  context.subscriptions.push(codeLensDisposable);

  // エディタ変更時にデコレーションを更新
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(updateAIModeOverlay),
    vscode.window.onDidChangeVisibleTextEditors(updateAllAIModeOverlays)
  );
}

/**
 * すべての可視エディタのAIモードオーバーレイを更新
 */
function updateAllAIModeOverlays(): void {
  for (const editor of vscode.window.visibleTextEditors) {
    updateAIModeOverlayForEditor(editor);
  }
}

/**
 * アクティブエディタのAIモードオーバーレイを更新
 */
function updateAIModeOverlay(): void {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    updateAIModeOverlayForEditor(editor);
  }
}

/**
 * 指定したエディタのAIモードオーバーレイを更新
 */
function updateAIModeOverlayForEditor(editor: vscode.TextEditor): void {
  if (!aiModeDecorationType) {
    return;
  }

  // セッションがアクティブでAIモードの場合のみデコレーションを適用
  if (sessionState?.isLogging && sessionState.controlMode === 'ai') {
    // fileスキーマのみ対象
    if (editor.document.uri.scheme === 'file') {
      // ドキュメント全体にデコレーションを適用
      const fullRange = new vscode.Range(
        0, 0,
        editor.document.lineCount - 1,
        editor.document.lineAt(editor.document.lineCount - 1).text.length
      );
      editor.setDecorations(aiModeDecorationType, [fullRange]);
      return;
    }
  }

  // AIモードでない場合はデコレーションをクリア
  editor.setDecorations(aiModeDecorationType, []);
}

/**
 * AIモード視覚表示を更新（モード切替時に呼び出し）
 */
function refreshAIModeVisuals(): void {
  // CodeLensを更新
  if (codeLensProvider) {
    codeLensProvider.refresh();
  }

  // すべてのエディタのデコレーションを更新
  updateAllAIModeOverlays();
}

/**
 * 拡張機能のアクティベーション
 */
export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;

  // ステータスバーアイテムを作成（セッション状態用）
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = 'craftlog.toggleLogging';
  context.subscriptions.push(statusBarItem);
  updateStatusBar();
  statusBarItem.show();

  // モード表示用ステータスバーアイテムを作成
  modeStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    99  // statusBarItemの左側に表示
  );
  modeStatusBarItem.command = 'craftlog.toggleMode';
  context.subscriptions.push(modeStatusBarItem);
  updateModeStatusBar();

  // コマンドを登録
  context.subscriptions.push(
    vscode.commands.registerCommand('craftlog.startSession', startSession),
    vscode.commands.registerCommand('craftlog.stopSession', stopSession),
    vscode.commands.registerCommand('craftlog.toggleLogging', toggleLogging),
    vscode.commands.registerCommand('craftlog.markAIPrompt', markAIPrompt),
    vscode.commands.registerCommand('craftlog.addNote', addNote),
    vscode.commands.registerCommand('craftlog.pauseSession', pauseSession),
    vscode.commands.registerCommand('craftlog.resumeSession', resumeSession),
    // モード切替コマンド
    vscode.commands.registerCommand('craftlog.setHumanMode', setHumanMode),
    vscode.commands.registerCommand('craftlog.setAIMode', setAIMode),
    vscode.commands.registerCommand('craftlog.toggleMode', toggleMode)
  );

  // 設定変更の監視
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(handleConfigChange)
  );

  // AIモード視覚表示の初期化
  initializeAIModeVisuals(context);

  // Copilot抑制の設定（可能な範囲で）
  setupCopilotSuppression(context);

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
    startTime: Date.now(),
    totalPausedMs: 0,
    lastPauseTime: null,
    controlMode: 'human'  // 初期値は必ず 'human'
  };

  // ログライターを作成
  logWriter = new LogWriter(logFilePath, config);

  // セッション開始イベントを記録
  const startEvent: SessionStartEvent = {
    ts: Date.now(),
    elapsed_ms: 0,
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
  updateModeStatusBar();
  refreshAIModeVisuals();

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
      elapsed_ms: calculateElapsedMs(),
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
  updateModeStatusBar();
  refreshAIModeVisuals();

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
    elapsed_ms: calculateElapsedMs(),
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
 * モードステータスバーを更新
 */
function updateModeStatusBar() {
  if (!sessionState?.isLogging) {
    modeStatusBarItem.hide();
    return;
  }

  const mode = sessionState.controlMode;
  if (mode === 'human') {
    modeStatusBarItem.text = '$(person) CraftLog: HUMAN';
    modeStatusBarItem.tooltip = 'CraftLog: Humanモード（クリックでAIモードに切替）\n\n人間による編集をログに記録中';
    modeStatusBarItem.backgroundColor = undefined;
  } else {
    modeStatusBarItem.text = '$(hubot) CraftLog: AI';
    modeStatusBarItem.tooltip = 'CraftLog: AIモード（クリックでHumanモードに切替）\n\nAIによる編集をログに記録中';
    modeStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
  }
  modeStatusBarItem.show();
}

/**
 * Humanモードに切り替え
 */
function setHumanMode() {
  if (!sessionState?.isLogging) {
    vscode.window.showWarningMessage('CraftLog: セッションを開始してください');
    return;
  }

  if (sessionState.controlMode === 'human') {
    vscode.window.showInformationMessage('CraftLog: 既にHumanモードです');
    return;
  }

  setControlMode('human', 'manual');
  vscode.window.showInformationMessage('CraftLog: Humanモードに切り替えました');
}

/**
 * AIモードに切り替え
 */
function setAIMode() {
  if (!sessionState?.isLogging) {
    vscode.window.showWarningMessage('CraftLog: セッションを開始してください');
    return;
  }

  if (sessionState.controlMode === 'ai') {
    vscode.window.showInformationMessage('CraftLog: 既にAIモードです');
    return;
  }

  setControlMode('ai', 'manual');
  vscode.window.showInformationMessage('CraftLog: AIモードに切り替えました');
}

/**
 * モードをトグル
 */
function toggleMode() {
  if (!sessionState?.isLogging) {
    vscode.window.showWarningMessage('CraftLog: セッションを開始してください');
    return;
  }

  const newMode: ControlMode = sessionState.controlMode === 'human' ? 'ai' : 'human';
  setControlMode(newMode, 'manual');
  vscode.window.showInformationMessage(`CraftLog: ${newMode === 'human' ? 'Human' : 'AI'}モードに切り替えました`);
}

/**
 * Copilot関連コマンドの抑制設定（可能な範囲で実装）
 *
 * VSCode API制約について:
 * - VSCodeでは他の拡張機能が登録したコマンドを直接上書きまたはキャンセルすることはできない
 * - vscode.commands.registerCommand()は同じコマンドIDで再登録するとエラーになる
 * - そのため、Copilotコマンドの完全な抑止は技術的に不可能
 *
 * 実装可能な代替策:
 * 1. ai_prompt検知時にHumanモードなら警告＆policy_violationを記録（AIPromptHandlerで実装）
 * 2. ペースト監視（onDidChangeTextDocumentでpaste-likeを検知して警告）
 *
 * 以下はCopilot関連コマンドを監視・警告する試みだが、
 * VSCode APIの制約により完全な抑止は不可能
 */
function setupCopilotSuppression(context: vscode.ExtensionContext) {
  // Copilotの利用を監視するためのアプローチ:
  // 実際にはコマンドの実行前にフックする公式APIがないため、
  // 以下の方法で可能な範囲の検知を行う:
  //
  // 1. AIPromptHandlerでai_prompt実行時にHumanモードチェック（実装済み）
  // 2. paste-like編集の検知はEditTrackerで行われる
  //
  // 注意: 以下のCopilotコマンドは存在するが、上書きできない
  // - github.copilot.chat.open
  // - github.copilot.openPanel
  // - workbench.action.chat.open
  // - workbench.panel.chat.view.copilot.focus
  //
  // エディタ内pasteコマンドについて:
  // - 'editor.action.clipboardPasteAction' は組み込みコマンド
  // - 上書きまたはキャンセルするAPIは存在しない
  // - 代わりに、EditTrackerでpaste-likeを検知してログに記録

  console.log('CraftLog: Copilot suppression initialized (limited by VSCode API constraints)');
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
  const pauseTime = Date.now();
  if (logWriter) {
    const pauseEvent: SessionPauseEvent = {
      ts: pauseTime,
      elapsed_ms: calculateElapsedMs(),
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

  // 一時停止時刻を記録
  sessionState.lastPauseTime = pauseTime;

  // セッション情報を永続化
  const savedInfo: SavedSessionInfo = {
    sessionId: sessionState.sessionId,
    workspaceId: sessionState.workspaceId,
    logFilePath: sessionState.logFilePath,
    startTime: sessionState.startTime,
    pausedAt: pauseTime,
    totalPausedMs: sessionState.totalPausedMs,
    controlMode: sessionState.controlMode  // 一時停止時のモードを保存
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
  updateModeStatusBar();
  refreshAIModeVisuals();

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

  // 一時停止中の時間を計算して累積
  const resumeTime = Date.now();
  const pausedDuration = resumeTime - savedInfo.pausedAt;
  const totalPausedMs = (savedInfo.totalPausedMs || 0) + pausedDuration;

  // セッション状態を復元
  sessionState = {
    sessionId: savedInfo.sessionId,
    workspaceId: savedInfo.workspaceId,
    isLogging: true,
    isPaused: false,
    logFilePath: savedInfo.logFilePath,
    startTime: savedInfo.startTime,
    totalPausedMs: totalPausedMs,
    lastPauseTime: null,
    controlMode: savedInfo.controlMode ?? 'human'  // 保存されたモードを復元（デフォルトはhuman）
  };

  // ログライターを作成（既存ファイルに追記）
  logWriter = new LogWriter(savedInfo.logFilePath, config);

  // 再開イベントを記録
  const resumeEvent: SessionResumeEvent = {
    ts: resumeTime,
    elapsed_ms: calculateElapsedMs(),
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
  updateModeStatusBar();
  refreshAIModeVisuals();

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
