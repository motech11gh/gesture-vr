import * as THREE from 'three';
import * as xb from 'xrblocks';
import { CURATED_YOUTUBE_360 } from './core/youtubeParser';
import { SpatialEnvironment } from './scene/SpatialEnvironment';
import { DualCameraTracker } from './systems/DualCameraTracker';
import { DualPhoneLink } from './systems/DualPhoneLink';
import { HapticEngine } from './systems/HapticEngine';
import { HeadTracker } from './systems/HeadTracker';
import {
  detectSoftwareWebGL,
  PhoneVRStereoRenderer,
} from './systems/PhoneVRStereoRenderer';
import { CompanionHud } from './ui/CompanionHud';
import { FloatingWorkspace } from './ui/FloatingWorkspace';
import type {
  DualPhoneRole,
  EnvironmentPreset,
  FloatingAppId,
  HandCalibrationProfile,
  HandGestureId,
  HeadOrientationEuler,
  TrackingSettings,
  UIStyleMode,
  WorkspaceTask,
  YouTubeVideoItem,
} from './types';

/**
 * AeroHandXRApp — Root XR Blocks Script orchestrating:
 * - Real-world live camera background passthrough behind transparent 3D & 2D Liquid Glass UI
 * - iOS 27 Liquid Glass & Samsung One UI Glass live skin switcher + transparency tuning
 * - Floating Hand Gesture Tracking Box displaying the cropped camera ROI tracking your hand
 * - Full-hand spatial mouse navigation & thumb-index pinch-click with haptic feedback
 * - Dual-camera Rear (World + Hand + Optical Flow) & Front (Eye Gaze) sensor fusion
 * - Phone VR Split-Screen Stereoscopic mode + IMU/Camera Head-Tracking
 * - Dual-Phone Wi-Fi Direct P2P WebRTC / Instant Link (Phone A Display <-> Phone B Detector)
 * - Floating grabbable 3D apps & YouTube 360° Immersive Theater
 */
class AeroHandXRApp extends xb.Script {
  private environment = new SpatialEnvironment();
  private haptics = new HapticEngine();
  private headTracker = new HeadTracker();
  private dualCameras = new DualCameraTracker();
  private dualPhoneLink = new DualPhoneLink();
  private vrStereo = new PhoneVRStereoRenderer();
  private workspace!: FloatingWorkspace;
  private hud!: CompanionHud;

  private settings: TrackingSettings = {
    pinchThreshold: 0.075,
    smoothing: 0.45,
    eyeGazeAssist: true,
    gazeWeight: 0.22,
    hapticIntensity: 0.85,
    audioHaptics: true,
    vrStereoEnabled: false,
    ipdMm: 64,
    headTrackingEnabled: false,
    cameraOpticalFlowEnabled: true,
    uiStyle: 'ios27',
    cameraPassthrough: true,
    glassOpacity: 0.34,
    handBoxVisible: true,
  };

  private tasks: WorkspaceTask[] = [
    { id: 't1', label: 'Calibrate pinch click', done: false },
    { id: 't2', label: 'Test Phone VR Stereo', done: false },
    { id: 't3', label: 'Launch YouTube 360°', done: false },
  ];

  private remoteOrientation: HeadOrientationEuler | null = null;
  private remoteOrientationExpiresAt = 0;
  private lastHudSyncMs = 0;
  private lastDetectorSendMs = 0;
  private syntheticPinchActive = false;
  private autoCameraAttempted = false;
  private pointerOverHud = false;
  private pinchRaycaster = new THREE.Raycaster();
  private pinchNdcScratch = new THREE.Vector2();

  private isEventOverHud(e: PointerEvent): boolean {
    const target = e.target as HTMLElement | null;
    if (!target) return false;
    return Boolean(
      target.closest(
        '.ah-os-topbar, .ah-dock-wrap, .ah-hand-box, .ah-drawer, #XRButtonWrapper',
      ),
    );
  }

