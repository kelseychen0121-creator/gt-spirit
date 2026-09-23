// One quality budget covers every chapter. Geometry and source animation stay intact.
export const QUALITY_TIERS = Object.freeze({
  high: Object.freeze({ name: 'high', pixelRatio: 2, maxPixels: 8294400, shadowSize: 2048, shadowSearch: 24, shadowFilter: 64, reflectionSize: 1024, reflectionSamples: 12 }),
  balanced: Object.freeze({ name: 'balanced', pixelRatio: 1.75, maxPixels: 5184000, shadowSize: 2048, shadowSearch: 16, shadowFilter: 48, reflectionSize: 768, reflectionSamples: 8 }),
  performance: Object.freeze({ name: 'performance', pixelRatio: 1.25, maxPixels: 2304000, shadowSize: 1536, shadowSearch: 10, shadowFilter: 24, reflectionSize: 512, reflectionSamples: 5 }),
});
const ORDER = ['high', 'balanced', 'performance'];
const clock = () => globalThis.performance?.now?.() ?? Date.now();

export function qualitySettings(tier = 'high') {
  const settings = QUALITY_TIERS[typeof tier === 'string' ? tier : tier?.name];
  if (!settings) throw new RangeError(`Unknown rendering quality: ${String(tier)}`);
  return settings;
}

export function qualityPixelRatio(settings, width, height, deviceRatio = 1) {
  const profile = qualitySettings(settings);
  const area = Math.max(1, width) * Math.max(1, height);
  return Math.min(Math.max(0.25, Number.isFinite(deviceRatio) ? deviceRatio : 1), profile.pixelRatio, Math.sqrt(profile.maxPixels / area));
}

// Samples the work itself, not gaps between wheel events. Sparse scroll input must
// never be mistaken for poor frame rate. GPU queries are asynchronous and bounded;
// unavailable timers fall back to conservative CPU submission measurements.
export class RenderQuality {
  constructor(renderer, { tier = 'high', onChange = null } = {}) {
    this.renderer = renderer;
    this.settings = qualitySettings(tier);
    this.onChange = onChange;
    this._gl = renderer.getContext();
    this._timer = this._gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this._pending = [];
    this._active = null;
    this._frames = 0;
    this._samples = [];
    this._lastMean = null;
    this._lastMeasuredTier = null;
    this._lastChange = -Infinity;
    this._start = null;
    this._disposed = false;
  }

  pixelRatio(width, height, deviceRatio = globalThis.devicePixelRatio || 1) {
    return qualityPixelRatio(this.settings, width, height, deviceRatio);
  }

  setTier(tier, reason = 'requested') {
    const settings = qualitySettings(tier);
    if (this._disposed || settings === this.settings) return false;
    this.settings = settings;
    this._reason = reason;
    this._samples.length = 0;
    this._lastChange = clock();
    this.onChange?.(settings);
    return true;
  }

  beginFrame(now = clock()) {
    if (this._disposed || this._start !== null) return;
    this._start = now;
    this._frames += 1;
    this._poll(now);
    // Ignore initial shader compilation and sample one in two requested frames.
    if (!this._timer || this._frames < 8 || this._frames % 2 || this._pending.length >= 4) return;
    const gl = this._gl;
    if (gl.getQuery(this._timer.TIME_ELAPSED_EXT, gl.CURRENT_QUERY)) return;
    const query = gl.createQuery();
    if (!query) return;
    gl.beginQuery(this._timer.TIME_ELAPSED_EXT, query);
    this._active = query;
  }

  endFrame(now = clock()) {
    if (this._disposed || this._start === null) return;
    const elapsed = now - this._start;
    this._start = null;
    if (this._active) {
      this._gl.endQuery(this._timer.TIME_ELAPSED_EXT);
      this._pending.push({ query: this._active, tier: this.settings.name });
      this._active = null;
    }
    if (!this._timer && this._frames >= 8) this._sample(elapsed, now, 'cpu');
    this._poll(now);
  }

  _poll(now) {
    if (!this._timer || !this._pending.length) return;
    const gl = this._gl;
    if (gl.getParameter(this._timer.GPU_DISJOINT_EXT)) {
      for (const entry of this._pending) gl.deleteQuery(entry.query);
      this._pending.length = 0;
      this._samples.length = 0;
      return;
    }
    while (this._pending.length && gl.getQueryParameter(this._pending[0].query, gl.QUERY_RESULT_AVAILABLE)) {
      const entry = this._pending.shift();
      const duration = gl.getQueryParameter(entry.query, gl.QUERY_RESULT) / 1000000;
      gl.deleteQuery(entry.query);
      if (entry.tier === this.settings.name) this._sample(duration, now, 'gpu');
    }
  }

  _sample(duration, now, source) {
    // A context interruption or background tab is not a quality measurement.
    if (!Number.isFinite(duration) || duration <= 0 || duration > 1000) return;
    this._samples.push(duration);
    const count = source === 'gpu' ? 8 : 32;
    if (this._samples.length < count) return;
    const sorted = this._samples.splice(0).sort((a, b) => a - b);
    // Trim isolated shader/upload spikes, while keeping sustained slow work.
    const trimmed = sorted.slice(Math.floor(count / 6), -Math.floor(count / 6));
    this._lastMean = trimmed.reduce((sum, value) => sum + value, 0) / trimmed.length;
    this._lastMeasuredTier = this.settings.name;
    const index = ORDER.indexOf(this.settings.name);
    if (index < ORDER.length - 1 && now - this._lastChange > 2500 && this._lastMean > (source === 'gpu' ? 30 : 28)) {
      this.setTier(ORDER[index + 1], `sustained ${source} render time`);
    }
  }

  get diagnostics() {
    return { tier: this.settings.name, timer: this._timer ? 'gpu' : 'cpu', measuredMs: this._lastMean, measuredTier: this._lastMeasuredTier,
      reason: this._reason ?? 'initial quality budget', frames: this._frames, pendingQueries: this._pending.length,
      motionBlur: 'disabled consistently; no temporal history or reverse-scroll trails' };
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._active) {
      this._gl.endQuery(this._timer.TIME_ELAPSED_EXT);
      this._gl.deleteQuery(this._active);
      this._active = null;
    }
    for (const entry of this._pending) this._gl.deleteQuery(entry.query);
    this._pending.length = 0;
    this._start = null;
  }
}
