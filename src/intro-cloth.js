import * as THREE from '../vendor/three/build/three.module.js';

const ASSETS_BASE = (typeof document !== 'undefined' && document.baseURI) || new URL('../', import.meta.url);
const MANIFEST_URL = new URL('models/intro-cloth.json', ASSETS_BASE);
const SOURCE_HASH = '6a806fe4ce2f32af26f71774a52dbbc81ce7f33304e565d818985e3f2c12ddaa';
const FIRST = 30, LAST = 504, VERTICES = 41745, TRIANGLES = 82656;
const HASH = /^[a-f0-9]{64}$/;
// Thin rigid trim (wipers, window edges) was never part of the cloth collision set and
// pierces the baked surface by a few centimetres. Lift the render pose along its baked
// normals; geometry data stays byte-exact, the displacement is GPU-only.
const LIFT_NEAR = 0.04, LIFT_FAR = 0.01, LIFT_FADE_START = 350;
const liftForFrame = (frame) => LIFT_NEAR + (LIFT_FAR - LIFT_NEAR) * Math.min(1, Math.max(0, (frame - LIFT_FADE_START) / (LAST - LIFT_FADE_START)));
const abortError = () => new DOMException('Cloth loading cancelled', 'AbortError');
const finiteVector = (value) => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);

function validateManifest(data) {
  if (data?.schemaVersion !== 1 || data.id !== 'gt-intro-cloth-v1'
    || data.source?.sha256 !== SOURCE_HASH || data.source?.object !== 'Cover'
    || !data.source?.cache?.isBaked || data.source.cache.simulationRerun !== false || data.source.cache.sourceSaved !== false
    || data.timeline?.firstFrame !== FIRST || data.timeline?.lastFrame !== LAST
    || data.timeline?.frameCount !== LAST - FIRST + 1 || data.timeline?.step !== 1
    || data.encoding?.compression !== 'gzip' || !finiteVector(data.encoding.minimum)
    || !finiteVector(data.encoding.step) || data.encoding.step.some((step) => step <= 0 || step > .0003)
    || data.topology?.vertexCount !== VERTICES || data.topology?.triangles !== TRIANGLES
    || data.topology?.indexCount !== TRIANGLES * 3 || data.topology?.componentType !== 'uint16'
    || !Array.isArray(data.chunks) || data.chunks.length !== 19
    || !data.validation?.sourceHashesUnchanged || !data.validation?.sourceTopologyPreservedAtEveryFrame
    || !data.validation?.sourceSubdivisionPreserved || !data.validation?.losslessCodecRoundTrip
    || data.validation?.vehicleGeometryChanged !== false || data.validation?.sourceCameraChanged !== false
    || !Number.isFinite(data.validation.maxPositionErrorMetres) || data.validation.maxPositionErrorMetres > .00015
    || !Number.isFinite(data.validation.maxNormalErrorDegrees) || data.validation.maxNormalErrorDegrees > 1
    || !Array.isArray(data.bounds) || data.bounds.length !== 2 || !data.bounds.every(finiteVector)
    || !Array.isArray(data.frameBounds) || data.frameBounds.length !== LAST - FIRST + 1
    || data.frameBounds.some((bounds) => !Array.isArray(bounds) || bounds.length !== 2 || !bounds.every(finiteVector))) {
    throw new Error('Intro cloth manifest is invalid');
  }
  for (const record of [data.topology, ...data.chunks]) {
    if (!/^intro-cloth-(?:topology|\d{4})\.bin\.gz$/.test(record.file)
      || !HASH.test(record.sha256) || !HASH.test(record.decodedSha256)
      || !Number.isSafeInteger(record.bytes) || record.bytes <= 0 || record.bytes > 12 * 1024 * 1024
      || !Number.isSafeInteger(record.decodedBytes) || record.decodedBytes <= 0 || record.decodedBytes > 12 * 1024 * 1024) {
      throw new Error('Intro cloth asset metadata is invalid');
    }
  }
  if (data.topology.decodedBytes !== TRIANGLES * 3 * 2) throw new Error('Intro cloth index buffer is invalid');
  let expected = FIRST;
  for (const chunk of data.chunks) {
    if (chunk.firstFrame !== expected || !Number.isInteger(chunk.frameCount) || chunk.frameCount < 1 || chunk.frameCount > 25
      || chunk.positionBytes !== chunk.frameCount * VERTICES * 6 || chunk.normalBytes !== chunk.frameCount * VERTICES * 2
      || chunk.decodedBytes !== chunk.positionBytes + chunk.normalBytes) throw new Error('Intro cloth frames are incomplete');
    expected += chunk.frameCount;
  }
  if (expected !== LAST + 1) throw new Error('Intro cloth timeline is incomplete');
  return data;
}

