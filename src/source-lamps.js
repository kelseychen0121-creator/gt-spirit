import * as THREE from '../vendor/three/build/three.module.js';

// Final-video vehicle lamps from final.blend (frames 30-504, rain excluded).
// Headlight spots ramp 0 -> 2400 W across frames 74-86, taillight points
// 0 -> 70 W across 116-127, then both stay on through the garage chapters.
// Lens emission is constant in the source: headlight lens 36 warm, taillight 9 red.
const HEAD_POSITIONS = [[0.55, 0.55, 2.25], [-0.55, 0.55, 2.25]];
const TAIL_POSITIONS = [[0.6, 0.7, -2.18], [-0.6, 0.7, -2.18]];
const HEAD_COLOR = [1, 0.79, 0.52];
const TAIL_COLOR = [1, 0.02, 0.008];
const SPOT_DIRECTION = [0, -0.342, 0.94];
const SPOT_HALF_ANGLE = 0.9075712 / 2;
const SPOT_PENUMBRA = 0.45;
const HEAD_WATTS = 2400;
const TAIL_WATTS = 70;
const HEAD_ON = [74, 86];
const TAIL_ON = [116, 127];
const HEAD_LENS = { color: [1, 0.83, 0.55], strength: 36 };
const TAIL_LENS = { color: [1, 0.03, 0.009], strength: 9 };
const HEAD_LENS_NAME = /^Headlight_On/i;
const TAIL_LENS_NAME = /^Taillight_On/i;
// Blender watts -> three.js physical intensity (decay = 2).
const SPOT_CANDELA = HEAD_WATTS / (2 * Math.PI * (1 - Math.cos(SPOT_HALF_ANGLE)));
const POINT_CANDELA = TAIL_WATTS / (4 * Math.PI);
const GAIN = 0.65;
const BEAM_LENGTH = 1.75;
const BEAM_BASE_RADIUS = Math.tan(SPOT_HALF_ANGLE) * BEAM_LENGTH;
const BEAM_OPACITY = 0.10;
const BEAM_SHADER = {
  vertex: `
    varying vec2 vUv;
    varying float vEdge;
    void main() {
      vUv = uv;
      vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
      vec3 viewNormal = normalize(normalMatrix * normal);
      vEdge = abs(dot(viewNormal, normalize(-viewPosition.xyz)));
      gl_Position = projectionMatrix * viewPosition;
    }
  `,
  fragment: `
    uniform vec3 beamColor;
    uniform float beamOpacity;
    varying vec2 vUv;
    varying float vEdge;
    void main() {
      float axial = pow(clamp(vUv.y, 0.0, 1.0), 1.7);
      float edge = smoothstep(0.0, 0.55, vEdge);
      float alpha = beamOpacity * axial * edge;
      gl_FragColor = vec4(beamColor * alpha, alpha);
    }
  `,
};

function linearColor(value) {
  return new THREE.Color().setRGB(...value, THREE.LinearSRGBColorSpace);
}

