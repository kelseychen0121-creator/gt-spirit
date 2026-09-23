import {
  PALETTE, CHAPTERS, TRACK_SCREENS, BRIDGE, MAX_COLOR_YAW, MAX_INSPECTION_YAW,
  clamp, smooth, mix, sampleExperience, samplePaint, positionForChapter,
  positionForHood, positionForExplosion, positionForExplosionProgress, sampleExplosionScrub, colorYawTarget,
} from './experience-state.js';
import { createPresentation } from './presentation.js';

const root = document.getElementById('interactive-experience');
const byId = (id) => document.getElementById(id);
const stage = byId('interactive-stage');
const originalStage = byId('stage');
const track = byId('interactive-track');
const host = byId('vehicle-canvas-host');
const loading = byId('model-loading');
const loadProgress = byId('model-load-progress');
const retryButton = byId('model-retry');
const partCard = byId('part-card');
const presentation = createPresentation(stage);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const ranks = { none: 0, exterior: 1, 'engine-bay': 2, structure: 3, complete: 3 };
const readPreference = (key, fallback) => {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
};
const savePreference = (key, value) => {
  try { localStorage.setItem(key, value); } catch {}
};

let savedColor = readPreference('gt:paint:v1', '');
if (!PALETTE.some((entry) => entry.id === savedColor)) savedColor = '';
let colorMode = 'auto';
let lockedColor = null;
let color = 'silver';
let paintState = { color, colorFrom: color, colorMix: 1 };
let layout = readPreference('gt:layout:v1', 'vertical');
if (!['vertical', 'horizontal'].includes(layout)) layout = 'vertical';
let displayedLayout = layout;
let vehicle = null;
let initialization = null;
let readyStage = 'none';
let loadStatus = { phase: 'idle', label: 'Loading', detail: 'Preparing the garage.', progress: 0 };
let colorYaw = 0;
let inspectionYaw = 0;
let manualYaw = false;
let yawDirection = 1;
let colorMotion = null;
let layoutMotion = null;
let modeScrub = null;
let scrollMotion = null;
let pointer = null;
let frameRequest = 0;
let preloadTimer = 0;
let preloadIdle = 0;
let trackStart = 0;
let physicalTrackStart = 0;
let screenHeight = 0;
let trackPosition = 0;
let rawPosition = -1;
let visible = false;
let controlsVisible = false;
let presented = false;
let sample = sampleExperience(0);
let effectiveExplosion = 0;
let selectedPart = null;
let lastRenderKey = '';
let lastPhase = 'color';
let lastError = '';

function requestUpdate() {
  if (!frameRequest && !document.hidden) frameRequest = requestAnimationFrame(update);
}

let resizePosition = null;
let resizeRequest = 0;
let inputGeneration = 0;
let fullscreenTransition = false;
let fullscreenRequest = 0;

function cancelResizeRestore() {
  inputGeneration += 1;
  cancelAnimationFrame(resizeRequest);
  resizeRequest = 0;
  resizePosition = null;
}

function measure() {
  const intro = window.gtPlayer;
  if (!fullscreenTransition && !intro?.transitioning) {
    screenHeight = originalStage.clientHeight || stage.clientHeight || innerHeight;
    track.style.height = `${screenHeight * TRACK_SCREENS}px`;
    physicalTrackStart = root.getBoundingClientRect().top + scrollY;
    trackStart = Number.isFinite(intro?.introEnd) ? intro.introEnd : physicalTrackStart - screenHeight;
    presentation.measure(intro);
  }
  requestUpdate();
}

function scheduleResize() {
  if (document.hidden || fullscreenTransition || window.gtPlayer?.transitioning || scrollMotion || pointer) {
    cancelResizeRestore();
    measure();
    return;
  }
  if (resizePosition === null && screenHeight && scrollY >= trackStart
    && scrollY <= trackStart + screenHeight * TRACK_SCREENS) {
    resizePosition = trackPosition;
  }
  const generation = inputGeneration;
  cancelAnimationFrame(resizeRequest);
  resizeRequest = requestAnimationFrame(() => {
    resizeRequest = 0;
    if (generation !== inputGeneration || document.hidden) return;
    measure();
    resizeRequest = requestAnimationFrame(() => {
      resizeRequest = 0;
      if (generation !== inputGeneration || document.hidden) return;
      measure();
      const position = resizePosition;
      resizePosition = null;
      if (position !== null && !fullscreenTransition && !scrollMotion) {
        window.scrollTo({ top: trackStart + position * screenHeight, behavior: 'auto' });
      }
      requestUpdate();
    });
  });
}

