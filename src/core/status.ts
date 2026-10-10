// Pure status derivation. Every source (hook, process registry, transcript) reports a
// "phase" with a timestamp; the newest phase wins, ties go to the higher-priority source
// (hook > process > transcript). This handles cases like "permission prompt was answered
// in the meantime" (transcript moves on after the hook's notification) or "user pressed Esc"
// (no Stop hook fires, but the process registry turns idle) without special cases.

import { SessionStatus, StatusSignals, StatusSource, WaitingReason } from './model';

export interface StatusContext {
	now: number;
	/** Sessions without activity for longer than this are 'stale' (default 24h). */
	staleAfterMs: number;
	/** A "running" phase without any new activity for this long is considered stuck/finished. */
	runningTimeoutMs: number;
	/** Without hooks/process info, a turn in progress counts as running only this long. */
	transcriptRunningMs: number;
	/** If true, finished-but-unseen turns are shown as 'waiting' (reason 'unread'). */
	unreadAsWaiting: boolean;
	/** When the user last looked at this session in the radar (ms). */
	lastSeenAt?: number;
	/** Turns that ended before this point count as seen (set on first run). */
	seenBaseline?: number;
}

export const DEFAULT_STATUS_CONTEXT: Omit<StatusContext, 'now'> = {
	staleAfterMs: 24 * 60 * 60 * 1000,
	runningTimeoutMs: 30 * 60 * 1000,
	transcriptRunningMs: 5 * 60 * 1000,
	unreadAsWaiting: true,
};

export interface DerivedStatus {
	status: SessionStatus;
	source: StatusSource;
	waitingReason?: WaitingReason;
}

type Phase =
	| { kind: 'running'; at: number }
	| { kind: 'blocked'; at: number; reason: 'permission' | 'input' }
	| { kind: 'turnEnded'; at: number }
	| { kind: 'ended'; at: number };

interface Candidate { source: StatusSource; phase: Phase }

/** A lower-priority source must be newer by more than this to override a higher one. */
const OVERRIDE_SLACK_MS = 2000;

export function deriveStatus(sig: StatusSignals, ctx: StatusContext): DerivedStatus {
	const candidates: Candidate[] = [];

	if (sig.hook) {
		const h = sig.hook;
		const phase: Phase =
			h.state === 'running' ? { kind: 'running', at: h.updatedAt }
				: h.state === 'waiting' ? { kind: 'blocked', at: h.updatedAt, reason: h.waitingReason ?? 'input' }
					: h.state === 'ended' ? { kind: 'ended', at: h.updatedAt }
						: { kind: 'turnEnded', at: h.turnEndedAt ?? h.updatedAt };
		candidates.push({ source: 'hook', phase });
	}

	if (sig.process) {
		const p = sig.process;
		const at = p.stateSince ?? sig.lastActivity;
		let phase: Phase | undefined;
		if (!p.alive) {
			// A dead process is authoritative regardless of timestamps.
			phase = { kind: 'ended', at: Number.MAX_SAFE_INTEGER };
		} else if (p.state === 'busy') {
			phase = { kind: 'running', at };
		} else if (p.state === 'idle') {
			phase = { kind: 'turnEnded', at };
		} else if (p.state && /wait|input|permission/i.test(p.state)) {
			phase = { kind: 'blocked', at, reason: /permission/i.test(p.state) ? 'permission' : 'input' };
		}
		if (phase) {
			candidates.push({ source: 'process', phase });
		}
	}

	// The transcript is always available.
	candidates.push({
		source: 'transcript',
		phase: sig.turnInProgress
			? { kind: 'running', at: sig.lastActivity }
			: { kind: 'turnEnded', at: sig.turnEndedAt ?? sig.lastActivity },
	});

	// Candidates are in priority order; a later one wins only if clearly newer.
	let chosen = candidates[0];
	for (const c of candidates.slice(1)) {
		if (c.phase.at > chosen.phase.at + OVERRIDE_SLACK_MS) {
			chosen = c;
		}
	}

	const lastActivity = Math.max(sig.lastActivity, sig.hook?.updatedAt ?? 0, sig.process?.stateSince ?? 0);
	const isOld = ctx.now - lastActivity > ctx.staleAfterMs;
	const idleOrStale = (source: StatusSource): DerivedStatus => ({ status: isOld ? 'stale' : 'idle', source });
	let phase = chosen.phase;

	// Guard against "running" that never ends (crash, interrupt without Stop hook, ...).
	if (phase.kind === 'running') {
		const limit = chosen.source === 'transcript' ? ctx.transcriptRunningMs : ctx.runningTimeoutMs;
		if (ctx.now - Math.max(phase.at, sig.lastActivity) > limit) {
			phase = { kind: 'turnEnded', at: Math.max(phase.at, sig.lastActivity) };
		}
	}

	switch (phase.kind) {
		case 'ended':
			return idleOrStale(chosen.source);
		case 'running':
			return { status: 'running', source: chosen.source };
		case 'blocked':
			// A blocked prompt stays relevant as long as the process is (or may be) alive.
			if (isOld && sig.process?.alive !== true) {
				return idleOrStale(chosen.source);
			}
			return { status: 'waiting', source: chosen.source, waitingReason: phase.reason };
		case 'turnEnded': {
			const seen = Math.max(ctx.lastSeenAt ?? 0, ctx.seenBaseline ?? 0);
			const unread = ctx.unreadAsWaiting
				&& phase.at > seen
				&& ctx.now - phase.at <= ctx.staleAfterMs;
			if (unread) {
				return { status: 'waiting', source: chosen.source, waitingReason: 'unread' };
			}
			return idleOrStale(chosen.source);
		}
	}
}

/** Sort order inside a status group: most recent activity first. */
export function compareByActivity(a: { signals: StatusSignals }, b: { signals: StatusSignals }): number {
	return b.signals.lastActivity - a.signals.lastActivity;
}
