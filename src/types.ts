export type FloatingAppId =
  | 'youtube360'
  | 'tracking'
  | 'dualPhone'
  | 'workspace';

export type UIStyleMode = 'ios27' | 'oneui';

export type PinchPhase = 'open' | 'pinch-start' | 'pinching' | 'pinch-end';

export type HandGestureId =
  | 'open-palm'
  | 'pinch-click'
  | 'point'
  | 'fist-grab'
  | 'peace'
  | 'thumbs-up'
  | 'none';

export type DualPhoneRole = 'standalone' | 'display' | 'detector';

export type DualPhoneLinkState =
  | 'idle'
  | 'awaiting-answer'
  | 'connecting'
  | 'connected'
  | 'error';

export type EnvironmentPreset =
  | 'studio'
  | 'orbital360'
  | 'alpine360'
  | 'reef360'
  | 'tokyo360';

export type CameraSensorStatus =
  | 'standby'
  | 'requesting'
  | 'active'
  | 'simulated'
  | 'unavailable';

export interface Vec2 {
  x: number;
  y: number;
}

export interface HandLandmarkPoint {
  x: number;
  y: number;
  z?: number;
}

export interface HandCropRect {
  /** Source video crop origin X in pixels */
  sx: number;
  /** Source video crop origin Y in pixels */
  sy: number;
  /** Source video crop width in pixels */
  sw: number;
  /** Source video crop height in pixels */
  sh: number;
  /** Normalized bounding box of the hand in [0..1] camera space */
  normMinX: number;
  normMinY: number;
  normMaxX: number;
  normMaxY: number;
}

export interface HandGestureClassification {
  id: HandGestureId;
  label: string;
  actionHint: string;
  confidence: number;
}

export type HandCalibrationStatus = 'idle' | 'guiding' | 'holding' | 'complete';

export interface HandCalibrationProfile {
  calibrated: boolean;
  /** Neutral hand center X in normalized [0..1] camera space */
  centerX: number;
  /** Neutral hand center Y in normalized [0..1] camera space */
  centerY: number;
  /** Measured hand bounding scale in normalized [0..1] camera space */
  handScale: number;
  /** Tuned horizontal reach gain */
  reachGainX: number;
  /** Tuned vertical reach gain */
  reachGainY: number;
  /** Tuned thumb-index pinch threshold proportional to hand scale */
  recommendedPinchThreshold: number;
  /** Stability & centering precision score (0..100) */
  precisionScore: number;
  calibratedAt: number | null;
}

export interface HeadOrientationEuler {
  yaw: number; // radians
  pitch: number; // radians
  roll: number; // radians
}

export interface HandCursorState {
  /** Normalized cursor coordinates in [-1, 1] NDC range */
  x: number;
  y: number;
  /** Raw pinch metric 0 (closed) .. 1 (open) */
  pinchDistance: number;
  isPinching: boolean;
  phase: PinchPhase;
  /** Eye gaze normalized coordinates in [-1, 1] */
  gazeX: number;
  gazeY: number;
  gazeActive: boolean;
  /** Source currently driving the hand mouse */
  source: 'rear-cam' | 'remote-phone' | 'xr-hand' | 'pointer';
  confidence: number;
  /** Live 21-point MediaPipe landmarks (normalized 0..1) or simulated hand pose */
  landmarks: HandLandmarkPoint[] | null;
  /** Recognized semantic hand gesture */
  gesture: HandGestureClassification;
}

export interface PosePacket {
  /** Schema version */
  v: 1;
  /** Packet type */
  kind: 'pose' | 'ping' | 'pong';
  /** Sender monotonic timestamp in ms */
  t: number;
  /** Sequence number */
  seq: number;
  /** Hand mouse NDC X [-1, 1] */
  hx: number;
  /** Hand mouse NDC Y [-1, 1] */
  hy: number;
  /** Pinch closed boolean */
  pinch: boolean;
  /** Eye gaze NDC X [-1, 1] */
  gx: number;
  /** Eye gaze NDC Y [-1, 1] */
  gy: number;
  /** Head orientation yaw/pitch/roll in radians */
  yaw: number;
  pitch: number;
  roll: number;
}

export interface YouTubeVideoItem {
  id: string;
  title: string;
  subtitle: string;
  preset: EnvironmentPreset;
  is360: boolean;
}

export interface TrackingSettings {
  pinchThreshold: number; // 0.03 - 0.14 normalized hand distance
  smoothing: number; // 0.1 - 0.9
  eyeGazeAssist: boolean;
  gazeWeight: number; // 0 - 0.5
  hapticIntensity: number; // 0 - 1
  audioHaptics: boolean;
  vrStereoEnabled: boolean;
  ipdMm: number; // 58 - 72
  headTrackingEnabled: boolean;
  cameraOpticalFlowEnabled: boolean;
  uiStyle: UIStyleMode;
  cameraPassthrough: boolean;
  glassOpacity: number; // 0.16 - 0.72
  handBoxVisible: boolean;
}

export interface DualPhoneStats {
  role: DualPhoneRole;
  state: DualPhoneLinkState;
  transport: 'none' | 'webrtc-p2p' | 'local-channel';
  rttMs: number;
  packetHz: number;
  lastError: string | null;
}

export interface WorkspaceTask {
  id: string;
  label: string;
  done: boolean;
}
