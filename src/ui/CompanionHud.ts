import {
  computePalmCenterAndScale,
  createInitialCalibrationSession,
  DEFAULT_HAND_CALIBRATION,
  startCalibrationSession,
  stepCalibrationSession,
  type CalibrationSessionState,
} from '../core/handCalibration';
import { HAND_SKELETON_CONNECTIONS } from '../core/handGestureBox';
import {
  buildYouTubeEmbedUrl,
  CURATED_YOUTUBE_360,
  parseYouTubeVideoId,
} from '../core/youtubeParser';
import type {
  CameraSensorStatus,
  DualPhoneRole,
  DualPhoneStats,
  EnvironmentPreset,
  FloatingAppId,
  HandCalibrationProfile,
  HandCursorState,
  HandGestureId,
  TrackingSettings,
  UIStyleMode,
  YouTubeVideoItem,
} from '../types';
import { HandGestureBox } from './HandGestureBox';

export interface CompanionHudCallbacks {
  onToggleFloatingApp: (appId: FloatingAppId) => void;
  onToggleVRStereo: () => void;
  onSetIpdMm: (ipdMm: number) => void;
  onToggleHeadTracking: () => void;
  onToggleOpticalFlow: () => void;
  onRecenterHead: () => void;
  onStartDualCameras: () => Promise<void>;
  onSwitchWorldCamera: () => Promise<void>;
  onStopDualCameras: () => void;
  onTogglePassthrough: () => void;
  onSetUIStyle: (style: UIStyleMode) => void;
  onSetGlassOpacity: (opacity: number) => void;
  onSelectPreviewGesture: (gesture?: HandGestureId) => void;
  onApplyCalibration: (profile: HandCalibrationProfile) => void;
  onResetCalibration: () => void;
  onCalibrationPreviewPointer: (ndcX: number, ndcY: number) => void;
  onSelectYouTubeVideo: (item: YouTubeVideoItem) => void;
  onLoadCustomYouTubeId: (videoId: string) => void;
  onSelectEnvironment: (preset: EnvironmentPreset) => void;
  onSetDualPhoneRole: (role: DualPhoneRole) => void;
  onStartLocalInstantLink: (withLoopback: boolean) => void;
  onCreateOfferToken: () => Promise<string>;
  onAcceptOfferToken: (token: string) => Promise<string>;
  onApplyAnswerToken: (token: string) => Promise<void>;
  onDisconnectLink: () => void;
  onDetectorPadInput: (hx: number, hy: number, pinch: boolean) => void;
  onTriggerHaptic: (kind: 'pinch-click' | 'app-launch' | 'error') => void;
}

type DrawerId = 'none' | 'youtube' | 'dualPhone' | 'cameras';

/**
 * iOS 27 Liquid Glass / Samsung One UI Glass Companion HUD:
 * - Full-screen Real-World Camera Passthrough Background Layer (behind transparent WebGL canvas)
 * - Floating Hand Gesture Tracking Box showing the cropped camera region tracking your hand
 * - Translucent OS Status Bar with live clock, iOS 27 / One UI skin switcher & Camera background toggle
 * - Collapsible Liquid-Glass Bottom Dock & Slide-Over Sheets
 */
export class CompanionHud {
  private callbacks: CompanionHudCallbacks;
  private root: HTMLElement;
  private activeDrawer: DrawerId = 'none';
  private dockCollapsed = false;

  // Full-screen Real-World Camera Passthrough layer (mounted directly to body at z-index: 0)
  private passthroughLayerEl!: HTMLElement;
  private passthroughSimCanvas!: HTMLCanvasElement;
  private passthroughSimCtx!: CanvasRenderingContext2D;
  passthroughVideoEl!: HTMLVideoElement;
  private lastSimDrawMs = 0;

  // Hand Gesture Tracking Box
  private handGestureBox!: HandGestureBox;

  // Top OS Bar references
  private clockEl!: HTMLElement;
  private badgeMetaEl!: HTMLElement;
  private ios27Btn!: HTMLButtonElement;
  private oneuiBtn!: HTMLButtonElement;
  private passthroughToggleBtn!: HTMLButtonElement;
  private enableWorldCamBtn!: HTMLButtonElement;

  // Bottom Dock references
  private dockWrapEl!: HTMLElement;
  private dockToggleBtn!: HTMLButtonElement;
  private vrBtn!: HTMLButtonElement;
  private camBtn!: HTMLButtonElement;
  private ytBtn!: HTMLButtonElement;
  private linkBtn!: HTMLButtonElement;
  private vrOverlayEl!: HTMLElement;

  // Drawers
  private ytDrawerEl!: HTMLElement;
  private ytIframeEl!: HTMLIFrameElement;
  private ytInputEl!: HTMLInputElement;
  private ytErrorEl!: HTMLElement;
  private ytCatalogBtns = new Map<string, HTMLButtonElement>();
  private ytEnvBtns = new Map<EnvironmentPreset, HTMLButtonElement>();

  private linkDrawerEl!: HTMLElement;
  private roleBtns = new Map<DualPhoneRole, HTMLButtonElement>();
  private linkStatStateEl!: HTMLElement;
  private linkStatRttEl!: HTMLElement;
  private linkStatHzEl!: HTMLElement;
  private linkOfferOutEl!: HTMLTextAreaElement;
  private linkTokenInEl!: HTMLTextAreaElement;
  private linkMsgEl!: HTMLElement;
  private detectorPadEl!: HTMLElement;
  private detectorDotEl!: HTMLElement;
  private detectorPinching = false;

  private camDrawerEl!: HTMLElement;
  rearVideoEl!: HTMLVideoElement;
  frontVideoEl!: HTMLVideoElement;
  private rearMetaEl!: HTMLElement;
  private frontMetaEl!: HTMLElement;
  private ipdValueEl!: HTMLElement;
  private glassValueEl!: HTMLElement;
  private headTrackBtn!: HTMLButtonElement;
  private opticalFlowBtn!: HTMLButtonElement;
  private gesturePreviewBtns = new Map<string, HTMLButtonElement>();

  // Hand Center Calibration step elements & state
  private calibCanvas!: HTMLCanvasElement;
  private calibCtx!: CanvasRenderingContext2D;
  private calibStatusEl!: HTMLElement;
  private calibGuidanceEl!: HTMLElement;
  private calibProgressFillEl!: HTMLElement;
  private calibMetricsEl!: HTMLElement;
  private calibStartBtn!: HTMLButtonElement;
  private calibResetBtn!: HTMLButtonElement;
  private calibSession: CalibrationSessionState =
    createInitialCalibrationSession();
  private calibProfile: HandCalibrationProfile = { ...DEFAULT_HAND_CALIBRATION };
  private lastCalibDrawMs = 0;
  private lastCalibStepMs = 0;

  private currentVideoId: string = CURATED_YOUTUBE_360[0].id;
  private isLiveWorldCamera = false;
  private clockIntervalId: number | null = null;

  constructor(callbacks: CompanionHudCallbacks) {
    this.callbacks = callbacks;
    this.root = document.getElementById('root') ?? document.body;
    this.mount();
  }