function setText(id, value) {
  const element = byId(id);
  if (element && element.textContent !== String(value)) element.textContent = value;
}

function showPart(part) {
  selectedPart = part;
  if (!part) { partCard.hidden = true; return; }
  const english = (value) => typeof value === 'string' && !/\p{Script=Han}/u.test(value) ? value : '';
  const title = english(part.nameEn) || english(part.name) || english(part.partName)
    || (english(part.subsystem?.split(/\s*\/\s*/)[0]) || english(part.assemblyGroup) || english(part.group) || 'Vehicle part').replaceAll('_', ' ');
  setText('part-name', title.replace(/\b[a-z]/g, (letter) => letter.toUpperCase()));
  setText('part-id', part.id || part.partId || '');
  setText('part-group', english(part.group) || english(part.assemblyGroup) || 'Vehicle');
  setText('part-note', part.confidence?.includes('source') ? 'Original body geometry.' : 'Reference component.');
  partCard.hidden = false;
}

function graphicsFailed(scene = vehicle?.diagnostics) {
  return loadStatus.phase === 'context-lost' || Boolean(scene?.contextLost)
    || (loadStatus.phase === 'error' && (!loadStatus.stage || ['context', 'shader', 'render', 'renderer', 'stage', 'intro'].includes(loadStatus.stage)));
}

let loadingSince = 0;
let loadingNoticeTimer = 0;
function updateLoading() {
  const scene = vehicle?.diagnostics;
  const required = CHAPTERS[sample.phase].required;
  const intro = window.gtPlayer;
  const introFailed = Boolean(intro?.manifestError);
  const garageFailed = loadStatus.phase === 'error' || loadStatus.phase === 'context-lost'
    || Boolean(presentation.cameraError);
  const failed = garageFailed || introFailed;
  const usable = ranks[readyStage] >= ranks[required] && scene?.stageReady === true
    && scene?.introReady === true && !graphicsFailed(scene) && !presentation.cameraError;
  const waiting = visible && rawPosition > 0 && (!usable || introFailed);
  // A ready scene may need one render acknowledgement during the handoff.
  // That is a presentation step, not a loading state: never flash a status panel.
  if (waiting) {
    if (!loadingSince) loadingSince = performance.now();
    if (!failed && !loadingNoticeTimer && performance.now() - loadingSince < 800) {
      loadingNoticeTimer = setTimeout(() => { loadingNoticeTimer = 0; requestUpdate(); }, 810);
    }
  } else {
    loadingSince = 0;
    clearTimeout(loadingNoticeTimer);
    loadingNoticeTimer = 0;
  }
  loading.hidden = !waiting || (!failed && performance.now() - loadingSince < 800);
  loading.dataset.state = failed ? 'error' : 'loading';
  stage.dataset.modelReady = String(usable && presented);
  stage.dataset.readyStage = readyStage;
  host.setAttribute('aria-busy', String(!usable));
  retryButton.hidden = !garageFailed;
  byId('handoff-return').hidden = !failed;
  byId('intro-frame-retry').hidden = !waiting || !introFailed;
  setText('model-load-title', failed ? (introFailed ? 'Could not load frame' : 'Could not load the garage') : 'Loading');
  setText('model-load-detail', failed ? (presentation.cameraError
    || (introFailed && (intro.lastError || intro.manifestError)) || loadStatus.error || lastError || 'Please retry.') : '');
  if (Number.isFinite(loadStatus.progress) && !presentation.cameraError) loadProgress.value = clamp(loadStatus.progress);
  else loadProgress.removeAttribute('value');
}

function syncReadyStage(fallback = 'none') {
  const name = vehicle?.diagnostics.readyStage ?? fallback;
  readyStage = Object.hasOwn(ranks, name) ? name : 'none';
}

