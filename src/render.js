import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { config, dirs } from './config.js';

const run = promisify(execFile);
const { width: W, height: H, fps: FPS } = config;

async function ffmpeg(args, opts = {}) {
  return run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 1 << 28, ...opts });
}

export async function probeDuration(file) {
  const { stdout } = await run(ffprobeStatic.path, [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
  ]);
  return parseFloat(stdout.trim()) || 0;
}

/**
 * Normalize one visual into a silent clip of an exact size and duration.
 * Video is cover-cropped; stills get a slow Ken Burns push so nothing on
 * screen is ever completely static.
 */
async function makeSegment(clip, duration, outFile, index, w, h) {
  const frames = Math.max(2, Math.round(duration * FPS));

  if (clip.still) {
    // zoompan emits `d` frames per INPUT frame, so the input must stay a
    // single frame and the output is capped with -frames:v.
    const SW = Math.round(w * 1.4);
    const SH = Math.round(h * 1.4);
    const z = index % 2 === 0
      ? `min(1.001+0.00035*on,1.14)`
      : `max(1.14-0.00035*on,1.001)`;
    const zoom = `zoompan=z='${z}':d=${frames}`
      + `:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${w}x${h}:fps=${FPS}`;
    await ffmpeg([
      '-loop', '1', '-i', clip.file,
      '-vf', `scale=${SW}:${SH}:force_original_aspect_ratio=increase,crop=${SW}:${SH},${zoom},setsar=1`,
      '-frames:v', String(frames),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-an', outFile,
    ]);
    return outFile;
  }

  const src = await probeDuration(clip.file);
  // Skip the first moment of stock clips - they often start on a slate/fade.
  const startAt = src > duration + 1.2 ? Math.min(0.6, src - duration) : 0;
  const loop = src < duration ? ['-stream_loop', '-1'] : [];

  await ffmpeg([
    ...loop, '-ss', String(startAt), '-t', String(duration), '-i', clip.file,
    '-vf', `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},fps=${FPS},setsar=1`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-an', outFile,
  ]);
  return outFile;
}

/**
 * Builds the video. Each scene is split across its two visuals so the picture
 * changes mid-sentence. With `panel` set, footage is rendered at panel size and
 * composited onto a white frame (tweet-style layout); without it, footage fills
 * the frame. The ASS overlay is burned in last, then audio is mixed.
 */
export async function renderVideo({ scenes, audioFile, assFile, outFile, musicFile, panel }) {
  const vidW = panel ? panel.w : W;
  const vidH = panel ? panel.h : H;

  const segDir = path.join(dirs.work, 'segments');
  fs.rmSync(segDir, { recursive: true, force: true });
  fs.mkdirSync(segDir, { recursive: true });

  const segments = [];
  let i = 0;
  for (const scene of scenes) {
    const total = Math.max(0.6, scene.end - scene.start);
    const each = total / scene.clips.length;
    for (const clip of scene.clips) {
      const out = path.join(segDir, `seg_${String(i).padStart(3, '0')}.mp4`);
      await makeSegment(clip, each, out, i, vidW, vidH);
      segments.push(out);
      i++;
    }
  }

  const listFile = path.join(segDir, 'list.txt');
  fs.writeFileSync(listFile, segments.map((s) => `file '${s.replace(/\\/g, '/')}'`).join('\n'));

  const joined = path.join(dirs.work, 'joined.mp4');
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', joined]);

  // libass on Windows can't parse the drive-letter colon inside a filter
  // string, so ffmpeg runs from the subtitle's directory with a bare name.
  const assDir = path.dirname(assFile);
  const assName = path.basename(assFile);

  const inputs = [];
  let filter = '';
  let vLabel;

  if (panel) {
    inputs.push('-f', 'lavfi', '-i', `color=white:s=${W}x${H}:r=${FPS}`);
    inputs.push('-i', joined, '-i', audioFile);
    filter += `[0:v][1:v]overlay=${panel.x}:${panel.y}:shortest=1[comp];`
      + `[comp]subtitles=${assName}[v]`;
    vLabel = '[v]';
  } else {
    inputs.push('-i', joined, '-i', audioFile);
    filter += `[0:v]subtitles=${assName}[v]`;
    vLabel = '[v]';
  }

  const audioIdx = panel ? 2 : 1;
  let aMap = `${audioIdx}:a`;

  if (musicFile && fs.existsSync(musicFile)) {
    inputs.push('-stream_loop', '-1', '-i', musicFile);
    const musicIdx = audioIdx + 1;
    filter += `;[${musicIdx}:a]volume=0.10[m];[${audioIdx}:a][m]amix=inputs=2:duration=first:dropout_transition=0[a]`;
    aMap = '[a]';
  }

  await ffmpeg([
    ...inputs,
    '-filter_complex', filter,
    '-map', vLabel, '-map', aMap,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart',
    outFile,
  ], { cwd: assDir });

  return outFile;
}
