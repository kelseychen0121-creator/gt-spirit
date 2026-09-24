const ASSETS_BASE = (typeof document !== 'undefined' && document.baseURI) || new URL('../', import.meta.url);
const MANIFEST_URL = new URL('scene.json?v=20260924d', ASSETS_BASE);
const PIXELS_PER_FRAME = 22;
const fullscreenRoot = document.documentElement;
const byId = (id) => document.getElementById(id);
const ui = {
  experience: byId('experience'), track: byId('scroll-track'), stage: byId('stage'),
  imageRegion: byId('image-region'), firstLoad: byId('first-load'),
  firstLoadText: byId('first-load-text'), firstRetry: byId('first-retry'),
  current: byId('frame-current'), end: byId('frame-end'), lens: byId('lens-value'),
  availability: byId('availability'), availabilityText: byId('availability-text'),
  startTick: byId('timeline-start'), endTick: byId('timeline-end'), seek: byId('frame-seek'),
  state: byId('playback-state'), pending: byId('pending-frame'), retry: byId('retry-button'),
  restart: byId('restart-button'), fullscreen: byId('fullscreen-button'),
  fullscreenLabel: byId('fullscreen-label'), info: byId('info-button'),
  dialog: byId('quality-dialog'), closeInfo: byId('close-info'), announcement: byId('live-announcement'),
};

let manifest = null;
let records = new Map();
let displayed = null;
let targetFrame = null;
let progress = 0;
let status = 'loading-manifest';
let renderAvailable = false;
let manifestGeneration = 0;
let manifestController = null;
let manifestError = '';
let lastError = '';
let announcementTimer = 0;
let scrollRAF = 0;
let resizeRAF = 0;
let fullscreenChanging = false;
let fullscreenProgress = null;
let fullscreenWasActive = false;
let fullscreenScrollContext = null;
let fullscreenReleaseAnchor = null;
let fullscreenGeneration = 0;
let dialogScrollLock = null;
let layoutRange = null;
const scrollAnchorLocks = new Map();
let lastIntroEvent = null;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const frameLabel = (frame) => frame === null ? '—' : String(frame).padStart(4, '0');
const frameIndex = (frame) => (frame - manifest.timeline.start) / manifest.timeline.step;
const indexFrame = (index) => manifest.timeline.start + index * manifest.timeline.step;
const matrixOK = (value) => Array.isArray(value) && value.length === 16 && value.every(Number.isFinite);
const isFullscreen = () => document.fullscreenElement === fullscreenRoot;

function text(id, value) { byId(id).textContent = value; }

function normalizeManifest(data) {
  const timeline = data?.timeline;
  const image = data?.image;
  if (!timeline || !image || !Array.isArray(data.frames)) throw new Error('Scene timeline is incomplete');
  if (![timeline.start, timeline.end, timeline.step, timeline.count].every(Number.isInteger)
    || timeline.step < 1 || timeline.count < 1 || timeline.end < timeline.start
    || timeline.start + (timeline.count - 1) * timeline.step !== timeline.end
    || !Number.isFinite(timeline.fps) || timeline.fps <= 0) throw new Error('Invalid scene timeline');
  if (![image.width, image.height].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error('Source camera aspect ratio is missing');
  }
  const seen = new Set();
  const frames = data.frames.map((entry) => {
    if (!Number.isInteger(entry.frame) || entry.frame < timeline.start || entry.frame > timeline.end
      || (entry.frame - timeline.start) % timeline.step !== 0 || seen.has(entry.frame)
      || !matrixOK(entry.camera?.matrixWorld) || !matrixOK(entry.camera?.projectionMatrix)) {
      throw new Error('Scene camera data is incomplete');
    }
    seen.add(entry.frame);
    return { frame: entry.frame, camera: entry.camera };
  }).sort((a, b) => a.frame - b.frame);
  if (frames.length !== timeline.count) throw new Error('Scene camera timeline is incomplete');
  // The original manifest supplies camera metadata only. No image URL is retained or fetched.
  return { source: data.source, timeline: { ...timeline }, image: { width: image.width, height: image.height }, frames };
}

