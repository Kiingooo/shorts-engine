# assets

Drop-in audio. Empty by default: put your own files here, nothing is bundled.

```
assets/
  sfx/          one-shot effects: record scratch, boing, airhorn, whoosh
  stings/       short musical hits used as scene punctuation
  music/        background beds, looped under a whole video
  voice-drops/  pre-recorded character catchphrases, used instead of TTS
```

Any format ffmpeg reads works. mp3 or wav is fine.

## Using them

In a reaction script, a beat can fire a sound effect or play a pre-recorded
drop instead of synthesising the line:

```json
{
  "at": 8.0,
  "line": "Nah, that is crazy.",
  "sfx": "record-scratch.mp3",
  "voiceDrop": "ayo.mp3"
}
```

- `sfx` is mixed under the beat, quieter than the voice.
- `voiceDrop` replaces the TTS for that beat. The mouth still flaps, timed from
  the file's length rather than from word timings, so it stays roughly in sync.

Filenames are relative to the matching folder, so `"sfx": "boing.mp3"` means
`assets/sfx/boing.mp3`.

## Where to find free ones

Freesound (CC0 filter), Pixabay Sound Effects, and the YouTube Audio Library are
all free for commercial use. Check the licence per file. Keep anything requiring
attribution out of here, or track it in a NOTICE file.
