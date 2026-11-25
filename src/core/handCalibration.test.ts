import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyHandCalibrationToNdc,
  computePalmCenterAndScale,
  createInitialCalibrationSession,
  DEFAULT_HAND_CALIBRATION,
  evaluateHandCentering,
  isBenignMediaPipeInfoLog,
  startCalibrationSession,
  stepCalibrationSession,
} from './handCalibration';
import { generateSimulatedHandLandmarks } from './handGestureBox';

test('isBenignMediaPipeInfoLog identifies TFLite XNNPACK CPU info logs without hiding real errors', () => {
  assert.equal(
    isBenignMediaPipeInfoLog([
      'INFO: Created TensorFlow Lite XNNPACK delegate for CPU.',
    ]),
    true,
  );
  assert.equal(
    isBenignMediaPipeInfoLog([
      'INFO: Initialized TensorFlow Lite runtime.',
    ]),
    true,
  );
  assert.equal(
    isBenignMediaPipeInfoLog(['TypeError: Cannot read properties of null']),
    false,
  );
  assert.equal(
    isBenignMediaPipeInfoLog([new Error('Real error')]),
    false,
  );
});

test('computePalmCenterAndScale extracts stable palm center and scale from 21 landmarks', () => {
  const landmarks = generateSimulatedHandLandmarks(0, 0, false, 'open-palm');
  const measurement = computePalmCenterAndScale(landmarks);
  assert.ok(measurement);
  assert.ok(Math.abs(measurement.x - 0.5) < 0.08);
  assert.ok(Math.abs(measurement.y - 0.58) < 0.1);
  assert.ok(measurement.scale > 0.15 && measurement.scale < 0.5);
  assert.equal(computePalmCenterAndScale(null), null);
});

test('evaluateHandCentering gives directional coaching when off-center and confirms center', () => {
  const centered = evaluateHandCentering(0.51, 0.49);
  assert.equal(centered.isCentered, true);
  assert.match(centered.guidance, /Centered/i);

  const farRight = evaluateHandCentering(0.76, 0.5);
  assert.equal(farRight.isCentered, false);
  assert.match(farRight.guidance, /left/i);

  const farUpLeft = evaluateHandCentering(0.24, 0.25);
  assert.equal(farUpLeft.isCentered, false);
  assert.match(farUpLeft.guidance, /down and right/i);
});

test('stepCalibrationSession fills progress while centered and locks an optimized profile', () => {
  const idle = createInitialCalibrationSession();
  assert.equal(idle.status, 'idle');

  let state = startCalibrationSession();
  assert.equal(state.status, 'guiding');

  // Off-center sample keeps guiding and does not progress
  let res = stepCalibrationSession(
    state,
    { x: 0.82, y: 0.5, scale: 0.26 },
    0.1,
    1.0,
    1000,
  );
  state = res.session;
  assert.equal(state.status, 'guiding');
  assert.equal(state.progress, 0);
  assert.equal(res.completedProfile, null);

  // Hold centered for 1.0s (10 steps of 0.1s)
  let completedProfile = null;
  for (let i = 0; i < 11; i++) {
    res = stepCalibrationSession(
      state,
      { x: 0.52, y: 0.48, scale: 0.24 },
      0.1,
      1.0,
      2000 + i * 100,
    );
    state = res.session;
    if (res.completedProfile) {
      completedProfile = res.completedProfile;
    }
  }

  assert.equal(state.status, 'complete');
  assert.equal(state.progress, 1);
  assert.ok(completedProfile);
  assert.equal(completedProfile.calibrated, true);
  assert.ok(Math.abs(completedProfile.centerX - 0.52) < 0.001);
  assert.ok(Math.abs(completedProfile.centerY - 0.48) < 0.001);
  assert.ok(completedProfile.precisionScore >= 90);
});

test('applyHandCalibrationToNdc centers calibrated hand position to (0, 0) in both mirror modes', () => {
  const profile = {
    ...DEFAULT_HAND_CALIBRATION,
    calibrated: true,
    centerX: 0.58,
    centerY: 0.44,
    reachGainX: 1.5,
    reachGainY: 1.5,
  };

  const unmirrored = applyHandCalibrationToNdc(0.58, 0.44, false, profile);
  assert.ok(Math.abs(unmirrored.x) < 1e-6);
  assert.ok(Math.abs(unmirrored.y) < 1e-6);

  const mirrored = applyHandCalibrationToNdc(0.58, 0.44, true, profile);
  assert.ok(Math.abs(mirrored.x) < 1e-6);
  assert.ok(Math.abs(mirrored.y) < 1e-6);
});