  private mount(): void {
    // 0. Full-Screen Real-World Camera Passthrough Background Layer (sits behind WebGL canvas at z-index: 0)
    this.passthroughLayerEl = document.createElement('div');
    this.passthroughLayerEl.className = 'ah-passthrough-layer';
    this.passthroughLayerEl.setAttribute('aria-hidden', 'true');
    this.passthroughLayerEl.setAttribute('data-testid', 'camera-passthrough-layer');

    this.passthroughSimCanvas = document.createElement('canvas');
    this.passthroughSimCanvas.className = 'ah-passthrough-sim';
    this.passthroughSimCanvas.width = 640;
    this.passthroughSimCanvas.height = 360;
    this.passthroughSimCtx = this.passthroughSimCanvas.getContext('2d')!;

    this.passthroughVideoEl = document.createElement('video');
    this.passthroughVideoEl.className = 'ah-passthrough-video';
    this.passthroughVideoEl.muted = true;
    this.passthroughVideoEl.playsInline = true;
    this.passthroughVideoEl.autoplay = true;
    this.passthroughVideoEl.setAttribute('data-testid', 'camera-passthrough-video');

    this.passthroughLayerEl.append(
      this.passthroughSimCanvas,
      this.passthroughVideoEl,
    );
    document.body.prepend(this.passthroughLayerEl);

    // 1. iOS 27 / One UI Translucent Top Status Bar
    const topBar = document.createElement('header');
    topBar.className = 'ah-os-topbar ah-glass-surface';
    topBar.setAttribute('aria-label', 'AeroHand XR OS Status Bar');

    const left = document.createElement('div');
    left.className = 'ah-os-topbar__left';

    this.clockEl = document.createElement('span');
    this.clockEl.className = 'ah-os-clock';
    this.updateClock();
    this.clockIntervalId = window.setInterval(() => this.updateClock(), 15000);

    const brand = document.createElement('span');
    brand.className = 'ah-os-brand';
    brand.textContent = 'AeroHand XR';

    const dot = document.createElement('span');
    dot.className = 'ah-os-dot';
    dot.setAttribute('aria-hidden', 'true');
    dot.textContent = '·';

    this.badgeMetaEl = document.createElement('span');
    this.badgeMetaEl.className = 'ah-os-meta';
    this.badgeMetaEl.textContent = 'Real Camera · Head: Manual · Haptics: 0';

    left.append(this.clockEl, brand, dot, this.badgeMetaEl);

    const right = document.createElement('div');
    right.className = 'ah-os-topbar__right';

    // OS Skin Segmented Switcher (iOS 27 Liquid Glass <-> Samsung One UI Glass)
    const skinSeg = document.createElement('div');
    skinSeg.className = 'ah-os-segment';
    skinSeg.setAttribute('role', 'group');
    skinSeg.setAttribute('aria-label', 'Interface Style');

    this.ios27Btn = document.createElement('button');
    this.ios27Btn.type = 'button';
    this.ios27Btn.className = 'ah-seg-btn is-active';
    this.ios27Btn.textContent = 'iOS 27';
    this.ios27Btn.setAttribute('aria-pressed', 'true');
    this.ios27Btn.addEventListener('click', () => {
      this.callbacks.onTriggerHaptic('pinch-click');
      this.callbacks.onSetUIStyle('ios27');
    });

    this.oneuiBtn = document.createElement('button');
    this.oneuiBtn.type = 'button';
    this.oneuiBtn.className = 'ah-seg-btn';
    this.oneuiBtn.textContent = 'One UI';
    this.oneuiBtn.setAttribute('aria-pressed', 'false');
    this.oneuiBtn.addEventListener('click', () => {
      this.callbacks.onTriggerHaptic('pinch-click');
      this.callbacks.onSetUIStyle('oneui');
    });

    skinSeg.append(this.ios27Btn, this.oneuiBtn);

    // Real-World Camera Background Toggle
    this.passthroughToggleBtn = this.makeBtn(
      'Camera BG: ON',
      () => {
        this.callbacks.onTriggerHaptic('pinch-click');
        this.callbacks.onTogglePassthrough();
      },
      'is-active',
    );
    this.passthroughToggleBtn.setAttribute('aria-pressed', 'true');

    // Quick 1-click Live Real Camera Activation button
    this.enableWorldCamBtn = this.makeBtn(
      'Start Real Cam',
      () => {
        this.callbacks.onTriggerHaptic('app-launch');
        void this.callbacks.onStartDualCameras();
      },
      'is-primary',
    );

    right.append(skinSeg, this.passthroughToggleBtn, this.enableWorldCamBtn);
    topBar.append(left, right);
    this.root.appendChild(topBar);

    // 2. Floating Liquid-Glass Hand Gesture Tracking Box (Cropped Hand Camera ROI)
    this.handGestureBox = new HandGestureBox({
      onRequestLiveCamera: () => {
        this.callbacks.onTriggerHaptic('app-launch');
        void this.callbacks.onStartDualCameras();
      },
      onSelectPreviewGesture: (g) => this.callbacks.onSelectPreviewGesture(g),
    });
    this.root.appendChild(this.handGestureBox.element);

    // 3. Phone VR Split-Screen Lens Overlay
    this.vrOverlayEl = document.createElement('div');
    this.vrOverlayEl.className = 'ah-vr-overlay';
    this.vrOverlayEl.setAttribute('aria-hidden', 'true');
    this.vrOverlayEl.innerHTML = `
      <div class="ah-vr-eye-mask ah-vr-eye-mask--left"></div>
      <div class="ah-vr-eye-mask ah-vr-eye-mask--right"></div>
      <div class="ah-vr-divider"></div>
    `;
    this.root.appendChild(this.vrOverlayEl);

    // 4. Collapsible Bottom Liquid-Glass Dock
    this.dockWrapEl = document.createElement('nav');
    this.dockWrapEl.className = 'ah-dock-wrap';
    this.dockWrapEl.setAttribute('aria-label', 'Spatial workspace controls');

    this.dockToggleBtn = document.createElement('button');
    this.dockToggleBtn.type = 'button';
    this.dockToggleBtn.className = 'ah-dock-toggle ah-glass-surface';
    this.dockToggleBtn.textContent = '▾ Hide Dock (H)';
    this.dockToggleBtn.setAttribute('aria-expanded', 'true');
    this.dockToggleBtn.addEventListener('click', () => this.toggleDock());

    const dock = document.createElement('div');
    dock.className = 'ah-dock ah-glass-surface';

    this.ytBtn = this.makeBtn('YouTube 360°', () => this.toggleDrawer('youtube'));
    this.camBtn = this.makeBtn('Cameras & Glass', () =>
      this.toggleDrawer('cameras'),
    );
    this.linkBtn = this.makeBtn('Wi-Fi Direct', () =>
      this.toggleDrawer('dualPhone'),
    );
    const notesBtn = this.makeBtn('Notes', () => {
      this.callbacks.onTriggerHaptic('pinch-click');
      this.callbacks.onToggleFloatingApp('workspace');
    });

    this.vrBtn = this.makeBtn('Phone VR', () => {
      this.callbacks.onTriggerHaptic('app-launch');
      this.callbacks.onToggleVRStereo();
    });

    const recenterBtn = this.makeBtn('Recenter', () => {
      this.callbacks.onTriggerHaptic('app-launch');
      this.callbacks.onRecenterHead();
    });

    dock.append(
      this.ytBtn,
      this.camBtn,
      this.linkBtn,
      notesBtn,
      this.makeDivider(),
      this.vrBtn,
      recenterBtn,
    );

    this.dockWrapEl.append(this.dockToggleBtn, dock);
    this.root.appendChild(this.dockWrapEl);

    // 5. Build Liquid-Glass Drawers
    this.buildYouTubeDrawer();
    this.buildDualPhoneDrawer();
    this.buildCamerasDrawer();

    // Draw initial optical real-world preview frame immediately
    this.drawSimulatedCameraRoom(0, 0, 0);
  }

  private updateClock(): void {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    this.clockEl.textContent = `${hh}:${mm}`;
  }

