import h5wasm, {
  File as H5File,
  Group as H5Group,
  Dataset as H5Dataset,
  FS,
} from "h5wasm";

import type { DetectorImageResult } from "./event-data";

// Plugin .so filenames to load for filter support (bitshuffle, lz4, etc.)
const PLUGIN_NAMES = [
  "bshuf", "blosc", "blosc2", "bz2", "jpeg", "lz4", "lzf", "zfp", "zstd",
  "bitgroom", "bitround",
];

let h5wasmReady: Promise<void> | null = null;

export async function initH5Wasm(): Promise<void> {
  if (!h5wasmReady) {
    h5wasmReady = (async () => {
      const module = await h5wasm.ready;
      // Get the plugin search path from h5wasm and ensure directory exists
      const pluginPath = module.get_plugin_search_paths()[0];
      module.FS.mkdirTree(pluginPath);
      // Fetch .so plugin files from our public directory and write into WASM FS
      const base = import.meta.env.BASE_URL || "/";
      const fetches = PLUGIN_NAMES.map(async (name) => {
        const filename = `libH5Z${name}.so`;
        try {
          const resp = await fetch(`${base}h5wasm-plugins/${filename}`);
          if (!resp.ok) {
            console.warn(`Plugin ${filename}: HTTP ${resp.status}`);
            return;
          }
          const buf = await resp.arrayBuffer();
          module.FS.writeFile(`${pluginPath}/${filename}`, new Uint8Array(buf));
        } catch (e) {
          console.warn(`Failed to load plugin ${filename}:`, e);
        }
      });
      await Promise.all(fetches);
      console.log("h5wasm plugins installed:", PLUGIN_NAMES);
    })();
  }
  return h5wasmReady;
}

export async function openFile(file: File): Promise<H5File> {
  await initH5Wasm();
  const buf = await file.arrayBuffer();
  const filename = file.name;
  FS!.writeFile(filename, new Uint8Array(buf));
  return new H5File(filename, "r");
}

// ── File type detection ──────────────────────────────────────

export type NexusFileType = "NXeventdata" | "NXlauetof" | "unknown";

/**
 * Try to read a string value from an HDF5 dataset (handles typed arrays, Uint8Array, etc.)
 */
function readStringValue(ds: H5Dataset): string {
  const val = ds.value;
  if (typeof val === "string") return val.trim();
  if (val instanceof Uint8Array) return new TextDecoder().decode(val).trim();
  return String(val ?? "").trim();
}

/**
 * Find an NXevent_data group within a panel group.
 * Checks: (1) direct child datasets, (2) 'data' subgroup, (3) any subgroup with NX_class=NXevent_data.
 */
function findEventDataGroup(
  h5file: H5File,
  panelPath: string,
  panelGroup: H5Group
): H5Group | null {
  // Check if event_id exists directly in the panel group
  const directEventId = panelGroup.get("event_id") as H5Dataset | null;
  if (directEventId) return panelGroup;

  // Check 'data' subgroup
  const dataChild = panelGroup.get("data");
  if (dataChild && dataChild instanceof H5Group) {
    const eid = dataChild.get("event_id") as H5Dataset | null;
    if (eid) return dataChild;
  }

  // Scan all child groups for one containing event_id or NX_class=NXevent_data
  for (const childKey of panelGroup.keys()) {
    const child = panelGroup.get(childKey);
    if (!(child instanceof H5Group)) continue;
    const nxAttr = child.attrs?.["NX_class"];
    if (nxAttr) {
      const nxVal = nxAttr.value;
      if (typeof nxVal === "string" && nxVal === "NXevent_data") return child;
    }
    const eid = child.get("event_id") as H5Dataset | null;
    if (eid) return child;
  }

  return null;
}

export function detectFileType(h5file: H5File): NexusFileType {
  // Check /entry/definition or /entry/definitions
  for (const path of ["entry/definition", "entry/definitions"]) {
    const ds = h5file.get(path) as H5Dataset | null;
    if (!ds) continue;
    if (readStringValue(ds) === "NXlauetof") return "NXlauetof";
  }
  // Fall back: scan all groups under /entry/instrument/ for NXevent_data content
  const instrument = h5file.get("entry/instrument");
  if (instrument && instrument instanceof H5Group) {
    for (const key of instrument.keys()) {
      const child = instrument.get(key);
      if (!(child instanceof H5Group)) continue;
      const evGroup = findEventDataGroup(h5file, `entry/instrument/${key}`, child);
      if (evGroup) return "NXeventdata";
    }
  }
  return "unknown";
}

