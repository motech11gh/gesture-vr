import {
  FaceLandmarker,
  FilesetResolver,
  HandLandmarker,
} from '@mediapipe/tasks-vision';
import {
  applyHandCalibrationToNdc,
  computePalmCenterAndScale,
  DEFAULT_HAND_CALIBRATION,
  isBenignMediaPipeInfoLog,
} from '../core/handCalibration';
import {
  classifyHandGesture,
  generateSimulatedHandLandmarks,
} from '../core/handGestureBox';
import {
  computeLandmarkDistance,
  evaluatePinchState,
  fuseHandAndEyeCursor,
  smoothCursorNdc,
  type PinchDetectorState,
} from '../core/trackingMath';
import type {
  CameraSensorStatus,
  HandCalibrationProfile,
  HandCursorState,
  HandGestureId,
  HandLandmarkPoint,
  TrackingSettings,
  Vec2,
} from '../types';

const MEDIAPIPE_WASM_ROOT =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm';
const HAND_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const FACE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

/**
 * Manages simultaneous Rear Camera (hand-mouse & thumb-index pinch via MediaPipe HandLandmarker)
 * and Front Camera (eye-gaze focus via MediaPipe FaceLandmarker) with graceful fallback
 * when hardware cameras are unavailable or restricted to a single concurrent stream.
 */
export class DualCameraTracker {
  rearStatus: CameraSensorStatus = 'standby';
  frontStatus: CameraSensorStatus = 'standby';

  rearVideo: HTMLVideoElement | null = null;
  frontVideo: HTMLVideoElement | null = null;
  private passthroughVideo: HTMLVideoElement | null = null;

  private rearStream: MediaStream | null = null;
  private frontStream: MediaStream | null = null;
  private handLandmarker: HandLandmarker | null = null;
  private faceLandmarker: FaceLandmarker | null = null;
  private modelsLoading = false;
  private lastRearVideoTime = -1;
  private lastFrontVideoTime = -1;
  private lastHandTimestampMs = 0;
  private lastFaceTimestampMs = 0;

  private rawHandNdc: Vec2 = { x: 0, y: 0 };
  private rawEyeNdc: Vec2 = { x: 0, y: 0 };
  private smoothNdc: Vec2 = { x: 0, y: 0 };
  private pinchDistance = 0.16;
  private pinchState: PinchDetectorState = {
    isPinching: false,
    lastPhase: 'open',
  };
  private hasHandFrame = false;
  private hasEyeFrame = false;
  private liveLandmarks: HandLandmarkPoint[] | null = null;
  private simulatedGestureOverride: HandGestureId | undefined = undefined;
  private pointerFallbackNdc: Vec2 = { x: 0, y: 0 };
  private pointerDown = false;
  private calibration: HandCalibrationProfile = { ...DEFAULT_HAND_CALIBRATION };
  private origConsoleError: typeof console.error | null = null;
  private remotePacket: {
    hx: number;
    hy: number;
    pinch: boolean;
    gx: number;
    gy: number;
    expiresAt: number;
  } | null = null;

  private cursorState: HandCursorState = {
    x: 0,
    y: 0,
    pinchDistance: 0.16,
    isPinching: false,
    phase: 'open',
    gazeX: 0,
    gazeY: 0,
    gazeActive: false,
    source: 'pointer',
    confidence: 1,
    landmarks: generateSimulatedHandLandmarks(0, 0, false, 'open-palm'),
    gesture: {
      id: 'open-palm',
      label: 'Open Hand',
      actionHint: 'Mouse Navigate',
      confidence: 0.95,
    },
  };

  attachPreviewElements(
    rearEl: HTMLVideoElement | null,
    frontEl: HTMLVideoElement | null,
    passthroughEl?: HTMLVideoElement | null,
  ): void {
    this.rearVideo = rearEl;
    this.frontVideo = frontEl;
    if (passthroughEl !== undefined) {
      this.passthroughVideo = passthroughEl;
    }
    if (this.rearVideo && this.rearStream) {
      this.rearVideo.srcObject = this.rearStream;
      void this.rearVideo.play().catch(() => {});
    }
    if (this.passthroughVideo && this.rearStream) {
      this.passthroughVideo.srcObject = this.rearStream;
      void this.passthroughVideo.play().catch(() => {});
    }
    if (this.frontVideo && this.frontStream) {
      this.frontVideo.srcObject = this.frontStream;
      void this.frontVideo.play().catch(() => {});
    }
  }

