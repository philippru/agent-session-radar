import * as vscode from 'vscode';
import { AgentSession, sessionKey } from '../core/model';
import { ResumeHost } from '../core/provider';
import { SessionStore } from '../core/SessionStore';
import { Scope, SessionTreeProvider } from './SessionTreeProvider';

export interface CommandDeps {
	store: SessionStore;
	tree: SessionTreeProvider;
	view: vscode.TreeView<unknown>;
	host: ResumeHost;
	updateView: () => void;
}

export function registerCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
	const { store, tree } = deps;
	const reg = (id: string, fn: (...args: never[]) => unknown) =>
		context.subscriptions.push(vscode.commands.registerCommand(id, fn));

	const setScope = async (scope: Scope) => {
		tree.scope = scope;
		await context.workspaceState.update('sessionRadar.scope', scope);
		await vscode.commands.executeCommand('setContext', 'sessionRadar.scope', scope);
		deps.updateView();
	};

	reg('sessionRadar.refresh', () => store.refresh());
	reg('sessionRadar.scopeWorkspace', () => setScope('workspace'));
	reg('sessionRadar.scopeAll', () => setScope('all'));

	reg('sessionRadar.open', async (session: AgentSession) => {
		if (!session) {
			return;
		}
		await markSeen(store, [session]);
	});
}

/** Record that the user looked at these sessions (clears "unread"). */
export async function markSeen(store: SessionStore, sessions: AgentSession[]): Promise<void> {
	await store.annotations.updateMany(sessions.map(sessionKey), { lastSeenAt: Date.now() });
	store.recompute();
}
