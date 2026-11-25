import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeLandmarkDistance,
  estimateCameraOpticalFlow,
  evaluatePinchState,
  fuseHandAndEyeCursor,
  fuseHeadOrientation,
  handLandmarkToNdc,
  smoothCursorNdc,
} from './trackingMath';

test('pinch state machine uses hysteresis to prevent chatter', () => {
  const opts = { engageThreshold: 0.06, releaseHysteresis: 0.025 };

  // Open hand remains open
  let state = evaluatePinchState(
    { isPinching: false, lastPhase: 'open' },
    0.12,
    opts,
  );
  assert.equal(state.isPinching, false);
  assert.equal(state.lastPhase, 'open');

  // Thumb-index close triggers pinch-start
  state = evaluatePinchState(state, 0.05, opts);
  assert.equal(state.isPinching, true);
  assert.equal(state.lastPhase, 'pinch-start');

  // Slight relaxation inside hysteresis band stays pinching (no false release)
  state = evaluatePinchState(state, 0.07, opts);
  assert.equal(state.isPinching, true);
  assert.equal(state.lastPhase, 'pinching');

  // Opening beyond engage + hysteresis triggers pinch-end
  state = evaluatePinchState(state, 0.09, opts);
  assert.equal(state.isPinching, false);
  assert.equal(state.lastPhase, 'pinch-end');
});

test('handLandmarkToNdc mirrors X and clamps to [-1, 1]', () => {
  const center = handLandmarkToNdc(0.5, 0.5, true, 1.35);
  assert.equal(Math.abs(center.x) < 1e-6, true);
  assert.equal(Math.abs(center.y) < 1e-6, true);

  const topRight = handLandmarkToNdc(0.1, 0.1, true, 1.35);
  assert.equal(topRight.x, 1);
  assert.equal(topRight.y, 1);
});

test('fuseHandAndEyeCursor blends hand mouse and front-camera eye gaze', () => {
  const blended = fuseHandAndEyeCursor(
    { x: 0.0, y: 0.0 },
    { x: 0.8, y: -0.4 },
    true,
    true,
    0.25,
  );
  assert.ok(Math.abs(blended.x - 0.2) < 1e-6);
  assert.ok(Math.abs(blended.y - -0.1) < 1e-6);

  // Disabled eye gaze returns exact hand cursor
  const handOnly = fuseHandAndEyeCursor(
    { x: 0.3, y: -0.2 },
    { x: -0.9, y: 0.9 },
    true,
    false,
    0.25,
  );
  assert.equal(handOnly.x, 0.3);
  assert.equal(handOnly.y, -0.2);
});

test('smoothCursorNdc converges toward target without overshoot', () => {
  const next = smoothCursorNdc({ x: 0, y: 0 }, { x: 1, y: -1 }, 0.5, 0.016);
  assert.ok(next.x > 0 && next.x < 1);
  assert.ok(next.y < 0 && next.y > -1);
});

test('estimateCameraOpticalFlow detects shifted textured luminance frame', () => {
  const width = 24;
  const height = 24;
  const prev = new Uint8Array(width * height);
  const curr = new Uint8Array(width * height);

  // Create a bright pattern in prev shifted by (+2, -1) in curr
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pattern = ((x * 17 + y * 31) % 255) & 0xff;
      prev[y * width + x] = pattern;
      const sx = x - 2;
      const sy = y + 1;
      curr[y * width + x] =
        sx >= 0 && sx < width && sy >= 0 && sy < height
          ? ((sx * 17 + sy * 31) % 255) & 0xff
          : 0;
    }
  }

  const flow = estimateCameraOpticalFlow(prev, curr, width, height, 3);
  assert.equal(flow.x, 2);
  assert.equal(flow.y, -1);
});

test('fuseHeadOrientation subtracts recenter offset and clamps pitch', () => {
  const fused = fuseHeadOrientation(
    { yaw: 1.5, pitch: 2.0, roll: 0.1 },
    { yaw: 1.5, pitch: 0.0, roll: 0.1 },
    { x: 0.2, y: 0 },
    0.5,
  );
  assert.ok(Math.abs(fused.yaw - 0.1) < 1e-6);
  assert.ok(fused.pitch <= Math.PI * 0.46 + 1e-6);
  assert.ok(Math.abs(fused.roll) < 1e-6);
});

test('computeLandmarkDistance calculates 3D Euclidean distance', () => {
  assert.equal(
    computeLandmarkDistance({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 }),
    5,
  );
});
