/** Map over items with at most `limit` concurrent async calls, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

/** Trailing-edge debounce. */
export function debounce(fn: () => void, waitMs: number): { (): void; cancel(): void } {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const debounced = () => {
		if (timer) {
			clearTimeout(timer);
		}
		timer = setTimeout(() => {
			timer = undefined;
			fn();
		}, waitMs);
	};
	debounced.cancel = () => {
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
	};
	return debounced;
}

/** "vor 5 Min." style relative time (German UI). */
export function formatRelative(then: number, now: number): string {
	const sec = Math.max(0, Math.round((now - then) / 1000));
	if (sec < 45) {
		return 'gerade eben';
	}
	const min = Math.round(sec / 60);
	if (min < 60) {
		return `vor ${min} Min.`;
	}
	const h = Math.round(min / 60);
	if (h < 24) {
		return `vor ${h} Std.`;
	}
	const d = Math.round(h / 24);
	return d === 1 ? 'vor 1 Tag' : `vor ${d} Tagen`;
}

/** Normalize a filesystem path for comparisons (case-insensitive drive/path on Windows). */
export function normalizePath(p: string, platform: NodeJS.Platform = process.platform): string {
	let s = p.replace(/[\\/]+/g, '/').replace(/\/$/, '');
	if (platform === 'win32') {
		s = s.toLowerCase();
	}
	return s;
}

/** Is `child` equal to or inside `parent`? */
export function isPathInside(child: string, parent: string, platform: NodeJS.Platform = process.platform): boolean {
	const c = normalizePath(child, platform);
	const p = normalizePath(parent, platform);
	return c === p || c.startsWith(p + '/');
}
