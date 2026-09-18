# Episode writer

The script structure now lives in a Claude Code skill, derived from six wowday
transcripts rather than guessed from one:

**`C:\Users\ahmed\.claude\skills\wowday-shorts\SKILL.md`**

Invoke it with `/wowday-shorts` (or just ask for a script for the ships channel)
and it will produce the scenes JSON in the right shape.

## The seven beats, in short

1. **Attention command** — 2–4 words. "Can you believe this?"
2. **Visible anomaly** — one concrete sentence, with a number if one exists
3. **The viewer's wrong guess** ⭐ — the dumb answer, asked as a question
4. **Flat denial** — often three words. "Actually, no."
5. **Mechanism** — 4–7 sentences, strict causal chain
6. **Complication** — why the obvious version fails; the mid-video re-hook
7. **Looped payoff** — restate the opening image, now understood

## Non-negotiables

- **220–300 words.** Shorter collapses beats 5 and 6 and stops feeling like an explanation.
- **The last line hands back into the first.** No summary, no sign-off, no CTA.
- **Two literal visual terms per scene**, plus a generic `visual_fallback`.
- **Pick topics stock footage can show.** If the subject is invisible in stock, change topic.

Reference example: `scripts/red-hull-v2.json` — 20 scenes, 246 words, Pattern A loop.
