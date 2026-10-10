// Reader for Claude Code's live process registry: ~/.claude/sessions/<pid>.json
//
// NOTE: Not officially documented (internal to Claude Code, observed in 2.1.2xx). One file per
// running interactive process, removed on exit, e.g.:
//   {"pid":14256,"sessionId":"<uuid>","cwd":"c:\\...","kind":"interactive",
//    "entrypoint":"claude-vscode","name":"my-app-2e","nameSource":"derived",
//    "status":"idle"|"busy","updatedAt":<ms>,"statusUpdatedAt":<ms>, ...}
// Files of crashed processes can stay behind, so liveness is checked via the PID.

import { promises as fs } from 'fs';
import * as path from 'path';

export interface ClaudeProcessEntry {
	pid: number;
	sessionId: string;
	cwd?: string;
	status?: string;
	/** When `status` last changed (ms). */
	statusSince?: number;
	entrypoint?: string;
	/** Session name; only meaningful if set by the user (nameSource != "derived"). */
	userName?: string;
	alive: boolean;
}

export type AliveCheck = (pid: number) => boolean;

/** Does a process with this PID exist? Signal 0 only tests, it does not affect the process. */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM: exists, but belongs to another user
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}

export function parseProcessEntry(text: string, isAlive: AliveCheck): ClaudeProcessEntry | undefined {
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const pid = raw.pid;
	const sessionId = raw.sessionId;
	if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || typeof sessionId !== 'string' || !sessionId) {
		return undefined;
	}
	const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
	const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
	const nameSource = str(raw.nameSource);
	return {
		pid,
		sessionId,
		cwd: str(raw.cwd),
		status: str(raw.status),
		statusSince: num(raw.statusUpdatedAt) ?? num(raw.updatedAt),
		entrypoint: str(raw.entrypoint),
		userName: nameSource && nameSource !== 'derived' ? str(raw.name) : undefined,
		alive: isAlive(pid),
	};
}

/**
 * Read all registry entries, keyed by session id. If several processes claim the same
 * session, a live one wins, then the most recently updated.
 * Returns undefined if the registry directory does not exist (older Claude Code versions).
 */
export async function readProcessRegistry(sessionsDir: string, isAlive: AliveCheck = isProcessAlive): Promise<Map<string, ClaudeProcessEntry> | undefined> {
	let names: string[];
	try {
		names = await fs.readdir(sessionsDir);
	} catch {
		return undefined;
	}
	const result = new Map<string, ClaudeProcessEntry>();
	for (const name of names) {
		if (!/^\d+\.json$/.test(name)) {
			continue; // skips <pid>.<hash>.key files (contain tokens, never read them)
		}
		let text: string;
		try {
			text = await fs.readFile(path.join(sessionsDir, name), 'utf8');
		} catch {
			continue;
		}
		const entry = parseProcessEntry(text, isAlive);
		if (!entry) {
			continue;
		}
		const existing = result.get(entry.sessionId);
		if (!existing || better(entry, existing)) {
			result.set(entry.sessionId, entry);
		}
	}
	return result;
}

function better(a: ClaudeProcessEntry, b: ClaudeProcessEntry): boolean {
	if (a.alive !== b.alive) {
		return a.alive;
	}
	return (a.statusSince ?? 0) > (b.statusSince ?? 0);
}
