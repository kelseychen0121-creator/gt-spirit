export const PALETTE = Object.freeze([
  Object.freeze({ id: 'silver', name: 'Argento', hex: null, label: 'Originale' }),
  Object.freeze({ id: 'green', name: 'Verde', hex: '#00D83C', label: '#00D83C' }),
  Object.freeze({ id: 'orange', name: 'Arancio', hex: '#F06A00', label: '#F06A00' }),
  Object.freeze({ id: 'lime', name: 'Giallo', hex: '#F0BE00', label: '#F0BE00' }),
]);

export const CHAPTERS = Object.freeze({
  color: Object.freeze({ start: 0, end: 3.4, number: '02', title: 'Paintwork', description: 'Scroll to preview · Click to select', required: 'exterior' }),
  hood: Object.freeze({ start: 3.4, end: 6.4, number: '03', title: 'Engine', description: 'Scroll to open the heart', required: 'engine-bay' }),
  structure: Object.freeze({ start: 6.4, end: 13.4, number: '04', title: 'Structure', description: 'Scroll to expand the anatomy', required: 'complete' }),
});

export const TRACK_SCREENS = 13.4;
export const BRIDGE = Object.freeze({ cut: 0.18, push: 0.35, end: 1 });
export const PAINT_RESET_START = 3.2;
export const HOOD_CLOSED = 4.15;
export const HOOD_OPEN = 5.65;
export const EXPLOSION_START = 6.9;
export const EXPLOSION_END = 12.9;
export const MAX_COLOR_YAW = Math.PI / 12;
export const MAX_INSPECTION_YAW = Math.PI / 8;
export const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
export const smooth = (value) => { const p = clamp(value); return p * p * (3 - 2 * p); };
export const mix = (a, b, p) => a + (b - a) * p;
const interval = (value, start, end) => value <= start ? 0 : value >= end ? 1 : (value - start) / (end - start);

export function samplePaint(position, selection = null) {
  const silver = { color: 'silver', colorFrom: 'silver', colorMix: 1 };
  if (position >= CHAPTERS.hood.start) return silver;
  if (selection && PALETTE.some((entry) => entry.id === selection)) {
    if (selection === 'silver' || position <= BRIDGE.push) return silver;
    if (position < BRIDGE.end) {
      return { color: selection, colorFrom: 'silver', colorMix: smooth(interval(position, BRIDGE.push, BRIDGE.end)) };
    }
    if (position <= PAINT_RESET_START) return { color: selection, colorFrom: selection, colorMix: 1 };
    return { color: 'silver', colorFrom: selection, colorMix: smooth(interval(position, PAINT_RESET_START, CHAPTERS.hood.start)) };
  }
  const transitions = [
    { start: 1.6, end: 1.75, from: 'silver', to: 'green' },
    { start: 2.2, end: 2.35, from: 'green', to: 'orange' },
    { start: 2.8, end: 2.95, from: 'orange', to: 'lime' },
    { start: PAINT_RESET_START, end: CHAPTERS.hood.start, from: 'lime', to: 'silver' },
  ];
  for (const transition of transitions) {
    if (position <= transition.start) return { color: transition.from, colorFrom: transition.from, colorMix: 1 };
    if (position < transition.end) {
      return { color: transition.to, colorFrom: transition.from, colorMix: smooth(interval(position, transition.start, transition.end)) };
    }
  }
  return silver;
}

export function sampleExperience(position) {
  const scroll = clamp(position, 0, TRACK_SCREENS);
  const phase = scroll < CHAPTERS.hood.start ? 'color' : scroll < CHAPTERS.structure.start ? 'hood' : 'structure';
  const chapter = CHAPTERS[phase];
  const chapterProgress = interval(scroll, chapter.start, chapter.end);
  const prepareProgress = smooth(interval(scroll, CHAPTERS.hood.start, HOOD_CLOSED));
  const hoodProgress = smooth(interval(scroll, HOOD_CLOSED, HOOD_OPEN))
    * (1 - smooth(interval(scroll, CHAPTERS.structure.start, EXPLOSION_START)));
  const explodeProgress = interval(scroll, EXPLOSION_START, EXPLOSION_END);
  const matchProgress = smooth(interval(scroll, BRIDGE.push, BRIDGE.end));
  const scrollYaw = Math.PI / 150 * smooth(interval(scroll, BRIDGE.end, CHAPTERS.hood.start));
  return {
    phase, chapterProgress, prepareProgress, hoodProgress, explodeProgress,
    matchProgress, bridgeProgress: clamp(scroll), scrollYaw,
    ...samplePaint(scroll), progress: scroll / TRACK_SCREENS,
  };
}

export function positionForChapter(chapter) {
  if (!Object.hasOwn(CHAPTERS, chapter)) return 0;
  return chapter === 'color' ? BRIDGE.end : CHAPTERS[chapter].start;
}

export function positionForHood(open) {
  return open ? HOOD_OPEN : HOOD_CLOSED;
}

export function positionForHoodProgress(progress) {
  const p = clamp(progress);
  if (p === 0 || p === 1) return positionForHood(p === 1);
  const inverse = 0.5 - Math.sin(Math.asin(1 - 2 * p) / 3);
  return HOOD_CLOSED + inverse * (HOOD_OPEN - HOOD_CLOSED);
}

export function positionForExplosion(expanded) {
  return expanded ? EXPLOSION_END : EXPLOSION_START;
}

export function positionForExplosionProgress(progress) {
  return mix(EXPLOSION_START, EXPLOSION_END, clamp(progress));
}

export function sampleExplosionScrub(position, takeover = null) {
  const scroll = clamp(position, 0, TRACK_SCREENS);
  const progress = interval(scroll, EXPLOSION_START, EXPLOSION_END);
  if (!takeover) return { progress, takeover: null };
  const { anchor, value, position: origin } = takeover;
  // The final scroll dwell still has room after normalized explosion reaches 1.
  // Use that remaining distance when a direction change was interrupted there.
  if (anchor === 1 && value < 1 && origin < TRACK_SCREENS && scroll > origin) {
    const remaining = interval(scroll, origin, TRACK_SCREENS);
    return { progress: mix(value, 1, remaining), takeover: remaining === 1 ? null : takeover };
  }
  if (progress === anchor) return { progress: value, takeover };
  if (progress === 0 || progress === 1) return { progress, takeover: null };
  const effective = clamp(progress < anchor ? value * progress / anchor
    : value + (1 - value) * (progress - anchor) / (1 - anchor));
  return {
    progress: effective,
    takeover: anchor === 0 || anchor === 1 ? { anchor: progress, value: effective, position: scroll } : takeover,
  };
}

export function colorYawTarget(current, alternate = 1) {
  const step = Math.PI / 30;
  const preferred = current + Math.sign(alternate || 1) * step;
  return preferred > MAX_COLOR_YAW || preferred < -MAX_COLOR_YAW
    ? clamp(current - Math.sign(alternate || 1) * step, -MAX_COLOR_YAW, MAX_COLOR_YAW)
    : preferred;
}
