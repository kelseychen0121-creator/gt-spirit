import * as THREE from '../vendor/three/build/three.module.js';

const VERTEX = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;
const SRGB_DECODE = `
  vec3 srgbToLinear(vec3 c) {
    vec3 lo = c / 12.92;
    vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
    return mix(lo, hi, step(0.04045, c));
  }
`;
const EXTRACT = `
  uniform sampler2D source;
  varying vec2 vUv;
  ${SRGB_DECODE}
  void main() {
    vec3 color = srgbToLinear(texture2D(source, vUv).rgb);
    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    // Linear-light threshold: only bright reflections and lamps radiate.
    float mask = smoothstep(0.62, 1.0, luma);
    gl_FragColor = vec4(color * mask, 1.0);
  }
`;
const BLUR = `
  uniform sampler2D source;
  uniform vec2 stepSize;
  varying vec2 vUv;
  void main() {
    vec3 color = texture2D(source, vUv).rgb * 0.227027;
    color += texture2D(source, vUv + stepSize * 1.384615).rgb * 0.316216;
    color += texture2D(source, vUv - stepSize * 1.384615).rgb * 0.316216;
    color += texture2D(source, vUv + stepSize * 3.230769).rgb * 0.070270;
    color += texture2D(source, vUv - stepSize * 3.230769).rgb * 0.070270;
    gl_FragColor = vec4(color, 1.0);
  }
`;
const COMPOSITE = `
  uniform sampler2D source;
  uniform sampler2D nearGlow;
  uniform sampler2D wideGlow;
  uniform float glowStrength;
  varying vec2 vUv;
  ${SRGB_DECODE}
  void main() {
    vec3 original = srgbToLinear(texture2D(source, vUv).rgb);
    vec3 halo = texture2D(nearGlow, vUv).rgb * 0.22
              + texture2D(wideGlow, vUv).rgb * 0.30;
    halo *= glowStrength;
    // Screen blend retains highlight detail and cannot overexpose the base.
    gl_FragColor = vec4(original + (1.0 - original) * halo, 1.0);
    #include <colorspace_fragment>
  }
`;

const material = (fragmentShader, uniforms) => new THREE.ShaderMaterial({
  vertexShader: VERTEX, fragmentShader, uniforms,
  depthTest: false, depthWrite: false, toneMapped: false,
});
const target = () => new THREE.WebGLRenderTarget(1, 1, {
  depthBuffer: false, stencilBuffer: false,
  minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
});