async function initializeVehicle() {
  if (initialization) return initialization;
  initialization = (async () => {
    loadStatus = { phase: 'loading', stage: 'renderer', label: 'Loading', detail: 'Preparing the garage.', progress: 0 };
    syncReadyStage();
    updateLoading();
    presentation.loadCameras().then(() => {
      measure();
      lastRenderKey = '';
      requestUpdate();
    }).catch((error) => { window.gtIntroRenderer?.failed(error); updateLoading(); requestUpdate(); });
    try {
      const { VehicleScene } = await import('./vehicle-scene.js');
      vehicle = new VehicleScene(host, {
        onStatus(status) {
          loadStatus = status;
          syncReadyStage(status.phase === 'ready' ? status.stage
            : status.phase === 'loading' && status.stage === 'renderer' ? 'none' : readyStage);
          if (status.error) lastError = String(status.error?.message || status.error);
          else if (status.phase === 'ready') lastError = '';
          if (graphicsFailed()) resetPresentation();
          if (presentation.cameraError) window.gtIntroRenderer?.failed(presentation.cameraError);
          else if (graphicsFailed() || status.phase === 'error' && !vehicle?.diagnostics.presentationReady) window.gtIntroRenderer?.failed(lastError || status.detail);
          else if (!vehicle?.diagnostics.presentationReady) window.gtIntroRenderer?.loading('Loading scene');
          updateLoading();
          lastRenderKey = '';
          requestUpdate();
        },
        onPart: showPart,
        onRendered({ frame }) {
          if (!presentation.cameraError && !graphicsFailed()) window.gtIntroRenderer?.presented(frame);
          requestUpdate();
        },
        onReady(next) {
          syncReadyStage(typeof next === 'string' ? next : next?.stage);
          const scene = vehicle?.diagnostics;
          setText('hood-note-label', scene?.hoodVerified ? 'Hood note' : 'Hood preview');
          setText('hood-note', scene?.hoodVerified
            ? 'Scroll to open the hood.'
            : scene?.hoodStatus?.startsWith('blocked')
              ? 'Hood preview. Source geometry intersects; see model notes.'
              : 'Original hood surface. Hinge and inner structure are unverified.');
          lastRenderKey = '';
          updateLoading();
          requestUpdate();
        },
      });
      vehicle.update({ color: 'silver', visible: visible && !document.hidden, stageOnly: false, matchProgress: 0,
        introFrame: window.gtPlayer?.targetFrame ?? 30,
        introCamera: presentation.cameraFor(window.gtPlayer?.targetFrame ?? 30),
        sourceRect: presentation.sourceRect, viewPadding: presentation.viewPadding });
      await vehicle.load();
      syncReadyStage();
      updateLoading();
      requestUpdate();
    } catch (error) {
      lastError = error.message || String(error);
      loadStatus = { phase: 'error', stage: 'renderer', label: 'Could not load', detail: `${lastError}. Please retry.`, error: lastError };
      syncReadyStage();
      resetPresentation();
      window.gtIntroRenderer?.failed(lastError);
      updateLoading();
    }
  })();
  return initialization;
}

function schedulePreload() {
  if (initialization || preloadTimer || document.hidden || fullscreenTransition) return;
  const intro = window.gtPlayer;
  if (!intro?.manifestReady || intro.transitioning) return;
  preloadTimer = setTimeout(() => {
    preloadTimer = 0;
    if (!document.hidden && !window.gtPlayer?.transitioning) initializeVehicle();
  }, 0);
}

function clearPointer() {
  const previous = pointer;
  pointer = null;
  host.dataset.dragging = 'false';
  if (previous && host.hasPointerCapture(previous.id)) host.releasePointerCapture(previous.id);
}

function interruptLayoutMotion() {
  if (!layoutMotion) return;
  modeScrub = sample.phase === 'structure' && effectiveExplosion !== sample.explodeProgress
    ? { anchor: sample.explodeProgress, value: effectiveExplosion, position: trackPosition } : null;
  layoutMotion = null;
}

function scrubExplosion() {
  const next = sampleExplosionScrub(trackPosition, modeScrub);
  modeScrub = next.takeover;
  if (next.progress === 0 && !layoutMotion) displayedLayout = layout;
  return next.progress;
}

function takeOverProgress() {
  cancelResizeRestore();
  scrollMotion = null;
  colorMotion = null;
  interruptLayoutMotion();
  requestUpdate();
}

function resetPresentation() {
  presented = false;
  controlsVisible = false;
  lastRenderKey = '';
}

function suspendMotion() {
  cancelResizeRestore();
  cancelAnimationFrame(frameRequest);
  frameRequest = 0;
  clearTimeout(preloadTimer);
  preloadTimer = 0;
  if (preloadIdle && typeof cancelIdleCallback === 'function') cancelIdleCallback(preloadIdle);
  preloadIdle = 0;
  scrollMotion = null;
  colorMotion = null;
  interruptLayoutMotion();
  clearPointer();
  resetPresentation();
  visible = false;
  presentation.apply('suspended');
  vehicle?.setVisible(false);
  updateControls();
}

