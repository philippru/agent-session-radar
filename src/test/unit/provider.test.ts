import * as assert from 'assert';
import * as path from 'path';
import { ClaudeCodeProvider } from '../../providers/claude/ClaudeCodeProvider';
import { FIXTURES } from './fixtures';

suite('ClaudeCodeProvider.discover (fixtures)', () => {
	const provider = new ClaudeCodeProvider({ claudeDir: path.join(FIXTURES, 'claude'), maxAgeDays: 100_000 });

	test('finds top-level transcripts only, skips unused sessions and subagents', async () => {
		const sessions = await provider.discover();
		const ids = sessions.map(s => s.id.slice(0, 8)).sort();
		assert.deepStrictEqual(ids, ['11111111', '22222222', '33333333', '44444444']);
	});

	test('maps transcript info onto the shared model', async () => {
		const s = (await provider.discover()).find(x => x.id.startsWith('1111'))!;
		assert.strictEqual(s.agent, 'claude-code');
		assert.strictEqual(s.title, 'Add login form with validation');
		assert.strictEqual(s.project, 'C:\\work\\demo-app');
		assert.strictEqual(s.projectName, 'demo-app');
		assert.strictEqual(s.branch, 'feature/login');
		assert.strictEqual(s.surface, 'vscode');
		assert.ok(s.transcriptPath?.endsWith('.jsonl'));
		assert.strictEqual(s.signals.lastActivity, Date.parse('2026-10-01T08:10:00.500Z'));
	});

	test('isAvailable is false for a missing directory', async () => {
		const missing = new ClaudeCodeProvider({ claudeDir: path.join(FIXTURES, 'does-not-exist'), maxAgeDays: 1 });
		assert.strictEqual(await missing.isAvailable(), false);
		assert.deepStrictEqual(await missing.discover(), []);
	});
});
