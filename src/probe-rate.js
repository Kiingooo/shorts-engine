import { Communicate } from 'edge-tts-universal';
import fs from 'node:fs';

const text = 'Pull any ship out of the water, and the bottom is always the same colour.';

for (const [label, rate] of [['normal', '+0%'], ['fast', '+18%']]) {
  const c = new Communicate(text, { voice: 'en-US-ChristopherNeural', rate });
  let bytes = 0, lastEnd = 0;
  for await (const ev of c.stream()) {
    if (ev.type === 'audio' && ev.data) bytes += ev.data.length;
    if (ev.type === 'WordBoundary') lastEnd = (ev.offset + ev.duration) / 1e7;
  }
  console.log(`${label.padEnd(8)} rate=${rate.padEnd(6)} bytes=${bytes.toString().padEnd(6)} spoken_duration=${lastEnd.toFixed(2)}s`);
}