function announce(message) {
  clearTimeout(announcementTimer);
  announcementTimer = setTimeout(() => { ui.announcement.textContent = message; }, 400);
}

function setStatus(next, message = '') {
  const changed = status !== next;
  status = next;
  ui.stage.dataset.status = next;
  ui.stage.dataset.loadingVisible = String(!displayed && (next === 'loading' || next === 'loading-manifest'));
  ui.imageRegion.setAttribute('aria-busy', String(next === 'loading' || next === 'loading-manifest'));
  ui.state.textContent = message || ({ 'loading-manifest': 'Loading scene', loading: 'Loading scene', ready: 'Ready', error: 'Could not load scene' }[next] || next);
  ui.retry.hidden = next !== 'error';
  ui.firstRetry.hidden = next !== 'error';
  ui.firstLoad.hidden = Boolean(displayed) && next !== 'error';
  ui.firstLoadText.textContent = next === 'error' ? lastError || manifestError || 'Could not load scene' : message || 'Loading scene';
  ui.availability.dataset.complete = String(next === 'ready');
  ui.availability.dataset.error = String(next === 'error');
  ui.availabilityText.textContent = next === 'ready' ? 'Realtime 3D' : next === 'error' ? 'Could not load scene' : 'Loading scene';
  if (changed && next === 'error') announce(`${lastError || manifestError || 'Could not load scene'}. Please retry.`);
  updatePending();
  emitIntro();
}

function updatePending() {
  const pending = targetFrame !== null && displayed?.frame !== targetFrame;
  ui.pending.hidden = !pending;
  ui.pending.textContent = pending ? `→ ${frameLabel(targetFrame)}` : '';
  if (manifest) ui.seek.setAttribute('aria-valuetext', pending
    ? `Frame ${targetFrame}, rendering${displayed ? `; displaying frame ${displayed.frame}` : ''}`
    : `Frame ${targetFrame}, ${manifest.timeline.count} frames total`);
}

function presented(frame) {
  // A late render may never acknowledge a newer scroll request.
  if (!manifest || manifestError || frame !== targetFrame || !records.has(frame)) return false;
  const firstDraw = displayed === null;
  displayed = records.get(frame);
  renderAvailable = true;
  lastError = '';
  ui.current.textContent = frameLabel(frame);
  ui.lens.textContent = displayed.camera.lens === undefined ? '—' : String(displayed.camera.lens);
  ui.stage.dataset.frame = String(frame);
  ui.stage.dataset.displayedProgress = String(frameIndex(frame) / Math.max(1, manifest.timeline.count - 1));
  updateCurrentFacts();
  setStatus('ready');
  if (firstDraw) announce('Scene ready. Scroll to explore.');
  return true;
}

function rendererLoading(message = 'Loading scene') {
  if (!manifest || manifestError) return;
  renderAvailable = false;
  setStatus('loading', message);
}

function rendererFailed(error) {
  renderAvailable = false;
  lastError = error?.message || String(error || 'Could not load scene');
  setStatus('error');
}

function scrollElement() {
  return document.scrollingElement || document.documentElement;
}

function introRange(element = scrollElement()) {
  const origin = 0;
  const start = ui.track.getBoundingClientRect().top + element.scrollTop - origin;
  const trackHeight = ui.track.clientHeight;
  const viewportHeight = element.clientHeight;
  const distance = Math.max(0, trackHeight - viewportHeight);
  return { element, start, end: start + distance, distance, trackHeight, viewportHeight, handoffEnd: start + trackHeight };
}

function introActive(range = introRange()) {
  return range.element.scrollTop >= range.start && range.element.scrollTop <= range.end;
}

function scrollMaximum() {
  return introRange().distance;
}

function scrollProgress(range = introRange()) {
  return range.distance ? clamp((range.element.scrollTop - range.start) / range.distance, 0, 1) : 0;
}

