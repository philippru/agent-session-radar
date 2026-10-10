import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractPromptText, oneLine, parseTranscript, pickTitle, surfaceFromEntrypoint } from '../../providers/claude/transcript';
import { FIXTURES } from './fixtures';

const demo = (id: string) => path.join(FIXTURES, 'claude', 'projects', 'c--work-demo-app', `${id}.jsonl`);

suite('Claude transcript parser', () => {
	test('finished session: latest AI title, cwd, branch, turn ended', async () => {
		const info = await parseTranscript(demo('11111111-1111-4111-8111-111111111111'));
		assert.strictEqual(info.aiTitle, 'Add login form with validation');
		assert.strictEqual(info.cwd, 'C:\\work\\demo-app');
		assert.strictEqual(info.gitBranch, 'feature/login');
		assert.strictEqual(info.entrypoint, 'claude-vscode');
		assert.strictEqual(info.firstPrompt, 'Please add a login form with validation');
		assert.strictEqual(info.turnInProgress, false);
		assert.strictEqual(info.turnEndedAt, Date.parse('2026-10-01T08:10:00.000Z'));
		// last timestamped entry is the system stop_hook_summary
		assert.strictEqual(info.lastTimestamp, Date.parse('2026-10-01T08:10:00.500Z'));
	});

	test('sidechain entries are ignored for the turn state', async () => {
		const info = await parseTranscript(demo('11111111-1111-4111-8111-111111111111'));
		assert.strictEqual(info.turnInProgress, false);
	});

	test('custom title wins over AI title; tool_use last → in progress', async () => {
		const info = await parseTranscript(demo('22222222-2222-4222-8222-222222222222'));
		assert.strictEqual(pickTitle(info, 'x'), 'api-refactor');
		assert.strictEqual(info.turnInProgress, true);
	});

	test('interrupted turn is not in progress; title falls back to (de-tagged) first prompt', async () => {
		const info = await parseTranscript(demo('33333333-3333-4333-8333-333333333333'));
		assert.strictEqual(info.turnInProgress, false);
		assert.strictEqual(info.turnEndedAt, Date.parse('2026-10-03T10:00:09.000Z'));
		assert.strictEqual(info.aiTitle, undefined);
		assert.strictEqual(pickTitle(info, 'x'), 'Fix the flaky test in CI');
	});

	test('malformed lines and unknown entry types are skipped', async () => {
		const info = await parseTranscript(path.join(FIXTURES, 'claude', 'projects', 'C--work-other-repo', '44444444-4444-4444-8444-444444444444.jsonl'));
		assert.strictEqual(info.aiTitle, 'Release notes');
		assert.strictEqual(info.entrypoint, 'cli');
		assert.strictEqual(info.turnInProgress, false);
	});

	test('project is the first cwd, branch the latest', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-radar-test-'));
		const fp = path.join(dir, 'cd.jsonl');
		await fs.writeFile(fp, [
			JSON.stringify({ type: 'user', message: { content: 'Start' }, timestamp: '2026-10-05T09:00:00.000Z', cwd: 'C:\\start', gitBranch: 'main' }),
			JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn' }, timestamp: '2026-10-05T09:01:00.000Z', cwd: 'C:\\start\\sub', gitBranch: 'dev' }),
		].join('\n') + '\n');
		try {
			const info = await parseTranscript(fp);
			assert.strictEqual(info.cwd, 'C:\\start');
			assert.strictEqual(info.gitBranch, 'dev');
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test('large file: tail window grows until a title is found, head stays bounded', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-radar-test-'));
		const fp = path.join(dir, 'big.jsonl');
		const filler = JSON.stringify({ type: 'attachment', attachment: { type: 'x', pad: 'p'.repeat(1000) }, timestamp: '2026-10-05T10:00:00.000Z' });
		const lines = [
			JSON.stringify({ type: 'user', message: { content: 'First prompt' }, timestamp: '2026-10-05T09:00:00.000Z', cwd: '/w/big' }),
			JSON.stringify({ type: 'ai-title', aiTitle: 'Far away title' }),
			...Array.from({ length: 300 }, () => filler), // ~300 KB after the title
		];
		await fs.writeFile(fp, lines.join('\n') + '\n');
		try {
			const info = await parseTranscript(fp);
			assert.strictEqual(info.aiTitle, 'Far away title');
			assert.strictEqual(info.lastTimestamp, Date.parse('2026-10-05T10:00:00.000Z'));
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test('extractPromptText skips meta, tool results and context-only blocks', () => {
		assert.strictEqual(extractPromptText({ type: 'user', isMeta: true, message: { content: 'x' } }), undefined);
		assert.strictEqual(extractPromptText({ type: 'user', toolUseResult: {}, message: { content: 'x' } }), undefined);
		assert.strictEqual(extractPromptText({ type: 'user', message: { content: '<system-reminder>a</system-reminder>' } }), undefined);
		assert.strictEqual(extractPromptText({ type: 'assistant', message: { content: 'x' } }), undefined);
		assert.strictEqual(extractPromptText({ type: 'user', message: { content: [{ type: 'image' }, { type: 'text', text: 'Hi  there' }] } }), 'Hi there');
	});

	test('oneLine collapses whitespace and truncates', () => {
		assert.strictEqual(oneLine('a\n\n b', 10), 'a b');
		assert.strictEqual(oneLine('abcdefghijk', 5), 'abcd…');
	});

	test('surfaceFromEntrypoint', () => {
		assert.strictEqual(surfaceFromEntrypoint('claude-vscode'), 'vscode');
		assert.strictEqual(surfaceFromEntrypoint('cli'), 'cli');
		assert.strictEqual(surfaceFromEntrypoint('claude-desktop'), 'desktop');
		assert.strictEqual(surfaceFromEntrypoint(undefined), 'unknown');
	});
});
