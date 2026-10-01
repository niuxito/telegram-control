import fs from 'fs';
import { parse as parseDotenv } from 'dotenv';

export function readEnvFile(envPath: string): Record<string, string> {
  return fs.existsSync(envPath) ? parseDotenv(fs.readFileSync(envPath)) : {};
}

/**
 * Sets KEY=value lines in .env, replacing an existing line for the key
 * (including `KEY=   # hint` placeholders) or appending it. Other lines,
 * comments and order are preserved.
 */
export function setEnvValues(content: string, values: Record<string, string>): string {
  const lines = content.split('\n');
  for (const [key, value] of Object.entries(values)) {
    const index = lines.findIndex(line => new RegExp(`^\\s*${key}\\s*=`).test(line));
    if (index === -1) {
      if (lines.length && lines[lines.length - 1] === '') lines.splice(lines.length - 1, 0, `${key}=${value}`);
      else lines.push(`${key}=${value}`);
    } else {
      lines[index] = `${key}=${value}`;
    }
  }
  return lines.join('\n');
}

export function writeEnvValues(envPath: string, values: Record<string, string>): void {
  const current = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  fs.writeFileSync(envPath, setEnvValues(current, values), { mode: 0o600 });
}
