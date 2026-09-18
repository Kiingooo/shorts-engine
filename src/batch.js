/** Renders several episodes in sequence, continuing past any that fail. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { ROOT } from './config.js';

const run = promisify(execFile);
const slugs = process.argv.slice(2);
if (!slugs.length) { console.error('usage: node src/batch.js <slug> [slug...]'); process.exit(1); }

const results = [];
for (const slug of slugs) {
  process.stdout.write(`\n${'='.repeat(60)}\n${slug}\n${'='.repeat(60)}\n`);
  try {
    const { stdout } = await run(process.execPath, [path.join(ROOT, 'src', 'index.js'), '--script', slug],
      { cwd: ROOT, maxBuffer: 1 << 26 });
    process.stdout.write(stdout);
    results.push([slug, 'ok']);
  } catch (e) {
    console.error(`✖ ${slug}: ${(e.stderr || e.message).slice(0, 300)}`);
    results.push([slug, 'FAILED']);
  }
}

console.log(`\n${'='.repeat(60)}`);
for (const [slug, status] of results) console.log(`  ${status.padEnd(7)} ${slug}`);
