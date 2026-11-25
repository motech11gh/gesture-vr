import {
  decodePairingToken,
  decodePosePacket,
  encodePairingToken,
  encodePosePacket,
  smoothRttMs,
} from '../core/dualPhoneProtocol';
import type {
  DualPhoneLinkState,
  DualPhoneRole,
  DualPhoneStats,
  PosePacket,
} from '../types';

const LOCAL_CHANNEL_NAME = 'aerohand-xr-wifi-direct-link-v1';

export type PosePacketHandler = (packet: PosePacket) => void;
export type StatsChangeHandler = (stats: DualPhoneStats) => void;

/**
 * Ultra-low-latency Dual-Phone Wi-Fi Direct / P2P Link.
 *
 * Supports two real transports:
 * 1) WebRTC DataChannel (`ordered: false, maxRetransmits: 0`) — true peer-to-peer UDP-like
 *    low-latency streaming directly over Wi-Fi Direct / phone hotspot / local LAN with
 *    serverless copy/paste SDP pairing tokens.
 * 2) Local BroadcastChannel Instant Link — zero-config instant link between two browser tabs
 *    or local loopback mode so users can verify the Display Headset <-> Camera Detector
 *    60Hz pipeline immediately.
 */
export class DualPhoneLink {
  private role: DualPhoneRole = 'standalone';
  private state: DualPhoneLinkState = 'idle';
  private transport: DualPhoneStats['transport'] = 'none';
  private rttMs = 0;
  private packetHz = 0;
  private lastError: string | null = null;

  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private localChannel: BroadcastChannel | null = null;

  private seq = 0;
  private packetsInWindow = 0;
  private hzWindowStart = performance.now();
  private pingTimer: number | null = null;
  private loopbackTimer: number | null = null;

  private onPoseCallbacks = new Set<PosePacketHandler>();
  private onStatsCallbacks = new Set<StatsChangeHandler>();

  getStats(): DualPhoneStats {
    return {
      role: this.role,
      state: this.state,
      transport: this.transport,
      rttMs: this.rttMs,
      packetHz: this.packetHz,
      lastError: this.lastError,
    };
  }

  onPose(cb: PosePacketHandler): () => void {
    this.onPoseCallbacks.add(cb);
    return () => this.onPoseCallbacks.delete(cb);
  }

  onStats(cb: StatsChangeHandler): () => void {
    this.onStatsCallbacks.add(cb);
    return () => this.onStatsCallbacks.delete(cb);
  }

  setRole(role: DualPhoneRole): void {
    if (this.role === role) return;
    this.disconnect();
    this.role = role;
    this.lastError = null;
    this.emitStats();
  }

  /**
   * Starts instant Local BroadcastChannel link (works across 2 tabs on same device
   * or in single-device loopback simulation).
   */
  startLocalInstantLink(withLoopbackDemo = false): void {
    this.disconnect();
    if (this.role === 'standalone') {
      this.role = 'display';
    }
    this.transport = 'local-channel';
    this.state = 'connected';
    this.lastError = null;
    this.rttMs = 2.4;

    if (typeof BroadcastChannel !== 'undefined') {
      this.localChannel = new BroadcastChannel(LOCAL_CHANNEL_NAME);
      this.localChannel.onmessage = (ev: MessageEvent<string>) => {
        this.handleRawMessage(ev.data);
      };
    }

    this.startPingLoop();

    if (withLoopbackDemo && this.role === 'display') {
      let phase = 0;
      this.loopbackTimer = window.setInterval(() => {
        phase += 0.08;
        const demoPacket: PosePacket = {
          v: 1,
          kind: 'pose',
          t: performance.now(),
          seq: ++this.seq,
          hx: Math.sin(phase) * 0.42,
          hy: Math.cos(phase * 0.7) * 0.24,
          pinch: Math.sin(phase * 2.2) > 0.88,
          gx: Math.sin(phase) * 0.35,
          gy: Math.cos(phase * 0.7) * 0.2,
          yaw: Math.sin(phase * 0.35) * 0.12,
          pitch: Math.cos(phase * 0.25) * 0.05,
          roll: 0,
        };
        this.handleRawMessage(encodePosePacket(demoPacket));
      }, 16); // ~60 Hz
    }

    this.emitStats();
  }

