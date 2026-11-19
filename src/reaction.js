/**
 * Reaction video renderer.
 *
 * The source clip plays straight through, never pausing, while the character
 * watches and talks over it. The clip's own audio ducks under his voice and
 * comes back up when he stops.
 *
 *   node src/reaction.js --script <name>      (scripts/reactions/<name>.json)
 *
 * The character has three kinds of footage, all pre-rendered with alpha so
 * no 3D software is needed at render time:
 *
 *   reactions/idle.webm     looping, shown whenever he is doing nothing else
 *   closed.png + open.png   the two talking states, flapped from word timings
 *   reactions/<name>.webm   one-shot reactions (laugh, shock, nod, ...)
 *
 * Exactly one of them is visible on any frame. A character folder without a
 * reactions/ directory still works: it just holds closed.png when idle.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { ROOT, dirs } from './config.js';
import { synthesize } from './voice.js';
import { flapWindows, enableExpr, FPS } from './lipsync.js';
import { chunkByWidth } from './captions.js';
import { markUsed } from './hunt.js';

const run = promisify(execFile);
const W = 1080;
const H = 1920;
const SFX_VOLUME = 0.35;
const DUCK = 0.22;          // source volume while he talks
const GAP = 0.3;            // breath between two lines

// Landscape sources sit in a panel with the character underneath.
const PANEL_Y = 250;
const PANEL_H = 960;
const STACK_CHAR_W = 840;
const STACK_CHAR_Y = H - STACK_CHAR_W + 70;
// Portrait sources fill the frame with the character in the corner.
const CORNER_CHAR_W = 460;
const CORNER_MARGIN = 36;

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
};

const ff = (args, opts = {}) =>
  run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 1 << 28, ...opts });

async function probe(file, entries, extra = []) {
  const { stdout } = await run(ffprobeStatic.path,
    ['-v', 'error', ...extra, '-show_entries', entries, '-of', 'default=nw=1:nk=1', file]);
  return stdout.trim().split(/\r?\n/);
}

/** Resolves a filename against assets/<kind>/, returning null if absent. */
function asset(kind, name) {
  if (!name) return null;
  const file = path.isAbsolute(name) ? name : path.join(ROOT, 'assets', kind, name);
  return fs.existsSync(file) ? file : null;
}

