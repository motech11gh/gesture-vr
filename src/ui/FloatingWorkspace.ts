import * as THREE from 'three';
import * as xb from 'xrblocks';
import { CURATED_YOUTUBE_360 } from '../core/youtubeParser';
import type {
  CameraSensorStatus,
  DualPhoneStats,
  EnvironmentPreset,
  FloatingAppId,
  HandCursorState,
  TrackingSettings,
  UIStyleMode,
  WorkspaceTask,
  YouTubeVideoItem,
} from '../types';

export interface FloatingWorkspaceActions {
  onToggleApp: (appId: FloatingAppId) => void;
  onSelectYouTubeVideo: (item: YouTubeVideoItem) => void;
  onOpenYouTubeTheater: () => void;
  onToggleDome360: () => void;
  onRotateDome: (degrees: number) => void;
  onStartDualCameras: () => void;
  onToggleEyeGazeAssist: () => void;
  onSetPinchThreshold: (val: number) => void;
  onSetHapticIntensity: (val: number) => void;
  onTestHaptic: () => void;
  onToggleVRStereo: () => void;
  onRecenterHead: () => void;
  onOpenDualPhoneDrawer: () => void;
  onStartInstantDemoLink: () => void;
  onCycleEnvironment: (preset: EnvironmentPreset) => void;
  onToggleTask: (taskId: string) => void;
  onTriggerHaptic: (kind: 'pinch-click' | 'app-launch' | 'hover') => void;
}

interface InitialCardPose {
  position: THREE.Vector3;
  rotationY: number;
  rotationX: number;
}

/**
 * Floating Spatial OS Workspace built strictly with XR Blocks `xb.UICard` components.
 * Every floating app window supports direct grab/move/scale manipulation (`manipulation: true`, `edge: true`)
 * and responds to hand-mouse pointing, pinch clicking, and XR/simulator interactions.
 */
export class FloatingWorkspace extends xb.Script {
  private actions: FloatingWorkspaceActions;
  private cards = new Map<FloatingAppId, xb.UICard>();
  private initialPoses = new Map<FloatingAppId, InitialCardPose>();
  private launcherCard!: xb.UICard;

  // Dynamic UI text/button handles (retained updates, zero tree teardown)
  private ytNowPlayingText!: xb.UIText;
  private ytDomeButton!: xb.UIButton;
  private trackingGestureText!: xb.UIText;
  private trackingCamsText!: xb.UIText;
  private trackingEyeBtn!: xb.UIButton;
  private trackingPinchLabel!: xb.UIText;
  private trackingHapticLabel!: xb.UIText;
  private dualRoleText!: xb.UIText;
  private dualMetricsText!: xb.UIText;
  private vrToggleDockBtn!: xb.UIButton;
  private taskButtons = new Map<string, xb.UIButton>();

  private lastTextSyncMs = 0;

  constructor(actions: FloatingWorkspaceActions) {
    super();
    this.actions = actions;
  }

  init(): void {
    xb.ui.theme = 'grayGlass';
    this.applyOSTheme('ios27', 0.34);

    this.buildYouTube360Card();
    this.buildTrackingCard();
    this.buildDualPhoneCard();
    this.buildWorkspaceHubCard();
    this.buildFloatingLauncherDock();
  }