  private buildYouTubeDrawer(): void {
    this.ytDrawerEl = document.createElement('section');
    this.ytDrawerEl.className = 'ah-drawer';
    this.ytDrawerEl.setAttribute('aria-label', 'YouTube 360 Cinema Theater');

    const header = document.createElement('div');
    header.className = 'ah-drawer__header';
    header.innerHTML = `
      <div>
        <h2 class="ah-drawer__title">YouTube 360° Immersive Theater</h2>
        <p class="ah-drawer__sub">Stream any YouTube video or switch from Real-World Camera passthrough into a 360° surround sphere.</p>
      </div>
    `;
    header.appendChild(this.makeBtn('Close', () => this.openDrawer('none')));

    const form = document.createElement('form');
    form.className = 'ah-row';
    const urlLabel = document.createElement('label');
    urlLabel.className = 'ah-field-label';
    urlLabel.htmlFor = 'ah-yt-url-input';
    urlLabel.textContent = 'YouTube URL or Video ID';
    urlLabel.style.width = '100%';
    urlLabel.style.marginBottom = '0';

    this.ytInputEl = document.createElement('input');
    this.ytInputEl.id = 'ah-yt-url-input';
    this.ytInputEl.type = 'text';
    this.ytInputEl.className = 'ah-input';
    this.ytInputEl.placeholder = 'https://youtube.com/watch?v=... or 11-char ID';

    const loadBtn = this.makeBtn('Load Video', undefined, 'is-primary');
    loadBtn.type = 'submit';

    form.append(urlLabel, this.ytInputEl, loadBtn);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const parsed = parseYouTubeVideoId(this.ytInputEl.value);
      if (!parsed) {
        this.ytErrorEl.textContent =
          'Enter a valid YouTube URL (youtube.com/watch?v=..., youtu.be/...) or 11-character Video ID.';
        this.callbacks.onTriggerHaptic('error');
        return;
      }
      this.ytErrorEl.textContent = '';
      this.callbacks.onTriggerHaptic('app-launch');
      this.callbacks.onLoadCustomYouTubeId(parsed);
    });

    this.ytErrorEl = document.createElement('p');
    this.ytErrorEl.className = 'ah-error';
    this.ytErrorEl.setAttribute('role', 'alert');

    const stage = document.createElement('div');
    stage.className = 'ah-yt-stage';
    this.ytIframeEl = document.createElement('iframe');
    this.ytIframeEl.title = 'YouTube 360 Cinema Player';
    this.ytIframeEl.allow =
      'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
    this.ytIframeEl.allowFullscreen = true;
    stage.appendChild(this.ytIframeEl);

    const grid = document.createElement('div');
    grid.className = 'ah-yt-grid';
    for (const item of CURATED_YOUTUBE_360) {
      const cardBtn = document.createElement('button');
      cardBtn.type = 'button';
      cardBtn.className = 'ah-yt-card';
      cardBtn.innerHTML = `
        <span class="ah-yt-card__title">${item.title}</span>
        <span class="ah-yt-card__meta">${item.subtitle}</span>
      `;
      cardBtn.addEventListener('click', () => {
        this.ytErrorEl.textContent = '';
        this.callbacks.onTriggerHaptic('pinch-click');
        this.callbacks.onSelectYouTubeVideo(item);
      });
      this.ytCatalogBtns.set(item.id, cardBtn);
      grid.appendChild(cardBtn);
    }

    const envRow = document.createElement('div');
    envRow.className = 'ah-row';
    const envTitle = document.createElement('span');
    envTitle.className = 'ah-field-label';
    envTitle.style.margin = '0 6px 0 0';
    envTitle.textContent = '360° Surround Dome:';
    envRow.appendChild(envTitle);

    const presets: Array<{ id: EnvironmentPreset; label: string }> = [
      { id: 'studio', label: 'Studio Loft' },
      { id: 'orbital360', label: 'Orbital 360°' },
      { id: 'alpine360', label: 'Alpine 360°' },
      { id: 'reef360', label: 'Coral Reef 360°' },
      { id: 'tokyo360', label: 'Tokyo Neon 360°' },
    ];
    for (const p of presets) {
      const btn = this.makeBtn(p.label, () => {
        this.callbacks.onTriggerHaptic('pinch-click');
        this.callbacks.onSelectEnvironment(p.id);
      });
      this.ytEnvBtns.set(p.id, btn);
      envRow.appendChild(btn);
    }

    this.ytDrawerEl.append(header, form, this.ytErrorEl, stage, grid, envRow);
    this.root.appendChild(this.ytDrawerEl);
  }

  private buildDualPhoneDrawer(): void {
    this.linkDrawerEl = document.createElement('section');
    this.linkDrawerEl.className = 'ah-drawer';
    this.linkDrawerEl.setAttribute('aria-label', 'Dual-Phone Wi-Fi Direct Link');

    const header = document.createElement('div');
    header.className = 'ah-drawer__header';
    header.innerHTML = `
      <div>
        <h2 class="ah-drawer__title">Dual-Phone Wi-Fi Direct Link</h2>
        <p class="ah-drawer__sub">Use Phone B as a dedicated camera hand/eye detector streaming 60Hz poses to Phone A VR Display.</p>
      </div>
    `;
    header.appendChild(this.makeBtn('Close', () => this.openDrawer('none')));

    const roleRow = document.createElement('div');
    roleRow.className = 'ah-row';
    const roles: Array<{ id: DualPhoneRole; label: string }> = [
      { id: 'standalone', label: 'Standalone Phone' },
      { id: 'display', label: 'Phone A: VR Display' },
      { id: 'detector', label: 'Phone B: Cam Detector' },
    ];
    for (const r of roles) {
      const btn = this.makeBtn(r.label, () => {
        this.callbacks.onTriggerHaptic('pinch-click');
        this.callbacks.onSetDualPhoneRole(r.id);
      });
      this.roleBtns.set(r.id, btn);
      roleRow.appendChild(btn);
    }

    const statsGrid = document.createElement('div');
    statsGrid.className = 'ah-stat-grid';
    statsGrid.innerHTML = `
      <div class="ah-stat-box">
        <div class="ah-stat-box__label">Link State</div>
        <div class="ah-stat-box__value" id="ah-link-state">IDLE</div>
      </div>
      <div class="ah-stat-box">
        <div class="ah-stat-box__label">RTT Latency</div>
        <div class="ah-stat-box__value" id="ah-link-rtt">-- ms</div>
      </div>
      <div class="ah-stat-box">
        <div class="ah-stat-box__label">Pose Stream</div>
        <div class="ah-stat-box__value" id="ah-link-hz">0 Hz</div>
      </div>
    `;
    this.linkStatStateEl = statsGrid.querySelector('#ah-link-state')!;
    this.linkStatRttEl = statsGrid.querySelector('#ah-link-rtt')!;
    this.linkStatHzEl = statsGrid.querySelector('#ah-link-hz')!;

    const quickRow = document.createElement('div');
    quickRow.className = 'ah-row';
    const instantDemoBtn = this.makeBtn(
      'Start 60Hz Instant Demo Link',
      () => {
        this.callbacks.onTriggerHaptic('app-launch');
        this.callbacks.onStartLocalInstantLink(true);
      },
      'is-primary',
    );
    const localTabBtn = this.makeBtn('Same-Device Tab Link', () => {
      this.callbacks.onTriggerHaptic('pinch-click');
      this.callbacks.onStartLocalInstantLink(false);
    });
    const disconnectBtn = this.makeBtn(
      'Disconnect',
      () => {
        this.callbacks.onTriggerHaptic('pinch-click');
        this.callbacks.onDisconnectLink();
      },
      'is-danger',
    );
    quickRow.append(instantDemoBtn, localTabBtn, disconnectBtn);

    this.detectorPadEl = document.createElement('div');
    this.detectorPadEl.className = 'ah-detector-pad';
    this.detectorPadEl.setAttribute(
      'aria-label',
      'Phone B Hand-Mouse and Pinch Stream Pad',
    );
    this.detectorPadEl.innerHTML = `
      <span>Phone B Detector Surface — Move pointer/hand here to steer Display cursor; press/hold to send Pinch-Click</span>
      <div class="ah-detector-dot" id="ah-detector-dot"></div>
    `;
    this.detectorDotEl = this.detectorPadEl.querySelector('#ah-detector-dot')!;
    this.wireDetectorPad();

    const p2pSection = document.createElement('div');
    p2pSection.style.display = 'flex';
    p2pSection.style.flexDirection = 'column';
    p2pSection.style.gap = '8px';

    const p2pActions = document.createElement('div');
    p2pActions.className = 'ah-row';
    const createOfferBtn = this.makeBtn(
      '1. Phone A: Create Wi-Fi Direct Offer',
      async () => {
        this.linkMsgEl.textContent = 'Generating direct P2P WebRTC offer...';
        this.linkMsgEl.className = 'ah-status-note';
        try {
          const token = await this.callbacks.onCreateOfferToken();
          this.linkOfferOutEl.value = token;
          this.linkMsgEl.textContent =
            'Offer ready. Copy this token to Phone B (Camera Detector) on the same Wi-Fi Direct hotspot.';
          this.callbacks.onTriggerHaptic('app-launch');
        } catch (err) {
          this.linkMsgEl.className = 'ah-error';
          this.linkMsgEl.textContent =
            err instanceof Error ? err.message : String(err);
        }
      },
    );

    const acceptOfferBtn = this.makeBtn(
      '2. Phone B: Accept Offer -> Answer',
      async () => {
        const input = this.linkTokenInEl.value.trim();
        if (!input) {
          this.linkMsgEl.className = 'ah-error';
          this.linkMsgEl.textContent =
            'Paste the AERO1: Offer token from Phone A first.';
          this.callbacks.onTriggerHaptic('error');
          return;
        }
        try {
          const answer = await this.callbacks.onAcceptOfferToken(input);
          this.linkOfferOutEl.value = answer;
          this.linkMsgEl.className = 'ah-status-note';
          this.linkMsgEl.textContent =
            'Answer generated. Copy this Answer token back into Phone A.';
          this.callbacks.onTriggerHaptic('app-launch');
        } catch (err) {
          this.linkMsgEl.className = 'ah-error';
          this.linkMsgEl.textContent =
            err instanceof Error ? err.message : String(err);
        }
      },
    );

    const applyAnswerBtn = this.makeBtn(
      '3. Phone A: Complete Link',
      async () => {
        const input = this.linkTokenInEl.value.trim();
        if (!input) {
          this.linkMsgEl.className = 'ah-error';
          this.linkMsgEl.textContent =
            'Paste the AERO1: Answer token from Phone B first.';
          this.callbacks.onTriggerHaptic('error');
          return;
        }
        try {
          await this.callbacks.onApplyAnswerToken(input);
          this.linkMsgEl.className = 'ah-status-note';
          this.linkMsgEl.textContent =
            'Answer applied — opening low-latency P2P DataChannel.';
          this.callbacks.onTriggerHaptic('app-launch');
        } catch (err) {
          this.linkMsgEl.className = 'ah-error';
          this.linkMsgEl.textContent =
            err instanceof Error ? err.message : String(err);
        }
      },
    );

    p2pActions.append(createOfferBtn, acceptOfferBtn, applyAnswerBtn);

    const outLabel = document.createElement('label');
    outLabel.className = 'ah-field-label';
    outLabel.htmlFor = 'ah-link-token-out';
    outLabel.textContent = 'Local Pairing Token (Copy to other phone)';
    this.linkOfferOutEl = document.createElement('textarea');
    this.linkOfferOutEl.id = 'ah-link-token-out';
    this.linkOfferOutEl.className = 'ah-textarea';
    this.linkOfferOutEl.readOnly = true;
    this.linkOfferOutEl.placeholder =
      'Generated AERO1: token will appear here...';

    const inLabel = document.createElement('label');
    inLabel.className = 'ah-field-label';
    inLabel.htmlFor = 'ah-link-token-in';
    inLabel.textContent = 'Remote Pairing Token (Paste from other phone)';
    this.linkTokenInEl = document.createElement('textarea');
    this.linkTokenInEl.id = 'ah-link-token-in';
    this.linkTokenInEl.className = 'ah-textarea';
    this.linkTokenInEl.placeholder =
      'Paste AERO1:... token from the paired phone';

    this.linkMsgEl = document.createElement('p');
    this.linkMsgEl.className = 'ah-status-note';

    p2pSection.append(
      p2pActions,
      outLabel,
      this.linkOfferOutEl,
      inLabel,
      this.linkTokenInEl,
      this.linkMsgEl,
    );

    this.linkDrawerEl.append(
      header,
      roleRow,
      statsGrid,
      quickRow,
      this.detectorPadEl,
      p2pSection,
    );
    this.root.appendChild(this.linkDrawerEl);
  }

  private buildCamerasDrawer(): void {
    this.camDrawerEl = document.createElement('section');
    this.camDrawerEl.className = 'ah-drawer';
    this.camDrawerEl.setAttribute(
      'aria-label',
      'Real-World Camera Passthrough, Hand Tracking & Glass Settings',
    );

    const header = document.createElement('div');
    header.className = 'ah-drawer__header';
    header.innerHTML = `
      <div>
        <h2 class="ah-drawer__title">Real-World Camera, Hand Tracking &amp; Glass UI</h2>
        <p class="ah-drawer__sub">Stream your rear camera as the live background, crop your hand into the tracker box, and tune glass translucency.</p>
      </div>
    `;
    header.appendChild(this.makeBtn('Close', () => this.openDrawer('none')));

    const actionRow = document.createElement('div');
    actionRow.className = 'ah-row';
    const startCamsBtn = this.makeBtn(
      'Activate Real-World + Eye Cams',
      () => {
        this.callbacks.onTriggerHaptic('app-launch');
        void this.callbacks.onStartDualCameras();
      },
      'is-primary',
    );
    const flipCamBtn = this.makeBtn('Switch Rear / Front BG', () => {
      this.callbacks.onTriggerHaptic('pinch-click');
      void this.callbacks.onSwitchWorldCamera();
    });
    const stopCamsBtn = this.makeBtn('Stop Cameras', () => {
      this.callbacks.onTriggerHaptic('pinch-click');
      this.callbacks.onStopDualCameras();
    });
    this.headTrackBtn = this.makeBtn('Head-Tracking: OFF', () => {
      this.callbacks.onTriggerHaptic('pinch-click');
      this.callbacks.onToggleHeadTracking();
    });
    this.opticalFlowBtn = this.makeBtn('Optical Flow: ON', () => {
      this.callbacks.onTriggerHaptic('pinch-click');
      this.callbacks.onToggleOpticalFlow();
    });
    actionRow.append(
      startCamsBtn,
      flipCamBtn,
      stopCamsBtn,
      this.headTrackBtn,
      this.opticalFlowBtn,
    );

    // Dedicated Hand Center Calibration Step
    const calibCard = this.buildHandCalibrationStep();

    // Liquid Glass Transparency slider
    const glassRow = document.createElement('div');
    glassRow.className = 'ah-row';
    const glassLabel = document.createElement('label');
    glassLabel.className = 'ah-field-label';
    glassLabel.htmlFor = 'ah-glass-slider';
    glassLabel.style.margin = '0';
    glassLabel.textContent = 'Glass UI Opacity:';
    const glassSlider = document.createElement('input');
    glassSlider.id = 'ah-glass-slider';
    glassSlider.type = 'range';
    glassSlider.min = '16';
    glassSlider.max = '72';
    glassSlider.step = '2';
    glassSlider.value = '34';
    glassSlider.style.flex = '1';
    this.glassValueEl = document.createElement('span');
    this.glassValueEl.className = 'ah-mono-val';
    this.glassValueEl.textContent = '34%';
    glassSlider.addEventListener('input', () => {
      const pct = Number(glassSlider.value);
      this.glassValueEl.textContent = `${pct}%`;
      this.callbacks.onSetGlassOpacity(pct / 100);
    });
    glassRow.append(glassLabel, glassSlider, this.glassValueEl);

    // Hand Gesture Preview selector (useful on desktop without webcam)
    const gestureRow = document.createElement('div');
    gestureRow.className = 'ah-row';
    const gestureLabel = document.createElement('span');
    gestureLabel.className = 'ah-field-label';
    gestureLabel.style.margin = '0 6px 0 0';
    gestureLabel.textContent = 'Hand Box Gesture:';
    gestureRow.appendChild(gestureLabel);

    const previewOptions: Array<{ key: string; label: string; id?: HandGestureId }> = [
      { key: 'auto', label: 'Auto' },
      { key: 'open-palm', label: 'Open Hand', id: 'open-palm' },
      { key: 'pinch-click', label: 'Pinch', id: 'pinch-click' },
      { key: 'point', label: 'Point', id: 'point' },
      { key: 'fist-grab', label: 'Fist', id: 'fist-grab' },
      { key: 'peace', label: 'Peace', id: 'peace' },
    ];
    for (const opt of previewOptions) {
      const btn = this.makeBtn(
        opt.label,
        () => {
          this.callbacks.onTriggerHaptic('pinch-click');
          this.callbacks.onSelectPreviewGesture(opt.id);
          for (const [k, b] of this.gesturePreviewBtns.entries()) {
            b.classList.toggle('is-active', k === opt.key);
          }
        },
        opt.key === 'auto' ? 'is-active' : undefined,
      );
      this.gesturePreviewBtns.set(opt.key, btn);
      gestureRow.appendChild(btn);
    }

    // IPD calibration slider for Phone VR Headset
    const ipdRow = document.createElement('div');
    ipdRow.className = 'ah-row';
    const ipdLabel = document.createElement('label');
    ipdLabel.className = 'ah-field-label';
    ipdLabel.htmlFor = 'ah-ipd-slider';
    ipdLabel.style.margin = '0';
    ipdLabel.textContent = 'Phone VR Lens IPD:';
    const ipdSlider = document.createElement('input');
    ipdSlider.id = 'ah-ipd-slider';
    ipdSlider.type = 'range';
    ipdSlider.min = '58';
    ipdSlider.max = '72';
    ipdSlider.step = '1';
    ipdSlider.value = '64';
    ipdSlider.style.flex = '1';
    this.ipdValueEl = document.createElement('span');
    this.ipdValueEl.className = 'ah-mono-val';
    this.ipdValueEl.textContent = '64 mm';
    ipdSlider.addEventListener('input', () => {
      const mm = Number(ipdSlider.value);
      this.ipdValueEl.textContent = `${mm} mm`;
      this.callbacks.onSetIpdMm(mm);
    });
    ipdRow.append(ipdLabel, ipdSlider, this.ipdValueEl);

    // Dual camera preview feeds
    const camRow = document.createElement('div');
    camRow.className = 'ah-cam-row';

    const rearBox = document.createElement('div');
    rearBox.className = 'ah-cam-box';
    this.rearVideoEl = document.createElement('video');
    this.rearVideoEl.className = 'ah-cam-box__video';
    this.rearVideoEl.muted = true;
    this.rearVideoEl.playsInline = true;
    this.rearVideoEl.autoplay = true;
    this.rearMetaEl = document.createElement('div');
    this.rearMetaEl.className = 'ah-cam-box__meta';
    this.rearMetaEl.innerHTML =
      '<span>Rear World + Hand Cam</span><span>Standby</span>';
    rearBox.append(this.rearVideoEl, this.rearMetaEl);

    const frontBox = document.createElement('div');
    frontBox.className = 'ah-cam-box';
    this.frontVideoEl = document.createElement('video');
    this.frontVideoEl.className = 'ah-cam-box__video';
    this.frontVideoEl.muted = true;
    this.frontVideoEl.playsInline = true;
    this.frontVideoEl.autoplay = true;
    this.frontMetaEl = document.createElement('div');
    this.frontMetaEl.className = 'ah-cam-box__meta';
    this.frontMetaEl.innerHTML =
      '<span>Front Eye Gaze Cam</span><span>Standby</span>';
    frontBox.append(this.frontVideoEl, this.frontMetaEl);

    camRow.append(rearBox, frontBox);
    this.camDrawerEl.append(
      header,
      actionRow,
      calibCard,
      glassRow,
      gestureRow,
      ipdRow,
      camRow,
    );
    this.root.appendChild(this.camDrawerEl);
  }

  private buildHandCalibrationStep(): HTMLElement {
    const card = document.createElement('div');
    card.className = 'ah-calib-card';
    card.setAttribute('data-testid', 'hand-calibration-card');

    const head = document.createElement('div');
    head.className = 'ah-calib-card__head';

    const titleBlock = document.createElement('div');
    const title = document.createElement('h3');
    title.className = 'ah-calib-card__title';
    title.textContent = 'Hand Center Calibration';
    const sub = document.createElement('p');
    sub.className = 'ah-calib-card__sub';
    sub.textContent =
      'Center your open hand inside the target box to lock neutral origin & tune pinch precision.';
    titleBlock.append(title, sub);

    this.calibStatusEl = document.createElement('span');
    this.calibStatusEl.className = 'ah-calib-status';
    this.calibStatusEl.textContent = 'Uncalibrated';
    head.append(titleBlock, this.calibStatusEl);

    const stage = document.createElement('div');
    stage.className = 'ah-calib-stage';

    this.calibCanvas = document.createElement('canvas');
    this.calibCanvas.width = 360;
    this.calibCanvas.height = 210;
    this.calibCanvas.className = 'ah-calib-canvas';
    this.calibCanvas.setAttribute('data-testid', 'hand-calibration-canvas');
    this.calibCanvas.setAttribute(
      'aria-label',
      'Hand centering calibration tracking box',
    );
    this.calibCtx = this.calibCanvas.getContext('2d')!;
    stage.appendChild(this.calibCanvas);

    // Allow desktop/touchless users to steer the simulated hand directly inside the calibration box
    this.calibCanvas.addEventListener('pointermove', (e) => {
      if (this.isLiveWorldCamera) return;
      const rect = this.calibCanvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const normX = (e.clientX - rect.left) / rect.width;
      const normY = (e.clientY - rect.top) / rect.height;
      // Map [0..1] calibration box position to NDC so center of box -> (0, 0)
      const ndcX = Math.max(-1, Math.min(1, (normX - 0.5) * 4.0));
      const ndcY = Math.max(-1, Math.min(1, -(normY - 0.5) * 4.0));
      this.callbacks.onCalibrationPreviewPointer(ndcX, ndcY);
    });

    const guideWrap = document.createElement('div');
    guideWrap.className = 'ah-calib-guide-wrap';

    this.calibGuidanceEl = document.createElement('p');
    this.calibGuidanceEl.className = 'ah-calib-guidance';
    this.calibGuidanceEl.setAttribute('role', 'status');
    this.calibGuidanceEl.setAttribute('aria-live', 'polite');
    this.calibGuidanceEl.textContent = this.calibSession.guidance;

    const progressTrack = document.createElement('div');
    progressTrack.className = 'ah-calib-progress';
    this.calibProgressFillEl = document.createElement('div');
    this.calibProgressFillEl.className = 'ah-calib-progress__fill';
    progressTrack.appendChild(this.calibProgressFillEl);

    guideWrap.append(this.calibGuidanceEl, progressTrack);

    const footer = document.createElement('div');
    footer.className = 'ah-calib-footer';

    const btnGroup = document.createElement('div');
    btnGroup.className = 'ah-row';

    this.calibStartBtn = this.makeBtn(
      'Start Calibration',
      () => this.toggleCalibrationStep(),
      'is-primary',
    );
    this.calibResetBtn = this.makeBtn('Reset', () =>
      this.resetCalibrationStep(),
    );
    this.calibResetBtn.disabled = true;
    btnGroup.append(this.calibStartBtn, this.calibResetBtn);

    this.calibMetricsEl = document.createElement('span');
    this.calibMetricsEl.className = 'ah-mono-val';
    this.calibMetricsEl.textContent = 'Default center (0.50, 0.50) · 1.35x';

    footer.append(btnGroup, this.calibMetricsEl);

    card.append(head, stage, guideWrap, footer);
    return card;
  }

  private toggleCalibrationStep(): void {
    const isRunning =
      this.calibSession.status === 'guiding' ||
      this.calibSession.status === 'holding';
    if (isRunning) {
      this.calibSession = createInitialCalibrationSession();
      this.callbacks.onTriggerHaptic('pinch-click');
    } else {
      this.calibSession = startCalibrationSession();
      this.lastCalibStepMs = performance.now();
      this.callbacks.onTriggerHaptic('app-launch');
    }
    this.syncCalibrationDom();
  }

  private resetCalibrationStep(): void {
    this.calibProfile = { ...DEFAULT_HAND_CALIBRATION };
    this.calibSession = createInitialCalibrationSession();
    this.callbacks.onResetCalibration();
    this.callbacks.onTriggerHaptic('pinch-click');
    this.syncCalibrationDom();
  }

  private syncCalibrationDom(): void {
    const { status, progress, guidance } = this.calibSession;
    const isRunning = status === 'guiding' || status === 'holding';

    this.calibGuidanceEl.textContent = guidance;
    this.calibProgressFillEl.style.width = `${Math.round(progress * 100)}%`;
    this.calibProgressFillEl.classList.toggle(
      'is-complete',
      status === 'complete' || this.calibProfile.calibrated,
    );

    if (status === 'holding') {
      this.calibStatusEl.textContent = `Hold Steady · ${Math.round(progress * 100)}%`;
      this.calibStatusEl.className = 'ah-calib-status is-holding';
    } else if (status === 'guiding') {
      this.calibStatusEl.textContent = 'Align Hand';
      this.calibStatusEl.className = 'ah-calib-status is-guiding';
    } else if (this.calibProfile.calibrated) {
      this.calibStatusEl.textContent = `Calibrated · ${this.calibProfile.precisionScore}%`;
      this.calibStatusEl.className = 'ah-calib-status is-complete';
    } else {
      this.calibStatusEl.textContent = 'Uncalibrated';
      this.calibStatusEl.className = 'ah-calib-status';
    }

    this.calibStartBtn.textContent = isRunning
      ? 'Cancel Calibration'
      : this.calibProfile.calibrated
        ? 'Recalibrate'
        : 'Start Calibration';
    this.calibResetBtn.disabled = !this.calibProfile.calibrated && !isRunning;

    if (this.calibProfile.calibrated) {
      this.calibMetricsEl.textContent = `Center (${this.calibProfile.centerX.toFixed(2)}, ${this.calibProfile.centerY.toFixed(2)}) · Reach ${this.calibProfile.reachGainX.toFixed(2)}x · Pinch ${(this.calibProfile.recommendedPinchThreshold * 100).toFixed(1)}%`;
    } else {
      this.calibMetricsEl.textContent = 'Default center (0.50, 0.50) · 1.35x';
    }

    this.handGestureBox.setCalibrationState(
      isRunning,
      this.calibSession.isCentered,
      progress,
      this.calibProfile.calibrated,
    );
    document.body.dataset.handCalibrationStatus = status;
    document.body.dataset.handCalibrated = String(this.calibProfile.calibrated);
  }

  private wireDetectorPad(): void {
    const updateFromPointer = (ev: PointerEvent, pinching: boolean) => {
      const rect = this.detectorPadEl.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const nx = Math.max(
        -1,
        Math.min(1, ((ev.clientX - rect.left) / rect.width) * 2 - 1),
      );
      const ny = Math.max(
        -1,
        Math.min(1, -(((ev.clientY - rect.top) / rect.height) * 2 - 1)),
      );
      this.detectorPinching = pinching;
      this.detectorDotEl.style.left = `${((nx + 1) / 2) * 100}%`;
      this.detectorDotEl.style.top = `${((1 - ny) / 2) * 100}%`;
      this.detectorDotEl.classList.toggle('is-pinched', pinching);
      this.callbacks.onDetectorPadInput(nx, ny, pinching);
    };

    this.detectorPadEl.addEventListener('pointerdown', (e) => {
      try {
        this.detectorPadEl.setPointerCapture(e.pointerId);
      } catch {
        // Ignore pointer capture errors from synthetic or touchless events
      }
      updateFromPointer(e, true);
    });
    this.detectorPadEl.addEventListener('pointermove', (e) => {
      updateFromPointer(e, this.detectorPinching);
    });
    this.detectorPadEl.addEventListener('pointerup', (e) => {
      updateFromPointer(e, false);
    });
    this.detectorPadEl.addEventListener('pointercancel', (e) => {
      updateFromPointer(e, false);
    });
  }

  private makeBtn(
    label: string,
    onClick?: () => void,
    extraClass?: string,
  ): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = extraClass ? `ah-btn ${extraClass}` : 'ah-btn';
    btn.textContent = label;
    if (onClick) btn.addEventListener('click', onClick);
    return btn;
  }

  private makeDivider(): HTMLElement {
    const div = document.createElement('span');
    div.className = 'ah-divider';
    div.setAttribute('aria-hidden', 'true');
    return div;
  }

  /**
   * Updates the floating Hand Gesture Tracking Box with the cropped region of the camera
   * tracking the user's hand + 21-point skeleton + gesture readout.
   */
  renderHandBox(
    nowMs: number,
    dt: number,
    cursor: HandCursorState,
    rearVideo: HTMLVideoElement | null,
    rearStatus: CameraSensorStatus,
  ): void {
    // Advance calibration session using real wall-clock delta so 1.4s hold is framerate-independent
    if (
      this.calibSession.status === 'guiding' ||
      this.calibSession.status === 'holding'
    ) {
      const calibDt =
        this.lastCalibStepMs > 0
          ? Math.min(0.25, Math.max(0.008, (nowMs - this.lastCalibStepMs) / 1000))
          : dt;
      this.lastCalibStepMs = nowMs;
      const palm = computePalmCenterAndScale(cursor.landmarks);
      const { session, completedProfile } = stepCalibrationSession(
        this.calibSession,
        palm,
        calibDt,
        1.4,
        nowMs,
      );
      this.calibSession = session;
      if (completedProfile) {
        this.calibProfile = completedProfile;
        this.callbacks.onApplyCalibration(completedProfile);
      }
      this.syncCalibrationDom();
    } else {
      this.lastCalibStepMs = nowMs;
    }

    // Draw the dedicated calibration tracking box whenever the Cameras & Glass drawer is open
    if (this.activeDrawer === 'cameras' && nowMs - this.lastCalibDrawMs >= 33) {
      this.lastCalibDrawMs = nowMs;
      this.drawCalibrationCanvas(cursor, rearVideo, rearStatus);
    }

    this.handGestureBox.render(nowMs, dt, cursor, rearVideo, rearStatus);
  }

  private drawCalibrationCanvas(
    cursor: HandCursorState,
    rearVideo: HTMLVideoElement | null,
    rearStatus: CameraSensorStatus,
  ): void {
    const ctx = this.calibCtx;
    const w = this.calibCanvas.width;
    const h = this.calibCanvas.height;

    const hasLiveVideo =
      rearStatus === 'active' &&
      rearVideo !== null &&
      rearVideo.readyState >= 2 &&
      rearVideo.videoWidth > 0 &&
      rearVideo.videoHeight > 0;

    ctx.clearRect(0, 0, w, h);

    if (hasLiveVideo) {
      ctx.save();
      ctx.drawImage(rearVideo!, 0, 0, w, h);
      ctx.fillStyle = 'rgba(6, 12, 24, 0.34)';
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    } else {
      const bg = ctx.createRadialGradient(
        w * 0.5,
        h * 0.5,
        14,
        w * 0.5,
        h * 0.5,
        w * 0.65,
      );
      bg.addColorStop(0, 'rgba(26, 42, 72, 0.85)');
      bg.addColorStop(1, 'rgba(7, 11, 22, 0.96)');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      // Calibration grid
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
      ctx.lineWidth = 1;
      for (let i = 1; i < 6; i++) {
        ctx.beginPath();
        ctx.moveTo((w * i) / 6, 0);
        ctx.lineTo((w * i) / 6, h);
        ctx.stroke();
      }
      for (let j = 1; j < 4; j++) {
        ctx.beginPath();
        ctx.moveTo(0, (h * j) / 4);
        ctx.lineTo(w, (h * j) / 4);
        ctx.stroke();
      }
    }

    const cx = w * 0.5;
    const cy = h * 0.5;
    const boxW = w * 0.34;
    const boxH = h * 0.54;
    const isRunning =
      this.calibSession.status === 'guiding' ||
      this.calibSession.status === 'holding';
    const isAligned =
      this.calibSession.isCentered || this.calibSession.status === 'complete';

    // Centered target tracking box
    ctx.save();
    ctx.strokeStyle = isAligned
      ? 'rgba(48, 209, 88, 0.95)'
      : isRunning
        ? 'rgba(56, 189, 248, 0.92)'
        : 'rgba(255, 255, 255, 0.36)';
    ctx.lineWidth = isRunning ? 2.2 : 1.5;
    ctx.setLineDash(isAligned ? [] : [6, 5]);
    ctx.strokeRect(cx - boxW / 2, cy - boxH / 2, boxW, boxH);
    ctx.setLineDash([]);

    // Center crosshair
    ctx.strokeStyle = isAligned
      ? 'rgba(48, 209, 88, 0.7)'
      : 'rgba(255, 255, 255, 0.32)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(cx - 12, cy);
    ctx.lineTo(cx + 12, cy);
    ctx.moveTo(cx, cy - 12);
    ctx.lineTo(cx, cy + 12);
    ctx.stroke();

    // Circular progress ring while holding centered
    if (this.calibSession.progress > 0.01) {
      const ringR = Math.min(boxW, boxH) * 0.44;
      ctx.strokeStyle = 'rgba(48, 209, 88, 0.25)';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeStyle = '#30d158';
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(
        cx,
        cy,
        ringR,
        -Math.PI / 2,
        -Math.PI / 2 + Math.PI * 2 * this.calibSession.progress,
      );
      ctx.stroke();
    }

    // Draw live 21-point hand skeleton & palm centroid
    const landmarks = cursor.landmarks;
    if (landmarks && landmarks.length >= 21) {
      ctx.strokeStyle = isAligned
        ? 'rgba(48, 209, 88, 0.9)'
        : 'rgba(125, 211, 252, 0.85)';
      ctx.lineWidth = 2;
      for (const [a, b] of HAND_SKELETON_CONNECTIONS) {
        const pa = landmarks[a];
        const pb = landmarks[b];
        ctx.beginPath();
        ctx.moveTo(pa.x * w, pa.y * h);
        ctx.lineTo(pb.x * w, pb.y * h);
        ctx.stroke();
      }
      for (let i = 0; i < landmarks.length; i++) {
        ctx.fillStyle = i === 4 || i === 8 ? '#ffffff' : 'rgba(226, 232, 240, 0.85)';
        ctx.beginPath();
        ctx.arc(landmarks[i].x * w, landmarks[i].y * h, i === 4 || i === 8 ? 3.5 : 2, 0, Math.PI * 2);
        ctx.fill();
      }

      const palm = computePalmCenterAndScale(landmarks);
      if (palm) {
        const px = palm.x * w;
        const py = palm.y * h;

        // Directional vector guiding hand toward center when calibrating & off-center
        if (isRunning && !isAligned) {
          ctx.strokeStyle = 'rgba(56, 189, 248, 0.88)';
          ctx.lineWidth = 2;
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(cx, cy);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        // Palm centroid marker
        ctx.fillStyle = isAligned ? '#30d158' : '#38bdf8';
        ctx.beginPath();
        ctx.arc(px, py, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /**
   * Renders a soft daylight optical camera room preview behind the transparent WebGL canvas
   * whenever Camera Passthrough is active and a hardware webcam stream is not yet live.
   */
  renderPassthroughSim(
    nowMs: number,
    cursor: HandCursorState,
    passthroughEnabled: boolean,
  ): void {
    if (!passthroughEnabled || this.isLiveWorldCamera) return;
    if (nowMs - this.lastSimDrawMs < 50) return;
    this.lastSimDrawMs = nowMs;
    this.drawSimulatedCameraRoom(nowMs * 0.001, cursor.x, cursor.y);
  }

  private drawSimulatedCameraRoom(t: number, px: number, py: number): void {
    const ctx = this.passthroughSimCtx;
    const w = this.passthroughSimCanvas.width;
    const h = this.passthroughSimCanvas.height;
    const shiftX = px * 16;
    const shiftY = -py * 10;

    // Soft daylight depth-of-field architectural room backdrop (fallback when no hardware webcam is attached)
    const baseGrad = ctx.createLinearGradient(0, 0, w, h);
    baseGrad.addColorStop(0, '#364459');
    baseGrad.addColorStop(0.35, '#4b5b72');
    baseGrad.addColorStop(0.68, '#36404f');
    baseGrad.addColorStop(1, '#1d222e');
    ctx.fillStyle = baseGrad;
    ctx.fillRect(0, 0, w, h);

    // Out-of-focus sunlit window bloom on upper-left
    const sunX = w * 0.22 - shiftX * 0.45;
    const sunY = h * 0.24 - shiftY * 0.35;
    const sunBloom = ctx.createRadialGradient(sunX, sunY, 16, sunX, sunY, 240);
    sunBloom.addColorStop(0, 'rgba(244, 248, 255, 0.54)');
    sunBloom.addColorStop(0.42, 'rgba(182, 214, 248, 0.28)');
    sunBloom.addColorStop(1, 'rgba(120, 155, 200, 0)');
    ctx.fillStyle = sunBloom;
    ctx.fillRect(0, 0, w, h);

    // Warm desk-lamp bokeh on upper-right
    const lampX = w * 0.82 - shiftX * 0.55;
    const lampY = h * 0.3 - shiftY * 0.4;
    const lampGlow = ctx.createRadialGradient(lampX, lampY, 12, lampX, lampY, 195);
    lampGlow.addColorStop(0, 'rgba(255, 214, 158, 0.46)');
    lampGlow.addColorStop(0.45, 'rgba(235, 174, 118, 0.16)');
    lampGlow.addColorStop(1, 'rgba(235, 174, 118, 0)');
    ctx.fillStyle = lampGlow;
    ctx.fillRect(0, 0, w, h);

    // Soft foreground desk horizon plane
    const deskY = h * 0.74 - shiftY * 0.7;
    const deskGrad = ctx.createLinearGradient(0, deskY - 18, 0, h);
    deskGrad.addColorStop(0, 'rgba(72, 56, 44, 0)');
    deskGrad.addColorStop(0.22, 'rgba(68, 53, 42, 0.88)');
    deskGrad.addColorStop(1, '#1c1612');
    ctx.fillStyle = deskGrad;
    ctx.fillRect(0, deskY - 18, w, h - (deskY - 18));

    // Gentle optical lens bokeh highlights
    const orbs = [
      { x: 0.31, y: 0.38, r: 54, c: 'rgba(255, 252, 240, 0.12)' },
      { x: 0.68, y: 0.46, r: 68, c: 'rgba(135, 205, 255, 0.11)' },
      { x: 0.52, y: 0.22, r: 40, c: 'rgba(255, 224, 190, 0.1)' },
    ];
    for (const o of orbs) {
      const ox = o.x * w - shiftX * 0.35 + Math.sin(t * 0.35 + o.r) * 3;
      const oy = o.y * h - shiftY * 0.35;
      const g = ctx.createRadialGradient(ox, oy, 2, ox, oy, o.r);
      g.addColorStop(0, o.c);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(ox, oy, o.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Subtle optical vignette for crisp translucent glass contrast
    const vig = ctx.createRadialGradient(
      w * 0.5,
      h * 0.48,
      w * 0.2,
      w * 0.5,
      h * 0.5,
      w * 0.74,
    );
    vig.addColorStop(0, 'rgba(8, 12, 22, 0.06)');
    vig.addColorStop(1, 'rgba(5, 9, 18, 0.54)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, w, h);
  }

  toggleDock(): void {
    this.dockCollapsed = !this.dockCollapsed;
    this.dockWrapEl.classList.toggle('is-collapsed', this.dockCollapsed);
    this.dockToggleBtn.textContent = this.dockCollapsed
      ? '▴ Show Dock (H)'
      : '▾ Hide Dock (H)';
    this.dockToggleBtn.setAttribute(
      'aria-expanded',
      String(!this.dockCollapsed),
    );
  }

  toggleDrawer(id: DrawerId): void {
    this.openDrawer(this.activeDrawer === id ? 'none' : id);
  }

  openDrawer(id: DrawerId): void {
    this.activeDrawer = id;
    this.ytDrawerEl.classList.toggle('is-open', id === 'youtube');
    this.linkDrawerEl.classList.toggle('is-open', id === 'dualPhone');
    this.camDrawerEl.classList.toggle('is-open', id === 'cameras');

    this.ytBtn.classList.toggle('is-active', id === 'youtube');
    this.linkBtn.classList.toggle('is-active', id === 'dualPhone');
    this.camBtn.classList.toggle('is-active', id === 'cameras');

    if (id === 'youtube' && !this.ytIframeEl.src) {
      this.loadYouTubeIframe(this.currentVideoId, false);
    }
    document.body.dataset.drawer = id;
  }

  loadYouTubeIframe(videoId: string, autoplay = true): void {
    this.currentVideoId = videoId;
    this.ytIframeEl.src = buildYouTubeEmbedUrl(videoId, autoplay);
    for (const [id, btn] of this.ytCatalogBtns.entries()) {
      btn.classList.toggle('is-active', id === videoId);
    }
    document.body.dataset.ytVideoId = videoId;
  }

  syncEnvironment(preset: EnvironmentPreset): void {
    for (const [id, btn] of this.ytEnvBtns.entries()) {
      btn.classList.toggle('is-active', id === preset);
    }
    document.body.dataset.envPreset = preset;
    document.body.dataset.domeActive = String(preset !== 'studio');
  }

  syncUIStyle(style: UIStyleMode, glassOpacity: number): void {
    document.body.dataset.uiStyle = style;
    document.documentElement.style.setProperty(
      '--ah-glass-alpha',
      glassOpacity.toFixed(2),
    );
    this.ios27Btn.classList.toggle('is-active', style === 'ios27');
    this.ios27Btn.setAttribute('aria-pressed', String(style === 'ios27'));
    this.oneuiBtn.classList.toggle('is-active', style === 'oneui');
    this.oneuiBtn.setAttribute('aria-pressed', String(style === 'oneui'));
    if (this.glassValueEl) {
      this.glassValueEl.textContent = `${Math.round(glassOpacity * 100)}%`;
    }
  }

  syncPassthrough(enabled: boolean, mirrorVideo = false): void {
    this.passthroughLayerEl.classList.toggle('is-hidden', !enabled);
    this.passthroughVideoEl.classList.toggle('is-mirrored', mirrorVideo);
    this.passthroughToggleBtn.classList.toggle('is-active', enabled);
    this.passthroughToggleBtn.textContent = enabled
      ? 'Camera BG: ON'
      : 'Camera BG: OFF';
    this.passthroughToggleBtn.setAttribute('aria-pressed', String(enabled));
    document.body.dataset.passthrough = String(enabled);
  }

  syncVRStereo(enabled: boolean): void {
    this.vrOverlayEl.classList.toggle('is-active', enabled);
    this.vrBtn.classList.toggle('is-active', enabled);
    this.vrBtn.textContent = enabled ? 'Exit VR' : 'Phone VR';
    this.vrBtn.setAttribute('aria-pressed', String(enabled));
    document.body.dataset.vrStereo = String(enabled);
  }

  syncSettings(
    settings: TrackingSettings,
    headModeLabel: string,
    hapticCount: number,
  ): void {
    this.headTrackBtn.textContent = settings.headTrackingEnabled
      ? 'Head-Tracking: ON'
      : 'Head-Tracking: OFF';
    this.headTrackBtn.classList.toggle(
      'is-active',
      settings.headTrackingEnabled,
    );

    this.opticalFlowBtn.textContent = settings.cameraOpticalFlowEnabled
      ? 'Optical Flow: ON'
      : 'Optical Flow: OFF';
    this.opticalFlowBtn.classList.toggle(
      'is-active',
      settings.cameraOpticalFlowEnabled,
    );

    const bgLabel = settings.cameraPassthrough
      ? this.isLiveWorldCamera
        ? 'Live World Cam'
        : 'Camera Glass'
      : '360° Dome';
    this.badgeMetaEl.textContent = `${
      settings.vrStereoEnabled ? 'VR Stereo' : bgLabel
    } · Head: ${headModeLabel} · Haptics: ${hapticCount}`;
    document.body.dataset.hapticCount = String(hapticCount);
    document.body.dataset.headMode = headModeLabel;
  }

  syncCameraStatuses(
    rear: CameraSensorStatus,
    front: CameraSensorStatus,
    worldFacingMode: 'environment' | 'user' = 'environment',
  ): void {
    this.isLiveWorldCamera = rear === 'active';
    this.passthroughVideoEl.classList.toggle('is-live', this.isLiveWorldCamera);
    this.passthroughVideoEl.classList.toggle(
      'is-mirrored',
      worldFacingMode === 'user',
    );

    if (this.isLiveWorldCamera) {
      this.enableWorldCamBtn.textContent = 'Live Cam ON';
      this.enableWorldCamBtn.classList.remove('is-primary');
      this.enableWorldCamBtn.classList.add('is-active');
    } else if (rear === 'requesting') {
      this.enableWorldCamBtn.textContent = 'Starting Cam...';
    } else {
      this.enableWorldCamBtn.textContent = 'Start Real Cam';
      this.enableWorldCamBtn.classList.add('is-primary');
      this.enableWorldCamBtn.classList.remove('is-active');
    }

    this.rearMetaEl.innerHTML = `<span>Rear World + Hand Cam</span><span>${rear}</span>`;
    this.frontMetaEl.innerHTML = `<span>Front Eye Gaze Cam</span><span>${front}</span>`;
    document.body.dataset.rearCam = rear;
    document.body.dataset.frontCam = front;
  }

  syncDualPhoneStats(stats: DualPhoneStats): void {
    for (const [role, btn] of this.roleBtns.entries()) {
      btn.classList.toggle('is-active', role === stats.role);
    }
    this.linkStatStateEl.textContent = stats.state.toUpperCase();
    this.linkStatRttEl.textContent =
      stats.rttMs > 0 ? `${stats.rttMs.toFixed(1)} ms` : '-- ms';
    this.linkStatHzEl.textContent = `${stats.packetHz} Hz`;
    if (stats.lastError) {
      this.linkMsgEl.className = 'ah-error';
      this.linkMsgEl.textContent = stats.lastError;
    }
    document.body.dataset.linkRole = stats.role;
    document.body.dataset.linkState = stats.state;
  }

  dispose(): void {
    if (this.clockIntervalId !== null) {
      window.clearInterval(this.clockIntervalId);
      this.clockIntervalId = null;
    }
    this.passthroughLayerEl?.remove();
    this.root.innerHTML = '';
  }
}
