import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyHandGesture,
  computeHandCropRect,
  generateSimulatedHandLandmarks,
  HAND_SKELETON_CONNECTIONS,
  smoothHandCropRect,
} from './handGestureBox';

test('computeHandCropRect centers padded ROI around detected hand landmarks within video bounds', () => {
  const landmarks = generateSimulatedHandLandmarks(0.1, 0.1, false, 'open-palm');
  const crop = computeHandCropRect(landmarks, 640, 480, 0.4, 4 / 3);

  assert.ok(crop.sx >= 0);
  assert.ok(crop.sy >= 0);
  assert.ok(crop.sx + crop.sw <= 640.01);
  assert.ok(crop.sy + crop.sh <= 480.01);
  assert.ok(crop.sw < 640, 'Should zoom into the hand region rather than full frame');
  assert.ok(Math.abs(crop.sw / crop.sh - 4 / 3) < 0.05);
});

test('computeHandCropRect clamps cleanly near camera frame corners', () => {
  const edgeHand = [
    { x: 0.02, y: 0.02 },
    { x: 0.12, y: 0.14 },
  ];
  const crop = computeHandCropRect(edgeHand, 1280, 720, 0.4, 4 / 3);
  assert.equal(crop.sx, 0);
  assert.equal(crop.sy, 0);
  assert.ok(crop.sw > 0 && crop.sh > 0);
});

test('smoothHandCropRect interpolates smoothly without snapping', () => {
  const a = computeHandCropRect(
    generateSimulatedHandLandmarks(-0.6, 0, false),
    640,
    480,
  );
  const b = computeHandCropRect(
    generateSimulatedHandLandmarks(0.6, 0, false),
    640,
    480,
  );
  const mid = smoothHandCropRect(a, b, 0.016);
  assert.ok(mid.sx > a.sx && mid.sx < b.sx);
});

test('classifyHandGesture recognizes Open Hand, Pinch, Point, Fist, Peace, and Thumbs Up', () => {
  const openPts = generateSimulatedHandLandmarks(0, 0, false, 'open-palm');
  assert.equal(classifyHandGesture(openPts, false).id, 'open-palm');

  const pinchPts = generateSimulatedHandLandmarks(0, 0, true);
  assert.equal(classifyHandGesture(pinchPts, true).id, 'pinch-click');

  const pointPts = generateSimulatedHandLandmarks(0, 0, false, 'point');
  assert.equal(classifyHandGesture(pointPts, false).id, 'point');

  const peacePts = generateSimulatedHandLandmarks(0, 0, false, 'peace');
  assert.equal(classifyHandGesture(peacePts, false).id, 'peace');

  const fistPts = generateSimulatedHandLandmarks(0, 0, false, 'fist-grab');
  assert.equal(classifyHandGesture(fistPts, false).id, 'fist-grab');

  const thumbPts = generateSimulatedHandLandmarks(0, 0, false, 'thumbs-up');
  assert.equal(classifyHandGesture(thumbPts, false).id, 'thumbs-up');
});

test('HAND_SKELETON_CONNECTIONS stays within 21-point landmark indices', () => {
  for (const [a, b] of HAND_SKELETON_CONNECTIONS) {
    assert.ok(a >= 0 && a < 21);
    assert.ok(b >= 0 && b < 21);
  }
});