  /**
   * Styles all 3D spatial `xb.UICard` surfaces to match translucent iOS 27 Liquid Glass
   * or Samsung One UI Glass over the live real-world camera passthrough background.
   */
  applyOSTheme(style: UIStyleMode, glassOpacity: number): void {
    const a = Math.max(0.16, Math.min(0.78, glassOpacity));
    const raised = Math.min(0.86, a + 0.14);

    if (style === 'oneui') {
      xb.ui.setTheme({
        borderRadius: 34,
        colors: {
          surface: `rgba(18, 25, 39, ${a.toFixed(2)})`,
          raisedSurface: `rgba(38, 52, 78, ${raised.toFixed(2)})`,
          primary: '#3e8eff',
          primaryText: '#ffffff',
          text: '#f5f8ff',
          secondaryText: 'rgba(220, 232, 255, 0.82)',
          outline: 'rgba(180, 208, 255, 0.34)',
          sliderTrack: 'rgba(180, 208, 255, 0.24)',
        },
      });
    } else {
      // iOS 27 Liquid Glass: luminous crystal frost with high-clarity specular edges
      xb.ui.setTheme({
        borderRadius: 28,
        colors: {
          surface: `rgba(26, 32, 46, ${a.toFixed(2)})`,
          raisedSurface: `rgba(255, 255, 255, ${(a * 0.42).toFixed(2)})`,
          primary: '#0a84ff',
          primaryText: '#ffffff',
          text: '#ffffff',
          secondaryText: 'rgba(235, 242, 255, 0.84)',
          outline: 'rgba(255, 255, 255, 0.36)',
          sliderTrack: 'rgba(255, 255, 255, 0.24)',
        },
      });
    }
  }

  private createCardHeader(
    icon: string,
    title: string,
    subtitle: string,
  ): xb.UIPanel {
    return new xb.UIPanel({
      style: {
        width: '100%',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
      },
      children: [
        new xb.UIIcon({
          icon,
          style: { width: 34, height: 34, color: '#38bdf8' },
        }),
        new xb.UIPanel({
          style: {
            flexGrow: 1,
            flexDirection: 'column',
            alignItems: 'flex-start',
            gap: 2,
          },
          children: [
            new xb.UIText({
              text: title,
              style: { fontSize: 24, fontWeight: 'bold', color: '#f8fafc' },
            }),
            new xb.UIText({
              text: subtitle,
              style: { fontSize: 15, opacity: 0.78 },
            }),
          ],
        }),
      ],
    });
  }

  private buildYouTube360Card(): void {
    this.ytNowPlayingText = new xb.UIText({
      text: `Now Ready: ${CURATED_YOUTUBE_360[0].title}`,
      style: {
        width: '100%',
        fontSize: 15,
        color: '#7dd3fc',
        fontWeight: 'bold',
      },
    });

    this.ytDomeButton = new xb.UIButton({
      label: '360° Dome: Studio',
      icon: '360',
      style: { flexGrow: 1 },
      onClick: () => {
        this.actions.onTriggerHaptic('app-launch');
        this.actions.onToggleDome360();
      },
    });

    const videoRows: xb.UIPanel[] = [];
    for (let i = 0; i < CURATED_YOUTUBE_360.length; i += 2) {
      const pair = CURATED_YOUTUBE_360.slice(i, i + 2);
      videoRows.push(
        new xb.UIPanel({
          style: { width: '100%', flexDirection: 'row', gap: 8 },
          children: pair.map(
            (item) =>
              new xb.UIButton({
                label: item.title.replace(' 360°', ''),
                icon: 'play_circle',
                style: { flexGrow: 1 },
                onClick: () => {
                  this.actions.onTriggerHaptic('pinch-click');
                  this.actions.onSelectYouTubeVideo(item);
                },
              }),
          ),
        }),
      );
    }

    const spinSlider = new xb.UISlider({
      ariaLabel: '360 Horizon Yaw',
      min: -180,
      max: 180,
      step: 5,
      value: 0,
      style: { width: '100%', height: 36 },
      onInput: (deg) => this.actions.onRotateDome(deg),
    });

    const card = new xb.UICard({
      size: { width: 0.66, height: 'auto' },
      manipulation: true,
      edge: true,
      style: {
        flexDirection: 'column',
        gap: 12,
        padding: 18,
      },
      children: [
        this.createCardHeader(
          'smart_display',
          'YouTube 360° Cinema',
          'Immersive 360° dome & floating stream',
        ),
        this.ytNowPlayingText,
        ...videoRows,
        new xb.UIPanel({
          style: { width: '100%', flexDirection: 'row', gap: 10 },
          children: [
            new xb.UIButton({
              label: 'Open Player',
              icon: 'play_arrow',
              style: { flexGrow: 1 },
              onClick: () => {
                this.actions.onTriggerHaptic('app-launch');
                this.actions.onOpenYouTubeTheater();
              },
            }),
            this.ytDomeButton,
          ],
        }),
        new xb.UIText({
          text: '360° Horizon Orientation',
          style: { fontSize: 15, opacity: 0.8 },
        }),
        spinSlider,
      ],
    });

    card.name = 'YouTube 360 Floating App';
    const pose: InitialCardPose = {
      position: new THREE.Vector3(0, 1.54, -1.24),
      rotationY: 0,
      rotationX: 0,
    };
    this.applyPose(card, pose);
    this.cards.set('youtube360', card);
    this.initialPoses.set('youtube360', pose);
    this.add(card);
  }