  private readonly handleWindowPointerMove = (e: PointerEvent) => {
    if (window.innerWidth <= 0 || window.innerHeight <= 0) return;
    this.pointerOverHud = this.isEventOverHud(e);
    if ((e.target as HTMLElement | null)?.closest('.ah-calib-canvas')) return;
    const ndcX = (e.clientX / window.innerWidth) * 2 - 1;
    const ndcY = -(e.clientY / window.innerHeight) * 2 + 1;
    this.dualCameras.updatePointerFallback(ndcX, ndcY);
  };

  private readonly handleWindowPointerDown = (e: PointerEvent) => {
    if (window.innerWidth <= 0 || window.innerHeight <= 0) return;
    this.pointerOverHud = this.isEventOverHud(e);
    const ndcX = (e.clientX / window.innerWidth) * 2 - 1;
    const ndcY = -(e.clientY / window.innerHeight) * 2 + 1;
    this.dualCameras.updatePointerFallback(ndcX, ndcY, !this.pointerOverHud);
  };

  private readonly handleWindowPointerUp = (e: PointerEvent) => {
    if (window.innerWidth <= 0 || window.innerHeight <= 0) return;
    this.pointerOverHud = this.isEventOverHud(e);
    const ndcX = (e.clientX / window.innerWidth) * 2 - 1;
    const ndcY = -(e.clientY / window.innerHeight) * 2 + 1;
    this.dualCameras.updatePointerFallback(ndcX, ndcY, false);
  };

