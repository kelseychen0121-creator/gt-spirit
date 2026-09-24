import * as THREE from '../vendor/three/build/three.module.js';
import { GLTFLoader } from '../vendor/three/examples/jsm/loaders/GLTFLoader.js';
import { RectAreaLightUniformsLib } from '../vendor/three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { qualitySettings } from './render-quality.js';

const ASSETS_BASE = (typeof document !== 'undefined' && document.baseURI) || new URL('../', import.meta.url);
const MANIFEST_URL = new URL('models/stage.json', ASSETS_BASE);
const SOURCE_HASH = '6a806fe4ce2f32af26f71774a52dbbc81ce7f33304e565d818985e3f2c12ddaa';
const GROUND_Y = -0.006;
const NOISE_SIZE = 64;
const AREA_RADIANCE = 1 / Math.PI;
const STAGE_PRESENTATION = Object.freeze({
  floorAlbedo: 0.5,
  floorDirectDiffuse: 0.45,
  floorDirectSpecular: 0.12,
  floorIndirectDiffuse: 0.4,
  floorIndirectSpecular: 0.18,
  wallAlbedo: 0.5,
  wallDirectDiffuse: 0.6,
  wallDirectSpecular: 0.5,
  wallIndirectDiffuse: 0.5,
  wallIndirectSpecular: 0.3,
  floorReflection: 0.06,
  background: Object.freeze([0.012, 0.011, 0.0095]),
});
// Light lavender tint for the reveal cloth (static stage cover + shared animated material).
const CLOTH_TINT = '#bfb3e6';
const FLOOR_REFLECTION_GLSL = `
  uniform sampler2D stageReflection;
  uniform float stageReflectionReady;
  uniform int stageReflectionSamples;
  varying vec4 vStageReflection;
  varying vec3 vStageWorld;
  vec3 stageReflectedFloor(vec3 litFloor, vec3 N, vec3 V, float surfaceRoughness) {
    if (stageReflectionReady < 0.5) return litFloor;
    vec2 uv = vStageReflection.xy / vStageReflection.w;
    if (uv.x <= 0.0 || uv.x >= 1.0 || uv.y <= 0.0 || uv.y >= 1.0) return litFloor;
    float lod = surfaceRoughness * 7.5;
    vec2 spread = vec2(0.004, 0.018) * surfaceRoughness;
    vec3 reflected = textureLod(stageReflection, uv, lod).rgb * 0.28;
    for (int i = 0; i < 8; i++) {
      if (i >= stageReflectionSamples) break;
      float a = float(i) * 6.283185307 / float(stageReflectionSamples);
      reflected += textureLod(stageReflection, uv + vec2(cos(a), sin(a)) * spread, lod).rgb * (0.72 / float(stageReflectionSamples));
    }
    float grazing = 1.0 - clamp(dot(N, V), 0.0, 1.0);
    float fresnel = 0.04 + 0.96 * pow(grazing, 5.0);
    float edge = smoothstep(0.0, 0.03, min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y)));
    float reflectionWeight = fresnel * (1.0 - surfaceRoughness * 0.55) * edge * ${STAGE_PRESENTATION.floorReflection.toFixed(3)};
    return mix(litFloor, reflected, reflectionWeight);
  }
`;
const SOFT_SHADOW_GLSL = `
  uniform sampler2D stageBlockerDepth;
  uniform vec2 stageShadowExtent;
  uniform vec2 stageShadowClip;
  uniform float stageEmitterRadius;
  uniform float stageShadowReady;
  uniform int stageShadowSearchSamples;
  uniform int stageShadowFilterSamples;
  varying vec3 vStageShadowPosition;
  vec2 stageDisk(int i, int count) {
    float angle = float(i) * 2.399963229728653;
    return vec2(cos(angle), sin(angle)) * sqrt((float(i) + 0.5) / float(count));
  }
  float getStageShadowMask() {
    #if defined(USE_SHADOWMAP) && defined(SHADOWMAP_TYPE_PCF) && NUM_DIR_LIGHT_SHADOWS > 0
      if (!receiveShadow || stageShadowReady < 0.5) return 1.0;
      vec3 coord = vDirectionalShadowCoord[0].xyz / vDirectionalShadowCoord[0].w;
      if (coord.x < 0.0 || coord.x > 1.0 || coord.y < 0.0 || coord.y > 1.0 || coord.z > 1.0 || coord.z < 0.0) return 1.0;
      float depthSpan = stageShadowClip.y - stageShadowClip.x;
      float receiver = coord.z * depthSpan + stageShadowClip.x;
      vec2 texel = 1.0 / directionalLightShadows[0].shadowMapSize;
      vec2 search = min(vec2(0.12), stageEmitterRadius * 0.7 / stageShadowExtent);
      float blockerSum = 0.0;
      float blockers = 0.0;
      for (int i = 0; i < 24; i++) {
        if (i >= stageShadowSearchSamples) break;
        float sampleDepth = texture2D(stageBlockerDepth, coord.xy + stageDisk(i, stageShadowSearchSamples) * search).r;
        if (sampleDepth < coord.z - 0.00016) {
          blockerSum += sampleDepth * depthSpan + stageShadowClip.x;
          blockers += 1.0;
        }
      }
      float blocker = blockers > 0.0 ? blockerSum / blockers : receiver;
      float penumbra = clamp(stageEmitterRadius * max(0.0, receiver - blocker) / max(1.0, blocker), 0.012, 0.68);
      vec2 radius = max(texel * 1.2, penumbra / stageShadowExtent);
      float visibility = 0.0;
      float angle = fract(sin(dot(floor(vStageShadowPosition.xz * 1024.0), vec2(12.9898, 78.233))) * 43758.5453) * 6.283185307;
      mat2 rotation = mat2(cos(angle), sin(angle), -sin(angle), cos(angle));
      for (int i = 0; i < 64; i++) {
        if (i >= stageShadowFilterSamples) break;
        visibility += texture(directionalShadowMap[0], vec3(coord.xy + rotation * stageDisk(i, stageShadowFilterSamples) * radius, coord.z + directionalLightShadows[0].shadowBias));
      }
      return mix(1.0, visibility / float(stageShadowFilterSamples), directionalLightShadows[0].shadowIntensity);
    #else
      return 1.0;
    #endif
  }
`;
const clamp01 = (value) => THREE.MathUtils.clamp(Number.isFinite(value) ? value : 0, 0, 1);
const linearColor = (value) => new THREE.Color().setRGB(...value, THREE.LinearSRGBColorSpace);
const materialsOf = (material) => Array.isArray(material) ? material : [material];
const abortError = () => new DOMException('Studio request cancelled', 'AbortError');
const arrayOK = (value, length) => Array.isArray(value) && value.length === length && value.every(Number.isFinite);
const SHARED_LTC = ['LTC_FLOAT_1', 'LTC_FLOAT_2', 'LTC_HALF_1', 'LTC_HALF_2'];
const VEHICLE_SHADOW_PATCH = Symbol('source-key-vehicle-shadow');
const VEHICLE_PAINT_SOURCE = /(?:^|_)(?:bonnet(?:_ref)?|body_n(?:_ref_AeroMaterial\d+)?|aero|closedheadlight(?:_paint)?)(?:[.\s-]\d+)?$/i;
const PAINT_PRESENTATION = Object.freeze({ environmentGain: 1.2, shadowScale: 0.6, shadowContrast: 0.04 });
const FOG_PRESENTATION = Object.freeze({ colorDim: 0.16, tint: Object.freeze([1, 0.94, 0.82]) });
const isVehiclePaint = (material) => material.userData?.paint !== false && !/__fixed(?:[.\s-]\d+)?$/i.test(material.name || '') && (material.userData?.paint === true
  || VEHICLE_PAINT_SOURCE.test(String(material.userData?.sourceMaterial || material.name || '').replace(/__(?:paint|fixed)$/, '')));
const VEHICLE_SHADOW_GLSL = `
  float vehicleStageShadow = mix(1.0, getStageShadowMask(), vehicleStageShadowStrength * vehiclePaintShadowScale);
  reflectedLight.directDiffuse *= vehicleStageShadow;
  reflectedLight.directSpecular *= mix(1.0, vehicleStageShadow, 0.72);
  reflectedLight.indirectDiffuse *= mix(1.0, vehicleStageShadow, 0.18);
  reflectedLight.indirectSpecular *= mix(1.0, vehicleStageShadow, 0.08) * vehiclePaintEnvironmentGain;
  #ifdef USE_CLEARCOAT
    clearcoatSpecularDirect *= mix(1.0, vehicleStageShadow, 0.72);
    clearcoatSpecularIndirect *= mix(1.0, vehicleStageShadow, 0.08) * mix(1.0, vehiclePaintEnvironmentGain, 0.6);
  #endif
  #ifdef USE_SHEEN
    sheenSpecularDirect *= vehicleStageShadow;
    sheenSpecularIndirect *= mix(1.0, vehicleStageShadow, 0.18);
  #endif
`;
let ltcUsers = 0;
let ownedLTC = null;

