import fs from 'node:fs';
import { config, layout } from './config.js';
import { chunkByWidth } from './captions.js';

/**
 * Builds one ASS overlay containing the whole tweet-style frame:
 *
 *   ┌─────────────────────────────┐
 *   │ (o)  Channel Name           │  header, persistent
 *   │      @handle                │
 *   │  HOOK SENTENCE GOES HERE    │  hook, persistent, UPPERCASE
 *   │  ┌───────────────────────┐  │
 *   │  │                       │  │  video panel (overlaid separately)
 *   │  │      CAPTIONS         │  │  captions, timed
 *   │  └───────────────────────┘  │
 *   └─────────────────────────────┘
 *
 * The panel's Y position is computed from the ACTUAL wrapped hook line count
 * rather than reserved at a fixed worst-case height, so a 1-line hook sits
 * close to the video instead of leaving dead white space. writeLayoutAss
 * returns the resulting panel rect; the caller must render footage into
 * exactly that rect (renderVideo takes it as `panel`).
 */

// Impact is what's actually installed on this machine — "Arial Black" is
// not, so it was silently substituting a plain weight, which read as flat.
const DISPLAY_FONT = 'Impact';
const HOOK_SIZE = 64;
const HOOK_LINE_H = 70;
const CAPTION_SIZE = 74;

const t = (s) => {
  const cs = Math.round(s * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const sec = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};

const esc = (s) => String(s).replace(/[{}\\]/g, '');

/** Circle as four bezier arcs, for the avatar. */
function circlePath(d) {
  const r = d / 2;
  const k = r * 0.5523;
  return `m ${r} 0 `
    + `b ${r + k} 0 ${d} ${r - k} ${d} ${r} `
    + `b ${d} ${r + k} ${r + k} ${d} ${r} ${d} `
    + `b ${r - k} ${d} 0 ${r + k} 0 ${r} `
    + `b 0 ${r - k} ${r - k} 0 ${r} 0`;
}

/** Greedy wrap by estimated glyph width. Impact is condensed, so a tighter ratio applies. */
function wrap(text, widthPx, fontSize, avgGlyph = 0.52) {
  const maxChars = Math.floor(widthPx / (fontSize * avgGlyph));
  const lines = [];
  let cur = '';
  for (const word of text.split(/\s+/)) {
    const next = cur ? `${cur} ${word}` : word;
    if (next.length > maxChars && cur) { lines.push(cur); cur = word; } else { cur = next; }
  }
  if (cur) lines.push(cur);
  return lines;
}

export function writeLayoutAss({ hook, scenes, duration, file }) {
  const { width, height } = config;
  const { pad, avatarSize, headerY, hookMaxLines, panelX, panelH } = layout;

  const hookLines = wrap(esc(hook).toUpperCase(), width - pad * 2, HOOK_SIZE).slice(0, hookMaxLines);

  // Header block ends here; hook starts right after with a small fixed gap.
  const headerBottom = headerY + avatarSize;
  const hookY = headerBottom + 34;
  const hookBlockH = hookLines.length * HOOK_LINE_H;

  // Panel starts right after the ACTUAL hook height, not a reserved worst case.
  const panelY = hookY + hookBlockH + 28;
  const panelW = width - panelX * 2;

  const captionMarginV = height - (panelY + panelH) + 110;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Name,Arial,42,&H00141414,&H00141414,&H00FFFFFF,&H00FFFFFF,-1,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1
Style: Handle,Arial,32,&H00808080,&H00808080,&H00FFFFFF,&H00FFFFFF,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1
Style: Hook,${DISPLAY_FONT},${HOOK_SIZE},&H00101010,&H00101010,&H00FFFFFF,&H00FFFFFF,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1
Style: Avatar,Arial,20,${config.avatarColour},${config.avatarColour},${config.avatarColour},${config.avatarColour},0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1
Style: Cap,${DISPLAY_FONT},${CAPTION_SIZE},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,6,3,2,60,60,${captionMarginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const FULL = `${t(0)},${t(duration)}`;
  const ev = [];

  ev.push(`Dialogue: 0,${FULL},Avatar,,0,0,0,,{\\an7\\pos(${pad},${headerY})\\p1}${circlePath(avatarSize)}{\\p0}`);

  const textX = pad + avatarSize + 26;
  ev.push(`Dialogue: 0,${FULL},Name,,0,0,0,,{\\an7\\pos(${textX},${headerY + 4})}${esc(config.channelName)}`);
  ev.push(`Dialogue: 0,${FULL},Handle,,0,0,0,,{\\an7\\pos(${textX},${headerY + 54})}${esc(config.channelHandle)}`);

  ev.push(`Dialogue: 0,${FULL},Hook,,0,0,0,,{\\an7\\pos(${pad},${hookY})}${hookLines.join('\\N')}`);

  // Chunked PER SCENE, never across a scene boundary — otherwise the last
  // word of one sentence can end up sharing a caption card with the first
  // words of the next, unrelated one.
  for (const scene of scenes) {
    for (const card of chunkByWidth(scene.words, panelW - 80, CAPTION_SIZE)) {
      for (let i = 0; i < card.length; i++) {
        const start = card[i].start;
        const end = i + 1 < card.length ? card[i + 1].start : card[card.length - 1].end;
        const text = card
          .map((w, j) => {
            const label = w.text.toUpperCase().replace(/[{}\\]/g, '');
            return j === i ? `{\\c&H00E0FF&}${label}{\\c&HFFFFFF&}` : label;
          })
          .join(' ');
        ev.push(`Dialogue: 1,${t(start)},${t(Math.max(end, start + 0.05))},Cap,,0,0,0,,${text}`);
      }
    }
  }

  fs.writeFileSync(file, header + ev.join('\n') + '\n', 'utf8');
  return { file, panel: { x: panelX, y: panelY, w: panelW, h: panelH } };
}
