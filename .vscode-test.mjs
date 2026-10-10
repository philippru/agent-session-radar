import { defineConfig } from '@vscode/test-cli';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// Integration tests run against the anonymized fixtures and a throw-away status folder,
// never against the real ~/.claude or ~/.session-radar.
export default defineConfig({
	files: 'out/test/integration/**/*.test.js',
	env: {
		CLAUDE_CONFIG_DIR: resolve('test/fixtures/claude'),
		SESSION_RADAR_HOME: mkdtempSync(join(tmpdir(), 'session-radar-it-')),
	},
	launchArgs: ['--disable-extensions'],
});
