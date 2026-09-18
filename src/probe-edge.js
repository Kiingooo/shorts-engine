/** Checks what edge-tts-universal exposes and whether word boundaries arrive. */
import * as edge from 'edge-tts-universal';

console.log('exports:', Object.keys(edge).join(', '));

const Comm = edge.Communicate || edge.EdgeTTS || edge.default?.Communicate;
if (!Comm) { console.error('no Communicate export found'); process.exit(1); }

const c = new Comm('Pull any ship out of the water, and the bottom is always the same colour.', {
  voice: 'en-US-AndrewNeural',
});

let audioBytes = 0;
const boundaries = [];
for await (const chunk of c.stream()) {
  if (chunk.type === 'audio') audioBytes += chunk.data?.length || 0;
  if (chunk.type === 'WordBoundary') boundaries.push(chunk);
}

console.log('audio bytes:', audioBytes);
console.log('word boundaries:', boundaries.length);
console.log('first 3:', JSON.stringify(boundaries.slice(0, 3), null, 1));
