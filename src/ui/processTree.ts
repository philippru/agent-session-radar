import { execFile } from 'child_process';

/** Parent PID of a process, or undefined. Local process query only (no network). */
export function parentPid(pid: number): Promise<number | undefined> {
	return new Promise(resolve => {
		if (!Number.isInteger(pid) || pid <= 0) {
			resolve(undefined);
			return;
		}
		const done = (err: Error | null, stdout: string) => {
			const n = parseInt(String(stdout).trim(), 10);
			resolve(!err && Number.isInteger(n) && n > 0 ? n : undefined);
		};
		if (process.platform === 'win32') {
			execFile('powershell.exe',
				['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`],
				{ timeout: 5000, windowsHide: true }, done);
		} else {
			execFile('ps', ['-o', 'ppid=', '-p', String(pid)], { timeout: 2000 }, done);
		}
	});
}
