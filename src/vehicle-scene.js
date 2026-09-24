import * as THREE from '../vendor/three/build/three.module.js';
import { GLTFLoader } from '../vendor/three/examples/jsm/loaders/GLTFLoader.js';
import { StudioStage } from './studio-stage.js';
import { CameraRig } from './camera-rig.js';
import { IntroCloth } from './intro-cloth.js';
import { RenderQuality } from './render-quality.js';
import { HighlightBloom } from './highlight-bloom.js';
import { SourceLamps } from './source-lamps.js';

const ASSETS_BASE = (typeof document !== 'undefined' && document.baseURI) || new URL('../', import.meta.url);
const MANIFEST_URL = new URL('models/vehicle.json', ASSETS_BASE);
const STAGES = ['exterior', 'engine-bay', 'structure'];
const BACKGROUND = '#10110f';
const INACTIVITY_TIMEOUT = 60000;
const BAY_SUPPORT_IDS = new Set([
  'BIW-001-L', 'BIW-001-R', 'BIW-002', 'BIW-003',
  'BIW-011-L', 'BIW-011-R', 'BIW-014-L', 'BIW-014-R',
  'BIW-015-L', 'BIW-015-R', 'BIW-017-L', 'BIW-017-R',
  'BIW-023',
  'INT-080', 'INT-081', 'INT-082', 'INT-083', 'INT-084-L', 'INT-084-R',
]);
const COLORS = { green: '#00D83C', orange: '#FF5E00', lime: '#FFD400' };
// Exploded-view part travel multiplier: >1 pushes parts farther out for impact.
const EXPLODE_SPREAD = 1.25;
// Horizontal layout: a true top-down exploded view — every part keeps its
// assembled x/z direction from the car centre, scaled outward and flattened
// onto the floor; an AABB relaxation pass then pushes only the parts that
// actually overlap (formerly stacked columns) apart, so wheel bolts stay by
// their wheel instead of being re-sorted into a size grid.
const GRID_ASPECT = 1.75;
const EXPLODE_GAP = 0.02;
const GROUPS = new Set([
  'EXTERIOR', 'WHEELS', 'STRUCTURE', 'ENGINE', 'TURBO', 'CLUTCH', 'GEARBOX',
  'DRIVELINE', 'FRONT_SUSPENSION', 'REAR_SUSPENSION', 'BRAKES', 'STEERING',
  'COOLING', 'FUEL', 'EXHAUST', 'INTERIOR', 'ELECTRICAL',
]);
const DEFAULT_STATE = {
  color: 'silver', colorFrom: 'silver', colorMix: 1, yaw: 0,
  phase: 'color', prepareProgress: 0, hoodProgress: 0, explodeProgress: 0,
  layout: 'vertical', visible: false, stageOnly: false, matchProgress: 1,
  introCamera: null, introFrame: null, sourceRect: null, viewPadding: null,
};
const PAINT_COLORS = Object.fromEntries(Object.entries(COLORS).map(([id, hex]) => [id, new THREE.Color(hex)]));
const LACQUER_FINISH = Object.freeze({ metalness: 0, roughness: 0.5, clearcoat: 0.4, clearcoatRoughness: 0.4, envGain: 0.5 });
const SILVER_PAINT_ENV_GAIN = 1.2;
const LABELS = {
  renderer: 'Preparing vehicle', manifest: 'Loading vehicle manifest',
  exterior: 'Loading exterior', 'engine-bay': 'Loading engine bay',
  structure: 'Loading structure', complete: 'Vehicle ready',
};
const PAINT_SOURCE = /(?:^|_)(?:bonnet(?:_ref)?|body_n(?:_ref_AeroMaterial\d+)?|aero|closedheadlight(?:_paint)?)(?:[.\s-]\d+)?$/i;
// Final-video compositor glare animation (fix_v13): subtle baseline, stronger
// while the camera sweeps the rear (~200-260) and the front (~330-450), gentle
// hero glow at 504. Scaled so the video baseline matches the previous fixed halo.
const GLARE_KEYS = [[1, 0.45], [180, 0.45], [200, 1.0], [260, 1.0], [290, 0.45], [330, 1.15], [440, 1.15], [470, 0.7], [504, 0.7]];
const GLARE_BASELINE = 0.45;
function glareStrength(frame) {
  const value = frame === null ? GLARE_KEYS[GLARE_KEYS.length - 1][1] : frame;
  let index = 0;
  while (index < GLARE_KEYS.length - 1 && value > GLARE_KEYS[index + 1][0]) index += 1;
  const [frameA, strengthA] = GLARE_KEYS[index];
  if (index >= GLARE_KEYS.length - 1) return strengthA / GLARE_BASELINE;
  const [frameB, strengthB] = GLARE_KEYS[index + 1];
  const alpha = frameB === frameA ? 0 : clamp((value - frameA) / (frameB - frameA), 0, 1);
  return (strengthA + (strengthB - strengthA) * alpha) / GLARE_BASELINE;
}
const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const step = (start, end, value) => THREE.MathUtils.smoothstep(value, start, end);
const vectorOK = (value) => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
const abortError = () => new DOMException('Vehicle request cancelled', 'AbortError');
const materialList = (material) => Array.isArray(material) ? material : [material];
const normalizeGroup = (group) => String(group || 'STRUCTURE').toUpperCase().replace(/[\s-]+/g, '_');

function boxFromMetadata(bounds) {
  if (!Array.isArray(bounds) || !vectorOK(bounds[0]) || !vectorOK(bounds[1])) return null;
  const box = new THREE.Box3(new THREE.Vector3(...bounds[0]), new THREE.Vector3(...bounds[1]));
  return box.isEmpty() ? null : box;
}

function boxPoints(box) {
  const values = new Float64Array(24);
  for (let index = 0; index < 8; index += 1) {
    values[index * 3] = index & 1 ? box.max.x : box.min.x;
    values[index * 3 + 1] = index & 2 ? box.max.y : box.min.y;
    values[index * 3 + 2] = index & 4 ? box.max.z : box.min.z;
  }
  return values;
}

