import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Tiny .env reader so we don't need a dependency for three keys.
function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, '');
    if (value && !process.env[m[1]]) process.env[m[1]] = value;
  }
}
loadEnv();

export const config = {
  // 'edge' = free Microsoft Edge neural voices, no key.
  // 'elevenlabs' = paid, better delivery.
  provider: (process.env.VOICE_PROVIDER || 'edge').toLowerCase(),
  edgeVoice: process.env.EDGE_VOICE || 'en-US-ChristopherNeural',
  edgeRate: process.env.EDGE_RATE || '+15%',

  elevenKey: process.env.ELEVENLABS_API_KEY || '',
  voiceId: process.env.ELEVENLABS_VOICE_ID || '',
  elevenModel: process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2',
  pexelsKey: process.env.PEXELS_API_KEY || '',
  pixabayKey: process.env.PIXABAY_API_KEY || '',
  width: 1080,
  height: 1920,
  fps: 30,

  // Channel identity shown in the tweet-style header. Change these in one
  // place and every future render picks them up.
  channelName: process.env.CHANNEL_NAME || 'Deep Water',
  channelHandle: process.env.CHANNEL_HANDLE || '@deepwaterfacts',
  avatarColour: process.env.AVATAR_COLOUR || '&H00B07A2A&', // ASS is BGR
};

// Tweet-style layout geometry, all in 1080x1920 space. panelY is NOT set here —
// it's computed in layout.js from the actual wrapped hook height, so a short
// hook doesn't leave a dead gap above the video.
export const layout = {
  pad: 48,
  avatarSize: 92,
  headerY: 56,
  hookMaxLines: 3,
  panelX: 48,
  panelH: 1430,
};

export const dirs = {
  scripts: path.join(ROOT, 'scripts'),
  work: path.join(ROOT, 'work'),
  out: path.join(ROOT, 'out'),
  cache: path.join(ROOT, 'work', 'cache'),
};

for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