  private readonly handleWindowKeyDown = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    if (e.key === 'h' || e.key === 'H') {
      this.hud.toggleDock();
    } else if (e.key === 'r' || e.key === 'R') {
      this.recenterHead();
    } else if (e.key === 'v' || e.key === 'V') {
      this.toggleVRStereo();
    } else if (e.key === 'c' || e.key === 'C') {
      this.togglePassthrough();
    }
  };

  init(): void {
    // Wire 3D environment & floating spatial workspace
    this.add(this.environment);

    this.workspace = new FloatingWorkspace({
      onToggleApp: (appId) => this.toggleFloatingApp(appId),
      onSelectYouTubeVideo: (item) => this.selectYouTubeVideo(item),
      onOpenYouTubeTheater: () => this.hud.openDrawer('youtube'),
      onToggleDome360: () => this.cycleNext360Dome(),
      onRotateDome: (deg) => this.environment.setDomeRotationDegrees(deg),
      onStartDualCameras: () => void this.startDualCameras(),
      onToggleEyeGazeAssist: () => this.toggleEyeGazeAssist(),
      onSetPinchThreshold: (val) => {
        this.settings.pinchThreshold = val;
      },
      onSetHapticIntensity: (val) => {
        this.settings.hapticIntensity = val;
        this.haptics.setIntensity(val);
      },
      onTestHaptic: () => this.haptics.trigger('pinch-click'),
      onToggleVRStereo: () => this.toggleVRStereo(),
      onRecenterHead: () => this.recenterHead(),
      onOpenDualPhoneDrawer: () => this.hud.openDrawer('dualPhone'),
      onStartInstantDemoLink: () => this.startLocalInstantLink(true),
      onCycleEnvironment: (preset) => this.setEnvironment(preset),
      onToggleTask: (taskId) => this.toggleTask(taskId),
      onTriggerHaptic: (kind) => this.haptics.trigger(kind),
    });
    this.add(this.workspace);

    // Wire 2D Companion HUD (Real-World Camera Layer + iOS 27 / One UI Glass + Hand Gesture Box)
    this.hud = new CompanionHud({
      onToggleFloatingApp: (appId) => this.toggleFloatingApp(appId),
      onToggleVRStereo: () => this.toggleVRStereo(),
      onSetIpdMm: (mm) => {
        this.settings.ipdMm = mm;
        this.vrStereo.setIpdMm(mm);
      },
      onToggleHeadTracking: () => void this.toggleHeadTracking(),
      onToggleOpticalFlow: () => this.toggleOpticalFlow(),
      onRecenterHead: () => this.recenterHead(),
      onStartDualCameras: () => this.startDualCameras(),
      onSwitchWorldCamera: () => this.switchWorldCamera(),
      onStopDualCameras: () => this.stopDualCameras(),
      onTogglePassthrough: () => this.togglePassthrough(),
      onSetUIStyle: (style) => this.setUIStyle(style),
      onSetGlassOpacity: (opacity) => this.setGlassOpacity(opacity),
      onSelectPreviewGesture: (gesture) => this.selectPreviewGesture(gesture),
      onApplyCalibration: (profile) => this.applyHandCalibration(profile),
      onResetCalibration: () => this.resetHandCalibration(),
      onCalibrationPreviewPointer: (ndcX, ndcY) =>
        this.dualCameras.updatePointerFallback(ndcX, ndcY),
      onSelectYouTubeVideo: (item) => this.selectYouTubeVideo(item),
      onLoadCustomYouTubeId: (videoId) => this.loadCustomYouTubeId(videoId),
      onSelectEnvironment: (preset) => this.setEnvironment(preset),
      onSetDualPhoneRole: (role) => this.setDualPhoneRole(role),
      onStartLocalInstantLink: (loopback) =>
        this.startLocalInstantLink(loopback),
      onCreateOfferToken: () => this.dualPhoneLink.createOfferToken(),
      onAcceptOfferToken: (token) =>
        this.dualPhoneLink.acceptOfferAndCreateAnswer(token),
      onApplyAnswerToken: (token) => this.dualPhoneLink.applyAnswerToken(token),
      onDisconnectLink: () => this.dualPhoneLink.disconnect(),
      onDetectorPadInput: (hx, hy, pinch) => {
        this.dualPhoneLink.sendPose(
          hx,
          hy,
          pinch,
          hx * 0.85,
          hy * 0.85,
          this.headTracker.currentOrientation.yaw,
          this.headTracker.currentOrientation.pitch,
          this.headTracker.currentOrientation.roll,
        );
        if (this.dualPhoneLink.getStats().role === 'detector') {
          this.dualCameras.injectRemotePhoneInput(
            hx,
            hy,
            pinch,
            hx * 0.85,
            hy * 0.85,
          );
        }
      },
      onTriggerHaptic: (kind) => this.haptics.trigger(kind),
    });

    // Attach rear, front, and full-screen real-world passthrough video elements
    this.dualCameras.attachPreviewElements(
      this.hud.rearVideoEl,
      this.hud.frontVideoEl,
      this.hud.passthroughVideoEl,
    );

    // Connect Haptic Engine -> 3D spatial visual confirmation ripple & HUD counter
    this.haptics.onPulse((pattern) => {
      this.environment.triggerHapticRipple(pattern);
      this.hud.syncSettings(
        this.settings,
        this.headTracker.modeLabel,
        this.haptics.count,
      );
    });

    // Connect Dual-Phone Wi-Fi Direct Link -> Display Headset cursor & orientation
    this.dualPhoneLink.onPose((packet) => {
      const stats = this.dualPhoneLink.getStats();
      if (stats.role === 'display' || stats.role === 'standalone') {
        this.dualCameras.injectRemotePhoneInput(
          packet.hx,
          packet.hy,
          packet.pinch,
          packet.gx,
          packet.gy,
        );
        this.remoteOrientation = {
          yaw: packet.yaw,
          pitch: packet.pitch,
          roll: packet.roll,
        };
        this.remoteOrientationExpiresAt = performance.now() + 1200;
      }
    });

    this.dualPhoneLink.onStats((stats) => {
      this.workspace.syncDualPhoneStats(stats);
      this.hud.syncDualPhoneStats(stats);
    });

    window.addEventListener('pointermove', this.handleWindowPointerMove, {
      passive: true,
    });
    window.addEventListener('pointerdown', this.handleWindowPointerDown, {
      passive: true,
    });
    window.addEventListener('pointerup', this.handleWindowPointerUp, {
      passive: true,
    });
    window.addEventListener('keydown', this.handleWindowKeyDown);

    // Apply initial OS Liquid Glass skin & Real-World Camera Passthrough mode
    this.setUIStyle(this.settings.uiStyle);
    this.setPassthroughMode(this.settings.cameraPassthrough);
    this.hud.syncEnvironment('studio');
    this.hud.syncVRStereo(false);
    this.hud.syncDualPhoneStats(this.dualPhoneLink.getStats());
    this.hud.syncCameraStatuses(
      this.dualCameras.rearStatus,
      this.dualCameras.frontStatus,
      this.dualCameras.worldFacingMode,
    );
    this.hud.syncSettings(
      this.settings,
      this.headTracker.modeLabel,
      this.haptics.count,
    );

    document.body.dataset.state = 'ready';
    document.body.dataset.activeApp = 'youtube360';
  }

  onSelectStart(): void {
    this.haptics.trigger('pinch-click');
  }

  onXRSessionStarted(): void {
    document.body.dataset.state = 'xr-active';
    this.setPassthroughMode(this.settings.cameraPassthrough);
    this.tryAutoStartRealWorldCamera();
  }

  onSimulatorStarted(): void {
    document.body.dataset.state = 'simulator-active';
    this.setPassthroughMode(this.settings.cameraPassthrough);
    this.tryAutoStartRealWorldCamera();
  }

  /**
   * Automatically starts the live real-world camera feed when the user enters the app
   * so the background immediately shows the real world via camera (with graceful fallback
   * to the optical camera backdrop when running on a headless device without a webcam).
   */
  private tryAutoStartRealWorldCamera(): void {
    if (this.autoCameraAttempted || !this.settings.cameraPassthrough) return;
    this.autoCameraAttempted = true;
    void this.startDualCameras();
  }

  update(): void {
    const nowMs = performance.now();
    const dt = Math.min(0.05, Math.max(0.001, xb.getDeltaTime() || 0.016));

    // 1. Sample Rear Camera optical flow for head-tracking sensor fusion
    if (
      this.settings.headTrackingEnabled &&
      this.settings.cameraOpticalFlowEnabled
    ) {
      this.headTracker.sampleCameraFrame(this.dualCameras.rearVideo, nowMs);
    }

    // 2. Apply Phone VR / Remote Phone head orientation if enabled
    const activeRemoteOrient =
      this.remoteOrientation && nowMs < this.remoteOrientationExpiresAt
        ? this.remoteOrientation
        : null;
    if (
      xb.core?.camera &&
      (this.settings.headTrackingEnabled || activeRemoteOrient)
    ) {
      this.headTracker.applyToCamera(xb.core.camera, dt, activeRemoteOrient);
    }

    // 3. Fuse Rear Hand Cam + Front Eye Cam + Remote Phone + Pointer fallback
    const cursor = this.dualCameras.update(nowMs, dt, this.settings);

    // 4. If in Phone B (Camera Detector) role, stream 60Hz poses over Wi-Fi Direct link
    const linkStats = this.dualPhoneLink.getStats();
    if (
      linkStats.role === 'detector' &&
      linkStats.state === 'connected' &&
      nowMs - this.lastDetectorSendMs >= 16
    ) {
      this.lastDetectorSendMs = nowMs;
      this.dualPhoneLink.sendPose(
        cursor.x,
        cursor.y,
        cursor.isPinching,
        cursor.gazeX,
        cursor.gazeY,
        this.headTracker.currentOrientation.yaw,
        this.headTracker.currentOrientation.pitch,
        this.headTracker.currentOrientation.roll,
      );
    }

    // 5. Forward camera/remote hand pinch-clicks into 3D spatial UI
    if (cursor.source === 'rear-cam' || cursor.source === 'remote-phone') {
      this.bridgeHandPinchToCanvas(cursor.x, cursor.y, cursor.phase);
    }

    // 6. Update unified 3D Hand-Mouse Spatial Cursor (hidden cleanly over 2D HUD/drawers)
    const drawerOpen =
      document.body.dataset.drawer && document.body.dataset.drawer !== 'none';
    const show3DCursor =
      !drawerOpen && (!this.pointerOverHud || cursor.source !== 'pointer');
    this.environment.updateVisualCursor(cursor, dt, show3DCursor);

    // 7. Update floating Hand Gesture Tracking Box (cropped camera ROI + 21-point skeleton)
    this.hud.renderHandBox(
      nowMs,
      dt,
      cursor,
      this.dualCameras.rearVideo,
      this.dualCameras.rearStatus,
    );

    // 8. Animate subtle optical real-world camera fallback backdrop when webcam is standby
    this.hud.renderPassthroughSim(
      nowMs,
      cursor,
      this.settings.cameraPassthrough,
    );

    // 9. Retained spatial UI updates (throttled inside workspace)
    this.workspace.syncTrackingHud(
      nowMs,
      cursor,
      this.dualCameras.rearStatus,
      this.dualCameras.frontStatus,
      this.settings,
    );

    if (nowMs - this.lastHudSyncMs > 400) {
      this.lastHudSyncMs = nowMs;
      this.hud.syncSettings(
        this.settings,
        this.headTracker.modeLabel,
        this.haptics.count,
      );
    }
  }

  private bridgeHandPinchToCanvas(
    ndcX: number,
    ndcY: number,
    phase: 'open' | 'pinch-start' | 'pinching' | 'pinch-end',
  ): void {
    const camera = xb.core?.camera;
    if (!camera) return;

    if (phase === 'pinch-start' && !this.syntheticPinchActive) {
      this.syntheticPinchActive = true;
      this.haptics.trigger('pinch-click');
      this.pinchNdcScratch.set(ndcX, ndcY);
      this.pinchRaycaster.setFromCamera(this.pinchNdcScratch, camera);
      this.workspace.tryClickAtRay(this.pinchRaycaster);
    } else if (phase === 'pinch-end' && this.syntheticPinchActive) {
      this.syntheticPinchActive = false;
    }
  }

  private setUIStyle(style: UIStyleMode): void {
    this.settings.uiStyle = style;
    this.hud.syncUIStyle(style, this.settings.glassOpacity);
    this.workspace.applyOSTheme(style, this.settings.glassOpacity);
  }

  private setGlassOpacity(opacity: number): void {
    this.settings.glassOpacity = Math.max(0.16, Math.min(0.72, opacity));
    this.hud.syncUIStyle(this.settings.uiStyle, this.settings.glassOpacity);
    this.workspace.applyOSTheme(
      this.settings.uiStyle,
      this.settings.glassOpacity,
    );
  }

  private togglePassthrough(): void {
    this.setPassthroughMode(!this.settings.cameraPassthrough);
  }

  private setPassthroughMode(enabled: boolean): void {
    this.settings.cameraPassthrough = enabled;
    this.environment.setPassthroughMode(enabled);
    this.hud.syncPassthrough(
      enabled,
      this.dualCameras.worldFacingMode === 'user',
    );
    this.hud.syncSettings(
      this.settings,
      this.headTracker.modeLabel,
      this.haptics.count,
    );
    if (enabled && this.dualCameras.rearStatus === 'standby') {
      void this.startDualCameras();
    }
  }

  private selectPreviewGesture(gesture?: HandGestureId): void {
    this.dualCameras.setSimulatedGesture(gesture);
  }

  private applyHandCalibration(profile: HandCalibrationProfile): void {
    this.dualCameras.setCalibration(profile);
    this.settings.pinchThreshold = profile.recommendedPinchThreshold;
    this.haptics.trigger('app-launch');
    const calibrateTask = this.tasks.find((t) => t.id === 't1');
    if (calibrateTask && !calibrateTask.done) {
      this.toggleTask('t1');
    }
    this.hud.syncSettings(
      this.settings,
      this.headTracker.modeLabel,
      this.haptics.count,
    );
  }

  private resetHandCalibration(): void {
    this.dualCameras.resetCalibration();
    this.settings.pinchThreshold = 0.075;
    this.hud.syncSettings(
      this.settings,
      this.headTracker.modeLabel,
      this.haptics.count,
    );
  }

  private toggleFloatingApp(appId: FloatingAppId): void {
    const next = !this.workspace.isAppVisible(appId);
    this.workspace.setAppVisible(appId, next);
    document.body.dataset.activeApp = next ? appId : 'none';
  }

  private selectYouTubeVideo(item: YouTubeVideoItem): void {
    this.workspace.setAppVisible('youtube360', true);
    this.workspace.syncYouTubeState(item.title, item.preset);
    // Switch smoothly to 360° dome when user explicitly launches a 360° panorama experience
    if (item.preset !== 'studio') {
      this.setPassthroughMode(false);
    }
    this.environment.setEnvironmentPreset(item.preset);
    this.hud.syncEnvironment(item.preset);
    this.hud.loadYouTubeIframe(item.id, true);
    this.hud.openDrawer('youtube');
  }

  private loadCustomYouTubeId(videoId: string): void {
    this.workspace.setAppVisible('youtube360', true);
    this.workspace.syncYouTubeState(
      `Custom Video (${videoId})`,
      this.environment.getEnvironmentPreset(),
    );
    this.hud.loadYouTubeIframe(videoId, true);
  }

  private cycleNext360Dome(): void {
    const order: EnvironmentPreset[] = [
      'studio',
      'orbital360',
      'alpine360',
      'reef360',
      'tokyo360',
    ];
    const currIdx = order.indexOf(this.environment.getEnvironmentPreset());
    const next = order[(currIdx + 1) % order.length];
    this.setEnvironment(next);
  }

  private setEnvironment(preset: EnvironmentPreset): void {
    this.setPassthroughMode(false);
    this.environment.setEnvironmentPreset(preset);
    this.hud.syncEnvironment(preset);
    const matchingVideo = CURATED_YOUTUBE_360.find((v) => v.preset === preset);
    this.workspace.syncYouTubeState(
      matchingVideo ? matchingVideo.title : 'Spatial Studio',
      preset,
    );
  }

  private async startDualCameras(): Promise<void> {
    const res = await this.dualCameras.startDualCameras();
    this.hud.syncCameraStatuses(
      res.rear,
      res.front,
      this.dualCameras.worldFacingMode,
    );
    this.hud.syncSettings(
      this.settings,
      this.headTracker.modeLabel,
      this.haptics.count,
    );
  }

  private async switchWorldCamera(): Promise<void> {
    const res = await this.dualCameras.switchWorldCamera();
    this.hud.syncCameraStatuses(
      res.rear,
      res.front,
      this.dualCameras.worldFacingMode,
    );
    this.hud.syncPassthrough(
      this.settings.cameraPassthrough,
      this.dualCameras.worldFacingMode === 'user',
    );
  }

  private stopDualCameras(): void {
    this.dualCameras.stopCameras();
    this.hud.syncCameraStatuses(
      this.dualCameras.rearStatus,
      this.dualCameras.frontStatus,
      this.dualCameras.worldFacingMode,
    );
    this.hud.syncSettings(
      this.settings,
      this.headTracker.modeLabel,
      this.haptics.count,
    );
  }

  private toggleEyeGazeAssist(): void {
    this.settings.eyeGazeAssist = !this.settings.eyeGazeAssist;
  }

  private toggleVRStereo(): void {
    const next = !this.settings.vrStereoEnabled;
    this.settings.vrStereoEnabled = next;
    this.vrStereo.setIpdMm(this.settings.ipdMm);
    this.vrStereo.setEnabled(next);
    this.workspace.syncVRStereoState(next);
    this.hud.syncVRStereo(next);

    if (next && !this.settings.headTrackingEnabled) {
      void this.toggleHeadTracking(true);
    }
    this.hud.syncSettings(
      this.settings,
      this.headTracker.modeLabel,
      this.haptics.count,
    );
  }

  private async toggleHeadTracking(forceOn?: boolean): Promise<void> {
    const next =
      typeof forceOn === 'boolean'
        ? forceOn
        : !this.settings.headTrackingEnabled;
    if (next) {
      const ok = await this.headTracker.enable();
      this.settings.headTrackingEnabled = ok;
    } else {
      this.headTracker.disable();
      this.settings.headTrackingEnabled = false;
    }
    this.hud.syncSettings(
      this.settings,
      this.headTracker.modeLabel,
      this.haptics.count,
    );
  }

  private toggleOpticalFlow(): void {
    this.settings.cameraOpticalFlowEnabled =
      !this.settings.cameraOpticalFlowEnabled;
    this.headTracker.setOpticalFlowEnabled(
      this.settings.cameraOpticalFlowEnabled,
    );
    this.hud.syncSettings(
      this.settings,
      this.headTracker.modeLabel,
      this.haptics.count,
    );
  }

  private recenterHead(): void {
    this.headTracker.recenter();
    this.haptics.trigger('recenter');
  }

  private setDualPhoneRole(role: DualPhoneRole): void {
    this.dualPhoneLink.setRole(role);
  }

  private startLocalInstantLink(withLoopback: boolean): void {
    if (this.dualPhoneLink.getStats().role === 'standalone') {
      this.dualPhoneLink.setRole('display');
    }
    this.dualPhoneLink.startLocalInstantLink(withLoopback);
  }

  private toggleTask(taskId: string): void {
    this.tasks = this.tasks.map((t) =>
      t.id === taskId ? { ...t, done: !t.done } : t,
    );
    this.workspace.syncTasks(this.tasks);
    const doneCount = this.tasks.filter((t) => t.done).length;
    document.body.dataset.tasksDone = String(doneCount);
  }

  dispose(): void {
    window.removeEventListener('pointermove', this.handleWindowPointerMove);
    window.removeEventListener('pointerdown', this.handleWindowPointerDown);
    window.removeEventListener('pointerup', this.handleWindowPointerUp);
    window.removeEventListener('keydown', this.handleWindowKeyDown);
    this.vrStereo.dispose();
    this.dualPhoneLink.dispose();
    this.dualCameras.dispose();
    this.headTracker.dispose();
    this.haptics.dispose();
    this.hud.dispose();
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const isSoftwareGl = detectSoftwareWebGL();
  document.body.classList.toggle('has-gpu-glass', !isSoftwareGl);

  const params = new URLSearchParams(window.location.search);
  const autostart = params.get('autostart') === '1';

  const options = new xb.Options();
  options.antialias = !isSoftwareGl;
  options.setAppTitle('AeroHand XR');
  options.setAppDescription(
    'Transparent iOS 27 / One UI liquid-glass spatial workspace over your live real-world camera with a cropped Hand Gesture Tracker box, pinch-click haptics, Phone VR stereo, Dual-Phone Wi-Fi Direct, and YouTube 360°.',
  );
  options.enableHands();
  options.hands.visualization = true;
  options.enableGestures();
  options.reticles.enabled = false;
  options.simulator.instructions.overlayEnabled = false;
  options.xrButton.showEnterSimulatorButton = true;
  if (autostart) {
    options.xrButton.alwaysAutostartSimulator = true;
  }

  const app = new AeroHandXRApp();
  xb.add(app);
  await xb.init(options);

  const renderer = xb.core?.renderer as THREE.WebGLRenderer | undefined;
  if (renderer) {
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(
      isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2),
    );
    renderer.shadowMap.enabled = !isSoftwareGl;

    const canvasHost = renderer.domElement?.parentElement;
    if (canvasHost && canvasHost !== document.body) {
      canvasHost.classList.add('ah-xr-canvas-host');
    }
    if (renderer.domElement) {
      renderer.domElement.style.background = 'transparent';
    }
  }
});