const SOURCE_LIGHTS = [
  { name: 'Key', energyWatts: 520, color: [1, 0.74, 0.5], position: [-4.5, 4.6, 3.8], quaternion: [-0.269055396, -0.402239859, -0.124950603, 0.866140664], direction: [0.629555345, -0.566599846, -0.531624556], sourceShape: 'DISK', sourceSize: [4, 0.25] },
  { name: 'Fill', energyWatts: 135, color: [0.62, 0.74, 1], position: [4.8, 2.7, 0.8], quaternion: [-0.157578349, 0.632440686, 0.133488849, 0.746571243], sourceShape: 'DISK', sourceSize: [3.5, 0.25] },
  { name: 'Rim', energyWatts: 680, color: [1, 0.88, 0.72], position: [0.4, 4.2, -5.4], quaternion: [-0.010801143, 0.955694437, 0.292030841, 0.035347652], sourceShape: 'DISK', sourceSize: [3, 0.25] },
  { name: 'Top', energyWatts: 300, color: [1, 0.93, 0.84], position: [0, 7, 0], quaternion: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], sourceShape: 'DISK', sourceSize: [5, 0.25] },
  { name: 'FrontFill', energyWatts: 180, color: [1, 0.72, 0.48], position: [0, 1.8, 4.8], quaternion: [-0.127034992, 0, 0, 0.991898239], sourceShape: 'SQUARE', sourceSize: [3, 0.25] },
  { name: 'PaintSweep', energyWatts: 360, color: [1, 0.82, 0.62], position: [-4, 2.4, 1.5], quaternion: [-0.166664511, -0.566429973, -0.118245311, 0.798372149], sourceShape: 'SQUARE', sourceSize: [2.2, 0.25] },
  { name: 'TubeLight', energyWatts: 620, color: [1, 0.9, 0.76], position: [0, 5.2, -6], quaternion: [-0.000000081, -0.946154058, -0.32371667, 0.000000052], sourceShape: 'RECTANGLE', sourceSize: [4, 3] },
].map((record) => {
  const area = record.sourceShape === 'DISK' ? Math.PI * (record.sourceSize[0] / 2) ** 2
    : record.sourceSize[0] * (record.sourceShape === 'RECTANGLE' ? record.sourceSize[1] : record.sourceSize[0]);
  const width = record.sourceShape === 'DISK' ? Math.sqrt(area) : record.sourceSize[0];
  const height = record.sourceShape === 'RECTANGLE' ? record.sourceSize[1] : width;
  return { ...record, area, width, height };
});
const SOURCE_LEDS = [
  { name: 'Industrial_LED_X_A', center: [-1.2, 5, -10.15], length: 5.4, axis: [0.7313537, -0.681998372, 0] },
  { name: 'Industrial_LED_X_B', center: [1.2, 5, -10.12], length: 5.4, axis: [0.7313537, 0.681998372, 0] },
  { name: 'Industrial_LED_X_C', center: [0, 6.2, -10.1], length: 5.8, axis: [1, 0, 0] },
  { name: 'Industrial_LED_X_D', center: [-2.8, 4.1, -10.08], length: 3.2, axis: [0.819152057, 0.57357645, 0] },
];
const SOURCE_SURFACES = {
  Industrial_Concrete_Floor: {
    name: 'Industrial_Concrete_Floor', roughness: 0.58, metalness: 0, baseColor: [0.051004717, 0.043585851, 0.035239623],
    procedural: { scale: 4, detail: 5, roughness: 0.72, lacunarity: 2, ramp: [{ position: 0.25, color: [0.03025, 0.02585, 0.0209] }, { position: 0.78, color: [0.07425, 0.06345, 0.0513] }], colorMultiplier: [1, 1, 1], bumpStrength: 0.22, bumpDistance: 0.12 },
  },
  Industrial_Concrete_Wall: {
    name: 'Industrial_Concrete_Wall', roughness: 0.74, metalness: 0, baseColor: [0.009737265, 0.008346227, 0.007233397],
    procedural: { scale: 3.2, detail: 5, roughness: 0.72, lacunarity: 2, ramp: [{ position: 0.25, color: [0.01925, 0.0165, 0.0143] }, { position: 0.78, color: [0.04725, 0.0405, 0.0351] }], colorMultiplier: [0.3, 0.3, 0.3], bumpStrength: 0.16, bumpDistance: 0.12 },
  },
  Industrial_LED_White: { name: 'Industrial_LED_White', baseColor: [0, 0, 0], emissionColor: [1, 0.93, 0.82], emissionStrength: 5, roughness: 0.4, metalness: 0 },
};
const SOURCE_TO_BROWSER = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);

function resourcesIn(root) {
  const resources = { geometries: new Set(), materials: new Set(), textures: new Set() };
  root.traverse((node) => {
    if (node.geometry) resources.geometries.add(node.geometry);
    for (const material of materialsOf(node.material)) {
      if (!material) continue;
      resources.materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) resources.textures.add(value);
    }
  });
  return resources;
}

function disposeResources(resources, shared = new Set()) {
  if (!resources) return;
  for (const geometry of resources.geometries) geometry.dispose();
  for (const material of resources.materials) material.dispose();
  const images = new Set();
  for (const texture of resources.textures) {
    if (shared.has(texture)) continue;
    texture.dispose();
    if (texture.source?.data) images.add(texture.source.data);
  }
  for (const image of images) image.close?.();
  for (const collection of Object.values(resources)) collection.clear();
}

