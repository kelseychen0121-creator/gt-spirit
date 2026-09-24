const ASSETS_BASE = (typeof document !== 'undefined' && document.baseURI) || new URL('../', import.meta.url);
const CAMERA_URL = new URL('scene.json?v=20260924d', ASSETS_BASE);
const matrixOK = (value) => Array.isArray(value) && value.length === 16 && value.every(Number.isFinite);

export function containedSourceRect(imageRect, stageRect, width, height) {
  if (![imageRect.width, imageRect.height, width, height].every((value) => Number.isFinite(value) && value > 0)) return null;
  const scale = Math.min(imageRect.width / width, imageRect.height / height);
  return {
    x: imageRect.left - stageRect.left + (imageRect.width - width * scale) / 2,
    y: imageRect.top - stageRect.top + (imageRect.height - height * scale) / 2,
    width: width * scale,
    height: height * scale,
  };
}

export function coveredSourceRect(imageRect, stageRect, width, height) {
  if (![imageRect.width, imageRect.height, width, height].every((value) => Number.isFinite(value) && value > 0)) return null;
  const scale = Math.max(imageRect.width / width, imageRect.height / height);
  return {
    x: imageRect.left - stageRect.left + (imageRect.width - width * scale) / 2,
    y: imageRect.top - stageRect.top + (imageRect.height - height * scale) / 2,
    width: width * scale,
    height: height * scale,
  };
}

export function createPresentation(stage) {
  const originalStage = document.getElementById('stage');
  const loading = document.getElementById('model-loading');
  const originalInert = originalStage.inert;
  const originalHidden = originalStage.getAttribute('aria-hidden');
  const cameraMap = new Map();
  let cameraPromise = null;
  let cameraError = '';
  let mode = 'original';
  let sourceRect = null;
  let viewPadding = { top: 84, bottom: 132, left: 32, right: 32 };

  function measure(intro) {
    const region = document.getElementById('image-region');
    const imageRect = region.getBoundingClientRect();
    const sourceFit = document.body.dataset.introFit === 'cover' ? coveredSourceRect : containedSourceRect;
    const nextRect = sourceFit(imageRect, originalStage.getBoundingClientRect(),
      intro?.image?.width || 0, intro?.image?.height || 0);
    if (!nextRect || !sourceRect || ['x', 'y', 'width', 'height'].some((key) => Math.abs(nextRect[key] - sourceRect[key]) > 0.001)) {
      sourceRect = nextRect;
    }
    const style = getComputedStyle(stage);
    const nextPadding = {
      top: parseFloat(style.paddingTop) || 0,
      bottom: parseFloat(style.paddingBottom) || 0,
      left: parseFloat(style.paddingLeft) || 0,
      right: parseFloat(style.paddingRight) || 0,
    };
    if (Object.keys(nextPadding).some((key) => nextPadding[key] !== viewPadding[key])) viewPadding = nextPadding;
    for (const name of ['--safe-top', '--safe-bottom', '--safe-left', '--safe-right', '--edge-bottom']) {
      const value = style.getPropertyValue(name);
      if (loading.style.getPropertyValue(name) !== value) loading.style.setProperty(name, value);
    }
    return { sourceRect, viewPadding };
  }

  function apply(next) {
    if (next === mode && document.body.dataset.presentation === next) return;
    mode = next;
    document.body.dataset.presentation = mode;
    const inactive = mode === 'realtime';
    originalStage.inert = inactive || originalInert;
    if (mode === 'realtime') originalStage.setAttribute('aria-hidden', 'true');
    else if (originalHidden === null) originalStage.removeAttribute('aria-hidden');
    else originalStage.setAttribute('aria-hidden', originalHidden);
    if (inactive && originalStage.contains(document.activeElement)) document.activeElement.blur();
  }

  function loadCameras(retry = false) {
    if (retry && cameraError) cameraPromise = null;
    if (cameraPromise) return cameraPromise;
    cameraError = '';
    cameraPromise = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new DOMException('Camera data timed out', 'TimeoutError')), 12000);
      try {
        const response = await fetch(CAMERA_URL, { cache: 'force-cache', priority: 'low', signal: controller.signal });
        if (!response.ok) throw new Error(`Camera data failed (HTTP ${response.status})`);
        const data = await response.json();
        if (!Array.isArray(data.frames)) throw new Error('Incomplete camera data');
        for (const record of data.frames) {
          if (!Number.isInteger(record.frame) || !matrixOK(record.camera?.matrixWorld) || !matrixOK(record.camera?.projectionMatrix)) {
            throw new Error('Incomplete camera matrices');
          }
        }
        for (const record of data.frames) {
          cameraMap.set(record.frame, Object.freeze({
            ...record.camera,
            frame: record.frame,
            matrixWorld: Object.freeze([...record.camera.matrixWorld]),
            projectionMatrix: Object.freeze([...record.camera.projectionMatrix]),
          }));
        }
        if (!cameraMap.has(504)) throw new Error('Missing final camera');
        return cameraMap;
      } catch (error) {
        cameraError = error.message || String(error);
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    })();
    return cameraPromise;
  }

  apply('original');
  return {
    apply, measure, loadCameras,
    cameraFor: (frame) => cameraMap.get(frame) || null,
    get mode() { return mode; },
    get sourceRect() { return sourceRect; },
    get viewPadding() { return viewPadding; },
    get cameraError() { return cameraError; },
    get cameraCount() { return cameraMap.size; },
  };
}
