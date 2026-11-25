import type {
  HandCropRect,
  HandGestureClassification,
  HandGestureId,
  HandLandmarkPoint,
} from '../types';
import { clamp, computeLandmarkDistance } from './trackingMath';

/**
 * Standard MediaPipe 21-point hand skeleton bone edges.
 */
export const HAND_SKELETON_CONNECTIONS: ReadonlyArray<readonly [number, number]> =
  [
    // Thumb
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
    // Index
    [0, 5],
    [5, 6],
    [6, 7],
    [7, 8],
    // Middle
    [0, 9],
    [9, 10],
    [10, 11],
    [11, 12],
    // Ring
    [0, 13],
    [13, 14],
    [14, 15],
    [15, 16],
    // Pinky
    [0, 17],
    [17, 18],
    [18, 19],
    [19, 20],
    // Palm knuckles
    [5, 9],
    [9, 13],
    [13, 17],
  ];

/**
 * Computes a padded, clamped pixel ROI crop rectangle around the 21 hand landmarks
 * so the Hand Gesture Box zooms tightly onto the exact part of the camera tracking your hand.
 */
export function computeHandCropRect(
  landmarks: readonly HandLandmarkPoint[],
  videoWidth: number,
  videoHeight: number,
  paddingRatio = 0.42,
  targetAspect = 4 / 3,
): HandCropRect {
  const vw = Math.max(1, videoWidth);
  const vh = Math.max(1, videoHeight);

  if (!landmarks || landmarks.length === 0) {
    // Default centered camera crop region
    const defaultH = Math.min(vh, vw / targetAspect) * 0.72;
    const defaultW = defaultH * targetAspect;
    const sx = (vw - defaultW) / 2;
    const sy = (vh - defaultH) / 2;
    return {
      sx,
      sy,
      sw: defaultW,
      sh: defaultH,
      normMinX: sx / vw,
      normMinY: sy / vh,
      normMaxX: (sx + defaultW) / vw,
      normMaxY: (sy + defaultH) / vh,
    };
  }

  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;

  for (const pt of landmarks) {
    if (pt.x < minX) minX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y > maxY) maxY = pt.y;
  }

  minX = clamp(minX, 0, 1);
  minY = clamp(minY, 0, 1);
  maxX = clamp(maxX, 0, 1);
  maxY = clamp(maxY, 0, 1);

  const boxW = Math.max(0.14, maxX - minX) * vw;
  const boxH = Math.max(0.14, maxY - minY) * vh;
  const cx = ((minX + maxX) / 2) * vw;
  const cy = ((minY + maxY) / 2) * vh;

  const padFactor = 1 + clamp(paddingRatio, 0.1, 1.2);
  let sw = boxW * padFactor;
  let sh = boxH * padFactor;

  // Enforce consistent box aspect ratio so the cropped hand never stretches
  if (sw / sh < targetAspect) {
    sw = sh * targetAspect;
  } else {
    sh = sw / targetAspect;
  }

  // Enforce minimum and maximum crop bounds
  const minSw = vw * 0.28;
  const minSh = minSw / targetAspect;
  if (sw < minSw) {
    sw = minSw;
    sh = minSh;
  }
  if (sw > vw) {
    sw = vw;
    sh = Math.min(vh, sw / targetAspect);
  }
  if (sh > vh) {
    sh = vh;
    sw = Math.min(vw, sh * targetAspect);
  }

  const sx = clamp(cx - sw / 2, 0, vw - sw);
  const sy = clamp(cy - sh / 2, 0, vh - sh);

  return {
    sx,
    sy,
    sw,
    sh,
    normMinX: sx / vw,
    normMinY: sy / vh,
    normMaxX: (sx + sw) / vw,
    normMaxY: (sy + sh) / vh,
  };
}

/**
 * Exponentially smooths the camera hand ROI crop box to prevent shaky zoom/pan jitter.
 */
export function smoothHandCropRect(
  prev: HandCropRect | null,
  target: HandCropRect,
  dtSeconds: number,
): HandCropRect {
  if (!prev) return { ...target };
  const alpha = 1 - Math.exp(-9 * clamp(dtSeconds, 0.001, 0.1));
  const lerp = (a: number, b: number) => a + (b - a) * alpha;
  return {
    sx: lerp(prev.sx, target.sx),
    sy: lerp(prev.sy, target.sy),
    sw: lerp(prev.sw, target.sw),
    sh: lerp(prev.sh, target.sh),
    normMinX: lerp(prev.normMinX, target.normMinX),
    normMinY: lerp(prev.normMinY, target.normMinY),
    normMaxX: lerp(prev.normMaxX, target.normMaxX),
    normMaxY: lerp(prev.normMaxY, target.normMaxY),
  };
}

/**
 * Classifies a 21-point hand landmark array into an intuitive spatial gesture.
 */
