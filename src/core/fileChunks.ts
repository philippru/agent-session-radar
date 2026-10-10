// Read only the beginning or end of (potentially very large) line-based files.
// Transcripts can be tens of megabytes; we never load them completely.

import { promises as fs } from 'fs';

/** Complete lines from the first `maxBytes` of a file (a trailing partial line is dropped). */
export async function readHeadLines(filePath: string, maxBytes: number): Promise<string[]> {
	const fh = await fs.open(filePath, 'r');
	try {
		const { size } = await fh.stat();
		const len = Math.min(size, maxBytes);
		const buf = Buffer.alloc(len);
		await fh.read(buf, 0, len, 0);
		const text = buf.toString('utf8');
		const lines = text.split('\n');
		if (len < size) {
			lines.pop(); // partial last line
		}
		return lines.filter(l => l.trim().length > 0);
	} finally {
		await fh.close();
	}
}

/** Complete lines from the last `maxBytes` of a file (a leading partial line is dropped). */
export async function readTailLines(filePath: string, maxBytes: number): Promise<{ lines: string[]; reachedStart: boolean }> {
	const fh = await fs.open(filePath, 'r');
	try {
		const { size } = await fh.stat();
		const start = Math.max(0, size - maxBytes);
		const len = size - start;
		const buf = Buffer.alloc(len);
		await fh.read(buf, 0, len, start);
		const lines = buf.toString('utf8').split('\n');
		if (start > 0) {
			lines.shift(); // partial first line
		}
		return { lines: lines.filter(l => l.trim().length > 0), reachedStart: start === 0 };
	} finally {
		await fh.close();
	}
}

/** JSON.parse that returns undefined instead of throwing. */
export function tryParseJson(line: string): unknown {
	try {
		return JSON.parse(line);
	} catch {
		return undefined;
	}
}