function resumePresentation() {
  if (document.hidden || window.gtPlayer?.transitioning) return;
  lastRenderKey = '';
  measure();
  schedulePreload();
}

function scrollToPosition(top, immediate = false, durationScale = 1) {
  takeOverProgress();
  clearPointer();
  const maximum = Math.max(0, document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight);
  const destination = clamp(top, 0, maximum);
  const target = sampleExperience((destination - trackStart) / Math.max(1, screenHeight)).explodeProgress;
  if (modeScrub && target === sample.explodeProgress && (target === 0 || target === 1)) {
    modeScrub = null;
    if (!reducedMotion.matches && !immediate) {
      layoutMotion = { stage: 'expand', start: performance.now(), from: effectiveExplosion };
    }
  }
  if (immediate || reducedMotion.matches || Math.abs(destination - scrollY) < 1) {
    window.scrollTo({ top: destination, behavior: 'auto' });
  } else {
    scrollMotion = { from: scrollY, to: destination, start: performance.now(), duration: Math.min(850, 380 + Math.abs(destination - scrollY) * 0.06) * durationScale };
  }
  requestUpdate();
}

function navigate(chapter) {
  measure();
  if (chapter === 'intro') scrollToPosition(0);
  else scrollToPosition(trackStart + positionForChapter(chapter) * screenHeight);
}

function currentYaw() {
  const limit = mix(MAX_COLOR_YAW, MAX_INSPECTION_YAW, sample.prepareProgress);
  return clamp(manualYaw ? colorYaw : sample.scrollYaw, -limit, limit);
}

function selectedPaint() {
  return samplePaint(trackPosition, colorMode === 'manual' ? lockedColor : null);
}

function selectColor(id) {
  if (!PALETTE.some((entry) => entry.id === id) || (colorMode === 'manual' && id === lockedColor)) return;
  cancelResizeRestore();
  const changed = id !== color;
  lockedColor = id;
  colorMode = 'manual';
  color = id;
  savedColor = id;
  savePreference('gt:paint:v1', id);
  if (changed && sample.phase === 'color' && trackPosition >= BRIDGE.end && !pointer?.dragging && !reducedMotion.matches) {
    colorYaw = currentYaw();
    inspectionYaw = colorYaw;
    manualYaw = true;
    colorMotion = { start: performance.now(), from: colorYaw, to: colorYawTarget(colorYaw, yawDirection), duration: 580 };
    yawDirection *= -1;
  }
  requestUpdate();
}

function resumeAutoColor() {
  cancelResizeRestore();
  colorMode = 'auto';
  lockedColor = null;
  colorMotion = null;
  requestUpdate();
}

function selectLayout(next) {
  if (!['vertical', 'horizontal'].includes(next) || (next === layout && displayedLayout === next && !modeScrub && !layoutMotion)) return;
  cancelResizeRestore();
  clearPointer();
  layout = next;
  savePreference('gt:layout:v1', next);
  modeScrub = null;
  if (sample.phase !== 'structure' || sample.explodeProgress === 0 || reducedMotion.matches) {
    displayedLayout = next;
    layoutMotion = null;
  } else {
    layoutMotion = { stage: displayedLayout === next ? 'expand' : 'contract', start: performance.now(), from: effectiveExplosion };
  }
  requestUpdate();
}

