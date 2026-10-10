import { promises as fs } from 'fs';
import * as path from 'path';
import { AgentSession, baseName } from '../../core/model';
import { BaseSessionProvider, Disposable, ResumeHost, WatchHost } from '../../core/provider';
import { mapLimit } from '../../core/util';
import { AliveCheck, ClaudeProcessEntry, isProcessAlive, readProcessRegistry } from './processRegistry';
import { TranscriptInfo, parseTranscript, pickTitle, surfaceFromEntrypoint } from './transcript';

export interface ClaudeCodeProviderOptions {
	/** Claude Code config dir, usually ~/.claude (or $CLAUDE_CONFIG_DIR). */
	claudeDir: string;
	/** Ignore transcripts not modified within this many days. */
	maxAgeDays: number;
	/** Injectable for tests. */
	isAlive?: AliveCheck;
}

interface CacheEntry {
	size: number;
	mtimeMs: number;
	info: TranscriptInfo;
}

const SESSION_ID_RE = /^[0-9a-fA-F-]{8,64}$/;

export class ClaudeCodeProvider extends BaseSessionProvider {
	readonly agent = 'claude-code' as const;
	readonly displayName = 'Claude Code';
	readonly iconId = 'sparkle';

	private readonly cache = new Map<string, CacheEntry>();

	constructor(private readonly options: ClaudeCodeProviderOptions) {
		super();
	}

	get projectsDir(): string {
		return path.join(this.options.claudeDir, 'projects');
	}

	/** Live process registry (<pid>.json per running process). */
	get processRegistryDir(): string {
		return path.join(this.options.claudeDir, 'sessions');
	}

	async isAvailable(): Promise<boolean> {
		try {
			return (await fs.stat(this.projectsDir)).isDirectory();
		} catch {
			return false;
		}
	}

	async discover(): Promise<AgentSession[]> {
		const [files, registry] = await Promise.all([
			this.listTranscripts(),
			readProcessRegistry(this.processRegistryDir, this.options.isAlive ?? isProcessAlive),
		]);
		const seen = new Set<string>();
		const sessions = await mapLimit(files, 8, async (file) => {
			seen.add(file.path);
			const info = await this.transcriptInfo(file.path, file.size, file.mtimeMs);
			const session = info ? this.toSession(file.path, file.mtimeMs, info) : undefined;
			if (session && info && registry) {
				this.applyProcess(session, info, registry.get(session.id));
			}
			return session;
		});
		// Drop cache entries of deleted/aged-out transcripts.
		for (const key of this.cache.keys()) {
			if (!seen.has(key)) {
				this.cache.delete(key);
			}
		}
		return sessions.filter((s): s is AgentSession => s !== undefined);
	}

	watch(host: WatchHost, onChange: () => void): Disposable {
		const subs = [
			// Only top-level transcripts; subagent transcripts live in <session>/subagents/.
			host.watch(this.projectsDir, '*/*.jsonl', () => onChange()),
			host.watch(this.processRegistryDir, '*.json', () => onChange()),
		];
		return { dispose: () => subs.forEach(s => s.dispose()) };
	}

	async resume(session: AgentSession, host: ResumeHost): Promise<void> {
		host.runInTerminal({
			name: `Claude: ${session.label ?? session.title}`.slice(0, 60),
			cwd: session.project,
			command: `claude --resume ${session.id}`,
		});
	}

	/** Attach live process info. A registry without this session means: process has exited. */
	private applyProcess(session: AgentSession, info: TranscriptInfo, proc: ClaudeProcessEntry | undefined): void {
		if (!proc) {
			session.signals.process = { alive: false, registered: false };
			return;
		}
		session.signals.process = {
			alive: proc.alive,
			registered: true,
			state: proc.status,
			stateSince: proc.statusSince,
			pid: proc.pid,
		};
		if (proc.userName && !info.customTitle) {
			session.title = proc.userName;
		}
	}

	/** All top-level <projects>/<dir>/<uuid>.jsonl files modified within maxAgeDays. */
	private async listTranscripts(): Promise<{ path: string; size: number; mtimeMs: number }[]> {
		const minMtime = Date.now() - this.options.maxAgeDays * 24 * 60 * 60 * 1000;
		const result: { path: string; size: number; mtimeMs: number }[] = [];
		let projectDirs: string[];
		try {
			projectDirs = await fs.readdir(this.projectsDir);
		} catch {
			return result;
		}
		for (const dir of projectDirs) {
			const full = path.join(this.projectsDir, dir);
			let names: string[];
			try {
				names = await fs.readdir(full);
			} catch {
				continue; // not a directory or not readable
			}
			for (const name of names) {
				if (!name.endsWith('.jsonl') || !SESSION_ID_RE.test(name.slice(0, -6))) {
					continue;
				}
				const fp = path.join(full, name);
				try {
					const st = await fs.stat(fp);
					if (st.isFile() && st.size > 0 && st.mtimeMs >= minMtime) {
						result.push({ path: fp, size: st.size, mtimeMs: st.mtimeMs });
					}
				} catch {
					// file vanished between readdir and stat
				}
			}
		}
		return result;
	}

	private async transcriptInfo(fp: string, size: number, mtimeMs: number): Promise<TranscriptInfo | undefined> {
		const cached = this.cache.get(fp);
		if (cached && cached.size === size && cached.mtimeMs === mtimeMs) {
			return cached.info;
		}
		try {
			const info = await parseTranscript(fp);
			this.cache.set(fp, { size, mtimeMs, info });
			return info;
		} catch {
			return undefined;
		}
	}

	private toSession(fp: string, mtimeMs: number, info: TranscriptInfo): AgentSession | undefined {
		const id = path.basename(fp, '.jsonl');
		// Transcripts without any timestamped entry were opened but never used.
		if (info.lastTimestamp === undefined && info.firstPrompt === undefined) {
			return undefined;
		}
		const project = info.cwd ?? path.dirname(fp);
		return {
			id,
			agent: this.agent,
			title: pickTitle(info, `Session ${id.slice(0, 8)}`),
			project,
			projectName: baseName(project),
			branch: info.gitBranch,
			surface: surfaceFromEntrypoint(info.entrypoint),
			transcriptPath: fp,
			agentVersion: info.version,
			signals: {
				lastActivity: info.lastTimestamp ?? mtimeMs,
				turnEndedAt: info.turnEndedAt,
				turnInProgress: info.turnInProgress,
			},
			// filled in by the store
			status: 'idle',
			statusSource: 'transcript',
		};
	}
}
