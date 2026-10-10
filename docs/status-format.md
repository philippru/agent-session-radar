# Agent Session Radar status layer — file format

Agent Session Radar keeps a small, agent-independent state layer under `~/.session-radar/`
(override with the environment variable `SESSION_RADAR_HOME`). It is written by agent hooks
and by the VS Code extension and can be read by any other front-end, e.g. a web or mobile view.

```
~/.session-radar/
├── status/
│   └── <agent>/                   one folder per agent type, e.g. claude-code, codex
│       └── <sessionId>.json       live state of one session (written by hooks)
├── annotations.json               user annotations: labels, archived, last seen (written by the UI)
├── hooks/
│   └── session-radar-hook.js      hook script referenced from ~/.claude/settings.json
└── backups/
    └── claude-settings.<timestamp>.json   copies of settings.json before every change
```

**Privacy:** None of these files contain prompt or message text. Only states, timestamps,
paths and ids. Transcripts are only ever read, never written.

**Writing rules:** Files are written atomically (write `<file>.<pid>.tmp`, then rename).
Readers must ignore `*.tmp` files, tolerate unknown fields and skip files they cannot parse.

## `status/<agent>/<sessionId>.json` (schemaVersion 1)

```json
{
  "schemaVersion": 1,
  "agent": "claude-code",
  "sessionId": "4d60d851-80c5-4e46-85ab-c051c433af05",
  "state": "waiting",
  "waitingReason": "permission",
  "event": "Notification",
  "detail": "permission_prompt",
  "cwd": "C:\\Users\\me\\projects\\my-app",
  "transcriptPath": "C:\\Users\\me\\.claude\\projects\\c--Users-me-projects-my-app\\4d60….jsonl",
  "startedAt": "2026-10-10T08:00:00.000Z",
  "turnEndedAt": "2026-10-10T08:41:12.345Z",
  "updatedAt": "2026-10-10T08:42:03.120Z",
  "writer": "session-radar-hook/1"
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `schemaVersion` | number | yes | `1`. A reader must reject versions it does not know. |
| `agent` | string | yes | Agent type, same as the folder name. |
| `sessionId` | string | yes | Agent's session id (file name without `.json`). |
| `state` | string | yes | `running` (agent works) · `waiting` (blocked on the user) · `idle` (ready, turn finished) · `ended` (session closed) |
| `waitingReason` | string | no | Only with `state: waiting`: `permission` (tool approval) or `input` (question/form). |
| `event` | string | no | Agent event that caused the last update (e.g. Claude Code hook name). |
| `detail` | string | no | Event detail, e.g. `notification_type`, `SessionStart.source`, `SessionEnd.reason`. |
| `cwd` | string | no | Working directory of the session. |
| `transcriptPath` | string | no | Agent transcript (read-only for consumers). |
| `startedAt` | ISO 8601 | no | When the session was started (first `SessionStart`). |
| `turnEndedAt` | ISO 8601 | no | When the agent last finished a turn. Missing after a new prompt or a (re)start. Consumers use it for "unread": unread = `turnEndedAt` > last time the user looked. |
| `updatedAt` | ISO 8601 | yes | Time of this update. |
| `writer` | string | no | Name/version of the writer. |

### Claude Code: event → state

| Hook event | Resulting state |
|---|---|
| `SessionStart` | `idle`, clears `turnEndedAt` and `waitingReason` |
| `UserPromptSubmit` | `running`, clears `turnEndedAt` |
| `Notification` with `notification_type` = `permission_prompt` | `waiting` / `permission` |
| `Notification` with `elicitation_dialog`, `elicitation_url_dialog`, `agent_needs_input` | `waiting` / `input` |
| other notifications (`idle_prompt`, `auth_success`, …) | no change |
| `Stop` | `idle`, sets `turnEndedAt` |
| `SessionEnd` | `ended`, `detail` = reason |

Caveats a consumer should handle:

- **No event when a permission prompt is answered.** `waiting` stays until the next event. Agent Session Radar
  treats `waiting` as resolved as soon as the transcript was written after `updatedAt`.
- **No `Stop` when the user interrupts (Esc).** `running` can therefore get stuck. Agent Session Radar
  cross-checks the process registry and uses a timeout (`sessionRadar.runningTimeoutMinutes`).
- **Crashes** leave the last state behind. Check process liveness where possible.
- Status files older than `sessionRadar.maxAgeDays` are deleted by the extension.

## `annotations.json` (schemaVersion 1)

```json
{
  "schemaVersion": 1,
  "seenBaseline": 1791620000000,
  "sessions": {
    "claude-code:4d60d851-80c5-4e46-85ab-c051c433af05": {
      "label": "Login-Refactoring",
      "archived": true,
      "lastSeenAt": 1791621234567
    }
  }
}
```

| Field | Meaning |
|---|---|
| `seenBaseline` | ms since epoch. Turns that ended before this point count as seen (set on first start, so old sessions do not show up as unread). |
| `sessions` | Keyed by `<agent>:<sessionId>`. |
| `label` | Local display name. Overrides the agent's title, does not rename the session in the agent. |
| `archived` | Hidden from the default view. |
| `lastSeenAt` | ms since epoch. When the user last opened the session from a Agent Session Radar front-end. |

Writers must re-read the file immediately before writing (read-modify-write), because several
VS Code windows or other front-ends may write to it.
