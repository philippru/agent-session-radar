import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension (integration)', () => {
	test('activates and registers its commands', async () => {
		const ext = vscode.extensions.getExtension('local.session-radar');
		assert.ok(ext, 'extension not found');
		await ext.activate();
		const commands = await vscode.commands.getCommands(true);
		for (const id of ['refresh', 'open', 'rename', 'archive', 'installHooks', 'uninstallHooks', 'showTranscript']) {
			assert.ok(commands.includes(`sessionRadar.${id}`), id);
		}
	});

	test('refresh and view commands run without errors against the fixtures', async () => {
		await vscode.commands.executeCommand('sessionRadar.refresh');
		await vscode.commands.executeCommand('sessionRadar.scopeWorkspace');
		await vscode.commands.executeCommand('sessionRadar.scopeAll');
		await vscode.commands.executeCommand('workbench.view.extension.sessionRadar');
	});
});
