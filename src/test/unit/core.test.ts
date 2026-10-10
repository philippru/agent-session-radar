import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AnnotationStore, parseAnnotations } from '../../core/annotations';
import { formatRelative, isPathInside, mapLimit } from '../../core/util';

suite('util', () => {
	test('isPathInside is case-insensitive on Windows and slash-agnostic', () => {
		assert.ok(isPathInside('c:\\Users\\me\\proj\\sub', 'C:/Users/me/proj', 'win32'));
		assert.ok(isPathInside('C:\\Users\\me\\proj', 'c:\\users\\me\\proj\\', 'win32'));
		assert.ok(!isPathInside('C:\\Users\\me\\project2', 'C:\\Users\\me\\proj', 'win32'));
		assert.ok(!isPathInside('/home/Me/proj', '/home/me/proj', 'linux'));
	});

	test('formatRelative', () => {
		const now = 1_000_000_000;
		assert.strictEqual(formatRelative(now - 10_000, now), 'gerade eben');
		assert.strictEqual(formatRelative(now - 5 * 60_000, now), 'vor 5 Min.');
		assert.strictEqual(formatRelative(now - 3 * 3600_000, now), 'vor 3 Std.');
		assert.strictEqual(formatRelative(now - 26 * 3600_000, now), 'vor 1 Tag');
	});

	test('mapLimit preserves order', async () => {
		const r = await mapLimit([30, 10, 20], 2, async n => {
			await new Promise(res => setTimeout(res, n));
			return n * 2;
		});
		assert.deepStrictEqual(r, [60, 20, 40]);
	});
});

suite('annotations', () => {
	test('parseAnnotations rejects garbage and drops invalid fields', () => {
		assert.strictEqual(parseAnnotations('nope'), undefined);
		assert.strictEqual(parseAnnotations('{"sessions":null}'), undefined);
		const p = parseAnnotations('{"schemaVersion":1,"sessions":{"a":{"label":"x","archived":"yes","lastSeenAt":5}}}');
		assert.deepStrictEqual(p?.sessions.a, { label: 'x', lastSeenAt: 5 });
	});

	test('update, remove fields, baseline, corrupt file is moved aside', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-radar-ann-'));
		const file = path.join(dir, 'sub', 'annotations.json');
		try {
			const store = new AnnotationStore(file);
			await store.load();
			await store.ensureSeenBaseline(123);
			await store.ensureSeenBaseline(999); // does not move an existing baseline
			await store.update('claude-code:1', { label: 'Mein Label', archived: true });
			await store.update('claude-code:1', { archived: false });

			const reread = new AnnotationStore(file);
			await reread.load();
			assert.strictEqual(reread.seenBaseline, 123);
			assert.deepStrictEqual(reread.get('claude-code:1'), { label: 'Mein Label' });

			await fs.writeFile(file, '{broken');
			await reread.load();
			assert.deepStrictEqual(reread.get('claude-code:1'), {});
			const files = await fs.readdir(path.dirname(file));
			assert.ok(files.some(f => f.startsWith('annotations.json.corrupt-')));
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
