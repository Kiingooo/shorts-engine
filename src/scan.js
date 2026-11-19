/**
 * Moment finder.
 *
 * Scans a long recording for loudness spikes, which on a stream are almost
 * always the streamer reacting to something. Returns ranked candidate
 * timestamps so an agent can pick clips without watching anything.
 *
 * Audio is streamed as low-rate mono PCM and reduced to RMS windows in
 * process. ffmpeg's own astats/ebur128 would mean parsing log lines, and a
 * three hour VOD decoded in one buffer is hundreds of megabytes, so neither
 * is worth it.
 *
 *   node src/scan.js --in clips/vod.mp4 [--top 20] [--window 0.5] [--thumbs]
 *
 * Writes work/scan/<name>.json. With --thumbs it also writes a jpg per
 * candidate so the picking step is visual.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { dirs } from './config.js';

const run = promisify(execFile);

const RATE = 4000;      // Hz, mono. Plenty for an energy envelope.
const LEAD = 6;         // seconds of run-up to include before a spike
const TAIL = 14;        // seconds after

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
};
const has = (n) => process.argv.includes(`--${n}`);

function ffprobeBin() {
  return ffprobeStatic.path;
}

/** Streams mono PCM and reduces it to one RMS value per window. */
function rmsWindows(file, windowSec) {
  return new Promise((resolve, reject) => {
    const samplesPerWindow = Math.round(RATE * windowSec);
    const out = [];
    let acc = 0;
    let count = 0;
    let leftover = null;

    const child = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-i', file,
      '-vn', '-ac', '1', '-ar', String(RATE),
      '-f', 's16le', '-',
    ]);

    child.stdout.on('data', (chunk) => {
      let buf = chunk;
      if (leftover) { buf = Buffer.concat([leftover, chunk]); leftover = null; }
      const usable = buf.length - (buf.length % 2);
      if (usable < buf.length) leftover = buf.subarray(usable);

      for (let i = 0; i < usable; i += 2) {
        const v = buf.readInt16LE(i) / 32768;
        acc += v * v;
        count++;
        if (count === samplesPerWindow) {
          out.push(Math.sqrt(acc / count));
          acc = 0;
          count = 0;
        }
      }
    });

    child.stderr.on('data', () => {});
    child.on('error', reject);
    child.on('close', (code) => {
      if (count > 0) out.push(Math.sqrt(acc / count));
      if (code !== 0 && !out.length) return reject(new Error(`ffmpeg exited ${code} with no audio`));
      resolve(out);
    });
  });
}

/**
 * Visual scene cuts.
 *
 * Loudness only separates moments when the audio has quiet stretches, which
 * is true of a stream and false of a trailer or an edited video where music
 * runs wall to wall. There, the signal is how hard the picture changes.
 */
async function sceneCuts(file, threshold) {
  // showinfo prints one line per selected frame on stderr. metadata=print
  // would carry the scene score too, but it writes to a different stream and
  // is fiddlier to parse for no real gain: spacing decides the picks anyway.
  const { stderr } = await run(ffmpegPath, [
    '-hide_banner', '-v', 'info', '-y',
    '-i', file,
    '-filter_complex', `select='gt(scene,${threshold})',showinfo`,
    '-f', 'null', '-',
  ], { maxBuffer: 1 << 28 }).catch((e) => ({ stderr: e.stderr || '' }));

  const out = [];
  const re = /pts_time:([\d.]+)/g;
  let m;
  while ((m = re.exec(String(stderr)))) out.push({ t: parseFloat(m[1]), score: 1 });
  return out;
}

/** Median is used rather than mean: a few very loud moments must not drag the baseline up. */
function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] || 0;
}

