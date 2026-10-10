// Entry point. VS Code calls activate() once (see activationEvents in package.json);
// everything registered in context.subscriptions is disposed automatically on deactivate.

import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AnnotationStore } from './core/annotations';
import { radarHome, resolveClaudeDir, resolveCodexDir } from './core/paths';
import { SessionStore, StoreSettings } from './core/SessionStore';
import { pruneStatusDir } from './core/statusLayer';
import { debounce } from './core/util';
import { ClaudeCodeProvider } from './providers/claude/ClaudeCodeProvider';
import { HOOK_SCRIPT_NAME } from './providers/claude/hookConfig';
import { CodexProvider } from './providers/codex/CodexProvider';
import { registerCommands } from './ui/commands';
import { HookPaths, hooksInstalled, registerHookCommands, syncInstalledScript } from './ui/hookCommands';
import { Scope, SessionTreeProvider } from './ui/SessionTreeProvider';
import { VsCodeResumeHost, VsCodeWatchHost } from './ui/vscodeHosts';

/** Periodic refresh for time-based transitions ("X min ago", running → idle, idle → stale). */
const TICK_MS = 30_000;
const DEBOUNCE_MS = 400;
const DEBOUNCE_MAX_MS = 2_000;

function readSettings(): StoreSettings {
	const c = vscode.workspace.getConfiguration('sessionRadar');
	return {
		staleAfterMs: c.get<number>('staleAfterHours', 24) * 3600_000,
		runningTimeoutMs: c.get<number>('runningTimeoutMinutes', 30) * 60_000,
		transcriptRunningMs: 5 * 60_000,
		unreadAsWaiting: c.get<boolean>('unreadAsWaiting', true),
	};
}

export async function activate(context: vscode.ExtensionContext) {
	const config = vscode.workspace.getConfiguration('sessionRadar');
	const claudeDir = resolveClaudeDir(config.get<string>('claudeDir'));
	const maxAgeDays = config.get<number>('maxAgeDays', 30);

	// Our own status layer; must exist before we put watchers on it.
	const home = radarHome();
	const claudeStatusDir = path.join(home, 'status', 'claude-code');
	await fs.mkdir(claudeStatusDir, { recursive: true }).catch(() => undefined);
	void pruneStatusDir(claudeStatusDir, maxAgeDays * 24 * 3600_000);

	const providers = [
		new ClaudeCodeProvider({ claudeDir, maxAgeDays, hookStatusDir: claudeStatusDir }),
		new CodexProvider({ codexDir: resolveCodexDir() }),
	];
	const annotations = new AnnotationStore(path.join(home, 'annotations.json'));
	const store = new SessionStore(providers, annotations, readSettings);
	context.subscriptions.push(store);

	const tree = new SessionTreeProvider(store);
	tree.scope = context.workspaceState.get<Scope>('sessionRadar.scope', 'all');
	const view = vscode.window.createTreeView('sessionRadar.sessions', { treeDataProvider: tree, showCollapseAll: true });
	context.subscriptions.push(tree, view);

	const hookPaths: HookPaths = {
		settingsFile: path.join(claudeDir, 'settings.json'),
		installedScript: path.join(home, 'hooks', HOOK_SCRIPT_NAME),
		backupDir: path.join(home, 'backups'),
		bundledScript: context.asAbsolutePath(path.join('resources', 'hooks', HOOK_SCRIPT_NAME)),
	};
	let hooksActive = false;

	const updateView = () => {
		tree.refresh();
		const waiting = tree.visibleSessions().filter(s => s.status === 'waiting').length;
		view.badge = waiting > 0 ? { value: waiting, tooltip: `${waiting} session(s) waiting for you` } : undefined;
		view.message = tree.scope === 'workspace' ? 'Filter: current workspace only' : undefined;
		// Part of the title: a view description is not rendered when the view is alone in its container.
		view.title = hooksActive ? 'Sessions' : 'Sessions (no hooks)';
	};
	context.subscriptions.push(store.onDidChange(updateView));
	void vscode.commands.executeCommand('setContext', 'sessionRadar.scope', tree.scope);

	registerCommands(context, { store, tree, view, host: new VsCodeResumeHost(), updateView });
	registerHookCommands(context, hookPaths, async () => {
		hooksActive = await hooksInstalled(hookPaths);
		updateView();
	});
	void syncInstalledScript(hookPaths).catch(() => undefined);

	// Settings changes that only affect status derivation → recompute; others need a reload.
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('sessionRadar.claudeDir') || e.affectsConfiguration('sessionRadar.maxAgeDays')) {
			void vscode.window.showInformationMessage('Agent Session Radar: Reload the window for the change to take effect.', 'Reload Window')
				.then(choice => choice && vscode.commands.executeCommand('workbench.action.reloadWindow'));
		} else if (e.affectsConfiguration('sessionRadar')) {
			store.recompute();
		}
	}));

	// File watchers (no polling for content changes); bursts are debounced.
	const scheduleRefresh = debounce(() => void store.refresh(), DEBOUNCE_MS, DEBOUNCE_MAX_MS);
	context.subscriptions.push({ dispose: () => scheduleRefresh.cancel() });
	const watchHost = new VsCodeWatchHost();
	for (const provider of providers) {
		context.subscriptions.push(provider.watch(watchHost, scheduleRefresh));
	}
	context.subscriptions.push(watchHost.watch(home, 'annotations.json', scheduleRefresh));

	// A timer is still needed for what no file event signals: process death (crash) and
	// time-based transitions. Thanks to the size/mtime cache a tick costs only a few stat calls.
	const timer = setInterval(() => void store.refresh(), TICK_MS);
	context.subscriptions.push({ dispose: () => clearInterval(timer) });

	await annotations.load();
	await annotations.ensureSeenBaseline(Date.now()).catch(() => undefined);
	await store.refresh();
}

export function deactivate() {
	// everything is disposed via context.subscriptions
}
