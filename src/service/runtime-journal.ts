import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

export function runtimeJournal(directory: string) {
  const file = path.join(directory, 'runtime.log');
  return (event: string, details: Record<string, unknown> = {}) => {
    try {
      if (existsSync(file) && statSync(file).size > 1024 * 1024) renameSync(file, `${file}.previous`);
      appendFileSync(file, `${JSON.stringify({ time: new Date().toISOString(), pid: process.pid, event, ...details })}\n`, { mode: 0o600 });
    } catch { /* Diagnostics cannot interrupt project processing. */ }
  };
}
