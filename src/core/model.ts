// Shared, agent-independent data model. No dependency on the vscode API,
// so it can be used by unit tests and (later) by other front-ends.

/** Identifier of an agent type. Extend this union when adding a provider. */
export type AgentKind = 'claude-code' | 'codex';

/** The four buckets shown in the tree. */
export type SessionStatus = 'running' | 'waiting' | 'idle' | 'stale';

/** Why a session is waiting for the user. */
export type WaitingReason =
	| 'permission' // tool permission prompt is open
	| 'input'      // agent asks for input (MCP elicitation, background agent needs input)
	| 'unread';    // turn finished, user has not looked at it yet

/** Where the session was started. */
export type SessionSurface = 'vscode' | 'cli' | 'desktop' | 'unknown';

/** Which data source determined the status (highest-priority source that had data). */
export type StatusSource = 'hook' | 'process' | 'transcript';

/**
 * Raw signals a provider collects for a session. Status is derived from these by
 * deriveStatus() (see status.ts), so the derivation can be unit tested in isolation.
 */
export interface StatusSignals {
	/** Last activity in the transcript (ms since epoch). Always present. */
	lastActivity: number;
	/** When the agent last finished a turn (ms), if known. */
	turnEndedAt?: number;
	/** True if the transcript shows a turn in progress (last entry is a prompt or tool call). */
	turnInProgress?: boolean;

	/** Live process information, if a process registry is available. */
	process?: {
		alive: boolean;
		/** Agent-reported state, e.g. 'busy' | 'idle' for Claude Code. Unknown values are kept. */
		state?: string;
		/** When the process last reported its state (ms). */
		stateSince?: number;
		pid?: number;
	};

	/** State reported by hooks via the ~/.session-radar status layer, if installed. */
	hook?: {
		state: 'running' | 'waiting' | 'idle' | 'ended';
		waitingReason?: 'permission' | 'input';
		/** When the hook wrote this state (ms). */
		updatedAt: number;
		turnEndedAt?: number;
	};
}

export interface AgentSession {
	/** Agent-specific session id (for Claude Code: the session UUID). */
	id: string;
	agent: AgentKind;
	/** Best available title: user rename > agent title > first prompt. */
	title: string;
	/** Absolute path of the working directory the session runs in. */
	project: string;
	/** Short display name of the project (last path segment). */
	projectName: string;
	branch?: string;
	surface: SessionSurface;
	/** Absolute path of the transcript file, if the agent has one. */
	transcriptPath?: string;
	/** Version of the agent that wrote the session, if known. */
	agentVersion?: string;

	signals: StatusSignals;

	// Filled in by the store (status derivation + user annotations):
	status: SessionStatus;
	statusSource: StatusSource;
	waitingReason?: WaitingReason;
	/** Local label set by the user (overrides title in the UI). */
	label?: string;
	archived?: boolean;
}

/** Globally unique key of a session across all providers. */
export function sessionKey(s: { agent: AgentKind; id: string }): string {
	return `${s.agent}:${s.id}`;
}

/** Last segment of a Windows or POSIX path. */
export function baseName(p: string): string {
	const parts = p.split(/[\\/]+/).filter(Boolean);
	return parts.length ? parts[parts.length - 1] : p;
}
