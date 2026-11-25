import type { HeadOrientationEuler, PinchPhase, Vec2 } from '../types';

export interface PinchDetectorState {
  isPinching: boolean;
  lastPhase: PinchPhase;
}

export interface PinchDetectorOptions {
  /** Threshold below which thumb-index distance triggers a pinch click */
  engageThreshold: number;
  /** Hysteresis margin added to release threshold to avoid flicker */
  releaseHysteresis?: number;
}

/**
 * Computes Euclidean distance between two 2D/3D hand landmarks (e.g. thumb tip #4 & index tip #8).
 */
export function computeLandmarkDistance(
  a: { x: number; y: number; z?: number },
  b: { x: number; y: number; z?: number },
): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = (a.z ?? 0) - (b.z ?? 0);
  return Math.hypot(dx, dy, dz);
}

/**
 * Pure pinch-click state machine with Schmitt-trigger hysteresis.
 * Prevents jittery double clicks when thumb & index fingers hover near the pinch threshold.
 */
export function evaluatePinchState(
  prev: PinchDetectorState,
  pinchDistance: number,
  options: PinchDetectorOptions,
): PinchDetectorState {
  const engage = Math.max(0.01, options.engageThreshold);
  const release = engage + (options.releaseHysteresis ?? 0.022);

  if (!prev.isPinching) {
    if (pinchDistance <= engage) {
      return { isPinching: true, lastPhase: 'pinch-start' };
    }
    return { isPinching: false, lastPhase: 'open' };
  }

  if (pinchDistance >= release) {
    return { isPinching: false, lastPhase: 'pinch-end' };
  }
  return { isPinching: true, lastPhase: 'pinching' };
}

/**
 * Maps a normalized camera landmark coordinate (0..1) into NDC (-1..1) with
 * optional horizontal mirroring and comfortable deadzone scaling so users
 * can reach every corner of the 3D spatial workspace without hyper-extending their arm.
 */
export function handLandmarkToNdc(
  rawX: number,
  rawY: number,
  mirrorX = true,
  reachGain = 1.35,
): Vec2 {
  const centeredX = (mirrorX ? 1 - rawX : rawX) * 2 - 1;
  const centeredY = -(rawY * 2 - 1);
  return {
    x: clamp(centeredX * reachGain, -1, 1),
    y: clamp(centeredY * reachGain, -1, 1),
  };
}

/**
 * Fuses full-hand mouse cursor with front-camera eye gaze focus.
 * When eye-gaze assist is enabled and the gaze is close to the hand intent,
 * pulls the cursor gently toward the gazed target for ergonomic low-fatigue selection.
 */
export function fuseHandAndEyeCursor(
  handNdc: Vec2,
  eyeGazeNdc: Vec2,
  eyeGazeActive: boolean,
  gazeAssistEnabled: boolean,
  gazeWeight = 0.25,
): Vec2 {
  if (!eyeGazeActive || !gazeAssistEnabled || gazeWeight <= 0) {
    return { x: clamp(handNdc.x, -1, 1), y: clamp(handNdc.y, -1, 1) };
  }
  const w = clamp(gazeWeight, 0, 0.5);
  return {
    x: clamp(handNdc.x * (1 - w) + eyeGazeNdc.x * w, -1, 1),
    y: clamp(handNdc.y * (1 - w) + eyeGazeNdc.y * w, -1, 1),
  };
}

/**
 * Frame-rate independent exponential damping for smooth spatial hand-mouse tracking.
 * Higher `smoothing` (0..0.95) yields steadier cursor; lower gives snappier response.
 */
export function smoothCursorNdc(
  current: Vec2,
  target: Vec2,
  smoothing: number,
  dtSeconds: number,
): Vec2 {
  const dt = clamp(dtSeconds, 0.001, 0.1);
  const clampedSmooth = clamp(smoothing, 0.05, 0.95);
  // Convert smoothing [0.05..0.95] to decay speed lambda [28..4]
  const lambda = 4 + (1 - clampedSmooth) * 26;
  const alpha = 1 - Math.exp(-lambda * dt);
  return {
    x: current.x + (target.x - current.x) * alpha,
    y: current.y + (target.y - current.y) * alpha,
  };
}

/**
 * Estimates coarse 2D translational optical flow (dx, dy in pixels) between two
 * small grayscale luminance frames using block-matching SAD (Sum of Absolute Differences).
 * Used to supplement phone IMU gyroscope with rear-camera visual head-tracking data.
 */
export function estimateCameraOpticalFlow(
  prevLuma: Uint8Array,
  currLuma: Uint8Array,
  width: number,
  height: number,
  maxShift = 3,
): Vec2 {
  if (
    prevLuma.length < width * height ||
    currLuma.length < width * height ||
    width < maxShift * 2 + 4 ||
    height < maxShift * 2 + 4
  ) {
    return { x: 0, y: 0 };
  }

  let bestDx = 0;
  let bestDy = 0;
  let bestSad = Number.POSITIVE_INFINITY;
  let zeroSad = 0;

  const xStart = maxShift;
  const xEnd = width - maxShift;
  const yStart = maxShift;
  const yEnd = height - maxShift;

  for (let dy = -maxShift; dy <= maxShift; dy++) {
    for (let dx = -maxShift; dx <= maxShift; dx++) {
      let sad = 0;
      for (let y = yStart; y < yEnd; y += 2) {
        const rowPrev = y * width;
        const rowCurr = (y + dy) * width;
        for (let x = xStart; x < xEnd; x += 2) {
          sad += Math.abs(prevLuma[rowPrev + x] - currLuma[rowCurr + x + dx]);
        }
      }
      if (dx === 0 && dy === 0) {
        zeroSad = sad;
      }
      if (sad < bestSad) {
        bestSad = sad;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }

  // Require meaningful improvement over zero-shift to reject sensor noise
  const sampleCount = ((xEnd - xStart) / 2) * ((yEnd - yStart) / 2);
  const meanGain = (zeroSad - bestSad) / Math.max(1, sampleCount);
  if (meanGain < 1.2) {
    return { x: 0, y: 0 };
  }

  return { x: bestDx, y: bestDy };
}

/**
 * Fuses IMU orientation with recenter zero-offset and optional rear-camera optical flow delta.
 */
export function fuseHeadOrientation(
  imuRaw: HeadOrientationEuler,
  zeroOffset: HeadOrientationEuler,
  opticalFlowDeltaRad: Vec2,
  opticalFlowWeight = 0.25,
): HeadOrientationEuler {
  const yaw =
    wrapAngleRad(imuRaw.yaw - zeroOffset.yaw) +
    opticalFlowDeltaRad.x * opticalFlowWeight;
  const pitch = clamp(
    imuRaw.pitch - zeroOffset.pitch + opticalFlowDeltaRad.y * opticalFlowWeight,
    -Math.PI * 0.46,
    Math.PI * 0.46,
  );
  const roll = clamp(
    wrapAngleRad(imuRaw.roll - zeroOffset.roll),
    -Math.PI * 0.35,
    Math.PI * 0.35,
  );
  return { yaw, pitch, roll };
}

export function wrapAngleRad(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function clamp(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}