// ── NXeventdata panels ───────────────────────────────────────

export interface DetectorPanelInfo {
  path: string;
  name: string;
  numEvents: number;
  detectorShape: [number, number];
  pixelIdMin: number;
  pixelIdMax: number;
}

export function findDetectorPanels(h5file: H5File): DetectorPanelInfo[] {
  const panels: DetectorPanelInfo[] = [];
  const instrument = h5file.get("entry/instrument");
  if (!instrument || !(instrument instanceof H5Group)) return panels;

  for (const key of instrument.keys()) {
    const child = instrument.get(key);
    if (!(child instanceof H5Group)) continue;

    const panelPath = `entry/instrument/${key}`;
    const evGroup = findEventDataGroup(h5file, panelPath, child);
    if (!evGroup) continue;

    const eventIdDs = evGroup.get("event_id") as H5Dataset | null;
    if (!eventIdDs) continue;

    // Look for detector_number in the panel group (not necessarily the event data group)
    let detNumDs = h5file.get(`${panelPath}/detector_number`) as H5Dataset | undefined;
    // Also check parent-level x_pixel_offset / y_pixel_offset for shape
    if (!detNumDs) {
      const xOff = h5file.get(`${panelPath}/x_pixel_offset`) as H5Dataset | undefined;
      const yOff = h5file.get(`${panelPath}/y_pixel_offset`) as H5Dataset | undefined;
      if (xOff?.shape && yOff?.shape) {
        // Construct shape from pixel offsets — each should be 1D with size = dim
        const nx = xOff.shape.length === 1 ? xOff.shape[0] : xOff.shape[1] ?? xOff.shape[0];
        const ny = yOff.shape.length === 1 ? yOff.shape[0] : yOff.shape[0];
        panels.push({
          path: panelPath,
          name: key,
          numEvents: eventIdDs.shape![0],
          detectorShape: [ny, nx],
          pixelIdMin: 0,
          pixelIdMax: ny * nx - 1,
        });
        continue;
      }
    }

    const detShape: [number, number] = detNumDs?.shape
      ? [detNumDs.shape[0], detNumDs.shape[1]]
      : [1280, 1280];

    panels.push({
      path: panelPath,
      name: key,
      numEvents: eventIdDs.shape![0],
      detectorShape: detShape,
      pixelIdMin: 0,
      pixelIdMax: detShape[0] * detShape[1] - 1,
    });
  }

  return panels;
}

export interface EventData {
  /** Pre-converted event pixel IDs (Float64) */
  eventIdF64: Float64Array;
  /** Pre-converted TOF values (Float64) */
  tofF64: Float64Array;
  detectorShape: [number, number];
  panelPixelIdMin: number;
  /** Cached pixel-to-flat-index mapping */
  pixelToFlat: Int32Array;
  /** True if pixelToFlat[i] === i for all i (sequential detector_number) */
  isIdentity: boolean;
  /** Pre-computed TOF bounds */
  tofMin: number;
  tofMax: number;
}

/**
 * Convert BigInt64Array or Int32Array to Float64Array.
 */
function toFloat64(arr: Int32Array | BigInt64Array): Float64Array {
  const out = new Float64Array(arr.length);
  if (arr instanceof BigInt64Array) {
    for (let i = 0; i < arr.length; i++) out[i] = Number(arr[i]);
  } else {
    for (let i = 0; i < arr.length; i++) out[i] = arr[i];
  }
  return out;
}

/**
 * Build reverse lookup: pixelId - panelMin → flat detector index.
 */
function buildPixelMap(
  detectorNumber: Int32Array,
  panelMin: number,
  totalPixels: number
): { pixelToFlat: Int32Array; isIdentity: boolean } {
  const pixelToFlat = new Int32Array(totalPixels);
  pixelToFlat.fill(-1);
  for (let i = 0; i < detectorNumber.length; i++) {
    const pid = detectorNumber[i] - panelMin;
    if (pid >= 0 && pid < totalPixels) pixelToFlat[pid] = i;
  }
  let isIdentity = true;
  for (let i = 0; i < totalPixels; i++) {
    if (pixelToFlat[i] !== i) { isIdentity = false; break; }
  }
  return { pixelToFlat, isIdentity };
}

