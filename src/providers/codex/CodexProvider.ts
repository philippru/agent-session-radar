// Skeleton for the OpenAI Codex CLI provider. NOT IMPLEMENTED YET.
//
// Notes for the implementation (observed on Windows, Codex CLI, 2026-10; verify before use):
// - Data dir: ~/.codex (or $CODEX_HOME)
// - Transcripts ("rollouts"): ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<timestamp>-<id>.jsonl
// - Index: ~/.codex/session_index.jsonl; further state in state_*.sqlite (needs a SQLite reader,
//   prefer the JSONL files to avoid a native dependency)
// - Resume: `codex resume <id>`
// - Live status: Codex supports a `notify` hook in config.toml; it could write status files to
//   ~/.session-radar/status/codex/ in the same format as the Claude Code hook (docs/status-format.md).

import { promises as fs } from 'fs';
import * as path from 'path';
import { AgentSession } from '../../core/model';
import { BaseSessionProvider, Disposable, ResumeHost, WatchHost } from '../../core/provider';

export interface CodexProviderOptions {
	codexDir: string;
}

export class CodexProvider extends BaseSessionProvider {
	readonly agent = 'codex' as const;
	readonly displayName = 'Codex CLI';
	readonly iconId = 'terminal';

	constructor(private readonly options: CodexProviderOptions) {
		super();
	}

	async isAvailable(): Promise<boolean> {
		try {
			return (await fs.stat(path.join(this.options.codexDir, 'sessions'))).isDirectory();
		} catch {
			return false;
		}
	}

	async discover(): Promise<AgentSession[]> {
		return []; // TODO: parse rollout-*.jsonl files
	}

	watch(_host: WatchHost, _onChange: () => void): Disposable {
		return { dispose() { /* nothing to watch yet */ } };
	}

	async resume(session: AgentSession, host: ResumeHost): Promise<void> {
		host.runInTerminal({ name: `Codex: ${session.title}`.slice(0, 60), cwd: session.project, command: `codex resume ${session.id}` });
	}
}
