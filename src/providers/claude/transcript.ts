// Parser for Claude Code transcripts (~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl).
//
// NOTE: The entry format is internal to Claude Code and not officially documented; it can
// change with any release. Everything here is defensive: unknown entries are ignored,
// missing fields are tolerated, and parse errors never throw.
//
// Observed entry types (Claude Code 2.1.2xx): user, assistant, attachment, system,
// ai-title {aiTitle}, custom-title {customTitle}, last-prompt {lastPrompt}, queue-operation,
// bridge-session, file-history-*, cost-state, mode, atis-latch.
// user/assistant/system/attachment carry: timestamp (ISO), cwd, gitBranch, entrypoint, version.

import { readHeadLines, readTailLines, tryParseJson } from '../../core/fileChunks';

export interface TranscriptInfo {
	sessionId?: string;
	cwd?: string;
	gitBranch?: string;
	entrypoint?: string;
	version?: string;
	customTitle?: string;
	aiTitle?: string;
	firstPrompt?: string;
	/** Timestamp of the newest entry that has one (ms). */
	lastTimestamp?: number;
	/** Timestamp of the last finished assistant turn (ms), if the tail ends with one. */
	turnEndedAt?: number;
	/** True if the last conversational entry is a prompt or tool call (turn not finished). */
	turnInProgress?: boolean;
}

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 128 * 1024;
const TAIL_BYTES_MAX = 1024 * 1024;
const TITLE_MAX = 120;

type Entry = Record<string, unknown>;