  private buildTrackingCard(): void {
    this.trackingGestureText = new xb.UIText({
      text: 'OPEN HAND — NAVIGATE',
      style: {
        width: '100%',
        fontSize: 15,
        fontWeight: 'bold',
        color: '#38bdf8',
      },
    });

    this.trackingCamsText = new xb.UIText({
      text: 'Rear Hand Cam: Standby\nFront Eye Cam: Standby',
      style: {
        width: '100%',
        fontSize: 13,
        lineHeight: 1.35,
        whiteSpace: 'pre-line',
        opacity: 0.82,
      },
    });

    this.trackingEyeBtn = new xb.UIButton({
      label: 'Eye Gaze: ON',
      icon: 'visibility',
      style: { flexGrow: 1 },
      onClick: () => {
        this.actions.onTriggerHaptic('pinch-click');
        this.actions.onToggleEyeGazeAssist();
      },
    });

    this.trackingPinchLabel = new xb.UIText({
      text: 'Pinch Click Sensitivity: 65%',
      style: { fontSize: 13, opacity: 0.8 },
    });

    const pinchSlider = new xb.UISlider({
      ariaLabel: 'Pinch sensitivity',
      min: 30,
      max: 100,
      step: 5,
      value: 65,
      style: { width: '100%', height: 34 },
      onInput: (val) => {
        this.trackingPinchLabel.text = `Pinch Click Sensitivity: ${val}%`;
        // Map 30..100 sensitivity to 0.04..0.11 normalized landmark threshold
        const threshold = 0.04 + ((val - 30) / 70) * 0.07;
        this.actions.onSetPinchThreshold(threshold);
      },
    });

    this.trackingHapticLabel = new xb.UIText({
      text: 'Haptic Feedback: 85%',
      style: { fontSize: 13, opacity: 0.8 },
    });

    const hapticSlider = new xb.UISlider({
      ariaLabel: 'Haptic intensity',
      min: 0,
      max: 100,
      step: 5,
      value: 85,
      style: { width: '100%', height: 34 },
      onInput: (val) => {
        this.trackingHapticLabel.text = `Haptic Feedback: ${val}%`;
        this.actions.onSetHapticIntensity(val / 100);
      },
    });

    const card = new xb.UICard({
      size: { width: 0.64, height: 'auto' },
      manipulation: true,
      edge: true,
      style: {
        flexDirection: 'column',
        gap: 11,
        padding: 18,
      },
      children: [
        this.createCardHeader(
          'pan_tool',
          'Hand & Eye Sensors',
          'Rear hand mouse + Front eye gaze',
        ),
        this.trackingGestureText,
        this.trackingCamsText,
        new xb.UIPanel({
          style: { width: '100%', flexDirection: 'row', gap: 8 },
          children: [
            new xb.UIButton({
              label: 'Dual Cams',
              icon: 'cameraswitch',
              style: { flexGrow: 1 },
              onClick: () => {
                this.actions.onTriggerHaptic('app-launch');
                this.actions.onStartDualCameras();
              },
            }),
            this.trackingEyeBtn,
          ],
        }),
        this.trackingPinchLabel,
        pinchSlider,
        this.trackingHapticLabel,
        hapticSlider,
        new xb.UIButton({
          label: 'Test Haptic Pulse',
          icon: 'sensors',
          style: { width: '100%' },
          onClick: () => this.actions.onTestHaptic(),
        }),
      ],
    });

    card.name = 'Hand and Eye Tracking Card';
    const pose: InitialCardPose = {
      position: new THREE.Vector3(-0.76, 1.52, -1.04),
      rotationY: 0.44,
      rotationX: 0,
    };
    this.applyPose(card, pose);
    this.cards.set('tracking', card);
    this.initialPoses.set('tracking', pose);
    this.add(card);
  }

