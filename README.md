# CraftLog

プログラマーの制作過程を同一時間軸のログとして記録するVSCode拡張機能です。

## 概要

CraftLogは、コーディング作業中の編集差分、AIへの依頼タイミング、ワークスペースの状態変化を記録し、後から時間軸上に可視化できるようにするためのツールです。

### 記録対象

1. **コード編集イベント** - ドキュメントの差分（追加/削除された文字数・行数）
2. **AIプロンプト送信イベント** - AIへの依頼タイミングと内容（オプション）
3. **スナップショット** - ワークスペースの総LOC、ファイル数などの状態

### 記録しないもの

- OSレベルのキーログ
- パスワード等センシティブな入力の全キャプチャ
- Copilot内部の非公開イベント

## インストール

```bash
cd logggggggg
npm install
npm run compile
```

その後、VSCodeで「Run Extension」(F5)でデバッグ実行できます。

## 使い方

### コマンド

| コマンド | 説明 |
|----------|------|
| `CraftLog: Start Session` | ログセッションを開始 |
| `CraftLog: Stop Session` | ログセッションを完全終了 |
| `CraftLog: Pause Session` | ログセッションを一時停止（後日再開可能） |
| `CraftLog: Resume Session` | 一時停止したセッションを再開 |
| `CraftLog: Toggle Logging` | ログ記録のON/OFF切り替え |
| `CraftLog: Mark AI Prompt...` | AIへの依頼をマーク |
| `CraftLog: Add Note...` | メモを追加 |

### ステータスバー

- `$(record) CraftLog: セッションID` - ログ記録中（クリックで一時停止）
- `$(debug-pause) CraftLog: セッションID` - 一時停止中（クリックで再開）
- `$(history) CraftLog: 再開可能` - 再開可能なセッションあり
- `$(circle-outline) CraftLog: OFF` - ログ停止中（クリックで開始）

### 一時停止と再開

セッションを一時停止すると、同じセッションIDを維持したまま後日再開できます。

- **一時停止**: `CraftLog: Pause Session` または記録中にステータスバーをクリック
- **再開**: `CraftLog: Resume Session` または一時停止中にステータスバーをクリック
- **VSCode終了時**: セッションが進行中の場合、自動的に一時停止として保存されます

これにより、複数日にまたがる制作過程を1つのセッションとして記録できます。

## 設定

| 設定 | 説明 | デフォルト |
|------|------|-----------|
| `craftlog.storePromptText` | AIプロンプトの本文を保存するか | `false` |
| `craftlog.logDirectory` | ログ保存先ディレクトリ | ワークスペース内 `.craftlog` |
| `craftlog.snapshotIntervalMs` | スナップショット間隔（ミリ秒） | `10000` |
| `craftlog.pasteLikeThreshold` | paste判定の閾値（文字数） | `80` |
| `craftlog.excludePatterns` | 除外するglobパターン | `.env`, `secrets.*`, `*.pem` 等 |
| `craftlog.targetExtensions` | LOC計測対象の拡張子 | `js`, `ts`, `py`, `cpp` 等 |
| `craftlog.maxFileSizeMB` | ログファイルの最大サイズ（MB） | `50` |

## ログ形式

JSON Lines（.jsonl）形式で保存されます。1行=1イベント。

### イベント種別

#### edit - コード編集

```json
{
  "ts": 1739830002201,
  "session_id": "S_2026-02-18_001",
  "workspace_id": "W_ab12",
  "event": "edit",
  "file": {
    "path": "src/render.ts",
    "lang": "typescript",
    "scheme": "file"
  },
  "delta": {
    "added_chars": 1460,
    "deleted_chars": 12,
    "added_lines": 48,
    "deleted_lines": 0
  },
  "flags": {
    "is_paste_like": true,
    "is_undo_like": false,
    "is_redo_like": false
  }
}
```

#### ai_prompt - AIへの依頼

```json
{
  "ts": 1739830000123,
  "session_id": "S_2026-02-18_001",
  "workspace_id": "W_ab12",
  "event": "ai_prompt",
  "prompt": {
    "length": 182,
    "hash": "e3b0c442...",
    "stored": false
  },
  "mode": "agent",
  "note": "refactor pipeline"
}
```

#### snapshot - ワークスペース状態

```json
{
  "ts": 1739830005000,
  "session_id": "S_2026-02-18_001",
  "workspace_id": "W_ab12",
  "event": "snapshot",
  "workspace": {
    "files_count": 38,
    "total_loc": 6210,
    "total_bytes": 180233
  },
  "git": {
    "is_repo": true,
    "head": "abc12345"
  }
}
```

#### file_create - ファイル作成

```json
{
  "ts": 1739830010000,
  "session_id": "S_2026-02-18_001",
  "workspace_id": "W_ab12",
  "event": "file_create",
  "file": {
    "path": "src/newFile.ts",
    "lang": "typescript",
    "scheme": "file"
  },
  "stats": {
    "loc": 25,
    "bytes": 512
  }
}
```

#### file_delete - ファイル削除

```json
{
  "ts": 1739830015000,
  "session_id": "S_2026-02-18_001",
  "workspace_id": "W_ab12",
  "event": "file_delete",
  "file": {
    "path": "src/oldFile.ts",
    "lang": "typescript",
    "scheme": "file"
  },
  "stats": {
    "loc": 100,
    "bytes": 2048
  }
}
```

#### workspace_diff - ワークスペース差分

snapshot毎に前回との差分を記録。外部からのファイル追加（git checkout、npm installなど）を検知できます。

```json
{
  "ts": 1739830020000,
  "session_id": "S_2026-02-18_001",
  "workspace_id": "W_ab12",
  "event": "workspace_diff",
  "added_files": 5,
  "removed_files": 1,
  "added_loc": 350,
  "removed_loc": 50,
  "added_bytes": 8192,
  "removed_bytes": 1024,
  "added_paths": ["src/new1.ts", "src/new2.ts", "..."],
  "removed_paths": ["src/deleted.ts"]
}
```

## プライバシー・安全設計

- **外部送信なし**: ネットワークアクセスを実装していません
- **ファイルパス**: workspace相対パスのみ記録（絶対パスは記録しない）
- **プロンプト本文**: デフォルトでは保存しない（length+hashのみ）
- **除外パターン**: `.env`, `secrets.*`, `*.pem` 等はデフォルトで除外

## ライセンス

MIT