function str(v: unknown): string | undefined {
	return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function ts(v: unknown): number | undefined {
	if (typeof v !== 'string') {
		return undefined;
	}
	const t = Date.parse(v);
	return Number.isNaN(t) ? undefined : t;
}

/** Collapse whitespace and cut to a single short line. */
export function oneLine(text: string, max = TITLE_MAX): string {
	const s = text.replace(/\s+/g, ' ').trim();
	return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * Extract a human prompt from a user entry. Skips meta entries, tool results and
 * IDE/system context blocks (text that starts with an XML-like tag such as <ide_opened_file>).
 */
export function extractPromptText(entry: Entry): string | undefined {
	if (entry.type !== 'user' || entry.isMeta === true || entry.toolUseResult !== undefined || entry.isSidechain === true) {
		return undefined;
	}
	const message = entry.message as Entry | undefined;
	const content = message?.content;
	const texts: string[] = [];
	if (typeof content === 'string') {
		texts.push(content);
	} else if (Array.isArray(content)) {
		for (const block of content) {
			if (block && typeof block === 'object' && (block as Entry).type === 'text' && typeof (block as Entry).text === 'string') {
				texts.push((block as Entry).text as string);
			}
		}
	}
	const plain = texts.find(t => !t.trimStart().startsWith('<'));
	if (plain && plain.trim()) {
		return oneLine(plain);
	}
	// Only tagged blocks: strip tags (e.g. pasted content) and use what remains.
	for (const t of texts) {
		if (/^\s*<(system-reminder|ide_|command-|local-command)/.test(t)) {
			continue;
		}
		const stripped = t.replace(/<[^>]+>/g, ' ').trim();
		if (stripped) {
			return oneLine(stripped);
		}
	}
	return undefined;
}

/** Apply one parsed entry to the info object. `fromTail` entries overwrite head values. */
function applyEntry(info: TranscriptInfo, e: Entry, fromTail: boolean): void {
	const set = <K extends keyof TranscriptInfo>(key: K, value: TranscriptInfo[K] | undefined) => {
		if (value !== undefined && (fromTail || info[key] === undefined)) {
			info[key] = value;
		}
	};
	set('sessionId', str(e.sessionId));
	// The project is where the session was started (first cwd), even if the agent cd'ed later.
	if (info.cwd === undefined) {
		info.cwd = str(e.cwd);
	}
	set('gitBranch', str(e.gitBranch));
	set('entrypoint', str(e.entrypoint));
	set('version', str(e.version));
	if (e.type === 'ai-title') {
		set('aiTitle', str(e.aiTitle));
	} else if (e.type === 'custom-title') {
		set('customTitle', str(e.customTitle));
	}
	const t = ts(e.timestamp);
	if (t !== undefined && (info.lastTimestamp === undefined || t > info.lastTimestamp)) {
		info.lastTimestamp = t;
	}
}

/** Turn state from the last conversational (user/assistant, non-sidechain) entry. */
function applyTurnState(info: TranscriptInfo, entries: Entry[]): void {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if ((e.type !== 'user' && e.type !== 'assistant') || e.isSidechain === true) {
			continue;
		}
		if (e.type === 'assistant') {
			const stop = (e.message as Entry | undefined)?.stop_reason;
			if (stop === 'end_turn' || stop === 'stop_sequence' || e.isApiErrorMessage === true) {
				info.turnInProgress = false;
				info.turnEndedAt = ts(e.timestamp);
			} else {
				info.turnInProgress = true;
			}
		} else {
			// A user entry last: prompt submitted or tool result delivered → turn in progress.
			// Exception: interrupts are recorded as a user text "[Request interrupted by user...]".
			const text = JSON.stringify((e.message as Entry | undefined)?.content ?? '');
			info.turnInProgress = !text.includes('[Request interrupted by user');
			if (!info.turnInProgress) {
				info.turnEndedAt = ts(e.timestamp);
			}
		}
		return;
	}
}

/** Parse head and tail of a transcript file. Never throws for malformed content. */
export async function parseTranscript(filePath: string): Promise<TranscriptInfo> {
	const info: TranscriptInfo = {};

	const head = await readHeadLines(filePath, HEAD_BYTES);
	for (const line of head) {
		const e = tryParseJson(line) as Entry | undefined;
		if (!e || typeof e !== 'object') {
			continue;
		}
		applyEntry(info, e, false);
		if (info.firstPrompt === undefined) {
			info.firstPrompt = extractPromptText(e);
		}
	}

	// Tail: grow the window until we have a timestamp and a title (bounded).
	let bytes = TAIL_BYTES;
	for (;;) {
		const { lines, reachedStart } = await readTailLines(filePath, bytes);
		const entries = lines.map(l => tryParseJson(l)).filter((e): e is Entry => !!e && typeof e === 'object');
		const tailInfo: TranscriptInfo = {};
		for (const e of entries) {
			applyEntry(tailInfo, e, true);
		}
		applyTurnState(tailInfo, entries);
		const complete = tailInfo.lastTimestamp !== undefined && (tailInfo.aiTitle !== undefined || tailInfo.customTitle !== undefined);
		if (complete || reachedStart || bytes >= TAIL_BYTES_MAX) {
			for (const [k, v] of Object.entries(tailInfo)) {
				if (v !== undefined && !(k === 'cwd' && info.cwd !== undefined)) {
					(info as Record<string, unknown>)[k] = v;
				}
			}
			break;
		}
		bytes *= 4;
	}

	return info;
}

/** Title precedence: user rename > AI title > first prompt > fallback. */
export function pickTitle(info: TranscriptInfo, fallback: string): string {
	return oneLine(info.customTitle ?? info.aiTitle ?? info.firstPrompt ?? fallback);
}

/** Map Claude Code's `entrypoint` to a surface. */
export function surfaceFromEntrypoint(entrypoint: string | undefined): 'vscode' | 'cli' | 'desktop' | 'unknown' {
	if (!entrypoint) {
		return 'unknown';
	}
	if (/vscode|ide/i.test(entrypoint)) {
		return 'vscode';
	}
	if (/desktop/i.test(entrypoint)) {
		return 'desktop';
	}
	if (/cli|terminal|sdk/i.test(entrypoint)) {
		return 'cli';
	}
	return 'unknown';
}