// A spatial, display-referred halo after the original AgX render. The finished
// canvas is resolved into a plain RGBA target with blitFramebuffer, which is
// portable; copyTexSubImage2D from the MSAA default framebuffer is rejected
// (INVALID_OPERATION) on ANGLE/Metal. The raw sRGB bytes are decoded in-shader,
// so the original threshold/blend math is unchanged. This preserves the existing
// material look, MSAA, source reflection capture and reverse scroll.
// No second car render, temporal history, or full-resolution blur is needed.
export class HighlightBloom {
  constructor(renderer) {
    this.renderer = renderer;
    this._disposed = false;
    this._capture = new THREE.WebGLRenderTarget(1, 1, {
      depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });
    this._capture.texture.name = 'GT resolved display color for highlight bloom';
    this._size = new THREE.Vector2();
    this._viewport = new THREE.Vector4();
    this._scissor = new THREE.Vector4();
    this._targets = Array.from({ length: 4 }, target);
    this._extract = material(EXTRACT, { source: { value: this._capture.texture } });
    this._blur = material(BLUR, { source: { value: null }, stepSize: { value: new THREE.Vector2() } });
    this._composite = material(COMPOSITE, {
      source: { value: this._capture.texture }, nearGlow: { value: this._targets[1].texture }, wideGlow: { value: this._targets[3].texture },
      glowStrength: { value: 1 },
    });
    this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._extract);
    this._quad.frustumCulled = false;
    this._scene = new THREE.Scene();
    this._scene.add(this._quad);
    this._camera = new THREE.Camera();
    this._tier = 'balanced';
  }

  resize(tier = this._tier) {
    if (this._disposed) return;
    this._tier = typeof tier === 'string' ? tier : tier.name;
    this.renderer.getDrawingBufferSize(this._size);
    const width = this._size.x, height = this._size.y;
    this._capture.setSize(width, height);
    this.renderer.initRenderTarget(this._capture);
    const divisor = this._tier === 'performance' ? 4 : 3;
    const w = Math.max(1, Math.ceil(width / divisor)), h = Math.max(1, Math.ceil(height / divisor));
    this._targets[0].setSize(w, h);
    this._targets[1].setSize(w, h);
    this._targets[2].setSize(Math.max(1, Math.ceil(w / 2)), Math.max(1, Math.ceil(h / 2)));
    this._targets[3].setSize(Math.max(1, Math.ceil(w / 2)), Math.max(1, Math.ceil(h / 2)));
  }

  _draw(material, destination) {
    this._quad.material = material;
    this.renderer.setRenderTarget(destination);
    this.renderer.render(this._scene, this._camera);
  }

  render() {
    if (this._disposed) return;
    const renderer = this.renderer;
    const previous = {
      target: renderer.getRenderTarget(), autoClear: renderer.autoClear,
      scissorTest: renderer.getScissorTest(), xr: renderer.xr.enabled,
    };
    // This pass is only for the final canvas, never PMREM or floor captures.
    if (previous.target !== null) return;
    renderer.getViewport(this._viewport);
    renderer.getScissor(this._scissor);
    try {
      const gl = renderer.getContext();
      const framebuffer = renderer.properties.get(this._capture).__webglFramebuffer;
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, framebuffer);
      gl.blitFramebuffer(0, 0, this._size.x, this._size.y, 0, 0, this._size.x, this._size.y, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      renderer.resetState();
      renderer.xr.enabled = false;
      renderer.autoClear = false;
      renderer.setScissorTest(false);
      this._draw(this._extract, this._targets[0]);
      const radius = Math.max(0.75, this._size.y / 900);
      const pass = (source, destination, x, y) => {
        this._blur.uniforms.source.value = source.texture;
        this._blur.uniforms.stepSize.value.set(x / this._size.x * radius, y / this._size.y * radius);
        this._draw(this._blur, destination);
      };
      pass(this._targets[0], this._targets[1], 6, 0);
      pass(this._targets[1], this._targets[0], 0, 6);
      // Retain the narrow halo while creating a broader, weaker shoulder.
      pass(this._targets[0], this._targets[1], 3, 0);
      pass(this._targets[1], this._targets[2], 18, 0);
      pass(this._targets[2], this._targets[3], 0, 13);
      this._draw(this._composite, null);
    } finally {
      renderer.setRenderTarget(previous.target);
      renderer.setViewport(this._viewport);
      renderer.setScissor(this._scissor);
      renderer.setScissorTest(previous.scissorTest);
      renderer.autoClear = previous.autoClear;
      renderer.xr.enabled = previous.xr;
    }
  }

  setStrength(value) {
    if (this._disposed || !Number.isFinite(value)) return;
    this._composite.uniforms.glowStrength.value = Math.max(0, value);
  }

  get diagnostics() {
    return { enabled: !this._disposed, tier: this._tier, mode: 'spatial highlight halo after AgX; blitFramebuffer canvas capture; no temporal history',
      resolution: this._targets.map(({ width, height }) => [width, height]), threshold: [0.62, 1.0], strength: this._composite.uniforms.glowStrength.value };
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._capture.dispose();
    for (const item of this._targets) item.dispose();
    for (const item of [this._extract, this._blur, this._composite]) item.dispose();
    this._quad.geometry.dispose();
    this._scene.clear();
  }
}
