/**
 * First-run onboarding.
 *
 * Walks a new user from nothing to a working setup: their own character art,
 * their own voice, their own keys. Nothing here reuses anyone else's account.
 *
 * Flow: what are you making -> name it -> keywords -> reference board ->
 * generated prompt -> your two images -> cutout -> pose lock -> voice -> keys.
 *
 * Deliberately resumable. Every step checks whether it is already done, so
 * re-running after a failure picks up rather than starting over.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import { ROOT } from './config.js';
import { grabReferences } from './refimages.js';

const run = promisify(execFile);
const rl = readline.createInterface({ input, output });

const ask = async (q, def = '') => {
  const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
  return a || def;
};
const yes = async (q, def = 'y') => (await ask(q, def)).toLowerCase().startsWith('y');
const pause = (msg) => rl.question(`\n${msg}\nPress Enter when done... `);
const line = () => console.log('\n' + '─'.repeat(66) + '\n');

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

const promptClosed = (desc) =>
  `Photorealistic studio portrait of ${desc}. Front-facing, head and chest only, `
  + `shoulders square to camera, centered, sitting upright. Mouth CLOSED, jaw relaxed, `
  + `calm confident expression. Shot on 85mm, shallow depth of field, soft key light from `
  + `the left with a cool rim light, natural detail, individual hairs visible, subtle `
  + `catchlights. Plain flat background. No text, no logos, no watermark.`;

const PROMPT_OPEN =
  'Identical subject, identical outfit and accessories, identical pose, framing, lighting '
  + 'and camera. ONLY difference: mouth OPEN mid-speech, jaw dropped naturally. Everything '
  + 'else pixel-identical.';

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

async function imageWidth(file) {
  const bin = path.join(ROOT, 'node_modules', 'ffprobe-static', 'bin',
    process.platform, process.arch, 'ffprobe' + (process.platform === 'win32' ? '.exe' : ''));
  const { stdout } = await run(bin,
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width', '-of', 'default=nw=1:nk=1', file])
    .catch(() => ({ stdout: '2048' }));
  return parseInt(String(stdout).trim(), 10) || 2048;
}

async function buildCharacter() {
  line();
  console.log('  STEP 1 — name it\n');

  const name = await ask('What is the character called?', 'Lil Woof');
  const slug = (await ask('Folder name', name.toLowerCase().replace(/[^a-z0-9]+/g, '-')))
    .toLowerCase().replace(/[^a-z0-9-]/g, '-');

  const charDir = path.join(ROOT, 'character', slug);
  const refDir = path.join(charDir, 'reference');
  fs.mkdirSync(charDir, { recursive: true });

  const closed = path.join(charDir, 'closed.png');
  const open = path.join(charDir, 'open.png');

  if (fs.existsSync(closed) && fs.existsSync(open)) {
    console.log(`\n  ✓ character/${slug} already has both images, skipping ahead.`);
    return { slug, name };
  }

  // ── reference board ──────────────────────────────────────────────────
  line();
  console.log('  STEP 2 — reference board\n');
  console.log('  Keywords describing the look you are going for.');
  console.log('  Example: "rottweiler sunglasses bandana chain"\n');

  const keywords = await ask('Keywords', 'rottweiler sunglasses');

  if (await yes('Grab 10 reference images for these? (y/n)')) {
    console.log('\n  Searching...');
    const saved = await grabReferences(keywords, refDir, 10);
    if (saved.length) {
      console.log(`  ✓ ${saved.length} images saved to character/${slug}/reference/`);
      console.log('    (SOURCES.txt lists where each came from)');
      await pause('  Open that folder and look through them.');
    } else {
      console.log('  Nothing found for those keywords. Carrying on without a board.');
    }
  }

  // ── prompt ───────────────────────────────────────────────────────────
  line();
  console.log('  STEP 3 — your prompt\n');
  console.log('  Describe the character in one line, using what you just saw.\n');

  const desc = await ask(
    'Description',
    `a real ${keywords} wearing a white tank top, photoreal, confident expression`,
  );

  console.log('\n  ── PROMPT 1 (mouth closed) ──\n');
  console.log('  ' + promptClosed(desc) + '\n');
  console.log('  ── PROMPT 2 (mouth open) ──\n');
  console.log('  ' + PROMPT_OPEN + '\n');
  console.log('  Generate the CLOSED one first, then feed it back as an image');
  console.log('  reference for the OPEN one. If the body drifts between the two,');
  console.log('  the mouth flap will jitter.\n');

  await pause('  Generate both, save them anywhere, then come back.');

  const srcClosed = await ask('  Full path to the MOUTH CLOSED image');
  const srcOpen = await ask('  Full path to the MOUTH OPEN image');
  for (const f of [srcClosed, srcOpen]) {
    if (!fs.existsSync(f)) { console.error(`\n  ✖ Not found: ${f}\n`); process.exit(1); }
  }

  // ── cutout ───────────────────────────────────────────────────────────
  line();
  console.log('  STEP 4 — background removal\n');

  const rawClosed = path.join(charDir, '_raw_closed.png');
  const rawOpen = path.join(charDir, '_raw_open.png');
  fs.copyFileSync(srcClosed, rawClosed);
  fs.copyFileSync(srcOpen, rawOpen);

  if (await yes('Remove backgrounds automatically? (y/n)')) {
    console.log('\n  Working (first run downloads a model, be patient)...');
    try {
      const { removeBackground } = await import('@imgly/background-removal-node');
      for (const [src, dst] of [[rawClosed, closed], [rawOpen, open]]) {
        const blob = await removeBackground(`file://${src.replace(/\\/g, '/')}`);
        fs.writeFileSync(dst, Buffer.from(await blob.arrayBuffer()));
        console.log(`  ✓ ${path.basename(dst)}`);
      }
    } catch (e) {
      console.error(`\n  ✖ Automatic removal failed: ${e.message}`);
      console.error('  Cut them out manually, save as closed.png and open.png, re-run setup.\n');
      process.exit(1);
    }
  } else {
    console.log('\n  Use any free cutout tool, then save the transparent PNGs as:');
    console.log(`    ${closed}`);
    console.log(`    ${open}`);
    await pause('  Save both, then come back.');
    for (const f of [closed, open]) {
      if (!fs.existsSync(f)) { console.error(`\n  ✖ Missing ${f}\n`); process.exit(1); }
    }
  }

  // ── pose lock ────────────────────────────────────────────────────────
  line();
  console.log('  STEP 5 — locking the pose\n');
  console.log('  Background removers often punch holes elsewhere in the image, and any');
  console.log('  drift outside the mouth shows up as a flicker on every flap. So the');
  console.log('  open frame gets rebuilt as the closed frame with only the mouth pasted in.\n');

  const srcSize = await imageWidth(closed);
  const box = await detectMouthBox(closed, open, srcSize);

  if (box && box.w > 40 && box.h > 40) {
    console.log(`  Changed region detected: ${box.w}x${box.h} at ${box.x},${box.y}`);
    if (await yes('  Use it? (y/n)')) {
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

  return { slug, name };
}

async function pickVoice() {
  line();
  console.log('  STEP 6 — pick a voice\n');
  console.log('  Free, no API key, no account. Microsoft Edge neural voices.\n');
  VOICES.forEach(([id, d], i) => console.log(`   ${String(i + 1).padStart(2)}. ${id.padEnd(34)} ${d}`));

  if (await yes('\nGenerate samples of all of these to listen to? (y/n)')) {
    const sampleDir = path.join(ROOT, 'work', 'voice-samples');
    fs.mkdirSync(sampleDir, { recursive: true });
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
    console.log('\n  Samples are in work/voice-samples/');
    await pause('  Listen, then come back.');
  }

  const pick = parseInt(await ask('Voice number', '1'), 10);
  const voice = (VOICES[pick - 1] || VOICES[0])[0];
  const rate = await ask('Speed (e.g. +0%, +15%, +25%)', '+15%');
  return { voice, rate };
}

async function main() {
  console.log('\n  shorts-engine setup\n');
  console.log('  Your own character, your own voice, your own keys.');

  line();
  console.log('  What are you setting up?\n');
  console.log('   1. Reaction channel   — a character reacting to clips');
  console.log('   2. Knowledge channel  — narrated explainers over stock footage');
  console.log('   3. Both\n');

  const mode = await ask('Pick', '1');
  const wantsCharacter = mode === '1' || mode === '3';
  const wantsStock = mode === '2' || mode === '3';

  let character = null;
  if (wantsCharacter) character = await buildCharacter();

  const { voice, rate } = await pickVoice();

  // ── keys ───────────────────────────────────────────────────────────────
  let pexels = '';
  let pixabay = '';
  if (wantsStock) {
    line();
    console.log('  STEP 7 — stock footage keys\n');
    console.log('  Both free, about a minute each.\n');
    console.log('    Pexels   https://www.pexels.com/api/');
    console.log('    Pixabay  https://pixabay.com/api/docs/\n');
    pexels = await ask('PEXELS_API_KEY (Enter to skip)', '');
    pixabay = await ask('PIXABAY_API_KEY (Enter to skip)', '');
  }

  line();
  const channelName = await ask('Channel name (shown in the layout header)', 'My Channel');
  const channelHandle = await ask('Channel handle', '@mychannel');

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
    `CHANNEL_NAME=${channelName}`,
    `CHANNEL_HANDLE=${channelHandle}`,
    '',
  ].join('\n');

  if (fs.existsSync(envPath)) {
    fs.copyFileSync(envPath, `${envPath}.backup`);
    console.log('\n  (existing .env backed up to .env.backup)');
  }
  fs.writeFileSync(envPath, env);

  line();
  console.log('  Done.\n');
  if (character) console.log(`  Character: character/${character.slug}/`);
  console.log(`  Voice:     ${voice} at ${rate}\n`);
  console.log('  Next:\n');
  if (character) {
    console.log(`    npm run puppet -- --char ${character.slug} --seconds 5`);
    console.log('    npm run grab   -- "<video url>"');
    console.log('    npm run react  -- --script demo');
    console.log(`\n  Point scripts/reactions/demo.json at your clip and set`);
    console.log(`  "character": "${character.slug}".`);
  }
  if (wantsStock) console.log('    npm run make   -- --script red-hull-v2');
  console.log('\n  Drop sound effects into assets/sfx/ when you want them.\n');

  rl.close();
}

main().catch((e) => { console.error(`\n✖ ${e.message}\n`); rl.close(); process.exit(1); });
