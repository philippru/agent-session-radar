// Aggregates all providers, merges user annotations and derives the status.
// No vscode dependency: the extension wires it to the tree view.

import { AnnotationStore } from './annotations';
import { AgentKind, AgentSession, sessionKey } from './model';
import { Disposable, SessionProvider } from './provider';
import { DEFAULT_STATUS_CONTEXT, StatusContext } from './status';

export type StoreSettings = Omit<StatusContext, 'now' | 'lastSeenAt' | 'seenBaseline'>;

export class SessionStore implements Disposable {
	private sessions: AgentSession[] = [];
	private readonly listeners = new Set<() => void>();
	private refreshing: Promise<void> | undefined;
	private refreshAgain = false;
	private lastError: unknown;

	constructor(
		readonly providers: SessionProvider[],
		readonly annotations: AnnotationStore,
		private readonly settings: () => StoreSettings = () => DEFAULT_STATUS_CONTEXT,
	) { }

	getSessions(): readonly AgentSession[] {
		return this.sessions;
	}

	get error(): unknown {
		return this.lastError;
	}

	provider(agent: AgentKind): SessionProvider | undefined {
		return this.providers.find(p => p.agent === agent);
	}

	onDidChange(listener: () => void): Disposable {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	/**
	 * Re-discover sessions from all providers. Concurrent calls are coalesced:
	 * if a refresh is running, exactly one more runs after it.
	 */
	refresh(): Promise<void> {
		if (this.refreshing) {
			this.refreshAgain = true;
			return this.refreshing;
		}
		this.refreshing = (async () => {
			try {
				do {
					this.refreshAgain = false;
					await this.doRefresh();
				} while (this.refreshAgain);
			} finally {
				this.refreshing = undefined;
			}
		})();
		return this.refreshing;
	}

	/** Re-derive status (time-based transitions, changed annotations) without disk IO for sessions. */
	recompute(): void {
		this.applyStatus(this.sessions);
		this.emit();
	}

	private async doRefresh(): Promise<void> {
		const all: AgentSession[] = [];
		this.lastError = undefined;
		for (const provider of this.providers) {
			try {
				if (await provider.isAvailable()) {
					all.push(...await provider.discover());
				}
			} catch (err) {
				this.lastError = err;
			}
		}
		await this.annotations.load();
		this.applyStatus(all);
		this.sessions = all;
		this.emit();
	}

	private applyStatus(sessions: AgentSession[]): void {
		const now = Date.now();
		const base = this.settings();
		for (const s of sessions) {
			const a = this.annotations.get(sessionKey(s));
			s.label = a.label;
			s.archived = a.archived;
			const ctx: StatusContext = { ...base, now, lastSeenAt: a.lastSeenAt, seenBaseline: this.annotations.seenBaseline };
			const provider = this.provider(s.agent);
			const derived = provider ? provider.getStatus(s, ctx) : undefined;
			if (derived) {
				s.status = derived.status;
				s.statusSource = derived.source;
				s.waitingReason = derived.waitingReason;
			}
		}
	}

	private emit(): void {
		for (const l of this.listeners) {
			l();
		}
	}

	dispose(): void {
		this.listeners.clear();
		for (const p of this.providers) {
			p.dispose();
		}
	}
}