export function classifyHandGesture(
  landmarks: readonly HandLandmarkPoint[] | null,
  isPinching: boolean,
): HandGestureClassification {
  if (!landmarks || landmarks.length < 21) {
    if (isPinching) {
      return {
        id: 'pinch-click',
        label: 'Pinch',
        actionHint: 'Click & Select',
        confidence: 0.9,
      };
    }
    return {
      id: 'none',
      label: 'No Hand',
      actionHint: 'Show hand to camera',
      confidence: 0,
    };
  }

  if (isPinching) {
    return {
      id: 'pinch-click',
      label: 'Pinch',
      actionHint: 'Click & Select',
      confidence: 0.97,
    };
  }

  const wrist = landmarks[0];
  const isExtended = (tipIdx: number, pipIdx: number) =>
    computeLandmarkDistance(landmarks[tipIdx], wrist) >
    computeLandmarkDistance(landmarks[pipIdx], wrist) * 1.12;

  const thumbExt =
    computeLandmarkDistance(landmarks[4], landmarks[17]) >
    computeLandmarkDistance(landmarks[2], landmarks[17]) * 1.1;
  const indexExt = isExtended(8, 6);
  const middleExt = isExtended(12, 10);
  const ringExt = isExtended(16, 14);
  const pinkyExt = isExtended(20, 18);

  const extendedFingers =
    Number(indexExt) + Number(middleExt) + Number(ringExt) + Number(pinkyExt);

  if (extendedFingers >= 4) {
    return {
      id: 'open-palm',
      label: 'Open Hand',
      actionHint: 'Mouse Navigate',
      confidence: 0.95,
    };
  }

  if (indexExt && middleExt && !ringExt && !pinkyExt) {
    return {
      id: 'peace',
      label: 'Peace',
      actionHint: 'Switch App',
      confidence: 0.9,
    };
  }

  if (indexExt && !middleExt && !ringExt && !pinkyExt) {
    return {
      id: 'point',
      label: 'Point',
      actionHint: 'Precision Aim',
      confidence: 0.92,
    };
  }

  if (
    thumbExt &&
    !indexExt &&
    !middleExt &&
    !ringExt &&
    !pinkyExt &&
    landmarks[4].y < landmarks[2].y - 0.03
  ) {
    return {
      id: 'thumbs-up',
      label: 'Thumbs Up',
      actionHint: 'Confirm',
      confidence: 0.88,
    };
  }

  if (extendedFingers === 0) {
    return {
      id: 'fist-grab',
      label: 'Fist',
      actionHint: 'Grab & Drag',
      confidence: 0.91,
    };
  }

  return {
    id: 'open-palm',
    label: 'Open Hand',
    actionHint: 'Mouse Navigate',
    confidence: 0.84,
  };
}

/**
 * Generates an anatomically articulated 21-point hand pose in normalized [0..1]
 * camera space based on cursor position and pinch/gesture state.
 * Used when hardware camera is standby/simulated so the Hand Gesture Box stays live.
 */
export function generateSimulatedHandLandmarks(
  ndcX: number,
  ndcY: number,
  isPinching: boolean,
  previewGesture?: HandGestureId,
): HandLandmarkPoint[] {
  // Center hand smoothly inside [0.22..0.78] camera space
  const cx = clamp(0.5 + ndcX * 0.24, 0.22, 0.78);
  const cy = clamp(0.56 - ndcY * 0.2, 0.26, 0.78);
  const s = 0.24; // hand scale in normalized camera frame

  const gesture: HandGestureId = isPinching
    ? 'pinch-click'
    : (previewGesture ?? 'open-palm');

  // Base open-hand offsets relative to palm center (cx, cy)
  const pts: Array<[number, number]> = [
    // 0: Wrist
    [0.0, 0.56],
    // 1..4: Thumb
    [-0.24, 0.42],
    [-0.42, 0.24],
    [-0.56, 0.06],
    [-0.66, -0.14],
    // 5..8: Index
    [-0.24, 0.02],
    [-0.3, -0.3],
    [-0.33, -0.54],
    [-0.35, -0.74],
    // 9..12: Middle
    [-0.04, -0.04],
    [-0.05, -0.38],
    [-0.05, -0.64],
    [-0.05, -0.86],
    // 13..16: Ring
    [0.16, 0.01],
    [0.2, -0.32],
    [0.23, -0.56],
    [0.25, -0.76],
    // 17..20: Pinky
    [0.34, 0.12],
    [0.42, -0.14],
    [0.47, -0.34],
    [0.51, -0.52],
  ];

  const curlFinger = (mcp: number, pip: number, dip: number, tip: number) => {
    const base = pts[mcp];
    pts[pip] = [base[0] * 0.92, base[1] - 0.1];
    pts[dip] = [base[0] * 0.82, base[1] + 0.05];
    pts[tip] = [base[0] * 0.72, base[1] + 0.18];
  };

  if (gesture === 'pinch-click') {
    // Bring thumb tip (#4) and index tip (#8) into exact pinch contact
    pts[3] = [-0.36, -0.04];
    pts[4] = [-0.26, -0.26];
    pts[6] = [-0.24, -0.22];
    pts[7] = [-0.25, -0.31];
    pts[8] = [-0.25, -0.27];
  } else if (gesture === 'point') {
    curlFinger(9, 10, 11, 12);
    curlFinger(13, 14, 15, 16);
    curlFinger(17, 18, 19, 20);
    pts[3] = [-0.26, 0.12];
    pts[4] = [-0.12, 0.12];
  } else if (gesture === 'peace') {
    curlFinger(13, 14, 15, 16);
    curlFinger(17, 18, 19, 20);
    pts[3] = [-0.24, 0.14];
    pts[4] = [-0.08, 0.14];
  } else if (gesture === 'fist-grab') {
    curlFinger(5, 6, 7, 8);
    curlFinger(9, 10, 11, 12);
    curlFinger(13, 14, 15, 16);
    curlFinger(17, 18, 19, 20);
    pts[3] = [-0.22, 0.18];
    pts[4] = [-0.02, 0.16];
  } else if (gesture === 'thumbs-up') {
    curlFinger(5, 6, 7, 8);
    curlFinger(9, 10, 11, 12);
    curlFinger(13, 14, 15, 16);
    curlFinger(17, 18, 19, 20);
    pts[2] = [-0.38, 0.08];
    pts[3] = [-0.4, -0.22];
    pts[4] = [-0.38, -0.52];
  }

  return pts.map(([ox, oy]) => ({
    x: clamp(cx + ox * s, 0.02, 0.98),
    y: clamp(cy + oy * s, 0.02, 0.98),
    z: 0,
  }));
}
