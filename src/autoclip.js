/**
 * Turns a scan result into finished reaction clips, unattended.
 *
 *   node src/autoclip.js --scan work/scan/gta6.json --lines scripts/lines/gta6.json [--limit 10]
 *
 * For each candidate it cuts a short segment out of the source, writes a
 * reaction script pointing at that segment, and renders it. The lines file
 * supplies what the character says, one entry per clip, so the writing stays
 * a human (or agent) decision and this stays mechanical.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import { ROOT, dirs } from './config.js';

const run = promisify(execFile);

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
};

const ff = (args) => run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 1 << 28 });

async function main() {
  const scanFile = arg('scan');
  const linesFile = arg('lines');
  if (!scanFile || !linesFile) {
    console.error('usage: node src/autoclip.js --scan <scan.json> --lines <lines.json> [--limit 10]');
    process.exit(1);
  }

  const scan = JSON.parse(fs.readFileSync(path.resolve(ROOT, scanFile), 'utf8'));
  const linesDoc = JSON.parse(fs.readFileSync(path.resolve(ROOT, linesFile), 'utf8'));
  const limit = parseInt(arg('limit', '10'), 10);
  const character = linesDoc.character || 'lilwoof-v2';
  const source = path.resolve(ROOT, scan.source);

  const candidates = scan.candidates.slice(0, limit);
  const lines = linesDoc.lines || [];

  const cutDir = path.join(ROOT, 'clips', 'cuts');
  const scriptDir = path.join(dirs.scripts, 'reactions');
  fs.mkdirSync(cutDir, { recursive: true });
  fs.mkdirSync(scriptDir, { recursive: true });

  const base = path.basename(scan.source).replace(/\.[^.]+$/, '');
  const made = [];

  for (const [i, c] of candidates.entries()) {
    const n = String(i + 1).padStart(2, '0');
    const slug = `${base}_${n}`;
    const line = lines[i % lines.length];
    if (!line) { console.log(`  skip ${slug}: no line`); continue; }

    // Keep the cut short: a reaction short lives or dies in the first seconds,
    // and a long tail just pads the render.
    const start = c.clipStart;
    const dur = Math.min(16, c.clipEnd - c.clipStart);
    const cut = path.join(cutDir, `${slug}.mp4`);

    await ff(['-ss', String(start), '-t', String(dur), '-i', source,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2', cut]);

    const doc = {
      title: `${linesDoc.title || base} ${n}`,
      source: path.relative(ROOT, cut).replace(/\\/g, '/'),
      character,
      flapHz: linesDoc.flapHz || 3,
      beats: [{ at: Math.min(3, dur / 3), line }],
    };
    const docFile = path.join(scriptDir, `${slug}.json`);
    fs.writeFileSync(docFile, JSON.stringify(doc, null, 2));

    process.stdout.write(`\n[${i + 1}/${candidates.length}] ${slug}  @${c.peakStamp}\n`);
    const expected = path.join(dirs.out, `${slug}.mp4`);
    fs.rmSync(expected, { force: true });
    try {
      const { stdout } = await run(process.execPath, [path.join(ROOT, 'src', 'reaction.js'), '--script', slug],
        { cwd: ROOT, maxBuffer: 1 << 26 });
      process.stdout.write(stdout.split('\n').filter((l) => l.includes('✅')).join('\n') + '\n');
    } catch (e) {
      console.error(`  ✖ ${slug}: ${String(e.stderr || e.message).slice(0, 300)}`);
    }
    // Trust the file, not the exit code. A renderer that dies on an unsettled
    // promise exits 0 with no output, which otherwise counts as a success.
    if (fs.existsSync(expected)) made.push(slug);
    else console.error(`  ✖ ${slug}: no output file was produced`);
  }

  console.log(`\n${made.length}/${candidates.length} clips in out/\n`);
  made.forEach((s) => console.log(`  out/${s}.mp4`));
}

main().catch((e) => { console.error(`\n✖ ${e.message}\n`); process.exit(1); });
