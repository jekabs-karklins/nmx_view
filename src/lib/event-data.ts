import type { EventData } from "./h5wasm-loader";

export interface TofHistogramResult {
  binEdges: Float64Array; // length = numBins + 1
  counts: Float64Array; // length = numBins
  tofMin: number;
  tofMax: number;
}

/**
 * Compute a TOF histogram from pre-processed event data.
 * Uses pre-converted Float64Array (no BigInt conversion needed).
 */
export function computeTofHistogram(
  eventData: EventData,
  numBins: number = 500
): TofHistogramResult {
  const { tofMin, tofMax, tofF64 } = eventData;

  const range = tofMax - tofMin;
  const binWidth = range / numBins;
  const binEdges = new Float64Array(numBins + 1);
  for (let i = 0; i <= numBins; i++) {
    binEdges[i] = tofMin + i * binWidth;
  }

  const counts = new Float64Array(numBins);
  for (let i = 0; i < tofF64.length; i++) {
    const bin = Math.floor((tofF64[i] - tofMin) / binWidth);
    const clampedBin = Math.min(bin, numBins - 1);
    if (clampedBin >= 0) counts[clampedBin]++;
  }

  return { binEdges, counts, tofMin, tofMax };
}

export interface DetectorImageResult {
  image: Float64Array; // flattened 2D array [rows][cols]
  shape: [number, number]; // [rows, cols]
  totalEvents: number;
}

/**
 * Bin events into a 2D detector image for a given TOF range.
 * Scans pre-converted Float64Arrays (no BigInt conversion per call).
 * Uses cached pixel-to-flat mapping (computed once at load time).
 */
export function computeDetectorImage(
  eventData: EventData,
  tofRange: [number, number]
): DetectorImageResult {
  console.time('computeDetectorImage');

  const { detectorShape, panelPixelIdMin, pixelToFlat, isIdentity,
          eventIdF64, tofF64 } = eventData;
  const [rows, cols] = detectorShape;
  const totalPixels = rows * cols;
  const image = new Float64Array(totalPixels);

  const [tofLow, tofHigh] = tofRange;
  let totalEvents = 0;

  if (isIdentity) {
    // Fast path: pixel ID is the flat index directly
    for (let i = 0; i < tofF64.length; i++) {
      const t = tofF64[i];
      if (t < tofLow || t > tofHigh) continue;
      const pid = eventIdF64[i] - panelPixelIdMin;
      if (pid >= 0 && pid < totalPixels) {
        image[pid]++;
        totalEvents++;
      }
    }
  } else {
    // General path: use cached pixel-to-flat map
    for (let i = 0; i < tofF64.length; i++) {
      const t = tofF64[i];
      if (t < tofLow || t > tofHigh) continue;
      const pid = eventIdF64[i] - panelPixelIdMin;
      if (pid >= 0 && pid < totalPixels) {
        const flatIdx = pixelToFlat[pid];
        if (flatIdx >= 0) {
          image[flatIdx]++;
          totalEvents++;
        }
      }
    }
  }
  console.timeEnd('computeDetectorImage');
  return { image, shape: [rows, cols], totalEvents };
}
