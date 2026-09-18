/** Lists the voices available on the account so one can be picked and approved. */
import { config } from './config.js';

const res = await fetch('https://api.elevenlabs.io/v1/voices', {
  headers: { 'xi-api-key': config.elevenKey },
});
if (!res.ok) {
  console.error(`ERR ${res.status}: ${(await res.text()).slice(0, 400)}`);
  process.exit(1);
}

const { voices } = await res.json();
console.log(`total: ${voices.length}\n`);

for (const v of voices) {
  const l = v.labels || {};
  const bits = [l.gender, l.age, l.accent, l.use_case || l.description].filter(Boolean);
  console.log(`${v.voice_id}  ${v.name}`);
  console.log(`   ${bits.join(' · ') || '-'}`);
  if (v.preview_url) console.log(`   ${v.preview_url}`);
}
