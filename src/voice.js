import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import { config, dirs } from './config.js';

const run = promisify(execFile);

const API = 'https://api.elevenlabs.io/v1';

/**
 * Two voice providers behind one interface, both returning word-level timings
 * so captions stay frame-exact either way:
 *
 *   edge        free, no API key, Microsoft Edge's neural voices.
 *               Emits WordBoundary events directly.
 *   elevenlabs  paid, better delivery. Returns character-level alignment,
 *               which is folded up into words here.
 *
 * Output is cached on disk keyed by provider + voice + text, so re-rendering
 * for layout, footage or caption changes never re-buys narration.
 */

function cacheKey(text) {
  const id = config.provider === 'edge'
    ? `${config.edgeVoice}|${config.edgeRate}`
    : `${config.voiceId}|${config.elevenModel}`;
  return crypto.createHash('sha1').update(`${config.provider}|${id}|${text}`).digest('hex').slice(0, 16);
}

/** Character alignment -> word objects. */
function charsToWords(chars, starts, ends) {
  const words = [];
  let cur = null;
  let tag = 0;
  for (let i = 0; i < chars.length; i++) {
    // Expression tags like [laughs] are performed, not spoken, so they must
    // not turn into caption words or mouth flaps.
    if (chars[i] === '[') { tag++; if (cur) { words.push(cur); cur = null; } continue; }
    if (chars[i] === ']') { tag = Math.max(0, tag - 1); continue; }
    if (tag) continue;
    if (/\s/.test(chars[i])) { if (cur) { words.push(cur); cur = null; } continue; }
    if (!cur) cur = { text: '', start: starts[i], end: ends[i] };
    cur.text += chars[i];
    cur.end = ends[i];
  }
  if (cur) words.push(cur);
  return words;
}

async function synthesizeEleven(text, outFile) {
  if (!config.elevenKey) throw new Error('ELEVENLABS_API_KEY missing (.env)');
  if (!config.voiceId) throw new Error('ELEVENLABS_VOICE_ID missing (.env)');

  const res = await fetch(
    `${API}/text-to-speech/${config.voiceId}/with-timestamps?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { 'xi-api-key': config.elevenKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        model_id: config.elevenModel,
        // v3 and later take their delivery from expression tags in the text
        // and reject the older fine-grained settings.
        ...(/^eleven_v[3-9]/.test(config.elevenModel)
          ? {}
          : { voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.3, use_speaker_boost: true } }),
      }),
    },
  );
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const data = await res.json();
  fs.writeFileSync(outFile, Buffer.from(data.audio_base64, 'base64'));

  const a = data.alignment || data.normalized_alignment;
  if (!a) throw new Error('No alignment returned from ElevenLabs');

  const words = charsToWords(a.characters, a.character_start_times_seconds, a.character_end_times_seconds);
  return { words, duration: words[words.length - 1].end };
}

async function synthesizeEdge(text, outFile) {
  const { Communicate } = await import('edge-tts-universal');
  const c = new Communicate(text, { voice: config.edgeVoice, rate: config.edgeRate });

  const chunks = [];
  const words = [];

  const consume = (async () => {
    for await (const ev of c.stream()) {
      if (ev.type === 'audio' && ev.data) chunks.push(Buffer.from(ev.data));
      // Offsets arrive in 100-nanosecond ticks.
      if (ev.type === 'WordBoundary') {
        words.push({
          text: ev.text,
          start: ev.offset / 1e7,
          end: (ev.offset + ev.duration) / 1e7,
        });
      }
    }
  })();

  // Microsoft's free endpoint can stop answering without closing the socket.
  // The iterator then never settles, Node sees an empty event loop and the
  // whole process exits 0 with no output, which looks like success to any
  // caller. A timeout turns that into a normal, reportable failure.
  const timeoutMs = Number(process.env.EDGE_TIMEOUT_MS || 45000);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Edge TTS timed out after ${timeoutMs}ms (endpoint may have changed; set VOICE_PROVIDER=elevenlabs)`)),
      timeoutMs,
    );
  });

  try {
    await Promise.race([consume, timeout]);
  } finally {
    clearTimeout(timer);
  }

  if (!chunks.length) throw new Error('Edge TTS returned no audio');
  fs.writeFileSync(outFile, Buffer.concat(chunks));

  return { words, duration: words.length ? words[words.length - 1].end : 0 };
}

/**
 * Speeds the finished narration up or down and moves every word timing with
 * it. Done after the cache on purpose: changing VOICE_SPEED re-times audio
 * that is already paid for instead of buying it again.
 */
async function retime(result, speed) {
  if (Math.abs(speed - 1) < 0.01) return result;
  const tmp = result.audioFile.replace(/(\.\w+)$/, '.raw$1');
  fs.renameSync(result.audioFile, tmp);
  await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', tmp,
    '-filter:a', `atempo=${speed}`, result.audioFile]);
  fs.rmSync(tmp, { force: true });
  return {
    ...result,
    duration: result.duration / speed,
    words: result.words.map((w) => ({ ...w, start: w.start / speed, end: w.end / speed })),
  };
}

export async function synthesize(text, outFile) {
  return retime(await synthesizeRaw(text, outFile), config.voiceSpeed);
}

async function synthesizeRaw(text, outFile) {
  const key = cacheKey(text);
  const cachedAudio = path.join(dirs.cache, `tts_${key}.mp3`);
  const cachedMeta = path.join(dirs.cache, `tts_${key}.json`);

  if (fs.existsSync(cachedAudio) && fs.existsSync(cachedMeta)) {
    fs.copyFileSync(cachedAudio, outFile);
    console.log('  (cached voiceover — nothing spent)');
    return { audioFile: outFile, ...JSON.parse(fs.readFileSync(cachedMeta, 'utf8')) };
  }

  const result = config.provider === 'edge'
    ? await synthesizeEdge(text, outFile)
    : await synthesizeEleven(text, outFile);

  fs.copyFileSync(outFile, cachedAudio);
  fs.writeFileSync(cachedMeta, JSON.stringify(result));

  return { audioFile: outFile, ...result };
}

/**
 * Map each scene onto a real time window by walking the word list in order.
 * The word count is exact because the voiceover was generated from the
 * concatenation of these same scene texts.
 */
export function sceneTimings(scenes, words, totalDuration) {
  const out = [];
  let i = 0;
  for (const scene of scenes) {
    const n = scene.text.trim().split(/\s+/).length;
    const slice = words.slice(i, i + n);
    if (!slice.length) throw new Error(`Ran out of words at scene ${scene.id}`);
    out.push({ ...scene, start: slice[0].start, end: slice[slice.length - 1].end, words: slice });
    i += n;
  }

  // Scene windows must tile the WHOLE timeline, not just word-to-word. The
  // pauses between sentences belong to a scene too — otherwise the video is
  // shorter than the narration and `-shortest` truncates the ending.
  for (let k = 0; k < out.length; k++) {
    out[k].start = k === 0 ? 0 : out[k - 1].end;
    out[k].end = k === out.length - 1
      ? Math.max(totalDuration ?? out[k].end, out[k].end)
      : out[k + 1].start;
  }
  return out;
}