async function digest(bytes) {
  const value = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function inflateChecked(compressed, record, signal) {
  if (typeof DecompressionStream !== 'function') throw new Error('This browser cannot load the 3D cloth animation');
  const reader = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const output = new Uint8Array(record.decodedBytes);
  let offset = 0;
  try {
    for (;;) {
      if (signal.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.length > output.length) throw new Error('Intro cloth data exceeds its expected size');
      output.set(value, offset);
      offset += value.length;
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (offset !== output.length || await digest(output) !== record.decodedSha256) throw new Error('Intro cloth data integrity check failed');
  return output;
}

async function fetchChunk(record, manifestURL, signal) {
  const response = await fetch(new URL(record.file, manifestURL), { signal });
  if (!response.ok) throw new Error(`Intro cloth could not load (${response.status})`);
  const encoded = await response.arrayBuffer();
  if (encoded.byteLength !== record.bytes || await digest(encoded) !== record.sha256) throw new Error('Intro cloth download integrity check failed');
  if (signal.aborted) throw abortError();
  return inflateChecked(encoded, record, signal);
}

/** Cached source geometry, shaded and rendered every frame by the shared 3D scene. */
export class IntroCloth {
  constructor({ material = null, manifestURL = MANIFEST_URL } = {}) {
    this.group = new THREE.Group();
    this.group.name = 'Original animated cloth';
    this.group.userData = { sourceObject: 'Cover', stageRole: 'cloth', realtimeIntro: true };
    this.mesh = null;
    this._manifestURL = new URL(manifestURL, import.meta.url);
    this._material = material;
    this._ownsMaterial = false;
    this._manifest = null;
    this._positions = null;
    this._normalSamples = null;
    this._normalFrames = [-1, -1];
    this._normalBuffers = null;
    this._pendingFrame = FIRST;
    this._frame = null;
    this._ready = false;
    this._disposed = false;
    this._loadPromise = null;
    this._controller = null;
    this._completedChunks = 0;
    this._error = null;
    this._lastUpdateMs = 0;
  }

  get ready() { return this._ready; }

  get diagnostics() {
    return {
      ready: this._ready, frame: this._frame, pendingFrame: this._pendingFrame,
      bounds: this.mesh?.geometry.boundingBox ? [this.mesh.geometry.boundingBox.min.toArray(), this.mesh.geometry.boundingBox.max.toArray()] : null,
      matrixWorld: this.mesh?.matrixWorld.toArray() ?? null,
      source: 'Original baked Cover geometry', vertices: this._manifest?.topology.vertexCount ?? 0,
      triangles: this._manifest?.topology.triangles ?? 0, sourceFrames: this._manifest?.timeline.frameCount ?? 0,
      completedChunks: this._completedChunks, totalChunks: this._manifest?.chunks.length ?? 0,
      networkBytes: this._manifest?.validation.networkBytes ?? 0,
      animationMemoryBytes: (this._positions?.byteLength ?? 0) + (this._normalSamples?.byteLength ?? 0),
      maxPositionErrorMetres: this._manifest?.validation.maxPositionErrorMetres ?? null,
      maxNormalErrorDegrees: this._manifest?.validation.maxNormalErrorDegrees ?? null,
      sourceTopologyPreserved: this._manifest?.validation.sourceTopologyPreservedAtEveryFrame ?? false,
      sharedStageMaterial: Boolean(this._material && !this._ownsMaterial),
      lastUpdateMs: this._lastUpdateMs, error: this._error,
    };
  }

  setMaterial(material, { owned = false } = {}) {
    if (!material?.isMaterial) throw new TypeError('IntroCloth requires a Three.Material');
    if (this._disposed) throw new Error('Intro cloth is disposed');
    if (this._material && this._material !== material && this._ownsMaterial) this._material.dispose();
    this._material = material;
    this._ownsMaterial = owned;
    this._patchMaterial(material);
    if (this.mesh) this.mesh.material = material;
    return this;
  }

  _patchMaterial(material) {
    if (material.userData.introClothLift) return;
    const uniform = { value: liftForFrame(this._pendingFrame) };
    material.userData.introClothLift = uniform;
    const previousCompile = material.onBeforeCompile;
    material.onBeforeCompile = function (shader, renderer) {
      previousCompile?.call(this, shader, renderer);
      shader.uniforms.introClothLift = uniform;
      shader.vertexShader = 'uniform float introClothLift;\n' + shader.vertexShader
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n  transformed += objectNormal * introClothLift;');
    };
    const previousKey = material.customProgramCacheKey;
    material.customProgramCacheKey = function () { return `${previousKey.call(this)}|intro-cloth-lift`; };
    material.needsUpdate = true;
  }

  load({ signal } = {}) {
    if (this._disposed) return Promise.reject(new Error('Intro cloth is disposed'));
    if (signal?.aborted) return Promise.reject(abortError());
    if (this._ready) return Promise.resolve(this);
    if (this._loadPromise) return this._loadPromise;
    const controller = new AbortController();
    this._controller = controller;
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    this._error = null;
    this._completedChunks = 0;
    this._loadPromise = this._load(controller.signal).catch((error) => {
      controller.abort();
      this._positions = null;
      this._normalSamples = null;
      this._error = error.name === 'AbortError' ? null : error.message;
      throw error;
    }).finally(() => {
      signal?.removeEventListener('abort', onAbort);
      if (this._controller === controller) this._controller = null;
      this._loadPromise = null;
    });
    return this._loadPromise;
  }

  async _load(signal) {
    const response = await fetch(this._manifestURL, { signal });
    if (!response.ok) throw new Error(`Intro cloth manifest could not load (${response.status})`);
    const manifest = validateManifest(await response.json());
    if (signal.aborted) throw abortError();
    this._manifest = manifest;
    this._positions = new Uint16Array(manifest.timeline.frameCount * VERTICES * 3);
    this._normalSamples = new Uint8Array(manifest.timeline.frameCount * VERTICES * 2);
    const topology = await fetchChunk(manifest.topology, this._manifestURL, signal);
    const indices = new Uint16Array(topology.buffer, topology.byteOffset, topology.byteLength / 2);
    for (const index of indices) if (index >= VERTICES) throw new Error('Intro cloth topology is out of range');
    // Bounded concurrency keeps decompression buffers below 25 MB while decoding directly into the cache.
    let cursor = 0;
    let firstFailure = null;
    const workers = Array.from({ length: 3 }, async () => {
      try {
        while (!firstFailure && cursor < manifest.chunks.length) {
          const chunk = manifest.chunks[cursor++];
          const bytes = await fetchChunk(chunk, this._manifestURL, signal);
          if (signal.aborted) throw abortError();
          this._decodeChunk(bytes, chunk);
          this._completedChunks += 1;
        }
      } catch (error) {
        firstFailure ??= error;
        // A failed chunk must release stalled sibling requests before awaiting them.
        // Preserve the original error so cancellation does not hide a download failure.
        this._controller?.abort();
        throw error;
      }
    });
    // Keep all workers accounted for on failure so retry cannot race a stale load.
    const results = await Promise.allSettled(workers);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw firstFailure ?? failed.reason;
    if (signal.aborted || this._disposed) throw abortError();
    const geometry = new THREE.BufferGeometry();
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(VERTICES * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(VERTICES * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geometry.boundingBox = new THREE.Box3(new THREE.Vector3(...manifest.bounds[0]), new THREE.Vector3(...manifest.bounds[1]));
    geometry.boundingBox.expandByScalar(LIFT_NEAR);
    geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
    if (!this._material) {
      const source = manifest.material;
      const linear = (values) => new THREE.Color().setRGB(...values, THREE.LinearSRGBColorSpace);
      this._material = new THREE.MeshPhysicalMaterial({
        color: linear(source.baseColor), roughness: source.roughness, metalness: source.metalness,
        ior: source.ior, sheen: source.sheen, sheenRoughness: source.sheenRoughness,
        sheenColor: linear([1, 1, 1]), side: THREE.DoubleSide,
      });
      this._material.name = 'Original cloth';
      this._ownsMaterial = true;
    }
    this.mesh = new THREE.Mesh(geometry, this._material);
    this._patchMaterial(this._material);
    this.mesh.name = 'Cover';
    this.mesh.userData = { sourceObject: 'Cover', stageRole: 'cloth', realtimeIntro: true };
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.group.add(this.mesh);
    this._normalBuffers = [new Float32Array(VERTICES * 3), new Float32Array(VERTICES * 3)];
    this._normalFrames = [-1, -1];
    this._ready = true;
    this._frame = null;
    this.setFrame(this._pendingFrame);
    return this;
  }

  _decodeChunk(bytes, chunk) {
    const planeSize = chunk.frameCount * VERTICES;
    const firstIndex = chunk.firstFrame - FIRST;
    const positionFrameSize = VERTICES * 3;
    const normalFrameSize = VERTICES * 2;
    for (let axis = 0; axis < 3; axis += 1) {
      const lowPlane = axis * 2 * planeSize;
      const highPlane = lowPlane + planeSize;
      for (let frame = 0; frame < chunk.frameCount; frame += 1) {
        const source = frame * VERTICES;
        let target = (firstIndex + frame) * positionFrameSize + axis;
        for (let vertex = 0; vertex < VERTICES; vertex += 1, target += 3) {
          const delta = bytes[lowPlane + source + vertex] | (bytes[highPlane + source + vertex] << 8);
          this._positions[target] = delta + (frame ? this._positions[target - positionFrameSize] : 0);
        }
      }
    }
    for (let axis = 0; axis < 2; axis += 1) {
      const plane = chunk.positionBytes + axis * planeSize;
      for (let frame = 0; frame < chunk.frameCount; frame += 1) {
        const source = frame * VERTICES;
        let target = (firstIndex + frame) * normalFrameSize + axis;
        for (let vertex = 0; vertex < VERTICES; vertex += 1, target += 2) {
          this._normalSamples[target] = bytes[plane + source + vertex] + (frame ? this._normalSamples[target - normalFrameSize] : 0);
        }
      }
    }
  }

  _decodeNormals(frameIndex, target) {
    let source = frameIndex * VERTICES * 2;
    for (let index = 0; index < target.length; index += 3) {
      let x = this._normalSamples[source++] * (2 / 255) - 1;
      let y = this._normalSamples[source++] * (2 / 255) - 1;
      const z = 1 - Math.abs(x) - Math.abs(y);
      if (z < 0) {
        const nextX = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1);
        y = (1 - Math.abs(x)) * (y >= 0 ? 1 : -1);
        x = nextX;
      }
      const scale = 1 / Math.sqrt(x * x + y * y + z * z);
      target[index] = x * scale;
      target[index + 1] = y * scale;
      target[index + 2] = z * scale;
    }
  }

  setFrame(value) {
    if (!Number.isFinite(value)) throw new TypeError('Intro cloth frame must be finite');
    const frame = Math.min(LAST, Math.max(FIRST, value));
    this._pendingFrame = frame;
    if (!this._ready || this._disposed || frame === this._frame) return false;
    const started = performance.now();
    const first = Math.floor(frame) - FIRST;
    const second = Math.min(LAST - FIRST, first + 1);
    const alpha = frame - Math.floor(frame);
    const size = VERTICES * 3;
    if (this._normalFrames[1] === first) {
      [this._normalFrames[0], this._normalFrames[1]] = [this._normalFrames[1], this._normalFrames[0]];
      [this._normalBuffers[0], this._normalBuffers[1]] = [this._normalBuffers[1], this._normalBuffers[0]];
    }
    for (const [slot, index] of [[0, first], [1, second]]) {
      if (this._normalFrames[slot] !== index) {
        this._decodeNormals(index, this._normalBuffers[slot]);
        this._normalFrames[slot] = index;
      }
    }
    const positions = this.mesh.geometry.attributes.position.array;
    const normals = this.mesh.geometry.attributes.normal.array;
    const [normalA, normalB] = this._normalBuffers;
    const { minimum, step } = this._manifest.encoding;
    const sampleA = first * size, sampleB = second * size;
    for (let index = 0; index < size; index += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        const i = index + axis;
        const a = this._positions[sampleA + i], b = this._positions[sampleB + i];
        positions[i] = minimum[axis] + (a + (b - a) * alpha) * step[axis];
        normals[i] = normalA[i] + (normalB[i] - normalA[i]) * alpha;
      }
    }
    // Interpolated extrema enclose the interpolated vertices; include quantization tolerance and the GPU lift.
    const lift = liftForFrame(frame);
    if (this._material?.userData.introClothLift) this._material.userData.introClothLift.value = lift;
    const boundsA = this._manifest.frameBounds[first], boundsB = this._manifest.frameBounds[second];
    const box = this.mesh.geometry.boundingBox;
    for (let axis = 0; axis < 3; axis += 1) {
      const low = boundsA[0][axis] + (boundsB[0][axis] - boundsA[0][axis]) * alpha;
      const high = boundsA[1][axis] + (boundsB[1][axis] - boundsA[1][axis]) * alpha;
      box.min.setComponent(axis, low - .00015 - lift);
      box.max.setComponent(axis, high + .00015 + lift);
    }
    box.getBoundingSphere(this.mesh.geometry.boundingSphere);
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.geometry.attributes.normal.needsUpdate = true;
    this._frame = frame;
    this._lastUpdateMs = performance.now() - started;
    return true;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._ready = false;
    this._controller?.abort();
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    if (this._material && this._ownsMaterial) this._material.dispose();
    this._material = null;
    this._positions = null;
    this._normalSamples = null;
    this._normalBuffers = null;
    this.group.removeFromParent();
  }
}
