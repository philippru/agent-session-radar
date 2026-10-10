import { promises as fs } from 'fs';
import * as vscode from 'vscode';
import { AgentSession, sessionKey } from '../core/model';
import { ResumeHost } from '../core/provider';
import { SessionStore } from '../core/SessionStore';
import { Scope, SessionTreeProvider } from './SessionTreeProvider';

const TRANSCRIPT_SCHEME = 'session-radar-transcript';

export interface CommandDeps {
	store: SessionStore;
	tree: SessionTreeProvider;
	view: vscode.TreeView<unknown>;
	host: ResumeHost;
	updateView: () => void;
}

/**
 * Read-only view of a transcript. Content providers cannot save, so the transcript can
 * never be modified from here, even by accident.
 */
class TranscriptContentProvider implements vscode.TextDocumentContentProvider {
	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		if (!uri.fsPath.endsWith('.jsonl')) {
			throw new Error('Only transcripts (*.jsonl) can be shown.');
		}
		return fs.readFile(uri.fsPath, 'utf8');
	}
}

export function registerCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
	const { store, tree, host } = deps;
	const reg = (id: string, fn: (...args: never[]) => unknown) =>
		context.subscriptions.push(vscode.commands.registerCommand(id, async (...args: never[]) => {
			try {
				await fn(...args);
			} catch (err) {
				void vscode.window.showErrorMessage(`Agent Session Radar: ${(err as Error).message}`);
			}
		}));
	context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(TRANSCRIPT_SCHEME, new TranscriptContentProvider()));

	const setScope = async (scope: Scope) => {
		tree.scope = scope;
		await context.workspaceState.update('sessionRadar.scope', scope);
		await vscode.commands.executeCommand('setContext', 'sessionRadar.scope', scope);
		deps.updateView();
	};
	const setShowArchived = async (show: boolean) => {
		tree.showArchived = show;
		await vscode.commands.executeCommand('setContext', 'sessionRadar.showArchived', show);
		deps.updateView();
	};
	const annotate = async (s: AgentSession, patch: Parameters<SessionStore['annotations']['update']>[1]) => {
		await store.annotations.update(sessionKey(s), patch);
		store.recompute();
	};

	reg('sessionRadar.refresh', () => store.refresh());
	reg('sessionRadar.scopeWorkspace', () => setScope('workspace'));
	reg('sessionRadar.scopeAll', () => setScope('all'));
	reg('sessionRadar.showArchived', () => setShowArchived(true));
	reg('sessionRadar.hideArchived', () => setShowArchived(false));

	reg('sessionRadar.open', async (s: AgentSession) => {
		if (!s) {
			return;
		}
		await markSeen(store, [s]);
		await store.provider(s.agent)?.resume(s, host);
	});

	reg('sessionRadar.resumeInTerminal', async (s: AgentSession) => {
		const provider = store.provider(s.agent);
		await markSeen(store, [s]);
		await (provider?.resumeInTerminal ? provider.resumeInTerminal(s, host) : provider?.resume(s, host));
	});

	reg('sessionRadar.rename', async (s: AgentSession) => {
		const value = await vscode.window.showInputBox({
			title: 'Rename session (locally in Agent Session Radar only)',
			value: s.label ?? s.title,
			prompt: `Original title: ${s.title}. Leave empty to remove the local label.`,
		});
		if (value !== undefined) {
			await annotate(s, { label: value.trim() && value.trim() !== s.title ? value.trim() : undefined });
		}
	});

	reg('sessionRadar.archive', (s: AgentSession) => annotate(s, { archived: true }));
	reg('sessionRadar.unarchive', (s: AgentSession) => annotate(s, { archived: undefined }));
	reg('sessionRadar.markSeen', (s: AgentSession) => markSeen(store, [s]));
	reg('sessionRadar.markAllSeen', () => markSeen(store, tree.visibleSessions().filter(s => s.status === 'waiting' && s.waitingReason === 'unread')));

	reg('sessionRadar.showTranscript', async (s: AgentSession) => {
		if (!s.transcriptPath) {
			return;
		}
		const uri = vscode.Uri.file(s.transcriptPath).with({ scheme: TRANSCRIPT_SCHEME });
		const doc = await vscode.workspace.openTextDocument(uri);
		await vscode.languages.setTextDocumentLanguage(doc, 'jsonl').then(undefined, () => undefined);
		await vscode.window.showTextDocument(doc, { preview: true });
	});

	reg('sessionRadar.revealTranscript', async (s: AgentSession) => {
		if (s.transcriptPath) {
			await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(s.transcriptPath));
		}
	});

	reg('sessionRadar.copySessionId', async (s: AgentSession) => {
		await vscode.env.clipboard.writeText(s.id);
		vscode.window.setStatusBarMessage('Session ID copied', 2000);
	});
}

/** Record that the user looked at these sessions (clears "unread"). */
export async function markSeen(store: SessionStore, sessions: AgentSession[]): Promise<void> {
	if (sessions.length === 0) {
		return;
	}
	await store.annotations.updateMany(sessions.map(sessionKey), { lastSeenAt: Date.now() });
	store.recompute();
}