const ts = (s) => {
  const cs = Math.round(s * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const sec = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};

const clean = (s) => String(s || '').toUpperCase().replace(/[{}\\]/g, '');

/** One ASS file for the whole video: the hook on top, word captions below. */
function writeAss({ file, hook, lines, total, capMarginV }) {
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
    `Style: Cap,Impact,${SIZE},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,6,3,2,80,80,${capMarginV},1`,
    'Style: Hook,Impact,84,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,6,3,8,60,60,54,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    '',
  ].join('\n');

  const ev = [];
  if (hook) ev.push(`Dialogue: 0,${ts(0)},${ts(total)},Hook,,0,0,0,,${clean(hook)}`);

  for (const line of lines) {
    if (line.static) {
      if (line.text) ev.push(`Dialogue: 1,${ts(line.start)},${ts(line.end)},Cap,,0,0,0,,${clean(line.text)}`);
      continue;
    }
    for (const card of chunkByWidth(line.words, W - 200, SIZE)) {
      for (let i = 0; i < card.length; i++) {
        const start = card[i].start;
        const end = i + 1 < card.length ? card[i + 1].start : card[card.length - 1].end;
        const text = card.map((w, j) => {
          const label = clean(w.text);
          return j === i ? `{\\c&H00E0FF&}${label}{\\c&HFFFFFF&}` : label;
        }).join(' ');
        ev.push(`Dialogue: 1,${ts(start)},${ts(Math.max(end, start + 0.05))},Cap,,0,0,0,,${text}`);
      }
    }
  }
  fs.writeFileSync(file, head + ev.join('\n') + '\n', 'utf8');
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

  const source = path.isAbsolute(doc.source) ? doc.source : path.join(ROOT, doc.source);
  if (!fs.existsSync(source)) throw new Error(`Source clip not found: ${source}`);

  const charDir = path.join(ROOT, 'character', doc.character || 'lilwoof-3d');
  const closed = path.join(charDir, 'closed.png');
  const open = path.join(charDir, 'open.png');
  for (const f of [closed, open]) {
    if (!fs.existsSync(f)) throw new Error(`Missing character art: ${f}`);
  }
  const loopFile = (name) => {
    const f = path.join(charDir, 'reactions', `${name}.webm`);
    return name && fs.existsSync(f) ? f : null;
  };
  const idle = loopFile('idle');

  const hz = doc.flapHz || 3;
  const halfAlpha = doc.halfAlpha ?? 0.55;

  const [durStr] = await probe(source, 'format=duration');
  const srcDur = parseFloat(durStr);
  const streams = await probe(source, 'stream=codec_type').catch(() => []);
  const hasAudio = streams.includes('audio');
  const [sw, sh] = (await probe(source, 'stream=width,height', ['-select_streams', 'v:0'])).map(Number);
  const stack = sw > sh;
  const CHAR_W = stack ? STACK_CHAR_W : CORNER_CHAR_W;
  const charPos = stack
    ? `overlay=${Math.round((W - CHAR_W) / 2)}:${STACK_CHAR_Y}`
    : `overlay=W-w-${CORNER_MARGIN}:H-h-${CORNER_MARGIN}`;

  console.log(`\n▶ ${doc.title}`);
  console.log(`  source ${srcDur.toFixed(1)}s ${sw}x${sh} · ${doc.beats.length} beats · layout ${stack ? 'stack' : 'corner'}\n`);

  const segDir = path.join(dirs.work, 'reaction', slug);
  fs.rmSync(segDir, { recursive: true, force: true });
  fs.mkdirSync(segDir, { recursive: true });

  // ---- timeline ----------------------------------------------------------
  // Walk the beats in order. A beat starts at its timestamp unless the
  // previous one is still running, in which case it waits for it to finish.
  const talks = [];     // { start, end, words, audio, sfx, static, text }
  const reacts = [];    // { start, end, file, plays }
  let cursor = 0;
  let n = 0;

  for (const beat of [...doc.beats].sort((a, b) => a.at - b.at)) {
    let t = Math.max(beat.at, cursor);

    const loop = loopFile(beat.reaction);
    if (loop) {
      const [d] = await probe(loop, 'format=duration');
      const one = parseFloat(d) || 1;
      const plays = Math.max(1, beat.reactionPlays || 1);
      reacts.push({ start: t, end: t + one * plays, file: loop, plays });
      console.log(`  ${beat.reaction.padEnd(6)} @${t.toFixed(2)}  ${(one * plays).toFixed(2)}s`);
      t += one * plays;
      cursor = t;
    }

    const drop = asset('voice-drops', beat.voiceDrop);
    if (!beat.line && !drop) continue;

    let audio;
    let duration;
    let words;
    if (drop) {
      // Pre-recorded, so no word timings: flap straight through the file.
      audio = drop;
      const [d] = await probe(drop, 'format=duration');
      duration = parseFloat(d) || 1;
      words = [{ text: beat.line || '', start: 0, end: duration }];
    } else {
      audio = path.join(segDir, `a${n}.mp3`);
      ({ words, duration } = await synthesize(beat.line, audio));
    }
    n++;

    talks.push({
      start: t,
      end: t + duration,
      words: words.map((w) => ({ ...w, start: w.start + t, end: w.end + t })),
      audio,
      sfx: asset('sfx', beat.sfx),
      static: Boolean(drop),
      text: beat.line,
    });
    console.log(`  talk   @${t.toFixed(2)}  ${duration.toFixed(2)}s  ${drop ? '[drop]' : ''}`);
    cursor = t + duration + GAP;
  }

  const total = doc.playToEnd === false ? cursor : Math.max(srcDur, cursor);

  // ---- captions ----------------------------------------------------------
  const assFile = path.join(segDir, 'subs.ass');
  writeAss({
    file: assFile,
    hook: doc.hook,
    lines: talks,
    total,
    capMarginV: stack ? H - (PANEL_Y + PANEL_H) + 24 : 640,
  });

  // ---- inputs ------------------------------------------------------------
  const inputs = ['-i', source];
  let idx = 1;
  const add = (...a) => { inputs.push(...a); return idx++; };

  const iIdle = idle
    ? add('-stream_loop', '-1', '-c:v', 'libvpx-vp9', '-i', idle)
    : add('-loop', '1', '-framerate', String(FPS), '-i', closed);
  const iClosed = add('-loop', '1', '-framerate', String(FPS), '-i', closed);
  const iOpen = add('-loop', '1', '-framerate', String(FPS), '-i', open);
  for (const r of reacts) {
    r.input = add('-stream_loop', String(r.plays - 1), '-c:v', 'libvpx-vp9', '-i', r.file);
  }
  for (const t of talks) {
    t.aIn = add('-i', t.audio);
    if (t.sfx) t.sIn = add('-i', t.sfx);
  }
  const iSilence = hasAudio ? null : add('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo');

  // ---- video graph -------------------------------------------------------
  const win = (list) => list.map((x) => [x.start, x.end]);
  const talkExpr = enableExpr(win(talks));
  const busyExpr = enableExpr([...win(talks), ...win(reacts)]);

  const flaps = { full: [], half: [] };
  for (const t of talks) {
    const f = flapWindows(t.words, hz, t.end);
    flaps.full.push(...f.full);
    flaps.half.push(...f.half);
  }

  const pad = total > srcDur ? `,tpad=stop_mode=clone:stop_duration=${(total - srcDur + 0.5).toFixed(2)}` : '';
  const g = [];

  if (stack) {
    g.push(`[0:v]fps=${FPS},setsar=1${pad},split=2[sa][sb]`);
    g.push(`[sa]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=28:4,eq=brightness=-0.22[bg]`);
    g.push(`[sb]scale=-2:${PANEL_H},crop=${W}:${PANEL_H}[panel]`);
    g.push(`[bg][panel]overlay=0:${PANEL_Y}[base]`);
  } else {
    g.push(`[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},setsar=1${pad}[base]`);
  }

  const sc = `scale=${CHAR_W}:-1,format=rgba`;
  g.push(`[${iIdle}:v]fps=${FPS},${sc}[cidle]`);
  g.push(`[${iClosed}:v]${sc}[cclosed]`);
  g.push(`[${iOpen}:v]${sc},split=2[cfull][chalf0]`);
  g.push(`[chalf0]colorchannelmixer=aa=${halfAlpha}[chalf]`);

  let last = 'base';
  let k = 0;
  const lay = (src, enable, extra = '') => {
    const out = `v${k++}`;
    g.push(`[${last}][${src}]${charPos}:enable='${enable}'${extra}[${out}]`);
    last = out;
  };
  lay('cidle', `not(${busyExpr})`);
  lay('cclosed', talkExpr);
  lay('chalf', enableExpr(flaps.half));
  lay('cfull', enableExpr(flaps.full));
  for (const r of reacts) {
    g.push(`[${r.input}:v]fps=${FPS},${sc},setpts=PTS+${r.start.toFixed(3)}/TB[r${r.input}]`);
    lay(`r${r.input}`, `between(t,${r.start.toFixed(3)},${r.end.toFixed(3)})`, ':eof_action=pass');
  }
  g.push(`[${last}]subtitles=${path.basename(assFile)}[v]`);

  // ---- audio graph -------------------------------------------------------
  const srcA = hasAudio ? '0:a' : `${iSilence}:a`;
  g.push(`[${srcA}]aresample=44100,aformat=channel_layouts=stereo,apad,`
    + `volume=eval=frame:volume='if(gt(${talkExpr},0),${DUCK},1)'[abed]`);
  const mix = ['[abed]'];
  for (const t of talks) {
    const ms = Math.round(t.start * 1000);
    g.push(`[${t.aIn}:a]aresample=44100,aformat=channel_layouts=stereo,volume=1.6,adelay=${ms}|${ms}[av${t.aIn}]`);
    mix.push(`[av${t.aIn}]`);
    if (t.sfx) {
      g.push(`[${t.sIn}:a]aresample=44100,aformat=channel_layouts=stereo,volume=${SFX_VOLUME},adelay=${ms}|${ms}[as${t.sIn}]`);
      mix.push(`[as${t.sIn}]`);
    }
  }
  g.push(`${mix.join('')}amix=inputs=${mix.length}:duration=longest:normalize=0,alimiter=limit=0.95[a]`);

  const graphFile = path.join(segDir, 'graph.txt');
  fs.writeFileSync(graphFile, g.join(';\n'));

  fs.mkdirSync(dirs.out, { recursive: true });
  const outFile = path.join(dirs.out, `${slug}.mp4`);
  await ff([
    ...inputs,
    '-filter_complex_script', graphFile,
    '-map', '[v]', '-map', '[a]',
    '-t', total.toFixed(3),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2',
    '-movflags', '+faststart', outFile,
  ], { cwd: segDir });

  if (!fs.existsSync(outFile)) throw new Error('ffmpeg finished but wrote no file');
  if (doc.clipSlug) markUsed(doc.clipSlug, { video: `${slug}.mp4` });

  const [outDur] = await probe(outFile, 'format=duration');
  const mb = (fs.statSync(outFile).size / 1048576).toFixed(1);
  console.log(`\n✅ ${outFile}  (${mb} MB, ${parseFloat(outDur).toFixed(1)}s)\n`);
}

main().catch((e) => { console.error(`\n✖ ${String(e.stderr || e.message).slice(0, 1500)}\n`); process.exitCode = 1; });
