/**
 * Cutout puppet lip sync.
 *
 * The mouth is driven by the word timings the TTS already returns, not by
 * audio analysis: while a word is being spoken the mouth cycles open/closed
 * at FLAP_HZ, between words it stays shut. Deterministic, so a re-render is
 * always identical.
 *
 * Smoothing: with only two mouth states a hard toggle strobes. Each cycle
 * therefore passes through a half-open frame on the way in and on the way
 * out, drawn as the open image at partial alpha. That reads as a soft jaw
 * movement instead of a flicker, without needing a third drawing.
 *
 * Rendering is a single ffmpeg pass using overlay `enable` windows.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import { dirs, config } from './config.js';
import { synthesize } from './voice.js';

const run = promisify(execFile);
const FPS = 30;


const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const CHAR_DIR = path.join(process.cwd(), 'character', arg('char', 'lilwoof-v2'));

/**
 * Returns { full, half } window lists.
 * One cycle = open for the first half, shut for the second, with a single
 * half-alpha frame leading into and out of the open phase.
 */
export function flapWindows(words, hz, limit = Infinity) {
  const cycle = 1 / hz;
  const f = 1 / FPS;
  const full = [];
  const half = [];

  for (const w of words) {
    if (w.start >= limit) break;
    const end = Math.min(w.end, limit);
    for (let t = w.start; t < end; t += cycle) {
      const openStart = t + f;
      const openEnd = Math.min(t + cycle / 2, end);
      if (openStart >= openEnd) continue;
      half.push([t, openStart]);
      full.push([openStart, openEnd]);
      half.push([openEnd, Math.min(openEnd + f, end)]);
    }
  }
  return { full, half };
}

const text = arg('text', 'Yo. They call me Lil Woof, and I am about to explain something you never noticed.');
const seconds = parseFloat(arg('seconds', '5'));
const size = parseInt(arg('size', '1080'), 10);
const hz = parseFloat(arg('hz', '5'));
const halfAlpha = parseFloat(arg('halfAlpha', '0.45'));

const audioFile = path.join(dirs.work, 'puppet.mp3');
console.log(`voice ${config.edgeVoice} ${config.edgeRate} · flap ${hz}Hz`);
const { words, duration } = await synthesize(text, audioFile);

const limit = Math.min(seconds, duration);
const { full, half } = flapWindows(words, hz, limit);
console.log(`${words.length} words · ${full.length} opens · ${limit.toFixed(2)}s`);

const expr = (list) => list.map(([a, b]) => `between(t,${a.toFixed(3)},${b.toFixed(3)})`).join('+') || '0';
const S = Math.round(size * 0.95);

const outFile = path.join(dirs.out, 'lilwoof-demo.mp4');
await run(ffmpegPath, [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-loop', '1', '-i', path.join(CHAR_DIR, 'closed.png'),
  '-loop', '1', '-i', path.join(CHAR_DIR, 'open.png'),
  '-i', audioFile,
  '-filter_complex',
    `color=c=0x0E1116:s=${size}x${size}:r=${FPS}[bg];`
  + `[0:v]scale=${S}:-1[c];`
  + `[1:v]scale=${S}:-1,format=rgba,split=2[of][oh0];`
  + `[oh0]colorchannelmixer=aa=${halfAlpha}[oh];`
  + `[bg][c]overlay=(W-w)/2:(H-h)/2[base];`
  + `[base][oh]overlay=(W-w)/2:(H-h)/2:enable='${expr(half)}'[s1];`
  + `[s1][of]overlay=(W-w)/2:(H-h)/2:enable='${expr(full)}'[v]`,
  '-map', '[v]', '-map', '2:a',
  '-t', String(limit),
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
  outFile,
], { maxBuffer: 1 << 28 });

console.log(`\nOK ${outFile}  (${(fs.statSync(outFile).size / 1048576).toFixed(1)} MB)`);
