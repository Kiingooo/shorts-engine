/**
 * Downloads a source clip into clips/ using yt-dlp.
 *
 * yt-dlp is a separate binary rather than a dependency: it needs frequent
 * updating to keep pace with site changes, so pinning it in package.json
 * would guarantee it goes stale.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT } from './config.js';

const CLIPS = path.join(ROOT, 'clips');
fs.mkdirSync(CLIPS, { recursive: true });

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('--'));
const nameFlag = args.indexOf('--name');
const name = nameFlag > -1 ? args[nameFlag + 1] : null;

if (!url) {
  console.error('usage: npm run grab -- <url> [--name my-clip]');
  process.exit(1);
}

const out = name
  ? path.join(CLIPS, `${name}.%(ext)s`)
  : path.join(CLIPS, '%(title).60s.%(ext)s');

// mp4 + m4a keeps the result directly usable by the reaction renderer without
// a remux step; the fallback covers sites that only offer a single stream.
const ytArgs = [
  '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b',
  '--merge-output-format', 'mp4',
  '--no-playlist',
  '--restrict-filenames',
  '-o', out,
  url,
];

console.log(`\ngrabbing into clips/\n`);

const child = spawn('yt-dlp', ytArgs, { stdio: 'inherit', shell: process.platform === 'win32' });

child.on('error', () => {
  console.error('\n✖ yt-dlp not found.\n');
  console.error('  Windows:  winget install yt-dlp');
  console.error('  macOS:    brew install yt-dlp');
  console.error('  Linux:    pipx install yt-dlp');
  console.error('\n  It also needs ffmpeg on PATH to merge video and audio.');
  console.error('  (This project ships its own ffmpeg for rendering, but yt-dlp cannot see it.)\n');
  process.exit(1);
});

child.on('exit', (code) => {
  if (code !== 0) { console.error(`\n✖ yt-dlp exited ${code}\n`); process.exit(code ?? 1); }
  console.log(`\n✅ saved to clips/\n`);
  console.log('Next: point a reaction script at it.');
  console.log('  scripts/reactions/<name>.json  ->  "source": "clips/<file>.mp4"');
  console.log('  npm run react -- --script <name>\n');
});