function transformPoints(source, matrix, target) {
  const m = matrix.elements;
  for (let index = 0; index < source.length; index += 3) {
    const x = source[index], y = source[index + 1], z = source[index + 2];
    target[index] = m[0] * x + m[4] * y + m[8] * z + m[12];
    target[index + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    target[index + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
}

function resourcesIn(root) {
  const resources = { geometries: new Set(), materials: new Set(), textures: new Set() };
  root.traverse((node) => {
    if (node.geometry) resources.geometries.add(node.geometry);
    for (const material of materialList(node.material)) {
      if (!material) continue;
      resources.materials.add(material);
      for (const value of Object.values(material)) {
        if (value?.isTexture) resources.textures.add(value);
      }
    }
  });
  return resources;
}

function disposeResources(resources) {
  if (!resources) return;
  for (const geometry of resources.geometries) geometry.dispose();
  for (const material of resources.materials) material.dispose();
  const images = new Set();
  for (const texture of resources.textures) {
    texture.dispose();
    if (texture.source?.data) images.add(texture.source.data);
  }
  for (const image of images) {
    if (typeof image.close === 'function') image.close();
  }
}

function partTraits(metadata, center) {
  const group = normalizeGroup(metadata.group);
  const text = `${metadata.name || ''} ${metadata.subsystem || ''} ${metadata.role || ''}`.toLowerCase();
  const side = Math.abs(center.x) > 0.08 ? Math.sign(center.x)
    : /(?:\bleft\b|\bfl\b|\brl\b|左)/.test(text) ? 1
      : /(?:\bright\b|\bfr\b|\brr\b|右)/.test(text) ? -1 : 0;
  const powertrain = ['ENGINE', 'TURBO', 'CLUTCH', 'GEARBOX', 'DRIVELINE'].includes(group);
  const cover = /(?:housing|cover|casing|bellhousing|\bcase\b|壳体|侧壳|中间壳|端盖|外壳|铝壳|蜗壳|钟形壳|剖分壳|轴承体|轴承座)/.test(text)
    && !/(?:gasket|\bseal\b|\bbolt|\bwasher|密封|油封|螺栓|定位销|垫圈|垫片)/.test(text);
  const internal = metadata.enclosed === true || metadata.role === 'internal'
    || (!cover && (
      /(?:\b(?:bearing|seal|gasket|circlip|synchronizer|synchro|needle)\b|轴承|油封|顶封|侧封|角封|滚针|卡簧|同步器)/.test(text)
      || (powertrain && /(?:\b(?:gear|impeller|rotor|eccentric shaft)\b|齿轮|叶轮|转子|偏心轴|定位销|油泵内|油泵外)/.test(text))));
  return {
    group, side, front: center.z >= 0 ? 1 : -1, internal, cover,
    baySupport: BAY_SUPPORT_IDS.has(String(metadata.id)) || metadata.role === 'engine-bay-support',
    subsystem: String(metadata.subsystem || '').toLowerCase(),
    glass: /(?:glass|glazing|windscreen|windshield|玻璃)/.test(text),
    tire: /(?:tire|tyre|轮胎)/.test(text),
    anchor: group === 'STRUCTURE' && /(?:floor|pan|crossmember|rail|tunnel|subframe|地板|纵梁|横梁|通道|车架)/.test(text),
  };
}

function layoutVectors(entry, groupBox, scale) {
  const { group, side, front, glass, tire, cover, internal, anchor } = entry.traits;
  const vertical = new THREE.Vector3();
  const horizontal = new THREE.Vector3();
  const detailV = new THREE.Vector3();
  const detailH = new THREE.Vector3();
  if (entry.hood) {
    vertical.set(0, 2.22, 0.32);
    horizontal.set(2.6, 0, 0.4);
  } else {
    switch (group) {
      case 'EXTERIOR':
        vertical.set(0, glass ? 1.7 : 1.34, glass ? -0.12 : 0);
        horizontal.set(side ? side * (glass ? 1.9 : 2.1) : glass ? -2.1 : 0, 0, glass ? -0.6 : 0);
        break;
      case 'WHEELS':
        vertical.set(side * (tire ? 0.48 : 0.3), tire ? 0 : 0.22, 0);
        horizontal.set(side * (tire ? 2.3 : 1.9), 0, front * 0.9);
        break;
      case 'STRUCTURE':
        vertical.set(anchor ? 0 : side * 0.08, anchor ? 0.5 : 0.72, 0);
        horizontal.set(anchor ? 0 : side * 0.35, 0, 0);
        break;
      case 'ENGINE': vertical.set(0, 1.13, 0.3); horizontal.set(0, 0, 1.7); break;
      case 'TURBO': vertical.set(0.34, 0.96, 0.3); horizontal.set(1.35, 0, 1.5); break;
      case 'CLUTCH': vertical.set(-0.3, 0.48, 0.2); horizontal.set(-1.3, 0, 0.8); break;
      case 'GEARBOX': vertical.set(0.25, 0.65, -0.14); horizontal.set(1.4, 0, 0.2); break;
      case 'DRIVELINE': vertical.set(0.32, 0.24, -0.1); horizontal.set(1.45, 0, -0.9); break;
      case 'FRONT_SUSPENSION': vertical.set(side * 0.28, 0.24, 0.14); horizontal.set(side * 1.5, 0, 1.1); break;
      case 'REAR_SUSPENSION': vertical.set(side * 0.28, 0.32, -0.14); horizontal.set(side * 1.5, 0, -1.2); break;
      case 'BRAKES': vertical.set(side * 0.76, 0.2, front * 0.06); horizontal.set(side * 2.5, 0, front * 0.5); break;
      case 'STEERING': vertical.set(-0.42, 0.52, 0.2); horizontal.set(-1.5, 0, 0.2); break;
      case 'COOLING': vertical.set(0, 0.85, 0.7); horizontal.set(1.2, 0, 1.4); break;
      case 'FUEL': vertical.set(0, 0.88, -0.5); horizontal.set(-1.3, 0, -1.3); break;
      case 'EXHAUST': vertical.set(-0.54, 0.14, 0); horizontal.set(-2.0, 0, -0.6); break;
      case 'INTERIOR': vertical.set(side * 0.14, 1.04, -0.13); horizontal.set(side ? side * 1.9 : 2.0, 0, -0.3); break;
      case 'ELECTRICAL': vertical.set(side * 0.24, 0.86, front * 0.14); horizontal.set(side ? side * 1.9 : 1.6, 0, front * 0.9); break;
      default: vertical.set(0, 0.5, 0); horizontal.set(0, 0, 0);
    }
  }
  if (!entry.hood && group === 'EXTERIOR') {
    const subsystem = entry.traits.subsystem;
    const roof = /(?:roof|wing)/.test(subsystem);
    const lower = /(?:rocker|nose|bumper|plate|head_|closed_|tail_|light_line)/.test(subsystem);
    const longitudinal = /(?:nose|front_plate|head_|closed_)/.test(subsystem) ? 0.2
      : /(?:rear_bumper|rear_plate|tail_|light_line)/.test(subsystem) ? -0.2 : 0;
    const longitudinalH = longitudinal * (side ? 2.25 : 5);
    vertical.add(new THREE.Vector3(side * (glass ? 0.12 : 0.18), roof ? 0.6 : lower ? -0.38 : 0, longitudinal));
    horizontal.add(new THREE.Vector3(side * (glass ? 0.2 : 0.4), 0, longitudinalH));
    if (!side && !glass && roof) horizontal.set(2.5, 0, -1.3);
  }
  if (!entry.hood && group !== 'EXTERIOR' && group !== 'WHEELS' && !anchor) {
    const middle = groupBox.getCenter(new THREE.Vector3());
    const half = groupBox.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    const nx = clamp((entry.center.x - middle.x) / Math.max(half.x, 0.08), -1, 1);
    const ny = clamp((entry.center.y - middle.y) / Math.max(half.y, 0.08), -1, 1);
    const nz = clamp((entry.center.z - middle.z) / Math.max(half.z, 0.08), -1, 1);
    if (['ENGINE', 'GEARBOX', 'CLUTCH', 'TURBO', 'DRIVELINE'].includes(group)) {
      const authored = vectorOK(entry.metadata.detail) ? entry.metadata.detail : null;
      const reveal = cover ? 0.25 : internal ? -0.08 : 0;
      if (authored) {
        detailV.set(clamp(authored[0], -0.42, 0.42), clamp(authored[1], -0.45, 0.45) + reveal, clamp(authored[2], -0.72, 0.72));
      } else detailV.set(nx * 0.13, reveal + ny * 0.28, nz * 0.62);
      detailH.set(detailV.x * 1.35, detailV.y * 0.3, detailV.z * 1.35);
    } else if (group !== 'STRUCTURE') {
      detailV.set(nx * 0.1, ny * 0.32, nz * 0.18);
      detailH.set(nx * 0.5, ny * 0.12, nz * 0.35);
    }
  }
  for (const vector of [vertical, horizontal, detailV, detailH]) vector.multiplyScalar(scale);
  const groundClearance = Math.max(0, entry.bounds.min.y + 0.006);
  detailV.y = Math.max(detailV.y, -vertical.y - groundClearance + 0.008);
  detailH.y = Math.max(detailH.y, -horizontal.y - groundClearance + 0.008);
  const cabin = glass || group === 'INTERIOR';
  const timing = entry.hood ? [0, 0.128]
    : group === 'EXTERIOR' && !glass ? [0.128, 0.326]
      : cabin ? [0.326, 0.454]
        : [0.454, 0.756];
  return { vertical, horizontal, detailV, detailH, timing };
}

// Horizontal two-stage choreography: majors (any dimension >= H_MAJOR_SIZE)
// fly out and land in stage 1; minors hold their assembled spots at the car's
// centre, then scatter straight outward in stage 2, staggered by final
// distance from the carpet centre (see _layoutHorizontalFlat).
const H_STAGE1 = [0, 0.5], H_STAGE1_DROP = [0.38, 0.5];
const H_MAJOR_SIZE = 0.15;

function writePartMatrix(entry, progress, layout, hoodMatrix, target) {
  const staged = layout === 'horizontal' && entry.layout.timingH;
  const base = entry.layout[layout];
  const fine = layout === 'horizontal' ? entry.layout.detailH : entry.layout.detailV;
  if (staged && entry.layout.ride) {
    // Stage 1: the minor rides its major rigidly (offset = the major's own
    // offset at this progress, drop included). Stage 2: it bursts straight
    // outward from the major's exploded spot to its own halo spot.
    const ride = entry.layout.ride;
    const pm = step(H_STAGE1[0], H_STAGE1[1], progress);
    const pd = step(H_STAGE1_DROP[0], H_STAGE1_DROP[1], progress);
    const px = ride.layout.horizontal.x * pm + ride.layout.detailH.x * pd;
    const py = ride.layout.horizontal.y * pm + ride.layout.detailH.y * pd;
    const pz = ride.layout.horizontal.z * pm + ride.layout.detailH.z * pd;
    const e = step(entry.layout.timingH[0], entry.layout.timingH[1], progress);
    target.makeTranslation(
      px + (base.x + fine.x - px) * e,
      py + (base.y + fine.y - py) * e,
      pz + (base.z + fine.z - pz) * e,
    );
    if (entry.hood) target.multiply(hoodMatrix);
    return target;
  }
  const timing = staged ? entry.layout.timingH : entry.layout.timing;
  const drop = staged ? entry.layout.dropTimingH : [0.756, 1];
  const major = step(timing[0], timing[1], progress);
  const detail = step(drop[0], drop[1], progress);
  target.makeTranslation(
    base.x * major + fine.x * detail,
    base.y * major + fine.y * detail,
    base.z * major + fine.z * detail,
  );
  if (entry.hood) target.multiply(hoodMatrix);
  return target;
}

export class VehicleScene {
  constructor(host, { onStatus, onPart, onReady, onRendered } = {}) {
    this.host = host;
    this._callbacks = { onStatus, onPart, onReady, onRendered };
    this._state = { ...DEFAULT_STATE };
    this._visible = false;
    this._disposed = false;
    this._renderer = null;
    this._manifest = null;
    this._loader = null;
    this._parts = new Map();
    this._assets = new Map();
    this._ready = new Set();
    this._paint = new Map();
    this._cadBodyMaterials = new Set();
    this._selection = null;
    this._selectionMaterials = new Map();
    this._resources = { geometries: new Set(), materials: new Set(), textures: new Set() };
    this._pendingResources = new Set();
    this._retiredGraphics = null;
    this._received = new Map();
    this._expected = new Map();
    this._warnings = new Set();
    this._loadPromise = null;
    this._controller = null;
    this._generation = 0;
    this._raf = 0;
    this._readyStage = 'none';
    this._stage = 'renderer';
    this._lastError = null;
    this._errorContext = null;
    this._callbackError = null;
    this._contextLost = false;
    this._needsRebuild = false;
    this._poseDirty = true;
    this._colorDirty = true;
    this._cameraDirty = true;
    this._lastProgressAt = 0;
    this._renderFrames = 0;
    this._meshCount = 0;
    this._triangles = 0;
    this._drawCalls = 0;
    this._renderedTriangles = 0;
    this._hoodAngle = 0;
    this._effectiveExplode = 0;
    this._effectiveHood = 0;
    this._width = 0;
    this._height = 0;
    this._summary = { partsCount: 0, visibleMeshCount: 0, baselineIntegrityError: 0, positionDrift: 0 };
    this._paintInputs = [];
    this._framing = null;
    this._bayRequiredAssets = new Set();
    this._baselineDirty = true;
    this._flatMaterialCount = 0;
    this._studio = null;
    this._stageReady = false;
    this._presentationReady = false;
    this._matchRenderedFrame = null;
    this._matchRenderedCamera = null;
    this._matchRenderedRect = null;
    this._environmentDirty = true;
    this._stateVersion = 0;
    this._renderedStateVersion = -1;
    this._introCloth = null;
    this._introReady = false;
    this._introRenderedFrame = null;
    this._quality = null;
  }

  async load() {
    if (this._disposed) return false;
    if (this._loadPromise) return this._loadPromise;
    if (this._readyStage === 'complete' && !this._needsRebuild) return this;
    const generation = ++this._generation;
    this._controller = new AbortController();
    this._lastError = null;
    this._errorContext = null;
    const job = this._load(generation);
    this._loadPromise = job;
    const result = await job;
    if (this._generation === generation) this._loadPromise = null;
    return result;
  }

  retry() {
    if (this._disposed) return Promise.resolve(false);
    this._generation += 1;
    this._controller?.abort();
    this._loadPromise = null;
    if (this._needsRebuild || this._contextLost) {
      this._releaseGraphics();
      this._manifest = null;
      this._parts.clear();
      this._assets.clear();
      this._ready.clear();
      this._received.clear();
      this._expected.clear();
      this._readyStage = 'none';
      this._meshCount = 0;
      this._triangles = 0;
      this._contextLost = false;
      this._needsRebuild = false;
    }
    return this.load();
  }

  update(state = {}) {
    if (this._disposed) return;
    const previous = this._state;
    const phase = ['color', 'hood', 'structure'].includes(state.phase) ? state.phase : previous.phase;
    const yawLimit = phase === 'color' ? Math.PI / 12 : Math.PI / 8;
    const next = {
      color: ['silver', 'green', 'orange', 'lime'].includes(state.color) ? state.color : previous.color,
      colorFrom: ['silver', 'green', 'orange', 'lime'].includes(state.colorFrom) ? state.colorFrom : previous.colorFrom,
      colorMix: clamp(finite(state.colorMix, previous.colorMix), 0, 1),
      yaw: clamp(finite(state.yaw, previous.yaw), -yawLimit, yawLimit),
      phase,
      prepareProgress: clamp(finite(state.prepareProgress, previous.prepareProgress), 0, 1),
      hoodProgress: clamp(finite(state.hoodProgress, previous.hoodProgress), 0, 1),
      explodeProgress: clamp(finite(state.explodeProgress, previous.explodeProgress), 0, 1),
      layout: ['vertical', 'horizontal'].includes(state.layout) ? state.layout : previous.layout,
      visible: typeof state.visible === 'boolean' ? state.visible : previous.visible,
      stageOnly: typeof state.stageOnly === 'boolean' ? state.stageOnly : previous.stageOnly,
      matchProgress: clamp(finite(state.matchProgress, previous.matchProgress), 0, 1),
      introFrame: state.introFrame ?? null,
      introCamera: state.introCamera ?? previous.introCamera,
      sourceRect: state.sourceRect ?? previous.sourceRect,
      viewPadding: state.viewPadding ?? previous.viewPadding,
    };
    const colorChanged = ['color', 'colorFrom', 'colorMix'].some((key) => next[key] !== previous[key]);
    const poseChanged = ['yaw', 'phase', 'hoodProgress', 'explodeProgress', 'layout', 'stageOnly']
      .some((key) => next[key] !== previous[key]);
    const cameraChanged = poseChanged || ['prepareProgress', 'matchProgress', 'introCamera', 'sourceRect', 'viewPadding']
      .some((key) => next[key] !== previous[key]);
    this._state = next;
    this._stateVersion += 1;
    this._colorDirty ||= colorChanged;
    this._poseDirty ||= poseChanged || (next.prepareProgress > 0) !== (previous.prepareProgress > 0);
    this._cameraDirty ||= cameraChanged;
    this._environmentDirty ||= next.introFrame !== previous.introFrame || cameraChanged;
    if (next.visible !== this._visible) this.setVisible(next.visible);
    if (colorChanged || poseChanged || cameraChanged || this._environmentDirty) this._requestRender();
  }

  setVisible(visible) {
    if (this._disposed) return;
    const next = Boolean(visible);
    this._state.visible = next;
    this._visible = next;
    if (this._renderer) {
      this._renderer.domElement.hidden = !next;
      this._renderer.domElement.style.display = next ? 'block' : 'none';
    }
    if (!next) {
      if (this._raf) cancelAnimationFrame(this._raf);
      this._raf = 0;
      this.clearSelection();
      return;
    }
    this._resize();
    this._requestRender();
  }

  pick(clientX, clientY) {
    if (this._disposed || !this._visible || this._state.stageOnly || !this._renderer || !this._ready.has('exterior') || this._contextLost) return null;
    this._applyState();
    const rect = this._renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height || clientX < rect.left || clientX > rect.right
      || clientY < rect.top || clientY > rect.bottom) return null;
    this._pointer.set((clientX - rect.left) / rect.width * 2 - 1, 1 - (clientY - rect.top) / rect.height * 2);
    this._raycaster.setFromCamera(this._pointer, this._camera);
    const candidates = [];
    for (const entry of this._parts.values()) {
      if (!entry.active || !this._raycaster.ray.intersectsBox(entry.worldBounds)) continue;
      for (const mesh of entry.pickMeshes) candidates.push(mesh);
    }
    let hit;
    try {
      hit = this._raycaster.intersectObjects(candidates, false)[0];
    } catch (error) {
      this._fail(error, 'selection');
      return null;
    }
    const entry = hit ? this._parts.get(this._meshParts.get(hit.object)) : null;
    if (!entry) {
      this.clearSelection();
      return null;
    }
    if (entry !== this._selection) {
      this._restoreHighlight();
      this._selection = entry;
      this._highlight();
      this._emit('onPart', this._publicPart(entry));
      this._requestRender();
    }
    return this._publicPart(entry);
  }

  clearSelection() {
    if (!this._selection) return;
    this._restoreHighlight();
    this._selection = null;
    this._emit('onPart', null);
    this._requestRender();
  }

  get diagnostics() {
    return {
      ...this._summary,
      readyStage: this._readyStage,
      loadedStages: [...this._ready],
      loadedAssets: [...this._assets.keys()],
      bayRequiredAssets: [...this._bayRequiredAssets],
      meshCount: this._meshCount,
      manifestPartsCount: this._parts.size,
      triangles: this._triangles,
      flatMaterialCount: this._flatMaterialCount,
      paintInputs: this._paintInputs,
      cadBodyMaterials: [...this._cadBodyMaterials].map((material) => ({
        name: material.name, color: material.color.toArray(), metalness: material.metalness, roughness: material.roughness,
      })),
      aPillarReinforcements: ['BIW-020-L', 'BIW-020-R'].map((id) => ({ id, visible: this._parts.get(id)?.active === true })),
      framing: this._framing,
      drawCalls: this._drawCalls,
      renderedTriangles: this._renderedTriangles,
      renderFrames: this._renderFrames,
      stageReady: this._stageReady,
      introReady: this._introReady,
      introRenderedFrame: this._introRenderedFrame,
      cloth: this._introCloth?.diagnostics || null,
      quality: this._quality?.diagnostics || null,
      bloom: this._bloom?.diagnostics || null,
      renderMode: 'realtime-3d',
      presentationReady: this._presentationReady,
      matchRenderedFrame: this._matchRenderedFrame,
      matchRenderedRect: this._matchRenderedRect,
      renderedStateVersion: this._renderedStateVersion,
      stageOnly: this._state.stageOnly,
      vehicleVisible: Boolean(this._vehicle?.visible),
      matchProgress: this._state.matchProgress,
      studio: this._studio?.diagnostics || null,
      lastError: this._lastError,
      errorContext: this._errorContext,
      callbackError: this._callbackError,
      selectedId: this._selection?.id || null,
      color: this._state.color,
      colorFrom: this._state.colorFrom,
      colorMix: this._state.colorMix,
      paintMaterialCount: this._paint.size,
      paintPolicy: 'source-material whitelist; original maps and per-material silver retained',
      hoodAngle: this._hoodAngle,
      hoodStatus: this._manifest?.hood?.status || 'unavailable',
      hoodVerified: this._manifest?.hood?.verified === true,
      hoodBasis: this._manifest?.hood?.basis || null,
      hoodIntersectionBlocked: Boolean(this._manifest?.hood?.status?.startsWith('blocked')),
      hoodAttachedSourceParts: this._manifest?.hood?.attachedSourceParts || [],
      requestedHoodProgress: this._state.hoodProgress,
      effectiveHoodProgress: this._effectiveHood,
      explodeProgress: this._effectiveExplode,
      layout: this._state.layout,
      yaw: this._state.yaw,
      contextLost: this._contextLost,
      visible: this._visible,
      pendingRender: Boolean(this._raf),
      size: [this._width, this._height],
      pixelRatio: this._renderer?.getPixelRatio() || 0,
      loadedBytes: this._loadedBytes(),
      totalBytes: this._totalBytes(),
      bounds: this._frameBox && !this._frameBox.isEmpty()
        ? [this._frameBox.min.toArray(), this._frameBox.max.toArray()] : null,
      camera: this._camera ? {
        position: this._camera.position.toArray(), target: this._cameraTarget.toArray(),
        fov: this._camera.fov, aspect: this._camera.aspect,
        near: this._camera.near, far: this._camera.far,
        matrixWorld: this._camera.matrixWorld.toArray(),
        projectionMatrix: this._camera.projectionMatrix.toArray(),
      } : null,
      warnings: [...this._warnings],
      sourceCount: Array.isArray(this._manifest?.sources) ? this._manifest.sources.length : Object.keys(this._manifest?.sources || {}).length,
      limitations: this._manifest?.limitations || [],
    };
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._generation += 1;
    this._controller?.abort();
    this._loadPromise = null;
    this._releaseGraphics();
    this._parts.clear();
    this._assets.clear();
    this._ready.clear();
    this._manifest = null;
    this._callbacks = {};
  }

  async _load(generation) {
    let batch = null;
    try {
      this._stage = 'renderer';
      this._status('loading', this._stage, 'Preparing materials and studio.');
      await this._yield(generation);
      this._ensureGraphics();
      this._assertCurrent(generation);
      if (!this._stageReady) {
        this._stage = 'stage';
        this._status('loading', this._stage, 'Loading studio.');
        await this._studio.load({ signal: this._controller.signal });
        this._assertCurrent(generation);
        this._stageReady = true;
        this._floor = this._studio.floor;
        this._grid = this._studio.grid;
        this._keyLight = this._studio.keyLight;
        this._environmentDirty = this._cameraDirty = true;
        this._requestRender();
      }
      if (!this._introReady) {
        this._stage = 'intro';
        this._status('loading', 'intro', 'Loading reveal animation.');
        await this._introCloth.load({ signal: this._controller.signal });
        this._assertCurrent(generation);
        this._introReady = true;
        this._studio.setAnimatedCloth(this._introCloth);
        this._environmentDirty = this._cameraDirty = true;
      }
      if (!this._manifest) {
        this._stage = 'manifest';
        this._status('loading', this._stage);
        const response = await fetch(MANIFEST_URL, { signal: this._controller.signal, cache: 'no-cache', priority: 'low' });
        if (!response.ok) throw new Error(`Vehicle manifest failed (HTTP ${response.status})`);
        const data = await response.json();
        this._assertCurrent(generation);
        this._acceptManifest(data);
      }
      for (const model of this._manifest.models) {
        this._assertCurrent(generation);
        if (this._assets.has(model.id)) continue;
        this._stage = model.stage;
        this._received.set(model.id, 0);
        this._status('loading', model.stage, `Loading ${model.id}.`);
        let buffer = await this._fetchModel(model, generation);
        this._status('loading', model.stage, `Validating ${model.id}.`);
        await this._yield(generation);
        await this._validateGLB(buffer, model);
        this._assertCurrent(generation);
        await this._yield(generation);
        const gltf = await this._loader.parseAsync(buffer, new URL('.', model.sourceURL).href);
        buffer = null;
        batch = { resources: resourcesIn(gltf.scene) };
        this._pendingResources.add(batch.resources);
        this._assertCurrent(generation);
        const textures = await gltf.parser.getDependencies('texture');
        this._assertCurrent(generation);
        if (textures.some((texture) => !texture?.image)) {
          throw new Error(`${model.id} textures could not be decoded`);
        }
        if (textures.some((texture) => Math.max(texture.image.width, texture.image.height) > this._renderer.capabilities.maxTextureSize)) {
          throw new Error('Original texture size exceeds this GPU limit');
        }
        batch = await this._prepareModel(gltf, model, batch.resources, generation);
        this._status('loading', model.stage, `Preparing ${model.id} materials.`);
        await this._yield(generation);
        await this._renderer.compileAsync(batch.object, this._camera, this._scene);
        this._assertCurrent(generation);
        if (this._needsRebuild) throw new Error(this._lastError || 'WebGL material preparation failed');
        this._commitModel(batch, model);
        this._pendingResources.delete(batch.resources);
        batch = null;
        for (const stage of STAGES) {
          if (this._ready.has(stage)) continue;
          const required = stage === 'engine-bay' ? [...this._bayRequiredAssets]
            : this._manifest.models.filter((asset) => asset.stage === stage).map((asset) => asset.id);
          if (!required.length || !required.every((id) => this._assets.has(id))) continue;
          this._ready.add(stage);
          this._readyStage = stage === 'structure' ? 'complete' : stage;
          this._poseDirty = this._colorDirty = this._cameraDirty = true;
          this._applyState();
          this._status('ready', this._readyStage, this._readyDetail(stage));
          this._emit('onReady', this._readyStage);
          this._requestRender();
        }
        if (!this._ready.has('engine-bay') && this._assets.has('engine-bay')) {
          this._status('loading', 'engine-bay', 'Preparing engine bay supports.');
        }
        await this._yield(generation);
      }
      return this;
    } catch (error) {
      if (batch && this._pendingResources.delete(batch.resources)) disposeResources(batch.resources);
      if (error?.name !== 'AbortError' && generation === this._generation && !this._disposed) {
        if (this._stage === 'renderer') this._needsRebuild = true;
        this._fail(error, this._stage);
      }
      return false;
    }
  }

  _acceptManifest(data) {
    const sourceModels = data?.models || data?.assets;
    if (!Array.isArray(sourceModels) || !Array.isArray(data.parts) || !data.parts.length) {
      throw new Error('vehicle.json requires models (or assets) and parts');
    }
    if ((data.units && !['metres', 'meters', 'm'].includes(data.units))
      || (data.coordinateSystem?.up && data.coordinateSystem.up !== '+Y')
      || (data.coordinateSystem?.front && data.coordinateSystem.front !== '+Z')) {
      throw new Error('Vehicle must use metres, +Y up and +Z forward');
    }
    const modelIds = new Set();
    const models = sourceModels.map((model) => {
      const stage = model.stage || model.id;
      if (!model.id || !STAGES.includes(stage) || modelIds.has(model.id) || typeof model.url !== 'string') {
        throw new Error('Models require unique IDs and exterior, engine-bay or structure stages');
      }
      modelIds.add(model.id);
      const url = new URL(model.url, MANIFEST_URL);
      if (url.origin !== MANIFEST_URL.origin || !url.pathname.toLowerCase().endsWith('.glb')) {
        throw new Error('Vehicle assets must be same-origin GLB files');
      }
      const requestURL = new URL(url);
      if (model.sha256) requestURL.searchParams.set('v', model.sha256);
      const bytes = Number.isSafeInteger(model.bytes) && model.bytes > 0 ? model.bytes : 0;
      return { ...model, stage, bytes, sourceURL: url.href, requestURL: requestURL.href };
    }).sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage));
    if (new Set(models.map((model) => model.stage)).size !== STAGES.length) {
      throw new Error('Vehicle manifest is missing a model stage');
    }
    const hood = data.hood || {};
    const hoodIds = new Set(Array.isArray(hood.partIds) ? hood.partIds.map(String) : []);
    const parts = new Map();
    for (const metadata of data.parts) {
      if (!metadata.id || parts.has(String(metadata.id))) throw new Error('Part IDs are missing or duplicated');
      const bounds = boxFromMetadata(metadata.bounds);
      if (!bounds) throw new Error(`Part ${metadata.id} is missing bounds in metres`);
      const id = String(metadata.id);
      parts.set(id, this._makePart({ ...metadata, id }, bounds, hoodIds.has(id)));
    }
    for (const id of hoodIds) {
      if (!parts.has(id)) throw new Error(`Hood part ${id} is missing from the manifest`);
    }
    this._hoodValid = hoodIds.size > 0 && vectorOK(hood.pivot) && vectorOK(hood.axis)
      && new THREE.Vector3(...hood.axis).lengthSq() > 0 && Number.isFinite(hood.openAngle);
    if (!this._hoodValid) this._warnings.add('Hood hinge metadata is incomplete; hood movement is disabled.');
    if (hood.verified !== true) this._warnings.add('Hood axis is estimated from its rear edge.');
    this._manifest = { ...data, models };
    this._parts = parts;
    this._expected = new Map(models.map((model) => [model.id, model.bytes]));
    this._bayRequiredAssets = new Set(models.filter((model) => model.stage === 'engine-bay').map((model) => model.id));
    for (const entry of parts.values()) {
      if (!entry.traits.baySupport) continue;
      const model = models.find((asset) => asset.id === entry.metadata.asset || asset.partIds?.includes(entry.id));
      if (model) this._bayRequiredAssets.add(model.id);
    }
    if (models.some((model) => model.id === 'structure')) this._bayRequiredAssets.add('structure');
    this._hoodPivot = this._hoodValid ? new THREE.Vector3(...hood.pivot) : new THREE.Vector3();
    this._hoodAxis = this._hoodValid ? new THREE.Vector3(...hood.axis).normalize() : new THREE.Vector3(1, 0, 0);
    this._hoodOpenAngle = this._hoodValid ? hood.openAngle : 0;
    this._buildLayout();
    this._poseDirty = this._cameraDirty = true;
    this._applyState();
  }

  _makePart(metadata, bounds, hood = false) {
    const center = vectorOK(metadata.center) ? new THREE.Vector3(...metadata.center) : bounds.getCenter(new THREE.Vector3());
    const traits = partTraits(metadata, center);
    if (!GROUPS.has(traits.group)) this._warnings.add(`Unknown part group ${traits.group}; using conservative separation.`);
    return {
      id: String(metadata.id), metadata, bounds, center, traits, hood,
      roots: [], meshes: [], pickMeshes: [], active: false, activeMeshCount: 0,
      object: null, layout: null, triangles: 0, assetIds: new Set(), lastPose: new Float64Array(16).fill(NaN),
      posedBounds: new THREE.Box3(), worldBounds: new THREE.Box3(),
      fitPoints: boxPoints(bounds), worldFitPoints: new Float64Array(24), preciseFit: false,
      poseMatrix: new THREE.Matrix4(),
    };
  }

  _buildLayout() {
    const groupBounds = new Map();
    this._assembledBox = new THREE.Box3();
    const exteriorBox = new THREE.Box3();
    for (const entry of this._parts.values()) {
      this._assembledBox.union(entry.bounds);
      if (['EXTERIOR', 'WHEELS'].includes(entry.traits.group)) exteriorBox.union(entry.bounds);
      if (!groupBounds.has(entry.traits.group)) groupBounds.set(entry.traits.group, new THREE.Box3());
      groupBounds.get(entry.traits.group).expandByPoint(entry.center);
    }
    const scaleBox = exteriorBox.isEmpty() ? this._assembledBox : exteriorBox;
    const size = scaleBox.getSize(new THREE.Vector3());
    this._modelScale = clamp(Math.max(size.x, size.z) / 4.3, 0.7, 1.6);
    for (const entry of this._parts.values()) {
      entry.layout = layoutVectors(entry, groupBounds.get(entry.traits.group), this._modelScale);
      for (const key of ['vertical', 'horizontal', 'detailV', 'detailH']) entry.layout[key].multiplyScalar(EXPLODE_SPREAD);
      if (!entry.preciseFit) {
        entry.fitPoints = boxPoints(entry.bounds);
        entry.worldFitPoints = new Float64Array(entry.fitPoints.length);
      }
    }
    this._gridAspect = (this._width && this._height) ? this._width / this._height : 0;
    this._layoutHorizontalFlat();
  }

  _layoutHorizontalFlat() {
    const size = new THREE.Vector3();
    const gap = EXPLODE_GAP * this._modelScale;
    const items = [];
    let area = 0;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const entry of this._parts.values()) {
      entry.bounds.getSize(size);
      const w = Math.max(size.x, 0.02), d = Math.max(size.z, 0.02);
      items.push({ entry, w, d, hw: w / 2 + gap / 2, hd: d / 2 + gap / 2, x: entry.center.x, z: entry.center.z });
      area += (w + gap) * (d + gap);
      minX = Math.min(minX, entry.center.x);
      maxX = Math.max(maxX, entry.center.x);
      minZ = Math.min(minZ, entry.center.z);
      maxZ = Math.max(maxZ, entry.center.z);
    }
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    const fx = Math.max(maxX - minX, 0.5), fz = Math.max(maxZ - minZ, 0.5);
    const target = clamp((this._gridAspect || GRID_ASPECT) * 0.97, 0.9, 2.4);
    // Whichever reads closer to the window aspect: car nose down, or the whole
    // map rotated 90° so the car's length runs across a wide screen.
    const natural = fx / fz;
    const rotate = Math.abs(Math.log(target / natural)) > Math.abs(Math.log(target * natural));
    const rx = rotate ? fz : fx, rz = rotate ? fx : fz;
    const finalAspect = (rx / rz) * clamp(target / (rx / rz), 0.5, 2);
    const spreadW = Math.sqrt(area * 1.15 * finalAspect);
    const kx = spreadW / rx, kz = (area * 1.15 / spreadW) / rz;
    for (const item of items) {
      const dx = item.x - cx, dz = item.z - cz;
      item.x = (rotate ? dz : dx) * kx;
      item.z = (rotate ? -dx : dz) * kz;
      item.tx = item.x;
      item.tz = item.z;
    }
    // Majors keep the radial spots above. Each minor is re-aimed at a burst
    // halo around its nearest major: its own assembled direction from that
    // major, pushed just past the major's footprint — so bolts ring their
    // wheel and gaskets ring the engine instead of flying back to the centre.
    const majorSize = H_MAJOR_SIZE * this._modelScale;
    const majors = new Set();
    for (const item of items) {
      item.entry.bounds.getSize(size);
      if (item.entry.hood || Math.max(size.x, size.y, size.z) >= majorSize) majors.add(item.entry);
    }
    // Two-phase relaxation. Phase 1 settles majors among themselves first;
    // halos are then anchored to the majors' FINAL positions, so a minor's
    // ride target and its burst target can never disagree (the mismatch used
    // to launch a few parts — e.g. the shifter — across the whole map).
    const order = items.map((_, index) => index);
    let maxHw = 0;
    for (const item of items) maxHw = Math.max(maxHw, item.hw);
    const relax = (majorsOnly) => {
      for (let iteration = 0; iteration < 160; iteration += 1) {
        order.sort((a, b) => items[a].x - items[b].x);
        let maxPen = 0;
        for (let ii = 0; ii < items.length; ii += 1) {
          const a = items[order[ii]];
          const aMajor = majors.has(a.entry);
          for (let jj = ii + 1; jj < items.length; jj += 1) {
            const b = items[order[jj]];
            const dx = b.x - a.x;
            if (dx > a.hw + maxHw) break;
            const bMajor = majors.has(b.entry);
            if (majorsOnly !== (aMajor && bMajor)) continue;
            const ox = a.hw + b.hw - Math.abs(dx);
            if (ox <= 0) continue;
            const dz = b.z - a.z;
            const oz = a.hd + b.hd - Math.abs(dz);
            if (oz <= 0) continue;
            maxPen = Math.max(maxPen, Math.min(ox, oz));
            if (ox < oz) {
              const dir = dx > 0 ? 1 : dx < 0 ? -1 : order[ii] < order[jj] ? 1 : -1;
              if (aMajor && !bMajor) b.x += ox * dir;
              else if (bMajor && !aMajor) a.x -= ox * dir;
              else {
                a.x -= (ox / 2) * dir;
                b.x += (ox / 2) * dir;
              }
            } else {
              const dir = dz > 0 ? 1 : dz < 0 ? -1 : order[ii] < order[jj] ? 1 : -1;
              if (aMajor && !bMajor) b.z += oz * dir;
              else if (bMajor && !aMajor) a.z -= oz * dir;
              else {
                a.z -= (oz / 2) * dir;
                b.z += (oz / 2) * dir;
              }
            }
          }
        }
        if (maxPen < gap * 0.1) break;
      }
    };
    relax(true);
    const itemByEntry = new Map(items.map((item) => [item.entry, item]));
    for (const item of items) {
      const { entry } = item;
      if (majors.has(entry)) continue;
      let best = null, bestDistance = Infinity;
      for (const candidate of majors) {
        const distance = (entry.center.x - candidate.center.x) ** 2
          + (entry.center.y - candidate.center.y) ** 2
          + (entry.center.z - candidate.center.z) ** 2;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = candidate;
        }
      }
      entry.layout.ride = best;
      const parent = itemByEntry.get(best);
      // Halo direction/distance are measured between ASSEMBLED positions
      // (parent.tx/tz), then applied around the parent's settled spot —
      // otherwise a parent that migrated far during relaxation would drag the
      // halo (and the minor's stage-2 flight) across the whole map.
      const lx = item.tx - parent.tx, lz = item.tz - parent.tz;
      const dist = Math.hypot(lx, lz);
      let hash = 0;
      for (const char of entry.id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
      let dirX, dirZ;
      if (dist < 0.05 * this._modelScale) {
        // The minor sits at its major's centre: burst in a deterministic
        // pseudo-random direction so centric hardware still rings the parent.
        const angle = ((hash >>> 0) % 6283) / 1000;
        dirX = Math.cos(angle);
        dirZ = Math.sin(angle);
      } else {
        dirX = lx / dist;
        dirZ = lz / dist;
      }
      // Burst past both the assembled offset and the parent's surface, plus a
      // hashed extra — every minor's final spot rings its parent.
      const surface = 1 / Math.sqrt((dirX / parent.hw) ** 2 + (dirZ / parent.hd) ** 2);
      const burst = Math.max(dist, surface) + (0.3 + 0.6 * ((hash >>> 0) % 1000) / 1000) * this._modelScale;
      item.x = parent.x + dirX * burst;
      item.z = parent.z + dirZ * burst;
      // Stage 2 detachment, lightly hashed so the scatter feels organic.
      const h01 = ((hash >>> 0) % 1000) / 1000;
      entry.layout.timingH = [0.5 + 0.08 * h01, 0.92 + 0.08 * h01];
      entry.layout.dropTimingH = null;
    }
    // Phase 2: minors relax among themselves and against the settled majors
    // (majors pinned — a wide halo may push small parts around, but it never
    // reshapes the major layout).
    relax(false);
    let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
    for (const item of items) {
      bx0 = Math.min(bx0, item.x - item.hw);
      bx1 = Math.max(bx1, item.x + item.hw);
      bz0 = Math.min(bz0, item.z - item.hd);
      bz1 = Math.max(bz1, item.z + item.hd);
    }
    const ox = (bx0 + bx1) / 2, oz = (bz0 + bz1) / 2;
    for (const item of items) {
      const { entry } = item;
      entry.layout.horizontal.set(item.x - ox - entry.center.x, 0, item.z - oz - entry.center.z);
      entry.layout.detailH.set(0, 0.004 * this._modelScale - entry.bounds.min.y, 0);
    }
    // Two-stage choreography: majors fly in stage 1 with their minors riding
    // along; in stage 2 each minor bursts outward from its major to its halo
    // spot (timings assigned per minor above).
    for (const item of items) {
      const { entry } = item;
      if (!majors.has(entry)) continue;
      entry.layout.timingH = [...H_STAGE1];
      entry.layout.dropTimingH = [...H_STAGE1_DROP];
    }
  }

  async _fetchModel(model, generation) {
    await this._yield(generation);
    const controller = new AbortController();
    const parentSignal = this._controller.signal;
    const abort = () => controller.abort();
    parentSignal.addEventListener('abort', abort, { once: true });
    let timer = 0;
    let timedOut = false;
    let reader = null;
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, INACTIVITY_TIMEOUT);
    };
    touch();
    try {
      const response = await fetch(model.requestURL, { signal: controller.signal, priority: 'low', cache: 'default' });
      this._assertCurrent(generation);
      if (!response.ok) throw new Error(`${model.id} failed (HTTP ${response.status})`);
      touch();
      const headerBytes = Number(response.headers.get('content-length'));
      if (!model.bytes && Number.isSafeInteger(headerBytes) && headerBytes > 0) this._expected.set(model.id, headerBytes);
      if (!response.body) {
        const buffer = await response.arrayBuffer();
        this._assertCurrent(generation);
        this._received.set(model.id, buffer.byteLength);
        return buffer;
      }
      const output = model.bytes > 0 && model.bytes < 1024 * 1024 * 1024 ? new Uint8Array(model.bytes) : null;
      const chunks = [];
      let received = 0;
      reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        this._assertCurrent(generation);
        if (done) break;
        touch();
        if (output) {
          if (received + value.byteLength > output.byteLength) throw new Error(`${model.id} exceeds the manifest byte count`);
          output.set(value, received);
        } else chunks.push(value);
        received += value.byteLength;
        this._received.set(model.id, received);
        if (performance.now() - this._lastProgressAt > 120) {
          this._lastProgressAt = performance.now();
          this._status('loading', model.stage, `Loading ${model.id}.`);
        }
      }
      if (model.bytes && received !== model.bytes) throw new Error(`${model.id} byte count mismatch (${received}/${model.bytes})`);
      this._expected.set(model.id, received);
      if (output) return output.buffer;
      const buffer = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
      return buffer.buffer;
    } catch (error) {
      if (reader) await reader.cancel().catch(() => {});
      if (timedOut) throw new Error(`${model.id} timed out after 60 seconds. Retry to continue.`);
      throw error;
    } finally {
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', abort);
      reader?.releaseLock();
    }
  }

  async _validateGLB(buffer, model) {
    if (buffer.byteLength < 20) throw new Error(`${model.id} is not a complete GLB`);
    const view = new DataView(buffer);
    if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2
      || view.getUint32(8, true) !== buffer.byteLength || view.getUint32(16, true) !== 0x4e4f534a) {
      throw new Error(`${model.id} GLB header or length is invalid`);
    }
    if (model.bytes && model.bytes !== buffer.byteLength) throw new Error(`${model.id} GLB byte count mismatch`);
    const jsonLength = view.getUint32(12, true);
    if (20 + jsonLength > buffer.byteLength) throw new Error(`${model.id} GLB JSON is incomplete`);
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLength)));
    const external = [...(json.buffers || []), ...(json.images || [])]
      .some((item) => item.uri && !item.uri.startsWith('data:'));
    if (external) throw new Error(`${model.id} requires embedded textures and buffers`);
    const unsupported = (json.extensionsRequired || [])
      .filter((extension) => ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_texture_basisu'].includes(extension));
    if (unsupported.length) throw new Error(`Unsupported GLB extensions: ${unsupported.join(', ')}`);
    if (model.sha256) {
      if (!/^[a-f\d]{64}$/i.test(model.sha256)) throw new Error(`${model.id} SHA-256 is invalid`);
      if (!globalThis.crypto?.subtle) throw new Error('Open via localhost or HTTPS to verify model SHA-256');
      const digest = await crypto.subtle.digest('SHA-256', buffer);
      const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      if (hash !== model.sha256.toLowerCase()) throw new Error(`${model.id} SHA-256 mismatch`);
    }
  }

  async _prepareModel(gltf, model, resources, generation) {
    gltf.scene.updateMatrixWorld(true);
    const candidates = [];
    const owner = new Map();
    gltf.scene.traverse((node) => {
      if (node.userData?.partId == null) return;
      const id = String(node.userData.partId);
      let ancestor = node.parent;
      while (ancestor && ancestor.userData?.partId == null) ancestor = ancestor.parent;
      if (ancestor && String(ancestor.userData.partId) === id) return;
      const candidate = { node, id, baseline: node.matrixWorld.clone(), meshes: [], bounds: new THREE.Box3(), baseVisible: true };
      for (let parent = node; parent; parent = parent.parent) candidate.baseVisible &&= parent.visible;
      candidates.push(candidate);
      owner.set(node, candidate);
    });
    if (!candidates.length) throw new Error(`${model.id} is missing partId roots`);
    gltf.scene.traverse((mesh) => {
      if (!mesh.isMesh) return;
      let ancestor = mesh;
      while (ancestor && !owner.has(ancestor)) ancestor = ancestor.parent;
      if (!ancestor) throw new Error(`${model.id} mesh ${mesh.name || mesh.uuid} has no assigned part`);
      if (mesh.isSkinnedMesh || mesh.isInstancedMesh) throw new Error(`${model.id} requires static meshes without skinning or instancing`);
      const candidate = owner.get(ancestor);
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      candidate.bounds.union(mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld));
      candidate.meshes.push(mesh);
    });
    const batch = { resources, object: new THREE.Group(), parts: new Map(), paint: new Map(), cadBody: new Set() };
    const paintCopies = new Map();
    const cadBodyCopies = new Map();
    let processed = 0;
    for (const candidate of candidates) {
      if (!candidate.meshes.length || candidate.bounds.isEmpty()) continue;
      const previous = this._parts.get(candidate.id);
      const metadata = { ...previous?.metadata, ...candidate.node.userData, id: candidate.id };
      const original = candidate.node;
      const group = new THREE.Group();
      group.name = `staging:${candidate.id}`;
      group.add(original);
      original.matrix.copy(candidate.baseline);
      original.matrixAutoUpdate = false;
      original.matrixWorldNeedsUpdate = true;
      batch.object.add(group);
      candidate.stage = model.stage;
      candidate.metadata = metadata;
      candidate.motionParentId = metadata.motionParentPartId ? String(metadata.motionParentPartId) : null;
      candidate.movingBounds = new THREE.Box3();
      for (const mesh of candidate.meshes) {
        const materials = materialList(mesh.material).map((material) => {
          if (!material) return material;
          if (model.stage !== 'exterior' && material.userData?.sourceFlatShading === true && !material.flatShading) {
            material.flatShading = true;
            material.needsUpdate = true;
          }
          const source = material.userData?.sourceMaterial || mesh.userData?.sourceMaterial
            || metadata.sourceMaterial || material.name;
          if (source === 'CAD_body' && (material.isMeshStandardMaterial || material.isMeshPhysicalMaterial)) {
            let copy = cadBodyCopies.get(material);
            if (!copy) {
              copy = material.clone();
              copy.color.setRGB(0.42, 0.42, 0.42, THREE.LinearSRGBColorSpace);
              copy.metalness = 0.8;
              copy.roughness = 0.34;
              cadBodyCopies.set(material, copy);
              resources.materials.add(copy);
              batch.cadBody.add(copy);
            }
            return copy;
          }
          const declared = material.userData?.paint ?? mesh.userData?.paint ?? metadata.paint;
          const allowed = declared === true && PAINT_SOURCE.test(String(source || ''));
          if (!allowed || !material.color || !(material.isMeshStandardMaterial || material.isMeshPhysicalMaterial)) return material;
          let copy = paintCopies.get(material);
          if (!copy) {
            copy = material.clone();
            paintCopies.set(material, copy);
            resources.materials.add(copy);
            batch.paint.set(copy, { color: material.color.clone(), metalness: material.metalness, roughness: material.roughness, clearcoat: material.clearcoat ?? null, clearcoatRoughness: material.clearcoatRoughness ?? null, source: String(source) });
          }
          return copy;
        });
        for (const material of materials) this._studio.attachVehicleMaterial(material);
        mesh.material = Array.isArray(mesh.material) ? materials : materials[0];
        const dimensions = mesh.geometry.boundingBox.getSize(new THREE.Vector3());
        const opaque = materials.some((material) => material && (!material.transparent || material.opacity > 0.8) && !(material.transmission > 0.5));
        mesh.castShadow = opaque && (model.id === 'exterior' || Math.max(dimensions.x, dimensions.y, dimensions.z) > 0.045);
        mesh.receiveShadow = opaque;
        if (mesh !== original) {
          if (mesh.matrixAutoUpdate) mesh.updateMatrix();
          mesh.matrixAutoUpdate = false;
        }
        candidate.triangles = (candidate.triangles || 0) + (mesh.geometry.index?.count || mesh.geometry.attributes.position?.count || 0) / 3;
      }
      if (!batch.parts.has(candidate.id)) batch.parts.set(candidate.id, []);
      batch.parts.get(candidate.id).push(candidate);
      processed += 1;
      if (processed % 32 === 0) await this._yield(generation);
    }
    if (!batch.parts.size) throw new Error(`${model.id} has no renderable meshes`);
    if (Array.isArray(model.partIds)) {
      const expected = new Set(model.partIds.map(String));
      if (expected.size !== batch.parts.size || [...expected].some((id) => !batch.parts.has(id))) {
        throw new Error(`${model.id} part IDs do not match the manifest`);
      }
    }
    const triangles = [...batch.parts.values()].flat().reduce((total, root) => total + root.triangles, 0);
    const expectedTriangles = model.geometry?.triangles ?? model.validation?.triangles;
    if (Number.isFinite(expectedTriangles) && triangles !== expectedTriangles) {
      throw new Error(`${model.id} triangle count mismatch (${triangles}/${expectedTriangles})`);
    }
    return batch;
  }

  _commitModel(batch, model) {
    for (const roots of batch.parts.values()) {
      for (const root of roots) {
        if (root.motionParentId && !batch.parts.has(root.motionParentId) && !this._parts.get(root.motionParentId)?.object) {
          throw new Error(`Part ${root.id} is missing motion parent ${root.motionParentId}`);
        }
      }
    }
    let boundsChanged = false;
    for (const [id, roots] of batch.parts) {
      let entry = this._parts.get(id);
      if (!entry) {
        const bounds = roots.reduce((box, root) => box.union(root.bounds), new THREE.Box3());
        entry = this._makePart(roots[0].metadata, bounds, this._manifest.hood?.partIds?.includes(id));
        this._parts.set(id, entry);
        boundsChanged = true;
        this._warnings.add(`${id} is absent from the manifest; using mesh bounds.`);
      }
      if (!entry.object) {
        entry.object = new THREE.Group();
        entry.object.name = `part:${id}`;
        entry.object.matrixAutoUpdate = false;
        entry.object.visible = false;
        this._vehicle.add(entry.object);
      }
      entry.assetIds.add(model.id);
      for (const root of roots) {
        root.node.visible = false;
        entry.object.add(root.node);
        entry.roots.push(root);
        entry.meshes.push(...root.meshes);
        entry.triangles += root.triangles;
        this._meshCount += root.meshes.length;
        this._triangles += root.triangles;
        for (const mesh of root.meshes) this._meshParts.set(mesh, id);
        const padded = entry.bounds.clone().expandByScalar(0.015);
        if (!padded.containsBox(root.bounds)) {
          entry.bounds.union(root.bounds);
          boundsChanged = true;
          this._warnings.add(`${id} exceeds manifest bounds; using mesh bounds.`);
        }
      }
    }
    for (const roots of batch.parts.values()) {
      for (const root of roots) {
        if (!root.motionParentId) continue;
        const parent = this._parts.get(root.motionParentId);
        if (!parent?.object) throw new Error(`Part ${root.id} is missing motion parent ${root.motionParentId}`);
        parent.object.add(root.node);
      }
    }
    for (const [material, original] of batch.paint) this._paint.set(material, original);
    for (const material of batch.cadBody) this._cadBodyMaterials.add(material);
    for (const key of ['geometries', 'materials', 'textures']) {
      for (const item of batch.resources[key]) this._resources[key].add(item);
    }
    this._assets.set(model.id, { parts: [...batch.parts.keys()], bytes: this._received.get(model.id) || 0 });
    this._summary.partsCount = [...this._parts.values()].filter((entry) => entry.roots.length).length;
    this._flatMaterialCount = [...this._resources.materials].filter((material) => material.userData?.sourceFlatShading && material.flatShading).length;
    this._baselineDirty = true;
    if (boundsChanged) this._buildLayout();
    if (model.stage === 'exterior') this._cacheExteriorFit([...batch.parts.keys()]);
    if (model.id === 'exterior' && !this._paint.size) this._warnings.add('No approved paint materials found; original colors retained.');
  }

  _cacheExteriorFit(ids) {
    const point = new THREE.Vector3();
    const world = new THREE.Matrix4();
    for (const id of ids) {
      const entry = this._parts.get(id);
      const matrixByNode = new Map();
      const values = [];
      for (const root of entry.roots) {
        if (root.stage !== 'exterior') continue;
        const rootValues = [];
        root.node.traverse((node) => {
          if (node === root.node) world.copy(root.baseline);
          else world.multiplyMatrices(matrixByNode.get(node.parent), node.matrix);
          matrixByNode.set(node, world.clone());
          if (!node.isMesh || !root.meshes.includes(node)) return;
          const attribute = node.geometry.attributes.position;
          for (let index = 0; index < attribute.count; index += 1) {
            point.fromBufferAttribute(attribute, index).applyMatrix4(world);
            rootValues.push(point.x, point.y, point.z);
          }
        });
        if (root.motionParentId) {
          root.fitPoints = new Float64Array(rootValues);
          root.worldFitPoints = new Float64Array(rootValues.length);
        } else {
          for (const value of rootValues) values.push(value);
        }
      }
      if (!values.length) continue;
      entry.fitPoints = new Float64Array(values);
      entry.worldFitPoints = new Float64Array(values.length);
      entry.preciseFit = true;
    }
  }

  _ensureGraphics() {
    if (this._renderer) return;
    if (!this.host || typeof this.host.appendChild !== 'function') throw new Error('VehicleScene requires a valid render container');
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this._renderer = renderer;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.AgXToneMapping;
    renderer.toneMappingExposure = 0.78;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
    renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
    renderer.debug.onShaderError = (gl, program) => {
      this._needsRebuild = true;
      this._fail(new Error(`WebGL material compilation failed: ${gl.getProgramInfoLog(program) || 'No GPU details'}`), 'shader');
    };
    const canvas = renderer.domElement;
    canvas.style.display = this._visible ? 'block' : 'none';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.hidden = !this._visible;
    canvas.setAttribute('aria-label', 'Interactive GT coupe 3D model');
    this._onContextLost = (event) => {
      event.preventDefault();
      if (this._disposed || this._renderer !== renderer) return;
      this._contextLost = true;
      this._needsRebuild = true;
      this._readyStage = 'none';
      this._ready.clear();
      this._generation += 1;
      this._controller?.abort();
      this._loadPromise = null;
      this._releaseGraphics({ retainLostCanvas: true });
      this._fail(new Error('WebGL context lost. Retry to restore the vehicle.'), 'context');
    };
    this._onContextRestored = () => {
      if (this._disposed || this._retiredGraphics?.canvas !== canvas) return;
      this._contextLost = false;
      this._needsRebuild = true;
      this._status('error', 'context', 'WebGL restored. Retry to reload materials and shadows.', this._lastError);
    };
    canvas.addEventListener('webglcontextlost', this._onContextLost);
    canvas.addEventListener('webglcontextrestored', this._onContextRestored);
    this.host.appendChild(canvas);
    this._scene = new THREE.Scene();
    this._scene.background = new THREE.Color(BACKGROUND);
    this._vehicle = new THREE.Group();
    this._vehicle.name = 'GT — original shared assembly';
    this._scene.add(this._vehicle);
    this._camera = new THREE.PerspectiveCamera(36, 1, 0.05, 80);
    this._camera.position.set(5, 3, 7);
    this._cameraTarget = new THREE.Vector3(0, 0.6, 0);
    this._camera.lookAt(this._cameraTarget);
    this._pointer = new THREE.Vector2();
    this._raycaster = new THREE.Raycaster();
    this._meshParts = new WeakMap();
    this._hoodMatrix = new THREE.Matrix4();
    this._hoodRotatedPivot = new THREE.Vector3();
    this._openHoodMatrix = new THREE.Matrix4();
    this._scratchMatrix = new THREE.Matrix4();
    this._yawMatrix = new THREE.Matrix4();
    this._frameBox = new THREE.Box3();
    this._shadowBounds = new THREE.Box3();
    this._shadowBoundsDirty = true;
    this._scratchBox = new THREE.Box3();
    this._cameraRig = new CameraRig(this._camera);
    this._loader = new GLTFLoader();
    this._makeStudio();
    this._introCloth = new IntroCloth();
    this._scene.add(this._introCloth.group);
    this._studio.setAnimatedCloth(this._introCloth);
    this._quality = new RenderQuality(renderer, { tier: 'high', onChange: (profile) => {
      this._studio?.setQuality(profile);
      this._resize();
      this._requestRender();
    } });
    this._studio.setQuality(this._quality.settings);
    this._lamps = null;
    this._bloom = new HighlightBloom(renderer);
    this._resizeCallback = () => { this._resize(); this._requestRender(); };
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(this._resizeCallback);
      this._resizeObserver.observe(this.host);
    }
    globalThis.addEventListener?.('resize', this._resizeCallback, { passive: true });
    this._resize();
  }

  _makeStudio() {
    this._studio = new StudioStage(this._scene, this._renderer);
    this._floor = this._studio.floor;
    this._grid = this._studio.grid;
    this._keyLight = this._studio.keyLight;
  }

  _resize() {
    if (!this._renderer || this._disposed) return;
    const width = Math.max(1, Math.round(this.host.clientWidth || globalThis.innerWidth || 1));
    const height = Math.max(1, Math.round(this.host.clientHeight || globalThis.innerHeight || 1));
    // The exploded parts grid is packed for the current window shape; rebuild
    // it when the viewport aspect drifts so the carpet always fills the frame.
    const aspect = width / height;
    if (this._parts.size && Math.abs(aspect - (this._gridAspect || 0)) > 0.02) {
      this._gridAspect = aspect;
      this._layoutHorizontalFlat();
      this._poseDirty = true;
    }
    const ratio = this._quality?.pixelRatio(width, height) ?? Math.min(globalThis.devicePixelRatio || 1, 1.5);
    if (width === this._width && height === this._height && ratio === this._renderer.getPixelRatio()) {
      this._bloom?.resize(this._quality?.settings ?? 'balanced');
      return;
    }
    this._width = width;
    this._height = height;
    this._renderer.setPixelRatio(ratio);
    this._renderer.setSize(width, height, false);
    this._bloom?.resize(this._quality?.settings ?? 'balanced');
    this._camera.aspect = width / height;
    this._camera.updateProjectionMatrix();
    this._cameraDirty = true;
  }

  _makeHoodMatrix(angle, target) {
    if (!this._hoodPivot || !this._hoodAxis) return target.identity();
    const pivot = this._hoodPivot;
    target.makeRotationAxis(this._hoodAxis, angle);
    const rotatedPivot = this._hoodRotatedPivot.copy(pivot).applyMatrix4(target);
    target.setPosition(pivot.x - rotatedPivot.x, pivot.y - rotatedPivot.y, pivot.z - rotatedPivot.z);
    return target;
  }

  _rootVisible(entry, stage) {
    if (stage === 'exterior') return this._ready.has('exterior');
    const bayVisible = this._ready.has('engine-bay') && this._state.phase !== 'color'
      && (this._state.prepareProgress > 0 || this._effectiveHood > 0 || this._effectiveExplode > 0);
    if (entry.traits.baySupport && bayVisible) return true;
    if (entry.traits.internal) return this._ready.has('structure') && this._effectiveExplode > 0.65;
    if (stage === 'engine-bay') return bayVisible;
    if (!this._ready.has('structure') || this._state.phase !== 'structure' || this._effectiveExplode < 0.08) return false;
    return true;
  }

  _applyState() {
    if (!this._renderer || this._disposed) return;
    this._vehicle.visible = !this._state.stageOnly;
    if (!this._lamps && this._ready.has('exterior')) {
      this._lamps = new SourceLamps(this._resources.materials);
      this._vehicle.add(this._lamps.group);
    }
    const lampLevel = this._state.phase === 'structure' && this._state.layout === 'horizontal'
      ? 1 - THREE.MathUtils.smoothstep(clamp(this._state.explodeProgress, 0, 1), 0, 0.35) : 1;
    this._lamps?.setFrame(this._state.introFrame, lampLevel);
    this._bloom?.setStrength(glareStrength(this._state.introFrame));
    if (this._introCloth) {
      // The frozen reveal cloth reads as clutter in the top-down parts grid.
      const gridView = this._state.phase === 'structure' && this._state.layout === 'horizontal'
        && this._state.explodeProgress > 0.05;
      // Finale: the settled cloth dissolves so the hero frame stays clean.
      const frame = this._state.introFrame;
      const clothFade = frame == null ? 1 : 1 - THREE.MathUtils.smoothstep(frame, 455, 492);
      const clothMesh = this._introCloth.mesh;
      const clothMaterial = clothMesh?.material;
      const fading = clothFade < 0.999;
      if (clothMaterial && fading !== this._clothFading) {
        this._clothFading = fading;
        clothMaterial.transparent = fading;
        clothMaterial.depthWrite = !fading;
        clothMaterial.needsUpdate = true;
      }
      if (clothMaterial && fading) clothMaterial.opacity = clothFade;
      if (clothMesh) clothMesh.castShadow = clothFade > 0.4;
      this._introCloth.group.visible = !gridView && clothFade > 0.01;
    }
    if (this._introCloth?.ready) {
      const frame = this._state.introFrame ?? 504;
      if (this._introCloth.setFrame(frame)) {
        this._shadowBoundsDirty = true;
        this._renderer.shadowMap.needsUpdate = true;
        this._keyLight.shadow.needsUpdate = true;
      }
    }
    if (this._environmentDirty && this._stageReady) {
      this._studio.update({
        reveal: this._state.matchProgress, phase: this._state.phase,
        prepare: this._state.prepareProgress, explode: this._state.explodeProgress,
        introFrame: this._state.introFrame,
      });
      this._environmentDirty = false;
    }
    if (!this._manifest) {
      if (this._cameraDirty) this._fitCamera();
      return;
    }
    if (this._colorDirty) {
      const selected = this._selection;
      if (selected) this._restoreHighlight();
      const lacquer = (this._state.colorFrom === 'silver' ? 0 : 1) * (1 - this._state.colorMix)
        + (this._state.color === 'silver' ? 0 : 1) * this._state.colorMix;
      this._studio?.setPaintEnvironmentGain(SILVER_PAINT_ENV_GAIN + (LACQUER_FINISH.envGain - SILVER_PAINT_ENV_GAIN) * lacquer);
      let index = 0;
      for (const [material, original] of this._paint) {
        const from = this._state.colorFrom === 'silver' ? original.color : PAINT_COLORS[this._state.colorFrom];
        const to = this._state.color === 'silver' ? original.color : PAINT_COLORS[this._state.color];
        if (this._state.colorMix === 1) material.color.copy(to);
        else if (this._state.colorMix === 0) material.color.copy(from);
        else material.color.copy(from).lerp(to, this._state.colorMix);
        material.metalness = original.metalness + (LACQUER_FINISH.metalness - original.metalness) * lacquer;
        material.roughness = original.roughness + (LACQUER_FINISH.roughness - original.roughness) * lacquer;
        if (original.clearcoat !== null && 'clearcoat' in material) {
          material.clearcoat = original.clearcoat + (LACQUER_FINISH.clearcoat - original.clearcoat) * lacquer;
          material.clearcoatRoughness = original.clearcoatRoughness + (LACQUER_FINISH.clearcoatRoughness - original.clearcoatRoughness) * lacquer;
        }
        if (!this._paintInputs[index]) this._paintInputs[index] = {
          name: material.name, current: [0, 0, 0], original: original.color.toArray(), paint: true,
        };
        material.color.toArray(this._paintInputs[index].current);
        index += 1;
      }
      this._paintInputs.length = index;
      if (selected) this._highlight();
      this._colorDirty = false;
    }
    if (this._poseDirty) {
      this._effectiveHood = this._hoodValid && this._ready.has('engine-bay') && this._state.phase !== 'color'
        ? this._state.hoodProgress : 0;
      this._effectiveExplode = this._ready.has('structure') && this._state.phase === 'structure'
        ? this._state.explodeProgress : 0;
      this._hoodAngle = this._hoodOpenAngle * this._effectiveHood;
      this._makeHoodMatrix(this._hoodAngle, this._hoodMatrix);
      this._vehicle.rotation.y = this._state.yaw;
      this._vehicle.updateMatrix();
      this._yawMatrix.makeRotationY(this._state.yaw);
      this._frameBox.makeEmpty();
      let visibleMeshCount = 0;
      let baselineIntegrityError = this._summary.baselineIntegrityError;
      let restError = 0;
      const atRest = this._effectiveExplode === 0 && this._hoodAngle === 0;
      const checkBaseline = this._baselineDirty || (atRest && this._summary.positionDrift === null);
      for (const entry of this._parts.values()) {
        writePartMatrix(entry, this._effectiveExplode, this._state.layout, this._hoodMatrix, entry.poseMatrix);
        entry.posedBounds.copy(entry.bounds).applyMatrix4(entry.poseMatrix);
        entry.worldBounds.copy(entry.posedBounds).applyMatrix4(this._yawMatrix);
        this._scratchMatrix.multiplyMatrices(this._yawMatrix, entry.poseMatrix);
        let changed = entry.lastFitSource !== entry.fitPoints;
        for (let index = 0; index < 16; index += 1) changed ||= entry.lastPose[index] !== this._scratchMatrix.elements[index];
        if (changed) {
          transformPoints(entry.fitPoints, this._scratchMatrix, entry.worldFitPoints);
          entry.lastPose.set(this._scratchMatrix.elements);
          entry.lastFitSource = entry.fitPoints;
        }
        if (!entry.object) continue;
        entry.object.matrix.copy(entry.poseMatrix);
        entry.object.matrixWorldNeedsUpdate = true;
        entry.active = false;
        entry.pickMeshes.length = 0;
        entry.activeMeshCount = 0;
        for (const root of entry.roots) {
          if (checkBaseline) {
            for (let index = 0; index < 16; index += 1) {
              baselineIntegrityError = Math.max(baselineIntegrityError, Math.abs(root.node.matrix.elements[index] - root.baseline.elements[index]));
            }
          }
          root.node.visible = root.baseVisible && this._rootVisible(entry, root.stage);
          if (!root.node.visible) continue;
          entry.active = true;
          root.node.traverseVisible((mesh) => {
            if (!mesh.isMesh || this._meshParts.get(mesh) !== entry.id) return;
            entry.activeMeshCount += 1;
            if (entry.traits.glass && this._effectiveExplode < 0.1 && this._state.phase !== 'color') return;
            entry.pickMeshes.push(mesh);
          });
        }
        if (atRest) {
          for (let index = 0; index < 16; index += 1) {
            restError = Math.max(restError, Math.abs(entry.object.matrix.elements[index] - (index % 5 === 0 ? 1 : 0)));
          }
        }
        entry.object.visible = entry.active;
        if (entry.active) this._frameBox.union(entry.worldBounds);
        visibleMeshCount += entry.activeMeshCount;
      }
      for (const entry of this._parts.values()) {
        for (const root of entry.roots) {
          if (!root.motionParentId || !root.fitPoints) continue;
          const parent = this._parts.get(root.motionParentId);
          this._scratchMatrix.multiplyMatrices(this._yawMatrix, parent.poseMatrix);
          transformPoints(root.fitPoints, this._scratchMatrix, root.worldFitPoints);
          root.movingBounds.copy(root.bounds).applyMatrix4(this._scratchMatrix);
          entry.worldBounds.union(root.movingBounds);
          if (root.node.visible) this._frameBox.union(root.movingBounds);
        }
      }
      this._summary = { ...this._summary, visibleMeshCount, baselineIntegrityError, positionDrift: atRest ? Math.max(restError, baselineIntegrityError) : null };
      this._baselineDirty = false;
      this._vehicle.updateMatrixWorld(true);
      this._shadowBoundsDirty = true;
      this._renderer.shadowMap.needsUpdate = true;
      this._poseDirty = false;
      this._cameraDirty = true;
      if (this._selection && !this._selection.active) this.clearSelection();
    }
    if (this._shadowBoundsDirty && this._shadowBounds && !this._frameBox.isEmpty()) {
      this._shadowBounds.copy(this._frameBox);
      const cloth = this._introCloth?.mesh;
      if (cloth?.geometry.boundingBox) {
        cloth.updateWorldMatrix(true, false);
        this._scratchBox.copy(cloth.geometry.boundingBox).applyMatrix4(cloth.matrixWorld);
        this._shadowBounds.union(this._scratchBox);
      }
      this._studio.setBounds(this._shadowBounds);
      this._shadowBoundsDirty = false;
    }
    if (this._cameraDirty) {
      this._fitCamera();
      this._cameraDirty = false;
    }
  }

  _fitCamera() {
    if (!this._cameraRig) return;
    this._makeHoodMatrix(this._hoodOpenAngle || 0, this._openHoodMatrix);
    this._cameraRig.update({
      state: this._state, parts: this._parts, width: this._width || 1, height: this._height || 1,
      openHood: this._openHoodMatrix,
    });
    this._cameraTarget.copy(this._cameraRig.target);
    this._framing = this._cameraRig.bounds;
  }

  _highlight() {
    if (!this._selection) return;
    const lift = new THREE.Color('#bce4de').multiplyScalar(0.055);
    for (const mesh of this._selection.meshes) {
      this._selectionMaterials.set(mesh, mesh.material);
      const copies = materialList(mesh.material).map((material) => {
        const copy = material.clone();
        this._studio.attachVehicleMaterial(copy);
        if (copy.emissive) {
          copy.emissive.multiplyScalar(copy.emissiveIntensity ?? 1).add(lift);
          copy.emissiveIntensity = 1;
          copy.emissiveMap = null;
        }
        return copy;
      });
      mesh.material = Array.isArray(mesh.material) ? copies : copies[0];
    }
  }

  _restoreHighlight() {
    for (const [mesh, original] of this._selectionMaterials) {
      for (const material of materialList(mesh.material)) material.dispose();
      mesh.material = original;
    }
    this._selectionMaterials.clear();
  }

  _publicPart(entry) {
    return {
      ...entry.metadata, id: entry.id, group: entry.traits.group,
      center: entry.center.toArray(), bounds: [entry.bounds.min.toArray(), entry.bounds.max.toArray()],
      meshCount: entry.meshes.length, triangles: Math.round(entry.triangles),
      modelStages: [...entry.assetIds], hood: entry.hood,
    };
  }

  _requestRender() {
    if (this._raf || !this._visible || !this._renderer || !this._stageReady
      || !this._introReady || !this._ready.has('exterior') || !this._state.introCamera
      || this._disposed || this._contextLost || this._needsRebuild) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      if (!this._visible || this._disposed || this._contextLost || this._needsRebuild) return;
      try {
        this._quality?.beginFrame();
        this._applyState();
        const firstPresentation = !this._presentationReady && this._ready.has('exterior');
        const matchChanged = this._state.stageOnly && this._state.introFrame === 504 && this._ready.has('exterior')
          && (this._matchRenderedFrame !== 504 || this._matchRenderedCamera !== this._state.introCamera
            || this._matchRenderedRect !== this._state.sourceRect);
        if ((firstPresentation || matchChanged) && this._state.stageOnly) {
          this._vehicle.visible = true;
          this._renderer.shadowMap.needsUpdate = true;
          this._renderer.render(this._scene, this._camera);
          this._vehicle.visible = false;
          this._renderer.shadowMap.needsUpdate = true;
        }
        this._renderer.render(this._scene, this._camera);
        const sceneCalls = this._renderer.info.render.calls;
        const sceneTriangles = this._renderer.info.render.triangles;
        if (!this._needsRebuild && !this._contextLost) this._bloom?.render();
        this._quality?.endFrame();
        // Three reports shader failures through its callback without necessarily throwing.
        // Such a draw must never clear the error or acknowledge a usable scene.
        if (this._needsRebuild || this._contextLost || this._disposed) return;
        this._renderFrames += 1;
        this._introRenderedFrame = this._state.introFrame ?? 504;
        this._renderedStateVersion = this._stateVersion;
        this._drawCalls = sceneCalls;
        this._renderedTriangles = sceneTriangles;
        if (matchChanged) {
          this._matchRenderedFrame = 504;
          this._matchRenderedCamera = this._state.introCamera;
          this._matchRenderedRect = this._state.sourceRect;
        }
        if (firstPresentation || matchChanged) {
          this._presentationReady = true;
          this._emit('onReady', this._readyStage);
        }
        this._emit('onRendered', { frame: this._introRenderedFrame, stateVersion: this._stateVersion });
      } catch (error) {
        this._quality?.endFrame();
        this._needsRebuild = true;
        this._fail(error, 'render');
      }
    });
  }

  _loadedBytes() {
    let total = 0;
    for (const value of this._received.values()) total += value;
    return total;
  }

  _totalBytes() {
    if (!this._manifest || this._expected.size !== this._manifest.models.length
      || [...this._expected.values()].some((bytes) => !bytes)) return null;
    let total = 0;
    for (const value of this._expected.values()) total += value;
    return total;
  }

  _readyDetail(stage) {
    if (stage === 'exterior') return 'Exterior ready. Loading remaining parts.';
    const hinge = this._manifest.hood?.verified === true ? '' : ' Hood axis is estimated.';
    const intersections = this._manifest.hood?.status?.startsWith('blocked')
      ? ' Original hood intersections remain.' : '';
    if (stage === 'engine-bay') return `Engine bay ready. Loading structure.${hinge}${intersections}`;
    return `Vehicle ready.${hinge}${intersections}`;
  }

  _status(phase, stage, detail = '', error = null) {
    const loadedBytes = this._loadedBytes();
    const totalBytes = this._totalBytes();
    const complete = this._readyStage === 'complete' && phase === 'ready';
    const readyLabels = { exterior: 'Exterior ready', 'engine-bay': 'Engine bay ready', complete: 'Vehicle ready' };
    this._emit('onStatus', {
      phase, stage,
      label: phase === 'error' ? 'Vehicle unavailable' : phase === 'ready'
        ? readyLabels[stage] || 'Vehicle stage ready' : LABELS[stage] || 'Preparing vehicle',
      detail, loadedBytes, totalBytes,
      progress: complete ? 1 : totalBytes ? Math.min(0.99, loadedBytes / totalBytes) : null,
      error,
    });
  }

  _fail(error, stage) {
    this._lastError = error instanceof Error ? error.message : String(error);
    this._errorContext = { stage, name: error?.name || 'Error', readyStage: this._readyStage };
    this._status('error', stage, this._lastError, this._lastError);
  }

  _emit(name, value) {
    const recordError = (error) => {
      this._callbackError = `${name}: ${error instanceof Error ? error.message : String(error)}`;
    };
    try {
      const result = this._callbacks[name]?.(value);
      if (result && typeof result.then === 'function') Promise.resolve(result).catch(recordError);
    } catch (error) {
      recordError(error);
    }
  }

  _assertCurrent(generation) {
    if (this._disposed || generation !== this._generation || this._controller?.signal.aborted || this._contextLost) throw abortError();
  }

  async _yield(generation) {
    this._assertCurrent(generation);
    while (!this._visible || this._state.stageOnly) {
      const intro = globalThis.gtPlayer;
      if (!intro || (!String(intro.status).startsWith('loading') && !(intro.networkRequests > 0))) break;
      await new Promise((resolve, reject) => {
        const signal = this._controller.signal;
        const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, 240);
        const cancel = () => { clearTimeout(timer); reject(abortError()); };
        signal.addEventListener('abort', cancel, { once: true });
      });
      this._assertCurrent(generation);
    }
    await new Promise((resolve) => {
      if ((!this._visible || this._state.stageOnly) && typeof requestIdleCallback === 'function') requestIdleCallback(resolve, { timeout: 180 });
      else setTimeout(resolve, 0);
    });
    this._assertCurrent(generation);
  }

  _releaseGraphics({ retainLostCanvas = false } = {}) {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    if (this._resizeCallback) globalThis.removeEventListener?.('resize', this._resizeCallback);
    this._resizeCallback = null;
    const selected = this._selection;
    this._restoreHighlight();
    this._selection = null;
    if (selected && !this._disposed) this._emit('onPart', null);
    disposeResources(this._resources);
    this._resources = { geometries: new Set(), materials: new Set(), textures: new Set() };
    for (const resources of this._pendingResources) disposeResources(resources);
    this._pendingResources.clear();
    this._paint.clear();
    this._cadBodyMaterials.clear();
    this._quality?.dispose();
    this._quality = null;
    this._bloom?.dispose();
    this._bloom = null;
    this._lamps?.dispose();
    this._lamps = null;
    this._introCloth?.dispose();
    this._introCloth = null;
    this._introReady = false;
    this._introRenderedFrame = null;
    this._studio?.dispose();
    this._studio = null;
    this._stageReady = false;
    this._presentationReady = false;
    this._matchRenderedFrame = null;
    this._matchRenderedCamera = null;
    this._matchRenderedRect = null;
    this._renderedStateVersion = -1;
    this._environmentDirty = true;
    this._cameraRig = null;
    if (this._renderer) {
      const renderer = this._renderer;
      const canvas = renderer.domElement;
      const context = renderer.getContext();
      canvas.removeEventListener('webglcontextlost', this._onContextLost);
      if (!retainLostCanvas) canvas.removeEventListener('webglcontextrestored', this._onContextRestored);
      renderer.dispose();
      if (retainLostCanvas) {
        this._retiredGraphics = { canvas, context, onRestore: this._onContextRestored };
      } else {
        if (!context.isContextLost()) context.getExtension('WEBGL_lose_context')?.loseContext();
        canvas.remove();
      }
    }
    if (!retainLostCanvas && this._retiredGraphics) {
      const { canvas, context, onRestore } = this._retiredGraphics;
      canvas.removeEventListener('webglcontextrestored', onRestore);
      if (!context.isContextLost()) context.getExtension('WEBGL_lose_context')?.loseContext();
      canvas.remove();
      this._retiredGraphics = null;
    }
    this._renderer = null;
    this._onContextLost = null;
    if (!retainLostCanvas) this._onContextRestored = null;
    this._scene = null;
    this._vehicle = null;
    this._loader = null;
    this._projectionCoordinates = null;
    this._floor = null;
    this._grid = null;
    this._keyLight = null;
    this._camera = null;
    this._frameBox = null;
    this._width = this._height = 0;
    this._drawCalls = this._renderedTriangles = 0;
    this._hoodAngle = this._effectiveHood = this._effectiveExplode = 0;
    this._summary = { partsCount: 0, visibleMeshCount: 0, baselineIntegrityError: 0, positionDrift: 0 };
    this._paintInputs = [];
    this._framing = null;
    this._baselineDirty = true;
    this._flatMaterialCount = 0;
    this._poseDirty = this._colorDirty = this._cameraDirty = true;
  }
}
