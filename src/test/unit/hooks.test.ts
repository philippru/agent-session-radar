import * as assert from 'assert';
import { spawnSync } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseStatusFile, pruneStatusDir, readStatusDir } from '../../core/statusLayer';
import { HOOK_EVENTS, hookCommand, installedEvents, planInstall, planUninstall, serializeLike } from '../../providers/claude/hookConfig';

const HOOK_SCRIPT = path.resolve(__dirname, '..', '..', '..', 'resources', 'hooks', 'session-radar-hook.js');
const CMD = hookCommand('C:\\Users\\me\\.session-radar\\hooks\\session-radar-hook.js');

/** Shape of the user's real settings.json (anonymized): one foreign PostToolUse hook. */
const EXISTING = {
	permissions: { allow: ['Bash(npm test)'] },
	hooks: {
		PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'bash -c "echo reminder"' }] }],
	},
	effortLevel: 'high',
};

suite('hook config (settings.json merge)', () => {
	test('hookCommand uses forward slashes and quotes (works in bash, PowerShell, cmd)', () => {
		assert.strictEqual(CMD, 'node "C:/Users/me/.session-radar/hooks/session-radar-hook.js"');
	});

	test('install adds all events, keeps foreign hooks and other settings, does not mutate input', () => {
		const before = structuredClone(EXISTING);
		const plan = planInstall(EXISTING, CMD);
		assert.deepStrictEqual(EXISTING, before);
		assert.deepStrictEqual(plan.added, [...HOOK_EVENTS]);
		const hooks = plan.next.hooks as Record<string, unknown[]>;
		assert.deepStrictEqual(hooks.PostToolUse, EXISTING.hooks.PostToolUse);
		assert.deepStrictEqual(hooks.Stop, [{ hooks: [{ type: 'command', command: CMD, timeout: 10 }] }]);
		assert.strictEqual(plan.next.effortLevel, 'high');
		assert.deepStrictEqual(installedEvents(plan.next), [...HOOK_EVENTS]);
	});

	test('install is idempotent; a moved script path is updated in place', () => {
		const once = planInstall(EXISTING, CMD).next;
		const twice = planInstall(once, CMD);
		assert.deepStrictEqual(twice.added, []);
		assert.deepStrictEqual(twice.unchanged, [...HOOK_EVENTS]);
		const moved = planInstall(once, hookCommand('D:/other/session-radar-hook.js'));
		assert.deepStrictEqual(moved.updated, [...HOOK_EVENTS]);
		assert.strictEqual((moved.next.hooks as Record<string, unknown[]>).Stop.length, 1);
	});

	test('install next to a foreign hook on the same event keeps both', () => {
		const withStop = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } };
		const stop = (planInstall(withStop, CMD).next.hooks as Record<string, unknown[]>).Stop;
		assert.strictEqual(stop.length, 2);
	});

	test('uninstall removes only our handlers and restores the original structure', () => {
		const installed = planInstall(EXISTING, CMD).next;
		const { next, removed } = planUninstall(installed);
		assert.deepStrictEqual(removed.sort(), [...HOOK_EVENTS].sort());
		assert.deepStrictEqual(next, EXISTING);
	});

	test('uninstall keeps foreign handlers that share a group with ours', () => {
		const mixed = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }, { type: 'command', command: CMD }] }] } };
		const { next } = planUninstall(mixed);
		assert.deepStrictEqual(next, { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } });
	});

	test('unexpected shapes are rejected instead of being overwritten', () => {
		assert.throws(() => planInstall({ hooks: [] }, CMD));
		assert.throws(() => planInstall({ hooks: { Stop: {} } }, CMD));
		assert.throws(() => planInstall('nope', CMD));
	});

	test('serializeLike keeps indentation, CRLF and trailing newline', () => {
		const orig = '{\r\n    "a": 1\r\n}\r\n';
		assert.strictEqual(serializeLike(orig, { a: 1 }), orig);
		assert.strictEqual(serializeLike('{\n  "a": 1\n}', { a: 1 }), '{\n  "a": 1\n}');
		assert.strictEqual(serializeLike(undefined, {}), '{}\n');
	});
});

