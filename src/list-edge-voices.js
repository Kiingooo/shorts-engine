import { listVoicesUniversal } from 'edge-tts-universal';

const voices = await listVoicesUniversal();
const en = voices.filter((v) => v.Locale?.startsWith('en-') && /Male/.test(v.Gender));

console.log(`total en-* male voices: ${en.length}\n`);
for (const v of en) {
  const styles = v.VoiceTag?.VoicePersonalities?.join(', ') || '';
  console.log(`${v.ShortName.padEnd(28)} ${v.Locale.padEnd(8)} ${styles}`);
}
