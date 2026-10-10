#!/usr/bin/env node
// Session Radar hook for Claude Code.
//
// Installed by the Session Radar VS Code extension into ~/.session-radar/hooks/ and registered
// in ~/.claude/settings.json for the events SessionStart, UserPromptSubmit, Notification, Stop
// and SessionEnd. Claude Code passes the event as JSON on stdin; this script writes one small
// status file per session:
//
//     ~/.session-radar/status/claude-code/<session_id>.json      (format: docs/status-format.md)
//
// Design rules:
// - Never print anything and always exit 0, so the hook can never influence Claude Code.
// - Never store prompt or message contents (only state, timestamps, paths).
// - No dependencies, no network. Atomic writes (temp file + rename).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SCHEMA_VERSION = 1;
const AGENT = 'claude-code';
const WRITER = 'session-radar-hook/1';
const SESSION_ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

function radarHome(env) {
	return env.SESSION_RADAR_HOME || path.join(os.homedir(), '.session-radar');
}

/**
 * Map a hook event to a patch for the status file. `null` values delete a field.
 * Returns undefined for events that do not change the status.
 */
function statusPatch(input, nowIso) {
	const event = input && input.hook_event_name;
	switch (event) {
		case 'SessionStart':
			// New, resumed, cleared or compacted session: ready, nothing unread.
			return { state: 'idle', event, detail: str(input.source), waitingReason: null, turnEndedAt: null, startedAt: nowIso };
		case 'UserPromptSubmit':
			return { state: 'running', event, detail: null, waitingReason: null, turnEndedAt: null };
		case 'Stop':
			return { state: 'idle', event, detail: null, waitingReason: null, turnEndedAt: nowIso };
		case 'SessionEnd':
			return { state: 'ended', event, detail: str(input.reason), waitingReason: null };
		case 'Notification': {
			const reason = waitingReasonFor(input);
			return reason ? { state: 'waiting', event, detail: str(input.notification_type) || null, waitingReason: reason } : undefined;
		}
		default:
			return undefined;
	}
}

/** Which notifications mean "blocked, needs the user". idle_prompt etc. are ignored. */
function waitingReasonFor(input) {
	const type = str(input.notification_type);
	if (type === 'permission_prompt') {
		return 'permission';
	}
	if (type === 'elicitation_dialog' || type === 'elicitation_url_dialog' || type === 'agent_needs_input') {
		return 'input';
	}
	// Older Claude Code versions without notification_type
	if (!type && /permission/i.test(str(input.message) || '')) {
		return 'permission';
	}
	return undefined;
}

function str(v) {
	return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function readJson(file) {
	try {
		const data = JSON.parse(fs.readFileSync(file, 'utf8'));
		return data && typeof data === 'object' ? data : undefined;
	} catch {
		return undefined;
	}
}

function writeAtomic(file, content) {
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, content, 'utf8');
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			fs.renameSync(tmp, file);
			return;
		} catch (err) {
			if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
				break;
			}
			const until = Date.now() + 15 * (attempt + 1);
			while (Date.now() < until) { /* short busy wait, hooks must stay synchronous and quick */ }
		}
	}
	try {
		fs.writeFileSync(file, content, 'utf8');
	} finally {
		try { fs.unlinkSync(tmp); } catch { /* ignore */ }
	}
}

/** Apply one hook event. Returns the written file path, or undefined if nothing was written. */
function handleEvent(input, env, now) {
	if (!input || typeof input !== 'object') {
		return undefined;
	}
	const sessionId = str(input.session_id);
	if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
		return undefined;
	}
	const nowIso = new Date(now).toISOString();
	const patch = statusPatch(input, nowIso);
	if (!patch) {
		return undefined;
	}
	const dir = path.join(radarHome(env), 'status', AGENT);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${sessionId}.json`);
	const previous = readJson(file) || {};

	const next = Object.assign({}, previous, {
		schemaVersion: SCHEMA_VERSION,
		agent: AGENT,
		sessionId,
		cwd: str(input.cwd) || previous.cwd,
		transcriptPath: str(input.transcript_path) || previous.transcriptPath,
		updatedAt: nowIso,
		writer: WRITER,
	});
	for (const [key, value] of Object.entries(patch)) {
		if (value === null || value === undefined) {
			delete next[key];
		} else if (!(key === 'startedAt' && previous.startedAt && input.source !== 'startup')) {
			next[key] = value;
		}
	}
	writeAtomic(file, JSON.stringify(next, null, 2) + '\n');
	return file;
}

function readStdin(timeoutMs) {
	return new Promise(resolve => {
		const chunks = [];
		const timer = setTimeout(() => resolve(Buffer.concat(chunks).toString('utf8')), timeoutMs);
		process.stdin.on('data', c => chunks.push(c));
		process.stdin.on('end', () => {
			clearTimeout(timer);
			resolve(Buffer.concat(chunks).toString('utf8'));
		});
		process.stdin.on('error', () => {
			clearTimeout(timer);
			resolve('');
		});
	});
}

async function main() {
	try {
		const text = await readStdin(3000);
		handleEvent(JSON.parse(text), process.env, Date.now());
	} catch {
		// Swallow everything: a status hook must never disturb the agent.
	}
	process.exit(0);
}

if (require.main === module) {
	main();
}

module.exports = { statusPatch, waitingReasonFor, handleEvent, SCHEMA_VERSION, WRITER };