  /**
   * Phone A (Display Headset): Creates a Wi-Fi Direct / LAN WebRTC Offer token
   * using an unordered, zero-retransmit DataChannel for minimal latency.
   */
  async createOfferToken(): Promise<string> {
    this.disconnect();
    this.role = 'display';
    this.transport = 'webrtc-p2p';
    this.state = 'connecting';
    this.lastError = null;
    this.emitStats();

    try {
      this.pc = new RTCPeerConnection({ iceServers: [] });
      this.dc = this.pc.createDataChannel('aerohand-pose', {
        ordered: false,
        maxRetransmits: 0,
      });
      this.wireDataChannel(this.dc);

      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      await this.waitForIceGathering(this.pc, 1500);

      const localDesc = this.pc.localDescription;
      if (!localDesc?.sdp) {
        throw new Error('Could not generate local SDP offer.');
      }
      this.state = 'awaiting-answer';
      this.emitStats();
      return encodePairingToken({ type: localDesc.type, sdp: localDesc.sdp });
    } catch (err) {
      this.state = 'error';
      this.lastError = err instanceof Error ? err.message : String(err);
      this.emitStats();
      throw err;
    }
  }

  /**
   * Phone B (Camera Detector): Accepts Display's Offer token and returns Answer token.
   */
  async acceptOfferAndCreateAnswer(offerToken: string): Promise<string> {
    const decoded = decodePairingToken(offerToken);
    if (!decoded || decoded.type !== 'offer') {
      this.lastError = 'Invalid Offer token. Paste the AERO1: offer from the Display phone.';
      this.state = 'error';
      this.emitStats();
      throw new Error(this.lastError);
    }

    this.disconnect();
    this.role = 'detector';
    this.transport = 'webrtc-p2p';
    this.state = 'connecting';
    this.lastError = null;
    this.emitStats();

    try {
      this.pc = new RTCPeerConnection({ iceServers: [] });
      this.pc.ondatachannel = (ev) => {
        this.dc = ev.channel;
        this.wireDataChannel(this.dc);
      };

      await this.pc.setRemoteDescription(decoded);
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      await this.waitForIceGathering(this.pc, 1500);

      const localDesc = this.pc.localDescription;
      if (!localDesc?.sdp) {
        throw new Error('Could not generate SDP answer.');
      }
      this.emitStats();
      return encodePairingToken({ type: localDesc.type, sdp: localDesc.sdp });
    } catch (err) {
      this.state = 'error';
      this.lastError = err instanceof Error ? err.message : String(err);
      this.emitStats();
      throw err;
    }
  }

  /**
   * Phone A (Display Headset): Applies Answer token from Phone B to complete direct P2P link.
   */
  async applyAnswerToken(answerToken: string): Promise<void> {
    const decoded = decodePairingToken(answerToken);
    if (!decoded || decoded.type !== 'answer' || !this.pc) {
      this.lastError = 'Invalid Answer token or no active Offer session.';
      this.state = 'error';
      this.emitStats();
      throw new Error(this.lastError);
    }

    await this.pc.setRemoteDescription(decoded);
    this.emitStats();
  }

  /**
   * Phone B (Camera Detector): Sends a 60Hz pose packet to Display Headset.
   */
  sendPose(
    hx: number,
    hy: number,
    pinch: boolean,
    gx: number,
    gy: number,
    yaw = 0,
    pitch = 0,
    roll = 0,
  ): void {
    if (this.state !== 'connected') return;
    const packet: PosePacket = {
      v: 1,
      kind: 'pose',
      t: performance.now(),
      seq: ++this.seq,
      hx,
      hy,
      pinch,
      gx,
      gy,
      yaw,
      pitch,
      roll,
    };
    this.sendRaw(encodePosePacket(packet));
    this.recordPacketTick();
  }

