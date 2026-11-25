import {
  computeHandCropRect,
  HAND_SKELETON_CONNECTIONS,
  smoothHandCropRect,
} from '../core/handGestureBox';
import type {
  CameraSensorStatus,
  HandCropRect,
  HandCursorState,
  HandGestureId,
  HandLandmarkPoint,
} from '../types';

export interface HandGestureBoxCallbacks {
  onRequestLiveCamera: () => void;
  onSelectPreviewGesture: (gesture?: HandGestureId) => void;
}

const BOX_CANVAS_W = 248;
const BOX_CANVAS_H = 186;

/**
 * Floating Liquid-Glass Hand Gesture Tracking Box:
 * Shows the cropped region of the camera actively tracking the user's hand,
 * overlays the 21-point hand skeleton & thumb-index pinch bridge, and displays
 * the live recognized hand gesture & action cue.
 */
export class HandGestureBox {
  readonly element: HTMLElement;

  private callbacks: HandGestureBoxCallbacks;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private gestureTitleEl: HTMLElement;
  private gestureHintEl: HTMLElement;
  private sourceLabelEl: HTMLElement;
  private pinchFillEl: HTMLElement;
  private collapseBtn: HTMLButtonElement;
  private camQuickBtn: HTMLButtonElement;
  private bodyEl: HTMLElement;

  private collapsed = false;
  private smoothedCrop: HandCropRect | null = null;
  private lastDrawMs = 0;
  private calibrationActive = false;
  private calibrationCentered = false;
  private calibrationProgress = 0;
  private isCalibrated = false;

  constructor(callbacks: HandGestureBoxCallbacks) {
    this.callbacks = callbacks;

    this.element = document.createElement('aside');
    this.element.className = 'ah-hand-box ah-glass-surface';
    this.element.setAttribute('aria-label', 'Live Hand Gesture Camera Tracker');
    this.element.setAttribute('data-testid', 'hand-gesture-box');

    const header = document.createElement('div');
    header.className = 'ah-hand-box__header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'ah-hand-box__title-group';
    const title = document.createElement('span');
    title.className = 'ah-hand-box__title';
    title.textContent = 'Hand Tracker';
    this.sourceLabelEl = document.createElement('span');
    this.sourceLabelEl.className = 'ah-hand-box__source';
    this.sourceLabelEl.textContent = 'Camera ROI';
    titleWrap.append(title, this.sourceLabelEl);

    const headerActions = document.createElement('div');
    headerActions.className = 'ah-hand-box__actions';

    this.camQuickBtn = document.createElement('button');
    this.camQuickBtn.type = 'button';
    this.camQuickBtn.className = 'ah-mini-btn';
    this.camQuickBtn.textContent = 'Live Cam';
    this.camQuickBtn.setAttribute('aria-label', 'Activate live hand camera');
    this.camQuickBtn.addEventListener('click', () => {
      this.callbacks.onRequestLiveCamera();
    });

    this.collapseBtn = document.createElement('button');
    this.collapseBtn.type = 'button';
    this.collapseBtn.className = 'ah-mini-btn';
    this.collapseBtn.textContent = '−';
    this.collapseBtn.setAttribute('aria-label', 'Collapse hand tracking box');
    this.collapseBtn.setAttribute('aria-expanded', 'true');
    this.collapseBtn.addEventListener('click', () => this.toggleCollapsed());

    headerActions.append(this.camQuickBtn, this.collapseBtn);
    header.append(titleWrap, headerActions);

    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'ah-hand-box__body';

    const viewport = document.createElement('div');
    viewport.className = 'ah-hand-box__viewport';

    this.canvas = document.createElement('canvas');
    this.canvas.width = BOX_CANVAS_W;
    this.canvas.height = BOX_CANVAS_H;
    this.canvas.className = 'ah-hand-box__canvas';
    this.canvas.setAttribute('data-testid', 'hand-tracker-canvas');
    this.ctx = this.canvas.getContext('2d')!;
    viewport.appendChild(this.canvas);

    // Gesture readout row (clean unboxed typography with · separator)
    const readout = document.createElement('div');
    readout.className = 'ah-hand-box__readout';
    this.gestureTitleEl = document.createElement('span');
    this.gestureTitleEl.className = 'ah-hand-box__gesture-name';
    this.gestureTitleEl.textContent = 'Open Hand';

    const sep = document.createElement('span');
    sep.className = 'ah-hand-box__sep';
    sep.setAttribute('aria-hidden', 'true');
    sep.textContent = '·';

    this.gestureHintEl = document.createElement('span');
    this.gestureHintEl.className = 'ah-hand-box__gesture-hint';
    this.gestureHintEl.textContent = 'Mouse Navigate';
    readout.append(this.gestureTitleEl, sep, this.gestureHintEl);

    // Pinch proximity meter
    const meterTrack = document.createElement('div');
    meterTrack.className = 'ah-hand-box__meter';
    meterTrack.setAttribute('aria-label', 'Pinch proximity');
    this.pinchFillEl = document.createElement('div');
    this.pinchFillEl.className = 'ah-hand-box__meter-fill';
    meterTrack.appendChild(this.pinchFillEl);

    this.bodyEl.append(viewport, readout, meterTrack);
    this.element.append(header, this.bodyEl);
  }

