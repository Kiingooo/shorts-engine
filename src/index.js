import fs from 'node:fs';
import path from 'node:path';
import { config, dirs } from './config.js';
import { synthesize, sceneTimings } from './voice.js';
import { resolveFootage } from './footage.js';
import { writeLayoutAss } from './layout.js';
import { renderVideo } from './render.js';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
};

async function main() {
  const slug = arg('script');
  if (!slug) {
    console.error('usage: node src/index.js --script <name>   (file in scripts/<name>.json)');
    process.exit(1);
  }

  const scriptFile = path.join(dirs.scripts, `${slug}.json`);
  if (!fs.existsSync(scriptFile)) throw new Error(`No script at ${scriptFile}`);
  const doc = JSON.parse(fs.readFileSync(scriptFile, 'utf8'));
  const scenes = doc.scenes;

  const narration = scenes.map((s) => s.text.trim()).join(' ');
  const wordCount = narration.split(/\s+/).length;
  console.log(`\n▶ ${doc.title}`);
  console.log(`  ${scenes.length} scenes · ${wordCount} words · ~${(wordCount / 2.9).toFixed(0)}s estimated\n`);

  console.log('1/4  footage');
  const withClips = await resolveFootage(scenes);

  console.log(`\n2/4  voiceover (${config.provider === 'edge' ? `Edge · ${config.edgeVoice}` : 'ElevenLabs'})`);
  const audioFile = path.join(dirs.work, `${slug}.mp3`);
  const alignment = await synthesize(narration, audioFile);
  const words = alignment.words;
  const timed = sceneTimings(withClips, words, alignment.duration);
  console.log(`  ${alignment.duration.toFixed(1)}s of audio, ${words.length} words aligned`);

  console.log('\n3/4  layout + captions');
  const assFile = path.join(dirs.work, `${slug}.ass`);
  const hook = doc.hook || scenes[0].text;
  const { panel } = writeLayoutAss({ hook, scenes: timed, duration: alignment.duration, file: assFile });

  console.log('\n4/4  render');
  const outFile = path.join(dirs.out, `${slug}.mp4`);
  const music = doc.music ? path.join(dirs.work, doc.music) : null;
  await renderVideo({ scenes: timed, audioFile, assFile, outFile, musicFile: music, panel });

  const mb = (fs.statSync(outFile).size / 1048576).toFixed(1);
  console.log(`\n✅ ${outFile}  (${mb} MB, ${config.width}x${config.height})\n`);
}

main().catch((e) => { console.error(`\n✖ ${e.message}\n`); process.exit(1); });
