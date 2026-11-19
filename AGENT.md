# Daily run, for the agent

You are producing Lil Woof reaction shorts about GTA 6. Follow these steps in
order. Do not improvise the pipeline, only the writing.

## Once per machine

```
npm install
pipx install yt-dlp
```

`.env` must contain `VOICE_PROVIDER=elevenlabs`, `ELEVENLABS_API_KEY`,
`ELEVENLABS_VOICE_ID`. Never print or commit it.

## Every day

### 1. Update and hunt

```
git pull
npm run hunt -- --top 15
```

This writes `work/hunt/latest.json` and, per clip, `clips/hunt/<id>.mp4` plus
`clips/hunt/<id>.jpg` (six frames in a grid, in time order, left to right, top
to bottom).

### 2. Pick 10

Read `work/hunt/latest.json`. For each clip look at the title and open the
`.jpg`. Keep a clip only if all of these are true:

- Something visibly happens in the game: a crash, a glitch, a stunt, a fail, a
  detail people would not believe.
- No nudity, strip club scenes or sexual content. Skip those, always.
- It is not just a streamer talking to camera with nothing on screen.

### 3. Write one script per clip

Save as `scripts/reactions/<id>.json`:

```json
{
  "title": "Lil Woof reacts: <short description>",
  "hook": "How did he survive this landing?",
  "source": "clips/hunt/<id>.mp4",
  "clipSlug": "<slug from latest.json>",
  "credit": "<streamer> on Twitch",
  "character": "lilwoof-3d",
  "beats": [
    { "at": 0.6, "line": "..." },
    { "at": 7.2, "reaction": "shock" },
    { "at": 8.2, "line": "..." },
    { "at": 23.5, "reaction": "laugh" },
    { "at": 25.0, "line": "..." }
  ]
}
```

`clipSlug` matters: it is how the clip gets marked as used so it is never
picked twice.

Rules for the writing. These are not optional.

- **He talks a lot.** His lines must cover 60 to 75 percent of the clip. A 30
  second clip needs 3 or 4 lines of 2 to 3 sentences each. Roughly 2.7 words
  are spoken per second, so 30 seconds needs about 55 to 60 words in total.
- **First line starts inside the first second** (`"at": 0.6`). No silent
  opening.
- **Lines follow what is on screen.** Use the six frames to place each `at`:
  frame 1 is the start of the clip, frame 6 is near the end, evenly spaced.
- **Voice:** a laid back hip hop dog watching his homie play. Short punchy
  sentences. Dog jokes are welcome, one per video at most. No swearing, no
  slurs, nothing about real people's looks.
- **Never describe only.** Every line needs an opinion, a joke or a
  comparison.
- **Hook:** a question or a claim of 4 to 8 words about what the viewer is
  about to see. It stays on screen the whole video.
- **Reactions:** `shock`, `laugh`, `nod`, `shake`, `lean`. Use 1 or 2 per
  video, placed right at the moment something happens, on a beat with no
  `line`. A reaction takes 1 to 1.5 seconds; start the next line after it.
- If a line runs long the next beat simply waits for it. Nothing overlaps.
- No em dashes or en dashes anywhere.

### 4. Render

```
npm run react -- --script <id>
```

Run it once per script. A finished video is `out/<id>.mp4`. The command
prints a line starting with ✅ on success. If the file does not exist
afterwards, the render failed: report the error, do not retry more than once.

### 5. Report

List the finished files in `out/` with their hook and the streamer credit.
Put the credit in the video description when posting.

## What not to do

- Do not edit files in `src/`.
- Do not re-render a script whose `out/<id>.mp4` already exists.
- Do not delete `work/hunt/used.json`. It is the memory of what was used.
