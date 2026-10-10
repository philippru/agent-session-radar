import * as os from 'os';
import * as path from 'path';

/** Expand a leading "~" to the home directory. */
export function expandHome(p: string): string {
	return p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Claude Code config dir: explicit setting > $CLAUDE_CONFIG_DIR > ~/.claude */
export function resolveClaudeDir(setting?: string): string {
	if (setting && setting.trim()) {
		return expandHome(setting.trim());
	}
	if (process.env.CLAUDE_CONFIG_DIR) {
		return expandHome(process.env.CLAUDE_CONFIG_DIR);
	}
	return path.join(os.homedir(), '.claude');
}

/** Codex data dir: $CODEX_HOME > ~/.codex */
export function resolveCodexDir(): string {
	return process.env.CODEX_HOME ? expandHome(process.env.CODEX_HOME) : path.join(os.homedir(), '.codex');
}

/** Root of the Agent Session Radar status layer: $SESSION_RADAR_HOME > ~/.session-radar */
export function radarHome(): string {
	return process.env.SESSION_RADAR_HOME ? expandHome(process.env.SESSION_RADAR_HOME) : path.join(os.homedir(), '.session-radar');
}