function introMetrics() {
  const range = introRange();
  return {
    ready: status === 'ready' && displayed?.frame === targetFrame,
    introStart: range.start,
    introEnd: range.end,
    active: introActive(range),
    transitioning: fullscreenChanging,
    trackHeight: range.trackHeight,
    viewportHeight: range.viewportHeight,
    handoffEnd: range.handoffEnd,
    ended: Boolean(manifest) && targetFrame === manifest.timeline.end,
  };
}

function emitIntro(force = false) {
  const { introStart: start, introEnd: end, ...metrics } = introMetrics();
  const detail = {
    ...metrics,
    start,
    end,
    status,
    progress,
    displayedFrame: displayed?.frame ?? null,
    targetFrame,
    fullscreen: isFullscreen(),
    manifestReady: Boolean(manifest),
    networkRequests: 0, queuedRequests: 0, activeDecodes: 0,
  };
  if (!force && lastIntroEvent && Object.keys(detail).every((key) => detail[key] === lastIntroEvent[key])) return;
  lastIntroEvent = Object.freeze(detail);
  window.dispatchEvent(new CustomEvent('gt:intro', { detail: lastIntroEvent }));
}

function setTarget(next, nextProgress, force = false) {
  const previous = targetFrame;
  targetFrame = next;
  progress = clamp(nextProgress, 0, 1);
  ui.stage.dataset.targetFrame = String(next);
  ui.stage.dataset.progress = progress.toFixed(8);
  ui.seek.value = String(next);
  ui.seek.style.setProperty('--seek-progress', `${progress * 100}%`);
  updatePending();
  if ((previous !== next || force) && status !== 'error') {
    // Returning before a pending draw is still ready if the acknowledged scene is intact.
    // Asset retries and context loss invalidate it until a new render is acknowledged.
    setStatus(renderAvailable && displayed?.frame === next ? 'ready' : 'loading');
  }
  emitIntro(force);
}

function readScroll() {
  scrollRAF = 0;
  if (!manifest || fullscreenChanging || ui.dialog.open) return;
  const nextProgress = scrollProgress();
  const index = Math.round(nextProgress * (manifest.timeline.count - 1));
  setTarget(indexFrame(index), nextProgress);
}

function onScroll() {
  if (!scrollRAF) scrollRAF = requestAnimationFrame(readScroll);
}

function moveScroll(nextProgress) {
  const range = introRange();
  const top = range.start + nextProgress * range.distance;
  window.scrollTo({ top, behavior: 'auto' });
}

function seekTo(frame) {
  if (!manifest) return;
  const index = clamp(Math.round(frameIndex(frame)), 0, manifest.timeline.count - 1);
  const nextProgress = index / Math.max(1, manifest.timeline.count - 1);
  moveScroll(nextProgress);
  setTarget(indexFrame(index), nextProgress);
}

function lockScrollAnchor(root) {
  let lock = scrollAnchorLocks.get(root);
  if (!lock) {
    lock = { count: 0, value: root.style.getPropertyValue('overflow-anchor'), priority: root.style.getPropertyPriority('overflow-anchor') };
    scrollAnchorLocks.set(root, lock);
    root.style.setProperty('overflow-anchor', 'none');
  }
  ++lock.count;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--lock.count) return;
    if (lock.value) root.style.setProperty('overflow-anchor', lock.value, lock.priority);
    else root.style.removeProperty('overflow-anchor');
    scrollAnchorLocks.delete(root);
  };
}

function captureScrollContext(range = introRange()) {
  const root = scrollElement();
  return {
    root, top: root.scrollTop, left: root.scrollLeft, progress,
    active: introActive(range), focus: document.activeElement,
    postIntroScreens: root.scrollTop > range.end ? (root.scrollTop - range.end) / Math.max(1, range.viewportHeight) : null,
  };
}

function restoreScrollContext(context) {
  if (context.active) moveScroll(context.progress);
  else if (context.root === scrollElement()) {
    window.scrollTo({ top: context.top, left: context.left, behavior: 'auto' });
  }
}

