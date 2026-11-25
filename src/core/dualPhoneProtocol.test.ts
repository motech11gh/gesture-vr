import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodePairingToken,
  decodePosePacket,
  encodePairingToken,
  encodePosePacket,
  smoothRttMs,
} from './dualPhoneProtocol';
import type { PosePacket } from '../types';

test('encodes and decodes 60Hz pose packets with clamping', () => {
  const packet: PosePacket = {
    v: 1,
    kind: 'pose',
    t: 12345.6,
    seq: 42,
    hx: 0.4567,
    hy: -1.4, // clamped to -1
    pinch: true,
    gx: -0.2229,
    gy: 0.7891,
    yaw: 0.31415,
    pitch: -0.1234,
    roll: 0.01,
  };

  const encoded = encodePosePacket(packet);
  const decoded = decodePosePacket(encoded);
  assert.ok(decoded !== null);
  assert.equal(decoded.kind, 'pose');
  assert.equal(decoded.seq, 42);
  assert.equal(decoded.hx, 0.457);
  assert.equal(decoded.hy, -1);
  assert.equal(decoded.pinch, true);
  assert.equal(decoded.gx, -0.223);
  assert.equal(decoded.yaw, 0.314);
});

test('rejects malformed or wrong-version packets', () => {
  assert.equal(decodePosePacket('not json'), null);
  assert.equal(decodePosePacket('{"v":2,"k":0}'), null);
  assert.equal(decodePosePacket('{"v":1,"k":9,"t":1,"s":1,"hx":0,"hy":0}'), null);
});

test('encodes and decodes Wi-Fi Direct WebRTC pairing tokens', () => {
  const token = encodePairingToken({
    type: 'offer',
    sdp: 'v=0\r\no=- 12345 2 IN IP4 127.0.0.1\r\n',
  });
  assert.ok(token.startsWith('AERO1:'));

  const decoded = decodePairingToken(token);
  assert.ok(decoded !== null);
  assert.equal(decoded.type, 'offer');
  assert.ok(decoded.sdp.includes('IN IP4 127.0.0.1'));

  assert.equal(decodePairingToken('INVALID:xyz'), null);
});

test('smoothRttMs computes bounded exponential moving average', () => {
  assert.equal(smoothRttMs(0, 12.4), 12.4);
  assert.equal(smoothRttMs(12, 16), 13);
});
