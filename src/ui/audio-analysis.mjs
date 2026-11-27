import { editorSkinContext, editorCanvasRevision, editorCanvasOpacity } from './editor-skin-canvas.mjs';
import { AudioSourcesPanel } from './audio-sources.mjs';
import { WaveformEnvelope } from '../core/waveform.mjs';
import { t } from '../i18n.mjs';

import { analyseAudioBuffer, clamp } from "../core/audio-analysis-core.mjs";
import { analyseAudioInWorker } from "../platform/analysis-worker.mjs";
export { analyseAudioBuffer };

async function analyseAsync(buffer, options = {}) {
  try { return await analyseAudioInWorker(buffer, options); } catch { return analyseAudioBuffer(buffer, options); }
}

export class AudioAnalysis {
  constructor(canvas, getTimeline, getAudio, onChange = () => {}) {
    this.canvas = canvas;
    this.getTimeline = getTimeline;
    this.getAudio = getAudio;
    this.onChange = onChange;
    this.mode = 'waveform';
    this.enabled = false;
    this.alpha = 0.2;
    this.width = 0.62;
    this.data = null;
    this.layers = []; this.analysisCache = new WeakMap(); this.waveformCache = new WeakMap();
    this.showFullScan = true;   // 叠加全曲 DDC 预分析起音点
    this.fullScanCache = null;  // { buffer, peaks } —— 预分析完成后刷新
    this.onPeaksToNotes = null; // 由 app 注入：把全曲 peaks 写成 Tap 音符
    this.onSectionsDetected = null; // 由 app 注入：自动分段生成 markers
  }

  setBuffer(buffer) {
    if (this.sources) { this.sources.reset(buffer); return; }
    const serial = this.analysisSerial = (this.analysisSerial ?? 0) + 1;
    void analyseAsync(buffer).then(data => {
      if (serial !== this.analysisSerial) return;
      this.data = data; this.layers = data ? [{ data, color: '#5db9d4', id: 'original', buffer }] : []; this.draw();
    });
  }
  attachSources(sources, notify, onsets) {
    this.sources = sources; this.onsets = onsets; this.sourcePanel = new AudioSourcesPanel(sources, notify, onsets);
    onsets?.addEventListener('change', () => {
      // 全曲预分析完成后刷新起音点缓存（segment 走缓存不重跑模型）。
      const buffer = this.getAudio()?.buffer;
      if (buffer && typeof onsets.fullScanStatus === 'function' && onsets.fullScanStatus(buffer)?.status === 'done') {
        if (this.fullScanCache?.buffer !== buffer) {
          try { const result = onsets.segment(buffer, 0, buffer.duration); this.fullScanCache = { buffer, peaks: result?.peaks ?? [] }; }
          catch { this.fullScanCache = { buffer, peaks: [] }; }
        }
      } else this.fullScanCache = null;
      this.refreshFullScanUI?.();
      if (onsets.preview && onsets.preview !== this.previewResult) { this.previewResult = onsets.preview; this.enabled = true; if (this.enabledInput) this.enabledInput.checked = true; this.onChange(); }
      this.draw(this.lastOffsetSeconds ?? 0);
    });
    const refresh = async () => {
      if (onsets?.preview && (!sources.original || onsets.preview.sourceRevision !== sources.revision || onsets.preview.selection !== sources.selectedIds.join('\0'))) onsets.clearPreview();
      const selection = sources.selectedIds.join('\0'); if (this.originalAudio && this.originalAudio !== sources.original || this.sourceSelection && this.sourceSelection !== selection) onsets?.cancel(); this.originalAudio = sources.original; this.sourceSelection = selection;
      const serial = this.sourceSerial = (this.sourceSerial ?? 0) + 1;
      try {
        const layers = [];
        for (const id of sources.selectedIds) {
          const entry = await sources.resolve(id); if (serial !== this.sourceSerial) return;
          let data = this.analysisCache.get(entry.buffer); if (!data) { data = await analyseAsync(entry.buffer); if (data) this.analysisCache.set(entry.buffer, data); }
          if (data) layers.push({ id, buffer: entry.buffer, color: entry.color, data });
        }
        const selected = await sources.resolveSelection(); if (serial !== this.sourceSerial) return; this.layers = layers; this.data = layers[0]?.data ?? null; this.sourceBuffer = selected.buffer; this.sourceOffset = 0; this.draw(this.lastOffsetSeconds ?? 0);
      } catch { if (serial === this.sourceSerial) { this.layers = []; this.sourceBuffer = null; this.data = null; this.draw(); } }
    };
    sources.addEventListener('change', refresh); refresh();
  }

