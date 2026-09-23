import * as THREE from '../vendor/three/build/three.module.js';

const clamp = THREE.MathUtils.clamp;
const smooth = THREE.MathUtils.smoothstep;
const UP = new THREE.Vector3(0, 1, 0);
const INTRO_PULL_FOCUS = new THREE.Vector3(0, 0.55, 0);
const INTRO_PULLBACK = 0.22;
// Cloth-reveal wide framing: dolly out from the car, except the authored rear
// (~200-260) and front (~330-450) push-in passes, which keep their close-ups.
function introPullback(frame) {
  if (!Number.isFinite(frame)) return 0;
  const early = smooth(frame, 30, 60) * (1 - smooth(frame, 182, 200));
  const middle = smooth(frame, 262, 282) * (1 - smooth(frame, 312, 330));
  return INTRO_PULLBACK * Math.max(early, middle);
}

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.right = new THREE.Vector3();
    this.up = new THREE.Vector3();
    this.forward = new THREE.Vector3();
    this.point = new THREE.Vector3();
    this.matrix = new THREE.Matrix4();
    this.sourceMatrix = new THREE.Matrix4();
    this.sourceProjection = new THREE.Matrix4();
    this.viewportMatrix = new THREE.Matrix4();
    this.basis = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
    this.yaw = new THREE.Matrix4();
    this.hood = new THREE.Matrix4();
    this.rotation = new THREE.Matrix4();
    this.sourcePosition = new THREE.Vector3();
    this.sourceQuaternion = new THREE.Quaternion();
    this.target = new THREE.Vector3();
    this.positions = new Float64Array(0);
    this.count = 0;
    this.shots = Object.fromEntries(['hero', 'bay', 'structure'].map((name) => [name, {
      position: new THREE.Vector3(), target: new THREE.Vector3(), quaternion: new THREE.Quaternion(),
    }]));
    this.finalPosition = new THREE.Vector3();
    this.finalTarget = new THREE.Vector3();
    this.finalQuaternion = new THREE.Quaternion();
    this.finalProjection = new THREE.Matrix4();
    this.bounds = null;
  }

  _push(points, matrix, frontOnly = false, source = points) {
    for (let i = 0; i < points.length; i += 3) {
      if (frontOnly && source[i + 2] < 0.2) continue;
      this.point.set(points[i], points[i + 1], points[i + 2]);
      if (matrix) this.point.applyMatrix4(matrix);
      this.positions[this.count++] = this.point.x;
      this.positions[this.count++] = this.point.y;
      this.positions[this.count++] = this.point.z;
    }
  }

  _pushFrontBox(points, source, matrix) {
    if (source[14] < 0.2) return;
    const cut = Math.max(source[2], 0.2);
    const alpha = source[14] === source[2] ? 0 : (cut - source[2]) / (source[14] - source[2]);
    for (let i = 0; i < 24; i += 3) {
      this.point.fromArray(points, i);
      if (i < 12 && alpha > 0) {
        this.point.x += (points[i + 12] - points[i]) * alpha;
        this.point.y += (points[i + 13] - points[i + 1]) * alpha;
        this.point.z += (points[i + 14] - points[i + 2]) * alpha;
      }
      if (matrix) this.point.applyMatrix4(matrix);
      this.positions[this.count++] = this.point.x;
      this.positions[this.count++] = this.point.y;
      this.positions[this.count++] = this.point.z;
    }
  }

  _gather(parts, mode, openHood) {
    let required = 0;
    for (const entry of parts.values()) {
      if (!entry.active) continue;
      required += entry.fitPoints.length;
      for (const root of entry.roots) if (root.worldFitPoints) required += root.worldFitPoints.length;
    }
    if (this.positions.length < required) this.positions = new Float64Array(required);
    this.count = 0;
    const bay = mode === 'bay' || mode === 'bay-motion';
    const moving = mode === 'structure' || mode === 'bay-motion';
    if (bay && !moving) this.hood.multiplyMatrices(this.yaw, openHood);
    for (const entry of parts.values()) {
      if (!entry.active) continue;
      const exterior = entry.traits.group === 'EXTERIOR' || entry.traits.group === 'WHEELS';
      let ownVisible = false, engineBay = entry.traits.baySupport;
      for (const root of entry.roots) {
        if (!root.node.visible) continue;
        if (!root.motionParentId) ownVisible = true;
        if (root.stage === 'engine-bay') engineBay = true;
      }
      if (mode !== 'structure' && !exterior && !(bay && engineBay)) continue;
      if (ownVisible && (!bay || entry.hood || engineBay)) {
        if (bay && !entry.hood && !entry.preciseFit) {
          this._pushFrontBox(moving ? entry.worldFitPoints : entry.fitPoints, entry.fitPoints, moving ? null : this.yaw);
        } else if (moving) this._push(entry.worldFitPoints, null, bay && !entry.hood, entry.fitPoints);
        else this._push(entry.fitPoints, bay && entry.hood ? this.hood : this.yaw, bay && !entry.hood);
      }
      for (const root of entry.roots) {
        if (!root.motionParentId || !root.node.visible || !root.worldFitPoints) continue;
        const parent = parts.get(root.motionParentId);
        if (moving) this._push(root.worldFitPoints, null, bay && !parent?.hood, root.fitPoints);
        else this._push(root.fitPoints, bay && parent?.hood ? this.hood : this.yaw, bay && !parent?.hood);
      }
    }
    return this.count > 0;
  }

  _fit(shot, azimuth, elevation, tanH, tanV, halfX, halfY) {
    this.forward.set(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation));
    this.right.crossVectors(UP, this.forward).normalize();
    this.up.crossVectors(this.forward, this.right).normalize();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < this.count; i += 3) {
      this.point.set(this.positions[i], this.positions[i + 1], this.positions[i + 2]);
      const x = this.point.dot(this.right), y = this.point.dot(this.up), z = this.point.dot(this.forward);
      this.positions[i] = x; this.positions[i + 1] = y; this.positions[i + 2] = z;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    let cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;
    let distance = 0;
    for (let pass = 0; pass < 3; pass += 1) {
      distance = 0;
      for (let i = 0; i < this.count; i += 3) {
        const depth = this.positions[i + 2] - cz;
        distance = Math.max(distance, Math.abs(this.positions[i] - cx) / (tanH * halfX) + depth,
          Math.abs(this.positions[i + 1] - cy) / (tanV * halfY) + depth);
      }
      distance += 0.035;
      let left = Infinity, right = -Infinity, bottom = Infinity, top = -Infinity;
      for (let i = 0; i < this.count; i += 3) {
        const depth = distance - this.positions[i + 2] + cz;
        const x = (this.positions[i] - cx) / (depth * tanH), y = (this.positions[i + 1] - cy) / (depth * tanV);
        left = Math.min(left, x); right = Math.max(right, x);
        bottom = Math.min(bottom, y); top = Math.max(top, y);
      }
      if (pass < 2) {
        cx += (left + right) * distance * tanH * 0.5;
        cy += (bottom + top) * distance * tanV * 0.5;
      }
    }
    shot.target.copy(this.right).multiplyScalar(cx).addScaledVector(this.up, cy).addScaledVector(this.forward, cz);
    shot.position.copy(shot.target).addScaledVector(this.forward, distance);
    this.rotation.lookAt(shot.position, shot.target, UP);
    shot.quaternion.setFromRotationMatrix(this.rotation);
  }

  _contain(tanH, tanV, halfX, halfY) {
    this.right.set(1, 0, 0).applyQuaternion(this.finalQuaternion);
    this.up.set(0, 1, 0).applyQuaternion(this.finalQuaternion);
    this.forward.set(0, 0, 1).applyQuaternion(this.finalQuaternion);
    let retreat = 0;
    for (let i = 0; i < this.count; i += 3) {
      this.point.fromArray(this.positions, i).sub(this.finalPosition);
      const depth = -this.point.dot(this.forward);
      retreat = Math.max(retreat, Math.abs(this.point.dot(this.right)) / (tanH * halfX) - depth,
        Math.abs(this.point.dot(this.up)) / (tanV * halfY) - depth);
    }
    if (retreat > 0) this.finalPosition.addScaledVector(this.forward, retreat);
  }

  update({ state, parts, width, height, openHood }) {
    const camera = this.camera;
    const aspect = width / height;
    const padding = state.viewPadding || { top: 88, bottom: 142, left: 32, right: 32 };
    const left = clamp(padding.left / width, 0, 0.2), right = clamp(padding.right / width, 0, 0.2);
    const top = clamp(padding.top / height, 0, 0.25), bottom = clamp(padding.bottom / height, 0, 0.35);
    const halfX = 1 - left - right, availableY = 1 - top - bottom;
    const portrait = aspect < 1;
    const low = height < 500;
    const prepare = smooth(state.prepareProgress, 0, 1);
    const structure = smooth(state.explodeProgress, 0, 0.128);
    const heroTanV = portrait ? Math.tan(THREE.MathUtils.degToRad(54 / 2)) : 18 / ((low ? 36 : 34) * aspect);
    const bayTanV = portrait ? Math.tan(THREE.MathUtils.degToRad(50 / 2)) : 18 / (40 * aspect);
    const structureTanV = portrait ? Math.tan(THREE.MathUtils.degToRad(46 / 2)) : 18 / (36 * aspect);
    const tanV = THREE.MathUtils.lerp(THREE.MathUtils.lerp(heroTanV, bayTanV, prepare), structureTanV, structure);
    const tanH = tanV * aspect;
    const headroom = 0.065 * (1 - prepare) * (1 - structure);
    const centerX = left - right, centerY = bottom - top - headroom;
    const halfY = availableY - headroom;
    camera.aspect = aspect;
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(tanV));
    camera.near = 0.05;
    camera.far = 180;
    camera.updateProjectionMatrix();
    camera.projectionMatrix.elements[8] = -centerX;
    camera.projectionMatrix.elements[9] = -centerY;
    this.finalProjection.copy(camera.projectionMatrix);
    this.yaw.makeRotationY(state.yaw);
    const hasShot = this._gather(parts, 'hero', openHood);
    if (hasShot) {
      this._fit(this.shots.hero, low ? 0.84 : 0.64, low ? 0.03 : 0.055,
        heroTanV * aspect, heroTanV, halfX * (portrait ? 0.88 : 0.75), (availableY - 0.065) * (low ? 0.96 : 0.89));
      this.finalPosition.copy(this.shots.hero.position);
      this.finalTarget.copy(this.shots.hero.target);
      this.finalQuaternion.copy(this.shots.hero.quaternion);
      if (prepare > 0 && this._gather(parts, 'bay', openHood)) {
        this._fit(this.shots.bay, 0.82, low ? 0.3 : 0.4, bayTanV * aspect, bayTanV,
          halfX * (portrait ? 0.84 : 0.76), availableY * 0.985);
        this.point.set(-0.08, 0, 0.16);
        this.shots.bay.position.add(this.point);
        this.shots.bay.target.add(this.point);
        this.finalPosition.lerp(this.shots.bay.position, prepare);
        this.finalTarget.lerp(this.shots.bay.target, prepare);
        this.finalQuaternion.slerp(this.shots.bay.quaternion, prepare);
        if (prepare < 1 && this._gather(parts, 'bay-motion', openHood)) {
          this._contain(tanH, tanV, halfX * 0.985, halfY * 0.995);
        }
      }
      if (structure > 0 && this._gather(parts, 'structure', openHood)) {
        const vertical = state.layout === 'vertical';
        // Horizontal layout goes full-bleed from a near-top-down camera: the
        // flattened carpet is allowed to run under the UI chrome at the edges.
        const fitX = vertical ? halfX * (portrait ? 0.9 : 0.86) : halfX * 0.98;
        const fitY = vertical ? availableY * 0.94 : 0.94;
        this._fit(this.shots.structure, vertical ? 1.07 : 0.05, vertical ? 0.27 : 1.32,
          structureTanV * aspect, structureTanV, fitX, fitY);
        this.finalPosition.lerp(this.shots.structure.position, structure);
        this.finalTarget.lerp(this.shots.structure.target, structure);
        this.finalQuaternion.slerp(this.shots.structure.quaternion, structure);
        this._gather(parts, structure < 1 ? 'bay-motion' : 'structure', openHood);
        this._contain(tanH, tanV, vertical ? halfX * 0.985 : fitX * 0.99, vertical ? halfY * 0.995 : fitY * 0.99);
      }
      this.forward.set(0, 0, -1).applyQuaternion(this.finalQuaternion);
      const focusDistance = this.point.subVectors(this.finalTarget, this.finalPosition).dot(this.forward);
      this.finalTarget.copy(this.finalPosition).addScaledVector(this.forward, Math.max(0.05, focusDistance));
    }
    const source = state.introCamera;
    if (source?.matrixWorld?.length === 16 && source?.projectionMatrix?.length === 16) {
      this.sourceMatrix.set(...source.matrixWorld).premultiply(this.basis);
      this.sourcePosition.setFromMatrixPosition(this.sourceMatrix);
      const pullback = introPullback(state.introFrame);
      if (pullback > 0) {
        this.point.subVectors(this.sourcePosition, INTRO_PULL_FOCUS).multiplyScalar(pullback);
        this.sourcePosition.add(this.point);
      }
      this.sourceQuaternion.setFromRotationMatrix(this.sourceMatrix);
      this.sourceProjection.set(...source.projectionMatrix);
      const rect = state.sourceRect || { x: 0, y: 0, width, height };
      const sx = rect.width / width, sy = rect.height / height;
      const ox = (2 * rect.x + rect.width) / width - 1;
      const oy = 1 - (2 * rect.y + rect.height) / height;
      this.viewportMatrix.set(sx, 0, 0, ox, 0, sy, 0, oy, 0, 0, 1, 0, 0, 0, 0, 1);
      this.sourceProjection.premultiply(this.viewportMatrix);
      const p = hasShot && !state.stageOnly ? state.matchProgress : 0;
      camera.position.copy(this.sourcePosition).lerp(this.finalPosition, p);
      camera.quaternion.copy(this.sourceQuaternion).slerp(this.finalQuaternion, p);
      const destination = this.finalProjection.elements;
      for (let i = 0; i < 16; i += 1) {
        camera.projectionMatrix.elements[i] = THREE.MathUtils.lerp(this.sourceProjection.elements[i], destination[i], p);
      }
      this.target.set(0, 0, -1).applyQuaternion(camera.quaternion).multiplyScalar(8).add(camera.position);
      if (p === 1) this.target.copy(this.finalTarget);
    } else if (hasShot) {
      camera.position.copy(this.finalPosition);
      camera.quaternion.copy(this.finalQuaternion);
      this.target.copy(this.finalTarget);
    }
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    camera.updateMatrixWorld(true);
    this.matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._gather(parts, 'structure', openHood);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < this.count; i += 3) {
      this.point.fromArray(this.positions, i).applyMatrix4(this.matrix);
      minX = Math.min(minX, this.point.x); maxX = Math.max(maxX, this.point.x);
      minY = Math.min(minY, this.point.y); maxY = Math.max(maxY, this.point.y);
    }
    if (!this.count) this.bounds = null;
    else {
      this.bounds ||= { method: 'authored shots; visible current geometry only; hood and engine-bay focus allows surrounding body and wheels outside frame', ndc: {} };
      this.bounds.widthRatio = (maxX - minX) / 2;
      this.bounds.heightRatio = (maxY - minY) / 2;
      Object.assign(this.bounds.ndc, { minX, maxX, minY, maxY });
      this.bounds.focus = state.prepareProgress > 0 && state.explodeProgress < 0.128 ? 'engine-bay' : 'complete-assembly';
    }
  }
}
