# CraftLog

A VSCode extension that records the programming process as a unified timeline log.

## Overview

CraftLog captures code edits, AI prompt timings, and workspace state changes during your coding sessions, enabling later visualization and analysis on a timeline.

### What It Records

1. **Code Edit Events** - Document diffs (added/deleted characters and lines)
2. **AI Prompt Events** - When you request AI assistance and (optionally) the prompt content
3. **Snapshots** - Workspace state including total LOC, file count, etc.
4. **File Operations** - File creation and deletion events
5. **Workspace Diffs** - Changes detected from external tools (git checkout, npm install, etc.)
6. **Control Mode Changes** - Transitions between Human and AI editing modes

### What It Does NOT Record

- OS-level keylogging
- Full capture of sensitive inputs like passwords
- Copilot's internal non-public events

## Key Feature: Control Mode (Human/AI Mode)

CraftLog introduces a **Control Mode** system to clearly distinguish between human edits and AI-assisted edits.

### How It Works

- **Human Mode** (default): All edits are recorded as human-originated
- **AI Mode**: All edits are recorded as AI-originated

Every `edit` event includes an `origin_mode` field indicating whether the edit occurred during Human or AI mode.

### Automatic Mode Switching

When you execute `CraftLog: Mark AI Prompt...`, the extension automatically switches to AI Mode. This ensures that subsequent AI-generated edits are correctly attributed.

### Manual Mode Control

| Command | Description |
|---------|-------------|
| `CraftLog: Set Human Mode` | Switch to Human Mode |
| `CraftLog: Set AI Mode` | Switch to AI Mode |
| `CraftLog: Toggle Mode (Human/AI)` | Toggle between modes |

### Visual Indicators

When in **AI Mode**:
- **Status Bar**: Shows `$(hubot) CraftLog: AI` with highlighted background
- **Editor Overlay**: A subtle purple tint is applied to all open editors
- **CodeLens Button**: A "Return to Human Mode" button appears at the top of each file

Click the status bar or the CodeLens button to return to Human Mode.

### Policy Violation Detection

If an AI prompt is executed while in Human Mode, CraftLog will:
1. Log a `policy_violation` event for auditing
2. Show a warning message
3. Automatically switch to AI Mode

## Installation

### Development Mode

```bash
cd logggggggg
npm install
npm run compile
```

Then run "Run Extension" (F5) in VSCode to launch in debug mode.

### Building VSIX Package

To create a distributable `.vsix` file:

1. **Install vsce** (Visual Studio Code Extension Manager):
   ```bash
   npm install -g @vscode/vsce
   ```

2. **Build the extension**:
   ```bash
   npm run compile
   ```

3. **Package into VSIX**:
   ```bash
   vsce package
   ```

   This creates a file like `craftlog-0.1.0.vsix` in the project root.

### Installing VSIX in VSCode

**Method 1: Via Command Palette**
1. Open VSCode
2. Press `Cmd+Shift+P` (macOS) or `Ctrl+Shift+P` (Windows/Linux)
3. Type "Extensions: Install from VSIX..."
4. Select the `.vsix` file

**Method 2: Via Extensions Sidebar**
1. Open Extensions sidebar (`Cmd+Shift+X` / `Ctrl+Shift+X`)
2. Click the `...` menu (top-right of sidebar)
3. Select "Install from VSIX..."
4. Select the `.vsix` file

**Method 3: Via Command Line**
```bash
code --install-extension craftlog-0.1.0.vsix
```

After installation, reload VSCode and CraftLog will be available.

## Usage

### Commands

| Command | Description |
|---------|-------------|
| `CraftLog: Start Session` | Start a logging session |
| `CraftLog: Stop Session` | Stop and finalize the session |
| `CraftLog: Pause Session` | Pause session (can resume later) |
| `CraftLog: Resume Session` | Resume a paused session |
| `CraftLog: Toggle Logging` | Toggle logging ON/OFF |
| `CraftLog: Mark AI Prompt...` | Mark an AI prompt (auto-switches to AI Mode) |
| `CraftLog: Add Note...` | Add a note to the log |
| `CraftLog: Set Human Mode` | Switch to Human Mode |
| `CraftLog: Set AI Mode` | Switch to AI Mode |
| `CraftLog: Toggle Mode (Human/AI)` | Toggle between Human and AI modes |

### Status Bar

**Session Status (right side):**
- `$(record) CraftLog: <session_id>` - Recording (click to pause)
- `$(debug-pause) CraftLog: <session_id>` - Paused (click to resume)
- `$(history) CraftLog: Resumable` - A paused session is available
- `$(circle-outline) CraftLog: OFF` - Not recording (click to start)

