/**
 * Minimal .env.local loader (zero dependencies). Existing process.env values
 * always win. Import at the very top of any script that needs secrets.
 */
import fs from 'node:fs';
import path from 'node:path';

export function loadLocalEnv(fileName = '.env.local'): void {
  const envPath = path.resolve(__dirname, '..', fileName);
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadLocalEnv();