function sizeTrack(preserve = true) {
  if (!manifest) return;
  const previousRange = layoutRange?.element === scrollElement() ? layoutRange : introRange();
  const preserveIntro = preserve && introActive(previousRange);
  const distance = (manifest.timeline.count - 1) * PIXELS_PER_FRAME;
  ui.track.style.height = `${ui.stage.clientHeight + distance}px`;
  ui.track.dataset.scrollDistance = String(distance);
  layoutRange = introRange();
  if (preserveIntro && !ui.dialog.open) moveScroll(progress);
}

function onResize() {
  cancelAnimationFrame(resizeRAF);
  resizeRAF = requestAnimationFrame(() => {
    if (!manifest || fullscreenChanging) return;
    const height = ui.stage.clientHeight + (manifest.timeline.count - 1) * PIXELS_PER_FRAME;
    if (Math.abs(ui.track.getBoundingClientRect().height - height) > 0.5) sizeTrack();
    layoutRange = introRange();
    readScroll();
    emitIntro(true);
  });
}

function updateFacts() {
  text('source-file', 'GT coupe scene (.blend)');
  text('source-timeline', `${manifest.timeline.start}–${manifest.timeline.end} · Scroll controlled`);
  text('source-engine', 'Realtime WebGL');
  text('source-effects', 'Shared lighting, shadows, reflections and post-processing');
  text('quality-label', 'REALTIME 3D');
  updateCurrentFacts();
}

function updateCurrentFacts() {
  if (!displayed) return;
  text('source-camera', `Frame ${displayed.frame} · ${displayed.camera.lens ?? '—'} mm`);
}

async function loadManifest(force = false) {
  if (manifestController && !force) return;
  manifestController?.abort();
  const generation = ++manifestGeneration;
  const controller = new AbortController();
  manifestController = controller;
  const timeout = setTimeout(() => controller.abort(new DOMException('Scene data timed out', 'TimeoutError')), 12000);
  try {
    const response = await fetch(MANIFEST_URL, { cache: 'force-cache', signal: controller.signal });
    if (!response.ok) throw new Error(`Scene data failed (HTTP ${response.status})`);
    const next = normalizeManifest(await response.json());
    if (generation !== manifestGeneration) return;
    const previousTimeline = manifest?.timeline;
    manifestError = '';
    manifest = next;
    records = new Map(next.frames.map((record) => [record.frame, record]));
    ui.seek.min = String(next.timeline.start);
    ui.seek.max = String(next.timeline.end);
    ui.seek.step = String(next.timeline.step);
    ui.seek.disabled = next.timeline.count < 2;
    ui.restart.disabled = false;
    ui.end.textContent = frameLabel(next.timeline.end);
    ui.startTick.textContent = frameLabel(next.timeline.start);
    ui.endTick.textContent = frameLabel(next.timeline.end);
    ui.stage.dataset.totalFrames = String(next.timeline.count);
    updateFacts();
    const timelineChanged = !previousTimeline || previousTimeline.start !== next.timeline.start
      || previousTimeline.end !== next.timeline.end || previousTimeline.step !== next.timeline.step;
    if (timelineChanged) sizeTrack(Boolean(previousTimeline));
    const nextProgress = ui.dialog.open ? progress : scrollProgress();
    setTarget(indexFrame(Math.round(nextProgress * (next.timeline.count - 1))), nextProgress, true);
  } catch (error) {
    if (generation !== manifestGeneration || error?.name === 'AbortError') return;
    manifestError = error.message || 'Cannot load scene data';
    lastError = manifestError;
    setStatus('error');
  } finally {
    clearTimeout(timeout);
    if (generation === manifestGeneration) manifestController = null;
  }
}

async function retry() {
  lastError = '';
  if (!manifest || manifestError) {
    setStatus('loading-manifest');
    await loadManifest(true);
  }
  if (!manifest || manifestError) return;
  setStatus('loading');
  window.dispatchEvent(new CustomEvent('gt:intro-retry', { detail: { frame: targetFrame } }));
  emitIntro(true);
}

