// The provider abstraction. One provider per agent type (Claude Code, Codex, ...).
// Providers do not depend on the vscode API directly; UI actions go through ResumeHost,
// file watching through WatchHost. This keeps providers testable and reusable.

import { AgentKind, AgentSession } from './model';
import { DerivedStatus, StatusContext, deriveStatus } from './status';

export interface Disposable {
	dispose(): void;
}

/** File-watching service provided by the host (VS Code FileSystemWatcher in the extension). */
export interface WatchHost {
	/**
	 * Watch files matching `glob` below `baseDir` (absolute). The listener gets the changed path.
	 * Hosts may batch events; providers should be prepared for bursts.
	 */
	watch(baseDir: string, glob: string, listener: (changedPath: string) => void): Disposable;
}

/** UI operations a provider can use to resume or focus a session. */
export interface ResumeHost {
	/** URI scheme of the running editor, e.g. "vscode" or "vscode-insiders". */
	readonly uriScheme: string;
	/** Is an extension with this id installed? */
	hasExtension(id: string): boolean;
	/** Is `dir` inside one of the folders open in the current window? */
	isInCurrentWorkspace(dir: string): boolean;
	/** Open a URI with the OS / VS Code URI handler (e.g. vscode://publisher.ext/...). */
	openUri(uri: string): Promise<boolean>;
	/** Run a command in a new integrated terminal. */
	runInTerminal(options: { name: string; cwd?: string; command: string }): void;
	/** Try to show an existing integrated terminal whose process tree contains `pid`. */
	focusTerminalOfPid(pid: number): Promise<boolean>;
	/** Open a folder (focuses the window if the folder is already open elsewhere). */
	openFolder(dir: string): Promise<void>;
	/** Ask the user to pick one of several actions. Returns the chosen id or undefined. */
	pick(title: string, items: { id: string; label: string; detail?: string }[]): Promise<string | undefined>;
	/** Modal warning with a confirm button. */
	confirm(message: string, confirmLabel: string): Promise<boolean>;
	info(message: string): void;
}

export interface SessionProvider extends Disposable {
	readonly agent: AgentKind;
	/** Human readable name, e.g. "Claude Code". */
	readonly displayName: string;
	/** Codicon id used as the agent icon in the tree, e.g. "sparkle". */
	readonly iconId: string;

	/** True if the agent's data directory exists on this machine. */
	isAvailable(): Promise<boolean>;

	/**
	 * Find all sessions. Implementations should cache (e.g. by file size/mtime) so repeated
	 * calls are cheap. Returned sessions carry raw `signals`; `status` is filled in by getStatus().
	 */
	discover(): Promise<AgentSession[]>;

	/** Start watching the agent's data; call `onChange` whenever sessions may have changed. */
	watch(host: WatchHost, onChange: () => void): Disposable;

	/** Derive the status of a session. Providers may override the default derivation. */
	getStatus(session: AgentSession, ctx: StatusContext): DerivedStatus;

	/** Resume or focus the session (click in the tree). */
	resume(session: AgentSession, host: ResumeHost): Promise<void>;

	/** Optional: explicitly resume in a new terminal (context menu). Defaults to resume(). */
	resumeInTerminal?(session: AgentSession, host: ResumeHost): Promise<void>;
}

/** Base class with the default status derivation. */
export abstract class BaseSessionProvider implements SessionProvider {
	abstract readonly agent: AgentKind;
	abstract readonly displayName: string;
	abstract readonly iconId: string;
	abstract isAvailable(): Promise<boolean>;
	abstract discover(): Promise<AgentSession[]>;
	abstract watch(host: WatchHost, onChange: () => void): Disposable;
	abstract resume(session: AgentSession, host: ResumeHost): Promise<void>;

	getStatus(session: AgentSession, ctx: StatusContext): DerivedStatus {
		return deriveStatus(session.signals, ctx);
	}

	dispose(): void {
		// nothing by default
	}
}
