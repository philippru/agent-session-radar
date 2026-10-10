// "Install/remove hooks" commands: diff preview → confirmation → backup → write.

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { writeFileAtomic } from '../core/atomicWrite';
import { HOOK_SCRIPT_NAME, hookCommand, installedEvents, planInstall, planUninstall, serializeLike } from '../providers/claude/hookConfig';

const PREVIEW_SCHEME = 'session-radar-preview';

export interface HookPaths {
	/** ~/.claude/settings.json */
	settingsFile: string;
	/** ~/.session-radar/hooks/session-radar-hook.js */
	installedScript: string;
	/** ~/.session-radar/backups */
	backupDir: string;
	/** Bundled script inside the extension */
	bundledScript: string;
}

/** Read-only virtual documents for the diff preview. */
class PreviewProvider implements vscode.TextDocumentContentProvider {
	private readonly docs = new Map<string, string>();
	private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this.emitter.event;
	set(name: string, content: string): vscode.Uri {
		const uri = vscode.Uri.from({ scheme: PREVIEW_SCHEME, path: `/${name}`, query: String(Date.now()) });
		this.docs.set(uri.toString(), content);
		return uri;
	}
	provideTextDocumentContent(uri: vscode.Uri): string {
		return this.docs.get(uri.toString()) ?? '';
	}
}

async function readIfExists(file: string): Promise<string | undefined> {
	try {
		return await fs.readFile(file, 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return undefined;
		}
		throw err;
	}
}

function parseSettings(text: string | undefined): unknown {
	if (text === undefined || !text.trim()) {
		return {};
	}
	try {
		return JSON.parse(text);
	} catch {
		throw new Error('~/.claude/settings.json is not valid JSON. Please check it manually first — nothing was changed.');
	}
}

function timestamp(): string {
	return new Date().toISOString().replace(/[:.]/g, '-');
}

function nodeAvailable(): Promise<boolean> {
	return new Promise(resolve => execFile('node', ['--version'], { timeout: 5000, windowsHide: true }, err => resolve(!err)));
}

export async function hooksInstalled(paths: HookPaths): Promise<boolean> {
	try {
		return installedEvents(parseSettings(await readIfExists(paths.settingsFile))).length > 0;
	} catch {
		return false;
	}
}

/** Keep the installed hook script in sync with the bundled one (our own folder only). */
export async function syncInstalledScript(paths: HookPaths): Promise<void> {
	const bundled = await fs.readFile(paths.bundledScript, 'utf8');
	const installed = await readIfExists(paths.installedScript);
	if (installed !== undefined && installed !== bundled) {
		await writeFileAtomic(paths.installedScript, bundled);
	}
}

export function registerHookCommands(context: vscode.ExtensionContext, paths: HookPaths, onChanged: () => void): void {
	const preview = new PreviewProvider();
	context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, preview));

	const updateContext = async () => {
		await vscode.commands.executeCommand('setContext', 'sessionRadar.hooksInstalled', await hooksInstalled(paths));
		onChanged();
	};
	void updateContext();

	/** Shared flow: show diff, confirm, back up, verify unchanged, write. */
	const applyChange = async (original: string | undefined, nextText: string, title: string, question: string, confirmLabel: string) => {
		const left = original === undefined ? preview.set('settings.json (new)', '') : vscode.Uri.file(paths.settingsFile);
		const right = preview.set('settings.json (preview)', nextText);
		await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
		const ok = await vscode.window.showWarningMessage(question, { modal: true }, confirmLabel);
		if (ok !== confirmLabel) {
			return undefined;
		}
		// Abort if Claude Code or the user changed the file while the diff was open.
		if (await readIfExists(paths.settingsFile) !== original) {
			throw new Error('settings.json was changed in the meantime. Please run the command again — nothing was written.');
		}
		let backup: string | undefined;
		if (original !== undefined) {
			await fs.mkdir(paths.backupDir, { recursive: true });
			backup = path.join(paths.backupDir, `claude-settings.${timestamp()}.json`);
			await fs.writeFile(backup, original, 'utf8');
		}
		await fs.mkdir(path.dirname(paths.settingsFile), { recursive: true });
		await writeFileAtomic(paths.settingsFile, nextText);
		return { backup };
	};

	const run = (fn: () => Promise<void>) => async () => {
		try {
			await fn();
		} catch (err) {
			void vscode.window.showErrorMessage(`Session Radar: ${(err as Error).message}`);
		}
	};

	context.subscriptions.push(vscode.commands.registerCommand('sessionRadar.installHooks', run(async () => {
		const original = await readIfExists(paths.settingsFile);
		const plan = planInstall(parseSettings(original), hookCommand(paths.installedScript));

		// The script itself lives in our own folder and is always (re)copied.
		await fs.mkdir(path.dirname(paths.installedScript), { recursive: true });
		await fs.copyFile(paths.bundledScript, paths.installedScript);

		if (plan.added.length === 0 && plan.updated.length === 0) {
			void vscode.window.showInformationMessage('Session Radar: The hooks are already installed.');
			await updateContext();
			return;
		}
		if (!await nodeAvailable()) {
			const go = await vscode.window.showWarningMessage(
				'"node" was not found in PATH. The hooks need Node.js. Install them anyway?', { modal: true }, 'Install Anyway');
			if (!go) {
				return;
			}
		}
		const events = [...plan.added, ...plan.updated].join(', ');
		const result = await applyChange(
			original,
			serializeLike(original, plan.next),
			'Claude settings.json: add Session Radar hooks',
			`Session Radar will add hooks for ${events} to ~/.claude/settings.json.\n\nExisting hooks are left untouched. A backup is created in ~/.session-radar/backups first. The change is shown in the open diff.`,
			'Install Hooks',
		);
		if (!result) {
			return;
		}
		await updateContext();
		const choice = await vscode.window.showInformationMessage(
			'Session Radar: Hooks installed. They take effect for newly started or resumed Claude Code sessions.',
			...(result.backup ? ['Show Backup'] : []));
		if (choice && result.backup) {
			await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(result.backup));
		}
	})));

	context.subscriptions.push(vscode.commands.registerCommand('sessionRadar.uninstallHooks', run(async () => {
		const original = await readIfExists(paths.settingsFile);
		const plan = planUninstall(parseSettings(original));
		if (plan.removed.length === 0) {
			void vscode.window.showInformationMessage(`Session Radar: No hooks using ${HOOK_SCRIPT_NAME} found.`);
			await updateContext();
			return;
		}
		const result = await applyChange(
			original,
			serializeLike(original, plan.next),
			'Claude settings.json: remove Session Radar hooks',
			`Session Radar will remove its hooks (${plan.removed.join(', ')}) from ~/.claude/settings.json.\n\nOther hooks are left untouched. A backup is created first.`,
			'Remove Hooks',
		);
		if (result) {
			await updateContext();
			void vscode.window.showInformationMessage('Session Radar: Hooks removed. Without hooks, Session Radar uses the process registry and transcripts.');
		}
	})));
}
