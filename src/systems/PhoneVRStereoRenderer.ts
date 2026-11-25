import * as THREE from 'three';
import * as xb from 'xrblocks';

/**
 * Detects software WebGL (SwiftShader, llvmpipe, WARP) from the GPU renderer string
 * so we only tune rendering cost (pixel ratio, shadows) without changing scene content.
 */
export function detectSoftwareWebGL(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return false;
  }
}

/**
 * Phone VR Split-Screen Stereoscopic (Side-by-Side Cardboard) Renderer Hook.
 * Plugs directly into `xb.core.renderSceneOverride` so placing a phone inside a
 * VR headset renders true dual-eye stereo with configurable IPD.
 */
export class PhoneVRStereoRenderer {
  private enabled = false;
  private stereoCamera = new THREE.StereoCamera();
  private sizeScratch = new THREE.Vector2();

  constructor() {
    this.stereoCamera.eyeSep = 0.064; // Default 64mm IPD
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  setIpdMm(ipdMm: number): void {
    this.stereoCamera.eyeSep = THREE.MathUtils.clamp(ipdMm, 55, 75) / 1000;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!xb.core) return;

    if (!enabled) {
      xb.core.renderSceneOverride = undefined;
      const renderer = xb.core.renderer as THREE.WebGLRenderer | undefined;
      if (renderer && typeof renderer.setScissorTest === 'function') {
        renderer.setScissorTest(false);
        renderer.getSize(this.sizeScratch);
        renderer.setViewport(0, 0, this.sizeScratch.x, this.sizeScratch.y);
      }
      return;
    }

    xb.core.renderSceneOverride = (
      supportedRenderer,
      scene: THREE.Scene,
      camera: THREE.Camera,
    ) => {
      const renderer = supportedRenderer as unknown as THREE.WebGLRenderer;
      if (
        !renderer ||
        typeof renderer.setScissorTest !== 'function' ||
        renderer.xr?.isPresenting
      ) {
        renderer?.render(scene, camera);
        return;
      }

      const persp = camera as THREE.PerspectiveCamera;
      renderer.getSize(this.sizeScratch);
      const width = this.sizeScratch.x;
      const height = this.sizeScratch.y;
      const halfW = Math.floor(width / 2);

      // Update StereoCamera matrices for left & right eyes
      if (persp.parent === null) persp.updateMatrixWorld();
      this.stereoCamera.aspect = 0.5;
      this.stereoCamera.update(persp);

      const prevAutoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.setScissorTest(true);

      // Left Eye Viewport
      renderer.setScissor(0, 0, halfW, height);
      renderer.setViewport(0, 0, halfW, height);
      renderer.clear(true, true, true);
      renderer.render(scene, this.stereoCamera.cameraL);

      // Right Eye Viewport
      renderer.setScissor(halfW, 0, width - halfW, height);
      renderer.setViewport(halfW, 0, width - halfW, height);
      renderer.clear(true, true, true);
      renderer.render(scene, this.stereoCamera.cameraR);

      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, width, height);
      renderer.autoClear = prevAutoClear;
    };
  }

  dispose(): void {
    this.setEnabled(false);
  }
}
