/**
 * BPM detection from an AudioBuffer using energy-based onset detection.
 *
 * Algorithm:
 * 1. Down-mix to mono and apply a low-pass filter emphasis (bass frequencies carry the beat).
 * 2. Compute short-window energy values across the track.
 * 3. Detect onsets where the energy exceeds a local-average threshold.
 * 4. Compute inter-onset intervals and find the dominant tempo via histogram binning.
 */

/** Reasonable BPM bounds for dance / DJ music. */
const MIN_BPM = 60;
const MAX_BPM = 200;

/**
 * Detect the BPM of an AudioBuffer.
 * @returns The most likely BPM as a number rounded to one decimal place.
 */
export async function detectBpm(buffer: AudioBuffer): Promise<number> {
  // 1. Down-mix to mono
  const length = buffer.length;
  const sampleRate = buffer.sampleRate;
  const mono = new Float32Array(length);
  const channels = buffer.numberOfChannels;

  for (let ch = 0; ch < channels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      mono[i] += data[i];
    }
  }
  if (channels > 1) {
    for (let i = 0; i < length; i++) {
      mono[i] /= channels;
    }
  }

  // 2. Simple low-pass emphasis — square the samples and apply a moving-average envelope.
  //    Window size: ~10 ms worth of samples.
  const windowSize = Math.round(sampleRate * 0.01);
  const hopSize = Math.round(windowSize / 2);
  const numWindows = Math.floor((length - windowSize) / hopSize);

  const energy = new Float32Array(numWindows);
  for (let w = 0; w < numWindows; w++) {
    const start = w * hopSize;
    let sum = 0;
    for (let i = start; i < start + windowSize; i++) {
      sum += mono[i] * mono[i];
    }
    energy[w] = sum / windowSize;
  }

  // 3. Onset detection: local energy exceeds a running average by a threshold.
  const avgWindow = 20; // number of energy frames for the local average
  const threshold = 1.4; // energy must be this many times the local average
  const onsets: number[] = [];
  const minOnsetGap = Math.round(sampleRate * 0.1 / hopSize); // at least 100 ms apart

  for (let w = avgWindow; w < numWindows; w++) {
    // Compute local average
    let localAvg = 0;
    for (let j = w - avgWindow; j < w; j++) {
      localAvg += energy[j];
    }
    localAvg /= avgWindow;

    if (energy[w] > localAvg * threshold) {
      // Enforce minimum gap
      if (onsets.length === 0 || (w - onsets[onsets.length - 1]) >= minOnsetGap) {
        onsets.push(w);
      }
    }
  }

  if (onsets.length < 2) {
    // Not enough onsets detected — return a default
    return 120;
  }

  // 4. Compute inter-onset intervals in BPM and build a histogram.
  const intervals: number[] = [];
  for (let i = 1; i < onsets.length; i++) {
    const deltaFrames = onsets[i] - onsets[i - 1];
    const deltaSeconds = (deltaFrames * hopSize) / sampleRate;
    const bpm = 60 / deltaSeconds;
    // Normalise into MIN-MAX range by halving / doubling
    let normBpm = bpm;
    while (normBpm > MAX_BPM) normBpm /= 2;
    while (normBpm < MIN_BPM) normBpm *= 2;
    intervals.push(normBpm);
  }

  // Histogram with 1-BPM resolution
  const bins = new Float32Array(MAX_BPM - MIN_BPM + 1);
  for (const bpm of intervals) {
    const idx = Math.round(bpm) - MIN_BPM;
    if (idx >= 0 && idx < bins.length) {
      bins[idx]++;
    }
  }

  // Find the peak bin
  let bestIdx = 0;
  for (let i = 1; i < bins.length; i++) {
    if (bins[i] > bins[bestIdx]) {
      bestIdx = i;
    }
  }

  const detectedBpm = bestIdx + MIN_BPM;

  // Refine: average the intervals that fall within +-2 BPM of the peak
  let sum = 0;
  let count = 0;
  for (const bpm of intervals) {
    if (Math.abs(bpm - detectedBpm) <= 2) {
      sum += bpm;
      count++;
    }
  }

  const refined = count > 0 ? sum / count : detectedBpm;
  return Math.round(refined * 10) / 10;
}
