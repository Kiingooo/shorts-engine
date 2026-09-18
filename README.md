# shorts-engine

Faceless short-form video factory. Two renderers share one pipeline:

- **Knowledge shorts** — narrated explainers over stock footage, tweet-style layout
- **Reaction shorts** — a cutout character watches a clip and talks over freeze frames

Node only. No Python, no admin rights, no system installs: ffmpeg ships as an npm
package. **Nothing in the default path costs money.**

---

## Install

```bash
git clone https://github.com/Kiingooo/shorts-engine.git
cd shorts-engine
npm install
npm run setup
```

Requires Node 18+ (built on 24).

`npm run setup` is an interactive walkthrough that ends with you having your own
character and your own voice. It:

1. asks what you are building and what to call it
2. turns your keywords into Pinterest searches to collect references by hand
3. prints the two image prompts, tailored to your description
4. removes the background from both images automatically
5. **detects which region actually differs between them** and rebuilds the
   open-mouth frame as the closed frame with only that region pasted in, so the
   pose is pixel-locked and the flap cannot jitter
6. generates samples of ten free voices and lets you pick one
7. asks for optional free stock keys
8. writes your `.env`

It is resumable. Re-running it after a failure skips whatever is already done.

Nobody shares anyone else's credentials: the default voice provider needs no key
at all, and the stock keys are your own free signups.

### Keys

| Key | Cost | Needed for |
|---|---|---|
| `PEXELS_API_KEY` | free | stock footage ([get one](https://www.pexels.com/api/)) |
| `PIXABAY_API_KEY` | free | more stock footage ([get one](https://pixabay.com/api/docs/)) |
| `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` | paid | only if `VOICE_PROVIDER=elevenlabs` |

Voice defaults to **Edge TTS**, which is free and needs no key. Wikimedia and NASA
footage need no key either, so the engine runs with zero keys, just with a smaller
clip pool.

---

## Knowledge shorts

```bash
npm run make  -- --script red-hull-v2      # render one
npm run batch    red-hull-v2 anchor-chain-v2   # render several
npm run dryrun -- --script red-hull-v2     # no TTS call, checks the render chain
```

Scripts live in `scripts/*.json`. The writing structure is a Claude Code skill at
`~/.claude/skills/wowday-shorts/SKILL.md`: seven beats, 220 to 300 words, and a loop
rule where the final line runs straight into the on-screen hook as one sentence.

Output is 1080x1920: white frame, tweet-style header, uppercase hook, video panel
below, word-synced captions inside the panel.

---

## Reaction shorts

```bash
npm run react -- --script demo
```

Script shape, in `scripts/reactions/<slug>.json`:

```json
{
  "title": "Lil Woof reacts",
  "source": "clips/whatever.mp4",
  "character": "lilwoof-v2",
  "flapHz": 3,
  "beats": [
    { "at": 3.0, "line": "Hold up. Run that back." },
    { "at": 8.0, "line": "Nah, that is crazy." }
  ]
}
```

`at` is a timestamp in the source clip. The source plays with the character watching,
then freezes and dims while he talks, then resumes. Put source clips in `clips/`.

Set `"dim": false` on a beat to skip the darkening, or `"playToEnd": false` on the doc
to cut after the last beat.

### Getting source clips

```bash
npm run grab -- "https://www.youtube.com/watch?v=..." --name gta-trailer
```

Wraps **yt-dlp**, which is free, needs no API key and no account, and handles
YouTube, TikTok, Instagram and most other sites. It is not bundled as a dependency
because it needs frequent updating to keep working:

```
Windows   winget install yt-dlp
macOS     brew install yt-dlp
Linux     pipx install yt-dlp
```

yt-dlp also needs ffmpeg on PATH to merge video and audio. This project ships its
own ffmpeg for rendering, but yt-dlp cannot see it, so install ffmpeg separately if
merges fail.

---

## Character puppet

```bash
npm run puppet -- --char lilwoof-v2 --hz 3 --halfAlpha 0.55 --seconds 5
```

Each character is a folder under `character/` holding exactly two PNGs:

```
character/lilwoof-v2/
  closed.png
  open.png
```

Same pose, same everything, only the mouth differs. Transparent background.

**Mouth timing comes from the TTS word timings, not from audio analysis**, so a
re-render is always identical. While a word is spoken the mouth cycles at `--hz`;
between words it stays shut. Because two drawings alone strobe, each cycle passes
through a half-alpha frame going in and out, which reads as a soft jaw.

### Making a new pose

Generate the variant, then **patch only the changed region onto the locked base**:

```bash
ffmpeg -i closed.png -i variant.png \
  -filter_complex "[1:v]crop=470:430:850:890[p];[0:v][p]overlay=850:890" \
  -frames:v 1 open.png
```

This is not optional polish. Background removers routinely punch holes elsewhere in
the image, and any drift outside the mouth shows up as a flicker on every flap.

---

## Voices

```bash
npm run voices        # ElevenLabs voices on the account
node src/list-edge-voices.js   # free Edge voices
```

Set in `.env`:

```
VOICE_PROVIDER=edge
EDGE_VOICE=en-US-ChristopherNeural
EDGE_RATE=+15%
```

Voice output is cached on disk keyed by provider, voice, rate and text. Changing
footage, captions or layout never re-bills or re-fetches narration; only editing the
words does.

---

## Footage sources

Tried in order, all free:

| Source | Key | Media |
|---|---|---|
| Pexels | free key | video |
| Pixabay | free key | video |
| Wikimedia Commons | none | video, public domain / CC0 only |
| NASA | none | video, public domain |
| Openverse | none | images, fallback |

A ledger at `work/used-clips.json` records every clip used and skips it next time.
Repetition across uploads is what the inauthentic-content policy targets, so this
matters more than it looks. Delete the ledger to reset.

---

## Layout

```
src/config.js     keys, channel identity, geometry
src/footage.js    provider chain + dedup ledger
src/voice.js      Edge / ElevenLabs behind one interface, disk cache
src/lipsync.js    mouth-flap timing
src/captions.js   width-based caption chunking
src/layout.js     tweet-style frame, returns the computed panel rect
src/render.js     segments -> concat -> burn subs -> mux
src/index.js      knowledge short
src/reaction.js   reaction short
src/puppet.js     character test render
```

---

## Gotchas already solved

- `zoompan` emits `d` frames per *input* frame. The input must be a single frame
  capped with `-frames:v`, or segment files balloon past 30 MB.
- `zoompan` needs explicit `x`/`y` centering or the push drifts to the top-left.
- libass cannot parse the Windows drive colon inside a filter string. ffmpeg is run
  with `cwd` set to the subtitle's directory and given a bare filename.
- Scene windows must tile the whole timeline. If they only span word to word, the
  pauses between sentences belong to no scene, the video ends up shorter than the
  audio, and `-shortest` silently truncates the ending.
- Captions are chunked per scene. Chunking across the whole word list lets the last
  word of one sentence share a card with the first words of the next.
- "Arial Black" is not installed on stock Windows. libass silently substitutes a
  lighter weight. Use Impact.
