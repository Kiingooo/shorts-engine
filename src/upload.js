/**
 * Uploads a finished video to Cloudflare R2 and prints its public link.
 *
 *   node src/upload.js out/<id>.mp4
 *
 * The posting tool needs a URL it can fetch the file from, so the video goes
 * into a bucket that has its public r2.dev address switched on. Uploading is
 * done through wrangler, which is already logged in on the machine, so no
 * storage keys live in this project.
 *
 * .env (all optional, these are the defaults):
 *   R2_BUCKET=shortvidengine
 *   R2_PUBLIC_URL=https://pub-d882bda4ebf948e5a75807e5ba096751.r2.dev
 *   CLOUDFLARE_ACCOUNT_ID=ffcf73f6278d1f8770ea7d9e29532e0e
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import './config.js';

const run = promisify(execFile);

const BUCKET = process.env.R2_BUCKET || 'shortvidengine';
const PUBLIC_URL = (process.env.R2_PUBLIC_URL || 'https://pub-d882bda4ebf948e5a75807e5ba096751.r2.dev').replace(/\/$/, '');
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || 'ffcf73f6278d1f8770ea7d9e29532e0e';

/** Uploads a file and returns the public link to it. */
export async function upload(file, { prefix = 'videos' } = {}) {
  if (!fs.existsSync(file)) throw new Error(`No such file: ${file}`);
  const name = path.basename(file).replace(/[^A-Za-z0-9._-]/g, '_');
  const key = `${prefix}/${name}`;

  try {
    await run('npx', ['--yes', 'wrangler', 'r2', 'object', 'put', `${BUCKET}/${key}`,
      '--file', file, '--content-type', 'video/mp4', '--remote'], {
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
      maxBuffer: 1 << 26,
      shell: process.platform === 'win32',
    });
  } catch (e) {
    throw new Error(`wrangler upload failed: ${String(e.stderr || e.stdout || e.message).slice(-400)}`);
  }

  // Trust the link, not wrangler's exit code: fetch one byte and compare size.
  const url = `${PUBLIC_URL}/${key}`;
  const size = fs.statSync(file).size;
  const res = await fetch(url, { method: 'HEAD' });
  if (!res.ok) throw new Error(`Uploaded, but ${url} answers ${res.status}`);
  const remote = Number(res.headers.get('content-length'));
  if (remote !== size) throw new Error(`Size mismatch: local ${size}, remote ${remote}`);
  return { key, url };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('usage: npm run upload -- out/<id>.mp4');
    process.exitCode = 1;
  } else {
    upload(path.resolve(file))
      .then((r) => { console.log(`\n✅ uploaded ${r.key}\n\n${r.url}\n`); })
      .catch((e) => { console.error(`\n✖ ${e.message}\n`); process.exitCode = 1; });
  }
}
