export const clamp = (value, minimum = 0, maximum = 1) => Math.max(minimum, Math.min(maximum, value));

function channelSamples(buffer) {
  if (!buffer || typeof buffer.getChannelData !== 'function' || !buffer.length) return null;
  const channels = Math.max(1, Number(buffer.numberOfChannels) || 1);
  const length = Number(buffer.length) || 0;
  const output = new Float32Array(length);
  for (let channel = 0; channel < channels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < length; index++) output[index] += (data[index] ?? 0) / channels;
  }
  return output;
}

export function analyseAudioBuffer(buffer, options = {}) {
  const samples = channelSamples(buffer);
  if (!samples) return null;
  const waveformSize = Math.max(256, Math.min(65536, Number(options.waveformSize) || 32768));
  const waveform = new Float32Array(waveformSize);
  let peakMaximum = 0;
  for (let index = 0; index < waveform.length; index++) {
    const start = Math.floor(index * samples.length / waveform.length);
    const end = Math.max(start + 1, Math.floor((index + 1) * samples.length / waveform.length));
    let peak = 0;
    for (let cursor = start; cursor < end && cursor < samples.length; cursor++) peak = Math.max(peak, Math.abs(samples[cursor]));
    waveform[index] = peak;
    peakMaximum = Math.max(peakMaximum, peak);
  }
  if (peakMaximum > 0) for (let index = 0; index < waveform.length; index++) waveform[index] = Math.min(1, Math.pow(waveform[index] / peakMaximum, 1.35));
  const bands = Math.max(16, Math.min(128, Number(options.bands) || 64));
  const frameCount = Math.max(256, Math.min(8192, Number(options.spectrumFrames) || 2048));
  const spectrum = new Float32Array(frameCount * bands);
  const frameSize = 1024;
  const real = new Float64Array(frameSize); const imaginary = new Float64Array(frameSize); const reverse = new Uint16Array(frameSize);
  const rawSpectrum = new Float32Array(frameCount * bands);
  const bandPeaks = new Float32Array(bands);
  for (let index = 1, reversed = 0; index < frameSize; index++) {
    let bit = frameSize >> 1;
    for (; reversed & bit; bit >>= 1) reversed ^= bit;
    reversed ^= bit; reverse[index] = reversed;
  }
  for (let frame = 0; frame < frameCount; frame++) {
    const center = Math.floor((frame + 0.5) * samples.length / frameCount);
    const start = center - frameSize / 2;
    for (let index = 0; index < frameSize; index++) {
      const value = samples[Math.max(0, Math.min(samples.length - 1, start + index))] ?? 0;
      const window = 0.5 - 0.5 * Math.cos(Math.PI * 2 * index / (frameSize - 1));
      real[index] = value * window; imaginary[index] = 0;
    }
    for (let index = 1; index < frameSize; index++) if (index < reverse[index]) {
      [real[index], real[reverse[index]]] = [real[reverse[index]], real[index]];
      [imaginary[index], imaginary[reverse[index]]] = [imaginary[reverse[index]], imaginary[index]];
    }
    for (let size = 2; size <= frameSize; size <<= 1) {
      const half = size >> 1; const angle = -Math.PI * 2 / size;
      for (let startIndex = 0; startIndex < frameSize; startIndex += size) for (let offset = 0; offset < half; offset++) {
        const cosine = Math.cos(angle * offset); const sine = Math.sin(angle * offset);
        const target = startIndex + offset; const paired = target + half;
        const pairedReal = real[paired] * cosine - imaginary[paired] * sine;
        const pairedImaginary = real[paired] * sine + imaginary[paired] * cosine;
        real[paired] = real[target] - pairedReal; imaginary[paired] = imaginary[target] - pairedImaginary;
        real[target] += pairedReal; imaginary[target] += pairedImaginary;
      }
    }
    for (let band = 0; band < bands; band++) {
      const low = Math.max(1, Math.floor(Math.pow(band / bands, 2.2) * (frameSize / 2 - 1)));
      const high = Math.max(low + 1, Math.min(frameSize / 2, Math.ceil(Math.pow((band + 1) / bands, 2.2) * (frameSize / 2 - 1) + 1)));
      let energy = 0;
      let count = 0;
      for (let bin = low; bin < high; bin++) {
        const magnitude = Math.hypot(real[bin], imaginary[bin]) / (frameSize * 0.5);
        energy += magnitude * magnitude;
        count++;
      }
      const value = count ? Math.sqrt(energy / count) : 0;
      rawSpectrum[frame * bands + band] = value;
      bandPeaks[band] = Math.max(bandPeaks[band], value);
    }
  }
  for (let frame = 0; frame < frameCount; frame++) for (let band = 0; band < bands; band++) {
    const value = rawSpectrum[frame * bands + band];
    const peak = bandPeaks[band];
    if (peak <= 0) continue;
    const floor = peak * 0.025;
    const normalized = clamp((value - floor) / Math.max(peak - floor, Number.EPSILON));
    rawSpectrum[frame * bands + band] = Math.pow(normalized, 0.48);
  }
  spectrum.set(rawSpectrum);
  return { duration: Number(buffer.duration) || 0, waveform, spectrum, bands, frameCount };
}

