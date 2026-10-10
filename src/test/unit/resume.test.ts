import * as assert from 'assert';
import { AgentSession } from '../../core/model';
import { ResumeHost } from '../../core/provider';
import { ClaudeCodeProvider } from '../../providers/claude/ClaudeCodeProvider';

/** Records every UI call; answers are configurable per test. */
class FakeHost implements ResumeHost {
	readonly uriScheme = 'vscode';
	calls: string[] = [];
	extensions = new Set(['anthropic.claude-code']);
	workspace = 'C:\\work\\demo-app';
	pickAnswer: string | undefined;
	confirmAnswer = false;
	terminalOfPid = false;

	hasExtension(id: string) { return this.extensions.has(id); }
	isInCurrentWorkspace(dir: string) { return dir.toLowerCase().startsWith(this.workspace.toLowerCase()); }
	async openUri(uri: string) { this.calls.push(`uri ${uri}`); return true; }
	runInTerminal(o: { name: string; cwd?: string; command: string }) { this.calls.push(`terminal ${o.cwd} ${o.command}`); }
	async focusTerminalOfPid(pid: number) { this.calls.push(`focus ${pid}`); return this.terminalOfPid; }
	async openFolder(dir: string) { this.calls.push(`folder ${dir}`); }
	async pick(_t: string, items: { id: string }[]) { this.calls.push(`pick ${items.map(i => i.id).join(',')}`); return this.pickAnswer; }
	async confirm() { this.calls.push('confirm'); return this.confirmAnswer; }
	info(m: string) { this.calls.push(`info ${m}`); }
}

const ID = '11111111-1111-4111-8111-111111111111';

function session(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		id: ID, agent: 'claude-code', title: 'T', project: 'C:\\work\\demo-app', projectName: 'demo-app',
		surface: 'vscode', signals: { lastActivity: 0 }, status: 'idle', statusSource: 'transcript',
		...overrides,
	};
}

suite('ClaudeCodeProvider.resume', () => {
	const provider = new ClaudeCodeProvider({ claudeDir: 'unused', maxAgeDays: 1 });

	test('VS Code session of this workspace → documented deep link', async () => {
		const host = new FakeHost();
		await provider.resume(session(), host);
		assert.deepStrictEqual(host.calls, [`uri vscode://anthropic.claude-code/open?session=${ID}`]);
	});

	test('VS Code session of another project → offer window or terminal', async () => {
		const host = new FakeHost();
		host.pickAnswer = 'window';
		await provider.resume(session({ project: 'C:\\work\\other' }), host);
		assert.deepStrictEqual(host.calls, ['pick window,terminal', 'folder C:\\work\\other']);
	});

	test('Claude Code extension not installed → terminal', async () => {
		const host = new FakeHost();
		host.extensions.clear();
		await provider.resume(session(), host);
		assert.deepStrictEqual(host.calls, [`terminal C:\\work\\demo-app claude --resume ${ID}`]);
	});

	test('live CLI session in an integrated terminal → focus it, nothing else', async () => {
		const host = new FakeHost();
		host.terminalOfPid = true;
		await provider.resume(session({ surface: 'cli', signals: { lastActivity: 0, process: { alive: true, pid: 4711 } } }), host);
		assert.deepStrictEqual(host.calls, ['focus 4711']);
	});

	test('live CLI session elsewhere → warn; declining starts nothing', async () => {
		const host = new FakeHost();
		await provider.resume(session({ surface: 'cli', signals: { lastActivity: 0, process: { alive: true, pid: 4711 } } }), host);
		assert.deepStrictEqual(host.calls, ['focus 4711', 'confirm']);
	});

	test('ended CLI session → claude --resume in its project folder', async () => {
		const host = new FakeHost();
		await provider.resume(session({ surface: 'cli', signals: { lastActivity: 0, process: { alive: false } } }), host);
		assert.deepStrictEqual(host.calls, [`terminal C:\\work\\demo-app claude --resume ${ID}`]);
	});

	test('unexpected session id is never passed to a shell', async () => {
		const host = new FakeHost();
		await provider.resumeInTerminal(session({ id: 'abc; rm -rf /', surface: 'cli' }), host);
		assert.deepStrictEqual(host.calls, []);
	});
});
