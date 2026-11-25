import * as THREE from 'three';
import {
  estimateCameraOpticalFlow,
  fuseHeadOrientation,
} from '../core/trackingMath';
import type { HeadOrientationEuler } from '../types';

const FLOW_W = 48;
const FLOW_H = 36;

/**
 * Phone VR Head-Tracking Sensor Fusion Engine:
 * Combines phone IMU gyroscope/compass (`DeviceOrientationEvent`) with
 * rear-camera visual optical-flow estimation (luminance block matching)
 * so putting the phone in a VR headset gives smooth, low-drift orientation control.
 */
export class HeadTracker {
  private enabled = false;
  private opticalFlowEnabled = true;
  private imuActive = false;
  private imuRaw: HeadOrientationEuler = { yaw: 0, pitch: 0, roll: 0 };
  private zeroOffset: HeadOrientationEuler = { yaw: 0, pitch: 0, roll: 0 };
  private opticalAccumYaw = 0;
  private opticalAccumPitch = 0;
  private fused: HeadOrientationEuler = { yaw: 0, pitch: 0, roll: 0 };
  private smoothedQuat = new THREE.Quaternion();
  private targetQuat = new THREE.Quaternion();
  private eulerScratch = new THREE.Euler(0, 0, 0, 'YXZ');

  private flowCanvas: HTMLCanvasElement | null = null;
  private flowCtx: CanvasRenderingContext2D | null = null;
  private prevLuma: Uint8Array | null = null;
  private currLuma = new Uint8Array(FLOW_W * FLOW_H);
  private lastFlowSampleMs = 0;
  private flowDeltaPx = { x: 0, y: 0 };

  private readonly onDeviceOrientation = (ev: DeviceOrientationEvent) => {
    if (ev.alpha === null || ev.beta === null || ev.gamma === null) return;
    const degToRad = Math.PI / 180;
    const yaw = ev.alpha * degToRad;
    // Landscape VR headset orientation maps gamma/beta cleanly
    const isLandscape = window.innerWidth > window.innerHeight;
    const pitch = isLandscape
      ? (Math.abs(ev.gamma) > 1 ? -ev.gamma : ev.beta - 90) * degToRad * 0.65
      : (ev.beta - 90) * degToRad;
    const roll = isLandscape ? 0 : -ev.gamma * degToRad * 0.4;

    if (!this.imuActive) {
      this.imuActive = true;
      this.zeroOffset = { yaw, pitch, roll };
    }
    this.imuRaw = { yaw, pitch, roll };
  };

  constructor() {
    if (typeof document !== 'undefined') {
      this.flowCanvas = document.createElement('canvas');
      this.flowCanvas.width = FLOW_W;
      this.flowCanvas.height = FLOW_H;
      this.flowCtx = this.flowCanvas.getContext('2d', {
        willReadFrequently: true,
      });
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  get isImuActive(): boolean {
    return this.imuActive;
  }

  get currentOrientation(): HeadOrientationEuler {
    return this.fused;
  }

  get lastOpticalFlow(): { x: number; y: number } {
    return this.flowDeltaPx;
  }

  get modeLabel(): string {
    if (!this.enabled) return 'Manual / XR';
    if (this.imuActive && this.opticalFlowEnabled) return 'IMU + Cam Flow';
    if (this.imuActive) return 'IMU Gyro';
    if (this.opticalFlowEnabled) return 'Cam Visual Flow';
    return 'Head Tracking';
  }

  async enable(): Promise<boolean> {
    if (typeof window === 'undefined') return false;
    // Request iOS 13+ DeviceOrientation permission when required
    const DevOrient = DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<'granted' | 'denied'>;
    };
    if (typeof DevOrient?.requestPermission === 'function') {
      try {
        const res = await DevOrient.requestPermission();
        if (res !== 'granted') return false;
      } catch {
        return false;
      }
    }

    if (!this.enabled) {
      window.addEventListener('deviceorientation', this.onDeviceOrientation);
      this.enabled = true;
    }
    return true;
  }

  disable(): void {
    if (!this.enabled) return;
    window.removeEventListener('deviceorientation', this.onDeviceOrientation);
    this.enabled = false;
  }

  setOpticalFlowEnabled(enabled: boolean): void {
    this.opticalFlowEnabled = enabled;
    if (!enabled) {
      this.opticalAccumYaw = 0;
      this.opticalAccumPitch = 0;
    }
  }

  recenter(): void {
    this.zeroOffset = { ...this.imuRaw };
    this.opticalAccumYaw = 0;
    this.opticalAccumPitch = 0;
  }

  /**
   * Samples rear phone camera video frame for optical-flow head-motion delta.
   */
  sampleCameraFrame(video: HTMLVideoElement | null, nowMs: number): void {
    if (
      !this.enabled ||
      !this.opticalFlowEnabled ||
      !video ||
      video.readyState < 2 ||
      !this.flowCtx
    ) {
      return;
    }
    if (nowMs - this.lastFlowSampleMs < 50) return; // 20 Hz optical flow
    this.lastFlowSampleMs = nowMs;

    this.flowCtx.drawImage(video, 0, 0, FLOW_W, FLOW_H);
    const data = this.flowCtx.getImageData(0, 0, FLOW_W, FLOW_H).data;
    for (let i = 0, p = 0; i < this.currLuma.length; i++, p += 4) {
      this.currLuma[i] =
        (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
    }

    if (this.prevLuma) {
      const flow = estimateCameraOpticalFlow(
        this.prevLuma,
        this.currLuma,
        FLOW_W,
        FLOW_H,
        3,
      );
      this.flowDeltaPx = flow;
      // Camera image shifts opposite to head rotation
      this.opticalAccumYaw = THREE.MathUtils.clamp(
        this.opticalAccumYaw - flow.x * 0.018,
        -Math.PI * 0.65,
        Math.PI * 0.65,
      );
      this.opticalAccumPitch = THREE.MathUtils.clamp(
        this.opticalAccumPitch + flow.y * 0.015,
        -Math.PI * 0.35,
        Math.PI * 0.35,
      );
    } else {
      this.prevLuma = new Uint8Array(FLOW_W * FLOW_H);
    }
    this.prevLuma.set(this.currLuma);
  }

  /**
   * Applies fused head orientation to the active Three.js camera when phone-VR
   * head tracking or remote-phone orientation override is active.
   */
  applyToCamera(
    camera: THREE.Camera,
    dt: number,
    remoteOverride?: HeadOrientationEuler | null,
  ): void {
    const active = remoteOverride || this.enabled;
    if (!active) return;

    if (remoteOverride) {
      this.fused = remoteOverride;
    } else {
      // Gentle decay on optical accumulation to prevent runaway drift
      this.opticalAccumYaw *= Math.exp(-0.25 * dt);
      this.opticalAccumPitch *= Math.exp(-0.25 * dt);
      this.fused = fuseHeadOrientation(
        this.imuRaw,
        this.zeroOffset,
        { x: this.opticalAccumYaw, y: this.opticalAccumPitch },
        this.imuActive ? 0.25 : 0.85,
      );
    }

    this.eulerScratch.set(this.fused.pitch, this.fused.yaw, this.fused.roll, 'YXZ');
    this.targetQuat.setFromEuler(this.eulerScratch);
    const alpha = 1 - Math.exp(-14 * Math.min(dt, 0.1));
    this.smoothedQuat.slerp(this.targetQuat, alpha);
    camera.quaternion.copy(this.smoothedQuat);
  }

  dispose(): void {
    this.disable();
    this.prevLuma = null;
  }
}
