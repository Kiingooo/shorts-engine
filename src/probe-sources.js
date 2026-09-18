/** Probes candidate footage APIs to see which actually return usable maritime media. */

const Q = 'ship';

async function j(url, headers = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': 'shorts-engine/1.0', ...headers } });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

const probes = {
  async 'Wikimedia Commons (video)'() {
    const u = `https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search`
      + `&gsrsearch=${encodeURIComponent(`filetype:video ${Q}`)}&gsrlimit=10&gsrnamespace=6`
      + `&prop=imageinfo&iiprop=url|size|mime`;
    const d = await j(u);
    const p = Object.values(d.query?.pages || {});
    return { count: p.length, sample: p.slice(0, 3).map((x) => `${x.title} (${x.imageinfo?.[0]?.mime})`) };
  },

  async 'Archive.org (movies)'() {
    const u = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(`${Q} AND mediatype:(movies)`)}`
      + `&fl[]=identifier&fl[]=title&fl[]=licenseurl&rows=10&output=json`;
    const d = await j(u);
    const docs = d.response?.docs || [];
    return { count: d.response?.numFound, sample: docs.slice(0, 3).map((x) => x.title) };
  },

  async 'NASA images/video'() {
    const d = await j(`https://images-api.nasa.gov/search?q=ocean&media_type=video`);
    const items = d.collection?.items || [];
    return { count: d.collection?.metadata?.total_hits, sample: items.slice(0, 3).map((x) => x.data?.[0]?.title) };
  },

  async 'Library of Congress'() {
    const d = await j(`https://www.loc.gov/search/?q=${Q}&fo=json&c=5`);
    const r = d.results || [];
    return { count: d.pagination?.of, sample: r.slice(0, 3).map((x) => x.title) };
  },

  async 'Openverse (images)'() {
    const d = await j(`https://api.openverse.org/v1/images/?q=${Q}&page_size=5`);
    return { count: d.result_count, sample: (d.results || []).slice(0, 3).map((x) => x.title) };
  },
};

for (const [name, fn] of Object.entries(probes)) {
  try {
    const r = await fn();
    console.log(`\n✓ ${name}\n  results: ${r.count}`);
    for (const s of r.sample) console.log(`    · ${String(s).slice(0, 70)}`);
  } catch (e) {
    console.log(`\n✖ ${name}  — ${e.message}`);
  }
}