/** Run the real hook script as Claude Code would: JSON on stdin. */
function runHook(home: string, input: unknown) {
	const r = spawnSync(process.execPath, [HOOK_SCRIPT], {
		input: typeof input === 'string' ? input : JSON.stringify(input),
		env: { ...process.env, SESSION_RADAR_HOME: home },
		encoding: 'utf8',
		timeout: 10_000,
	});
	return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

suite('hook script (end-to-end, child process)', () => {
	let home: string;
	const SID = 'aaaaaaaa-0000-4000-8000-000000000001';
	const statusFile = () => path.join(home, 'status', 'claude-code', `${SID}.json`);
	const base = { session_id: SID, transcript_path: 'C:\\x\\t.jsonl', cwd: 'C:\\work\\demo' };
	const read = async () => {
		const text = await fs.readFile(statusFile(), 'utf8');
		return { text, status: parseStatusFile(text)! };
	};

	setup(async () => {
		home = await fs.mkdtemp(path.join(os.tmpdir(), 'session-radar-hook-'));
	});
	teardown(async () => {
		await fs.rm(home, { recursive: true, force: true });
	});

	test('full lifecycle produces the documented states; silent, exit 0', async () => {
		let r = runHook(home, { ...base, hook_event_name: 'SessionStart', source: 'startup' });
		assert.deepStrictEqual([r.status, r.stdout, r.stderr], [0, '', '']);
		let s = (await read()).status;
		assert.strictEqual(s.state, 'idle');
		assert.strictEqual(s.turnEndedAt, undefined);
		assert.strictEqual(s.cwd, 'C:\\work\\demo');

		runHook(home, { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'TOP-SECRET-PROMPT' });
		const after = await read();
		assert.strictEqual(after.status.state, 'running');
		assert.ok(!after.text.includes('TOP-SECRET'), 'prompt content must never be stored');

		runHook(home, { ...base, hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
		s = (await read()).status;
		assert.deepStrictEqual([s.state, s.waitingReason, s.detail], ['waiting', 'permission', 'permission_prompt']);

		runHook(home, { ...base, hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'waiting' });
		assert.strictEqual((await read()).status.state, 'waiting', 'idle_prompt does not change the state');

		runHook(home, { ...base, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'SECRET ANSWER' });
		const stopped = await read();
		assert.strictEqual(stopped.status.state, 'idle');
		assert.strictEqual(stopped.status.waitingReason, undefined);
		assert.ok(stopped.status.turnEndedAt);
		assert.ok(!stopped.text.includes('SECRET ANSWER'));

		runHook(home, { ...base, hook_event_name: 'SessionStart', source: 'resume' });
		assert.strictEqual((await read()).status.turnEndedAt, undefined, 'resuming clears "unread"');

		runHook(home, { ...base, hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' });
		s = (await read()).status;
		assert.deepStrictEqual([s.state, s.detail], ['ended', 'prompt_input_exit']);
	});

	test('garbage input, unknown events and unsafe session ids: exit 0, nothing written', async () => {
		for (const input of ['not json', '', { hook_event_name: 'Stop' }, { ...base, hook_event_name: 'PreToolUse' },
			{ ...base, session_id: '../../evil', hook_event_name: 'Stop' }, { ...base, session_id: 'a/b', hook_event_name: 'Stop' }]) {
			const r = runHook(home, input);
			assert.deepStrictEqual([r.status, r.stdout], [0, ''], JSON.stringify(input));
		}
		const status = await fs.readdir(path.join(home, 'status', 'claude-code')).catch(() => []);
		assert.deepStrictEqual(status, []);
		await assert.rejects(fs.stat(path.join(home, '..', 'evil.json')));
	});
});

suite('status layer reader', () => {
	test('parseStatusFile accepts v1, rejects other versions and bad states', () => {
		const ok = { schemaVersion: 1, agent: 'claude-code', sessionId: 's', state: 'waiting', waitingReason: 'permission', updatedAt: '2026-10-10T10:00:00.000Z' };
		assert.strictEqual(parseStatusFile(JSON.stringify(ok))?.updatedAt, Date.parse('2026-10-10T10:00:00.000Z'));
		assert.strictEqual(parseStatusFile(JSON.stringify({ ...ok, schemaVersion: 2 })), undefined);
		assert.strictEqual(parseStatusFile(JSON.stringify({ ...ok, state: 'dancing' })), undefined);
		assert.strictEqual(parseStatusFile(JSON.stringify({ ...ok, waitingReason: 'x' }))?.waitingReason, undefined);
	});

	test('readStatusDir and pruneStatusDir', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-radar-status-'));
		try {
			const mk = (id: string) => JSON.stringify({ schemaVersion: 1, agent: 'claude-code', sessionId: id, state: 'idle', updatedAt: new Date().toISOString() });
			await fs.writeFile(path.join(dir, 'a.json'), mk('a'));
			await fs.writeFile(path.join(dir, 'b.json'), mk('b'));
			await fs.writeFile(path.join(dir, 'c.json'), '{broken');
			const old = new Date(Date.now() - 40 * 24 * 3600_000);
			await fs.utimes(path.join(dir, 'b.json'), old, old);
			assert.deepStrictEqual([...(await readStatusDir(dir)).keys()].sort(), ['a', 'b']);
			assert.strictEqual(await pruneStatusDir(dir, 30 * 24 * 3600_000), 1);
			assert.deepStrictEqual([...(await readStatusDir(dir)).keys()], ['a']);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