  toggleCollapsed(): void {
    this.collapsed = !this.collapsed;
    this.element.classList.toggle('is-collapsed', this.collapsed);
    this.collapseBtn.textContent = this.collapsed ? '+' : '−';
    this.collapseBtn.setAttribute('aria-expanded', String(!this.collapsed));
    this.collapseBtn.setAttribute(
      'aria-label',
      this.collapsed
        ? 'Expand hand tracking box'
        : 'Collapse hand tracking box',
    );
  }

  setVisible(visible: boolean): void {
    this.element.style.display = visible ? '' : 'none';
  }

  setCalibrationState(
    active: boolean,
    isCentered: boolean,
    progress: number,
    calibrated: boolean,
  ): void {
    this.calibrationActive = active;
    this.calibrationCentered = isCentered;
    this.calibrationProgress = progress;
    this.isCalibrated = calibrated;
  }

  /**
   * Renders the cropped hand camera feed + 21-point hand skeleton + gesture readout.
   * Throttled to ~30 Hz for minimal CPU overhead on software WebGL and mobile GPUs.
   */
  render(
    nowMs: number,
    dt: number,
    cursor: HandCursorState,
    rearVideo: HTMLVideoElement | null,
    rearStatus: CameraSensorStatus,
  ): void {
    if (this.collapsed || this.element.style.display === 'none') return;
    if (nowMs - this.lastDrawMs < 33) return;
    this.lastDrawMs = nowMs;

    const ctx = this.ctx;
    const w = BOX_CANVAS_W;
    const h = BOX_CANVAS_H;
    const landmarks = cursor.landmarks;

    const hasLiveVideo =
      rearStatus === 'active' &&
      rearVideo !== null &&
      rearVideo.readyState >= 2 &&
      rearVideo.videoWidth > 0 &&
      rearVideo.videoHeight > 0;

    const srcW = hasLiveVideo ? rearVideo!.videoWidth : 640;
    const srcH = hasLiveVideo ? rearVideo!.videoHeight : 480;

    // Compute smooth camera ROI crop centered on the user's hand
    const targetCrop = computeHandCropRect(
      landmarks ?? [],
      srcW,
      srcH,
      0.46,
      w / h,
    );
    this.smoothedCrop = smoothHandCropRect(this.smoothedCrop, targetCrop, dt);
    const crop = this.smoothedCrop;

    ctx.clearRect(0, 0, w, h);

    if (hasLiveVideo) {
      // Draw the exact cropped part of the real camera tracking the user's hand
      ctx.save();
      ctx.drawImage(rearVideo!, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, w, h);
      // Subtle contrast vignette so skeleton landmarks stay crisp over bright rooms
      const scrim = ctx.createLinearGradient(0, 0, 0, h);
      scrim.addColorStop(0, 'rgba(6, 10, 20, 0.22)');
      scrim.addColorStop(0.5, 'rgba(6, 10, 20, 0.06)');
      scrim.addColorStop(1, 'rgba(6, 10, 20, 0.42)');
      ctx.fillStyle = scrim;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
      this.sourceLabelEl.textContent = 'Live Cam Crop';
      this.camQuickBtn.textContent = 'Active';
      this.camQuickBtn.classList.add('is-active');
    } else {
      // Optical viewfinder backdrop when hardware camera is standby/simulated
      this.drawOpticalViewfinderBg(ctx, w, h, cursor);
      this.sourceLabelEl.textContent =
        cursor.source === 'remote-phone' ? 'Phone B Cam' : 'Hand Preview';
      this.camQuickBtn.textContent = 'Live Cam';
      this.camQuickBtn.classList.remove('is-active');
    }

    // Draw anatomical hand silhouette + 21-point MediaPipe skeleton mapped into the crop box
    if (landmarks && landmarks.length >= 21) {
      this.drawHandOverlay(
        ctx,
        w,
        h,
        landmarks,
        crop,
        cursor.isPinching,
        !hasLiveVideo,
      );
    }

    // Draw crisp corner camera-tracking autofocus brackets
    this.drawTrackingBrackets(ctx, w, h, cursor.isPinching);

    if (this.calibrationActive) {
      this.drawCalibrationReticle(ctx, w, h);
    }

    if (this.isCalibrated && !this.calibrationActive) {
      this.sourceLabelEl.textContent = hasLiveVideo
        ? 'Live Crop · Calibrated'
        : 'Preview · Calibrated';
    }

    // Update semantic text & pinch meter
    this.gestureTitleEl.textContent = cursor.gesture.label;
    this.gestureHintEl.textContent = cursor.gesture.actionHint;
    this.element.classList.toggle('is-pinching', cursor.isPinching);

    const pinchCloseness = Math.max(
      0,
      Math.min(1, 1 - cursor.pinchDistance / 0.16),
    );
    this.pinchFillEl.style.width = `${Math.round(pinchCloseness * 100)}%`;

    document.body.dataset.handGesture = cursor.gesture.id;
  }

