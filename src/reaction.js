/**
 * Reaction video renderer.
 *
 * Takes a source clip plus a list of reaction beats and produces a vertical
 * short where the character sits in the corner watching, and at each beat the
 * source freezes while he talks over it.
 *
 * The timeline is built as independent segments rather than one giant filter
 * graph, so any single segment can fail loudly and be inspected on its own:
 *
 *   [source 0..beat1] [freeze + talk] [source beat1..beat2] [freeze + talk] ...
 *
 * Every segment is normalised to the same resolution, fps and audio layout so
 * the concat demuxer can join them without re-encoding surprises.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { dirs } from './config.js';
import { synthesize } from './voice.js';
import { flapWindows, enableExpr, FPS } from './lipsync.js';
import { chunkByWidth } from './captions.js';

const run = promisify(execFile);
const W = 1080;
const H = 1920;
const CHAR_W = 460;
const CHAR_MARGIN = 36;
const SFX_VOLUME = 0.35;

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
};

const ff = (args, opts = {}) =>
  run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 1 << 28, ...opts });

async function probe(file, entries) {
  const { stdout } = await run(ffprobeStatic.path,
    ['-v', 'error', '-show_entries', entries, '-of', 'default=nw=1:nk=1', file]);
  return stdout.trim().split('\n');
}

/** Resolves a filename against assets/<kind>/, returning null if absent. */
function asset(kind, name) {
  if (!name) return null;
  const file = path.isAbsolute(name) ? name : path.join(process.cwd(), 'assets', kind, name);
  return fs.existsSync(file) ? file : null;
}

const ts = (s) => {
  const cs = Math.round(s * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const sec = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};

/** Caption-only ASS for one spoken line, timed from zero. */
function writeLineAss(words, file) {
  const SIZE = 74;
  const head = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Cap,Impact,${SIZE},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,6,3,2,80,80,640,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    '',
  ].join('\n');

  const ev = [];
  for (const card of chunkByWidth(words, W - 260, SIZE)) {
    for (let i = 0; i < card.length; i++) {
      const start = card[i].start;
      const end = i + 1 < card.length ? card[i + 1].start : card[card.length - 1].end;
      const text = card.map((w, j) => {
        const label = w.text.toUpperCase().replace(/[{}\\]/g, '');
        return j === i ? `{\\c&H00E0FF&}${label}{\\c&HFFFFFF&}` : label;
      }).join(' ');
      ev.push(`Dialogue: 0,${ts(start)},${ts(Math.max(end, start + 0.05))},Cap,,0,0,0,,${text}`);
    }
  }
  fs.writeFileSync(file, head + ev.join('\n') + '\n', 'utf8');
}

/**
 * Caption for a pre-recorded voice drop.
 *
 * A drop is just an audio file, so there are no word timings to highlight
 * against. The line is held as one static card for the whole beat instead.
 */
function writeStaticAss(text, duration, file) {
  const SIZE = 74;
  const head = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Cap,Impact,${SIZE},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,6,3,2,80,80,640,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    '',
  ].join('\n');

  const label = String(text || '').toUpperCase().replace(/[{}\\]/g, '');
  const body = label
    ? `Dialogue: 0,${ts(0)},${ts(duration)},Cap,,0,0,0,,${label}\n`
    : '';
  fs.writeFileSync(file, head + body, 'utf8');
}