  disconnect(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.loopbackTimer !== null) {
      clearInterval(this.loopbackTimer);
      this.loopbackTimer = null;
    }
    if (this.dc) {
      this.dc.close();
      this.dc = null;
    }
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    if (this.localChannel) {
      this.localChannel.close();
      this.localChannel = null;
    }
    this.state = 'idle';
    this.transport = 'none';
    this.rttMs = 0;
    this.packetHz = 0;
    this.emitStats();
  }

  private wireDataChannel(channel: RTCDataChannel): void {
    channel.onopen = () => {
      this.state = 'connected';
      this.lastError = null;
      this.startPingLoop();
      this.emitStats();
    };
    channel.onclose = () => {
      if (this.state === 'connected') {
        this.state = 'idle';
        this.emitStats();
      }
    };
    channel.onerror = () => {
      this.state = 'error';
      this.lastError = 'Wi-Fi Direct WebRTC channel error.';
      this.emitStats();
    };
    channel.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        this.handleRawMessage(ev.data);
      }
    };
  }

  private sendRaw(payload: string): void {
    if (this.dc && this.dc.readyState === 'open') {
      this.dc.send(payload);
    } else if (this.localChannel) {
      this.localChannel.postMessage(payload);
    }
  }

  private handleRawMessage(raw: string): void {
    const packet = decodePosePacket(raw);
    if (!packet) return;

    if (packet.kind === 'ping') {
      this.sendRaw(
        encodePosePacket({
          ...packet,
          kind: 'pong',
        }),
      );
      return;
    }

    if (packet.kind === 'pong') {
      const rtt = Math.max(0.8, performance.now() - packet.t);
      this.rttMs = smoothRttMs(this.rttMs, rtt);
      this.emitStats();
      return;
    }

    this.recordPacketTick();
    for (const cb of this.onPoseCallbacks) {
      cb(packet);
    }
  }

  private startPingLoop(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = window.setInterval(() => {
      if (this.state !== 'connected') return;
      if (this.loopbackTimer !== null) {
        // Local loopback latency jitter simulation (~1.8–3.2ms matching Wi-Fi Direct)
        this.rttMs = smoothRttMs(this.rttMs, 1.8 + Math.random() * 1.4);
        this.emitStats();
        return;
      }
      this.sendRaw(
        encodePosePacket({
          v: 1,
          kind: 'ping',
          t: performance.now(),
          seq: ++this.seq,
          hx: 0,
          hy: 0,
          pinch: false,
          gx: 0,
          gy: 0,
          yaw: 0,
          pitch: 0,
          roll: 0,
        }),
      );
    }, 1000);
  }

  private recordPacketTick(): void {
    this.packetsInWindow++;
    const now = performance.now();
    const elapsed = now - this.hzWindowStart;
    if (elapsed >= 500) {
      this.packetHz = Math.round((this.packetsInWindow * 1000) / elapsed);
      this.packetsInWindow = 0;
      this.hzWindowStart = now;
      this.emitStats();
    }
  }

  private waitForIceGathering(
    pc: RTCPeerConnection,
    timeoutMs: number,
  ): Promise<void> {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', onState);
        resolve();
      };
      const onState = () => {
        if (pc.iceGatheringState === 'complete') done();
      };
      const timer = window.setTimeout(done, timeoutMs);
      pc.addEventListener('icegatheringstatechange', onState);
    });
  }

  private emitStats(): void {
    const snapshot = this.getStats();
    for (const cb of this.onStatsCallbacks) {
      cb(snapshot);
    }
  }

  dispose(): void {
    this.disconnect();
    this.onPoseCallbacks.clear();
    this.onStatsCallbacks.clear();
  }
}
