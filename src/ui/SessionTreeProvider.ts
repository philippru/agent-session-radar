import * as vscode from 'vscode';
import { AgentSession, SessionStatus, sessionKey } from '../core/model';
import { SessionStore } from '../core/SessionStore';
import { compareByActivity } from '../core/status';
import { formatRelative, isPathInside } from '../core/util';

export type Scope = 'all' | 'workspace';

interface GroupDef { status: SessionStatus; label: string; expanded: boolean }

const GROUPS: GroupDef[] = [
	{ status: 'running', label: '🟢 Läuft', expanded: true },
	{ status: 'waiting', label: '🟡 Wartet auf mich', expanded: true },
	{ status: 'idle', label: '⚪ Idle / fertig', expanded: true },
	{ status: 'stale', label: '💤 Alt', expanded: false },
];

const WAITING_LABEL: Record<string, string> = {
	permission: '🔐 Freigabe nötig',
	input: '❓ Eingabe nötig',
	unread: '✉️ ungelesen',
};

const SURFACE_LABEL: Record<string, string> = {
	vscode: 'VS Code',
	cli: 'Terminal',
	desktop: 'Desktop-App',
	unknown: 'unbekannt',
};

const SOURCE_LABEL: Record<string, string> = {
	hook: 'Hooks',
	process: 'Prozessliste',
	transcript: 'Transkript',
};

export class GroupNode {
	constructor(readonly def: GroupDef, readonly sessions: AgentSession[]) { }
}

export type Node = GroupNode | AgentSession;

export class SessionTreeProvider implements vscode.TreeDataProvider<Node> {
	private readonly changeEmitter = new vscode.EventEmitter<Node | undefined | void>();
	readonly onDidChangeTreeData = this.changeEmitter.event;

	scope: Scope = 'all';
	showArchived = false;

	constructor(private readonly store: SessionStore) { }

	refresh(): void {
		this.changeEmitter.fire();
	}

	/** Sessions after scope/archive filtering. */
	visibleSessions(): AgentSession[] {
		const folders = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [];
		return this.store.getSessions().filter(s => {
			if (s.archived && !this.showArchived) {
				return false;
			}
			if (this.scope === 'workspace') {
				return folders.some(f => isPathInside(s.project, f));
			}
			return true;
		});
	}

	getChildren(element?: Node): Node[] {
		if (!element) {
			const visible = this.visibleSessions();
			return GROUPS
				.map(def => new GroupNode(def, visible.filter(s => s.status === def.status).sort(compareByActivity)))
				.filter(g => g.sessions.length > 0);
		}
		if (element instanceof GroupNode) {
			return element.sessions;
		}
		return [];
	}

	getTreeItem(element: Node): vscode.TreeItem {
		if (element instanceof GroupNode) {
			const item = new vscode.TreeItem(
				element.def.label,
				element.def.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
			);
			item.id = `group:${element.def.status}`;
			item.description = String(element.sessions.length);
			item.contextValue = `group.${element.def.status}`;
			return item;
		}
		return this.sessionItem(element);
	}

	private sessionItem(s: AgentSession): vscode.TreeItem {
		const now = Date.now();
		const item = new vscode.TreeItem(s.label ?? s.title, vscode.TreeItemCollapsibleState.None);
		item.id = sessionKey(s);
		const parts: string[] = [];
		if (s.status === 'waiting' && s.waitingReason) {
			parts.push(WAITING_LABEL[s.waitingReason]);
		}
		parts.push(s.projectName);
		if (s.branch) {
			parts.push(`⎇ ${s.branch}`);
		}
		parts.push(formatRelative(s.signals.lastActivity, now));
		item.description = parts.join(' · ');
		const provider = this.store.provider(s.agent);
		item.iconPath = new vscode.ThemeIcon(provider?.iconId ?? 'comment-discussion');
		item.tooltip = this.tooltip(s, provider?.displayName ?? s.agent, now);
		// Matched by `viewItem =~ /…/` in package.json menus.
		item.contextValue = `session;agent=${s.agent};status=${s.status};reason=${s.waitingReason ?? ''};archived=${s.archived ? 1 : 0};transcript=${s.transcriptPath ? 1 : 0}`;
		if (s.archived) {
			parts.unshift('🗄️ archiviert');
			item.description = parts.join(' · ');
		}
		item.command = { command: 'sessionRadar.open', title: 'Öffnen', arguments: [s] };
		return item;
	}

	private tooltip(s: AgentSession, agentName: string, now: number): vscode.MarkdownString {
		const md = new vscode.MarkdownString(undefined, true);
		const esc = (t: string) => t.replace(/([\\`*_{}[\]()#+\-.!|<>])/g, '\\$1');
		md.appendMarkdown(`**${esc(s.label ?? s.title)}**\n\n`);
		if (s.label) {
			md.appendMarkdown(`_Originaltitel:_ ${esc(s.title)}\n\n`);
		}
		const status = GROUPS.find(g => g.status === s.status)?.label ?? s.status;
		const waiting = s.status === 'waiting' && s.waitingReason ? ` (${WAITING_LABEL[s.waitingReason]})` : '';
		const rows: [string, string][] = [
			['Status', `${status}${waiting} — Quelle: ${SOURCE_LABEL[s.statusSource]}`],
			['Agent', `${agentName}${s.agentVersion ? ' ' + s.agentVersion : ''} · ${SURFACE_LABEL[s.surface]}`],
			['Projekt', s.project],
			['Branch', s.branch ?? '–'],
			['Zuletzt aktiv', `${formatRelative(s.signals.lastActivity, now)} (${new Date(s.signals.lastActivity).toLocaleString()})`],
		];
		if (s.signals.process?.pid) {
			rows.push(['Prozess', `PID ${s.signals.process.pid} (${s.signals.process.alive ? 'läuft' : 'beendet'})`]);
		}
		rows.push(['Session-ID', s.id]);
		for (const [k, v] of rows) {
			md.appendMarkdown(`${k}: ${esc(v)}  \n`);
		}
		return md;
	}

	dispose(): void {
		this.changeEmitter.dispose();
	}
}
