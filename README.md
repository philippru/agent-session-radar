# Session Radar

A VS Code extension that shows all your AI coding agent sessions at a glance: what is running right now,
what is waiting for you, and what is done or has been sitting around for days. Across all projects,
in every VS Code window.

Supported: **Claude Code** (VS Code extension, terminal, desktop app).
Prepared: **Codex CLI** (provider skeleton), more agents via the provider interface.

```
SESSION RADAR                         ✓✓  ⏷  ⟳
├─ 🟢 Running                                    1
│   ✦ Login form with validation   my-app · ⎇ main · just now
├─ 🟡 Waiting for me                             2
│   ✦ Refactor API client   🔐 Needs approval · my-app · ⎇ dev · 2 min ago
│   ✦ Release notes         ✉️ Unread · docs · 1 h ago
├─ ⚪ Idle / done                                3
└─ 💤 Stale                                     47
```

## Contents

- [Features](#features)
- [Installation (.vsix)](#installation-vsix)
- [Setting up hooks (recommended)](#setting-up-hooks-recommended)
- [Usage](#usage)
- [How the status is determined](#how-the-status-is-determined)
- [Settings](#settings)
- [Privacy and security](#privacy-and-security)
- [Known limitations](#known-limitations)
- [Development](#development)
- [Adding a new provider](#adding-a-new-provider)

## Features

- **Tree view in the Activity Bar**, grouped by status: 🟢 Running · 🟡 Waiting for me · ⚪ Idle/done (< 24 h) · 💤 Stale (> 24 h)
- Per session: title (your local label > `/rename` name > AI title > first message), project, Git branch,
  "last active X ago", agent icon. The tooltip shows all details, including the status source and PID.
- **Badge** on the Activity Bar with the number of sessions waiting for you.
- **Click** focuses or resumes the session (details under [Usage](#usage)).
- **Context menu:** rename locally, mark as read, archive, show transcript read-only,
  reveal in file explorer, copy session ID.
- **Filters:** current workspace only / all projects; show/hide archived sessions.
- Live updates via FileSystemWatcher (debounced), no continuous polling of file contents.

## Installation (.vsix)

Requirements: VS Code ≥ 1.140, Node.js ≥ 20 (for the hooks and for building).

```powershell
git clone <repository-url>
cd session-radar
npm install
npm run package:vsix                                 # creates session-radar.vsix
code --install-extension .\session-radar.vsix
```

Alternatively in VS Code: Extensions view → `…` → **Install from VSIX…** → pick `session-radar.vsix`.
The radar icon then shows up in the Activity Bar of every window.

- **Update:** bump the version in `package.json`, run `npm run package:vsix`, install again, reload the window.
- **Uninstall:** first run `…` → **Remove Claude Code Hooks…** in Session Radar (if installed),
  then uninstall the extension in VS Code. Optionally delete `~/.session-radar`.

## Setting up hooks (recommended)

Without hooks, Session Radar reads Claude Code's process registry and the transcripts. That is enough for
"running / done / unread". **Open permission prompts**, however, are only detected with hooks.

In the Session Radar view: `…` → **Install Claude Code Hooks…**

1. A diff shows the planned change to `~/.claude/settings.json`.
2. After you confirm, Session Radar creates a backup in `~/.session-radar/backups/`.
3. It then adds hooks for `SessionStart`, `UserPromptSubmit`, `Notification`, `Stop` and `SessionEnd`.
   **Existing hooks are left untouched.**
4. The hook script (`~/.session-radar/hooks/session-radar-hook.js`, plain Node.js) writes one small status file
   per session to `~/.session-radar/status/claude-code/`. It prints nothing, always exits with code 0
   and stores **no** prompt or response content.

The hooks take effect for newly started or resumed sessions. Removing them works the same way via
**Remove Claude Code Hooks…**: diff, backup, and only Session Radar's own entries are deleted.
Without hooks, the view is titled "Sessions (no hooks)".

## Usage

**Clicking a session** marks it as read and then:

| Session | Action |
|---|---|
| VS Code session from the current workspace | opens it via the official deep link `vscode://anthropic.claude-code/open?session=<id>`; an already open tab is focused |
| VS Code session from another project | choice: open/focus the project window, or resume here in a terminal |
| running terminal session in the integrated terminal | focuses that terminal |
| ended session | `claude --resume <id>` in a new terminal in the project folder |

If a session is still live (e.g. in another window) and you choose "Resume in Terminal",
Session Radar asks first: two processes on the same session can mess up its history.

**Title bar:** ✓✓ mark all as read · filter workspace/all · ⟳ refresh ·
`…` show/hide archived, install/remove hooks.

**Labels and archive** are local. They change nothing in Claude Code and are stored in `~/.session-radar/annotations.json`.

## How the status is determined

Three sources, each reports a phase with a timestamp. **The newest report wins; on a tie the order is
hooks > process registry > transcript.**

| Source | What it provides |
|---|---|
| **Hooks** (`~/.session-radar/status/…`) | running / waiting for approval or input / turn finished / session ended |
| **Process registry** (`~/.claude/sessions/<pid>.json`) | is the process alive? `busy` / `idle` |
| **Transcript** (`~/.claude/projects/…/<id>.jsonl`) | title, project, branch, last activity, whether the last turn has finished |

| Group | Meaning |
|---|---|
| 🟢 **Running** | the agent is working right now |
| 🟡 **Waiting for me** | 🔐 needs approval · ❓ needs input (hooks only) · ✉️ unread: response finished, not clicked in the radar since |
| ⚪ **Idle / done** | seen or ended, last activity < 24 h |
| 💤 **Stale** | > 24 h without activity |

On first start, all responses finished up to that point count as read. "Unread" can be turned off in the
settings.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `sessionRadar.claudeDir` | empty | Claude config folder; empty = `$CLAUDE_CONFIG_DIR` or `~/.claude` |
| `sessionRadar.maxAgeDays` | 30 | older transcripts are ignored |
| `sessionRadar.staleAfterHours` | 24 | when a session counts as "stale" |
| `sessionRadar.runningTimeoutMinutes` | 30 | "running" without new activity counts as stuck after this |
| `sessionRadar.unreadAsWaiting` | true | count finished, unseen responses as "waiting for me" |

The environment variable `SESSION_RADAR_HOME` relocates `~/.session-radar` (e.g. for tests).

## Privacy and security

- **Strictly local:** no network access, no telemetry.
- **Transcripts are only read**, and only the beginning and end of each file. The transcript view is
  a read-only virtual document that cannot be saved.
- The `.key` files in `~/.claude/sessions/` (tokens) are never read.
- The status layer `~/.session-radar/` contains no prompt or response text, only states, timestamps,
  paths and IDs.
- Changes to `~/.claude/settings.json` only happen on request, with a diff, confirmation and backup.
  If the file was changed while the dialog was open, nothing is written.
- Session IDs are validated before they are passed to a terminal command.

## Known limitations

- **The transcript format and the process registry are not officially documented.** According to the Claude Code
  docs, they can change with any release. The parser is tolerant (unknown entries are ignored). If something is
  missing after a Claude Code update, first extend the unit tests with new anonymized fixtures. Only the hook
  route is documented and therefore stable.
- There is no hook event for an answered permission prompt. "Waiting" ends as soon as the transcript
  moves on.
- Interrupting with Esc does not fire a `Stop` hook. The process registry or the timeout catches that.
- External terminal windows (outside VS Code) cannot be focused.
- If a PID is reused by another process after a crash, a session can briefly appear alive by mistake.

## Development

```powershell
npm install
npm run test:unit        # fast unit tests (Mocha, no VS Code), fixtures under test/fixtures
npm test                 # integration test in a VS Code test instance (against fixtures, not real data)
npm run compile          # type check + lint + build
npm run package:vsix     # build the .vsix
```

**Debugging:** open the project in VS Code, press F5. The first launch configuration opens this repository in the
Extension Development Host; "Run Extension (choose folder)" asks for another folder. Session Radar reads from
`~/.claude` either way; the folder only matters for the "current workspace only" filter. After code changes,
press `Ctrl+R` in the Development Host.

**Fixtures:** only anonymized, hand-written sample data. `.gitignore` blocks all other `*.jsonl` files.

### Structure

```
src/
├── extension.ts                    entry point: wires up providers, store, tree, watchers, commands
├── core/                           no VS Code dependency, fully unit-tested
│   ├── model.ts                    AgentSession, StatusSignals, …
│   ├── provider.ts                 SessionProvider interface, ResumeHost, WatchHost
│   ├── status.ts                   deriveStatus(): signals → status
│   ├── SessionStore.ts             combines providers + annotations
│   ├── statusLayer.ts              reads ~/.session-radar/status (format: docs/status-format.md)
│   └── annotations.ts …            labels/archive/read state, atomic writes, helpers
├── providers/
│   ├── claude/                     ClaudeCodeProvider, transcript parser, process registry, hook configuration
│   └── codex/                      CodexProvider (skeleton)
└── ui/                             tree view, commands, hook installer, VS Code hosts
resources/hooks/session-radar-hook.js   hook script (copied to ~/.session-radar/hooks)
docs/status-format.md                   status layer format for other front-ends
```

## Adding a new provider

Example: a provider for an agent called "Foo".

**1. Register the agent type** in `src/core/model.ts`:

```ts
export type AgentKind = 'claude-code' | 'codex' | 'foo';
```

**2. Write the provider** in `src/providers/foo/FooProvider.ts`. The easiest way is to extend `BaseSessionProvider`,
which already includes the default status logic:

```ts
import { promises as fs } from 'fs';
import * as path from 'path';
import { AgentSession, baseName } from '../../core/model';
import { BaseSessionProvider, Disposable, ResumeHost, WatchHost } from '../../core/provider';
import { readStatusDir } from '../../core/statusLayer';

export class FooProvider extends BaseSessionProvider {
	readonly agent = 'foo' as const;
	readonly displayName = 'Foo Agent';
	readonly iconId = 'robot';                          // Codicon name

	constructor(private readonly dataDir: string, private readonly statusDir: string) { super(); }

	async isAvailable() {
		return fs.stat(this.dataDir).then(s => s.isDirectory(), () => false);
	}

	async discover(): Promise<AgentSession[]> {
		const hooks = await readStatusDir(this.statusDir);  // optional: own hooks → status layer
		const sessions: AgentSession[] = [];
		// … find the agent's sessions. Read large files only partially
		//   (core/fileChunks.ts) and cache by size/mtime.
		// Fill in the raw signals per session; the store computes the status:
		// sessions.push({ id, agent: this.agent, title, project, projectName: baseName(project),
		//   branch, surface: 'cli', transcriptPath, status: 'idle', statusSource: 'transcript',
		//   signals: { lastActivity, turnEndedAt, turnInProgress, process: {...}, hook: {...} } });
		return sessions;
	}

	watch(host: WatchHost, onChange: () => void): Disposable {
		return host.watch(this.dataDir, '**/*.jsonl', () => onChange());
	}

	async resume(session: AgentSession, host: ResumeHost) {
		host.runInTerminal({ name: `Foo: ${session.title}`, cwd: session.project, command: `foo resume ${session.id}` });
	}
}
```

**What a provider must implement:**

| Method | Purpose |
|---|---|
| `isAvailable()` | is the agent installed on this machine, or does it have data? |
| `discover()` | all sessions with raw signals; must be cheap to call repeatedly (cache) |
| `watch()` | register file watchers; call `onChange()` on changes (the store debounces) |
| `getStatus()` | inherited (`deriveStatus`); only override if the agent has its own states |
| `resume()` | resume or focus a session, exclusively via `ResumeHost` (no direct VS Code API) |
| `resumeInTerminal()` | optional; explicit "Resume in Terminal" |

**3. Register it** in `src/extension.ts`:

```ts
const providers = [
	new ClaudeCodeProvider({ … }),
	new CodexProvider({ … }),
	new FooProvider(path.join(os.homedir(), '.foo'), path.join(home, 'status', 'foo')),
];
```

**4. Live status (optional, recommended):** if the agent has hooks or notify callbacks, have them write status
files in the documented format to `~/.session-radar/status/foo/<sessionId>.json`
([docs/status-format.md](docs/status-format.md)). `resources/hooks/session-radar-hook.js` serves as a template.
Without hooks: process liveness via `signals.process` and activity via `signals.lastActivity`.

**5. Tests:** add anonymized fixtures under `test/fixtures/foo/` and write parser/discovery tests under
`src/test/unit/` (see `transcript.test.ts`, `provider.test.ts`). Status logic and providers run
without VS Code and can therefore be tested with Mocha.

**Checklist:** strictly local (no network) · only read agent data · no content in the status layer ·
validate IDs before they go into shell commands · test Windows paths.

## License

[MIT](LICENSE)