async function main() {
  const input = arg('in');
  if (!input) {
    console.error('usage: node src/scan.js --in <video> [--top 20] [--window 0.5] [--thumbs]');
    process.exit(1);
  }
  const file = path.isAbsolute(input) ? input : path.join(process.cwd(), input);
  if (!fs.existsSync(file)) throw new Error(`Not found: ${file}`);

  const top = parseInt(arg('top', '20'), 10);
  const windowSec = parseFloat(arg('window', '0.5'));

  const { stdout: durOut } = await run(ffprobeBin(),
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  const duration = parseFloat(String(durOut).trim()) || 0;

  console.log(`\nscanning ${path.basename(file)}  ${(duration / 60).toFixed(1)} min`);

  const mode = arg('mode', 'auto');
  let hot = [];
  let base = 0;
  let used = mode;

  if (mode !== 'scene') {
    const windows = await rmsWindows(file, windowSec);
    if (!windows.length) throw new Error('No audio found in that file');
    base = median(windows);
    console.log(`  ${windows.length} windows · baseline ${base.toFixed(4)} · peak ${Math.max(...windows).toFixed(4)}`);

    const scored = windows.map((v, i) => ({ t: i * windowSec, v, ratio: base > 0 ? v / base : 0 }));
    hot = scored.filter((w) => w.ratio > 1.6).sort((a, b) => b.ratio - a.ratio);
    used = 'audio';
  }

  // Distinct moments only. Too large and two separate reactions 20s apart
  // collapse into one; too small and a single long reaction eats every slot.
  const MIN_GAP = parseFloat(arg('gap', '12'));
  const spread = (list) => {
    const out = [];
    for (const w of list) {
      if (out.length >= top) break;
      if (out.some((p) => Math.abs(p.t - w.t) < MIN_GAP)) continue;
      out.push(w);
    }
    return out;
  };

  let picked = spread(hot);

  // Wall-to-wall music keeps every window near the baseline, so audio spikes
  // cluster into a handful of places. Judge the fallback on how many DISTINCT
  // moments survived spacing, not on the raw spike count.
  if (mode === 'scene' || (mode === 'auto' && picked.length < top / 2)) {
    if (used === 'audio') console.log(`  only ${picked.length} distinct audio moments, switching to scene cuts`);
    const cuts = await sceneCuts(file, parseFloat(arg('scene', '0.25')));
    console.log(`  ${cuts.length} scene cuts`);
    hot = cuts.map((c) => ({ t: c.t, v: c.score, ratio: +(1 + c.score).toFixed(2) }))
      .sort((a, b) => b.ratio - a.ratio);
    used = 'scene';
    picked = spread(hot);
  }

  picked.sort((a, b) => a.t - b.t);

  const stamp = (s) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  };

  const outDir = path.join(dirs.work, 'scan');
  fs.mkdirSync(outDir, { recursive: true });
  const name = path.basename(file).replace(/\.[^.]+$/, '');

  const candidates = picked.map((w, i) => {
    const start = Math.max(0, w.t - LEAD);
    const end = Math.min(duration, w.t + TAIL);
    return {
      rank: i + 1,
      peakAt: +w.t.toFixed(2),
      peakStamp: stamp(w.t),
      clipStart: +start.toFixed(2),
      clipEnd: +end.toFixed(2),
      loudnessRatio: +w.ratio.toFixed(2),
    };
  });
  candidates.sort((a, b) => b.loudnessRatio - a.loudnessRatio).forEach((c, i) => { c.rank = i + 1; });
  candidates.sort((a, b) => a.peakAt - b.peakAt);

  if (has('thumbs')) {
    const thumbDir = path.join(outDir, name);
    fs.mkdirSync(thumbDir, { recursive: true });
    for (const c of candidates) {
      const out = path.join(thumbDir, `${String(c.rank).padStart(2, '0')}_${c.peakStamp.replace(/:/g, '-')}.jpg`);
      await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y',
        '-ss', String(c.peakAt), '-i', file, '-frames:v', '1', '-q:v', '4', '-vf', 'scale=480:-1', out])
        .catch(() => {});
      c.thumb = path.relative(process.cwd(), out);
    }
    console.log(`  thumbnails in ${path.relative(process.cwd(), thumbDir)}`);
  }

  const jsonFile = path.join(outDir, `${name}.json`);
  fs.writeFileSync(jsonFile, JSON.stringify({
    source: path.relative(process.cwd(), file),
    duration: +duration.toFixed(2),
    mode: used,
    baseline: +base.toFixed(5),
    windowSec,
    candidates,
  }, null, 2));

  console.log(`\n  rank  at         loudness  clip`);
  for (const c of [...candidates].sort((a, b) => a.rank - b.rank)) {
    console.log(`  ${String(c.rank).padStart(4)}  ${c.peakStamp}   ${String(c.loudnessRatio).padStart(5)}x   ${c.clipStart}s -> ${c.clipEnd}s`);
  }
  console.log(`\n✅ ${path.relative(process.cwd(), jsonFile)}\n`);
}

main().catch((e) => { console.error(`\n✖ ${e.message}\n`); process.exit(1); });