function updateControls() {
  const chapter = CHAPTERS[sample.phase];
  stage.dataset.phase = sample.phase;
  stage.dataset.color = color;
  stage.dataset.colorMode = colorMode;
  stage.dataset.hasSavedColor = String(Boolean(savedColor));
  stage.dataset.uiVisible = String(controlsVisible);
  stage.dataset.presented = String(presented);
  stage.dataset.layout = layout;
  stage.dataset.displayedLayout = displayedLayout;
  stage.dataset.layoutSwitching = String(Boolean(layoutMotion));
  stage.dataset.hoodProgress = sample.hoodProgress.toFixed(6);
  stage.dataset.explodeProgress = sample.explodeProgress.toFixed(6);
  stage.dataset.effectiveExplosion = effectiveExplosion.toFixed(6);
  stage.dataset.matchProgress = sample.matchProgress.toFixed(6);
  stage.dataset.hoodVerified = String(vehicle?.diagnostics.hoodVerified === true);
  for (const overlay of stage.querySelectorAll('[data-interactive-ui]')) {
    overlay.inert = !controlsVisible;
    overlay.setAttribute('aria-hidden', String(!controlsVisible));
  }
  host.inert = !controlsVisible;
  byId('vehicle-hotspots').inert = !controlsVisible;
  const bridge = trackPosition < BRIDGE.end;
  setText('chapter-number', bridge ? '01 — 02' : chapter.number);
  setText('chapter-title', bridge ? 'GT Spirit' : chapter.title);
  setText('chapter-description', bridge ? '' : chapter.description);
  const paint = PALETTE.find((entry) => entry.id === color);
  const from = PALETTE.find((entry) => entry.id === paintState.colorFrom);
  const retained = colorMode === 'manual' && sample.matchProgress < 1;
  byId('bridge-status').hidden = true;
  setText('bridge-status', retained ? `${paint.name}` : '');
  const blending = paintState.colorMix > 0 && paintState.colorMix < 1 && paintState.colorFrom !== paintState.color;
  setText('selected-color-label', retained ? `${paint.name}` : paint.name);
  setText('selected-color-code', retained ? 'Originale'
    : blending ? `${from.name} → ${paint.name} · ${paint.label}` : paint.label);
  setText('color-mode-label', retained ? 'Selected' : colorMode === 'manual' ? 'Selected' : 'Scroll preview');
  byId('color-auto').hidden = sample.phase !== 'color' || colorMode !== 'manual';
  byId('color-restore').hidden = sample.phase !== 'color' || colorMode !== 'auto' || !savedColor;
  const savedPaint = PALETTE.find((entry) => entry.id === savedColor);
  if (savedPaint) {
    byId('color-restore').title = `Restore ${savedPaint.name}`;
    byId('color-restore').setAttribute('aria-label', `Restore ${savedPaint.name}`);
  }
  setText('hood-progress', `${Math.round(sample.hoodProgress * 100)}%`);
  setText('explode-progress', `${Math.round(effectiveExplosion * 100)}%`);
  for (const button of root.querySelectorAll('button[data-color]')) {
    button.setAttribute('aria-pressed', String(colorMode === 'manual' && button.dataset.color === lockedColor));
    button.dataset.preview = String(colorMode === 'auto' && button.dataset.color === color);
  }
  for (const button of root.querySelectorAll('button[data-layout]')) {
    button.setAttribute('aria-pressed', String(button.dataset.layout === layout));
    button.dataset.displayed = String(button.dataset.layout === displayedLayout);
  }
  byId('structure-controls-label').textContent = layout !== displayedLayout && !layoutMotion
    ? 'Layout pending' : 'Structure';
  for (const button of root.querySelectorAll('button[data-hood]')) {
    button.setAttribute('aria-pressed', String(button.dataset.hood === (sample.hoodProgress === 0 ? 'closed' : sample.hoodProgress === 1 ? 'open' : '')));
  }
  for (const button of root.querySelectorAll('button[data-explode]')) {
    button.setAttribute('aria-pressed', String(button.dataset.explode === (effectiveExplosion === 0 ? 'assembled' : effectiveExplosion === 1 ? 'expanded' : '')));
  }
  for (const button of root.querySelectorAll('button[data-chapter]')) {
    const current = button.dataset.chapter === sample.phase;
    if (current) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
  }
  for (const phase of ['color', 'hood', 'structure']) byId(`${phase}-controls`).hidden = sample.phase !== phase;
  const seek = byId('structure-seek');
  if (seek && document.activeElement !== seek) seek.value = String(sample.explodeProgress);
  const progress = byId('section-progress');
  if (progress) {
    progress.value = sample.progress;
    progress.style.setProperty('--progress', `${sample.progress * 100}%`);
  }
  setText('interaction-hint', bridge ? 'Scroll to explore'
    : sample.phase === 'color' ? 'Drag to rotate'
      : sample.phase === 'hood' ? 'Scroll to open'
        : layoutMotion ? 'Switching layout'
          : modeScrub ? 'Scroll to expand' : 'Select a part');
  updateLoading();
}

