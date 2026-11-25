import type {
  HandCalibrationProfile,
  HandCalibrationStatus,
  HandLandmarkPoint,
  Vec2,
} from '../types';
import { clamp } from './trackingMath';

export const DEFAULT_HAND_CALIBRATION: HandCalibrationProfile = {
  calibrated: false,
  centerX: 0.5,
  centerY: 0.5,
  handScale: 0.26,
  reachGainX: 1.35,
  reachGainY: 1.35,
  recommendedPinchThreshold: 0.075,
  precisionScore: 0,
  calibratedAt: null,
};

export interface PalmMeasurement {
  x: number;
  y: number;
  scale: number;
}

export interface CenteringEvaluation {
  isCentered: boolean;
  offsetX: number;
  offsetY: number;
  radialError: number;
  guidance: string;
}

export interface CalibrationSessionState {
  status: HandCalibrationStatus;
  progress: number;
  isCentered: boolean;
  offsetX: number;
  offsetY: number;
  radialError: number;
  guidance: string;
  samples: PalmMeasurement[];
}

export function createInitialCalibrationSession(): CalibrationSessionState {
  return {
    status: 'idle',
    progress: 0,
    isCentered: false,
    offsetX: 0,
    offsetY: 0,
    radialError: 0,
    guidance:
      'Click Start Calibration, then center your open hand inside the tracking box.',
    samples: [],
  };
}

export function startCalibrationSession(): CalibrationSessionState {
  return {
    status: 'guiding',
    progress: 0,
    isCentered: false,
    offsetX: 0,
    offsetY: 0,
    radialError: 0,
    guidance: 'Hold your open hand centered inside the target box.',
    samples: [],
  };
}

/**
 * Computes a stable palm center (average of wrist and four MCP knuckles) and
 * normalized bounding hand scale from a 21-point MediaPipe hand landmark array.
 */
export function computePalmCenterAndScale(
  landmarks: readonly HandLandmarkPoint[] | null,
): PalmMeasurement | null {
  if (!landmarks || landmarks.length < 21) return null;

  const anchorIndices = [0, 5, 9, 13, 17];
  let sumX = 0;
  let sumY = 0;
  for (const idx of anchorIndices) {
    const pt = landmarks[idx];
    if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return null;
    sumX += pt.x;
    sumY += pt.y;
  }

  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  for (const pt of landmarks) {
    if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) continue;
    if (pt.x < minX) minX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y > maxY) maxY = pt.y;
  }

  const spanX = Math.max(0.05, maxX - minX);
  const spanY = Math.max(0.05, maxY - minY);

  return {
    x: clamp(sumX / anchorIndices.length, 0, 1),
    y: clamp(sumY / anchorIndices.length, 0, 1),
    scale: clamp(Math.max(spanX, spanY), 0.1, 0.75),
  };
}

/**
 * Evaluates how close the user's palm is to the center of the tracking box (0.5, 0.5)
 * and produces concise directional guidance.
 */
export function evaluateHandCentering(
  palmX: number,
  palmY: number,
  toleranceRadius = 0.13,
): CenteringEvaluation {
  const offsetX = palmX - 0.5;
  const offsetY = palmY - 0.5;
  const radialError = Math.hypot(offsetX, offsetY);
  const isCentered = radialError <= toleranceRadius;

  if (isCentered) {
    return {
      isCentered: true,
      offsetX,
      offsetY,
      radialError,
      guidance: 'Centered — hold steady to lock precision...',
    };
  }

  const axisThreshold = toleranceRadius * 0.55;
  const horiz =
    offsetX > axisThreshold
      ? 'left'
      : offsetX < -axisThreshold
        ? 'right'
        : '';
  const vert =
    offsetY > axisThreshold ? 'up' : offsetY < -axisThreshold ? 'down' : '';

  let dir = '';
  if (vert && horiz) {
    dir = `${vert} and ${horiz}`;
  } else {
    dir = vert || horiz || 'toward the center';
  }

  return {
    isCentered: false,
    offsetX,
    offsetY,
    radialError,
    guidance: `Move hand slightly ${dir} into the target box.`,
  };
}

/**
 * Advances the guided hand-centering calibration state machine by one frame.
 * Returns the updated session state and a finalized HandCalibrationProfile once locked.
 */
