/**
 * Renders the full video with a synthetic silent audio track and estimated
 * word timings, so the ffmpeg chain can be verified before any paid TTS call.
 * Same code path as index.js apart from voice.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import { dirs } from './config.js';
import { resolveFootage } from './footage.js';
import { sceneTimings } from './voice.js';
import { writeLayoutAss } from './layout.js';
import { renderVideo } from './render.js';

const run = promisify(execFile);
const WPS = 2.9; // words per second, roughly ElevenLabs narration pace

const slug = process.argv[process.argv.indexOf('--script') + 1];
const doc = JSON.parse(fs.readFileSync(path.join(dirs.scripts, `${slug}.json`), 'utf8'));

console.log(`\n▶ DRY RUN — ${doc.title}\n`);
console.log('1/4  footage');
const withClips = await resolveFootage(doc.scenes);

console.log('\n2/4  fake timings');
const words = [];
let cursor = 0;
for (const scene of doc.scenes) {
  for (const w of scene.text.trim().split(/\s+/)) {
    const dur = Math.max(0.16, w.length * 0.055);
    words.push({ text: w, start: cursor, end: cursor + dur });
    cursor += dur + 0.06;
  }
  cursor += 0.12; // small breath between scenes
}
const total = cursor;
const timed = sceneTimings(withClips, words, total);
console.log(`  ${words.length} words · ${total.toFixed(1)}s`);

console.log('\n3/4  layout + captions');
const assFile = path.join(dirs.work, `${slug}.dry.ass`);
const { panel } = writeLayoutAss({ hook: doc.hook || doc.scenes[0].text, scenes: timed, duration: total, file: assFile });

const audioFile = path.join(dirs.work, `${slug}.silent.m4a`);
await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', String(total), '-c:a', 'aac', audioFile]);

console.log('\n4/4  render');
const outFile = path.join(dirs.out, `${slug}.dryrun.mp4`);
await renderVideo({ scenes: timed, audioFile, assFile, outFile, panel });
console.log(`\n✅ ${outFile}  (${(fs.statSync(outFile).size / 1048576).toFixed(1)} MB)\n`);
