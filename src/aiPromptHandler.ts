/**
 * CraftLog AIプロンプトハンドラ
 * ユーザーがAIへの依頼を明示的にマークする機能
 */

import * as vscode from 'vscode';
import { AIPromptEvent, CraftLogConfig, SessionState, PromptInfo } from './types';
import { LogWriter, hashString } from './logWriter';

export type AIMode = 'copilot_chat' | 'agent' | 'copilot_inline' | 'unknown';

export interface AIPromptOptions {
  mode?: AIMode;
  note?: string;
  promptText?: string;
  autoExecute?: boolean;
}

export class AIPromptHandler {
  private config: CraftLogConfig;
  private sessionState: SessionState;
  private logWriter: LogWriter;

  constructor(
    config: CraftLogConfig,
    sessionState: SessionState,
    logWriter: LogWriter
  ) {
    this.config = config;
    this.sessionState = sessionState;
    this.logWriter = logWriter;
  }

  /**
   * AIプロンプトをマーク（コマンドから呼び出し）
   */
  public async markAIPrompt(): Promise<void> {
    if (!this.sessionState.isLogging) {
      vscode.window.showWarningMessage('CraftLog: ログセッションが開始されていません');
      return;
    }

    // モード選択（自動実行オプション付き）
    const modeItems: (vscode.QuickPickItem & { autoExecute?: boolean })[] = [
      { label: '$(comment-discussion) Copilot Chat + 自動実行', description: 'プロンプトをCopilot Chatに送信して実行', autoExecute: true },
      { label: '$(hubot) Agent + 自動実行', description: 'プロンプトをAgentモードで実行', autoExecute: true },
      { label: '$(comment-discussion) Copilot Chat（記録のみ）', description: 'チャットでの対話（ログ記録のみ）' },
      { label: '$(hubot) Copilot Agent（記録のみ）', description: 'エージェントモード（ログ記録のみ）' },
      { label: '$(code) Copilot Inline', description: 'インライン補完' },
      { label: '$(question) Unknown', description: 'その他/不明' }
    ];

    const selectedMode = await vscode.window.showQuickPick(modeItems, {
      placeHolder: 'AIモードを選択してください',
      title: 'CraftLog: Mark AI Prompt'
    });

    if (!selectedMode) {
      return; // キャンセル
    }

    const mode = this.mapModeLabel(selectedMode.label);
    const autoExecute = (selectedMode as { autoExecute?: boolean }).autoExecute === true;

    // プロンプト入力
    const promptText = await vscode.window.showInputBox({
      placeHolder: autoExecute ? 'AIに送信するプロンプトを入力' : 'プロンプト内容（任意。空でもOK）',
      prompt: autoExecute
        ? 'このプロンプトがCopilotに自動送信されます'
        : 'AIへの依頼内容を入力してください（保存しない設定の場合はハッシュ化されます）',
      title: 'CraftLog: プロンプト入力',
      ignoreFocusOut: true
    });

    if (promptText === undefined) {
      return; // キャンセル
    }

    if (autoExecute && promptText.trim() === '') {
      vscode.window.showWarningMessage('CraftLog: 自動実行にはプロンプトの入力が必要です');
      return;
    }

    // メモ入力（自動実行の場合はスキップ可能にする）
    let note = '';
    if (!autoExecute) {
      const noteInput = await vscode.window.showInputBox({
        placeHolder: '例: リファクタリング依頼、バグ修正など',
        prompt: '自己申告メモ（任意）',
        title: 'CraftLog: メモ入力'
      });

      if (noteInput === undefined) {
        return; // キャンセル
      }
      note = noteInput;
    }

    // イベントを記録
    await this.logPrompt({
      mode,
      note,
      promptText,
      autoExecute
    });

    // 自動実行の場合はCopilotにプロンプトを送信
    if (autoExecute && promptText.trim()) {
      await this.sendToCopilot(promptText, mode);
    } else {
      vscode.window.showInformationMessage(`CraftLog: AIプロンプトを記録しました（${mode}）`);
    }
  }

  /**
   * Copilot Chatにプロンプトを送信
   */
  private async sendToCopilot(promptText: string, mode: AIMode): Promise<void> {
    try {
      if (mode === 'agent') {
        // Agentモード: Edit Sessionを開いてからプロンプトを送信
        // まずプロンプトをクリップボードにコピー
        await vscode.env.clipboard.writeText(promptText);

        // workbench.action.chat.openEditSession でAgentモードを開く
        await vscode.commands.executeCommand('workbench.action.chat.openEditSession');

        // 少し待ってからペースト＆送信を試行
        setTimeout(async () => {
          try {
            // Ctrl/Cmd+V でペースト
            await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
            // Enter で送信
            await vscode.commands.executeCommand('workbench.action.chat.submit');
          } catch {
            // ペースト/送信に失敗した場合は何もしない（クリップボードにはコピー済み）
          }
        }, 500);

        vscode.window.showInformationMessage(
          `CraftLog: Agentモードを開きました。プロンプトをクリップボードにコピーしました。ペーストして実行してください。`
        );
      } else {
        // 通常のCopilot Chat
        await vscode.commands.executeCommand('workbench.action.chat.open', {
          query: promptText,
          isPartialQuery: false
        });
        vscode.window.showInformationMessage(`CraftLog: プロンプトをCopilotに送信しました`);
      }
    } catch (error) {
      console.error('CraftLog: Failed to send to Copilot', error);

      // フォールバック: クリップボードにコピー
      await vscode.env.clipboard.writeText(promptText);
      vscode.window.showWarningMessage(
        'CraftLog: Copilotへの直接送信に失敗しました。プロンプトをクリップボードにコピーしました。'
      );
    }
  }

  /**
   * プロンプトイベントをログに記録
   */
  public async logPrompt(options: AIPromptOptions): Promise<void> {
    const { mode = 'unknown', note = '', promptText = '' } = options;

    // プロンプト情報を構築
    const promptInfo: PromptInfo = {
      length: promptText.length,
      hash: promptText ? hashString(promptText) : '',
      stored: this.config.storePromptText && promptText.length > 0
    };

    // 本文保存が有効な場合
    if (promptInfo.stored) {
      promptInfo.text = promptText;
    }

    // イベントを構築
    const event: AIPromptEvent = {
      ts: Date.now(),
      session_id: this.sessionState.sessionId,
      workspace_id: this.sessionState.workspaceId,
      event: 'ai_prompt',
      vscode_version: vscode.version,
      prompt: promptInfo,
      mode,
      note
    };

    this.logWriter.write(event);
  }

  /**
   * モードラベルをAIModeに変換
   */
  private mapModeLabel(label: string): AIMode {
    if (label.includes('Copilot Chat') || label.includes('Chat')) {
      return 'copilot_chat';
    }
    if (label.includes('Agent')) {
      return 'agent';
    }
    if (label.includes('Inline')) {
      return 'copilot_inline';
    }
    return 'unknown';
  }

  /**
   * 設定を更新
   */
  public updateConfig(config: CraftLogConfig): void {
    this.config = config;
  }
}
