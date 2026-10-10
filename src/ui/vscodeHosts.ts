// VS Code implementations of the host interfaces used by providers.

import * as fs from 'fs';
import * as vscode from 'vscode';
import { Disposable, ResumeHost, WatchHost } from '../core/provider';
import { isPathInside } from '../core/util';
import { parentPid } from './processTree';

export class VsCodeWatchHost implements WatchHost {
	watch(baseDir: string, glob: string, listener: (changedPath: string) => void): Disposable {
		// Watching outside the workspace requires a RelativePattern with an absolute base URI.
		const pattern = new vscode.RelativePattern(vscode.Uri.file(baseDir), glob);
		const watcher = vscode.workspace.createFileSystemWatcher(pattern);
		const fire = (uri: vscode.Uri) => listener(uri.fsPath);
		const subs = [watcher.onDidCreate(fire), watcher.onDidChange(fire), watcher.onDidDelete(fire)];
		return {
			dispose: () => {
				subs.forEach(s => s.dispose());
				watcher.dispose();
			},
		};
	}
}

export class VsCodeResumeHost implements ResumeHost {
	get uriScheme(): string {
		return vscode.env.uriScheme;
	}

	hasExtension(id: string): boolean {
		return vscode.extensions.getExtension(id) !== undefined;
	}

	isInCurrentWorkspace(dir: string): boolean {
		return (vscode.workspace.workspaceFolders ?? []).some(f => isPathInside(dir, f.uri.fsPath));
	}

	async openUri(uri: string): Promise<boolean> {
		return vscode.env.openExternal(vscode.Uri.parse(uri));
	}

	runInTerminal(options: { name: string; cwd?: string; command: string }): void {
		const cwd = options.cwd && fs.existsSync(options.cwd) ? options.cwd : undefined;
		const terminal = vscode.window.createTerminal({ name: options.name, cwd });
		terminal.show();
		terminal.sendText(options.command, true);
	}

	async focusTerminalOfPid(pid: number): Promise<boolean> {
		// Walk up the process tree (agent → shell → ...) and match terminal shell PIDs.
		const terminals = await Promise.all(
			vscode.window.terminals.map(async t => ({ t, pid: await t.processId })),
		);
		let current: number | undefined = pid;
		for (let depth = 0; current && depth < 4; depth++) {
			const match = terminals.find(x => x.pid === current);
			if (match) {
				match.t.show();
				return true;
			}
			current = await parentPid(current);
		}
		return false;
	}

	async openFolder(dir: string): Promise<void> {
		await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dir), { forceNewWindow: true });
	}

	async pick(title: string, items: { id: string; label: string; detail?: string }[]): Promise<string | undefined> {
		const chosen = await vscode.window.showQuickPick(
			items.map(i => ({ label: i.label, detail: i.detail, id: i.id })),
			{ title, placeHolder: title },
		);
		return chosen?.id;
	}

	async confirm(message: string, confirmLabel: string): Promise<boolean> {
		return (await vscode.window.showWarningMessage(message, { modal: true }, confirmLabel)) === confirmLabel;
	}

	info(message: string): void {
		void vscode.window.showInformationMessage(message);
	}
}