function openInfo() {
  if (ui.dialog.open || fullscreenChanging) return;
  const context = captureScrollContext();
  dialogScrollLock = { ...context, overflow: context.root.style.overflowY, releaseAnchor: lockScrollAnchor(context.root) };
  context.root.style.overflowY = 'hidden';
  ui.dialog.showModal();
  restoreScrollContext(context);
}

function closeInfo() {
  const context = dialogScrollLock;
  if (context) {
    context.root.style.overflowY = context.overflow;
    dialogScrollLock = null;
    sizeTrack(false);
    restoreScrollContext(context);
    readScroll();
    requestAnimationFrame(() => requestAnimationFrame(context.releaseAnchor));
  }
  const focus = context && !context.active ? context.focus : ui.info;
  if (focus?.isConnected) focus.focus({ preventScroll: true });
  emitIntro();
}

ui.seek.addEventListener('input', () => seekTo(Number(ui.seek.value)));
ui.restart.addEventListener('click', () => { if (manifest) seekTo(manifest.timeline.start); });
ui.retry.addEventListener('click', retry);
ui.firstRetry.addEventListener('click', retry);
ui.info.addEventListener('click', openInfo);
ui.closeInfo.addEventListener('click', () => ui.dialog.close());
ui.dialog.addEventListener('close', closeInfo);
ui.dialog.addEventListener('click', (event) => {
  if (event.target !== ui.dialog) return;
  const rect = ui.dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) ui.dialog.close();
});
window.addEventListener('scroll', onScroll, { passive: true });
window.addEventListener('resize', onResize, { passive: true });
if ('ResizeObserver' in window) new ResizeObserver(onResize).observe(ui.stage);

window.addEventListener('keydown', (event) => {
  if (!manifest || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || ui.dialog.open || fullscreenChanging
    || event.target.closest?.('input, textarea, select, button, a, [contenteditable="true"], [role="dialog"], #interactive-experience')) return;
  const range = introRange();
  if (!introActive(range)) return;
  const { start, end, step, fps } = manifest.timeline;
  if (range.element.scrollTop >= range.end
    && (event.key === 'PageDown' || event.key === 'ArrowDown')) return;
  const page = Math.max(1, Math.round(fps)) * step;
  const destinations = {
    ArrowDown: targetFrame + step, ArrowRight: targetFrame + step,
    ArrowUp: targetFrame - step, ArrowLeft: targetFrame - step,
    PageDown: targetFrame + page, PageUp: targetFrame - page,
    Home: start, End: end,
  };
  if (!(event.key in destinations)) return;
  event.preventDefault();
  seekTo(destinations[event.key]);
});

if (document.fullscreenEnabled && fullscreenRoot.requestFullscreen) {
  ui.fullscreen.hidden = false;
  ui.fullscreen.addEventListener('click', async () => {
    if (fullscreenChanging) return;
    fullscreenScrollContext = captureScrollContext();
    if (!document.fullscreenElement) {
      fullscreenReleaseAnchor = lockScrollAnchor(fullscreenScrollContext.root);
    }
    fullscreenChanging = true;
    fullscreenProgress = progress;
    ui.fullscreen.disabled = true;
    ui.info.disabled = true;
    emitIntro(true);
    const timeout = setTimeout(() => {
      if (!fullscreenChanging) return;
      fullscreenChanging = false;
      fullscreenProgress = null;
      ui.fullscreen.disabled = false;
      ui.info.disabled = false;
      if (!isFullscreen()) {
        fullscreenReleaseAnchor?.();
        fullscreenReleaseAnchor = null;
      }
      emitIntro();
      announce('Fullscreen did not respond. Continue viewing on this page.');
    }, 2500);
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await fullscreenRoot.requestFullscreen({ navigationUI: 'hide' });
    } catch {
      fullscreenChanging = false;
      fullscreenProgress = null;
      if (!isFullscreen()) {
        fullscreenScrollContext = null;
        fullscreenReleaseAnchor?.();
        fullscreenReleaseAnchor = null;
      }
      emitIntro();
      announce('Fullscreen unavailable. Continue viewing on this page.');
    } finally {
      clearTimeout(timeout);
      ui.fullscreen.disabled = fullscreenChanging;
      ui.info.disabled = fullscreenChanging;
    }
  });
}