  render(host) {
    host.replaceChildren();
    if (this.sourcePanel) { this.sourcePanel.render(); host.append(this.sourcePanel.host); this.sourcePanel.refreshEnvironment(); }
    const heading = document.createElement('h3'); heading.textContent = t('audio-analysis.s2cfdcbf'); heading.className = 'audio-analysis-heading'; host.append(heading);
    const title = document.createElement('p'); title.className = 'hint';
    title.textContent = t('audio-analysis.s799c07a'); host.append(title);
    const enabled = document.createElement('label'); enabled.className = 'field'; enabled.append(t('audio-analysis.s1ca3ef1'));
    const enabledInput = document.createElement('input'); enabledInput.type = 'checkbox'; enabledInput.checked = this.enabled;
    this.enabledInput = enabledInput;
    enabledInput.oninput = () => { this.enabled = enabledInput.checked; this.onChange(); this.draw(this.lastOffsetSeconds ?? 0); }; enabled.append(enabledInput); host.append(enabled);
    // 全曲 DDC 起音叠加开关 + 一键生成音符。
    const fullScanRow = document.createElement('div'); fullScanRow.className = 'audio-fullscan-row';
    const fullScanLabel = document.createElement('label'); fullScanLabel.className = 'field'; fullScanLabel.append('显示 DDC 起音点（全曲预分析）');
    const fullScanInput = document.createElement('input'); fullScanInput.type = 'checkbox'; fullScanInput.checked = this.showFullScan;
    fullScanInput.oninput = () => { this.showFullScan = fullScanInput.checked; this.draw(this.lastOffsetSeconds ?? 0); }; fullScanLabel.append(fullScanInput); fullScanRow.append(fullScanLabel);
    const makeNotes = document.createElement('button'); makeNotes.type = 'button'; makeNotes.className = 'audio-fullscan-notes';
    const refreshCount = () => { const count = this.fullScanCache?.peaks?.length ?? 0; makeNotes.textContent = count ? `把这些起音写成 Tap（${count}）` : 'DDC 预分析完成后可写音符'; makeNotes.disabled = !count || !this.onPeaksToNotes; };
    refreshCount();
    makeNotes.onclick = () => { if (this.fullScanCache?.peaks?.length) this.onPeaksToNotes(this.fullScanCache.peaks); refreshCount(); };
    fullScanRow.append(makeNotes);
    const detectSections = document.createElement('button'); detectSections.type = 'button'; detectSections.className = 'audio-fullscan-notes';
    detectSections.textContent = '自动检测段落并加标记';
    detectSections.onclick = () => this.onSectionsDetected?.();
    fullScanRow.append(detectSections); host.append(fullScanRow);
    this.refreshFullScanUI = refreshCount;
    const alpha = document.createElement('label'); alpha.className = 'field'; alpha.append(t('audio-analysis.s61b101b'));
    const alphaInput = document.createElement('input'); alphaInput.type = 'range'; alphaInput.min = '0.02'; alphaInput.max = '1'; alphaInput.step = '0.01'; alphaInput.value = this.alpha;
    alphaInput.oninput = () => { this.alpha = Number(alphaInput.value); this.onChange(); this.draw(this.lastOffsetSeconds ?? 0); }; alpha.append(alphaInput); host.append(alpha);
    const width = document.createElement('label'); width.className = 'field'; width.append(t('audio-analysis.sa875081'));
    const widthInput = document.createElement('input'); widthInput.type = 'range'; widthInput.min = '0.2'; widthInput.max = '1'; widthInput.step = '0.01'; widthInput.value = this.width;
    widthInput.oninput = () => { this.width = Number(widthInput.value); this.onChange(); this.draw(this.lastOffsetSeconds ?? 0); }; width.append(widthInput); host.append(width);
    const mode = document.createElement('div'); mode.className = 'analysis-mode-buttons';
    for (const [value, label] of [['waveform', t('audio-analysis.s1b686e5')], ['spectrum', t('audio-analysis.s75c6d62')]]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.classList.toggle('active', this.mode === value);
      button.onclick = () => { this.mode = value; this.enabled = true; this.render(host); this.onChange(); this.draw(this.lastOffsetSeconds ?? 0); }; mode.append(button);
    }
    host.append(mode);
    if (!this.data) { const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = t('audio-analysis.s9463632'); host.append(empty); }
    if (this.sourcePanel?.onsetPanel) host.append(this.sourcePanel.onsetPanel.host);
  }

