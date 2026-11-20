/**
 * Uploads a finished video to Cloudflare R2 and prints a link to it.
 *
 *   node src/upload.js out/<id>.mp4 [--hours 24]
 *
 * The bucket stays private. The link is a signed URL that works for a
 * limited time (24 hours by default), which is long enough for the posting
 * tool to fetch the file and short enough that nothing is left public.
 *
 * R2 speaks the S3 protocol, so this signs requests by hand (SigV4) rather
 * than pulling in the AWS SDK for two calls.
 *
 * .env:
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import './config.js';

const REGION = 'auto';
const SERVICE = 's3';

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function settings() {
  const s = {
    account: process.env.R2_ACCOUNT_ID,
    keyId: process.env.R2_ACCESS_KEY_ID,
    secret: process.env.R2_SECRET_ACCESS_KEY,
    bucket: process.env.R2_BUCKET,
  };
  const missing = Object.entries({
    R2_ACCOUNT_ID: s.account, R2_ACCESS_KEY_ID: s.keyId, R2_SECRET_ACCESS_KEY: s.secret, R2_BUCKET: s.bucket,
  }).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`Missing in .env: ${missing.join(', ')}`);
  s.host = `${s.account}.r2.cloudflarestorage.com`;
  return s;
}

function stamp() {
  const iso = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate: iso, day: iso.slice(0, 8) };
}

function signingKey(secret, day) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, day), REGION), SERVICE), 'aws4_request');
}

const objectPath = (bucket, key) => `/${bucket}/${key.split('/').map(enc).join('/')}`;

async function put(s, key, body, contentType) {
  const { amzDate, day } = stamp();
  const scope = `${day}/${REGION}/${SERVICE}/aws4_request`;
  const uri = objectPath(s.bucket, key);
  const headers = { host: s.host, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'x-amz-date': amzDate };
  const signed = Object.keys(headers).sort();
  const canonical = [
    'PUT', uri, '',
    signed.map((h) => `${h}:${headers[h]}\n`).join(''),
    signed.join(';'),
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const signature = hmac(signingKey(s.secret, day), toSign).toString('hex');

  const res = await fetch(`https://${s.host}${uri}`, {
    method: 'PUT',
    headers: {
      'x-amz-content-sha256': headers['x-amz-content-sha256'],
      'x-amz-date': amzDate,
      'content-type': contentType,
      authorization: `AWS4-HMAC-SHA256 Credential=${s.keyId}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}`,
    },
    body,
  });
  if (!res.ok) throw new Error(`R2 upload failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

function presign(s, key, seconds) {
  const { amzDate, day } = stamp();
  const scope = `${day}/${REGION}/${SERVICE}/aws4_request`;
  const uri = objectPath(s.bucket, key);
  const query = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${s.keyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(seconds),
    'X-Amz-SignedHeaders': 'host',
  };
  const qs = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(query[k])}`).join('&');
  const canonical = ['GET', uri, qs, `host:${s.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const signature = hmac(signingKey(s.secret, day), toSign).toString('hex');
  return `https://${s.host}${uri}?${qs}&X-Amz-Signature=${signature}`;
}

/** Uploads a file and returns a time-limited link to it. */
export async function upload(file, { hours = 24, prefix = 'videos' } = {}) {
  const s = settings();
  if (!fs.existsSync(file)) throw new Error(`No such file: ${file}`);
  const key = `${prefix}/${path.basename(file)}`;
  const type = file.endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream';
  await put(s, key, fs.readFileSync(file), type);
  // R2 caps signed links at seven days.
  const seconds = Math.min(Math.round(hours * 3600), 604800);
  const url = presign(s, key, seconds);

  // Prove the link works before anyone depends on it.
  const check = await fetch(url, { headers: { range: 'bytes=0-0' } });
  if (!check.ok) throw new Error(`Uploaded, but the link answers ${check.status}`);
  return { key, url, hours: seconds / 3600 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const h = process.argv.indexOf('--hours');
  if (!file) {
    console.error('usage: npm run upload -- out/<id>.mp4 [--hours 24]');
    process.exitCode = 1;
  } else {
    upload(path.resolve(file), { hours: h > -1 ? parseFloat(process.argv[h + 1]) : 24 })
      .then((r) => { console.log(`\n✅ uploaded ${r.key}, link valid ${r.hours}h\n\n${r.url}\n`); })
      .catch((e) => { console.error(`\n✖ ${e.message}\n`); process.exitCode = 1; });
  }
}
