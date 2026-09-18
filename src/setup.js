/**
 * First-run onboarding.
 *
 * Walks a new user from nothing to a working setup: their own character art,
 * their own voice, their own keys. Nothing here reuses anyone else's account.
 *
 * Deliberately resumable — every step checks whether it is already done, so
 * re-running it after a failure picks up rather than starting over.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import { ROOT } from './config.js';

const run = promisify(execFile);
const rl = readline.createInterface({ input, output });

const ask = async (q, def = '') => {
  const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
  return a || def;
};
const pause = (msg) => rl.question(`\n${msg}\nPress Enter when done... `);
const line = () => console.log('\n' + '─'.repeat(64) + '\n');

const ff = (args) => run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 1 << 28 });

/** Curated English voices; the full list is `node src/list-edge-voices.js`. */
const VOICES = [
  ['en-US-ChristopherNeural', 'male, US, reliable / authority'],
  ['en-US-GuyNeural', 'male, US, passionate'],
  ['en-US-EricNeural', 'male, US, rational'],
  ['en-US-AndrewNeural', 'male, US, warm / confident'],
  ['en-US-RogerNeural', 'male, US, lively'],
  ['en-GB-RyanNeural', 'male, UK, friendly'],
  ['en-AU-WilliamMultilingualNeural', 'male, AU, friendly'],
  ['en-US-AriaNeural', 'female, US, crisp'],
  ['en-US-JennyNeural', 'female, US, friendly'],
  ['en-GB-SoniaNeural', 'female, UK, warm'],
];

const PROMPT_CLOSED = (desc) => `Photorealistic studio portrait of ${desc}. Front-facing, head and chest only, shoulders square to camera, centered, sitting upright. Mouth CLOSED, jaw relaxed, calm confident expression. Shot on 85mm, shallow depth of field, soft key light from the left with a cool rim light, natural detail, subtle catchlights. Plain flat background. No text, no logos, no watermark.`;

const PROMPT_OPEN = `Identical subject, identical outfit and accessories, identical pose, framing, lighting and camera. ONLY difference: mouth OPEN mid-speech, jaw dropped naturally. Everything else pixel-identical.`;

/**
 * Finds the region that differs between the two frames.
 *
 * ffmpeg's own cropdetect is no use here: a difference image is mostly black
 * with scattered noise, and it returns negative widths. So the difference is
 * rendered to a small raw grayscale buffer and the bounding box of the
 * above-threshold pixels is computed directly.
 */
async function detectMouthBox(closed, open, srcSize) {
  const N = 256;
  try {
    const { stdout } = await run(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', closed, '-i', open,
      '-filter_complex', `[0:v][1:v]blend=all_mode=difference,format=gray,scale=${N}:${N}`,
      '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
    ], { encoding: 'buffer', maxBuffer: 1 << 28 });

    if (stdout.length < N * N) return null;

    let max = 0;
    for (const v of stdout) if (v > max) max = v;
    const threshold = Math.max(18, max * 0.25);

    let x1 = N, y1 = N, x2 = -1, y2 = -1;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        if (stdout[y * N + x] > threshold) {
          if (x < x1) x1 = x;
          if (x > x2) x2 = x;
          if (y < y1) y1 = y;
          if (y > y2) y2 = y;
        }
      }
    }
    if (x2 < 0) return null;

    // Scale back up, then pad so the patch edge never lands on the lip line.
    const s = srcSize / N;
    const pad = Math.round(srcSize * 0.012);
    const x = Math.max(0, Math.round(x1 * s) - pad);
    const y = Math.max(0, Math.round(y1 * s) - pad);
    const w = Math.min(srcSize - x, Math.round((x2 - x1 + 1) * s) + pad * 2);
    const h = Math.min(srcSize - y, Math.round((y2 - y1 + 1) * s) + pad * 2);
    return { x, y, w, h };
  } catch {
    return null;
  }
}

