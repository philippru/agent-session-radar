import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension (integration)', () => {
	test('activates and registers its commands', async () => {
		const ext = vscode.extensions.getExtension('local.session-radar');
		assert.ok(ext, 'extension not found');
		await ext.activate();
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('sessionRadar.refresh'));
	});
});
