// Reader for the Session Radar status layer: ~/.session-radar/status/<agent>/<sessionId>.json
// Written by agent hooks (e.g. resources/hooks/session-radar-hook.js). The format is
// documented in docs/status-format.md and intended to be read by other front-ends, too.

import { promises as fs } from 'fs';
import * as path from 'path';

export interface HookStatus {
	sessionId: string;
	agent: string;
	state: 'running' | 'waiting' | 'idle' | 'ended';
	waitingReason?: 'permission' | 'input';
	/** ms since epoch */
	updatedAt: number;
	turnEndedAt?: number;
	cwd?: string;
	transcriptPath?: string;
	event?: string;
	detail?: string;
}

const STATES = new Set(['running', 'waiting', 'idle', 'ended']);

function isoToMs(v: unknown): number | undefined {
	if (typeof v !== 'string') {
		return undefined;
	}
	const t = Date.parse(v);
	return Number.isNaN(t) ? undefined : t;
}

/** Parse one status file (schemaVersion 1). Unknown future major versions are rejected. */
export function parseStatusFile(text: string): HookStatus | undefined {
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!raw || typeof raw !== 'object' || raw.schemaVersion !== 1) {
		return undefined;
	}
	const updatedAt = isoToMs(raw.updatedAt);
	if (typeof raw.sessionId !== 'string' || typeof raw.agent !== 'string' || typeof raw.state !== 'string'
		|| !STATES.has(raw.state) || updatedAt === undefined) {
		return undefined;
	}
	const s = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
	const waitingReason = raw.waitingReason === 'permission' || raw.waitingReason === 'input' ? raw.waitingReason : undefined;
	return {
		sessionId: raw.sessionId,
		agent: raw.agent,
		state: raw.state as HookStatus['state'],
		waitingReason,
		updatedAt,
		turnEndedAt: isoToMs(raw.turnEndedAt),
		cwd: s(raw.cwd),
		transcriptPath: s(raw.transcriptPath),
		event: s(raw.event),
		detail: s(raw.detail),
	};
}

/** Read all status files of one agent, keyed by session id. Missing directory → empty map. */
export async function readStatusDir(dir: string): Promise<Map<string, HookStatus>> {
	const result = new Map<string, HookStatus>();
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch {
		return result;
	}
	for (const name of names) {
		if (!name.endsWith('.json')) {
			continue;
		}
		try {
			const status = parseStatusFile(await fs.readFile(path.join(dir, name), 'utf8'));
			if (status) {
				result.set(status.sessionId, status);
			}
		} catch {
			// being written or removed right now; the next refresh will pick it up
		}
	}
	return result;
}

/** Delete status files not updated for `maxAgeMs` (and stale temp files). Our own layer only. */
export async function pruneStatusDir(dir: string, maxAgeMs: number, now = Date.now()): Promise<number> {
	let removed = 0;
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch {
		return 0;
	}
	for (const name of names) {
		if (!name.endsWith('.json') && !name.endsWith('.tmp')) {
			continue;
		}
		const fp = path.join(dir, name);
		try {
			const st = await fs.stat(fp);
			const limit = name.endsWith('.tmp') ? 60 * 60 * 1000 : maxAgeMs;
			if (now - st.mtimeMs > limit) {
				await fs.unlink(fp);
				removed++;
			}
		} catch {
			// ignore
		}
	}
	return removed;
}