/**
 * Read event data and pre-process: convert BigInt→Float64, sort by TOF,
 * cache pixel mapping. All heavy work is done here at load time.
 */
export function readEventData(h5file: H5File, panelPath: string): EventData {
  console.time(`[${panelPath}] total readEventData`);

  const panelGroup = h5file.get(panelPath) as H5Group;
  const evGroup = findEventDataGroup(h5file, panelPath, panelGroup);
  if (!evGroup) throw new Error(`No event data found in ${panelPath}`);

  const eventIdDs = evGroup.get("event_id") as H5Dataset;
  const etoDs = evGroup.get("event_time_offset") as H5Dataset;

  // detector_number can be in the panel group or the event data group
  let detNumDs = h5file.get(`${panelPath}/detector_number`) as H5Dataset | null;
  if (!detNumDs) detNumDs = evGroup.get("detector_number") as H5Dataset | null;

  const rawEventId = eventIdDs.value as Int32Array | BigInt64Array;
  const rawTof = etoDs.value as Int32Array | BigInt64Array;

  let detectorNumber: Int32Array;
  let detectorShape: [number, number];

  if (detNumDs && detNumDs.shape && detNumDs.shape.length >= 2) {
    detectorNumber = detNumDs.value as Int32Array;
    detectorShape = [detNumDs.shape[0], detNumDs.shape[1]];
  } else if (detNumDs && detNumDs.shape && detNumDs.shape.length === 1) {
    // 1D detector_number — infer square shape
    const n = Math.round(Math.sqrt(detNumDs.shape[0]));
    detectorNumber = detNumDs.value as Int32Array;
    detectorShape = [n, n];
  } else {
    // No detector_number — try to infer shape from x/y_pixel_offset
    const xOff = h5file.get(`${panelPath}/x_pixel_offset`) as H5Dataset | null;
    const yOff = h5file.get(`${panelPath}/y_pixel_offset`) as H5Dataset | null;
    if (xOff?.shape && yOff?.shape) {
      const nx = xOff.shape.length === 1 ? xOff.shape[0] : xOff.shape[1] ?? xOff.shape[0];
      const ny = yOff.shape.length === 1 ? yOff.shape[0] : yOff.shape[0];
      detectorShape = [ny, nx];
    } else {
      detectorShape = [1280, 1280];
    }
    // Build identity detector_number
    const totalPx = detectorShape[0] * detectorShape[1];
    detectorNumber = new Int32Array(totalPx);
    for (let i = 0; i < totalPx; i++) detectorNumber[i] = i;
  }

  // 1. Convert BigInt → Float64 (done once)
  console.time(`[${panelPath}] BigInt→Float64`);
  const eventIdF64 = toFloat64(rawEventId);
  const tofF64 = toFloat64(rawTof);
  console.timeEnd(`[${panelPath}] BigInt→Float64`);

  // 2. Find panelPixelIdMin
  let panelPixelIdMin = Number.MAX_SAFE_INTEGER;
  for (let i = 0; i < detectorNumber.length; i++) {
    if (detectorNumber[i] < panelPixelIdMin) panelPixelIdMin = detectorNumber[i];
  }

  // 3. Build + cache pixel map
  const totalPixels = detectorShape[0] * detectorShape[1];
  console.time(`[${panelPath}] buildPixelMap`);
  const { pixelToFlat, isIdentity } = buildPixelMap(detectorNumber, panelPixelIdMin, totalPixels);
  console.timeEnd(`[${panelPath}] buildPixelMap`);

  // 4. Find TOF bounds with a single O(N) pass
  let tofMin = Infinity;
  let tofMax = -Infinity;
  console.time(`[${panelPath}] TOF bounds`);

  for (let i = 0; i < tofF64.length; i++) {
    const v = tofF64[i];
    if (v < tofMin) tofMin = v;
    if (v > tofMax) tofMax = v;
  }
  console.timeEnd(`[${panelPath}] TOF bounds`);

  if (!isFinite(tofMin)) { tofMin = 0; tofMax = 0; }
  console.timeEnd(`[${panelPath}] total readEventData`);
  return {
    eventIdF64,
    tofF64,
    detectorShape,
    panelPixelIdMin,
    pixelToFlat,
    isIdentity,
    tofMin,
    tofMax,
  };
}

// ── NXlauetof panels ────────────────────────────────────────

