/**
 * Verifies the voiceover cache short-circuits before any network call.
 * Uses a deliberately invalid API key: if the cache works, synthesize()
 * succeeds anyway; if it leaks through to the API, it throws 401.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, dirs } from './config.js';
import { synthesize } from './voice.js';

const TEXT = 'Cache verification sentence, never sent to the API.';

const key = crypto.createHash('sha1')
  .update(`${config.voiceId}|${config.elevenModel}|${TEXT}`)
  .digest('hex').slice(0, 16);

const audio = path.join(dirs.cache, `tts_${key}.mp3`);
const meta = path.join(dirs.cache, `tts_${key}.json`);

// Plant a fake cache entry.
fs.writeFileSync(audio, Buffer.from('fake-audio-bytes'));
fs.writeFileSync(meta, JSON.stringify({
  chars: [...'hello'], starts: [0, 0.1, 0.2, 0.3, 0.4], ends: [0.1, 0.2, 0.3, 0.4, 0.5], duration: 0.5,
}));

config.elevenKey = 'invalid-key-would-401-if-network-were-hit';

const out = path.join(dirs.work, 'cache-test.mp3');
try {
  const r = await synthesize(TEXT, out);
  console.log(`✅ served from cache — duration ${r.duration}s, no API call made`);
} catch (e) {
  console.log(`✖ cache MISSED, hit the network: ${e.message.slice(0, 120)}`);
} finally {
  for (const f of [audio, meta, out]) fs.rmSync(f, { force: true });
}
