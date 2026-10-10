import * as assert from 'assert';
import * as path from 'path';
import { ClaudeCodeProvider } from '../../providers/claude/ClaudeCodeProvider';
import { isProcessAlive, parseProcessEntry, readProcessRegistry } from '../../providers/claude/processRegistry';
import { FIXTURES } from './fixtures';

const REGISTRY = path.join(FIXTURES, 'claude', 'sessions');
/** In the fixtures, PID 1002 has died (stale file left behind), all others run. */
const fakeAlive = (pid: number) => pid !== 1002;

suite('Claude process registry', () => {
	test('isProcessAlive: own process yes, absurd PID no', () => {
		assert.strictEqual(isProcessAlive(process.pid), true);
		assert.strictEqual(isProcessAlive(2_000_000_000), false);
	});

	test('parseProcessEntry validates required fields', () => {
		assert.strictEqual(parseProcessEntry('{', fakeAlive), undefined);
		assert.strictEqual(parseProcessEntry('{"pid":"1","sessionId":"a"}', fakeAlive), undefined);
		assert.strictEqual(parseProcessEntry('{"pid":1}', fakeAlive), undefined);
		const e = parseProcessEntry('{"pid":7,"sessionId":"s","status":"idle","updatedAt":5,"name":"n","nameSource":"derived"}', fakeAlive);
		assert.deepStrictEqual(e, { pid: 7, sessionId: 's', cwd: undefined, status: 'idle', statusSince: 5, entrypoint: undefined, userName: undefined, alive: true });
	});

	test('reads <pid>.json only, skips broken files and .key files', async () => {
		const reg = await readProcessRegistry(REGISTRY, fakeAlive);
		assert.ok(reg);
		assert.deepStrictEqual([...reg.keys()].sort(), [
			'11111111-1111-4111-8111-111111111111',
			'22222222-2222-4222-8222-222222222222',
		]);
	});

	test('two processes claim the same session: the live one wins over a newer dead one', async () => {
		const reg = await readProcessRegistry(REGISTRY, fakeAlive);
		const e = reg!.get('11111111-1111-4111-8111-111111111111')!;
		assert.strictEqual(e.pid, 1003);
		assert.strictEqual(e.status, 'idle');
	});

	test('user-set name is exposed, derived name is not', async () => {
		const reg = await readProcessRegistry(REGISTRY, fakeAlive);
		assert.strictEqual(reg!.get('22222222-2222-4222-8222-222222222222')!.userName, 'api-refactor-renamed');
		assert.strictEqual(reg!.get('11111111-1111-4111-8111-111111111111')!.userName, undefined);
	});

	test('missing registry directory → undefined (no information, not "all dead")', async () => {
		assert.strictEqual(await readProcessRegistry(path.join(FIXTURES, 'nope'), fakeAlive), undefined);
	});

	test('provider attaches process signals; unregistered sessions are marked as such', async () => {
		const provider = new ClaudeCodeProvider({ claudeDir: path.join(FIXTURES, 'claude'), maxAgeDays: 100_000, isAlive: fakeAlive });
		const byId = new Map((await provider.discover()).map(s => [s.id.slice(0, 4), s]));
		assert.deepStrictEqual(byId.get('2222')!.signals.process, { alive: true, registered: true, state: 'busy', stateSince: 1790000200000, pid: 1001 });
		// custom-title from the transcript beats the registry name
		assert.strictEqual(byId.get('2222')!.title, 'api-refactor');
		assert.strictEqual(byId.get('1111')!.signals.process?.pid, 1003);
		assert.deepStrictEqual(byId.get('3333')!.signals.process, { alive: false, registered: false });
	});
});