export interface LauetofPanelInfo {
  path: string;
  name: string;
  shape: [number, number, number]; // [rows, cols, numTofBins]
  tofBins: Float64Array; // TOF bin centers (ns)
}

/**
 * Find a 3D data dataset and time_of_flight within a panel group.
 * Checks: (1) direct 'data' dataset, (2) any child dataset with ndim=3,
 * and looks for 'time_of_flight' in the panel group or any child group.
 */
function findLauetofDatasets(
  h5file: H5File,
  panelPath: string,
  panelGroup: H5Group
): { dataDs: H5Dataset; tofDs: H5Dataset } | null {
  let dataDs: H5Dataset | null = null;
  let tofDs: H5Dataset | null = null;

  // Look for 3D data dataset: check 'data' first, then scan children
  const directData = h5file.get(`${panelPath}/data`) as H5Dataset | null;
  if (directData?.shape?.length === 3) {
    dataDs = directData;
  } else {
    for (const childKey of panelGroup.keys()) {
      const child = panelGroup.get(childKey);
      if (child instanceof H5Dataset && child.shape?.length === 3) {
        dataDs = child;
        break;
      }
    }
  }
  if (!dataDs) return null;

  // Look for time_of_flight: in panel group, then any child group
  tofDs = h5file.get(`${panelPath}/time_of_flight`) as H5Dataset | null;
  if (!tofDs) {
    for (const childKey of panelGroup.keys()) {
      const child = panelGroup.get(childKey);
      if (child instanceof H5Group) {
        const tof = child.get("time_of_flight") as H5Dataset | null;
        if (tof) { tofDs = tof; break; }
      } else if (child instanceof H5Dataset && childKey === "time_of_flight") {
        tofDs = child;
        break;
      }
    }
  }
  if (!tofDs) return null;

  return { dataDs, tofDs };
}

export function findLauetofPanels(h5file: H5File): LauetofPanelInfo[] {
  const panels: LauetofPanelInfo[] = [];
  const instrument = h5file.get("entry/instrument");
  if (!instrument || !(instrument instanceof H5Group)) return panels;

  for (const key of instrument.keys()) {
    const child = instrument.get(key);
    if (!(child instanceof H5Group)) continue;

    const panelPath = `entry/instrument/${key}`;
    const result = findLauetofDatasets(h5file, panelPath, child);
    if (!result) continue;
    const { dataDs, tofDs } = result;

    const tofRaw = tofDs.value;
    let tofBins: Float64Array;
    if (tofRaw instanceof Float64Array) {
      tofBins = tofRaw;
    } else if (tofRaw instanceof BigInt64Array) {
      tofBins = new Float64Array(tofRaw.length);
      for (let i = 0; i < tofRaw.length; i++) tofBins[i] = Number(tofRaw[i]);
    } else if (ArrayBuffer.isView(tofRaw)) {
      tofBins = new Float64Array(tofRaw as ArrayLike<number>);
    } else {
      continue;
    }

    panels.push({
      path: panelPath,
      name: key,
      shape: [dataDs.shape[0], dataDs.shape[1], dataDs.shape[2]],
      tofBins,
    });
  }

  return panels;
}

/**
 * Read a single TOF slice from an NXlauetof panel.
 * sliceIndex is a 0-based index into the TOF dimension.
 */
export function readLauetofSingleSlice(
  h5file: H5File,
  panelPath: string,
  sliceIndex: number
): DetectorImageResult {
  const panelGroup = h5file.get(panelPath) as H5Group;
  const result = findLauetofDatasets(h5file, panelPath, panelGroup);
  if (!result) throw new Error(`No 3D data found in ${panelPath}`);
  const { dataDs } = result;
  const [rows, cols, numBins] = dataDs.shape!;
  const idx = Math.max(0, Math.min(numBins - 1, sliceIndex));

  const image = new Float64Array(rows * cols);
  const raw = dataDs.slice([[0, rows], [0, cols], [idx, idx + 1]]);
  if (raw instanceof BigUint64Array || raw instanceof BigInt64Array) {
    for (let i = 0; i < raw.length; i++) image[i] = Number(raw[i]);
  } else if (ArrayBuffer.isView(raw)) {
    const arr = raw as ArrayLike<number>;
    for (let i = 0; i < arr.length; i++) image[i] = arr[i];
  }

  let totalEvents = 0;
  for (let i = 0; i < image.length; i++) totalEvents += image[i];

  return { image, shape: [rows, cols], totalEvents };
}
