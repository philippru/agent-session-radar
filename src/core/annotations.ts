// User annotations (local labels, archived flag, "last seen") stored in
// ~/.session-radar/annotations.json, so other front-ends can share them.
// Format is documented in docs/status-format.md.

import { promises as fs } from 'fs';
import * as path from 'path';
import { writeFileAtomic } from './atomicWrite';

export interface SessionAnnotation {
	/** Local label that overrides the session title in the UI. */
	label?: string;
	/** Hidden from the default view. */
	archived?: boolean;
	/** When the user last looked at the session (ms since epoch). */
	lastSeenAt?: number;
}

export interface AnnotationsFile {
	schemaVersion: 1;
	/** Turns that ended before this point count as seen (set on first run). */
	seenBaseline?: number;
	/** Keyed by "<agent>:<sessionId>". */
	sessions: Record<string, SessionAnnotation>;
}

function emptyFile(): AnnotationsFile {
	return { schemaVersion: 1, sessions: {} };
}

export function parseAnnotations(text: string): AnnotationsFile | undefined {
	try {
		const raw = JSON.parse(text) as Partial<AnnotationsFile>;
		if (!raw || typeof raw !== 'object' || typeof raw.sessions !== 'object' || raw.sessions === null) {
			return undefined;
		}
		const sessions: Record<string, SessionAnnotation> = {};
		for (const [key, value] of Object.entries(raw.sessions)) {
			if (!value || typeof value !== 'object') {
				continue;
			}
			const a: SessionAnnotation = {};
			if (typeof value.label === 'string' && value.label.trim()) {
				a.label = value.label;
			}
			if (value.archived === true) {
				a.archived = true;
			}
			if (typeof value.lastSeenAt === 'number') {
				a.lastSeenAt = value.lastSeenAt;
			}
			sessions[key] = a;
		}
		return {
			schemaVersion: 1,
			seenBaseline: typeof raw.seenBaseline === 'number' ? raw.seenBaseline : undefined,
			sessions,
		};
	} catch {
		return undefined;
	}
}

export class AnnotationStore {
	private data: AnnotationsFile = emptyFile();

	constructor(private readonly filePath: string) { }

	get path(): string {
		return this.filePath;
	}

	/** (Re)load from disk. A missing file means "no annotations"; a corrupt file is kept aside. */
	async load(): Promise<void> {
		let text: string;
		try {
			text = await fs.readFile(this.filePath, 'utf8');
		} catch {
			this.data = emptyFile();
			return;
		}
		const parsed = parseAnnotations(text);
		if (parsed) {
			this.data = parsed;
		} else {
			// Never silently overwrite a file we cannot read: move it aside.
			await fs.rename(this.filePath, `${this.filePath}.corrupt-${Date.now()}`).catch(() => undefined);
			this.data = emptyFile();
		}
	}

	get(key: string): SessionAnnotation {
		return this.data.sessions[key] ?? {};
	}

	get seenBaseline(): number | undefined {
		return this.data.seenBaseline;
	}

	/** On first run, mark everything that already happened as seen. */
	async ensureSeenBaseline(now: number): Promise<void> {
		if (this.data.seenBaseline === undefined) {
			await this.mutate(d => {
				d.seenBaseline ??= now;
			});
		}
	}

	async update(key: string, patch: Partial<SessionAnnotation>): Promise<void> {
		await this.updateMany([key], patch);
	}

	/** Patch several sessions; `undefined` values remove the field. */
	async updateMany(keys: string[], patch: Partial<SessionAnnotation>): Promise<void> {
		await this.mutate(d => {
			for (const key of keys) {
				const next: SessionAnnotation = { ...d.sessions[key] };
				for (const [k, v] of Object.entries(patch) as [keyof SessionAnnotation, unknown][]) {
					if (v === undefined || v === false || v === '') {
						delete next[k];
					} else {
						(next as Record<string, unknown>)[k] = v;
					}
				}
				if (Object.keys(next).length) {
					d.sessions[key] = next;
				} else {
					delete d.sessions[key];
				}
			}
		});
	}

	/** Read-modify-write against the latest file content (other windows may have written). */
	private async mutate(fn: (d: AnnotationsFile) => void): Promise<void> {
		await this.load();
		fn(this.data);
		await fs.mkdir(path.dirname(this.filePath), { recursive: true });
		await writeFileAtomic(this.filePath, JSON.stringify(this.data, null, 2) + '\n');
	}
}