function update(now) {
  frameRequest = 0;
  const intro = window.gtPlayer;
  if (document.hidden || fullscreenTransition || intro?.transitioning) {
    suspendMotion();
    return;
  }
  if (scrollMotion) {
    const p = clamp((now - scrollMotion.start) / scrollMotion.duration);
    window.scrollTo({ top: mix(scrollMotion.from, scrollMotion.to, smooth(p)), behavior: 'auto' });
    if (p === 1) scrollMotion = null;
  }
  if (Number.isFinite(intro?.introEnd)) trackStart = intro.introEnd;
  rawPosition = (scrollY - trackStart) / Math.max(1, screenHeight);
  const position = resizePosition ?? clamp(rawPosition, 0, TRACK_SCREENS);
  const boundary = [BRIDGE.cut, BRIDGE.push, BRIDGE.end, CHAPTERS.hood.start, CHAPTERS.structure.start,
    positionForHood(false), positionForHood(true), positionForExplosion(true), TRACK_SCREENS]
    .find((point) => Math.abs(point - position) * screenHeight <= 0.51);
  trackPosition = boundary ?? position;
  sample = sampleExperience(trackPosition);
  visible = true;
  if (sample.phase !== lastPhase) {
    colorMotion = null;
    vehicle?.clearSelection();
    showPart(null);
    lastPhase = sample.phase;
  }
  if (colorMotion) {
    const p = clamp((now - colorMotion.start) / colorMotion.duration);
    colorYaw = mix(colorMotion.from, colorMotion.to, smooth(p));
    inspectionYaw = colorYaw;
    if (p === 1) colorMotion = null;
  }
  if (sample.phase !== 'structure') {
    interruptLayoutMotion();
    modeScrub = null;
    displayedLayout = layout;
  }
  effectiveExplosion = scrubExplosion();
  if (layoutMotion) {
    const duration = layoutMotion.stage === 'contract' ? 390 : 510;
    const p = clamp((now - layoutMotion.start) / duration);
    if (layoutMotion.stage === 'contract') {
      effectiveExplosion = mix(layoutMotion.from, 0, smooth(p));
      if (p === 1) {
        displayedLayout = layout;
        layoutMotion = { stage: 'expand', start: now, from: 0 };
      }
    } else {
      effectiveExplosion = mix(layoutMotion.from, sample.explodeProgress, smooth(p));
      if (p === 1) layoutMotion = null;
    }
  }
  paintState = selectedPaint();
  color = paintState.color;
  const scene = vehicle?.diagnostics;
  const inIntro = rawPosition <= 0;
  const frame = inIntro ? intro?.targetFrame ?? 30 : 504;
  const usable = scene?.stageReady === true && scene?.introReady === true
    && ranks[readyStage] >= ranks[CHAPTERS[sample.phase].required]
    && scene.presentationReady && !graphicsFailed(scene) && !presentation.cameraError;
  const wasPresented = presented;
  presented = !inIntro && trackPosition >= BRIDGE.cut && Boolean(usable);
  if (wasPresented && !presented) {
    clearPointer();
    vehicle?.clearSelection();
    showPart(null);
  }
  // The canvas, cloth, vehicle and lighting never switch at the intro boundary.
  // Only control visibility and the authored camera track change chapters.
  const mode = inIntro ? 'original' : 'realtime';
  if (presentation.mode !== mode) {
    presentation.apply(mode);
    presentation.measure(intro);
  }
  const renderState = {
    ...(inIntro ? { color: 'silver', colorFrom: 'silver', colorMix: 1 } : paintState),
    yaw: inIntro ? 0 : currentYaw() * sample.matchProgress,
    phase: sample.phase, prepareProgress: inIntro ? 0 : sample.prepareProgress,
    hoodProgress: inIntro ? 0 : sample.hoodProgress,
    explodeProgress: inIntro ? 0 : effectiveExplosion,
    layout: displayedLayout, visible, stageOnly: false,
    matchProgress: inIntro ? 0 : sample.matchProgress,
    introFrame: inIntro ? frame : null,
    introCamera: presentation.cameraFor(frame),
    sourceRect: presentation.sourceRect, viewPadding: presentation.viewPadding,
  };
  const key = JSON.stringify(renderState);
  if (vehicle && key !== lastRenderKey) {
    vehicle.update(renderState);
    lastRenderKey = key;
  }
  controlsVisible = presented && visible && trackPosition >= BRIDGE.end;
  updateControls();
  schedulePreload();
  // Source-video 2D titles fade in as the cloth reveal completes.
  originalStage.dataset.revealText = String(inIntro && frame >= 445);
  if (scrollMotion || colorMotion || layoutMotion) requestUpdate();
}

