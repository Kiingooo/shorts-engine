/**
 * Finds today's best clips without anyone watching a stream.
 *
 *   node src/hunt.js [--game "Grand Theft Auto VI"] [--top 15] [--lang EN]
 *                    [--period LAST_DAY] [--min 12] [--max 60] [--no-download]
 *
 * Viewers already cut the good moments out of every stream as clips, and the
 * view count on a clip is a vote. So the hunt is: ask Twitch for the most
 * viewed clips in the game's category, rank them by views per hour so fresh
 * clips beat old ones, drop anything used before, download the winners.
 *
 * Uses the same public web endpoint the Twitch site and yt-dlp use. No API
 * key, no account.
 *
 * Output: work/hunt/latest.json plus one mp4 and one contact sheet per clip
 * in clips/hunt/. The sheet is six frames in a grid so whoever writes the
 * lines can see what happens without playing the video.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import { ROOT, dirs } from './config.js';

const run = promisify(execFile);

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
};
const flag = (n) => process.argv.includes(`--${n}`);

const GQL = 'https://gql.twitch.tv/gql';
const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

const HUNT_DIR = path.join(dirs.work, 'hunt');
const CLIP_DIR = path.join(ROOT, 'clips', 'hunt');
const LEDGER = path.join(HUNT_DIR, 'used.json');

const QUERY = `query($game:String!, $period:ClipsPeriod!){
  game(name:$game){
    clips(first:100, criteria:{period:$period}){
      edges{ node{
        slug title viewCount createdAt durationSeconds url language
        broadcaster{ login displayName }
      } }
    }
  }
}`;

// One page only. Twitch refuses a second page without a browser integrity
// token, and the first hundred already holds everything worth using.
async function fetchOnce(game, period) {
  const res = await fetch(GQL, {
    method: 'POST',
    headers: { 'Client-ID': CLIENT_ID, 'content-type': 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { game, period } }),
  });
  if (!res.ok) throw new Error(`Twitch answered ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(`Twitch: ${JSON.stringify(json.errors).slice(0, 200)}`);
  if (!json.data?.game) throw new Error(`No Twitch category called "${game}"`);
  return json.data.game.clips.edges.map((e) => e.node);
}

// Twitch answers "service error" on a fair share of calls for no reason and
// then works on the next one, so a single failure means nothing.
async function fetchClips(game, period) {
  let lastError;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      return await fetchOnce(game, period);
    } catch (e) {
      lastError = e;
      if (/No Twitch category/.test(e.message)) break;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastError;
}

async function download(url, out) {
  await run('yt-dlp', [
    '-f', 'b[ext=mp4]/b', '--no-playlist', '--no-warnings', '--quiet',
    '--ffmpeg-location', path.dirname(ffmpegPath),
    '-o', out, url,
  ], { maxBuffer: 1 << 26, shell: process.platform === 'win32' });
}

/** Six evenly spaced frames in a 3x2 grid. */
async function contactSheet(file, duration, out) {
  const step = Math.max(duration / 6, 0.5);
  await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', file,
    '-vf', `fps=1/${step.toFixed(3)},scale=480:-2,tile=3x2`, '-frames:v', '1', '-q:v', '4', out]);
}

async function main() {
  const game = arg('game', 'Grand Theft Auto VI');
  const top = parseInt(arg('top', '15'), 10);
  const lang = arg('lang', 'EN').toUpperCase();
  const period = arg('period', 'LAST_DAY');
  const minDur = parseFloat(arg('min', '12'));
  const maxDur = parseFloat(arg('max', '60'));
  const perStreamer = parseInt(arg('per-streamer', '2'), 10);

  fs.mkdirSync(HUNT_DIR, { recursive: true });
  fs.mkdirSync(CLIP_DIR, { recursive: true });
  const used = fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, 'utf8')) : {};

  console.log(`\nhunting "${game}" clips, ${period}\n`);
  const raw = await fetchClips(game, period);

  const now = Date.now();
  const seen = new Set();
  const ranked = raw
    .filter((c) => !seen.has(c.slug) && seen.add(c.slug))
    .filter((c) => lang === 'ANY' || c.language === lang)
    .filter((c) => c.durationSeconds >= minDur && c.durationSeconds <= maxDur)
    .filter((c) => !used[c.slug])
    .map((c) => {
      const hours = Math.max((now - Date.parse(c.createdAt)) / 3.6e6, 1);
      return { ...c, hours: +hours.toFixed(1), viewsPerHour: Math.round(c.viewCount / hours) };
    })
    .sort((a, b) => b.viewsPerHour - a.viewsPerHour);

  // One streamer having a huge day should not fill the whole list.
  const count = {};
  const picks = [];
  for (const c of ranked) {
    const who = c.broadcaster?.login || 'unknown';
    if ((count[who] || 0) >= perStreamer) continue;
    count[who] = (count[who] || 0) + 1;
    picks.push(c);
    if (picks.length >= top) break;
  }

  console.log(`  ${raw.length} clips seen, ${ranked.length} usable, taking ${picks.length}\n`);

  const out = [];
  for (const [i, c] of picks.entries()) {
    const id = `${new Date().toISOString().slice(0, 10)}_${String(i + 1).padStart(2, '0')}`;
    const file = path.join(CLIP_DIR, `${id}.mp4`);
    const sheet = path.join(CLIP_DIR, `${id}.jpg`);
    const entry = {
      id,
      rank: i + 1,
      slug: c.slug,
      title: c.title,
      streamer: c.broadcaster?.displayName || c.broadcaster?.login || 'unknown',
      views: c.viewCount,
      viewsPerHour: c.viewsPerHour,
      ageHours: c.hours,
      duration: c.durationSeconds,
      url: c.url,
      file: null,
      sheet: null,
    };

    if (!flag('no-download')) {
      try {
        fs.rmSync(file, { force: true });
        await download(c.url, file);
        if (!fs.existsSync(file)) throw new Error('no file written');
        entry.file = path.relative(ROOT, file).replace(/\\/g, '/');
        await contactSheet(file, c.durationSeconds, sheet).catch(() => {});
        if (fs.existsSync(sheet)) entry.sheet = path.relative(ROOT, sheet).replace(/\\/g, '/');
      } catch (e) {
        console.log(`  ✖ ${id}  download failed: ${String(e.stderr || e.message).slice(0, 160)}`);
        continue;
      }
    }

    out.push(entry);
    console.log(`  ${id}  ${String(entry.viewsPerHour).padStart(6)}/h  ${String(entry.duration).padStart(2)}s  ${entry.streamer}: ${entry.title}`);
  }

  const result = { game, period, huntedAt: new Date().toISOString(), clips: out };
  fs.writeFileSync(path.join(HUNT_DIR, 'latest.json'), JSON.stringify(result, null, 2));
  console.log(`\n✅ ${out.length} clips  ->  work/hunt/latest.json\n`);
}

/**
 * Marks clips as used so the next hunt skips them. Called by the renderer
 * once a video actually exists, not at download time, so a failed render
 * does not burn a good clip.
 */
export function markUsed(slug, meta = {}) {
  fs.mkdirSync(HUNT_DIR, { recursive: true });
  const used = fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, 'utf8')) : {};
  used[slug] = { at: new Date().toISOString(), ...meta };
  fs.writeFileSync(LEDGER, JSON.stringify(used, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