document.addEventListener('fullscreenchange', () => {
  const active = isFullscreen();
  if (!active && !fullscreenWasActive) return;
  fullscreenWasActive = active;
  const generation = ++fullscreenGeneration;
  const nextProgress = fullscreenProgress ?? progress;
  const context = active ? fullscreenScrollContext : captureScrollContext(layoutRange || introRange());
  fullscreenReleaseAnchor ||= lockScrollAnchor(document.scrollingElement || document.documentElement);
  fullscreenChanging = true;
  ui.fullscreen.disabled = true;
  ui.info.disabled = true;
  ui.fullscreenLabel.textContent = active ? 'Exit fullscreen' : 'Fullscreen';
  ui.fullscreen.setAttribute('aria-label', active ? 'Exit fullscreen' : 'Enter fullscreen');
  ui.fullscreen.title = active ? 'Exit fullscreen' : 'Enter fullscreen';
  emitIntro(true);
  const restore = () => {
    sizeTrack(false);
    if (context?.postIntroScreens !== null && context?.postIntroScreens !== undefined) {
      const range = introRange();
      window.scrollTo({ top: range.end + context.postIntroScreens * range.viewportHeight, left: context.left, behavior: 'auto' });
    } else if (context && !context.active) restoreScrollContext(context);
    else moveScroll(nextProgress);
  };
  requestAnimationFrame(() => {
    if (generation !== fullscreenGeneration) return;
    restore();
    requestAnimationFrame(() => {
      if (generation !== fullscreenGeneration) return;
      restore();
      if (!active) {
        fullscreenScrollContext = null;
        const releaseAnchor = fullscreenReleaseAnchor;
        fullscreenReleaseAnchor = null;
        requestAnimationFrame(releaseAnchor);
      }
      fullscreenChanging = false;
      fullscreenProgress = null;
      ui.fullscreen.disabled = false;
      ui.info.disabled = false;
      readScroll();
      emitIntro(true);
    });
  });
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    readScroll();
    emitIntro(true);
  }
});

// The scene controller owns assets and rendering. Only an acknowledged WebGL draw
// can advance displayedFrame; timeline requests never pretend an image was shown.
Object.defineProperty(window, 'gtIntroRenderer', {
  configurable: false,
  value: Object.freeze({ presented, loading: rendererLoading, failed: rendererFailed }),
});

Object.defineProperty(window, 'gtPlayer', {
  configurable: false,
  get: () => Object.freeze({
    status, mode: 'realtime', renderMode: 'realtime-3d', manifestReady: Boolean(manifest),
    displayedFrame: displayed?.frame ?? null, targetFrame, progress,
    displayedLens: displayed?.camera.lens ?? null,
    displayedSourceURL: null, displayedSHA256: null, shaVerified: false,
    availableFrames: records.size, frameCount: manifest?.timeline.count ?? 0,
    renderStatus: status,
    timeline: manifest ? Object.freeze({ ...manifest.timeline }) : null,
    image: manifest ? Object.freeze({ ...manifest.image, format: 'WebGL' }) : null,
    decodedFrames: 0, decodedLimit: 0, decodedBytes: 0,
    blobFrames: 0, blobBytes: 0, blobLimitBytes: 0,
    networkRequests: manifestController ? 1 : 0, queuedRequests: 0, activeDecodes: 0,
    fullscreen: isFullscreen(), cacheState: 'unused', cachedFrames: 0, manifestPolling: false,
    scrollDistance: scrollMaximum(), pixelsPerFrame: PIXELS_PER_FRAME,
    lastError, manifestError,
    ...introMetrics(),
  }),
});

loadManifest();
