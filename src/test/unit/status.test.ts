import * as assert from 'assert';
import { StatusSignals } from '../../core/model';
import { DEFAULT_STATUS_CONTEXT, StatusContext, deriveStatus } from '../../core/status';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-10-10T12:00:00Z');

function ctx(overrides: Partial<StatusContext> = {}): StatusContext {
	// seenBaseline far in the past so "unread" logic is active unless a test sets it
	return { ...DEFAULT_STATUS_CONTEXT, now: NOW, seenBaseline: 0, ...overrides };
}

suite('deriveStatus – transcript only', () => {
	test('turn in progress with recent activity → running', () => {
		const sig: StatusSignals = { lastActivity: NOW - 1 * MIN, turnInProgress: true };
		assert.deepStrictEqual(deriveStatus(sig, ctx()), { status: 'running', source: 'transcript' });
	});

	test('turn in progress but silent for > 5 min → no longer running', () => {
		const sig: StatusSignals = { lastActivity: NOW - 10 * MIN, turnInProgress: true };
		assert.strictEqual(deriveStatus(sig, ctx({ unreadAsWaiting: false })).status, 'idle');
	});

	test('finished turn, not seen yet → waiting (unread)', () => {
		const sig: StatusSignals = { lastActivity: NOW - 2 * HOUR, turnEndedAt: NOW - 2 * HOUR };
		assert.deepStrictEqual(deriveStatus(sig, ctx()), { status: 'waiting', source: 'transcript', waitingReason: 'unread' });
	});

	test('finished turn, seen afterwards → idle', () => {
		const sig: StatusSignals = { lastActivity: NOW - 2 * HOUR, turnEndedAt: NOW - 2 * HOUR };
		assert.strictEqual(deriveStatus(sig, ctx({ lastSeenAt: NOW - HOUR })).status, 'idle');
	});

	test('finished turn before the first-run baseline counts as seen', () => {
		const sig: StatusSignals = { lastActivity: NOW - 2 * HOUR, turnEndedAt: NOW - 2 * HOUR };
		assert.strictEqual(deriveStatus(sig, ctx({ seenBaseline: NOW - HOUR })).status, 'idle');
	});

	test('unread disabled → idle', () => {
		const sig: StatusSignals = { lastActivity: NOW - 2 * HOUR, turnEndedAt: NOW - 2 * HOUR };
		assert.strictEqual(deriveStatus(sig, ctx({ unreadAsWaiting: false })).status, 'idle');
	});

	test('older than 24h → stale, even if unread', () => {
		const sig: StatusSignals = { lastActivity: NOW - 30 * HOUR, turnEndedAt: NOW - 30 * HOUR };
		assert.strictEqual(deriveStatus(sig, ctx()).status, 'stale');
	});
});

suite('deriveStatus – process registry', () => {
	test('alive + busy → running (source process)', () => {
		const sig: StatusSignals = { lastActivity: NOW - 2 * MIN, process: { alive: true, state: 'busy', stateSince: NOW - 1 * MIN } };
		assert.deepStrictEqual(deriveStatus(sig, ctx()), { status: 'running', source: 'process' });
	});

	test('busy for a long time without transcript activity → considered stuck', () => {
		const sig: StatusSignals = { lastActivity: NOW - 2 * HOUR, process: { alive: true, state: 'busy', stateSince: NOW - 2 * HOUR } };
		assert.notStrictEqual(deriveStatus(sig, ctx()).status, 'running');
	});

	test('long-running tool: busy since long but transcript recently written → running', () => {
		const sig: StatusSignals = { lastActivity: NOW - 1 * MIN, turnInProgress: true, process: { alive: true, state: 'busy', stateSince: NOW - 2 * HOUR } };
		assert.strictEqual(deriveStatus(sig, ctx()).status, 'running');
	});

	test('alive + idle after the user saw it → idle', () => {
		const sig: StatusSignals = { lastActivity: NOW - 3 * HOUR, process: { alive: true, state: 'idle', stateSince: NOW - 3 * HOUR } };
		assert.strictEqual(deriveStatus(sig, ctx({ lastSeenAt: NOW - 2 * HOUR })).status, 'idle');
	});

	test('dead process wins over a transcript that looks in progress', () => {
		const sig: StatusSignals = { lastActivity: NOW - 1 * MIN, turnInProgress: true, process: { alive: false } };
		assert.deepStrictEqual(deriveStatus(sig, ctx()), { status: 'idle', source: 'process' });
	});

	test('dead process: no "unread" for an ended session', () => {
		const sig: StatusSignals = { lastActivity: NOW - 1 * HOUR, turnEndedAt: NOW - 1 * HOUR, process: { alive: false } };
		assert.strictEqual(deriveStatus(sig, ctx()).status, 'idle');
	});

	test('not in registry: ended, but only after a grace period', () => {
		const fresh: StatusSignals = { lastActivity: NOW - 1 * MIN, turnInProgress: true, process: { alive: false, registered: false } };
		assert.deepStrictEqual(deriveStatus(fresh, ctx()), { status: 'running', source: 'transcript' });
		const old: StatusSignals = { lastActivity: NOW - 10 * MIN, turnEndedAt: NOW - 10 * MIN, process: { alive: false, registered: false } };
		assert.deepStrictEqual(deriveStatus(old, ctx()), { status: 'idle', source: 'process' });
	});

	test('unknown process state is ignored (falls back to transcript)', () => {
		const sig: StatusSignals = { lastActivity: NOW - 1 * MIN, turnInProgress: true, process: { alive: true, state: 'something-new', stateSince: NOW - 1 * MIN } };
		assert.deepStrictEqual(deriveStatus(sig, ctx()), { status: 'running', source: 'transcript' });
	});
});