  private buildDualPhoneCard(): void {
    this.dualRoleText = new xb.UIText({
      text: 'Role: Standalone Headset',
      style: {
        width: '100%',
        fontSize: 15,
        fontWeight: 'bold',
        color: '#a5b4fc',
      },
    });

    this.dualMetricsText = new xb.UIText({
      text: 'Link: Idle\nLatency: -- ms   Rate: 0 Hz',
      style: {
        width: '100%',
        fontSize: 13,
        lineHeight: 1.4,
        whiteSpace: 'pre-line',
        opacity: 0.82,
      },
    });

    const card = new xb.UICard({
      size: { width: 0.62, height: 'auto' },
      manipulation: true,
      edge: true,
      style: {
        flexDirection: 'column',
        gap: 12,
        padding: 18,
      },
      children: [
        this.createCardHeader(
          'devices',
          'Wi-Fi Direct Dual-Phone',
          'Phone B detector -> Phone A VR display',
        ),
        this.dualRoleText,
        this.dualMetricsText,
        new xb.UIText({
          text: 'Stream 60Hz hand-mouse & pinch packets over direct P2P WebRTC or instant local link.',
          style: { fontSize: 14, lineHeight: 1.38, opacity: 0.78 },
        }),
        new xb.UIButton({
          label: 'Instant Demo Link',
          icon: 'bolt',
          style: { width: '100%' },
          onClick: () => {
            this.actions.onTriggerHaptic('app-launch');
            this.actions.onStartInstantDemoLink();
          },
        }),
        new xb.UIButton({
          label: 'Pair Two Phones',
          icon: 'wifi_tethering',
          style: { width: '100%' },
          onClick: () => {
            this.actions.onTriggerHaptic('pinch-click');
            this.actions.onOpenDualPhoneDrawer();
          },
        }),
      ],
    });

    card.name = 'Dual Phone Wi-Fi Direct Card';
    const pose: InitialCardPose = {
      position: new THREE.Vector3(0.76, 1.52, -1.04),
      rotationY: -0.44,
      rotationX: 0,
    };
    this.applyPose(card, pose);
    this.cards.set('dualPhone', card);
    this.initialPoses.set('dualPhone', pose);
    this.add(card);
  }

  private buildWorkspaceHubCard(): void {
    const initialTasks: WorkspaceTask[] = [
      { id: 't1', label: '[ ] Calibrate pinch click', done: false },
      { id: 't2', label: '[ ] Test Phone VR Stereo', done: false },
      { id: 't3', label: '[ ] Launch YouTube 360°', done: false },
    ];

    const taskBtnList = initialTasks.map((task) => {
      const btn = new xb.UIButton({
        label: task.label,
        icon: 'check_box_outline_blank',
        style: { width: '100%' },
        onClick: () => {
          this.actions.onTriggerHaptic('pinch-click');
          this.actions.onToggleTask(task.id);
        },
      });
      this.taskButtons.set(task.id, btn);
      return btn;
    });

    const card = new xb.UICard({
      size: { width: 0.62, height: 'auto' },
      manipulation: true,
      edge: true,
      style: {
        flexDirection: 'column',
        gap: 11,
        padding: 18,
      },
      children: [
        this.createCardHeader(
          'widgets',
          'Spatial Notes & Spaces',
          'Pinch tasks or switch 3D surroundings',
        ),
        ...taskBtnList,
        new xb.UIPanel({
          style: { width: '100%', flexDirection: 'row', gap: 8 },
          children: [
            new xb.UIButton({
              label: 'Studio',
              style: { flexGrow: 1 },
              onClick: () => {
                this.actions.onTriggerHaptic('pinch-click');
                this.actions.onCycleEnvironment('studio');
              },
            }),
            new xb.UIButton({
              label: 'Orbital',
              style: { flexGrow: 1 },
              onClick: () => {
                this.actions.onTriggerHaptic('pinch-click');
                this.actions.onCycleEnvironment('orbital360');
              },
            }),
            new xb.UIButton({
              label: 'Reset Layout',
              icon: 'restart_alt',
              style: { flexGrow: 1 },
              onClick: () => {
                this.actions.onTriggerHaptic('app-launch');
                this.resetAllCardPoses();
              },
            }),
          ],
        }),
      ],
    });

    card.name = 'Spatial Workspace Hub Card';
    const pose: InitialCardPose = {
      position: new THREE.Vector3(0, 1.54, -1.36),
      rotationY: 0,
      rotationX: 0,
    };
    this.applyPose(card, pose);
    card.visible = false; // Toggled cleanly from Launcher Dock so initial arc is uncluttered
    this.cards.set('workspace', card);
    this.initialPoses.set('workspace', pose);
    this.add(card);
  }

