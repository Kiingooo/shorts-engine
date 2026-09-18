/** Renders the episode-1 hook in each shortlisted voice for approval. */
import fs from 'node:fs';
import path from 'node:path';
import { config, dirs } from './config.js';

const LINE = 'Look at the front of any massive cargo ship, and you will find something that makes no sense. A giant steel bulb, bolted to the very bottom of the bow.';

const SHORTLIST = [
  ['Brian',   'nPczCjzI2devNBz1zQrb'],
  ['Daniel',  'onwK4e9ZLuTAKqWW03F9'],
  ['George',  'JBFqnCBsd6RMkjVDRZzb'],
  ['Eric',    'cjVigY5qzO86Huf0OWal'],
  ['Bill',    'pqHfZKP75CvOlQylNhV4'],
];

const outDir = path.join(dirs.work, 'voice-samples');
fs.mkdirSync(outDir, { recursive: true });

for (const [name, id] of SHORTLIST) {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${id}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { 'xi-api-key': config.elevenKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: LINE,
        model_id: config.elevenModel,
        voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.3, use_speaker_boost: true },
      }),
    },
  );
  if (!res.ok) { console.error(`${name}: ${res.status} ${(await res.text()).slice(0, 200)}`); continue; }
  const file = path.join(outDir, `${name}.mp3`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  console.log(`✓ ${name.padEnd(8)} ${id}  ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
}