export function stepCalibrationSession(
  prev: CalibrationSessionState,
  measurement: PalmMeasurement | null,
  dtSeconds: number,
  holdDurationSeconds = 1.4,
  nowMs = Date.now(),
): {
  session: CalibrationSessionState;
  completedProfile: HandCalibrationProfile | null;
} {
  if (prev.status === 'idle' || prev.status === 'complete') {
    return { session: prev, completedProfile: null };
  }

  const dt = clamp(dtSeconds, 0.001, 0.25);

  if (!measurement) {
    const decayedProgress = Math.max(0, prev.progress - dt * 0.65);
    return {
      session: {
        ...prev,
        status: 'guiding',
        progress: decayedProgress,
        isCentered: false,
        guidance: 'Show your open hand inside the tracking box.',
        samples: decayedProgress === 0 ? [] : prev.samples,
      },
      completedProfile: null,
    };
  }

  const evalRes = evaluateHandCentering(measurement.x, measurement.y);

  if (!evalRes.isCentered) {
    const decayedProgress = Math.max(0, prev.progress - dt * 0.85);
    return {
      session: {
        status: 'guiding',
        progress: decayedProgress,
        isCentered: false,
        offsetX: evalRes.offsetX,
        offsetY: evalRes.offsetY,
        radialError: evalRes.radialError,
        guidance: evalRes.guidance,
        samples: decayedProgress === 0 ? [] : prev.samples,
      },
      completedProfile: null,
    };
  }

  const nextSamples = [...prev.samples, measurement].slice(-90);
  const nextProgress = clamp(
    prev.progress + dt / Math.max(0.25, holdDurationSeconds),
    0,
    1,
  );

  if (nextProgress >= 1) {
    const profile = finalizeCalibrationProfile(nextSamples, nowMs);
    return {
      session: {
        status: 'complete',
        progress: 1,
        isCentered: true,
        offsetX: evalRes.offsetX,
        offsetY: evalRes.offsetY,
        radialError: evalRes.radialError,
        guidance: `Calibration locked (${profile.precisionScore}% precision).`,
        samples: nextSamples,
      },
      completedProfile: profile,
    };
  }

  const pct = Math.round(nextProgress * 100);
  return {
    session: {
      status: 'holding',
      progress: nextProgress,
      isCentered: true,
      offsetX: evalRes.offsetX,
      offsetY: evalRes.offsetY,
      radialError: evalRes.radialError,
      guidance: `Hold steady in the center box (${pct}%)`,
      samples: nextSamples,
    },
    completedProfile: null,
  };
}

/**
 * Computes an optimized HandCalibrationProfile from collected centered samples.
 */
export function finalizeCalibrationProfile(
  samples: readonly PalmMeasurement[],
  nowMs = Date.now(),
): HandCalibrationProfile {
  if (samples.length === 0) {
    return { ...DEFAULT_HAND_CALIBRATION, calibrated: true, precisionScore: 90, calibratedAt: nowMs };
  }

  let meanX = 0;
  let meanY = 0;
  let meanScale = 0;
  for (const s of samples) {
    meanX += s.x;
    meanY += s.y;
    meanScale += s.scale;
  }
  meanX /= samples.length;
  meanY /= samples.length;
  meanScale /= samples.length;

  let varSum = 0;
  for (const s of samples) {
    const dx = s.x - meanX;
    const dy = s.y - meanY;
    varSum += dx * dx + dy * dy;
  }
  const jitterStd = Math.sqrt(varSum / samples.length);
  const centerDist = Math.hypot(meanX - 0.5, meanY - 0.5);

  // Higher stability & closer-to-center alignment produce higher precision score (82..100)
  const stabilityPenalty = clamp(jitterStd * 220, 0, 12);
  const centerPenalty = clamp(centerDist * 45, 0, 6);
  const precisionScore = Math.round(
    clamp(100 - stabilityPenalty - centerPenalty, 82, 100),
  );

  // Tune reach gain proportionally to measured hand distance (smaller hand = slightly higher reach)
  const scaleRatio = clamp(0.26 / Math.max(0.14, meanScale), 0.82, 1.3);
  const tunedGain = Number(clamp(1.35 * scaleRatio, 1.15, 1.72).toFixed(2));

  // Scale pinch engage threshold gently to match hand size in frame
  const tunedPinch = Number(
    clamp(0.075 * clamp(meanScale / 0.26, 0.78, 1.25), 0.05, 0.105).toFixed(3),
  );

  return {
    calibrated: true,
    centerX: clamp(meanX, 0.2, 0.8),
    centerY: clamp(meanY, 0.2, 0.8),
    handScale: clamp(meanScale, 0.12, 0.65),
    reachGainX: tunedGain,
    reachGainY: tunedGain,
    recommendedPinchThreshold: tunedPinch,
    precisionScore,
    calibratedAt: nowMs,
  };
}

/**
 * Maps a raw normalized camera landmark coordinate (0..1) into NDC (-1..1)
 * relative to the user's calibrated neutral center & tuned reach gains.
 */
export function applyHandCalibrationToNdc(
  rawX: number,
  rawY: number,
  mirrorX: boolean,
  calibration: HandCalibrationProfile,
): Vec2 {
  const effectiveX = mirrorX ? 1 - rawX : rawX;
  const neutralX = mirrorX ? 1 - calibration.centerX : calibration.centerX;
  const neutralY = calibration.centerY;

  const deltaX = (effectiveX - neutralX) * 2;
  const deltaY = -(rawY - neutralY) * 2;

  return {
    x: clamp(deltaX * calibration.reachGainX, -1, 1),
    y: clamp(deltaY * calibration.reachGainY, -1, 1),
  };
}

/**
 * Detects benign informational C++ stderr logs emitted by MediaPipe / TensorFlow Lite
 * WASM runtimes (such as "INFO: Created TensorFlow Lite XNNPACK delegate for CPU.")
 * that Emscripten forwards to console.error even though they are not errors.
 */
export function isBenignMediaPipeInfoLog(args: readonly unknown[]): boolean {
  if (!args || args.length === 0) return false;
  const first = args[0];
  if (typeof first !== 'string') return false;
  const trimmed = first.trim();
  return (
    /^INFO:\s+Created TensorFlow Lite XNNPACK delegate/i.test(trimmed) ||
    /^INFO:\s+.*(?:TensorFlow Lite|XNNPACK|OpenGL|Graph|Metal|delegate)/i.test(
      trimmed,
    ) ||
    /^I\d{4}\s+\d{2}:\d{2}:\d{2}\.\d+\s+\d+\s+gl_context/i.test(trimmed)
  );
}