suite('deriveStatus – hooks', () => {
	test('permission prompt → waiting (permission)', () => {
		const sig: StatusSignals = {
			lastActivity: NOW - 10_000,
			turnInProgress: true,
			hook: { state: 'waiting', waitingReason: 'permission', updatedAt: NOW - 5_000 },
		};
		assert.deepStrictEqual(deriveStatus(sig, ctx()), { status: 'waiting', source: 'hook', waitingReason: 'permission' });
	});

	test('permission prompt answered: transcript moved on → running', () => {
		const sig: StatusSignals = {
			lastActivity: NOW - 10_000,
			turnInProgress: true,
			hook: { state: 'waiting', waitingReason: 'permission', updatedAt: NOW - 60_000 },
		};
		assert.deepStrictEqual(deriveStatus(sig, ctx()), { status: 'running', source: 'transcript' });
	});

	test('hook beats process registry at similar timestamps', () => {
		const sig: StatusSignals = {
			lastActivity: NOW - 10_000,
			hook: { state: 'waiting', waitingReason: 'input', updatedAt: NOW - 5_000 },
			process: { alive: true, state: 'busy', stateSince: NOW - 4_000 },
		};
		assert.strictEqual(deriveStatus(sig, ctx()).source, 'hook');
	});

	test('Esc interrupt (no Stop hook): newer idle process state wins over hook running', () => {
		const sig: StatusSignals = {
			lastActivity: NOW - 4 * MIN,
			hook: { state: 'running', updatedAt: NOW - 5 * MIN },
			process: { alive: true, state: 'idle', stateSince: NOW - 4 * MIN },
		};
		const d = deriveStatus(sig, ctx({ lastSeenAt: NOW }));
		assert.deepStrictEqual(d, { status: 'idle', source: 'process' });
	});

	test('Stop hook → unread until seen', () => {
		const sig: StatusSignals = { lastActivity: NOW - 2 * MIN, hook: { state: 'idle', updatedAt: NOW - 2 * MIN, turnEndedAt: NOW - 2 * MIN } };
		assert.strictEqual(deriveStatus(sig, ctx()).waitingReason, 'unread');
		assert.strictEqual(deriveStatus(sig, ctx({ lastSeenAt: NOW - MIN })).status, 'idle');
	});

	test('SessionEnd → idle, never unread', () => {
		const sig: StatusSignals = { lastActivity: NOW - 2 * MIN, turnEndedAt: NOW - 3 * MIN, hook: { state: 'ended', updatedAt: NOW - 2 * MIN } };
		assert.deepStrictEqual(deriveStatus(sig, ctx()), { status: 'idle', source: 'hook' });
	});

	test('blocked prompt stays waiting beyond 24h while the process is alive', () => {
		const sig: StatusSignals = {
			lastActivity: NOW - 48 * HOUR,
			hook: { state: 'waiting', waitingReason: 'permission', updatedAt: NOW - 48 * HOUR },
			process: { alive: true, state: 'busy', stateSince: NOW - 48 * HOUR },
		};
		assert.strictEqual(deriveStatus(sig, ctx()).status, 'waiting');
	});
});
