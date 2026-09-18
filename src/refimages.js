/**
 * Reference image grabber for character design.
 *
 * Pulls a small mood board from keywords so the user has something to look at
 * before writing the character prompt.
 *
 * Openverse is tried FIRST rather than last, unlike the footage chain: this
 * runs during onboarding, before any API keys exist, so the keyless source is
 * the only one guaranteed to work.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const UA = { 'User-Agent': 'shorts-engine/1.0 (personal project)' };

async function getJson(url, headers = {}) {
  try {
    const r = await fetch(url, { headers: { ...UA, ...headers } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function openverse(q, n) {
  const d = await getJson(
    `https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&license_type=all-cc&page_size=${n}`,
  );
  return (d?.results || []).filter((r) => r.url).map((r) => ({ url: r.url, credit: r.creator, source: 'openverse' }));
}

async function pexels(q, n) {
  if (!config.pexelsKey) return [];
  const d = await getJson(
    `https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=${n}`,
    { Authorization: config.pexelsKey },
  );
  return (d?.photos || []).map((p) => ({ url: p.src?.large || p.src?.original, credit: p.photographer, source: 'pexels' }));
}

async function pixabay(q, n) {
  if (!config.pixabayKey) return [];
  const d = await getJson(
    `https://pixabay.com/api/?key=${config.pixabayKey}&q=${encodeURIComponent(q)}&per_page=${Math.max(3, n)}&safesearch=true`,
  );
  return (d?.hits || []).map((h) => ({ url: h.largeImageURL || h.webformatURL, credit: h.user, source: 'pixabay' }));
}

/** Downloads up to `count` reference images for the keywords into `outDir`. */
export async function grabReferences(keywords, outDir, count = 10) {
  fs.mkdirSync(outDir, { recursive: true });

  const seen = new Set();
  const picked = [];

  for (const provider of [openverse, pexels, pixabay]) {
    if (picked.length >= count) break;
    let hits = [];
    try { hits = await provider(keywords, count); } catch { continue; }
    for (const hit of hits) {
      if (picked.length >= count) break;
      if (!hit.url || seen.has(hit.url)) continue;
      seen.add(hit.url);
      picked.push(hit);
    }
  }

  const saved = [];
  for (const [i, hit] of picked.entries()) {
    try {
      const res = await fetch(hit.url, { headers: UA });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 2048) continue;
      const ext = path.extname(new URL(hit.url).pathname).split('?')[0] || '.jpg';
      const file = path.join(outDir, `ref_${String(i + 1).padStart(2, '0')}${ext}`);
      fs.writeFileSync(file, buf);
      saved.push({ file, ...hit });
    } catch { /* skip a bad one rather than fail the whole board */ }
  }

  // Leave a note on where each image came from, so credit is traceable later.
  if (saved.length) {
    fs.writeFileSync(
      path.join(outDir, 'SOURCES.txt'),
      saved.map((s) => `${path.basename(s.file)}  ${s.source}  ${s.credit || 'unknown'}\n  ${s.url}`).join('\n'),
    );
  }

  return saved;
}
