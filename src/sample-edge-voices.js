import fs from 'node:fs';
import path from 'node:path';
import { Communicate } from 'edge-tts-universal';
import { dirs } from './config.js';

const LINE = 'Pull any ship out of the water, and the bottom is always the same colour.';
const VOICES = ['Christopher', 'Guy', 'Eric', 'Andrew', 'Roger', 'Steffan'];

const outDir = path.join(dirs.work, 'edge-samples');
fs.mkdirSync(outDir, { recursive: true });

for (const name of VOICES) {
  const c = new Communicate(LINE, { voice: `en-US-${name}Neural`, rate: '+15%' });
  const chunks = [];
  for await (const ev of c.stream()) if (ev.type === 'audio' && ev.data) chunks.push(Buffer.from(ev.data));
  const file = path.join(outDir, `${name}.mp3`);
  fs.writeFileSync(file, Buffer.concat(chunks));
  console.log(`✓ ${name}`);
}
