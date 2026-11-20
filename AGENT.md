# Daily run, for the agent

You produce and post Lil Woof reaction shorts about GTA 6. Follow these steps
in order. Do not improvise the pipeline, only the writing.

## Once per machine

```
npm install
pipx install yt-dlp
```

`.env` in the repo root must contain:

```
VOICE_PROVIDER=elevenlabs
ELEVENLABS_API_KEY=<the key>
ELEVENLABS_VOICE_ID=k4ci7YBR1aPJ3aczoJUQ
ELEVENLABS_MODEL=eleven_v4
VOICE_SPEED=1.15
```

Uploads go through wrangler, which must already be logged in to the
Cloudflare account that owns the `shortvidengine` bucket. Check with
`npx wrangler whoami`.

Never print or commit it.

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

If fewer than 10 pass, make fewer. Never lower the bar to hit the number.

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
    { "at": 0.5, "line": "[chuckles] Game said land near the dock. My man is coming in sideways." },
    { "at": 7.0, "reaction": "shock" },
    { "at": 8.0, "line": "[gasps] Nah. That plane did a full barrel roll and parked itself." },
    { "at": 18.5, "line": "Everybody on that flight, call your mama." }
  ]
}
```

`clipSlug` matters: it is how the clip gets marked as used so it is never
picked twice.

#### Pace

- **Short lines, many of them.** One line is 1 or 2 short sentences, 6 to 16
  words. Never 3 sentences in one line. A 30 second clip gets 4 to 6 lines.
- He should be talking for 55 to 70 percent of the clip. He speaks about 2.3
  words per second, so a 30 second clip needs 40 to 50 words in total. Count
  them. Too many words and his lines run late against the action.
- **First line starts inside the first second** (`"at": 0.5`). No silent
  opening.
- **React on the moment.** The line about a thing starts within one second of
  that thing happening on screen. Use the six frames to place each `at`: frame
  1 is the start of the clip, frame 6 is near the end, evenly spaced.
- Leave 1 to 3 seconds of air after the biggest moment so the clip itself can
  land. If a line runs long the next beat waits for it. Nothing overlaps.

#### Tone

He was trying too hard to be funny. Fix that.

- He is a relaxed dog watching his homie play. He reacts like a real viewer:
  surprised, impressed, disappointed, amused. Most lines are plain reactions,
  not jokes.
- **At most one written joke per video.** Everything else is a short honest
  reaction or opinion.
- No stacked comparisons, no "like a ... that ..." chains, no puns, no
  punchline at the end of every line. No dog jokes unless it is the one joke.
- Good: "Nah. He actually landed that." / "That is the cleanest fail I have
  seen today." / "Okay, I respect it."
- Bad: "My man is flying like the plane owes him money and the bank is
  closed on Sundays."
- No swearing, no slurs, nothing about real people's looks. Tease the play,
  never the person.
- No em dashes or en dashes anywhere.

#### Expression tags

Put at most one tag per line, in square brackets, before the words it
colours, and only when it fits what just happened: `[chuckles]`, `[laughs]`,
`[gasps]`, `[shocked]`, `[sighs]`, `[amused]`, `[deadpan]`, `[whispers]`,
`[excited]`. About half the lines should have no tag at all. They are
performed, never shown in captions.

#### Reactions

`shock`, `laugh`, `nod`, `shake`, `lean`. Use 1 or 2 per video, placed exactly
on the moment something happens, as a beat with no `line`. A reaction takes 1
to 1.5 seconds; start the next line right after it.

#### Hook

A question or a claim of 4 to 8 words about what the viewer is about to see.
It stays on screen the whole video. No clickbait that the clip does not pay
off.

### 4. Render

```
npm run react -- --script <id>
```

Run it once per script. A finished video is `out/<id>.mp4`. The command
prints a line starting with ✅ on success. If the file does not exist
afterwards, the render failed: report the error, do not retry more than once.

### 5. Post 3 per day

Post through Composio's YouTube connection. Choose the 3 best of the day,
spread across the day, never two within 3 hours of each other. The rest stay
in `out/` as backlog for days with a weak hunt.

For each upload:

- **File:** run `npm run upload -- out/<id>.mp4`. It uploads the video to the
  `shortvidengine` R2 bucket with wrangler and prints its public link. Give
  that link to Composio as the video file. If the command does not print ✅, do not post.
- **Title:** the hook, then ` #shorts #gta6`. Under 90 characters.
- **Description:** always exactly these three lines, filled in:

  ```
  Lil Woof reacts to GTA 6.
  Clip: <credit from the script>, <url from latest.json>
  #gta6 #gtavi #shorts #gaming
  ```

  The clip credit is mandatory. Never post without it.
- **Category:** Gaming. **Made for kids:** no. **Visibility:** public.

After a successful upload append one line to `work/posted.json` with the id,
the YouTube video id and the time, and never post an id that is already in
that file.

### 6. Report

One short message: what was hunted, what was rendered, what was posted (with
links), what failed and why.

## What not to do

- Do not edit files in `src/`.
- Do not re-render a script whose `out/<id>.mp4` already exists.
- Do not delete `work/hunt/used.json` or `work/posted.json`. They are the
  memory of what was used and posted.
- Do not post anything that failed a rule in step 2, even if it rendered.