  draw(offsetSeconds = 0) {
    this.lastOffsetSeconds = offsetSeconds;
    const canvas = this.canvas; if (!canvas) return;
    const timeline = this.getTimeline?.(); const stage = canvas.parentElement;
    if (!this.enabled || !this.data || timeline?.getSession?.()?.multiLineActive) { if (!canvas.hidden) canvas.hidden = true; this.lastFrame = null; return; }
    const stageRect = stage?.getBoundingClientRect?.(); const notesRect = timeline?.notesCanvas?.getBoundingClientRect?.();
    if (!stageRect || !notesRect || !notesRect.width || !notesRect.height) {
      if (!canvas.hidden) canvas.hidden = true; this.lastFrame = null; return;
    }
    if (canvas.hidden) canvas.hidden = false;
    const ratio = globalThis.devicePixelRatio || 1;
    const width = stageRect.width; const height = stageRect.height;
    const left = notesRect.left - stageRect.left; const right = notesRect.right - stageRect.left;
    const center = (left + right) / 2; const half = Math.max(8, (right - left) * clamp(this.width) / 2);
    const fullPixelWidth = Math.round(width * ratio), cropLeft = Math.max(0, Math.floor((center - half) * ratio) - 2), cropRight = Math.min(fullPixelWidth, Math.ceil((center + half) * ratio) + 2), pixelWidth = Math.max(1, cropRight - cropLeft);
    this.drawRegion = { left: cropLeft, width: pixelWidth, fullWidth: fullPixelWidth, ratio };
    const cropStyle = [cropLeft, pixelWidth, ratio, editorCanvasRevision()];
    if (!this.cropStyle || cropStyle.some((value, index) => value !== this.cropStyle[index])) { canvas.style.left = cropLeft / ratio + 'px'; canvas.style.right = 'auto'; canvas.style.width = pixelWidth / ratio + 'px'; this.cropStyle = cropStyle; }
    const timelineHeight = Math.min(height, notesRect.height), viewHeight = timeline.viewHeight(), factor = timeline.factor, preview = this.onsets?.preview;
    const frame = [width, height, left, right, ratio, canvas.width, canvas.height, timelineHeight, viewHeight, timeline.origin, timeline.tempo, timeline.scale, timeline.judgementOffset, factor, offsetSeconds, this.mode, this.width, this.alpha, this.layers, this.data, this.getAudio()?.buffer, editorCanvasRevision(), preview];
    if (this.lastFrame?.length === frame.length && frame.every((value, index) => value === this.lastFrame[index])) return;
    if (canvas.width !== pixelWidth || canvas.height !== Math.round(height * ratio)) { canvas.width = pixelWidth; canvas.height = Math.round(height * ratio); frame[5] = canvas.width; frame[6] = canvas.height; }
    this.lastFrame = frame;
    const nativeContext = canvas.getContext('2d'), context = editorSkinContext(nativeContext); context.setTransform(ratio, 0, 0, ratio, -cropLeft, 0); context.clearRect(0, 0, width, height);
    const originSeconds = timeline.tempo.seconds(timeline.origin, factor), judgementY = viewHeight - timeline.judgementOffset, scale = timeline.scale;
    const rowCount = Math.ceil(timelineHeight);
    if (!this.rowSeconds || this.rowSeconds.length < rowCount) this.rowSeconds = new Float64Array(rowCount);
    if (this.mode === 'waveform') for (let row = 0; row < rowCount; row++) this.rowSeconds[row] = originSeconds + (judgementY - row) / scale + offsetSeconds;
    context.save(); context.lineWidth = 1;
    for (const [layerIndex, layer] of this.layers.entries()) {
      const source = layer.data, laneWidth = half * 2 / this.layers.length, laneCenter = center - half + laneWidth * (layerIndex + .5), laneHalf = laneWidth / 2; context.globalAlpha = clamp(this.alpha); context.strokeStyle = layer.color; context.fillStyle = layer.color;
      const duration = Math.min(source.duration, this.getAudio()?.buffer?.duration ?? source.duration);
      if (this.mode === 'spectrum') {
        const start = Math.max(0, originSeconds + (judgementY - timelineHeight) / scale + offsetSeconds), end = Math.min(duration, originSeconds + judgementY / scale + offsetSeconds);
        if (end > start) {
          const texture = this.spectrumTexture(source, context.fillStyle), top = timeline.vertical(timeline.tempo.beat(end - offsetSeconds, timeline.factor)), bottom = timeline.vertical(timeline.tempo.beat(start - offsetSeconds, timeline.factor));
          context.save(); context.translate(laneCenter - laneHalf, bottom); context.scale(1, -1); context.imageSmoothingEnabled = false;
          context.drawImage(texture, 0, start / source.duration * source.frameCount, source.bands, (end - start) / source.duration * source.frameCount, 0, 0, laneWidth, bottom - top); context.restore();
        }
        continue;
      }
      const first = Math.max(0, Math.floor(judgementY - (duration - offsetSeconds - originSeconds) * scale) - 1), last = Math.min(rowCount, Math.ceil(judgementY + (offsetSeconds + originSeconds) * scale) + 1);
      let envelope = this.waveformCache.get(source.waveform);
      if (!envelope) { envelope = new WaveformEnvelope(source.waveform); this.waveformCache.set(source.waveform, envelope); }
      const samplesPerSecond = source.waveform.length / source.duration, rowDuration = 1 / scale;
      const alpha = nativeContext.globalAlpha; nativeContext.globalAlpha = alpha * editorCanvasOpacity(canvas);
      for (let y = first; y < last; y++) {
        const audioSeconds = this.rowSeconds[y];
        if (audioSeconds < 0 || audioSeconds - rowDuration > duration) continue;
        const amplitude = envelope.peak((audioSeconds - rowDuration) * samplesPerSecond, Math.min(duration, audioSeconds) * samplesPerSecond);
        const extent = amplitude * Math.max(1, laneHalf - (this.layers.length > 1 ? 2 : 0));
        nativeContext.fillRect(laneCenter - extent, y, Math.max(1, extent * 2), 1);
      }
      nativeContext.globalAlpha = alpha;
    }
    if (preview && preview.selection === this.sources?.selectedIds.join('\0')) {
      context.globalAlpha = .8; context.strokeStyle = '#63e6ad'; context.lineWidth = 1;
      for (const peak of preview.peaks) {
        const seconds = peak.seconds + preview.offsetSeconds - offsetSeconds, y = timeline.vertical(timeline.tempo.beat(seconds, timeline.factor)); if (y < 0 || y > timelineHeight) continue;
        context.beginPath(); context.moveTo(center - half, y); context.lineTo(center + half, y); context.stroke();
      }
    }
    // 全曲 DDC 预分析起音点：金色横线，置信度越高越亮。
    const fullScan = this.showFullScan ? this.fullScanCache : null;
    if (fullScan?.peaks?.length && fullScan.buffer === this.getAudio()?.buffer) {
      for (const peak of fullScan.peaks) {
        const seconds = peak.seconds - offsetSeconds, y = timeline.vertical(timeline.tempo.beat(seconds, timeline.factor));
        if (y < 0 || y > timelineHeight) continue;
        const confidence = Math.min(1, Math.max(0, Number(peak.confidence) || 0.6));
        context.globalAlpha = .25 + confidence * .6;
        context.strokeStyle = '#ffcf5c'; context.lineWidth = confidence > .8 ? 2 : 1;
        context.beginPath(); context.moveTo(center - half * .8, y); context.lineTo(center + half * .8, y); context.stroke();
      }
    }
    context.restore();
  }

  spectrumTexture(data, color) {
    if (data.texture?.color === color) return data.texture.canvas;
    const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(data.bands, data.frameCount) : document.createElement('canvas'); canvas.width = data.bands; canvas.height = data.frameCount;
    const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, 1, 1); const rgba = context.getImageData(0, 0, 1, 1).data, pixels = context.createImageData(data.bands, data.frameCount);
    for (let index = 0; index < data.spectrum.length; index++) { const magnitude = data.spectrum[index]; if (magnitude <= .01) continue; pixels.data[index * 4] = rgba[0]; pixels.data[index * 4 + 1] = rgba[1]; pixels.data[index * 4 + 2] = rgba[2]; pixels.data[index * 4 + 3] = Math.round(rgba[3] * (.18 + .82 * magnitude)); }
    context.putImageData(pixels, 0, 0); data.texture = { color, canvas }; return canvas;
  }
}