root.addEventListener('click', (event) => {
  const colorButton = event.target.closest('button[data-color]');
  if (colorButton) return selectColor(colorButton.dataset.color);
  const layoutButton = event.target.closest('button[data-layout]');
  if (layoutButton) return selectLayout(layoutButton.dataset.layout);
  const chapterButton = event.target.closest('button[data-chapter]');
  if (chapterButton) return navigate(chapterButton.dataset.chapter);
  const hoodButton = event.target.closest('button[data-hood]');
  if (hoodButton) return scrollToPosition(trackStart + positionForHood(hoodButton.dataset.hood === 'open') * screenHeight);
  const explosionButton = event.target.closest('button[data-explode]');
  if (explosionButton) scrollToPosition(trackStart + positionForExplosion(explosionButton.dataset.explode === 'expanded') * screenHeight, false, 3.4);
});

byId('structure-seek')?.addEventListener('input', (event) => {
  scrollToPosition(trackStart + positionForExplosionProgress(Number(event.target.value)) * screenHeight, true);
});
byId('color-auto').addEventListener('click', resumeAutoColor);
byId('color-restore').addEventListener('click', () => { if (savedColor) selectColor(savedColor); });
byId('handoff-return').addEventListener('click', () => navigate('intro'));
byId('intro-frame-retry').addEventListener('click', () => byId('retry-button').click());
window.addEventListener('gt:intro-retry', () => retryButton.click());

retryButton.addEventListener('click', async () => {
  if (retryButton.disabled) return;
  retryButton.disabled = true;
  retryButton.hidden = true;
  lastError = '';
  window.gtIntroRenderer?.loading('Loading scene');
  try {
    if (presentation.cameraError) {
      await presentation.loadCameras(true);
      measure();
    }
    if (!vehicle) {
      initialization = null;
      await initializeVehicle();
    } else {
      await vehicle.retry();
      syncReadyStage();
      lastRenderKey = '';
      requestUpdate();
    }
  } catch (error) {
    lastError = error.message || String(error);
    if (!presentation.cameraError) loadStatus = { phase: 'error', stage: 'renderer', detail: lastError, error: lastError };
    window.gtIntroRenderer?.failed(presentation.cameraError || lastError);
    syncReadyStage();
  } finally {
    retryButton.disabled = false;
    updateLoading();
  }
});

byId('part-close').addEventListener('click', () => { vehicle?.clearSelection(); showPart(null); });