**Mode Status (next to session status):**
- `$(person) CraftLog: HUMAN` - Human Mode (click to toggle)
- `$(hubot) CraftLog: AI` - AI Mode (click to toggle)

### Pause and Resume

Sessions can be paused and resumed later while maintaining the same session ID:

- **Pause**: `CraftLog: Pause Session` or click the status bar while recording
- **Resume**: `CraftLog: Resume Session` or click the status bar while paused
- **VSCode Exit**: Active sessions are automatically paused and saved

This allows recording multi-day projects as a single session.

## Configuration

| Setting | Description | Default |
|---------|-------------|---------|
| `craftlog.storePromptText` | Store AI prompt text content | `false` |
| `craftlog.logDirectory` | Log file directory | `.craftlog` in workspace |
| `craftlog.snapshotIntervalMs` | Snapshot interval (ms) | `10000` |
| `craftlog.pasteLikeThreshold` | Paste detection threshold (chars) | `80` |
| `craftlog.excludePatterns` | Glob patterns to exclude | `.env`, `secrets.*`, `*.pem`, etc. |
| `craftlog.targetExtensions` | File extensions for LOC counting | `js`, `ts`, `py`, `cpp`, etc. |
| `craftlog.maxFileSizeMB` | Max log file size (MB) | `50` |

## Log Format

Logs are saved in JSON Lines (.jsonl) format. Each line is one event.

### Event Types

#### edit - Code Edit

```json
{
  "ts": 1739830002201,
  "elapsed_ms": 5000,
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
  },
  "origin_mode": "ai"
}
```

#### ai_prompt - AI Request

```json
{
  "ts": 1739830000123,
  "elapsed_ms": 3000,
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

#### snapshot - Workspace State

```json
{
  "ts": 1739830005000,
  "elapsed_ms": 8000,
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

#### mode_change - Control Mode Change

```json
{
  "ts": 1739830006000,
  "elapsed_ms": 9000,
  "session_id": "S_2026-02-18_001",
  "workspace_id": "W_ab12",
  "event": "mode_change",
  "from": "human",
  "to": "ai",
  "reason": "ai_prompt"
}
```

**reason values:**
- `"manual"` - User manually switched modes via command
- `"ai_prompt"` - Automatically switched when ai_prompt was executed

#### policy_violation - Policy Violation

```json
{
  "ts": 1739830007000,
  "elapsed_ms": 10000,
  "session_id": "S_2026-02-18_001",
  "workspace_id": "W_ab12",
  "event": "policy_violation",
  "kind": "ai_action_in_human_mode",
  "control_mode": "human",
  "detail": "ai_prompt executed while in human mode (mode: agent)"
}
```

#### file_create - File Creation

```json
{
  "ts": 1739830010000,
  "elapsed_ms": 13000,
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

#### file_delete - File Deletion

```json
{
  "ts": 1739830015000,
  "elapsed_ms": 18000,
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

#### workspace_diff - Workspace Diff

Records differences between snapshots. Detects external file additions (git checkout, npm install, etc.).

```json
{
  "ts": 1739830020000,
  "elapsed_ms": 23000,
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

#### Session Events

- `session_start` - Session started
- `session_end` - Session ended
- `session_pause` - Session paused
- `session_resume` - Session resumed
- `note` - User-added note

## Privacy & Safety Design

- **No External Transmission**: No network access is implemented
- **File Paths**: Only workspace-relative paths are recorded (no absolute paths)
- **Prompt Content**: Not stored by default (only length + hash)
- **Exclusion Patterns**: `.env`, `secrets.*`, `*.pem`, etc. are excluded by default

## Technical Notes

### VSCode API Limitations

Some features have limitations due to VSCode API constraints:

- **Copilot Command Suppression**: VSCode does not allow overriding or canceling commands registered by other extensions. Full suppression of Copilot commands in Human Mode is not possible.
- **Paste Command Cancellation**: The built-in `editor.action.clipboardPasteAction` cannot be intercepted or canceled.
- **Editor Overlay**: Full modal overlays are not possible. The AI Mode visual indicator uses decoration API and CodeLens as alternatives.

### Alternative Implementations

- AI prompt execution in Human Mode triggers a `policy_violation` event and warning before auto-switching to AI Mode
- Paste-like edits are detected via `pasteLikeThreshold` and flagged in the `flags.is_paste_like` field

## License

MIT