function randomSequence(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function noiseTexture() {
  const random = randomSequence(0x7fd3504);
  const data = Uint8Array.from({ length: NOISE_SIZE ** 3 }, () => Math.floor(random() * 256));
  const texture = new THREE.Data3DTexture(data, NOISE_SIZE, NOISE_SIZE, NOISE_SIZE);
  texture.name = 'Stage generated-coordinate noise lattice';
  texture.format = THREE.RedFormat;
  texture.type = THREE.UnsignedByteType;
  texture.wrapS = texture.wrapT = texture.wrapR = THREE.RepeatWrapping;
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

function glowTexture() {
  const width = 128, height = 32;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const u = (x + 0.5) / width, v = ((y + 0.5) / height - 0.5) * 2;
      const alpha = Math.exp(-v * v * 7) * Math.sin(Math.PI * u) ** 0.3;
      const index = (y * width + x) * 4;
      data[index] = data[index + 1] = data[index + 2] = 255;
      data[index + 3] = Math.round(alpha * 255);
    }
  }
  const texture = new THREE.DataTexture(data, width, height);
  texture.name = 'Stage local LED halo';
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function fallbackRecord(name, role, matrix, localBounds, material) {
  const browser = SOURCE_TO_BROWSER.clone().multiply(matrix);
  return { name, role, matrixWorld: browser.toArray(), generatedFromBrowserMatrix: browser.clone().invert().toArray(), generatedBounds: localBounds, materials: [material] };
}

const DEFAULT_STAGE_STATE = Object.freeze({ reveal: 1, phase: 'color', prepare: 0, explode: 0, introFrame: null });

function writeState(target, { reveal = 1, phase = 'color', prepare = 0, explode = 0, introFrame = null } = DEFAULT_STAGE_STATE) {
  target.reveal = clamp01(reveal);
  target.phase = phase === 'color' || phase === 'hood' || phase === 'structure' ? phase : 'color';
  target.prepare = clamp01(prepare);
  target.explode = clamp01(explode);
  target.introFrame = Number.isFinite(introFrame) ? THREE.MathUtils.clamp(introFrame, 30, 504) : null;
  return target;
}

const SOURCE_VIEW_LOOK = `
  #ifdef TONE_MAPPING
    float stageViewLuma = max(dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722)), 0.00001);
    gl_FragColor.rgb *= pow(stageViewLuma / 0.18, 0.10);
    gl_FragColor.rgb = toneMapping(gl_FragColor.rgb);
  #endif
`;
// Lift only the approved paint's shadows. Midtones/highlights retain the stage
// curve, and the source base colour, texture and metallic inputs stay intact.
const PAINT_VIEW_LOOK = SOURCE_VIEW_LOOK.replace('pow(stageViewLuma / 0.18, 0.10)',
  `pow(stageViewLuma / 0.18, mix(${PAINT_PRESENTATION.shadowContrast.toFixed(2)}, 0.10, smoothstep(0.10, 0.45, stageViewLuma)))`);

function applySourceView(shader, paint = false) {
  shader.fragmentShader = shader.fragmentShader.replace('#include <tonemapping_fragment>', paint ? PAINT_VIEW_LOOK : SOURCE_VIEW_LOOK);
}

function atmosphereTexture() {
  const width = 128;
  const data = new Uint8Array(width * width * 4);
  for (let y = 0; y < width; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = (x + 0.5) / (width / 2) - 1, dy = (y + 0.5) / (width / 2) - 1;
      const radius = Math.sqrt(dx * dx + dy * dy);
      const opacity = Math.exp(-radius * radius * 5) * Math.max(0, 1 - radius);
      const index = (y * width + x) * 4;
      data[index] = data[index + 1] = data[index + 2] = 255;
      data[index + 3] = Math.round(opacity * 255);
    }
  }
  const texture = new THREE.DataTexture(data, width, width);
  texture.name = 'Source light local scattering kernel';
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

const NOISE_SHADER = `
  uniform highp sampler3D stageNoise;
  uniform float stageScale;
  uniform float stageNoiseRoughness;
  uniform float stageLacunarity;
  uniform float stageBump;
  uniform vec3 stageLow;
  uniform vec3 stageHigh;
  uniform vec2 stageRamp;
  varying vec3 vStageGenerated;
  float stageNoiseAt(vec3 p) {
    vec3 cell = floor(p);
    vec3 f = fract(p);
    f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    return texture(stageNoise, (cell + f + 0.5) / 64.0).r;
  }
  float stageFBM(vec3 p) {
    float sum = 0.0;
    float amplitude = 1.0;
    float total = 0.0;
    for (int octave = 0; octave < STAGE_OCTAVES; octave++) {
      sum += stageNoiseAt(p) * amplitude;
      total += amplitude;
      amplitude *= stageNoiseRoughness;
      p *= stageLacunarity;
    }
    return sum / total;
  }
`;

export class StudioStage {
  constructor(scene, renderer) {
    if (!scene?.isScene || !renderer) throw new TypeError('StudioStage requires a Three.Scene and renderer');
    this.scene = scene;
    this.renderer = renderer;
    this._quality = qualitySettings('high');
    this._disposed = false;
    this._ready = false;
    this._error = null;
    this._manifest = null;
    this._loading = null;
    this._controller = null;
    this._environment = null;
    this._pending = new Set();
    this._state = { ...DEFAULT_STAGE_STATE, reveal: 0 };
    this._bounds = new THREE.Box3();
    this._lightBox = new THREE.Box3();
    this._point = new THREE.Vector3();
    this._projected = new THREE.Vector3();
    this._shadowDirection = new THREE.Vector3();
    this._samplePosition = new THREE.Vector3();
    this._sampleQuaternion = new THREE.Quaternion();
    this._sampleColor = new THREE.Color();
    this._fogBaseDensity = Math.sqrt(0.0035 / 18);
    this._lights = new Map();
    this._lightRecords = SOURCE_LIGHTS;
    this._lightRuntime = [];
    this._animationRuntime = [];
    this._cloth = null;
    this._animatedCloth = null;
    this._shadowStrength = { value: 0.74 };
    this._vehicleShadowStrength = { value: 0.70 };
    this._blockerTarget = null;
    this._softShadowUniforms = {
      stageBlockerDepth: { value: null }, stageShadowExtent: { value: new THREE.Vector2(8, 8) },
      stageShadowClip: { value: new THREE.Vector2(0.05, 40) }, stageEmitterRadius: { value: 2 }, stageShadowReady: { value: 0 },
      stageShadowSearchSamples: { value: this._quality.shadowSearch }, stageShadowFilterSamples: { value: this._quality.shadowFilter },
    };
    this._shadowCopyFrame = -1;
    this._shadowViewport = new THREE.Vector4();
    this._shadowScissor = new THREE.Vector4();
    this._reflectionTarget = null;
    this._reflectionCamera = new THREE.PerspectiveCamera();
    this._reflectionUniforms = {
      stageReflection: { value: null }, stageReflectionMatrix: { value: new THREE.Matrix4() }, stageReflectionReady: { value: 0 },
      stageReflectionSamples: { value: this._quality.reflectionSamples },
    };
    this._reflectionView = new THREE.Vector3();
    this._reflectionLook = new THREE.Vector3();
    this._reflectionUp = new THREE.Vector3();
    this._reflectionPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -GROUND_Y);
    this._reflectionClip = new THREE.Vector4();
    this._reflectionQ = new THREE.Vector4();
    this._reflectionViewport = new THREE.Vector4();
    this._reflectionScissor = new THREE.Vector4();
    this._reflectionRendering = false;
    this._reflectionFrame = -1;
    this._vehicleMaterials = new Map();
    this._paintEnvGainValue = PAINT_PRESENTATION.environmentGain;
    this._paintEnvGainUniforms = new Map();
    this._vehicleSkippedGlass = new WeakSet();
    this._vehicleSkippedGlassCount = 0;
    this._previous = { background: scene.background, environment: scene.environment, environmentIntensity: scene.environmentIntensity, fog: scene.fog };
    if (!THREE.UniformsLib.LTC_HALF_1) {
      RectAreaLightUniformsLib.init();
      ownedLTC = SHARED_LTC.map((key) => THREE.UniformsLib[key]);
    }
    ltcUsers += 1;
    this._noise = noiseTexture();
    this._glow = glowTexture();
    this._sharedTextures = new Set([this._noise, this._glow]);
    this._background = linearColor(STAGE_PRESENTATION.background);
    this._fog = new THREE.FogExp2(linearColor([0.75, 0.8, 0.92]).multiply(linearColor(FOG_PRESENTATION.tint)).multiplyScalar(FOG_PRESENTATION.colorDim), Math.sqrt(0.0035 / 18));
    scene.background = this._background;
    scene.fog = this._fog;
    this._root = this._makeInitialStage();
    this._resources = resourcesIn(this._root);
    scene.add(this._root);
    this._lighting = new THREE.Group();
    this._lighting.name = 'Source industrial lighting';
    for (const record of SOURCE_LIGHTS) {
      const light = this._areaLight(record);
      this._lights.set(record.name, light);
      this._lighting.add(light);
    }
    this._cacheLighting(SOURCE_LIGHTS);
    this.keyLight = new THREE.DirectionalLight(linearColor(SOURCE_LIGHTS[0].color), 0);
    this.keyLight.name = 'Source Key shadow-only projector';
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(this._quality.shadowSize, this._quality.shadowSize);
    this.keyLight.shadow.bias = -0.00008;
    this.keyLight.shadow.normalBias = 0.003;
    this.keyLight.shadow.radius = 3;
    this._setShadowPose(SOURCE_LIGHTS[0]);
    this._lighting.add(this.keyLight, this.keyLight.target);
    scene.add(this._lighting);
    this._shadowSync = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
    this._shadowSync.name = 'Source area shadow depth synchronization';
    this._shadowSync.frustumCulled = false;
    this._shadowSync.renderOrder = -10000;
    this._shadowSync.onBeforeRender = (activeRenderer, activeScene, camera) => {
      if (this._reflectionRendering) return;
      this._syncShadowDepth();
      this._renderFloorReflection(camera);
    };
    scene.add(this._shadowSync);
    this._decor = new THREE.Group();
    this._decor.name = 'Scroll-controlled stage atmosphere';
    this.grid = new THREE.GridHelper(14, 28, '#554b3d', '#454039');
    this.grid.name = 'Fixed-floor assembly guide';
    this.grid.position.y = GROUND_Y + 0.002;
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0;
    this.grid.material.depthWrite = false;
    this.grid.visible = false;
    this._decor.add(this.grid);
    this._makeRain();
    this._makeAtmosphere();
    this._decorResources = resourcesIn(this._decor);
    scene.add(this._decor);
    this._compileCamera = new THREE.PerspectiveCamera(45, 1, 0.05, 80);
    this._compileCamera.position.set(4, 3, 7);
    this._compileCamera.lookAt(0, 1, 0);
    this.setBounds(new THREE.Box3(new THREE.Vector3(-2, 0, -3), new THREE.Vector3(2, 2, 3)));
    this.update(this._state);
  }

  async load({ signal } = {}) {
    if (this._disposed || signal?.aborted) throw abortError();
    if (this._ready) return this;
    if (this._loading) return this._loading;
    const controller = new AbortController();
    this._controller = controller;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    this._error = null;
    const promise = this._load(controller.signal);
    this._loading = promise;
    try {
      return await promise;
    } finally {
      signal?.removeEventListener('abort', abort);
      if (this._loading === promise) this._loading = null;
      if (this._controller === controller) this._controller = null;
    }
  }

  attachVehicleMaterial(material) {
    if (!material?.isMaterial) throw new TypeError('attachVehicleMaterial requires a Three.Material');
    if (this._disposed) throw new Error('Cannot attach vehicle materials to a disposed studio');
    const existing = material[VEHICLE_SHADOW_PATCH];
    if (existing?.stage === this) return material;
    if (existing) existing.detach();
    if (material.userData.stageOnly) return material;
    if (material.transmission > 0 || (material.transparent && material.opacity < 0.98 && !material.alphaTest)) {
      if (!this._vehicleSkippedGlass.has(material)) {
        this._vehicleSkippedGlass.add(material);
        this._vehicleSkippedGlassCount += 1;
      }
      return material;
    }
    if (!material.isMeshStandardMaterial && !material.isMeshPhysicalMaterial) {
      const message = `Vehicle material ${material.name || material.type} does not support PBR shadows`;
      this._error = message;
      throw new Error(message);
    }
    const stage = this;
    const properties = ['onBeforeCompile', 'customProgramCacheKey', 'clone'];
    const descriptors = Object.fromEntries(properties.map((name) => [name, Object.getOwnPropertyDescriptor(material, name)]));
    const original = {
      onBeforeCompile: material.onBeforeCompile,
      customProgramCacheKey: material.customProgramCacheKey,
      clone: material.clone,
    };
    const patch = { stage, original, descriptors, wrappers: {}, detach: null };
    const fail = (message) => {
      stage._error = message;
      throw new Error(message);
    };
    patch.wrappers.onBeforeCompile = function (shader, renderer) {
      original.onBeforeCompile.call(this, shader, renderer);
      if (stage._disposed) return;
      const declaration = '#include <shadowmap_pars_fragment>';
      const lighting = '#include <aomap_fragment>';
      if (!shader.fragmentShader.includes(declaration) || !shader.fragmentShader.includes(lighting)) {
        fail(`Vehicle material ${this.name || this.type} shader hook removed shadow support`);
      }
      const paint = isVehiclePaint(this);
      shader.uniforms.vehicleStageShadowStrength = stage._vehicleShadowStrength;
      shader.uniforms.vehiclePaintEnvironmentGain = { value: paint ? stage._paintEnvGainValue : 1 };
      shader.uniforms.vehiclePaintShadowScale = { value: paint ? PAINT_PRESENTATION.shadowScale : 1 };
      if (paint) stage._paintEnvGainUniforms.set(this, shader.uniforms.vehiclePaintEnvironmentGain);
      Object.assign(shader.uniforms, stage._softShadowUniforms);
      if (shader.fragmentShader.includes('float vehicleStageShadow =')) return;
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vStageShadowPosition;');
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvStageShadowPosition = (modelMatrix * vec4(position, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader.replace(declaration, `${declaration}\n${SOFT_SHADOW_GLSL}\nuniform float vehicleStageShadowStrength;\nuniform float vehiclePaintEnvironmentGain;\nuniform float vehiclePaintShadowScale;`);
      shader.fragmentShader = shader.fragmentShader.replace(lighting, `${lighting}\n${VEHICLE_SHADOW_GLSL}`);
      applySourceView(shader, paint);
    };
    patch.wrappers.customProgramCacheKey = function () {
      const base = original.customProgramCacheKey === THREE.Material.prototype.customProgramCacheKey
        ? original.onBeforeCompile.toString() : original.customProgramCacheKey.call(this);
      return `${base}|source-key-pcss-view-v3:${isVehiclePaint(this) ? 'paint' : 'source'}`;
    };
    patch.wrappers.clone = function (...args) {
      const copy = original.clone.apply(this, args);
      if (copy === this) fail('Material clone() did not return an independent material');
      const current = this[VEHICLE_SHADOW_PATCH] ?? patch;
      const inherited = copy[VEHICLE_SHADOW_PATCH];
      if (inherited) inherited.detach();
      for (const name of properties) {
        const hook = this[name];
        copy[name] = hook === current.wrappers[name] ? current.original[name] : hook;
      }
      return stage._disposed ? copy : stage.attachVehicleMaterial(copy);
    };
    patch.detach = () => {
      material.removeEventListener('dispose', patch.detach);
      for (const name of properties) {
        if (material[name] !== patch.wrappers[name]) continue;
        if (descriptors[name]) Object.defineProperty(material, name, descriptors[name]);
        else delete material[name];
      }
      if (material[VEHICLE_SHADOW_PATCH] === patch) delete material[VEHICLE_SHADOW_PATCH];
      stage._paintEnvGainUniforms.delete(material);
      stage._vehicleMaterials.delete(material);
      material.needsUpdate = true;
    };
    Object.defineProperty(material, VEHICLE_SHADOW_PATCH, { value: patch, configurable: true });
    Object.assign(material, patch.wrappers);
    material.addEventListener('dispose', patch.detach);
    this._vehicleMaterials.set(material, patch);
    material.needsUpdate = true;
    return material;
  }

  update(options = DEFAULT_STAGE_STATE) {
    if (this._disposed) return;
    const state = writeState(this._state, options);
    const reveal = state.introFrame === null ? state.reveal : 0;
    const readable = THREE.MathUtils.smoothstep(reveal, 0, 1);
    const inspection = state.phase === 'color' ? 0 : Math.max(state.prepare, state.explode);
    for (let index = 0; index < this._lightRuntime.length; index += 1) {
      const entry = this._lightRuntime[index];
      const light = entry.light;
      light.position.copy(entry.position);
      light.quaternion.copy(entry.quaternion);
      light.color.copy(entry.color);
      light.intensity = entry.intensity * (1 + readable * entry.lift + inspection * readable * entry.inspectionLift);
    }
    if (state.introFrame !== null) {
      const frame = Math.floor(state.introFrame);
      const alpha = state.introFrame - frame;
      for (let trackIndex = 0; trackIndex < this._animationRuntime.length; trackIndex += 1) {
        const track = this._animationRuntime[trackIndex];
        const samples = track.samples;
        const index = THREE.MathUtils.clamp(frame - track.firstFrame, 0, samples.length - 1);
        const first = samples[index], second = samples[Math.min(index + 1, samples.length - 1)];
        const light = track.light;
        light.position.fromArray(first.position).lerp(this._samplePosition.fromArray(second.position), alpha);
        light.quaternion.fromArray(first.quaternion).normalize().slerp(this._sampleQuaternion.fromArray(second.quaternion).normalize(), alpha);
        light.color.fromArray(first.color).lerp(this._sampleColor.fromArray(second.color), alpha);
        light.intensity = THREE.MathUtils.lerp(first.energyWatts, second.energyWatts, alpha) * track.inverseArea;
      }
    }
    this._fog.density = this._fogBaseDensity * THREE.MathUtils.lerp(1, 0.48, readable);
    this._shadowStrength.value = THREE.MathUtils.lerp(0.84, 0.78, readable);
    this._vehicleShadowStrength.value = THREE.MathUtils.lerp(0.42, 0.38, readable);
    if (this._environment && this.scene.environment === this._environment.texture) this.scene.environmentIntensity = THREE.MathUtils.lerp(0.30, 0.38, readable);
    const staticClothVisible = !this._animatedCloth && state.introFrame === null;
    if (this._cloth && this._cloth.visible !== staticClothVisible) {
      this._cloth.visible = staticClothVisible;
      this.keyLight.shadow.needsUpdate = true;
      if (this.renderer.shadowMap) this.renderer.shadowMap.needsUpdate = true;
    }
    this.grid.material.opacity = state.phase === 'structure' ? state.explode * readable * 0.035 : 0;
    this.grid.visible = this.grid.material.opacity > 0;
    this._rain.material.opacity = (1 - readable) * 0.12;
    this._rain.visible = this._rain.material.opacity > 0;
    this._poseRain(state.introFrame ?? 504);
    for (let index = 0; index < this._scattering.length; index += 1) {
      const entry = this._scattering[index];
      if (entry.light) {
        entry.sprite.position.copy(entry.light.position);
        entry.sprite.material.color.copy(entry.light.color);
      }
      entry.sprite.material.opacity = entry.opacity * THREE.MathUtils.lerp(1, 0.55, readable);
    }
    this._lighting.updateMatrixWorld(true);
  }

  // The dynamic cloth borrows the source material; this stage retains ownership.
  // It remains the same mesh at frame 504 and in every later chapter.
  setAnimatedCloth(cloth) {
    if (this._disposed) return;
    if (cloth && typeof cloth.setMaterial !== 'function') throw new TypeError('Animated cloth requires setMaterial(material, options)');
    this._animatedCloth = cloth || null;
    if (this._cloth) {
      this._cloth.visible = !cloth && this._state.introFrame === null;
      if (cloth) cloth.setMaterial(this._cloth.material, { owned: false });
    }
    this.keyLight.shadow.needsUpdate = true;
    this.renderer.shadowMap.needsUpdate = true;
  }

  setPaintEnvironmentGain(value) {
    if (this._disposed) return;
    this._paintEnvGainValue = value;
    for (const uniform of this._paintEnvGainUniforms.values()) uniform.value = value;
  }

  setQuality(tier) {
    if (this._disposed) return;
    const quality = qualitySettings(tier);
    if (quality === this._quality) return;
    this._quality = quality;
    this._softShadowUniforms.stageShadowSearchSamples.value = quality.shadowSearch;
    this._softShadowUniforms.stageShadowFilterSamples.value = quality.shadowFilter;
    this._reflectionUniforms.stageReflectionSamples.value = quality.reflectionSamples;
    const shadow = this.keyLight.shadow;
    if (shadow.mapSize.x !== quality.shadowSize) {
      shadow.dispose();
      shadow.map = null;
      shadow.mapPass = null;
      shadow.mapSize.set(quality.shadowSize, quality.shadowSize);
      this._softShadowUniforms.stageShadowReady.value = 0;
      this._shadowCopyFrame = -1;
    }
    this._reflectionFrame = -1;
    shadow.needsUpdate = true;
    this.renderer.shadowMap.needsUpdate = true;
  }

  setBounds(box) {
    if (this._disposed || !box?.isBox3 || box.isEmpty()) return;
    if (!Number.isFinite(box.min.x) || !Number.isFinite(box.min.y) || !Number.isFinite(box.min.z)
      || !Number.isFinite(box.max.x) || !Number.isFinite(box.max.y) || !Number.isFinite(box.max.z)) return;
    this._bounds.copy(box);
    this.keyLight.updateMatrixWorld(true);
    this.keyLight.target.updateMatrixWorld(true);
    this.keyLight.shadow.updateMatrices(this.keyLight);
    const camera = this.keyLight.shadow.camera;
    const lightBox = this._lightBox.makeEmpty();
    const point = this._point;
    const projected = this._projected;
    const direction = this._shadowDirection.subVectors(this.keyLight.target.position, this.keyLight.position).normalize();
    const groundY = this._manifest?.groundY ?? GROUND_Y;
    for (let index = 0; index < 8; index += 1) {
      point.set(index & 1 ? box.max.x : box.min.x, index & 2 ? box.max.y : box.min.y, index & 4 ? box.max.z : box.min.z);
      lightBox.expandByPoint(projected.copy(point).applyMatrix4(camera.matrixWorldInverse));
      if (direction.y < -0.0001 && point.y > groundY) {
        projected.copy(point).addScaledVector(direction, (groundY - point.y) / direction.y);
        lightBox.expandByPoint(projected.applyMatrix4(camera.matrixWorldInverse));
      }
    }
    camera.left = lightBox.min.x - 1.25;
    camera.right = lightBox.max.x + 1.25;
    camera.bottom = lightBox.min.y - 1.25;
    camera.top = lightBox.max.y + 1.25;
    camera.near = Math.min(0.05, -lightBox.max.z - 1);
    camera.far = Math.max(40, -lightBox.min.z + 4);
    camera.updateProjectionMatrix();
    this._softShadowUniforms.stageShadowExtent.value.set(camera.right - camera.left, camera.top - camera.bottom);
    this._softShadowUniforms.stageShadowClip.value.set(camera.near, camera.far);
    this.keyLight.shadow.needsUpdate = true;
    if (this.renderer.shadowMap) this.renderer.shadowMap.needsUpdate = true;
  }

  get diagnostics() {
    return {
      ready: this._ready, loading: Boolean(this._loading), error: this._error, disposed: this._disposed,
      groundY: this._manifest?.groundY ?? GROUND_Y,
      sources: [{ file: '3d汽车网页2.0.blend', sha256: SOURCE_HASH, frame: 504, unchanged: this._manifest?.source.unchanged === true }],
      asset: this._manifest?.asset ?? null,
      triangles: this._manifest?.validation.triangles ?? 76,
      clothTriangles: this._manifest?.objects.find((record) => record.role === 'cloth')?.geometry.triangles ?? 0,
      visibleSourceTriangles: (this._manifest?.validation.triangles ?? 76) - (this._cloth && !this._cloth.visible ? this._manifest.objects.find((record) => record.role === 'cloth').geometry.triangles : 0),
      sourceMeshCount: this._manifest?.validation.meshObjects ?? 8,
      lightCount: this._lights.size, shadowProjectorIntensity: this.keyLight.intensity,
      vehicleShadowMaterials: this._vehicleMaterials.size,
      vehicleShadowStrength: this._vehicleShadowStrength.value,
      paintPresentation: PAINT_PRESENTATION,
      stagePresentation: STAGE_PRESENTATION,
      vehicleGlassMaterialsSkipped: this._vehicleSkippedGlassCount,
      introFrame: this._state.introFrame, reveal: this._state.reveal, clothVisible: Boolean(this._cloth?.visible),
      animatedCloth: Boolean(this._animatedCloth), clothMaterialShared: Boolean(this._animatedCloth?.mesh && this._animatedCloth.mesh.material === this._cloth?.material),
      fogDensity: this._fog.density, environmentReady: Boolean(this._environment),
      shadowFilter: { mode: 'contact-hardening PCSS', searchSamples: this._quality.shadowSearch, filterSamples: this._quality.shadowFilter, sourceDiameter: 4,
        depthReady: this._softShadowUniforms.stageShadowReady.value > 0, mapSize: this.keyLight.shadow.mapSize.toArray() },
      floorReflection: { ready: this._reflectionUniforms.stageReflectionReady.value > 0,
        resolution: this._reflectionTarget ? [this._reflectionTarget.width, this._reflectionTarget.height] : null, sourceRoughness: 0.58 },
      quality: {
        tier: this._quality.name,
        geometry: this._ready ? (this._animatedCloth ? 'source stage; animated source cloth supplied by shared runtime; no car geometry' : 'source evaluated frame 504; full cloth subdivision; no car geometry') : 'same-source analytical floor, walls and LED scaffold; awaiting verified GLB',
        floor: 'source roughness 0.58, ramps and Generated noise; world-scaled contact shadows; bounded mip-filtered planar reflection',
        wallDarken: 'source colour ramp multiplied by linear [0.3,0.3,0.3]',
        lights: 'source transforms; equal-area disk rectangles; radiance = energyWatts / (PI * area)',
        shadow: 'source Key 4 m emitter; real blocker-depth copy; adaptive PCSS taps with world-stable rotation; contact hardening; vehicle clone-safe shared mask, no extra illuminating light',
        environment: 'source stage and oriented lamp cards; strength 0.08–0.12; original static world retained for reflection capture',
        atmosphere: 'one shared depth fog and source-position local lamp glow pipeline in every chapter; no full-screen blur',
        motionBlur: 'disabled in every chapter to preserve sharpness and exact reverse scrolling',
        colour: 'Three AgX plus bounded scene-luminance contrast adapted to Blender Medium High Contrast; not an exact OCIO transform',
        recommendedExposure: 0.78,
        sourcePixelEquivalent: false,
      },
    };
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._controller?.abort();
    this._controller = null;
    this._root.removeFromParent();
    this._lighting.removeFromParent();
    this._decor.removeFromParent();
    this._shadowSync.removeFromParent();
    this._shadowSync.geometry.dispose();
    this._shadowSync.material.dispose();
    this._blockerTarget?.dispose();
    this._blockerTarget = null;
    this._softShadowUniforms.stageShadowReady.value = 0;
    this._reflectionTarget?.dispose();
    this._reflectionTarget = null;
    this._reflectionUniforms.stageReflectionReady.value = 0;
    this._animatedCloth = null;
    if (this.scene.environment === this._environment?.texture) {
      this.scene.environment = this._previous.environment;
      this.scene.environmentIntensity = this._previous.environmentIntensity;
    }
    if (this.scene.background === this._background) this.scene.background = this._previous.background;
    if (this.scene.fog === this._fog) this.scene.fog = this._previous.fog;
    this._environment?.dispose();
    this._environment = null;
    this._vehicleShadowStrength.value = 0;
    for (const patch of this._vehicleMaterials.values()) patch.detach();
    this.keyLight.shadow.dispose();
    disposeResources(this._resources, this._sharedTextures);
    disposeResources(this._decorResources, this._sharedTextures);
    for (const resources of this._pending) disposeResources(resources, this._sharedTextures);
    this._pending.clear();
    for (const texture of this._sharedTextures) texture.dispose();
    this._sharedTextures.clear();
    ltcUsers -= 1;
    if (ltcUsers === 0 && ownedLTC) {
      for (const texture of ownedLTC) texture.dispose();
      SHARED_LTC.forEach((key, index) => {
        if (THREE.UniformsLib[key] === ownedLTC[index]) delete THREE.UniformsLib[key];
      });
      ownedLTC = null;
    }
    this._ready = false;
    this._loading = null;
  }

  _renderFloorReflection(camera) {
    if (this._disposed || this._reflectionRendering || !camera?.isPerspectiveCamera || camera.position.y <= GROUND_Y) return;
    const renderer = this.renderer;
    if (this._reflectionFrame === renderer.info.render.frame) return;
    this._reflectionFrame = renderer.info.render.frame;
    const aspect = Math.max(0.25, camera.aspect);
    const maximum = this._quality.reflectionSize;
    const width = Math.min(maximum, Math.round(maximum * aspect));
    const height = Math.max(96, Math.round(width / aspect));
    if (!this._reflectionTarget || this._reflectionTarget.width !== width || this._reflectionTarget.height !== height) {
      this._reflectionTarget?.dispose();
      this._reflectionTarget = new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true });
      this._reflectionTarget.texture.name = 'Source floor rough planar reflection';
      this._reflectionUniforms.stageReflection.value = this._reflectionTarget.texture;
    }
    const reflectedCamera = this._reflectionCamera;
    reflectedCamera.position.copy(camera.position);
    reflectedCamera.position.y = 2 * GROUND_Y - camera.position.y;
    this._reflectionLook.set(0, 0, -1).applyQuaternion(camera.quaternion).add(camera.position);
    this._reflectionLook.y = 2 * GROUND_Y - this._reflectionLook.y;
    reflectedCamera.up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    reflectedCamera.up.y *= -1;
    reflectedCamera.lookAt(this._reflectionLook);
    reflectedCamera.near = camera.near;
    reflectedCamera.far = camera.far;
    reflectedCamera.projectionMatrix.copy(camera.projectionMatrix);
    reflectedCamera.updateMatrixWorld(true);
    this._reflectionUniforms.stageReflectionMatrix.value.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
      .multiply(reflectedCamera.projectionMatrix).multiply(reflectedCamera.matrixWorldInverse);
    this._reflectionPlane.setComponents(0, 1, 0, -GROUND_Y).applyMatrix4(reflectedCamera.matrixWorldInverse);
    const clip = this._reflectionClip.set(this._reflectionPlane.normal.x, this._reflectionPlane.normal.y, this._reflectionPlane.normal.z, this._reflectionPlane.constant);
    const projection = reflectedCamera.projectionMatrix.elements;
    this._reflectionQ.set((Math.sign(clip.x) + projection[8]) / projection[0], (Math.sign(clip.y) + projection[9]) / projection[5], -1, (1 + projection[10]) / projection[14]);
    clip.multiplyScalar(2 / clip.dot(this._reflectionQ));
    projection[2] = clip.x; projection[6] = clip.y; projection[10] = clip.z + 1 - 0.0003; projection[14] = clip.w;
    reflectedCamera.projectionMatrixInverse.copy(reflectedCamera.projectionMatrix).invert();
    const target = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
    renderer.getViewport(this._reflectionViewport);
    renderer.getScissor(this._reflectionScissor);
    const scissorTest = renderer.getScissorTest(), toneMapping = renderer.toneMapping;
    const xr = renderer.xr.enabled, autoShadow = renderer.shadowMap.autoUpdate, needsShadow = renderer.shadowMap.needsUpdate;
    const floorVisible = this.floor.visible, decorVisible = this._decor.visible;
    try {
      this._reflectionRendering = true;
      this.floor.visible = false;
      this._decor.visible = false;
      renderer.xr.enabled = false;
      renderer.shadowMap.autoUpdate = false;
      renderer.shadowMap.needsUpdate = false;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.setRenderTarget(this._reflectionTarget);
      renderer.setScissorTest(false);
      renderer.clear();
      renderer.render(this.scene, reflectedCamera);
      this._reflectionUniforms.stageReflectionReady.value = 1;
    } finally {
      renderer.toneMapping = toneMapping;
      renderer.xr.enabled = xr;
      renderer.shadowMap.autoUpdate = autoShadow;
      renderer.shadowMap.needsUpdate = needsShadow;
      renderer.setRenderTarget(target, face, mip);
      renderer.setViewport(this._reflectionViewport);
      renderer.setScissor(this._reflectionScissor);
      renderer.setScissorTest(scissorTest);
      this.floor.visible = floorVisible;
      this._decor.visible = decorVisible;
      this._reflectionRendering = false;
    }
  }

  _syncShadowDepth() {
    if (this._disposed) return;
    const renderer = this.renderer;
    if (!renderer.shadowMap.enabled || renderer.shadowMap.type !== THREE.PCFShadowMap) throw new Error('Studio shadows require Three r186 PCFShadowMap');
    if (!this.keyLight.shadow.map?.depthTexture) throw new Error('Key light shadow depth is not ready');
    if (this._shadowCopyFrame === renderer.info.render.frame) return;
    this._shadowCopyFrame = renderer.info.render.frame;
    const source = this.keyLight.shadow.map.depthTexture;
    const width = source.image.width, height = source.image.height;
    if (!this._blockerTarget || this._blockerTarget.width !== width || this._blockerTarget.height !== height) {
      this._blockerTarget?.dispose();
      this._blockerTarget = new THREE.WebGLRenderTarget(width, height, { depthBuffer: true });
      this._blockerTarget.depthTexture = new THREE.DepthTexture(width, height, THREE.UnsignedIntType);
      this._blockerTarget.depthTexture.format = THREE.DepthFormat;
      this._blockerTarget.depthTexture.compareFunction = null;
      this._blockerTarget.depthTexture.minFilter = THREE.NearestFilter;
      this._blockerTarget.depthTexture.magFilter = THREE.NearestFilter;
      renderer.initRenderTarget(this._blockerTarget);
      this._softShadowUniforms.stageBlockerDepth.value = this._blockerTarget.depthTexture;
    }
    const target = renderer.getRenderTarget();
    const face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
    renderer.getViewport(this._shadowViewport);
    renderer.getScissor(this._shadowScissor);
    const scissorTest = renderer.getScissorTest();
    renderer.copyTextureToTexture(source, this._blockerTarget.depthTexture);
    renderer.setRenderTarget(target, face, mip);
    renderer.setViewport(this._shadowViewport);
    renderer.setScissor(this._shadowScissor);
    renderer.setScissorTest(scissorTest);
    this._softShadowUniforms.stageShadowReady.value = 1;
  }

  _areaLight(record) {
    const light = new THREE.RectAreaLight(linearColor(record.color), record.energyWatts * AREA_RADIANCE / record.area, record.width, record.height);
    light.name = record.name;
    light.position.fromArray(record.position);
    light.quaternion.fromArray(record.quaternion).normalize();
    return light;
  }

  _cacheLighting(records, animation = null) {
    this._lightRecords = records;
    this._lightRuntime = records.map((record) => ({
      light: this._lights.get(record.name),
      position: new THREE.Vector3().fromArray(record.position),
      quaternion: new THREE.Quaternion().fromArray(record.quaternion).normalize(),
      color: linearColor(record.color), intensity: record.energyWatts * AREA_RADIANCE / record.area,
      lift: record.name === 'Fill' ? 0.3 : record.name === 'Top' ? 0.2 : record.name === 'FrontFill' ? 0.1 : 0.035,
      inspectionLift: record.name === 'Top' || record.name === 'Fill' ? 0.1 : 0,
    }));
    this._animationRuntime = animation ? animation.tracks.map((track) => ({
      light: this._lights.get(track.name), firstFrame: animation.firstFrame, samples: track.samples,
      inverseArea: AREA_RADIANCE / records.find((record) => record.name === track.name).area,
    })) : [];
  }

  _setShadowPose(record) {
    this.keyLight.position.fromArray(record.position);
    const direction = this._shadowDirection;
    if (record.direction) direction.fromArray(record.direction);
    else direction.set(0, 0, -1).applyQuaternion(this._sampleQuaternion.fromArray(record.quaternion).normalize());
    this.keyLight.target.position.copy(this.keyLight.position).add(direction);
    this.keyLight.intensity = 0;
  }

  _surfaceMaterial(record, object) {
    const role = object.role;
    const albedoScale = role === 'ground' ? STAGE_PRESENTATION.floorAlbedo
      : role === 'wall' || role === 'backdrop' ? STAGE_PRESENTATION.wallAlbedo : 1;
    const material = new THREE.MeshPhysicalMaterial({
      color: linearColor(record.baseColor).multiplyScalar(albedoScale), roughness: record.roughness, metalness: record.metalness,
      ior: record.ior ?? 1.5, side: THREE.DoubleSide,
      sheen: record.sheen ?? 0, sheenRoughness: record.sheenRoughness ?? 0.5,
      sheenColor: linearColor([1, 1, 1]),
      emissive: linearColor(record.emissionColor ?? [0, 0, 0]), emissiveIntensity: record.emissionStrength ?? 0,
    });
    material.name = `Stage:${record.name}:${object.name}`;
    material.userData = { sourceMaterial: record.name, stageOnly: true, stageRole: object.role };
    if (role === 'cloth') material.color.set(CLOTH_TINT);
    const procedural = record.procedural;
    const shadow = object.role !== 'led';
    let uniforms = {};
    if (procedural) {
      const low = linearColor(procedural.ramp[0].color).multiply(linearColor(procedural.colorMultiplier)).multiplyScalar(albedoScale);
      const high = linearColor(procedural.ramp[1].color).multiply(linearColor(procedural.colorMultiplier)).multiplyScalar(albedoScale);
      const minimum = new THREE.Vector3().fromArray(object.generatedBounds[0]);
      const size = new THREE.Vector3().fromArray(object.generatedBounds[1]).sub(minimum);
      uniforms = {
        stageNoise: { value: this._noise }, stageGeneratedMatrix: { value: new THREE.Matrix4().fromArray(object.generatedFromBrowserMatrix) },
        stageGeneratedMin: { value: minimum }, stageGeneratedScale: { value: new THREE.Vector3(size.x ? 1 / size.x : 0, size.y ? 1 / size.y : 0, size.z ? 1 / size.z : 0) },
        stageScale: { value: procedural.scale }, stageNoiseRoughness: { value: procedural.roughness }, stageLacunarity: { value: procedural.lacunarity },
        stageBump: { value: procedural.bumpStrength * procedural.bumpDistance },
        stageLow: { value: low }, stageHigh: { value: high }, stageRamp: { value: new THREE.Vector2(procedural.ramp[0].position, procedural.ramp[1].position) },
      };
      material.defines = { STAGE_OCTAVES: Math.min(8, Math.floor(procedural.detail) + 1) };
    }
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms, { stageShadowStrength: this._shadowStrength });
      if (object.role === 'ground') {
        Object.assign(shader.uniforms, this._reflectionUniforms);
        shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\nuniform mat4 stageReflectionMatrix;\nvarying vec4 vStageReflection;\nvarying vec3 vStageWorld;`);
        shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>\nvStageWorld = (modelMatrix * vec4(position, 1.0)).xyz;\nvStageReflection = stageReflectionMatrix * vec4(vStageWorld, 1.0);`);
        shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${FLOOR_REFLECTION_GLSL}`);
        shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `outgoingLight = stageReflectedFloor(outgoingLight, geometryNormal, geometryViewDir, roughnessFactor);\n#include <opaque_fragment>`);
      }
      if (procedural) {
        shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
          uniform mat4 stageGeneratedMatrix;
          uniform vec3 stageGeneratedMin;
          uniform vec3 stageGeneratedScale;
          varying vec3 vStageGenerated;`);
        shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
          vStageGenerated = ((stageGeneratedMatrix * modelMatrix * vec4(position, 1.0)).xyz - stageGeneratedMin) * stageGeneratedScale;`);
        shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${NOISE_SHADER}`);
        shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
          float stageHeight = stageFBM(vStageGenerated * stageScale);
          float stageTint = clamp((stageHeight - stageRamp.x) / (stageRamp.y - stageRamp.x), 0.0, 1.0);
          diffuseColor.rgb = mix(stageLow, stageHigh, stageTint);`);
        shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          vec3 stageDX = dFdx(-vViewPosition);
          vec3 stageDY = dFdy(-vViewPosition);
          vec3 stageR1 = cross(stageDY, normal);
          vec3 stageR2 = cross(normal, stageDX);
          float stageDet = dot(stageDX, stageR1) * faceDirection;
          vec2 stageDerivative = vec2(dFdx(stageHeight), dFdy(stageHeight)) * stageBump;
          normal = normalize(abs(stageDet) * normal - sign(stageDet) * (stageDerivative.x * stageR1 + stageDerivative.y * stageR2));`);
      }
      if (shadow) {
        const directDiffuseScale = role === 'ground' ? STAGE_PRESENTATION.floorDirectDiffuse
          : role === 'wall' || role === 'backdrop' ? STAGE_PRESENTATION.wallDirectDiffuse : 1;
        const directSpecularScale = role === 'ground' ? STAGE_PRESENTATION.floorDirectSpecular
          : role === 'wall' || role === 'backdrop' ? STAGE_PRESENTATION.wallDirectSpecular : 1;
        const indirectDiffuseScale = role === 'ground' ? STAGE_PRESENTATION.floorIndirectDiffuse
          : role === 'wall' || role === 'backdrop' ? STAGE_PRESENTATION.wallIndirectDiffuse : 1;
        const indirectSpecularScale = role === 'ground' ? STAGE_PRESENTATION.floorIndirectSpecular
          : role === 'wall' || role === 'backdrop' ? STAGE_PRESENTATION.wallIndirectSpecular : 1;
        Object.assign(shader.uniforms, this._softShadowUniforms);
        shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vStageShadowPosition;');
        shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvStageShadowPosition = (modelMatrix * vec4(position, 1.0)).xyz;');
        shader.fragmentShader = shader.fragmentShader.replace('#include <shadowmap_pars_fragment>', `#include <shadowmap_pars_fragment>
          ${SOFT_SHADOW_GLSL}
          uniform float stageShadowStrength;`);
        shader.fragmentShader = shader.fragmentShader.replace('#include <aomap_fragment>', `#include <aomap_fragment>
          float stageShadow = mix(1.0, getStageShadowMask(), stageShadowStrength);
          reflectedLight.directDiffuse *= stageShadow * ${directDiffuseScale.toFixed(3)};
          reflectedLight.directSpecular *= mix(1.0, stageShadow, ${object.role === 'ground' ? '1.0' : '0.55'}) * ${directSpecularScale.toFixed(3)};
          reflectedLight.indirectSpecular *= mix(1.0, stageShadow, ${object.role === 'ground' ? '0.8' : '0.2'}) * ${indirectSpecularScale.toFixed(3)};
          reflectedLight.indirectDiffuse *= mix(1.0, stageShadow, ${object.role === 'ground' ? '0.8' : '0.45'}) * ${indirectDiffuseScale.toFixed(3)};`);
      }
      applySourceView(shader);
    };
    material.customProgramCacheKey = () => `source-industrial-stage-pcss-reflection-v2:${object.role}:${Boolean(procedural)}:${shadow}:${material.defines?.STAGE_OCTAVES ?? 0}`;
    return material;
  }

  _makeInitialStage() {
    const root = new THREE.Group();
    root.name = 'Source industrial stage — synchronous scaffold';
    const groundRecord = fallbackRecord('Ground', 'ground', new THREE.Matrix4().makeTranslation(0, 0, GROUND_Y), [[-30, -30, 0], [30, 30, 0]], 'Industrial_Concrete_Floor');
    const groundGeometry = new THREE.PlaneGeometry(60, 60).applyMatrix4(new THREE.Matrix4().fromArray(groundRecord.matrixWorld));
    this.floor = new THREE.Mesh(groundGeometry, this._surfaceMaterial(SOURCE_SURFACES.Industrial_Concrete_Floor, groundRecord));
    this.floor.name = 'Stage_Ground';
    this.floor.receiveShadow = true;
    this.floor.userData = { sourceObject: 'Ground', stageRole: 'ground', stageOnly: true };
    root.add(this.floor);
    const backdropRecord = fallbackRecord('Studio_Backdrop', 'backdrop', new THREE.Matrix4(), [[-18, 10.5, 0], [18, 10.5, 9]], 'Industrial_Concrete_Wall');
    const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(36, 9).translate(0, 4.5, -10.5), this._surfaceMaterial(SOURCE_SURFACES.Industrial_Concrete_Wall, backdropRecord));
    backdrop.name = 'Stage_Studio_Backdrop';
    backdrop.receiveShadow = true;
    root.add(backdrop);
    for (const [name, x, y, z, angle] of [['Industrial_Left_Slab', -8.8, 4, 3.4, -18], ['Industrial_Right_Slab', 8.8, 5, 3.5, 16]]) {
      const sourceMatrix = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(angle)), new THREE.Vector3(1.2, 1, 4.5));
      const record = fallbackRecord(name, 'wall', sourceMatrix, [[-1, -0.06, -1], [1, 0.06, 1]], 'Industrial_Concrete_Wall');
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 0.12, 2).applyMatrix4(new THREE.Matrix4().fromArray(record.matrixWorld)), this._surfaceMaterial(SOURCE_SURFACES.Industrial_Concrete_Wall, record));
      mesh.name = `Stage_${name}`;
      mesh.receiveShadow = true;
      root.add(mesh);
    }
    for (const record of SOURCE_LEDS) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(record.length, 0.07, 0.07), this._surfaceMaterial(SOURCE_SURFACES.Industrial_LED_White, { ...record, role: 'led' }));
      mesh.name = `Stage_${record.name}`;
      mesh.position.fromArray(record.center);
      mesh.rotation.z = Math.atan2(record.axis[1], record.axis[0]);
      root.add(mesh);
    }
    this._addGlow(root, SOURCE_LEDS);
    return root;
  }

  _addGlow(root, records) {
    const material = new THREE.MeshBasicMaterial({ color: linearColor([1, 0.93, 0.82]), map: this._glow,
      transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    material.name = 'Local LED soft halo';
    for (const record of records) {
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(record.length + 0.6, 1.3), material);
      glow.name = `Glow:${record.name}`;
      glow.position.fromArray(record.center);
      glow.position.z += 0.045;
      glow.rotation.z = Math.atan2(record.axis[1], record.axis[0]);
      glow.userData.stageGlow = true;
      root.add(glow);
    }
  }

  _makeRain() {
    const random = randomSequence(0x8a07504);
    this._rainPoints = Array.from({ length: 96 }, () => ({ x: (random() - 0.5) * 30, y: random() * 8.5, z: random() * 23 - 14, length: 0.06 + random() * 0.14 }));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this._rainPoints.length * 6), 3).setUsage(THREE.DynamicDrawUsage));
    this._rain = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: linearColor([0.43, 0.54, 0.64]), transparent: true, opacity: 0.12, depthWrite: false }));
    this._rain.name = 'Seeded scroll-position rain';
    this._rain.frustumCulled = false;
    this._decor.add(this._rain);
  }

  _makeAtmosphere() {
    const texture = atmosphereTexture();
    this._sharedTextures.add(texture);
    this._scattering = [];
    for (const name of ['Key', 'PaintSweep', 'Rim', 'TubeLight']) {
      const light = this._lights.get(name);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, color: light.color.clone(), opacity: 0.12,
        blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, toneMapped: true, fog: false }));
      sprite.name = `Local source fog scattering:${name}`;
      sprite.scale.set(6, 6, 1);
      sprite.renderOrder = 10;
      this._decor.add(sprite);
      this._scattering.push({ sprite, light, opacity: name === 'PaintSweep' ? 0.16 : 0.12 });
    }
    const led = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, color: linearColor([1, 0.93, 0.82]), opacity: 0.15,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, toneMapped: true, fog: false }));
    led.name = 'Source crossed LED local glow';
    led.position.set(0, 5.2, -10);
    led.scale.set(20, 17, 1);
    led.renderOrder = 10;
    this._decor.add(led);
    this._scattering.push({ sprite: led, light: null, opacity: 0.15 });
    // Source volumetric shafts on the backdrop: the video's Eevee fog scatters the
    // rear-top lamps into soft diagonal bands; elongated rotated sprites stand in.
    for (const [x, y, rotation, opacity] of [[4.2, 5.1, -0.52, 0.08], [-5.8, 4.2, -0.42, 0.06]]) {
      const shaft = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, color: linearColor([1, 0.9, 0.76]), opacity,
        blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, toneMapped: true, fog: false, rotation }));
      shaft.name = 'Source backdrop volumetric shaft';
      shaft.position.set(x, y, -10.35);
      shaft.scale.set(4.5, 15, 1);
      shaft.renderOrder = 10;
      this._decor.add(shaft);
      this._scattering.push({ sprite: shaft, light: null, opacity });
    }
  }

  _poseRain(frame) {
    if (this._rainFrame === frame) return;
    this._rainFrame = frame;
    const attribute = this._rain.geometry.getAttribute('position');
    for (let index = 0; index < this._rainPoints.length; index += 1) {
      const point = this._rainPoints[index];
      const y = THREE.MathUtils.euclideanModulo(point.y - frame * 0.027, 8.5);
      attribute.setXYZ(index * 2, point.x, y, point.z);
      attribute.setXYZ(index * 2 + 1, point.x - 0.004, y + point.length, point.z);
    }
    attribute.needsUpdate = true;
  }

  _validateManifest(data) {
    if (data?.schemaVersion !== 1 || data.source?.sha256 !== SOURCE_HASH || data.sourceFrame !== 504
      || data.units !== 'metres' || data.coordinateSystem?.up !== '+Y' || data.coordinateSystem?.front !== '+Z'
      || !Number.isFinite(data.groundY) || Math.abs(data.groundY - GROUND_Y) > 0.000001) throw new Error('Studio source, coordinates or ground height is invalid');
    const asset = data.asset;
    if (!Number.isSafeInteger(asset?.bytes) || asset.bytes <= 20 || asset.bytes > 32 * 1024 * 1024
      || !/^[a-f\d]{64}$/i.test(asset.sha256) || typeof asset.url !== 'string') throw new Error('Studio asset requires a valid byte count and SHA-256');
    const url = new URL(asset.url, MANIFEST_URL);
    if (url.origin !== MANIFEST_URL.origin || !url.pathname.endsWith('.glb')) throw new Error('Studio assets must be same-origin GLB files');
    const names = ['Ground', 'Studio_Backdrop', 'Industrial_Left_Slab', 'Industrial_Right_Slab', ...SOURCE_LEDS.map((entry) => entry.name), 'Cover'];
    if (!Array.isArray(data.objects) || data.objects.length !== names.length
      || new Set(data.objects.map((entry) => entry.name)).size !== names.length
      || names.some((name) => !data.objects.some((entry) => entry.name === name))) throw new Error('Studio is missing its floor, backdrop, LEDs or cloth');
    for (const record of data.objects) {
      const role = record.name === 'Ground' ? 'ground' : record.name === 'Cover' ? 'cloth'
        : record.name === 'Studio_Backdrop' ? 'backdrop' : record.name.startsWith('Industrial_LED_') ? 'led' : 'wall';
      if (record.role !== role || !arrayOK(record.generatedFromBrowserMatrix, 16) || !arrayOK(record.generatedBounds?.[0], 3)
        || !arrayOK(record.generatedBounds?.[1], 3) || !arrayOK(record.bounds?.[0], 3) || !arrayOK(record.bounds?.[1], 3)
        || !Number.isSafeInteger(record.geometry?.triangles) || !Array.isArray(record.materials) || !record.materials.length
        || record.materials.some((name) => !data.materials?.[name])) throw new Error(`Studio object ${record.name} is missing material or geometry metadata`);
      if (role === 'led' && (!arrayOK(record.center, 3) || !arrayOK(record.axis, 3) || !(record.length > 0))) throw new Error('LED position or length is invalid');
    }
    for (const material of Object.values(data.materials)) {
      if (!arrayOK(material.baseColor, 3) || !Number.isFinite(material.roughness) || !Number.isFinite(material.metalness)) throw new Error('Studio material parameters are invalid');
      const procedural = material.procedural;
      if (!procedural) continue;
      if (!Array.isArray(procedural.ramp) || procedural.ramp.length !== 2 || !arrayOK(procedural.colorMultiplier, 3)
        || procedural.ramp.some((stop) => !arrayOK(stop.color, 3) || !Number.isFinite(stop.position))
        || !(procedural.ramp[1].position > procedural.ramp[0].position)
        || ['scale', 'detail', 'roughness', 'lacunarity', 'bumpStrength', 'bumpDistance'].some((key) => !Number.isFinite(procedural[key]))) throw new Error('Procedural material noise, ramp or bump parameters are invalid');
    }
    if (!Array.isArray(data.lights) || data.lights.length !== SOURCE_LIGHTS.length || new Set(data.lights.map((light) => light.name)).size !== SOURCE_LIGHTS.length) throw new Error('Studio requires all seven original lights');
    for (const light of data.lights) {
      if (!SOURCE_LIGHTS.some((record) => record.name === light.name) || !arrayOK(light.position, 3)
        || !arrayOK(light.quaternion, 4) || !arrayOK(light.color, 3) || !(light.area > 0)
        || !(light.width > 0) || !(light.height > 0) || !Number.isFinite(light.energyWatts)) throw new Error(`Light ${light.name} parameters are invalid`);
    }
    if (!data.animation || data.animation.firstFrame !== 30 || data.animation.lastFrame !== 504
      || !Array.isArray(data.animation.tracks) || !data.animation.tracks.some((track) => track.name === 'PaintSweep')) throw new Error('Studio is missing intro lighting animation');
    for (const track of data.animation.tracks) {
      if (!data.lights.some((light) => light.name === track.name) || track.samples?.length !== 475
        || track.samples.some((sample, index) => sample.frame !== index + 30 || !arrayOK(sample.position, 3)
          || !arrayOK(sample.quaternion, 4) || !arrayOK(sample.color, 3) || !Number.isFinite(sample.energyWatts))) throw new Error(`Light ${track.name} animation samples are incomplete`);
    }
    if (!arrayOK(data.fog?.color, 3) || !(data.fog.density > 0) || !arrayOK(data.world?.color, 3)
      || !Number.isFinite(data.world.strength) || !Number.isSafeInteger(data.validation?.triangles)) throw new Error('Studio is missing fog, world or validation parameters');
    return url;
  }

  async _validateGLB(buffer, asset) {
    if (buffer.byteLength !== asset.bytes) throw new Error(`Studio GLB byte count mismatch (${buffer.byteLength}/${asset.bytes})`);
    const view = new DataView(buffer);
    if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2
      || view.getUint32(8, true) !== buffer.byteLength || view.getUint32(16, true) !== 0x4e4f534a) throw new Error('Studio GLB header is invalid');
    const length = view.getUint32(12, true);
    if (length > buffer.byteLength - 20) throw new Error('Studio GLB manifest is truncated');
    const document = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, length)));
    if ([...(document.buffers || []), ...(document.images || [])].some((resource) => resource.uri)
      || document.animations?.length || document.skins?.length || document.cameras?.length
      || document.extensionsUsed?.includes('KHR_lights_punctual')) throw new Error('Studio GLB requires embedded static meshes without vehicles, animations or duplicate lights');
    if (!globalThis.crypto?.subtle) throw new Error('Open via localhost or HTTPS to verify studio SHA-256');
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    const actual = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    if (actual !== asset.sha256.toLowerCase()) throw new Error('Studio GLB SHA-256 mismatch. Retry to continue.');
  }

  _prepareStage(root, manifest, resources) {
    const meshes = new Map();
    let triangles = 0;
    root.updateMatrixWorld(true);
    root.traverse((mesh) => {
      if (!mesh.isMesh) return;
      const record = manifest.objects.find((entry) => entry.name === mesh.userData.sourceObject);
      if (!record || meshes.has(record.name) || mesh.userData.stageOnly !== true || mesh.userData.stageRole !== record.role
        || mesh.isSkinnedMesh || mesh.isInstancedMesh) throw new Error('Studio GLB contains duplicate or unsupported objects');
      const count = (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3;
      if (count !== record.geometry.triangles) throw new Error(`Studio ${record.name} triangle count mismatch`);
      mesh.geometry.computeBoundingBox();
      const box = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
      if (box.min.distanceTo(new THREE.Vector3(...record.bounds[0])) > 0.00001
        || box.max.distanceTo(new THREE.Vector3(...record.bounds[1])) > 0.00001) throw new Error(`Studio ${record.name} world coordinates mismatch`);
      const nativeMaterials = materialsOf(mesh.material);
      const replacement = nativeMaterials.map((material) => {
        const source = material.userData.sourceMaterial;
        if (!record.materials.includes(source)) throw new Error(`Studio ${record.name} material assignment mismatch`);
        const adapted = this._surfaceMaterial(manifest.materials[source], record);
        resources.materials.add(adapted);
        return adapted;
      });
      mesh.material = Array.isArray(mesh.material) ? replacement : replacement[0];
      mesh.receiveShadow = record.role !== 'led';
      mesh.castShadow = record.role === 'cloth';
      if (record.role === 'cloth') mesh.visible = !this._animatedCloth && this._state.introFrame === null;
      triangles += count;
      meshes.set(record.name, mesh);
    });
    if (meshes.size !== manifest.objects.length || triangles !== manifest.validation.triangles) throw new Error('Studio package is incomplete');
    this._addGlow(root, manifest.objects.filter((record) => record.role === 'led'));
    const additions = resourcesIn(root);
    for (const key of Object.keys(resources)) for (const resource of additions[key]) resources[key].add(resource);
    return { root, resources, meshes, manifest, environment: null };
  }

  _makeEnvironment(batch) {
    const capture = new THREE.Scene();
    capture.background = linearColor(batch.manifest.world.color).multiplyScalar(batch.manifest.world.strength);
    const temporary = new THREE.Group();
    capture.add(temporary);
    for (const mesh of batch.meshes.values()) {
      if (mesh.userData.stageRole === 'cloth') continue;
      const copy = new THREE.Mesh(mesh.geometry, mesh.material);
      copy.matrix.copy(mesh.matrixWorld);
      copy.matrixAutoUpdate = false;
      copy.receiveShadow = false;
      capture.add(copy);
    }
    for (const record of batch.manifest.lights) {
      capture.add(this._areaLight(record));
      if (record.name === 'PaintSweep') continue;
      const geometry = record.sourceShape === 'DISK' ? new THREE.CircleGeometry(record.sourceSize[0] / 2, 48)
        : new THREE.PlaneGeometry(record.sourceSize[0], record.sourceShape === 'RECTANGLE' ? record.sourceSize[1] : record.sourceSize[0]);
      geometry.rotateY(Math.PI);
      const card = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: linearColor(record.color).multiplyScalar(record.energyWatts * AREA_RADIANCE / record.area) }));
      card.name = `Source emitting card:${record.name}`;
      card.position.fromArray(record.position);
      card.quaternion.fromArray(record.quaternion).normalize();
      temporary.add(card);
    }
    const renderer = this.renderer;
    const previous = {
      target: renderer.getRenderTarget(), face: renderer.getActiveCubeFace(), mip: renderer.getActiveMipmapLevel(),
      viewport: renderer.getViewport(new THREE.Vector4()), scissor: renderer.getScissor(new THREE.Vector4()), scissorTest: renderer.getScissorTest(),
      clearColor: renderer.getClearColor(new THREE.Color()), clearAlpha: renderer.getClearAlpha(),
      toneMapping: renderer.toneMapping, autoClear: renderer.autoClear, xr: renderer.xr.enabled,
      shadows: renderer.shadowMap.enabled, needsShadow: renderer.shadowMap.needsUpdate,
    };
    const generator = new THREE.PMREMGenerator(renderer);
    let environment = null;
    try {
      renderer.shadowMap.enabled = false;
      renderer.setScissorTest(false);
      environment = generator.fromScene(capture, 0.015, 0.1, 90, { size: 256, position: new THREE.Vector3(0, 0.9, 0) });
      this._assertPrograms();
      environment.texture.name = 'Source industrial stage PMREM';
      return environment;
    } catch (error) {
      environment?.dispose();
      throw error;
    } finally {
      generator.dispose();
      disposeResources(resourcesIn(temporary));
      renderer.setRenderTarget(previous.target, previous.face, previous.mip);
      renderer.setViewport(previous.viewport);
      renderer.setScissor(previous.scissor);
      renderer.setScissorTest(previous.scissorTest);
      renderer.setClearColor(previous.clearColor, previous.clearAlpha);
      renderer.toneMapping = previous.toneMapping;
      renderer.autoClear = previous.autoClear;
      renderer.xr.enabled = previous.xr;
      renderer.shadowMap.enabled = previous.shadows;
      renderer.shadowMap.needsUpdate = previous.needsShadow;
    }
  }

  _assertPrograms() {
    const failed = this.renderer.info?.programs?.find((program) => program.diagnostics?.runnable === false);
    if (failed) throw new Error(`Studio material compilation failed: ${failed.diagnostics.programLog || failed.name || 'shader error'}`);
    if (this.renderer.getContext?.().isContextLost()) throw new Error('WebGL context lost while preparing studio. Restore and retry.');
  }

  async _load(signal) {
    let resources = null;
    let batch = null;
    let timedOut = false;
    const controller = this._controller;
    const timer = setTimeout(() => { timedOut = true; controller?.abort(); }, 60000);
    try {
      const response = await fetch(MANIFEST_URL, { signal, cache: 'no-cache', redirect: 'error' });
      if (!response.ok) throw new Error(`Studio manifest failed (HTTP ${response.status})`);
      const manifest = await response.json();
      this._assertActive(signal);
      const url = this._validateManifest(manifest);
      url.searchParams.set('v', manifest.asset.sha256);
      const model = await fetch(url, { signal, cache: 'default', redirect: 'error' });
      if (!model.ok) throw new Error(`Studio model failed (HTTP ${model.status})`);
      const buffer = await model.arrayBuffer();
      await this._validateGLB(buffer, manifest.asset);
      this._assertActive(signal);
      const loader = new GLTFLoader();
      const gltf = await loader.parseAsync(buffer, new URL('.', url).href);
      resources = resourcesIn(gltf.scene);
      this._pending.add(resources);
      this._assertActive(signal);
      const textures = await gltf.parser.getDependencies('texture');
      if (textures.some((texture) => !texture?.image)) throw new Error('Studio textures could not be decoded');
      for (const texture of textures) resources.textures.add(texture);
      this._assertActive(signal);
      batch = this._prepareStage(gltf.scene, manifest, resources);
      batch.environment = this._makeEnvironment(batch);
      this._assertActive(signal);
      const compilation = new THREE.Scene();
      compilation.environment = batch.environment.texture;
      compilation.environmentIntensity = 0.22;
      compilation.fog = this._fog;
      for (const record of manifest.lights) compilation.add(this._areaLight(record));
      const shadowProjector = this.keyLight.clone();
      compilation.add(shadowProjector, shadowProjector.target);
      compilation.updateMatrixWorld(true);
      await this.renderer.compileAsync(batch.root, this._compileCamera, compilation);
      this._assertActive(signal);
      this._assertPrograms();
      this._commit(batch);
      this._pending.delete(resources);
      resources = null;
      batch = null;
      return this;
    } catch (error) {
      if (resources) {
        this._pending.delete(resources);
        disposeResources(resources, this._sharedTextures);
      }
      batch?.environment?.dispose();
      const failure = timedOut ? new Error('Studio preparation timed out after 60 seconds. Retry to continue.') : error;
      if (!this._disposed) this._error = failure instanceof Error ? failure.message : String(failure);
      throw failure;
    } finally {
      clearTimeout(timer);
    }
  }

  _assertActive(signal) {
    if (this._disposed || signal.aborted) throw abortError();
  }

  _commit(batch) {
    const previousRoot = this._root;
    const previousResources = this._resources;
    const previousEnvironment = this._environment;
    const loadedFloor = batch.meshes.get('Ground');
    this.floor.geometry = loadedFloor.geometry;
    this.floor.material = loadedFloor.material;
    this.floor.userData = { ...loadedFloor.userData };
    this.floor.matrix.copy(loadedFloor.matrixWorld);
    this.floor.matrixAutoUpdate = false;
    this.floor.matrixWorldNeedsUpdate = true;
    loadedFloor.removeFromParent();
    batch.root.add(this.floor);
    this._root = batch.root;
    this._root.name = 'Original industrial stage | evaluated source frame 504';
    this._resources = batch.resources;
    this._manifest = batch.manifest;
    this._cloth = batch.meshes.get('Cover');
    if (this._animatedCloth) this.setAnimatedCloth(this._animatedCloth);
    this._environment = batch.environment;
    this._cacheLighting(batch.manifest.lights, batch.manifest.animation);
    this._fogBaseDensity = Math.sqrt(batch.manifest.fog.density / 18);
    for (const record of this._lightRecords) {
      const light = this._lights.get(record.name);
      light.width = record.width;
      light.height = record.height;
    }
    this._setShadowPose(this._lightRecords.find((record) => record.name === 'Key'));
    this._background.setRGB(...STAGE_PRESENTATION.background, THREE.LinearSRGBColorSpace);
    this._fog.color.copy(linearColor(batch.manifest.fog.color).multiply(linearColor(FOG_PRESENTATION.tint)).multiplyScalar(FOG_PRESENTATION.colorDim));
    this.scene.add(this._root);
    this.scene.environment = this._environment.texture;
    previousRoot.removeFromParent();
    this._ready = true;
    this._error = null;
    this.update(this._state);
    if (this._bounds) this.setBounds(this._bounds);
    disposeResources(previousResources, this._sharedTextures);
    previousEnvironment?.dispose();
  }
}
