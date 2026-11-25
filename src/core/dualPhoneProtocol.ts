import type { PosePacket } from '../types';
import { clamp } from './trackingMath';

/**
 * Serializes a low-latency pose packet into a compact JSON string
 * (rounded to 3 decimal places to minimize Wi-Fi Direct / WebRTC payload size).
 */
export function encodePosePacket(packet: PosePacket): string {
  const compact = {
    v: 1 as const,
    k: packet.kind === 'pose' ? 0 : packet.kind === 'ping' ? 1 : 2,
    t: Math.round(packet.t),
    s: packet.seq,
    hx: round3(clamp(packet.hx, -1, 1)),
    hy: round3(clamp(packet.hy, -1, 1)),
    p: packet.pinch ? 1 : 0,
    gx: round3(clamp(packet.gx, -1, 1)),
    gy: round3(clamp(packet.gy, -1, 1)),
    y: round3(packet.yaw),
    pi: round3(packet.pitch),
    r: round3(packet.roll),
  };
  return JSON.stringify(compact);
}

/**
 * Parses and validates an incoming pose packet from a remote Camera Detector phone.
 * Returns null if malformed.
 */
export function decodePosePacket(raw: string): PosePacket | null {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object' || obj.v !== 1) return null;
    if (
      typeof obj.t !== 'number' ||
      typeof obj.s !== 'number' ||
      typeof obj.hx !== 'number' ||
      typeof obj.hy !== 'number'
    ) {
      return null;
    }

    const kind =
      obj.k === 0 ? 'pose' : obj.k === 1 ? 'ping' : obj.k === 2 ? 'pong' : null;
    if (!kind) return null;

    return {
      v: 1,
      kind,
      t: obj.t,
      seq: obj.s,
      hx: clamp(obj.hx, -1, 1),
      hy: clamp(obj.hy, -1, 1),
      pinch: Boolean(obj.p),
      gx: typeof obj.gx === 'number' ? clamp(obj.gx, -1, 1) : 0,
      gy: typeof obj.gy === 'number' ? clamp(obj.gy, -1, 1) : 0,
      yaw: typeof obj.y === 'number' && Number.isFinite(obj.y) ? obj.y : 0,
      pitch: typeof obj.pi === 'number' && Number.isFinite(obj.pi) ? obj.pi : 0,
      roll: typeof obj.r === 'number' && Number.isFinite(obj.r) ? obj.r : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Encodes a WebRTC SessionDescription (SDP offer or answer) into a compact copyable
 * pairing token for serverless Wi-Fi Direct / LAN handshake between two phones.
 */
export function encodePairingToken(desc: {
  type: string;
  sdp: string;
}): string {
  const payload = JSON.stringify({ type: desc.type, sdp: desc.sdp });
  const bytes = new TextEncoder().encode(payload);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `AERO1:${btoa(binary)}`;
}

/**
 * Decodes a compact `AERO1:` pairing token back into an RTCSessionDescriptionInit.
 */
export function decodePairingToken(
  token: string,
): { type: 'offer' | 'answer'; sdp: string } | null {
  const trimmed = token.trim();
  if (!trimmed.startsWith('AERO1:')) return null;
  try {
    const b64 = trimmed.slice('AERO1:'.length);
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const json = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(json) as { type?: string; sdp?: string };
    if (
      (parsed.type === 'offer' || parsed.type === 'answer') &&
      typeof parsed.sdp === 'string' &&
      parsed.sdp.length > 0
    ) {
      return { type: parsed.type, sdp: parsed.sdp };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Exponential moving average for smooth RTT latency readout.
 */
export function smoothRttMs(prevRtt: number, sampleRtt: number): number {
  const clamped = clamp(sampleRtt, 0.5, 999);
  if (prevRtt <= 0) return Math.round(clamped * 10) / 10;
  return Math.round((prevRtt * 0.75 + clamped * 0.25) * 10) / 10;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
