/**
 * Generate synthetic NXeventdata for demo purposes.
 * Creates 3 detector panels (1280×1280) with Laue-like spot patterns
 * and a realistic TOF distribution — no HDF5 file needed.
 */

import type { EventData, DetectorPanelInfo } from "./h5wasm-loader";
import type { DetectorImageResult } from "./event-data";
import { computeDetectorImage } from "./event-data";

/** Simple seeded PRNG (xorshift32) for reproducible demo data */
function xorshift32(seed: number): () => number {
  let state = seed | 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff; // [0, 1)
  };
}

/** Box-Muller transform for normal distribution */
function normalRandom(rng: () => number, mean: number, std: number): number {
  const u1 = rng();
  const u2 = rng();
  return mean + std * Math.sqrt(-2 * Math.log(u1 + 1e-10)) * Math.cos(2 * Math.PI * u2);
}

interface SpotDef {
  cx: number;
  cy: number;
  sigma: number;
  intensity: number;
  tofCenter: number;
  tofSigma: number;
}

function generateSpots(rng: () => number, count: number, size: number): SpotDef[] {
  const spots: SpotDef[] = [];
  for (let i = 0; i < count; i++) {
    spots.push({
      cx: rng() * size,
      cy: rng() * size,
      sigma: 3 + rng() * 15,
      intensity: 50 + rng() * 500,
      tofCenter: 5000 + rng() * 60000, // µs range: 5–65ms
      tofSigma: 500 + rng() * 3000,
    });
  }
  return spots;
}

/**
 * Generate synthetic EventData for a single panel.
 * Produces Laue-like spots with TOF structure.
 */
function generatePanelEventData(
  panelIndex: number,
  numEvents: number,
  size: number,
  rng: () => number
): { eventData: EventData; panelInfo: DetectorPanelInfo } {
  const totalPixels = size * size;
  const panelPixelIdMin = panelIndex * totalPixels;

  // Generate ~40-80 Laue spots per panel
  const numSpots = 40 + Math.floor(rng() * 40);
  const spots = generateSpots(rng, numSpots, size);

  // Add some Debye-Scherrer-like ring background
  const ringCenters = [
    { r: 200 + rng() * 100, width: 5 + rng() * 10 },
    { r: 400 + rng() * 100, width: 5 + rng() * 10 },
    { r: 550 + rng() * 100, width: 5 + rng() * 10 },
  ];

  const eventIdF64 = new Float64Array(numEvents);
  const tofF64 = new Float64Array(numEvents);

  const cx = size / 2;
  const cy = size / 2;

  let tofMin = Infinity;
  let tofMax = -Infinity;

  for (let e = 0; e < numEvents; e++) {
    let px: number, py: number, tof: number;

    // 70% spot events, 20% ring events, 10% uniform background
    const roll = rng();
    if (roll < 0.7 && spots.length > 0) {
      // Pick a random spot weighted by intensity
      const spot = spots[Math.floor(rng() * spots.length)];
      px = normalRandom(rng, spot.cx, spot.sigma);
      py = normalRandom(rng, spot.cy, spot.sigma);
      tof = normalRandom(rng, spot.tofCenter, spot.tofSigma) * 1000; // → ns
    } else if (roll < 0.9) {
      // Ring event
      const ring = ringCenters[Math.floor(rng() * ringCenters.length)];
      const angle = rng() * 2 * Math.PI;
      const r = normalRandom(rng, ring.r, ring.width);
      px = cx + r * Math.cos(angle);
      py = cy + r * Math.sin(angle);
      tof = (10000 + rng() * 50000) * 1000; // ns
    } else {
      // Uniform background
      px = rng() * size;
      py = rng() * size;
      tof = (5000 + rng() * 60000) * 1000; // ns
    }

    // Clamp to detector bounds
    px = Math.max(0, Math.min(size - 1, Math.round(px)));
    py = Math.max(0, Math.min(size - 1, Math.round(py)));
    tof = Math.max(0, tof);

    const flatIdx = py * size + px;
    eventIdF64[e] = panelPixelIdMin + flatIdx;
    tofF64[e] = tof;

    if (tof < tofMin) tofMin = tof;
    if (tof > tofMax) tofMax = tof;
  }

  // Build identity pixel map (sequential)
  const pixelToFlat = new Int32Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) pixelToFlat[i] = i;

  const eventData: EventData = {
    eventIdF64,
    tofF64,
    detectorShape: [size, size],
    panelPixelIdMin,
    pixelToFlat,
    isIdentity: true,
    tofMin,
    tofMax,
  };

  const panelInfo: DetectorPanelInfo = {
    path: `entry/instrument/detector_panel_${panelIndex}`,
    name: `detector_panel_${panelIndex}`,
    numEvents,
    detectorShape: [size, size],
    pixelIdMin: panelPixelIdMin,
    pixelIdMax: panelPixelIdMin + totalPixels - 1,
  };

  return { eventData, panelInfo };
}

export interface DemoData {
  panels: DetectorPanelInfo[];
  eventDataMap: Map<number, EventData>;
  images: DetectorImageResult[];
  tofMin: number;
  tofMax: number;
}

/**
 * Generate complete demo data for 3 detector panels.
 * Returns panels, event data, and pre-computed images.
 */
export function generateDemoData(
  onProgress?: (pct: number, label: string) => void
): DemoData {
  const SIZE = 1280;
  const rng = xorshift32(42);

  // Smaller event counts for snappy demo (~500K per panel)
  const panelEvents = [500_000, 800_000, 500_000];

  const panels: DetectorPanelInfo[] = [];
  const eventDataMap = new Map<number, EventData>();
  let globalTofMin = Infinity;
  let globalTofMax = -Infinity;

  for (let i = 0; i < 3; i++) {
    onProgress?.(((i) / 7) * 100, `Generating panel ${i}...`);
    const { eventData, panelInfo } = generatePanelEventData(
      i,
      panelEvents[i],
      SIZE,
      rng
    );
    panels.push(panelInfo);
    eventDataMap.set(i, eventData);
    if (eventData.tofMin < globalTofMin) globalTofMin = eventData.tofMin;
    if (eventData.tofMax > globalTofMax) globalTofMax = eventData.tofMax;
  }

  // Compute initial images
  const range: [number, number] = [globalTofMin, globalTofMax];
  const images: DetectorImageResult[] = [];
  for (let i = 0; i < 3; i++) {
    onProgress?.(((3 + i) / 7) * 100, `Computing image for panel ${i}...`);
    images.push(computeDetectorImage(eventDataMap.get(i)!, range));
  }
  onProgress?.(100, "Done!");

  return { panels, eventDataMap, images, tofMin: globalTofMin, tofMax: globalTofMax };
}
