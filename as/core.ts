// AssemblyScript 数值内核：JS 在 WASM 线性内存中分配原始缓冲区，函数按指针读写。
// 无对象分配、无 JSON 解析，适合 Worker 中高频调用。

let bump: usize = 0;

export function allocate(bytes: i32): usize {
  const ptr = bump;
  bump += <usize>((bytes + 15) & ~15);
  return ptr;
}

export function resetAllocator(): void { bump = 0; }

export function minGapPtr(atPtr: usize, len: i32): f64 {
  if (len < 2) return 0.0;
  let best = f64.POSITIVE_INFINITY;
  for (let i = 1; i < len; i++) {
    const gap = load<f64>(atPtr + <usize>(i << 3)) - load<f64>(atPtr + <usize>((i - 1) << 3));
    if (gap < best) best = gap;
  }
  return best;
}

export function bucketCountsPtr(atPtr: usize, len: i32, bucketsPtr: usize, size: i32): void {
  for (let i = 0; i < len; i++) {
    const second = <i32>Math.floor(load<f64>(atPtr + <usize>(i << 3)));
    if (second >= 0 && second < size) {
      const slot = bucketsPtr + <usize>(second << 2);
      store<u32>(slot, load<u32>(slot) + 1);
    }
  }
}

export function peakCountPtr(bucketsPtr: usize, size: i32): u32 {
  let peak: u32 = 0;
  for (let i = 0; i < size; i++) {
    const value = load<u32>(bucketsPtr + <usize>(i << 2));
    if (value > peak) peak = value;
  }
  return peak;
}

export function buildImpulseTrainPtr(secondsPtr: usize, strengthPtr: usize, len: i32, rate: f64, outPtr: usize): void {
  for (let i = 0; i < len; i++) {
    const index = <i32>Math.floor(load<f64>(secondsPtr + <usize>(i << 3)) * rate);
    if (index >= 0) {
      const slot = outPtr + <usize>(index << 2);
      store<f32>(slot, load<f32>(slot) + load<f32>(strengthPtr + <usize>(i << 2)));
    }
  }
}

export function autocorrScorePtr(trainPtr: usize, len: i32, lag: f64): f64 {
  let product = 0.0, first = 0.0, second = 0.0;
  for (let i = 0; i < len; i++) {
    const offset = f64(i) + lag, low = <i32>Math.floor(offset);
    if (low >= len) break;
    const part = offset - f64(low);
    const nextValue = low + 1 < len ? load<f32>(trainPtr + <usize>((low + 1) << 2)) : 0.0;
    const value = load<f32>(trainPtr + <usize>(low << 2)) * (1.0 - part) + nextValue * part;
    const source = load<f32>(trainPtr + <usize>(i << 2));
    product += source * value;
    first += source * source;
    second += value * value;
  }
  const denominator = Math.sqrt(first * second);
  return denominator > 0.0 ? product / denominator : 0.0;
}

export function concurrentMaxPtr(atPtr: usize, len: i32, window: f64): i32 {
  if (len <= 0) return 0;
  let start: i32 = 0, peak: i32 = 0;
  for (let end = 0; end < len; end++) {
    while (load<f64>(atPtr + <usize>(end << 3)) - load<f64>(atPtr + <usize>(start << 3)) > window) start++;
    const count = end - start + 1;
    if (count > peak) peak = count;
  }
  return peak;
}

function siftDown(events: Float64Array, root: i32, size: i32): void {
  while (true) {
    const left = root * 2 + 1, right = left + 1;
    let largest = root;
    if (left < size && events[left] > events[largest]) largest = left;
    if (right < size && events[right] > events[largest]) largest = right;
    if (largest == root) break;
    const tmp = events[root]; events[root] = events[largest]; events[largest] = tmp;
    root = largest;
  }
}

export function holdPeakPtr(startsPtr: usize, endsPtr: usize, len: i32): i32 {
  const events = new Float64Array(len * 2);
  for (let i = 0; i < len; i++) {
    events[i * 2] = load<f64>(startsPtr + <usize>(i << 3));
    events[i * 2 + 1] = -load<f64>(endsPtr + <usize>(i << 3));
  }
  const size = events.length;
  for (let i = size / 2 - 1; i >= 0; i--) siftDown(events, i, size);
  for (let end = size - 1; end > 0; end--) {
    const tmp = events[0]; events[0] = events[end]; events[end] = tmp;
    siftDown(events, 0, end);
  }
  let held: i32 = 0, peak: i32 = 0;
  for (let i = 0; i < size; i++) { held += events[i] > 0.0 ? 1 : -1; if (held > peak) peak = held; }
  return peak;
}