async function main() {
  console.log('\n  shorts-engine setup\n');
  console.log('  Gets you your own character, your own voice, your own keys.');
  line();

  // ── 1. character ────────────────────────────────────────────────────────
  const slug = (await ask('Character folder name (e.g. lilwoof, grizzle)', 'my-character'))
    .toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const charDir = path.join(ROOT, 'character', slug);
  fs.mkdirSync(charDir, { recursive: true });

  const closed = path.join(charDir, 'closed.png');
  const open = path.join(charDir, 'open.png');

  if (fs.existsSync(closed) && fs.existsSync(open)) {
    console.log(`\n✓ character/${slug} already has closed.png and open.png, skipping art steps.`);
  } else {
    line();
    console.log('  STEP 1 — generate your character\n');
    const desc = await ask(
      'Describe your character in one line',
      'a real rottweiler wearing a navy paisley bandana, black sunglasses, a silver chain and a white tank top',
    );

    console.log('\n  Paste these into your image generator.\n');
    console.log('  ── PROMPT 1 (mouth closed) ──\n');
    console.log('  ' + PROMPT_CLOSED(desc) + '\n');
    console.log('  ── PROMPT 2 (mouth open) ──\n');
    console.log('  ' + PROMPT_OPEN + '\n');
    console.log('  Generate the CLOSED one first, then feed it back as an image');
    console.log('  reference for the OPEN one. If the body drifts between the two,');
    console.log('  the mouth flap will jitter.\n');

    await pause(`Save both images anywhere, then come back.`);

    const srcClosed = await ask('Full path to the MOUTH CLOSED image');
    const srcOpen = await ask('Full path to the MOUTH OPEN image');
    for (const f of [srcClosed, srcOpen]) {
      if (!fs.existsSync(f)) { console.error(`\n✖ Not found: ${f}\n`); process.exit(1); }
    }

    // ── 2. background removal ─────────────────────────────────────────────
    line();
    console.log('  STEP 2 — background removal\n');
    const auto = (await ask('Remove backgrounds automatically? (y/n)', 'y')).toLowerCase().startsWith('y');

    const rawClosed = path.join(charDir, '_raw_closed.png');
    const rawOpen = path.join(charDir, '_raw_open.png');
    fs.copyFileSync(srcClosed, rawClosed);
    fs.copyFileSync(srcOpen, rawOpen);

    if (auto) {
      console.log('\n  Removing backgrounds (first run downloads a model, be patient)...');
      try {
        const { removeBackground } = await import('@imgly/background-removal-node');
        for (const [src, dst] of [[rawClosed, closed], [rawOpen, open]]) {
          const blob = await removeBackground(`file://${src.replace(/\\/g, '/')}`);
          fs.writeFileSync(dst, Buffer.from(await blob.arrayBuffer()));
          console.log(`  ✓ ${path.basename(dst)}`);
        }
      } catch (e) {
        console.error(`\n  ✖ Automatic removal failed: ${e.message}`);
        console.error('  Do it manually instead, then re-run setup.\n');
        process.exit(1);
      }
    } else {
      console.log('\n  Use any free cutout tool, then save the transparent PNGs as:');
      console.log(`    ${closed}`);
      console.log(`    ${open}`);
      await pause('Save both, then come back.');
      for (const f of [closed, open]) {
        if (!fs.existsSync(f)) { console.error(`\n✖ Missing ${f}\n`); process.exit(1); }
      }
    }

    // ── 3. lock everything except the mouth ───────────────────────────────
    line();
    console.log('  STEP 3 — locking the pose\n');
    console.log('  Background removers often punch holes elsewhere in the image, and');
    console.log('  any drift outside the mouth shows up as a flicker on every flap.');
    console.log('  So the open frame is rebuilt as the closed frame with only the');
    console.log('  mouth region pasted in.\n');

    const { stdout: dims } = await run(
      path.join(ROOT, 'node_modules', 'ffprobe-static', 'bin', process.platform, process.arch, 'ffprobe' + (process.platform === 'win32' ? '.exe' : '')),
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width', '-of', 'default=nw=1:nk=1', closed],
    ).catch(() => ({ stdout: '2048' }));
    const srcSize = parseInt(String(dims).trim(), 10) || 2048;

    const box = await detectMouthBox(closed, open, srcSize);
    if (box && box.w > 40 && box.h > 40) {
      console.log(`  Detected changed region: ${box.w}x${box.h} at ${box.x},${box.y}`);
      const ok = (await ask('  Use it? (y/n)', 'y')).toLowerCase().startsWith('y');
      if (ok) {
        const patched = path.join(charDir, '_patched.png');
        await ff(['-i', closed, '-i', open,
          '-filter_complex', `[1:v]crop=${box.w}:${box.h}:${box.x}:${box.y}[p];[0:v][p]overlay=${box.x}:${box.y}`,
          '-frames:v', '1', patched]);
        fs.renameSync(patched, open);
        console.log('  ✓ open.png rebuilt from the locked base');
      }
    } else {
      console.log('  Could not detect the changed region automatically, leaving both as-is.');
      console.log('  If the flap flickers, patch manually (see README).');
    }
  }

  // ── 4. voice ────────────────────────────────────────────────────────────
  line();
  console.log('  STEP 4 — pick a voice\n');
  console.log('  Free, no API key, no account. Microsoft Edge neural voices.\n');
  VOICES.forEach(([id, d], i) => console.log(`   ${String(i + 1).padStart(2)}. ${id.padEnd(34)} ${d}`));

  const sampleDir = path.join(ROOT, 'work', 'voice-samples');
  fs.mkdirSync(sampleDir, { recursive: true });

  const wantSamples = (await ask('\nGenerate samples of all of these to listen to? (y/n)', 'y'))
    .toLowerCase().startsWith('y');

  if (wantSamples) {
    const { Communicate } = await import('edge-tts-universal');
    const demo = 'Hold up. Run that back, I need to see that again.';
    for (const [id] of VOICES) {
      try {
        const c = new Communicate(demo, { voice: id, rate: '+15%' });
        const chunks = [];
        for await (const ev of c.stream()) if (ev.type === 'audio' && ev.data) chunks.push(Buffer.from(ev.data));
        fs.writeFileSync(path.join(sampleDir, `${id}.mp3`), Buffer.concat(chunks));
        console.log(`  ✓ ${id}`);
      } catch {
        console.log(`  ✖ ${id} (skipped)`);
      }
    }
    console.log(`\n  Samples are in work/voice-samples/`);
    await pause('Listen, then come back.');
  }

  const pick = parseInt(await ask('Voice number', '1'), 10);
  const voice = (VOICES[pick - 1] || VOICES[0])[0];
  const rate = await ask('Speed (e.g. +0%, +15%, +25%)', '+15%');

  // ── 5. keys ─────────────────────────────────────────────────────────────
  line();
  console.log('  STEP 5 — stock footage keys (optional)\n');
  console.log('  Only needed for narrated knowledge shorts. Reaction videos do not');
  console.log('  use them. Both are free and take a minute.\n');
  console.log('    Pexels   https://www.pexels.com/api/');
  console.log('    Pixabay  https://pixabay.com/api/docs/\n');

  const pexels = await ask('PEXELS_API_KEY (Enter to skip)', '');
  const pixabay = await ask('PIXABAY_API_KEY (Enter to skip)', '');

  // ── 6. write .env ───────────────────────────────────────────────────────
  const envPath = path.join(ROOT, '.env');
  const env = [
    '# Voice: free, no key needed.',
    'VOICE_PROVIDER=edge',
    `EDGE_VOICE=${voice}`,
    `EDGE_RATE=${rate}`,
    '',
    '# Optional paid alternative.',
    'ELEVENLABS_API_KEY=',
    'ELEVENLABS_VOICE_ID=',
    'ELEVENLABS_MODEL=eleven_multilingual_v2',
    '',
    '# Free stock footage keys.',
    `PEXELS_API_KEY=${pexels}`,
    `PIXABAY_API_KEY=${pixabay}`,
    '',
    '# Channel identity for the tweet-style layout.',
    'CHANNEL_NAME=My Channel',
    'CHANNEL_HANDLE=@mychannel',
    '',
  ].join('\n');

  if (fs.existsSync(envPath)) {
    fs.copyFileSync(envPath, `${envPath}.backup`);
    console.log('\n  (existing .env backed up to .env.backup)');
  }
  fs.writeFileSync(envPath, env);

  // ── done ────────────────────────────────────────────────────────────────
  line();
  console.log('  Done.\n');
  console.log(`  Character: character/${slug}/`);
  console.log(`  Voice:     ${voice} at ${rate}\n`);
  console.log('  Try it:\n');
  console.log(`    npm run puppet -- --char ${slug} --seconds 5`);
  console.log('    npm run grab   -- "<video url>"');
  console.log('    npm run react  -- --script demo\n');
  console.log('  Point scripts/reactions/demo.json at your downloaded clip and');
  console.log(`  set "character": "${slug}".\n`);

  rl.close();
}

main().catch((e) => { console.error(`\n✖ ${e.message}\n`); rl.close(); process.exit(1); });