  private buildFloatingLauncherDock(): void {
    this.vrToggleDockBtn = new xb.UIButton({
      label: 'Phone VR',
      icon: 'vrpano',
      onClick: () => {
        this.actions.onTriggerHaptic('app-launch');
        this.actions.onToggleVRStereo();
      },
    });

    this.launcherCard = new xb.UICard({
      size: { width: 1.06, height: 'auto' },
      manipulation: true,
      edge: true,
      style: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 10,
        padding: 12,
      },
      children: [
        new xb.UIButton({
          label: 'YT 360°',
          icon: 'smart_display',
          onClick: () => {
            this.actions.onTriggerHaptic('pinch-click');
            this.actions.onToggleApp('youtube360');
          },
        }),
        new xb.UIButton({
          label: 'Sensors',
          icon: 'pan_tool',
          onClick: () => {
            this.actions.onTriggerHaptic('pinch-click');
            this.actions.onToggleApp('tracking');
          },
        }),
        new xb.UIButton({
          label: 'Wi-Fi Link',
          icon: 'devices',
          onClick: () => {
            this.actions.onTriggerHaptic('pinch-click');
            this.actions.onToggleApp('dualPhone');
          },
        }),
        new xb.UIButton({
          label: 'Notes',
          icon: 'widgets',
          onClick: () => {
            this.actions.onTriggerHaptic('pinch-click');
            this.actions.onToggleApp('workspace');
          },
        }),
        this.vrToggleDockBtn,
        new xb.UIButton({
          label: 'Recenter',
          icon: 'center_focus_strong',
          onClick: () => {
            this.actions.onTriggerHaptic('app-launch');
            this.actions.onRecenterHead();
          },
        }),
      ],
    });

