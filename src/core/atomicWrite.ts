import { promises as fs } from 'fs';

/**
 * Write a file atomically: write to a temp file next to it, then rename over the target.
 * Readers never see a half-written file. On Windows, rename can fail with EPERM/EBUSY while
 * another process has the target open, so we retry briefly and fall back to a direct write.
 */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
	const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	await fs.writeFile(tmp, content, 'utf8');
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			await fs.rename(tmp, filePath);
			return;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') {
				await fs.unlink(tmp).catch(() => undefined);
				throw err;
			}
			await new Promise(r => setTimeout(r, 20 * (attempt + 1)));
		}
	}
	await fs.writeFile(filePath, content, 'utf8');
	await fs.unlink(tmp).catch(() => undefined);
}
