import fs from 'node:fs';
import path from 'node:path';
import { config, dirs } from './config.js';

/**
 * Footage providers, tried in order. All free.
 *
 *   pexels    video   free key      best general b-roll
 *   pixabay   video   free key      doubles the pool, same licence terms
 *   wikimedia video   keyless       public-domain only; has the specific
 *                                   technical subjects stock libraries lack
 *   nasa      video   keyless       public domain, ocean/science native
 *   openverse image   keyless       last-resort stills
 *
 * A ledger of already-used clips is kept on disk so the same harbour shot
 * doesn't turn up in five episodes in a row — repetition across uploads is
 * exactly what YouTube's inauthentic-content filter looks for.
 */

const LEDGER = path.join(dirs.work, 'used-clips.json');
const used = new Set(fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, 'utf8')) : []);
const claimedThisRun = new Set();

function saveLedger() {
  fs.writeFileSync(LEDGER, JSON.stringify([...used, ...claimedThisRun], null, 0));
}

const UA = { 'User-Agent': 'shorts-engine/1.0 (personal project)' };

async function getJson(url, headers = {}) {
  try {
    const r = await fetch(url, { headers: { ...UA, ...headers } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// ---------------------------------------------------------------- providers

async function pexels(query) {
  if (!config.pexelsKey) return [];
  const d = await getJson(
    `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&orientation=portrait&per_page=15&size=medium`,
    { Authorization: config.pexelsKey },
  );
  const out = [];
  for (const v of d?.videos || []) {
    const files = (v.video_files || [])
      .filter((f) => f.link && f.width && f.height)
      .sort((a, b) => (b.height - b.width) - (a.height - a.width) || b.width - a.width);
    const pick = files.find((f) => f.width >= 720) || files[0];
    if (pick) out.push({ url: pick.link, id: `pexels_${v.id}`, ext: '.mp4', source: 'pexels', credit: v.user?.name });
  }
  return out;
}

async function pixabay(query) {
  if (!config.pixabayKey) return [];
  const d = await getJson(
    `https://pixabay.com/api/videos/?key=${config.pixabayKey}&q=${encodeURIComponent(query)}&per_page=20&safesearch=true`,
  );
  const out = [];
  for (const v of d?.hits || []) {
    const vs = v.videos || {};
    const pick = vs.large?.url || vs.medium?.url || vs.small?.url;
    if (pick) out.push({ url: pick, id: `pixabay_${v.id}`, ext: '.mp4', source: 'pixabay', credit: v.user });
  }
  return out;
}

/** Public-domain video files on Wikimedia Commons. */
async function wikimedia(query) {
  const d = await getJson(
    `https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search`
    + `&gsrsearch=${encodeURIComponent(`filetype:video ${query}`)}&gsrlimit=20&gsrnamespace=6`
    + `&prop=imageinfo&iiprop=url|size|mime|extmetadata`,
  );
  const out = [];
  for (const p of Object.values(d?.query?.pages || {})) {
    const info = p.imageinfo?.[0];
    if (!info?.url) continue;
    const licence = (info.extmetadata?.LicenseShortName?.value || '').toLowerCase();
    // PD / CC0 only, so attribution is never required.
    if (!/public domain|^pd|cc0/.test(licence)) continue;
    if (!/^video\/|ogg/.test(info.mime || '')) continue;
    const ext = path.extname(new URL(info.url).pathname) || '.webm';
    out.push({ url: info.url, id: `wm_${p.pageid}`, ext, source: 'wikimedia', credit: 'Wikimedia (PD)' });
  }
  return out;
}

async function nasa(query) {
  const d = await getJson(`https://images-api.nasa.gov/search?q=${encodeURIComponent(query)}&media_type=video`);
  const out = [];
  for (const item of (d?.collection?.items || []).slice(0, 8)) {
    if (!item.href) continue;
    const manifest = await getJson(item.href);
    const mp4 = (manifest || []).find((u) => /\.mp4$/i.test(u) && !/~small|~preview/i.test(u))
      || (manifest || []).find((u) => /\.mp4$/i.test(u));
    if (mp4) out.push({ url: mp4, id: `nasa_${item.data?.[0]?.nasa_id}`, ext: '.mp4', source: 'nasa', credit: 'NASA (PD)' });
  }
  return out;
}

async function openverse(query) {
  const d = await getJson(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&license_type=all-cc&page_size=12`);
  return (d?.results || [])
    .filter((r) => r.url)
    .map((r) => ({ url: r.url, id: `ov_${r.id}`, ext: '.jpg', still: true, source: 'openverse', credit: r.creator }));
}

const PROVIDERS = [pexels, pixabay, wikimedia, nasa, openverse];

// ------------------------------------------------------------------- lookup

async function download(hit) {
  const file = path.join(dirs.cache, `${hit.id}${hit.ext}`.replace(/[^\w.\-]/g, '_'));
  if (fs.existsSync(file) && fs.statSync(file).size > 1024) return file;
  const res = await fetch(hit.url, { headers: UA });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024) return null;
  fs.writeFileSync(file, buf);
  return file;
}

/** First unused clip for this query, walking providers in priority order. */
export async function findClip(query) {
  for (const provider of PROVIDERS) {
    let hits = [];
    try { hits = await provider(query); } catch { continue; }
    for (const hit of hits) {
      if (used.has(hit.id) || claimedThisRun.has(hit.id)) continue;
      const file = await download(hit);
      if (!file) continue;
      claimedThisRun.add(hit.id);
      return { file, still: !!hit.still, source: hit.source, credit: hit.credit, query };
    }
  }
  return null;
}

/** Resolve every visual slot up front so failures are loud and early. */
export async function resolveFootage(scenes) {
  const plan = [];
  for (const scene of scenes) {
    const slots = [];
    for (const [idx, q] of [scene.visual_1, scene.visual_2].entries()) {
      if (!q) continue;
      let clip = await findClip(q);
      if (!clip && scene.visual_fallback) clip = await findClip(scene.visual_fallback);
      if (!clip) throw new Error(`No footage for scene ${scene.id} slot ${idx + 1}: "${q}"`);
      slots.push(clip);
      process.stdout.write(`  ${String(scene.id).padStart(2)}.${idx + 1}  ${clip.source.padEnd(10)} ${q}\n`);
    }
    plan.push({ ...scene, clips: slots });
  }
  saveLedger();
  return plan;
}
