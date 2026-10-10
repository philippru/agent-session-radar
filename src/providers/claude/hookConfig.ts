// Pure functions to add/remove the Session Radar hooks in Claude Code's settings.json.
// Existing hooks are never modified or removed; only entries whose command references
// our hook script are touched.

export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Notification', 'Stop', 'SessionEnd'] as const;
export const HOOK_SCRIPT_NAME = 'session-radar-hook.js';
/** Seconds. The hook typically finishes in well under 200 ms. */
export const HOOK_TIMEOUT_S = 10;

type Json = Record<string, unknown>;

interface HookHandler { type?: unknown; command?: unknown; [k: string]: unknown }
interface HookGroup { matcher?: unknown; hooks?: unknown; [k: string]: unknown }

/**
 * Shell command for the hook. Forward slashes and double quotes work in Git Bash,
 * PowerShell and cmd.exe alike, which Claude Code may use on Windows.
 */
export function hookCommand(scriptPath: string): string {
	return `node "${scriptPath.replace(/\\/g, '/')}"`;
}

function isOurs(handler: unknown): boolean {
	return !!handler && typeof handler === 'object'
		&& typeof (handler as HookHandler).command === 'string'
		&& ((handler as HookHandler).command as string).includes(HOOK_SCRIPT_NAME);
}

function asObject(v: unknown, what: string): Json {
	if (v === undefined) {
		return {};
	}
	if (!v || typeof v !== 'object' || Array.isArray(v)) {
		throw new Error(`Unerwartetes Format in settings.json: "${what}" ist kein Objekt.`);
	}
	return v as Json;
}

/** Events that currently have a Session Radar hook. */
export function installedEvents(settings: unknown): string[] {
	const hooks = asObject(asObject(settings, 'settings').hooks, 'hooks');
	return HOOK_EVENTS.filter(ev => Array.isArray(hooks[ev])
		&& (hooks[ev] as HookGroup[]).some(g => Array.isArray(g?.hooks) && (g.hooks as unknown[]).some(isOurs)));
}

export interface InstallPlan {
	next: Json;
	added: string[];
	updated: string[];
	unchanged: string[];
}

/** Add (or update the command of) our hook for each event. Does not mutate `settings`. */
export function planInstall(settings: unknown, command: string): InstallPlan {
	const next = structuredClone(asObject(settings, 'settings'));
	const hooks = asObject(next.hooks, 'hooks');
	const plan: InstallPlan = { next, added: [], updated: [], unchanged: [] };
	for (const ev of HOOK_EVENTS) {
		const groups = hooks[ev] ?? [];
		if (!Array.isArray(groups)) {
			throw new Error(`Unerwartetes Format in settings.json: "hooks.${ev}" ist keine Liste.`);
		}
		const ours = groups.flatMap(g => (Array.isArray(g?.hooks) ? (g.hooks as HookHandler[]) : [])).filter(isOurs);
		if (ours.length === 0) {
			groups.push({ hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_S }] });
			plan.added.push(ev);
		} else if (ours.some(h => h.command !== command)) {
			ours.forEach(h => (h.command = command));
			plan.updated.push(ev);
		} else {
			plan.unchanged.push(ev);
		}
		hooks[ev] = groups;
	}
	next.hooks = hooks;
	return plan;
}

/** Remove only our hook handlers; drop groups/events that become empty because of that. */
export function planUninstall(settings: unknown): { next: Json; removed: string[] } {
	const next = structuredClone(asObject(settings, 'settings'));
	const removed: string[] = [];
	if (next.hooks === undefined) {
		return { next, removed };
	}
	const hooks = asObject(next.hooks, 'hooks');
	for (const ev of Object.keys(hooks)) {
		const groups = hooks[ev];
		if (!Array.isArray(groups)) {
			continue;
		}
		let touched = false;
		const kept = (groups as HookGroup[]).flatMap(g => {
			if (!Array.isArray(g?.hooks) || !(g.hooks as unknown[]).some(isOurs)) {
				return [g];
			}
			touched = true;
			const rest = (g.hooks as unknown[]).filter(h => !isOurs(h));
			return rest.length ? [{ ...g, hooks: rest }] : [];
		});
		if (touched) {
			removed.push(ev);
			if (kept.length) {
				hooks[ev] = kept;
			} else {
				delete hooks[ev];
			}
		}
	}
	if (Object.keys(hooks).length === 0) {
		delete next.hooks;
	} else {
		next.hooks = hooks;
	}
	return { next, removed };
}

/** Serialize like the original file (indentation, trailing newline) to keep the diff minimal. */
export function serializeLike(original: string | undefined, value: unknown): string {
	const indentMatch = original?.match(/\n([ \t]+)"/);
	const indent = indentMatch ? indentMatch[1] : 2;
	const eol = original?.includes('\r\n') ? '\r\n' : '\n';
	const text = JSON.stringify(value, null, indent).replace(/\n/g, eol);
	return original === undefined || /\r?\n$/.test(original) ? text + eol : text;
}