  private drawOpticalViewfinderBg(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    cursor: HandCursorState,
  ): void {
    const bg = ctx.createRadialGradient(
      w * (0.5 + cursor.x * 0.18),
      h * (0.5 - cursor.y * 0.16),
      12,
      w * 0.5,
      h * 0.5,
      w * 0.85,
    );
    bg.addColorStop(0, 'rgba(30, 46, 74, 0.72)');
    bg.addColorStop(0.55, 'rgba(13, 21, 38, 0.86)');
    bg.addColorStop(1, 'rgba(6, 10, 20, 0.94)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Fine camera sensor grid lines
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(w / 3, 0);
    ctx.lineTo(w / 3, h);
    ctx.moveTo((w * 2) / 3, 0);
    ctx.lineTo((w * 2) / 3, h);
    ctx.moveTo(0, h / 3);
    ctx.lineTo(w, h / 3);
    ctx.moveTo(0, (h * 2) / 3);
    ctx.lineTo(w, (h * 2) / 3);
    ctx.stroke();
  }

  private drawHandOverlay(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    landmarks: readonly HandLandmarkPoint[],
    crop: HandCropRect,
    isPinching: boolean,
    drawFleshSilhouette: boolean,
  ): void {
    const spanX = Math.max(0.001, crop.normMaxX - crop.normMinX);
    const spanY = Math.max(0.001, crop.normMaxY - crop.normMinY);

    const toBox = (pt: HandLandmarkPoint) => ({
      x: ((pt.x - crop.normMinX) / spanX) * w,
      y: ((pt.y - crop.normMinY) / spanY) * h,
    });

    const mapped = landmarks.map(toBox);

    // Soft translucent hand silhouette in preview mode so the user sees a tangible hand in the box
    if (drawFleshSilhouette) {
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      // Soft palm polygon
      ctx.fillStyle = isPinching
        ? 'rgba(52, 211, 153, 0.18)'
        : 'rgba(125, 211, 252, 0.16)';
      ctx.beginPath();
      const palmIds = [0, 1, 5, 9, 13, 17];
      palmIds.forEach((idx, i) => {
        const p = mapped[idx];
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
      ctx.fill();

      // Thick translucent finger strokes
      ctx.strokeStyle = isPinching
        ? 'rgba(52, 211, 153, 0.24)'
        : 'rgba(148, 210, 255, 0.22)';
      ctx.lineWidth = 13;
      for (const [a, b] of HAND_SKELETON_CONNECTIONS) {
        ctx.beginPath();
        ctx.moveTo(mapped[a].x, mapped[a].y);
        ctx.lineTo(mapped[b].x, mapped[b].y);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Crisp 21-point skeleton bones
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = isPinching
      ? 'rgba(52, 211, 153, 0.92)'
      : 'rgba(125, 211, 252, 0.88)';
    ctx.lineWidth = 2.2;
    for (const [a, b] of HAND_SKELETON_CONNECTIONS) {
      ctx.beginPath();
      ctx.moveTo(mapped[a].x, mapped[a].y);
      ctx.lineTo(mapped[b].x, mapped[b].y);
      ctx.stroke();
    }

    // Thumb tip (#4) <-> Index tip (#8) pinch bridge line
    const thumb = mapped[4];
    const index = mapped[8];
    ctx.strokeStyle = isPinching ? '#34d399' : 'rgba(255, 255, 255, 0.55)';
    ctx.lineWidth = isPinching ? 3 : 1.4;
    ctx.setLineDash(isPinching ? [] : [4, 3]);
    ctx.beginPath();
    ctx.moveTo(thumb.x, thumb.y);
    ctx.lineTo(index.x, index.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Pinch confirmation halo when pinched
    if (isPinching) {
      const mx = (thumb.x + index.x) / 2;
      const my = (thumb.y + index.y) / 2;
      ctx.strokeStyle = '#34d399';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(mx, my, 12, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Landmark nodes
    for (let i = 0; i < mapped.length; i++) {
      const p = mapped[i];
      const isPinchTip = i === 4 || i === 8;
      ctx.fillStyle = isPinchTip
        ? isPinching
          ? '#34d399'
          : '#ffffff'
        : 'rgba(241, 245, 249, 0.92)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, isPinchTip ? 4.2 : 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawTrackingBrackets(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    isPinching: boolean,
  ): void {
    const pad = 10;
    const len = 14;
    ctx.save();
    ctx.strokeStyle = isPinching
      ? 'rgba(52, 211, 153, 0.9)'
      : 'rgba(255, 255, 255, 0.45)';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';

    const corners: Array<[number, number, number, number]> = [
      [pad, pad, 1, 1],
      [w - pad, pad, -1, 1],
      [pad, h - pad, 1, -1],
      [w - pad, h - pad, -1, -1],
    ];
    for (const [cx, cy, dx, dy] of corners) {
      ctx.beginPath();
      ctx.moveTo(cx + dx * len, cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy + dy * len);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawCalibrationReticle(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
  ): void {
    const cx = w * 0.5;
    const cy = h * 0.5;
    const r = Math.min(w, h) * 0.25;
    ctx.save();
    ctx.strokeStyle = this.calibrationCentered
      ? 'rgba(48, 209, 88, 0.92)'
      : 'rgba(56, 189, 248, 0.78)';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    if (this.calibrationProgress > 0.01) {
      ctx.strokeStyle = '#30d158';
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.arc(
        cx,
        cy,
        r + 4,
        -Math.PI / 2,
        -Math.PI / 2 + Math.PI * 2 * this.calibrationProgress,
      );
      ctx.stroke();
    }
    ctx.restore();
  }
}
