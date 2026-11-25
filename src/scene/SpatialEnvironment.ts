import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as xb from 'xrblocks';
import type { EnvironmentPreset, HandCursorState } from '../types';
import type { HapticPattern } from '../systems/HapticEngine';

const _rayOrigin = new THREE.Vector3();
const _rayDir = new THREE.Vector3();
const _targetPos = new THREE.Vector3();
const _gazePos = new THREE.Vector3();
const _handAnchor = new THREE.Vector3();
const _raycaster = new THREE.Raycaster();
const _ndcScratch = new THREE.Vector2();
const _gazeNdcScratch = new THREE.Vector2();

/**
 * Generates procedural 2048x1024 equirectangular 360° panorama textures
 * so every YouTube 360° & ambient environment has rich, zero-404 spherical immersion.
 */
function createEquirectangularTexture(
  preset: EnvironmentPreset,
  maxAnisotropy: number,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  const w = canvas.width;
  const h = canvas.height;

  if (preset === 'orbital360') {
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#02040a');
    grad.addColorStop(0.45, '#071329');
    grad.addColorStop(0.54, '#134e7a');
    grad.addColorStop(0.62, '#1d84b5');
    grad.addColorStop(0.75, '#0c2747');
    grad.addColorStop(1, '#040914');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Starfield upper hemisphere
    for (let i = 0; i < 420; i++) {
      const sx = (Math.sin(i * 12.9898) * 43758.5453) % 1;
      const sy = (Math.sin(i * 78.233) * 19341.123) % 1;
      const x = Math.abs(sx) * w;
      const y = Math.abs(sy) * h * 0.48;
      const r = 0.6 + (i % 3) * 0.55;
      ctx.fillStyle = i % 7 === 0 ? '#bae6fd' : '#ffffff';
      ctx.globalAlpha = 0.35 + (i % 5) * 0.14;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Aurora ribbons
    const aurora = ctx.createLinearGradient(0, h * 0.2, w, h * 0.45);
    aurora.addColorStop(0, 'rgba(52, 211, 153, 0)');
    aurora.addColorStop(0.3, 'rgba(52, 211, 153, 0.28)');
    aurora.addColorStop(0.6, 'rgba(56, 189, 248, 0.32)');
    aurora.addColorStop(1, 'rgba(99, 102, 241, 0)');
    ctx.fillStyle = aurora;
    ctx.beginPath();
    ctx.moveTo(0, h * 0.34);
    for (let x = 0; x <= w; x += 32) {
      ctx.lineTo(x, h * 0.32 + Math.sin((x / w) * Math.PI * 4) * 28);
    }
    ctx.lineTo(w, h * 0.44);
    ctx.lineTo(0, h * 0.44);
    ctx.closePath();
    ctx.fill();

    // Earth atmospheric limb & cloud bands
    ctx.strokeStyle = 'rgba(125, 211, 252, 0.65)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(0, h * 0.54);
    ctx.lineTo(w, h * 0.54);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
    for (let i = 0; i < 18; i++) {
      const cx = ((i * 89) % w);
      const cy = h * 0.6 + (i % 4) * 24;
      ctx.beginPath();
      ctx.ellipse(cx, cy, 70 + (i % 3) * 30, 12, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (preset === 'alpine360') {
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#0f2547');
    grad.addColorStop(0.35, '#3b6ea5');
    grad.addColorStop(0.5, '#f5b971');
    grad.addColorStop(0.56, '#e2e8f0');
    grad.addColorStop(1, '#1e293b');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // 360-degree mountain ridge silhouette
    ctx.fillStyle = '#1e3a5f';
    ctx.beginPath();
    ctx.moveTo(0, h * 0.58);
    for (let x = 0; x <= w; x += 16) {
      const t = (x / w) * Math.PI * 2;
      const ridge =
        Math.sin(t * 3) * 36 +
        Math.sin(t * 7 + 1.1) * 18 +
        Math.cos(t * 13) * 8;
      ctx.lineTo(x, h * 0.51 - Math.abs(ridge));
    }
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fill();

    // Snowcaps highlight
    ctx.strokeStyle = 'rgba(248, 250, 252, 0.65)';
    ctx.lineWidth = 3;
    ctx.stroke();
  } else if (preset === 'reef360') {
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#0e7490');
    grad.addColorStop(0.28, '#0891b2');
    grad.addColorStop(0.55, '#0c4a6e');
    grad.addColorStop(1, '#041c2c');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Caustic sunlight shafts from surface
    for (let i = 0; i < 14; i++) {
      const x = (i / 14) * w;
      const rayGrad = ctx.createLinearGradient(x, 0, x + 40, h * 0.65);
      rayGrad.addColorStop(0, 'rgba(165, 243, 252, 0.25)');
      rayGrad.addColorStop(1, 'rgba(165, 243, 252, 0)');
      ctx.fillStyle = rayGrad;
      ctx.beginPath();
      ctx.moveTo(x - 18, 0);
      ctx.lineTo(x + 22, 0);
      ctx.lineTo(x + 80, h * 0.65);
      ctx.lineTo(x + 10, h * 0.65);
      ctx.closePath();
      ctx.fill();
    }

    // Bioluminescent particles
    for (let i = 0; i < 160; i++) {
      const x = ((i * 67) % w);
      const y = h * 0.35 + ((i * 43) % (h * 0.55));
      ctx.fillStyle = i % 2 === 0 ? 'rgba(56, 189, 248, 0.45)' : 'rgba(52, 211, 153, 0.4)';
      ctx.beginPath();
      ctx.arc(x, y, 1.5 + (i % 3), 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (preset === 'tokyo360') {
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#070415');
    grad.addColorStop(0.42, '#1e1142');
    grad.addColorStop(0.53, '#3b1557');
    grad.addColorStop(0.6, '#0f172a');
    grad.addColorStop(1, '#020617');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // 360-degree skyline & glowing towers
    for (let i = 0; i < 48; i++) {
      const bw = 16 + (i % 4) * 9;
      const bh = 42 + ((i * 29) % 115);
      const bx = (i / 48) * w;
      const by = h * 0.56 - bh;
      ctx.fillStyle = '#0c1024';
      ctx.fillRect(bx, by, bw, bh + h * 0.1);
      ctx.fillStyle =
        i % 3 === 0 ? '#38bdf8' : i % 3 === 1 ? '#f472b6' : '#a78bfa';
      ctx.globalAlpha = 0.65;
      ctx.fillRect(bx + 2, by + 4, bw - 4, 3);
      for (let wy = by + 14; wy < h * 0.54; wy += 12) {
        ctx.fillRect(bx + 4, wy, bw - 8, 2);
      }
      ctx.globalAlpha = 1;
    }
  } else {
    // Studio Spatial Observatory (default)
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#090e1d');
    grad.addColorStop(0.45, '#131d36');
    grad.addColorStop(0.52, '#1d2b4a');
    grad.addColorStop(0.65, '#0d1527');
    grad.addColorStop(1, '#060912');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Subtle spatial latitude/longitude horizon lines
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
    ctx.lineWidth = 1;
    for (let y = 64; y < h; y += 64) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    for (let x = 0; x < w; x += 64) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = Math.max(1, maxAnisotropy);
  tex.needsUpdate = true;
  return tex;
}

/**
 * Generates a radial studio floor contact grid texture with crisp markings.
 */
function createFloorGridTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  ctx.clearRect(0, 0, 512, 512);
  const cx = 256;
  const cy = 256;

  // Radial rings
  for (let r = 48; r <= 240; r += 48) {
    ctx.strokeStyle =
      r === 192 ? 'rgba(56, 189, 248, 0.42)' : 'rgba(148, 163, 184, 0.2)';
    ctx.lineWidth = r === 192 ? 2.5 : 1.25;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Compass spokes
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.16)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * 48, cy + Math.sin(a) * 48);
    ctx.lineTo(cx + Math.cos(a) * 240, cy + Math.sin(a) * 240);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.max(1, maxAnisotropy);
  return tex;
}

/**
 * 3D Spatial Environment, 360° Panorama Dome, Composite Spatial Command Platform,
 * and 3D Hand-Mouse Cursor / Eye-Gaze Halo / Haptic Ripple visualizer.
 */
export class SpatialEnvironment extends xb.Script {
  private domeMesh!: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  private domeTextures = new Map<EnvironmentPreset, THREE.CanvasTexture>();
  private currentPreset: EnvironmentPreset = 'studio';
  private domeRotationOffset = 0;
  private domeAutoSpin = 0.015;

  private platformGroup!: THREE.Group;
  private cursorGroup!: THREE.Group;
  private cursorCore!: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>;
  private cursorRing!: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>;
  private gazeHalo!: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private handBeamLine!: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private beamPositions = new Float32Array(6);

  private rippleMesh!: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private rippleProgress = 1;
  private rippleColor = new THREE.Color(0x38bdf8);

  private envMapTexture: THREE.Texture | null = null;
  private floorTexture: THREE.CanvasTexture | null = null;
  private maxAnisotropy = 4;
  private passthroughEnabled = true;
  private studioFog = new THREE.FogExp2(0x0b1222, 0.018);
  private prevSceneOnBeforeRender: THREE.Scene['onBeforeRender'] | null = null;
  private hookedSimScene: THREE.Scene | null = null;
  private prevSimSceneOnBeforeRender: THREE.Scene['onBeforeRender'] | null = null;
  private hookedCompositor: {
    clearBeforeSimulatorScene?: () => void;
  } | null = null;
  private prevCompositorClear: (() => void) | null = null;

  init(): void {
    const renderer = xb.core?.renderer as THREE.WebGLRenderer | undefined;
    if (renderer) {
      this.maxAnisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      // Populate procedural studio reflection environment map (RoomEnvironment)
      try {
        const pmrem = new THREE.PMREMGenerator(renderer);
        const rt = pmrem.fromScene(new RoomEnvironment(), 0.04);
        this.envMapTexture = rt.texture;
        xb.core.scene.environment = this.envMapTexture;
        pmrem.dispose();
      } catch {
        // Safe fallback if renderer is non-WebGL
      }
    }

    // Balanced warm/cool lighting rig (never flat white AmbientLight alone)
    const hemi = new THREE.HemisphereLight(0xdbeafe, 0x1e293b, 1.5);
    const keyLight = new THREE.DirectionalLight(0xfff1dc, 2.2);
    keyLight.position.set(2.8, 5.2, 2.4);
    const rimLight = new THREE.DirectionalLight(0x60a5fa, 1.1);
    rimLight.position.set(-3.2, 2.6, -3.5);
    this.add(hemi, keyLight, rimLight);

    xb.core.scene.fog = new THREE.FogExp2(0x0b1222, 0.018);

    // 1. 360° Equirectangular Immersion Dome
    const domeGeo = new THREE.SphereGeometry(26, 48, 32);
    const initialTex = this.getOrCreateDomeTexture('studio');
    const domeMat = new THREE.MeshBasicMaterial({
      map: initialTex,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.domeMesh = new THREE.Mesh(domeGeo, domeMat);
    this.domeMesh.name = 'Equirectangular 360 Dome';
    this.domeMesh.xb = { pointerEvents: 'none' };
    this.domeMesh.raycast = () => {};
    this.add(this.domeMesh);

    // 2. Composite Multi-Part Procedural Spatial Observatory Platform (grounded at y=0)
    this.platformGroup = this.buildSpatialPlatform();
    this.add(this.platformGroup);

    // 3. 3D Hand-Mouse Pointer, Eye-Gaze Halo, Laser Beam & Haptic Confirmation Ripple
    this.buildSpatialCursorRig();

    // 4. Clear WebGL framebuffer to alpha=0 before every frame in passthrough mode
    // (XR Blocks' WebGLDirectCompositor sets autoClearColor=false, which otherwise leaves
    // smeared cursor & beam ghost trails when simulatorScene is hidden).
    this.installTransparentClearHook();

    // Apply initial camera passthrough transparency cleanly
    this.setPassthroughMode(this.passthroughEnabled);
  }

  private clearFramebufferTransparent(
    renderer: THREE.WebGLRenderer,
    respectScissor = true,
  ): void {
    if (!renderer || typeof renderer.clear !== 'function') return;
    if (renderer.xr?.isPresenting) return;

    const prevScissorTest =
      !respectScissor && typeof renderer.getScissorTest === 'function'
        ? renderer.getScissorTest()
        : false;
    if (!respectScissor && prevScissorTest) {
      renderer.setScissorTest(false);
    }

    renderer.setClearColor(0x000000, 0);
    renderer.state?.buffers?.color?.setMask(true);
    const gl =
      typeof renderer.getContext === 'function' ? renderer.getContext() : null;
    if (gl && typeof gl.colorMask === 'function') {
      gl.colorMask(true, true, true, true);
      gl.clearColor(0, 0, 0, 0);
    }
    renderer.clear(true, true, true);

    if (!respectScissor && prevScissorTest) {
      renderer.setScissorTest(true);
    }
  }

  private installTransparentClearHook(): void {
    const scene = xb.core?.scene;
    if (scene && !this.prevSceneOnBeforeRender) {
      const prev = scene.onBeforeRender;
      this.prevSceneOnBeforeRender = prev;
      scene.onBeforeRender = (...args) => {
        const [renderer] = args;
        if (this.passthroughEnabled && renderer) {
          this.clearFramebufferTransparent(
            renderer as THREE.WebGLRenderer,
            true,
          );
        }
        prev?.apply(scene, args);
      };
    }
    this.ensureSimulatorPassthroughHooks();
  }

  /**
   * XR Blocks' default WebGLRenderTargetCompositor (renderToRenderTexture=true)
   * renders the main scene to an offscreen target, then switches to the default
   * screen canvas (`null`), leaves `clearBeforeSimulatorScene()` as a no-op with
   * `autoClearColor = false`, and alpha-blends the offscreen quad on top.
   * When `simulatorScene` is hidden for real-world camera passthrough, the screen
   * canvas is never cleared unless we hook `simulatorScene` and `compositor`.
   */
  private ensureSimulatorPassthroughHooks(): void {
    const sim = xb.core?.simulator as
      | {
          simulatorScene?: THREE.Scene & { environmentRoot?: THREE.Object3D };
          compositor?: { clearBeforeSimulatorScene?: () => void };
        }
      | undefined;
    if (!sim) return;

    const simScene = sim.simulatorScene;
    if (simScene && this.hookedSimScene !== simScene) {
      this.hookedSimScene = simScene;
      const prev = simScene.onBeforeRender;
      this.prevSimSceneOnBeforeRender = prev;
      simScene.onBeforeRender = (...args) => {
        const [renderer] = args;
        if (this.passthroughEnabled && renderer) {
          this.clearFramebufferTransparent(
            renderer as THREE.WebGLRenderer,
            false,
          );
        }
        prev?.apply(simScene, args);
      };
    }

    const compositor = sim.compositor;
    if (compositor && this.hookedCompositor !== compositor) {
      this.hookedCompositor = compositor;
      const prevClear = compositor.clearBeforeSimulatorScene?.bind(compositor);
      this.prevCompositorClear = prevClear ?? null;
      compositor.clearBeforeSimulatorScene = () => {
        const renderer = xb.core?.renderer as THREE.WebGLRenderer | undefined;
        if (this.passthroughEnabled && renderer) {
          this.clearFramebufferTransparent(renderer, false);
          return;
        }
        prevClear?.();
      };
    }
  }

  private buildSpatialPlatform(): THREE.Group {
    const group = new THREE.Group();
    group.name = 'Spatial Observatory Platform';
    group.xb = { pointerEvents: 'none' };

    // Primary silhouette: dark anodized base disc
    const baseMat = new THREE.MeshStandardMaterial({
      color: 0x111827,
      roughness: 0.72,
      metalness: 0.35,
    });
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(2.6, 2.85, 0.08, 48),
      baseMat,
    );
    base.position.y = 0.04;
    group.add(base);

    // Secondary read: brushed titanium outer trim ring (varied roughness/metalness)
    const rimMat = new THREE.MeshStandardMaterial({
      color: 0x64748b,
      roughness: 0.28,
      metalness: 0.85,
    });
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(2.58, 0.032, 16, 64),
      rimMat,
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.085;
    group.add(rim);

    // Accent detail: glowing spatial coordinate ring
    const accentMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x0ea5e9,
      emissiveIntensity: 0.8,
      roughness: 0.25,
      metalness: 0.4,
    });
    const innerRing = new THREE.Mesh(
      new THREE.TorusGeometry(1.55, 0.012, 12, 64),
      accentMat,
    );
    innerRing.rotation.x = Math.PI / 2;
    innerRing.position.y = 0.088;
    group.add(innerRing);

    // 4 architectural perimeter beacon pylons positioned around the user arc
    const pylonGeo = new THREE.CylinderGeometry(0.025, 0.045, 0.52, 12);
    const capGeo = new THREE.SphereGeometry(0.032, 12, 10);
    const angles = [-Math.PI * 0.78, -Math.PI * 0.22, Math.PI * 0.22, Math.PI * 0.78];
    for (const angle of angles) {
      const x = Math.cos(angle) * 2.42;
      const z = Math.sin(angle) * 2.42;
      const pylon = new THREE.Mesh(pylonGeo, rimMat);
      pylon.position.set(x, 0.34, z);
      const cap = new THREE.Mesh(capGeo, accentMat);
      cap.position.set(x, 0.62, z);
      group.add(pylon, cap);
    }

    // Crisp floor calibration grid overlay (offset +0.02 above base with polygonOffset)
    this.floorTexture = createFloorGridTexture(this.maxAnisotropy);
    const gridMat = new THREE.MeshBasicMaterial({
      map: this.floorTexture,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    const gridPlane = new THREE.Mesh(new THREE.CircleGeometry(2.45, 48), gridMat);
    gridPlane.rotation.x = -Math.PI / 2;
    gridPlane.position.y = 0.1;
    group.add(gridPlane);

    group.traverse((child) => {
      child.xb = { pointerEvents: 'none' };
      child.raycast = () => {};
    });

    return group;
  }

  private buildSpatialCursorRig(): void {
    this.cursorGroup = new THREE.Group();
    this.cursorGroup.name = 'Hand Mouse Spatial Cursor';
    this.cursorGroup.xb = { pointerEvents: 'none' };

    const coreGeo = new THREE.SphereGeometry(0.013, 18, 14);
    const coreMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x38bdf8,
      emissiveIntensity: 0.9,
      roughness: 0.2,
      metalness: 0.3,
    });
    this.cursorCore = new THREE.Mesh(coreGeo, coreMat);
    this.cursorCore.xb = { pointerEvents: 'none' };
    this.cursorCore.raycast = () => {};
    this.cursorGroup.add(this.cursorCore);

    const ringGeo = new THREE.TorusGeometry(0.028, 0.0032, 12, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x7dd3fc,
      transparent: true,
      opacity: 0.88,
      depthTest: false,
    });
    this.cursorRing = new THREE.Mesh(ringGeo, ringMat);
    this.cursorRing.xb = { pointerEvents: 'none' };
    this.cursorRing.raycast = () => {};
    this.cursorRing.renderOrder = 200;
    this.cursorGroup.add(this.cursorRing);
    this.add(this.cursorGroup);

    // Eye-gaze focus halo (driven by Front Camera eye tracker)
    const gazeGeo = new THREE.RingGeometry(0.038, 0.045, 32);
    const gazeMat = new THREE.MeshBasicMaterial({
      color: 0x818cf8,
      transparent: true,
      opacity: 0.42,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    });
    this.gazeHalo = new THREE.Mesh(gazeGeo, gazeMat);
    this.gazeHalo.xb = { pointerEvents: 'none' };
    this.gazeHalo.raycast = () => {};
    this.gazeHalo.renderOrder = 190;
    this.gazeHalo.visible = false;
    this.add(this.gazeHalo);

    // Spatial hand-ray laser beam
    const beamGeo = new THREE.BufferGeometry();
    beamGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(this.beamPositions, 3),
    );
    const beamMat = new THREE.LineBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    });
    this.handBeamLine = new THREE.Line(beamGeo, beamMat);
    this.handBeamLine.xb = { pointerEvents: 'none' };
    this.handBeamLine.raycast = () => {};
    this.handBeamLine.frustumCulled = false;
    this.add(this.handBeamLine);

    // Haptic Confirmation Ripple Ring
    const rippleGeo = new THREE.RingGeometry(0.024, 0.036, 32);
    const rippleMat = new THREE.MeshBasicMaterial({
      color: 0x34d399,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    });
    this.rippleMesh = new THREE.Mesh(rippleGeo, rippleMat);
    this.rippleMesh.xb = { pointerEvents: 'none' };
    this.rippleMesh.raycast = () => {};
    this.rippleMesh.renderOrder = 210;
    this.rippleMesh.visible = false;
    this.add(this.rippleMesh);
  }

  private getOrCreateDomeTexture(preset: EnvironmentPreset): THREE.CanvasTexture {
    let tex = this.domeTextures.get(preset);
    if (!tex) {
      tex = createEquirectangularTexture(preset, this.maxAnisotropy);
      this.domeTextures.set(preset, tex);
    }
    return tex;
  }

  setPassthroughMode(enabled: boolean): void {
    this.passthroughEnabled = enabled;
    if (this.domeMesh) {
      this.domeMesh.visible = !enabled;
    }
    if (this.platformGroup) {
      this.platformGroup.visible = !enabled && this.currentPreset === 'studio';
    }
    if (xb.core?.scene) {
      xb.core.scene.fog = enabled ? null : this.studioFog;
      if (enabled) {
        xb.core.scene.background = null;
      }
    }
    // Hide XR Blocks simulator room geometry/background so live real-world camera shows through
    const simScene = xb.core?.simulator?.simulatorScene;
    if (simScene) {
      simScene.visible = !enabled;
      if (simScene.environmentRoot) {
        simScene.environmentRoot.visible = !enabled;
      }
      if (enabled) {
        simScene.background = null;
      }
    }
    const renderer = xb.core?.renderer as THREE.WebGLRenderer | undefined;
    if (renderer && typeof renderer.setClearColor === 'function') {
      renderer.setClearColor(0x000000, enabled ? 0 : 1);
    }
    this.ensureSimulatorPassthroughHooks();
  }

  isPassthroughMode(): boolean {
    return this.passthroughEnabled;
  }

  setEnvironmentPreset(preset: EnvironmentPreset): void {
    this.currentPreset = preset;
    if (!this.domeMesh) return;
    this.domeMesh.material.map = this.getOrCreateDomeTexture(preset);
    this.domeMesh.material.needsUpdate = true;

    // Hide platform floor accents during deep 360° sky/space immersion or camera passthrough
    this.platformGroup.visible =
      !this.passthroughEnabled && preset === 'studio';
  }

  getEnvironmentPreset(): EnvironmentPreset {
    return this.currentPreset;
  }

  setDomeRotationDegrees(deg: number): void {
    this.domeRotationOffset = THREE.MathUtils.degToRad(deg);
  }

  triggerHapticRipple(pattern: HapticPattern): void {
    this.rippleProgress = 0;
    this.rippleMesh.visible = true;
    this.rippleMesh.position.copy(this.cursorGroup.position);
    this.rippleMesh.quaternion.copy(this.cursorGroup.quaternion);

    if (pattern === 'pinch-click' || pattern === 'app-launch') {
      this.rippleColor.setHex(0x34d399);
    } else if (pattern === 'error') {
      this.rippleColor.setHex(0xfb7185);
    } else {
      this.rippleColor.setHex(0x38bdf8);
    }
    this.rippleMesh.material.color.copy(this.rippleColor);
  }

  /**
   * Projects the fused Hand-Mouse & Eye-Gaze NDC coordinates cleanly into 3D space
   * in front of the active camera so users always see immediate open-hand vs pinch feedback.
   */
  updateVisualCursor(
    cursor: HandCursorState,
    dt: number,
    showCursor = true,
  ): void {
    const camera = xb.core?.camera;
    if (!camera || !this.cursorGroup) return;

    this.cursorGroup.visible = showCursor;
    this.handBeamLine.visible = showCursor;

    const safeX = Number.isFinite(cursor.x) ? cursor.x : 0;
    const safeY = Number.isFinite(cursor.y) ? cursor.y : 0;

    if (showCursor) {
      // Compute world-space cursor point at ergonomic 1.18m depth
      _ndcScratch.set(safeX, safeY);
      _raycaster.setFromCamera(_ndcScratch, camera);
      _rayOrigin.copy(_raycaster.ray.origin);
      _rayDir.copy(_raycaster.ray.direction);
      _targetPos.copy(_rayOrigin).addScaledVector(_rayDir, 1.18);

      if (cursor.source === 'pointer') {
        // Zero lag for direct desktop/touch pointer so 3D cursor stays locked to pointer
        this.cursorGroup.position.copy(_targetPos);
      } else {
        this.cursorGroup.position.lerp(_targetPos, 1 - Math.exp(-24 * dt));
      }
      this.cursorGroup.quaternion.copy(camera.quaternion);

      // Visual distinction: Full open hand (cyan open ring) vs Pinch click (tight emerald orb)
      const targetRingScale = cursor.isPinching ? 0.56 : 1.06;
      this.cursorRing.scale.lerp(
        _targetPos.set(targetRingScale, targetRingScale, targetRingScale),
        1 - Math.exp(-20 * dt),
      );
      const activeHex = cursor.isPinching ? 0x30d158 : 0x38bdf8;
      this.cursorCore.material.color.setHex(activeHex);
      this.cursorCore.material.emissive.setHex(activeHex);
      this.cursorRing.material.color.setHex(
        cursor.isPinching ? 0x6ee7b7 : 0x7dd3fc,
      );

      // Update hand beam from bottom-right ergonomic hand origin to spatial cursor
      _handAnchor
        .set(0.24, -0.26, -0.35)
        .applyQuaternion(camera.quaternion)
        .add(camera.position);

      this.beamPositions[0] = _handAnchor.x;
      this.beamPositions[1] = _handAnchor.y;
      this.beamPositions[2] = _handAnchor.z;
      this.beamPositions[3] = this.cursorGroup.position.x;
      this.beamPositions[4] = this.cursorGroup.position.y;
      this.beamPositions[5] = this.cursorGroup.position.z;
      this.handBeamLine.geometry.attributes.position.needsUpdate = true;
      this.handBeamLine.material.color.setHex(activeHex);
    }

    // Eye-gaze focus halo from Front Camera
    if (
      showCursor &&
      cursor.gazeActive &&
      Number.isFinite(cursor.gazeX) &&
      Number.isFinite(cursor.gazeY)
    ) {
      _gazeNdcScratch.set(cursor.gazeX, cursor.gazeY);
      _raycaster.setFromCamera(_gazeNdcScratch, camera);
      _gazePos
        .copy(_raycaster.ray.origin)
        .addScaledVector(_raycaster.ray.direction, 1.24);
      this.gazeHalo.position.lerp(_gazePos, 1 - Math.exp(-14 * dt));
      this.gazeHalo.quaternion.copy(camera.quaternion);
      this.gazeHalo.visible = true;
    } else {
      this.gazeHalo.visible = false;
    }

    // Animate 3D Haptic Confirmation Ripple
    if (this.rippleProgress < 1) {
      this.rippleProgress = Math.min(1, this.rippleProgress + dt * 3.4);
      const scale = 1 + this.rippleProgress * 3.2;
      this.rippleMesh.scale.setScalar(scale);
      this.rippleMesh.material.opacity = (1 - this.rippleProgress) * 0.85;
      if (this.rippleProgress >= 1) {
        this.rippleMesh.visible = false;
      }
    }

    // Keep transparent camera passthrough & screen clear hooks enforced after async simulator init
    if (this.passthroughEnabled) {
      this.ensureSimulatorPassthroughHooks();
      const simScene = xb.core?.simulator?.simulatorScene;
      if (simScene) {
        if (simScene.visible) simScene.visible = false;
        if (simScene.environmentRoot?.visible) {
          simScene.environmentRoot.visible = false;
        }
        if (simScene.background !== null) simScene.background = null;
      }
      if (xb.core?.scene && xb.core.scene.background !== null) {
        xb.core.scene.background = null;
      }
    } else if (this.domeMesh) {
      // Gentle 360° dome slow drift for immersive atmosphere
      this.domeMesh.rotation.y =
        this.domeRotationOffset +
        (xb.core.elapsedTime || 0) * this.domeAutoSpin;
    }
  }

  dispose(): void {
    if (xb.core?.scene && this.prevSceneOnBeforeRender) {
      xb.core.scene.onBeforeRender = this.prevSceneOnBeforeRender;
      this.prevSceneOnBeforeRender = null;
    }
    if (this.hookedSimScene && this.prevSimSceneOnBeforeRender) {
      this.hookedSimScene.onBeforeRender = this.prevSimSceneOnBeforeRender;
      this.hookedSimScene = null;
      this.prevSimSceneOnBeforeRender = null;
    }
    if (this.hookedCompositor && this.prevCompositorClear) {
      this.hookedCompositor.clearBeforeSimulatorScene =
        this.prevCompositorClear;
      this.hookedCompositor = null;
      this.prevCompositorClear = null;
    }
    for (const tex of this.domeTextures.values()) {
      tex.dispose();
    }
    this.domeTextures.clear();
    this.floorTexture?.dispose();
    this.envMapTexture?.dispose();
    this.domeMesh?.geometry.dispose();
    this.domeMesh?.material.dispose();
  }
}