    this.launcherCard.name = 'Floating Spatial Launcher Dock';
    this.launcherCard.position.set(0, 0.99, -1.04);
    this.launcherCard.rotation.x = -0.2;
    this.add(this.launcherCard);
  }

  /**
   * Resolves a camera-hand or remote Wi-Fi Direct phone pinch-click directly against
   * mounted visible UIButton surfaces without dispatching synthetic PointerEvents
   * (avoiding browser setPointerCapture restrictions).
   */
  tryClickAtRay(raycaster: THREE.Raycaster): boolean {
    try {
      const roots: THREE.Object3D[] = [];
      if (this.launcherCard?.visible) roots.push(this.launcherCard);
      for (const card of this.cards.values()) {
        if (card.visible) roots.push(card);
      }
      const hits = raycaster.intersectObjects(roots, true);
      for (const hit of hits) {
        let node: THREE.Object3D | null = hit.object;
        while (node) {
          if (
            node instanceof xb.UIButton &&
            !node.disabled &&
            typeof node.onClick === 'function'
          ) {
            node.onClick();
            return true;
          }
          node = node.parent;
        }
      }
    } catch {
      // Ignore transient raycast intersection errors during UI layout updates
    }
    return false;
  }

  private applyPose(card: xb.UICard, pose: InitialCardPose): void {
    card.position.copy(pose.position);
    card.rotation.set(pose.rotationX, pose.rotationY, 0);
    card.scale.setScalar(1);
  }

  setAppVisible(appId: FloatingAppId, visible: boolean): void {
    const card = this.cards.get(appId);
    if (!card) return;
    // Keep center slot clean: YouTube 360 and Workspace Hub share the center focus slot cleanly
    if (visible && appId === 'workspace') {
      const yt = this.cards.get('youtube360');
      if (yt) yt.visible = false;
    } else if (visible && appId === 'youtube360') {
      const ws = this.cards.get('workspace');
      if (ws) ws.visible = false;
    }
    card.visible = visible;
  }

  isAppVisible(appId: FloatingAppId): boolean {
    return this.cards.get(appId)?.visible ?? false;
  }

  resetAllCardPoses(): void {
    for (const [id, pose] of this.initialPoses.entries()) {
      const card = this.cards.get(id);
      if (card) this.applyPose(card, pose);
    }
    this.launcherCard.position.set(0, 0.94, -1.16);
    this.launcherCard.rotation.set(-0.22, 0, 0);
    this.launcherCard.scale.setScalar(1);
  }

  syncYouTubeState(title: string, preset: EnvironmentPreset): void {
    if (this.ytNowPlayingText) {
      this.ytNowPlayingText.text = `Active: ${title}`;
    }
    if (this.ytDomeButton) {
      const labelMap: Record<EnvironmentPreset, string> = {
        studio: 'Studio',
        orbital360: 'Orbital 360°',
        alpine360: 'Alpine 360°',
        reef360: 'Reef 360°',
        tokyo360: 'Tokyo 360°',
      };
      this.ytDomeButton.label = `Dome: ${labelMap[preset]}`;
    }
  }

  syncTasks(tasks: WorkspaceTask[]): void {
    for (const task of tasks) {
      const btn = this.taskButtons.get(task.id);
      if (!btn) continue;
      btn.label = `${task.done ? '[x]' : '[ ]'} ${task.label.replace(/^\[[ x]\]\s*/, '')}`;
      btn.icon = task.done ? 'check_box' : 'check_box_outline_blank';
    }
  }

  syncDualPhoneStats(stats: DualPhoneStats): void {
    if (this.dualRoleText) {
      const roleLabels = {
        standalone: 'Role: Standalone Headset',
        display: 'Role: Display Headset (Phone A)',
        detector: 'Role: Camera Detector (Phone B)',
      };
      this.dualRoleText.text = roleLabels[stats.role];
    }
    if (this.dualMetricsText) {
      const rtt = stats.rttMs > 0 ? `${stats.rttMs.toFixed(1)} ms` : '-- ms';
      this.dualMetricsText.text = `Link: ${stats.state.toUpperCase()} (${stats.transport})\nLatency: ${rtt}   Stream: ${stats.packetHz} Hz`;
    }
  }

  syncVRStereoState(enabled: boolean): void {
    if (this.vrToggleDockBtn) {
      this.vrToggleDockBtn.label = enabled ? 'VR: SBS ON' : 'Phone VR';
    }
  }

  syncTrackingHud(
    nowMs: number,
    cursor: HandCursorState,
    rearStatus: CameraSensorStatus,
    frontStatus: CameraSensorStatus,
    settings: TrackingSettings,
  ): void {
    // Throttle retained text updates to <= 8 Hz for zero layout overhead
    if (nowMs - this.lastTextSyncMs < 125) return;
    this.lastTextSyncMs = nowMs;

    if (this.trackingGestureText) {
      this.trackingGestureText.text = cursor.isPinching
        ? 'PINCH DETECTED — CLICKING'
        : `OPEN HAND — NAVIGATE (${cursor.source})`;
      this.trackingGestureText.style.color = cursor.isPinching
        ? '#34d399'
        : '#38bdf8';
    }
    if (this.trackingCamsText) {
      this.trackingCamsText.text = `Rear Hand Cam: ${rearStatus}\nFront Eye Cam: ${frontStatus}`;
    }
    if (this.trackingEyeBtn) {
      this.trackingEyeBtn.label = settings.eyeGazeAssist
        ? 'Eye Gaze: ON'
        : 'Eye Gaze: OFF';
    }
  }
}