function glowTexture() {
  const width = 64;
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
  texture.name = 'Source lamp local scattering kernel';
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

export class SourceLamps {
  constructor(materials) {
    this._disposed = false;
    this.group = new THREE.Group();
    this.group.name = 'Source final-video vehicle lamps';
    this._texture = glowTexture();
    this._heads = [];
    this._tails = [];
    const headColor = linearColor(HEAD_COLOR);
    const tailColor = linearColor(TAIL_COLOR);
    for (const position of HEAD_POSITIONS) {
      const spot = new THREE.SpotLight(headColor, 0, 0, SPOT_HALF_ANGLE, SPOT_PENUMBRA, 2);
      spot.name = 'Source headlight beam';
      spot.position.set(...position);
      spot.target.position.set(
        position[0] + SPOT_DIRECTION[0] * 3,
        position[1] + SPOT_DIRECTION[1] * 3,
        position[2] + SPOT_DIRECTION[2] * 3,
      );
      // Glow sits on the actual lens mesh (EXT-019/020 centre +0.03 forward), not
      // on the Blender lamp point, which floats ahead of the bodywork.
      const lens = [Math.sign(position[0]) * 0.581, 0.437, 2.027];
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this._texture, color: headColor.clone(), opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, toneMapped: true, fog: false,
      }));
      sprite.name = 'Source headlight local glow';
      sprite.position.set(...lens);
      sprite.scale.set(0.9, 0.62, 1);
      sprite.visible = false;
      const core = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this._texture, color: headColor.clone(), opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, toneMapped: true, fog: false,
      }));
      core.name = 'Source headlight hot core';
      core.position.set(lens[0], lens[1] + 0.01, lens[2] + 0.01);
      core.scale.set(0.5, 0.36, 1);
      core.visible = false;
      const coneGeometry = new THREE.CylinderGeometry(0.05, BEAM_BASE_RADIUS, BEAM_LENGTH, 24, 1, true);
      coneGeometry.translate(0, -BEAM_LENGTH / 2, 0);
      const cone = new THREE.Mesh(coneGeometry, new THREE.ShaderMaterial({
        vertexShader: BEAM_SHADER.vertex, fragmentShader: BEAM_SHADER.fragment,
        uniforms: { beamColor: { value: headColor.clone() }, beamOpacity: { value: 0 } },
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
      }));
      cone.name = 'Source headlight fog beam';
      cone.position.set(...lens);
      cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), new THREE.Vector3(...SPOT_DIRECTION).normalize());
      cone.visible = false;
      this.group.add(spot, spot.target, sprite, core, cone);
      this._heads.push({ spot, sprite, core, cone });
    }
    for (const position of TAIL_POSITIONS) {
      const point = new THREE.PointLight(tailColor, 0, 0, 2);
      point.name = 'Source taillight glow';
      point.position.set(...position);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this._texture, color: tailColor.clone(), opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, toneMapped: true, fog: false,
      }));
      sprite.name = 'Source taillight local glow';
      sprite.position.set(...position);
      sprite.scale.set(0.9, 0.7, 1);
      sprite.visible = false;
      this.group.add(point, sprite);
      this._tails.push({ point, sprite });
    }
    this._lens = [];
    for (const material of materials) {
      if (!material?.emissive) continue;
      const lens = HEAD_LENS_NAME.test(material.name) ? HEAD_LENS : TAIL_LENS_NAME.test(material.name) ? TAIL_LENS : null;
      if (!lens) continue;
      material.emissive.copy(linearColor(lens.color));
      material.emissiveIntensity = lens.strength;
      this._lens.push({ material, strength: lens.strength });
    }
  }

  // frame drives the intro ramp (null = garage, fully on); level scales the
  // whole system down — used to switch the lamps off for the exploded grid.
  setFrame(frame, level = 1) {
    if (this._disposed) return;
    const head = (frame === null ? 1 : THREE.MathUtils.smoothstep(frame, HEAD_ON[0], HEAD_ON[1])) * level;
    const tail = (frame === null ? 1 : THREE.MathUtils.smoothstep(frame, TAIL_ON[0], TAIL_ON[1])) * level;
    for (const { spot, sprite, core, cone } of this._heads) {
      spot.intensity = SPOT_CANDELA * head * GAIN;
      sprite.material.opacity = 0.15 * head;
      sprite.visible = head > 0.001;
      core.material.opacity = 0.65 * head;
      core.visible = head > 0.001;
      cone.material.uniforms.beamOpacity.value = BEAM_OPACITY * head;
      cone.visible = head > 0.001;
    }
    for (const { point, sprite } of this._tails) {
      point.intensity = POINT_CANDELA * tail * GAIN;
      sprite.material.opacity = 0.16 * tail;
      sprite.visible = tail > 0.001;
    }
    // Lens emission is frame-constant in the source, but follows the system level.
    for (const { material, strength } of this._lens) material.emissiveIntensity = strength * level;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.group.removeFromParent();
    for (const { spot, sprite, core, cone } of this._heads) {
      spot.dispose();
      sprite.material.dispose();
      core.material.dispose();
      cone.geometry.dispose();
      cone.material.dispose();
    }
    for (const { point, sprite } of this._tails) {
      point.dispose();
      sprite.material.dispose();
    }
    this._texture.dispose();
    this._lens.length = 0;
  }
}
