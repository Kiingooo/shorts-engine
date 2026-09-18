import fs from 'node:fs';
import { config } from './config.js';

const t = (s) => {
  const cs = Math.round(s * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const sec = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};

/**
 * Captions are chunked by RENDERED WIDTH, not by word count.
 *
 * The previous version put a fixed 3 words on every card, so a card like
 * "COLLIDE, CANCEL EACH" overflowed the safe area and got clipped at the
 * screen edges. Arial Black at this size averages ~0.62em per glyph, so a
 * character budget derived from the usable width keeps every card inside
 * the frame regardless of how long the individual words are.
 */

const FONT_SIZE = 82;
const MARGIN_X = 110;
const AVG_GLYPH = 0.62; // em, measured for Arial Black caps

export function chunkByWidth(words, widthPx = config.width - MARGIN_X * 2, fontSize = FONT_SIZE) {
  const maxChars = Math.floor(widthPx / (fontSize * AVG_GLYPH));

  const cards = [];
  let cur = [];
  let len = 0;

  for (const w of words) {
    const wLen = w.text.length;
    const added = cur.length ? len + 1 + wLen : wLen;
    // Break when the card would overflow, or when it already holds 3 words.
    if (cur.length && (added > maxChars || cur.length >= 3)) {
      cards.push(cur);
      cur = [w];
      len = wLen;
    } else {
      cur.push(w);
      len = added;
    }
  }
  if (cur.length) cards.push(cur);
  return cards;
}

export function writeAss(words, file, opts = {}) {
  const { width, height } = config;
  const fontSize = opts.fontSize ?? FONT_SIZE;
  const marginV = opts.marginV ?? 420;

  // WrapStyle 0 = smart wrapping. The old value (2) disabled wrapping
  // entirely, which is why long cards ran off the sides instead of folding.
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Base,Arial Black,${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,6,3,2,${MARGIN_X},${MARGIN_X},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const lines = [];
  for (const card of chunkByWidth(words)) {
    for (let i = 0; i < card.length; i++) {
      const start = card[i].start;
      const end = i + 1 < card.length ? card[i + 1].start : card[card.length - 1].end;
      const text = card
        .map((w, j) => {
          const label = w.text.toUpperCase().replace(/[{}\\]/g, '');
          return j === i
            ? `{\\c&H00E0FF&}${label}{\\c&HFFFFFF&}`
            : label;
        })
        .join(' ');
      lines.push(`Dialogue: 0,${t(start)},${t(Math.max(end, start + 0.05))},Base,,0,0,0,,${text}`);
    }
  }

  fs.writeFileSync(file, header + lines.join('\n') + '\n', 'utf8');
  return file;
}