host.addEventListener('pointerdown', (event) => {
  if (!event.isPrimary || event.button !== 0 || !controlsVisible || trackPosition < BRIDGE.end) return;
  takeOverProgress();
  clearPointer();
  pointer = { id: event.pointerId, phase: sample.phase, x: event.clientX, y: event.clientY, yaw: currentYaw(), dragging: false };
});
host.addEventListener('pointermove', (event) => {
  if (!pointer || pointer.id !== event.pointerId) return;
  if (!(event.buttons & 1) || !controlsVisible) { clearPointer(); return; }
  const dx = event.clientX - pointer.x;
  const dy = event.clientY - pointer.y;
  if (!pointer.dragging) {
    if (Math.abs(dy) > 9 && Math.abs(dy) > Math.abs(dx)) { clearPointer(); return; }
    if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy) * 1.25) return;
    pointer.dragging = true;
    host.setPointerCapture(event.pointerId);
    host.dataset.dragging = 'true';
  }
  event.preventDefault();
  manualYaw = true;
  const angle = pointer.yaw + dx / Math.max(360, host.clientWidth) * 1.1;
  const limit = mix(MAX_COLOR_YAW, MAX_INSPECTION_YAW, sample.prepareProgress);
  colorYaw = clamp(angle, -limit, limit);
  inspectionYaw = colorYaw;
  requestUpdate();
});
function releasePointer(event) {
  if (!pointer || pointer.id !== event.pointerId) return;
  const click = !pointer.dragging && pointer.phase === sample.phase && event.type === 'pointerup'
    && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < 8;
  clearPointer();
  if (click && controlsVisible && sample.phase !== 'color' && host.contains(event.target)) vehicle?.pick(event.clientX, event.clientY);
}
window.addEventListener('pointerup', releasePointer, true);
window.addEventListener('pointercancel', releasePointer, true);
host.addEventListener('lostpointercapture', (event) => {
  if (event.target === host && pointer?.id === event.pointerId) clearPointer();
});
window.addEventListener('pointerdown', cancelResizeRestore, { capture: true, passive: true });
window.addEventListener('blur', clearPointer);
window.addEventListener('wheel', () => { clearPointer(); takeOverProgress(); }, { passive: true });
let controlTouch = null;
window.addEventListener('touchstart', (event) => {
  if (event.target.closest?.('button, input, summary, a, [role="button"]')) {
    const touch = event.touches[0];
    controlTouch = touch ? { id: touch.identifier, x: touch.clientX, y: touch.clientY } : null;
    cancelResizeRestore();
    return;
  }
  controlTouch = null;
  takeOverProgress();
}, { passive: true });
window.addEventListener('touchmove', (event) => {
  if (!controlTouch) return;
  const touch = Array.from(event.touches).find((item) => item.identifier === controlTouch.id);
  if (!touch) { controlTouch = null; return; }
  const dx = touch.clientX - controlTouch.x;
  const dy = touch.clientY - controlTouch.y;
  if (Math.abs(dy) > 9 && Math.abs(dy) > Math.abs(dx) * 1.25) {
    controlTouch = null;
    clearPointer();
    takeOverProgress();
  }
}, { passive: true });
window.addEventListener('touchend', () => { controlTouch = null; }, { passive: true });
window.addEventListener('touchcancel', () => { controlTouch = null; }, { passive: true });
window.addEventListener('keydown', (event) => {
  cancelResizeRestore();
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
    clearPointer();
    takeOverProgress();
  }
  if (visible && event.key === 'Escape') { vehicle?.clearSelection(); showPart(null); }
});
window.addEventListener('scroll', requestUpdate, { passive: true });
window.addEventListener('resize', scheduleResize, { passive: true });
function restoreAfterFullscreen() {
  fullscreenTransition = true;
  cancelAnimationFrame(fullscreenRequest);
  fullscreenRequest = requestAnimationFrame(() => {
    fullscreenRequest = requestAnimationFrame(() => {
      fullscreenRequest = 0;
      fullscreenTransition = false;
      resumePresentation();
    });
  });
}
window.addEventListener('gt:intro', () => {
  const intro = window.gtPlayer;
  if (intro?.transitioning) {
    fullscreenTransition = true;
    suspendMotion();
    return;
  }
  if (fullscreenTransition) restoreAfterFullscreen();
  else { measure(); schedulePreload(); }
});
function suspendPage() {
  cancelAnimationFrame(fullscreenRequest);
  fullscreenRequest = 0;
  fullscreenTransition = false;
  suspendMotion();
}
window.addEventListener('pagehide', suspendPage);
window.addEventListener('pageshow', () => { if (presentation.mode === 'suspended') resumePresentation(); else measure(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) suspendPage();
  else resumePresentation();
});
document.addEventListener('fullscreenchange', () => {
  fullscreenTransition = true;
  suspendMotion();
  restoreAfterFullscreen();
});
if ('ResizeObserver' in window) {
  const observer = new ResizeObserver(() => measure());
  observer.observe(stage);
  observer.observe(byId('image-region'));
}

Object.defineProperty(window, 'gtExperience', {
  configurable: false,
  get: () => Object.freeze({
    color, colorHex: PALETTE.find((entry) => entry.id === color).hex,
    colorMode, lockedColor, savedColor, colorFrom: paintState.colorFrom, colorMix: paintState.colorMix,
    colorYaw: currentYaw(), inspectionYaw: currentYaw(), manualYaw, colorAnimating: Boolean(colorMotion),
    layout, displayedLayout, switchingLayout: Boolean(layoutMotion),
    modeScrub: modeScrub ? { ...modeScrub } : null,
    phase: sample.phase, progress: sample.progress, chapterProgress: sample.chapterProgress,
    hoodProgress: sample.hoodProgress, explodeProgress: sample.explodeProgress,
    matchProgress: sample.matchProgress, effectiveExplosion,
    trackStart, physicalTrackStart, trackPosition, rawPosition, screenHeight, visible,
    controlsVisible, presented, handoffPending: false, presentation: presentation.mode,
    retainedStage: false, stageSnapshotVisible: false, renderMode: 'realtime-3d',
    sourceRect: presentation.sourceRect ? { ...presentation.sourceRect } : null,
    viewPadding: { ...presentation.viewPadding }, cameraFrames: presentation.cameraCount, cameraError: presentation.cameraError,
    readyStage, loading: { ...loadStatus }, selectedId: selectedPart?.id || selectedPart?.partId || null,
    scrollingByButton: Boolean(scrollMotion), lastError, scene: vehicle?.diagnostics || null,
  }),
});
measure();
