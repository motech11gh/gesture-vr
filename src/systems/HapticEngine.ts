import * as xb from 'xrblocks';

export type HapticPattern =
  | 'hover'
  | 'pinch-click'
  | 'app-launch'
  | 'grab'
  | 'error'
  | 'recenter';

export type HapticPulseListener = (pattern: HapticPattern, intensity: number) => void;

const VIBRATION_PATTERNS: Record<HapticPattern, number[]> = {
  hover: [10],
  'pinch-click': [22, 14, 30],
  'app-launch': [28, 18, 42],
  grab: [16],
  error: [40, 28, 40],
  recenter: [18, 16, 18],
};

/**
 * Multi-sensory haptic feedback engine:
 * 1) Mobile Vibration API (`navigator.vibrate`)
 * 2) WebXR controller hapticActuators
 * 3) Procedural Web Audio tactile click/thump synthesis
 * 4) 3D spatial ripple event callbacks
 */
export class HapticEngine {
  private audioCtx: AudioContext | null = null;
  private intensity = 0.85;
  private audioEnabled = true;
  private pulseCount = 0;
  private listeners = new Set<HapticPulseListener>();

  get count(): number {
    return this.pulseCount;
  }

  setIntensity(value: number): void {
    this.intensity = Math.min(1, Math.max(0, value));
  }

  setAudioEnabled(enabled: boolean): void {
    this.audioEnabled = enabled;
  }

  onPulse(listener: HapticPulseListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  trigger(pattern: HapticPattern): void {
    if (this.intensity <= 0.01) return;
    this.pulseCount++;

    // 1. Mobile hardware vibration
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      const scaled = VIBRATION_PATTERNS[pattern].map((ms) =>
        Math.max(4, Math.round(ms * this.intensity)),
      );
      try {
        navigator.vibrate(scaled);
      } catch {
        // Ignore browser autoplay / non-gesture vibrate guards
      }
    }

    // 2. WebXR Gamepad haptic actuators if in an active XR session
    try {
      const xrSession = xb.core?.renderer?.xr?.getSession?.();
      if (xrSession) {
        for (const source of xrSession.inputSources) {
          const actuator = source.gamepad?.hapticActuators?.[0] as
            | { pulse?: (value: number, duration: number) => Promise<boolean> }
            | undefined;
          if (actuator && typeof actuator.pulse === 'function') {
            const duration = pattern === 'hover' ? 18 : 42;
            const strength =
              (pattern === 'hover' ? 0.35 : 0.85) * this.intensity;
            void actuator.pulse(strength, duration);
          }
        }
      }
    } catch {
      // Safe no-op outside active XR session
    }

    // 3. Procedural Web Audio tactile cue
    if (this.audioEnabled) {
      this.playProceduralCue(pattern);
    }

    // 4. Notify 3D spatial visual ripple subscribers
    for (const listener of this.listeners) {
      listener(pattern, this.intensity);
    }
  }

  private playProceduralCue(pattern: HapticPattern): void {
    if (typeof window === 'undefined') return;
    try {
      const AudioCtor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AudioCtor) return;
      if (!this.audioCtx) {
        this.audioCtx = new AudioCtor();
      }
      if (this.audioCtx.state === 'suspended') {
        void this.audioCtx.resume();
      }

      const now = this.audioCtx.currentTime;
      const gain = this.audioCtx.createGain();
      const osc = this.audioCtx.createOscillator();
      const vol = 0.09 * this.intensity;

      if (pattern === 'hover') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(520, now);
        osc.frequency.exponentialRampToValueAtTime(660, now + 0.025);
        gain.gain.setValueAtTime(vol * 0.45, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.032);
        osc.connect(gain).connect(this.audioCtx.destination);
        osc.start(now);
        osc.stop(now + 0.035);
      } else if (pattern === 'pinch-click' || pattern === 'grab') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(pattern === 'grab' ? 280 : 420, now);
        osc.frequency.exponentialRampToValueAtTime(840, now + 0.045);
        gain.gain.setValueAtTime(vol, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.075);
        osc.connect(gain).connect(this.audioCtx.destination);
        osc.start(now);
        osc.stop(now + 0.08);
      } else if (pattern === 'app-launch' || pattern === 'recenter') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(360, now);
        osc.frequency.exponentialRampToValueAtTime(720, now + 0.09);
        gain.gain.setValueAtTime(vol * 0.9, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.13);
        osc.connect(gain).connect(this.audioCtx.destination);
        osc.start(now);
        osc.stop(now + 0.14);
      } else {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(210, now);
        osc.frequency.exponentialRampToValueAtTime(120, now + 0.09);
        gain.gain.setValueAtTime(vol * 0.7, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.1);
        osc.connect(gain).connect(this.audioCtx.destination);
        osc.start(now);
        osc.stop(now + 0.11);
      }
    } catch {
      // Audio playback blocked before user gesture
    }
  }

  dispose(): void {
    this.listeners.clear();
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      void this.audioCtx.close();
      this.audioCtx = null;
    }
  }
}