  setSimulatedGesture(gesture?: HandGestureId): void {
    this.simulatedGestureOverride = gesture;
  }

  setCalibration(profile: HandCalibrationProfile): void {
    this.calibration = { ...profile };
  }

  resetCalibration(): void {
    this.calibration = { ...DEFAULT_HAND_CALIBRATION };
  }

  getCalibration(): HandCalibrationProfile {
    return { ...this.calibration };
  }

  private installMediaPipeLogFilter(): void {
    if (this.origConsoleError) return;
    const original = console.error.bind(console);
    this.origConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      if (isBenignMediaPipeInfoLog(args)) {
        return;
      }
      original(...args);
    };
  }

  private restoreMediaPipeLogFilter(): void {
    if (!this.origConsoleError) return;
    console.error = this.origConsoleError;
    this.origConsoleError = null;
  }

  updatePointerFallback(ndcX: number, ndcY: number, isDown?: boolean): void {
    this.pointerFallbackNdc.x = ndcX;
    this.pointerFallbackNdc.y = ndcY;
    if (typeof isDown === 'boolean') {
      this.pointerDown = isDown;
    }
  }

  injectRemotePhoneInput(
    hx: number,
    hy: number,
    pinch: boolean,
    gx: number,
    gy: number,
  ): void {
    this.remotePacket = {
      hx,
      hy,
      pinch,
      gx,
      gy,
      expiresAt: performance.now() + 1500,
    };
  }

  worldFacingMode: 'environment' | 'user' = 'environment';

  async switchWorldCamera(): Promise<{
    rear: CameraSensorStatus;
    front: CameraSensorStatus;
  }> {
    this.worldFacingMode =
      this.worldFacingMode === 'environment' ? 'user' : 'environment';
    this.stopCameras();
    return this.startDualCameras();
  }

  /**
   * Activates the real-world background & hand camera (Rear / environment by default,
   * with automatic fallback to any available webcam) plus Front (user -> Eye) camera
   * simultaneously where supported by device hardware.
   */
  async startDualCameras(): Promise<{
    rear: CameraSensorStatus;
    front: CameraSensorStatus;
  }> {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.rearStatus = 'simulated';
      this.frontStatus = 'simulated';
      return { rear: this.rearStatus, front: this.frontStatus };
    }

    if (this.rearStatus === 'active' && this.rearStream) {
      this.ensureHiddenVideo('rear', this.rearStream);
      return { rear: this.rearStatus, front: this.frontStatus };
    }

    this.rearStatus = 'requesting';
    this.frontStatus = 'requesting';

    // Load MediaPipe models asynchronously without blocking stream startup
    void this.ensureVisionModels();

    // 1. Real-world camera for passthrough background + hand-mouse + optical-flow head tracking
    try {
      this.rearStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: this.worldFacingMode },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      this.rearStatus = 'active';
      this.ensureHiddenVideo('rear', this.rearStream);
    } catch {
      // Fallback to default unconstrained camera (e.g. desktop webcam)
      try {
        this.rearStream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false,
        });
        this.rearStatus = 'active';
        this.ensureHiddenVideo('rear', this.rearStream);
      } catch {
        this.rearStatus = 'simulated';
      }
    }

    // 2. Secondary camera for eye-gaze tracking (when world camera is environment)
    if (this.worldFacingMode === 'environment') {
      try {
        this.frontStream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'user' },
            width: { ideal: 320 },
            height: { ideal: 240 },
          },
          audio: false,
        });
        this.frontStatus = 'active';
        this.ensureHiddenVideo('front', this.frontStream);
      } catch {
        // Mobile browsers often restrict simultaneous rear+front streams;
        // fall back cleanly to eye-assisted simulation when rear camera holds hardware lock.
        this.frontStatus = 'simulated';
      }
    } else {
      this.frontStatus = 'simulated';
    }

    return { rear: this.rearStatus, front: this.frontStatus };
  }

  stopCameras(): void {
    this.rearStream?.getTracks().forEach((t) => t.stop());
    this.frontStream?.getTracks().forEach((t) => t.stop());
    this.rearStream = null;
    this.frontStream = null;
    if (this.rearVideo) this.rearVideo.srcObject = null;
    if (this.frontVideo) this.frontVideo.srcObject = null;
    if (this.passthroughVideo) this.passthroughVideo.srcObject = null;
    this.rearStatus = 'standby';
    this.frontStatus = 'standby';
    this.hasHandFrame = false;
    this.hasEyeFrame = false;
    this.liveLandmarks = null;
  }

  private ensureHiddenVideo(kind: 'rear' | 'front', stream: MediaStream): void {
    const existing = kind === 'rear' ? this.rearVideo : this.frontVideo;
    const video = existing ?? document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.srcObject = stream;
    void video.play().catch(() => {});
    if (kind === 'rear') {
      this.rearVideo = video;
      if (this.passthroughVideo) {
        this.passthroughVideo.srcObject = stream;
        void this.passthroughVideo.play().catch(() => {});
      }
    } else {
      this.frontVideo = video;
    }
  }

  private async ensureVisionModels(): Promise<void> {
    if (this.modelsLoading || (this.handLandmarker && this.faceLandmarker)) {
      return;
    }
    this.modelsLoading = true;
    // Prevent Emscripten's C++ stderr "INFO: Created TensorFlow Lite XNNPACK delegate for CPU."
    // from being logged via console.error as a false-positive application error.
    this.installMediaPipeLogFilter();
    try {
      const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_ROOT);
      const [hand, face] = await Promise.all([
        HandLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: HAND_MODEL_URL },
          runningMode: 'VIDEO',
          numHands: 1,
          minHandDetectionConfidence: 0.45,
          minHandPresenceConfidence: 0.45,
          minTrackingConfidence: 0.45,
        }),
        FaceLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: FACE_MODEL_URL },
          runningMode: 'VIDEO',
          numFaces: 1,
          outputFaceBlendshapes: true,
        }),
      ]);
      this.handLandmarker = hand;
      this.faceLandmarker = face;
    } catch {
      // Gracefully operate with pointer/simulator or remote phone tracking
    } finally {
      this.modelsLoading = false;
    }
  }

  /**
   * Per-frame fusion of Rear Hand Cam + Front Eye Cam + Remote Phone + Pointer fallback.
   */
  update(nowMs: number, dt: number, settings: TrackingSettings): HandCursorState {
    // 1. Sample Rear Camera HandLandmarker (strictly monotonic integer timestamp & non-zero video size)
    if (
      this.rearStatus === 'active' &&
      this.rearVideo &&
      this.rearVideo.readyState >= 2 &&
      this.rearVideo.videoWidth > 0 &&
      this.rearVideo.videoHeight > 0 &&
      this.handLandmarker &&
      this.rearVideo.currentTime !== this.lastRearVideoTime
    ) {
      this.lastRearVideoTime = this.rearVideo.currentTime;
      const handTs = Math.max(this.lastHandTimestampMs + 1, Math.round(nowMs));
      this.lastHandTimestampMs = handTs;
      try {
        const res = this.handLandmarker.detectForVideo(this.rearVideo, handTs);
        const landmarks = res.landmarks?.[0];
        if (landmarks && landmarks.length >= 21) {
          const thumbTip = landmarks[4];
          const indexTip = landmarks[8];
          const sanitizedLandmarks: HandLandmarkPoint[] = landmarks.map((p) => ({
            x: Number.isFinite(p.x) ? p.x : 0.5,
            y: Number.isFinite(p.y) ? p.y : 0.5,
            z: Number.isFinite(p.z) ? p.z : 0,
          }));
          const palmMeasure = computePalmCenterAndScale(sanitizedLandmarks);
          if (
            palmMeasure &&
            Number.isFinite(thumbTip?.x) &&
            Number.isFinite(indexTip?.x)
          ) {
            this.rawHandNdc = applyHandCalibrationToNdc(
              palmMeasure.x,
              palmMeasure.y,
              this.worldFacingMode === 'user',
              this.calibration,
            );
            this.pinchDistance = computeLandmarkDistance(thumbTip, indexTip);
            this.liveLandmarks = sanitizedLandmarks;
            this.hasHandFrame = true;
          }
        } else {
          this.hasHandFrame = false;
          this.liveLandmarks = null;
        }
      } catch {
        this.hasHandFrame = false;
        this.liveLandmarks = null;
      }
    }

    // 2. Sample Front Camera FaceLandmarker for Eye Gaze
    if (
      this.frontStatus === 'active' &&
      this.frontVideo &&
      this.frontVideo.readyState >= 2 &&
      this.frontVideo.videoWidth > 0 &&
      this.frontVideo.videoHeight > 0 &&
      this.faceLandmarker &&
      this.frontVideo.currentTime !== this.lastFrontVideoTime
    ) {
      this.lastFrontVideoTime = this.frontVideo.currentTime;
      const faceTs = Math.max(this.lastFaceTimestampMs + 1, Math.round(nowMs));
      this.lastFaceTimestampMs = faceTs;
      try {
        const res = this.faceLandmarker.detectForVideo(this.frontVideo, faceTs);
        const shapes = res.faceBlendshapes?.[0]?.categories;
        if (shapes && shapes.length > 0) {
          const getScore = (name: string) =>
            shapes.find((s) => s.categoryName === name)?.score ?? 0;
          const lookLeft =
            (getScore('eyeLookOutLeft') + getScore('eyeLookInRight')) * 0.5;
          const lookRight =
            (getScore('eyeLookInLeft') + getScore('eyeLookOutRight')) * 0.5;
          const lookUp =
            (getScore('eyeLookUpLeft') + getScore('eyeLookUpRight')) * 0.5;
          const lookDown =
            (getScore('eyeLookDownLeft') + getScore('eyeLookDownRight')) * 0.5;

          this.rawEyeNdc = {
            x: Math.max(-1, Math.min(1, (lookRight - lookLeft) * 1.8)),
            y: Math.max(-1, Math.min(1, (lookUp - lookDown) * 1.8)),
          };
          this.hasEyeFrame = true;
        } else {
          this.hasEyeFrame = false;
        }
      } catch {
        this.hasEyeFrame = false;
      }
    }

    // 3. Determine active source priority: Remote Wi-Fi Direct Phone > Rear Hand Cam > Pointer/Simulator
    let targetNdc: Vec2;
    let effectivePinchDist = 0.16;
    let source: HandCursorState['source'] = 'pointer';
    let gazeX = this.rawEyeNdc.x;
    let gazeY = this.rawEyeNdc.y;
    let gazeActive = this.hasEyeFrame;

    if (this.remotePacket && nowMs <= this.remotePacket.expiresAt) {
      source = 'remote-phone';
      targetNdc = { x: this.remotePacket.hx, y: this.remotePacket.hy };
      effectivePinchDist = this.remotePacket.pinch ? 0.02 : 0.16;
      gazeX = this.remotePacket.gx;
      gazeY = this.remotePacket.gy;
      gazeActive = true;
    } else if (this.hasHandFrame) {
      source = 'rear-cam';
      targetNdc = this.rawHandNdc;
      effectivePinchDist = this.pinchDistance;
    } else {
      source = 'pointer';
      targetNdc = this.pointerFallbackNdc;
      effectivePinchDist = this.pointerDown ? 0.02 : 0.16;
      if (this.frontStatus === 'simulated') {
        // Gentle gaze preview follows cursor with slight lead when front cam is simulated
        gazeX = targetNdc.x * 0.85;
        gazeY = targetNdc.y * 0.85;
        gazeActive = settings.eyeGazeAssist;
      }
    }

    const fusedTarget = fuseHandAndEyeCursor(
      targetNdc,
      { x: gazeX, y: gazeY },
      gazeActive,
      settings.eyeGazeAssist,
      settings.gazeWeight,
    );

    this.smoothNdc =
      source === 'pointer'
        ? { x: fusedTarget.x, y: fusedTarget.y }
        : smoothCursorNdc(
            this.smoothNdc,
            fusedTarget,
            settings.smoothing,
            dt,
          );

    this.pinchState = evaluatePinchState(this.pinchState, effectivePinchDist, {
      engageThreshold: settings.pinchThreshold,
    });

    const activeLandmarks =
      this.hasHandFrame && this.liveLandmarks
        ? this.liveLandmarks
        : generateSimulatedHandLandmarks(
            this.smoothNdc.x,
            this.smoothNdc.y,
            this.pinchState.isPinching,
            this.simulatedGestureOverride,
          );

    const gesture = classifyHandGesture(
      activeLandmarks,
      this.pinchState.isPinching,
    );

    this.cursorState = {
      x: this.smoothNdc.x,
      y: this.smoothNdc.y,
      pinchDistance: effectivePinchDist,
      isPinching: this.pinchState.isPinching,
      phase: this.pinchState.lastPhase,
      gazeX,
      gazeY,
      gazeActive,
      source,
      confidence: source === 'rear-cam' || source === 'remote-phone' ? 0.94 : 1,
      landmarks: activeLandmarks,
      gesture,
    };

    return this.cursorState;
  }

  getState(): HandCursorState {
    return this.cursorState;
  }

  dispose(): void {
    this.stopCameras();
    this.handLandmarker?.close();
    this.faceLandmarker?.close();
    this.handLandmarker = null;
    this.faceLandmarker = null;
    this.restoreMediaPipeLogFilter();
  }
}