const COVER = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},setsar=1`;
const CHAR_POS = `overlay=W-w-${CHAR_MARGIN}:H-h-${CHAR_MARGIN}`;

/** Source plays, character watches with mouth shut. */
async function watchSegment({ source, closed, hasAudio, start, dur, out }) {
  const args = ['-ss', String(start), '-t', String(dur), '-i', source, '-loop', '1', '-i', closed];
  if (!hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo');
  args.push(
    '-filter_complex',
    `[0:v]${COVER}[v0];[1:v]scale=${CHAR_W}:-1[ch];[v0][ch]${CHAR_POS}[v]`,
    '-map', '[v]', '-map', hasAudio ? '0:a' : '2:a',
    '-t', String(dur),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2', out,
  );
  await ff(args);
}

async function main() {
  const slug = arg('script');
  if (!slug) {
    console.error('usage: node src/reaction.js --script <name>   (scripts/reactions/<name>.json)');
    process.exit(1);
  }

  const docFile = path.join(dirs.scripts, 'reactions', `${slug}.json`);
  if (!fs.existsSync(docFile)) throw new Error(`No reaction script at ${docFile}`);
  const doc = JSON.parse(fs.readFileSync(docFile, 'utf8'));

  const source = path.isAbsolute(doc.source) ? doc.source : path.join(process.cwd(), doc.source);
  if (!fs.existsSync(source)) throw new Error(`Source clip not found: ${source}`);

  const charDir = path.join(process.cwd(), 'character', doc.character || 'lilwoof-v2');
  const closed = path.join(charDir, 'closed.png');
  const open = path.join(charDir, 'open.png');
  for (const f of [closed, open]) {
    if (!fs.existsSync(f)) throw new Error(`Missing character art: ${f}`);
  }

  const hz = doc.flapHz || 3;
  const halfAlpha = doc.halfAlpha ?? 0.55;

  const [durStr] = await probe(source, 'format=duration');
  const srcDur = parseFloat(durStr);
  const streams = await probe(source, 'stream=codec_type').catch(() => []);
  const hasAudio = streams.includes('audio');

  console.log(`\n▶ ${doc.title}`);
  console.log(`  source ${srcDur.toFixed(1)}s · ${doc.beats.length} beats · source audio ${hasAudio ? 'yes' : 'no'}\n`);

  const segDir = path.join(dirs.work, 'reaction', slug);
  fs.rmSync(segDir, { recursive: true, force: true });
  fs.mkdirSync(segDir, { recursive: true });

  const segments = [];
  let cursor = 0;
  let n = 0;
  const beats = [...doc.beats].sort((a, b) => a.at - b.at);

  for (const beat of beats) {
    const at = Math.min(beat.at, srcDur);

    if (at > cursor + 0.05) {
      const seg = path.join(segDir, `s${String(n++).padStart(3, '0')}.mp4`);
      await watchSegment({ source, closed, hasAudio, start: cursor, dur: at - cursor, out: seg });
      segments.push(seg);
      console.log(`  watch  ${cursor.toFixed(2)} -> ${at.toFixed(2)}`);
    }

    const frame = path.join(segDir, `f${n}.png`);
    await ff(['-ss', String(at), '-i', source, '-frames:v', '1', frame]);

    const assFile = path.join(segDir, `c${n}.ass`);
    const drop = asset('voice-drops', beat.voiceDrop);
    let lineAudio;
    let duration;
    let words;

    if (drop) {
      // A drop is pre-recorded, so there are no word timings. Treat the whole
      // file as one continuous "word" and let the mouth flap right through it.
      lineAudio = drop;
      const [d] = await probe(drop, 'format=duration');
      duration = parseFloat(d) || 1;
      words = [{ text: beat.line || '', start: 0, end: duration }];
      writeStaticAss(beat.line, duration, assFile);
    } else {
      lineAudio = path.join(segDir, `a${n}.mp3`);
      ({ words, duration } = await synthesize(beat.line, lineAudio));
      writeLineAss(words, assFile);
    }

    const hold = duration + 0.25;
    const { full, half } = flapWindows(words, hz, hold);

    const sfx = asset('sfx', beat.sfx);
    const dim = beat.dim === false ? '' : ',eq=brightness=-0.06';
    const seg = path.join(segDir, `s${String(n++).padStart(3, '0')}.mp4`);

    const inputs = [
      '-loop', '1', '-t', String(hold), '-i', frame,
      '-loop', '1', '-i', closed,
      '-loop', '1', '-i', open,
      '-i', lineAudio,
    ];

    let audioChain = '';
    let aMap = '3:a';
    if (sfx) {
      inputs.push('-i', sfx);
      // Mixed under the voice, not over it: the effect punctuates the line.
      audioChain = `;[4:a]volume=${SFX_VOLUME}[sx];`
        + `[3:a][sx]amix=inputs=2:duration=first:dropout_transition=0[a]`;
      aMap = '[a]';
    }

    await ff([
      ...inputs,
      '-filter_complex',
        `[0:v]${COVER}${dim}[bgv];`
      + `[1:v]scale=${CHAR_W}:-1[c];`
      + `[2:v]scale=${CHAR_W}:-1,format=rgba,split=2[of][oh0];`
      + `[oh0]colorchannelmixer=aa=${halfAlpha}[oh];`
      + `[bgv][c]${CHAR_POS}[b1];`
      + `[b1][oh]${CHAR_POS}:enable='${enableExpr(half)}'[b2];`
      + `[b2][of]${CHAR_POS}:enable='${enableExpr(full)}'[b3];`
      + `[b3]subtitles=${path.basename(assFile)}[v]`
      + audioChain,
      '-map', '[v]', '-map', aMap,
      '-t', String(hold),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2', seg,
    ], { cwd: segDir });

    segments.push(seg);
    const tags = [drop ? 'drop' : 'tts', sfx ? 'sfx' : null].filter(Boolean).join('+');
    console.log(`  react  @${at.toFixed(2)}  ${hold.toFixed(2)}s  [${tags}]`);
    cursor = at;
  }

  if (doc.playToEnd !== false && cursor < srcDur - 0.1) {
    const seg = path.join(segDir, `s${String(n++).padStart(3, '0')}.mp4`);
    await watchSegment({ source, closed, hasAudio, start: cursor, dur: srcDur - cursor, out: seg });
    segments.push(seg);
    console.log(`  watch  ${cursor.toFixed(2)} -> ${srcDur.toFixed(2)}`);
  }

  const listFile = path.join(segDir, 'list.txt');
  fs.writeFileSync(listFile, segments.map((s) => `file '${s.replace(/\\/g, '/')}'`).join('\n'));

  const outFile = path.join(dirs.out, `${slug}.mp4`);
  await ff(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outFile]);

  const [outDur] = await probe(outFile, 'format=duration');
  const mb = (fs.statSync(outFile).size / 1048576).toFixed(1);
  console.log(`\n✅ ${outFile}  (${mb} MB, ${parseFloat(outDur).toFixed(1)}s)\n`);
}

main().catch((e) => { console.error(`\n✖ ${e.message}\n`); process.exit(1); });
