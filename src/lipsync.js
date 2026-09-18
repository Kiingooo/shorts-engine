/**
 * Shared mouth-flap timing. Kept separate from puppet.js so other renderers
 * can import it without running that file's top-level demo code.
 */
export const FPS = 30;

/**
 * Word timings -> mouth windows.
 * One cycle = open for the first half, shut for the second, with a single
 * half-alpha frame leading in and out so two drawings read as a soft jaw
 * rather than a strobe.
 */
export function flapWindows(words, hz, limit = Infinity, offset = 0) {
  const cycle = 1 / hz;
  const f = 1 / FPS;
  const full = [];
  const half = [];

  for (const w of words) {
    const ws = w.start + offset;
    const we = Math.min(w.end + offset, limit);
    if (ws >= limit) break;
    for (let t = ws; t < we; t += cycle) {
      const openStart = t + f;
      const openEnd = Math.min(t + cycle / 2, we);
      if (openStart >= openEnd) continue;
      half.push([t, openStart]);
      full.push([openStart, openEnd]);
      half.push([openEnd, Math.min(openEnd + f, we)]);
    }
  }
  return { full, half };
}

export const enableExpr = (list) =>
  list.map(([a, b]) => `between(t,${a.toFixed(3)},${b.toFixed(3)})`).join('+') || '0';
