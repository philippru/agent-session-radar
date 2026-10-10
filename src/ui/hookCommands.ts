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
		throw new Error('~/.claude/settings.json ist kein gültiges JSON. Bitte zuerst manuell prüfen — es wurde nichts geändert.');
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
		const left = original === undefined ? preview.set('settings.json (neu)', '') : vscode.Uri.file(paths.settingsFile);
		const right = preview.set('settings.json (Vorschau)', nextText);
		await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
		const ok = await vscode.window.showWarningMessage(question, { modal: true }, confirmLabel);
		if (ok !== confirmLabel) {
			return undefined;
		}
		// Abort if Claude Code or the user changed the file while the diff was open.
		if (await readIfExists(paths.settingsFile) !== original) {
			throw new Error('settings.json wurde in der Zwischenzeit geändert. Bitte erneut ausführen — es wurde nichts geschrieben.');
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
			void vscode.window.showInformationMessage('Session Radar: Die Hooks sind bereits eingetragen.');
			await updateContext();
			return;
		}
		if (!await nodeAvailable()) {
			const go = await vscode.window.showWarningMessage(
				'"node" wurde im PATH nicht gefunden. Die Hooks brauchen Node.js. Trotzdem eintragen?', { modal: true }, 'Trotzdem eintragen');
			if (!go) {
				return;
			}
		}
		const events = [...plan.added, ...plan.updated].join(', ');
		const result = await applyChange(
			original,
			serializeLike(original, plan.next),
			'Claude settings.json: Session-Radar-Hooks hinzufügen',
			`Session Radar trägt Hooks für ${events} in ~/.claude/settings.json ein.\n\nBestehende Hooks bleiben unverändert. Vorher wird ein Backup in ~/.session-radar/backups angelegt. Die Änderung siehst du im geöffneten Diff.`,
			'Hooks installieren',
		);
		if (!result) {
			return;
		}
		await updateContext();
		const choice = await vscode.window.showInformationMessage(
			'Session Radar: Hooks installiert. Sie wirken für neu gestartete bzw. fortgesetzte Claude-Code-Sessions.',
			...(result.backup ? ['Backup anzeigen'] : []));
		if (choice && result.backup) {
			await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(result.backup));
		}
	})));

	context.subscriptions.push(vscode.commands.registerCommand('sessionRadar.uninstallHooks', run(async () => {
		const original = await readIfExists(paths.settingsFile);
		const plan = planUninstall(parseSettings(original));
		if (plan.removed.length === 0) {
			void vscode.window.showInformationMessage(`Session Radar: Keine Hooks mit ${HOOK_SCRIPT_NAME} gefunden.`);
			await updateContext();
			return;
		}
		const result = await applyChange(
			original,
			serializeLike(original, plan.next),
			'Claude settings.json: Session-Radar-Hooks entfernen',
			`Session Radar entfernt seine Hooks (${plan.removed.join(', ')}) aus ~/.claude/settings.json.\n\nAndere Hooks bleiben unverändert. Vorher wird ein Backup angelegt.`,
			'Hooks entfernen',
		);
		if (result) {
			await updateContext();
			void vscode.window.showInformationMessage('Session Radar: Hooks entfernt. Ohne Hooks nutzt Session Radar Prozessliste und Transkripte.');
		}
	})));
}
