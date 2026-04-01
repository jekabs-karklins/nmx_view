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

export function detectFileType(h5file: H5File): NexusFileType {
  // Check /entry/definition or /entry/definitions
  for (const path of ["entry/definition", "entry/definitions"]) {
    const ds = h5file.get(path) as H5Dataset | null;
    if (!ds) continue;
    const val = ds.value;
    const str =
      typeof val === "string"
        ? val
        : val instanceof Uint8Array
          ? new TextDecoder().decode(val)
          : String(val ?? "");
    if (str.trim() === "NXlauetof") return "NXlauetof";
  }
  // Fall back: check if any panel has NXevent_data
  const instrument = h5file.get("entry/instrument");
  if (instrument && instrument instanceof H5Group) {
    for (const key of instrument.keys()) {
      if (!key.startsWith("detector_panel")) continue;
      const dataGroup = h5file.get(`entry/instrument/${key}/data`);
      if (dataGroup && dataGroup instanceof H5Group) {
        const eventIdDs = dataGroup.get("event_id") as H5Dataset | null;
        if (eventIdDs) return "NXeventdata";
      }
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

  const group = instrument;
  const keys = group.keys();
  for (const key of keys) {
    if (!key.startsWith("detector_panel")) continue;
    const panelPath = `entry/instrument/${key}`;
    const dataGroup = h5file.get(`${panelPath}/data`);
    if (!dataGroup) continue;

    const dataG = dataGroup as H5Group;
    const attrs = dataG.attrs;
    const nxClass = attrs?.["NX_class"];
    // Check it's NXevent_data
    if (nxClass) {
      const nxVal = nxClass.value;
      if (typeof nxVal === "string" && nxVal !== "NXevent_data") continue;
    }

    const eventIdDs = dataG.get("event_id") as H5Dataset | null;
    if (!eventIdDs) continue;

    const detNumDs = h5file.get(`${panelPath}/detector_number`) as
      | H5Dataset
      | undefined;
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
  eventId: Int32Array | BigInt64Array;
  eventTimeOffset: Int32Array | BigInt64Array;
  detectorNumber: Int32Array;
  detectorShape: [number, number];
  panelPixelIdMin: number;
}

export function readEventData(h5file: H5File, panelPath: string): EventData {
  const eventIdDs = h5file.get(
    `${panelPath}/data/event_id`
  ) as H5Dataset;
  const etoDs = h5file.get(
    `${panelPath}/data/event_time_offset`
  ) as H5Dataset;
  const detNumDs = h5file.get(
    `${panelPath}/detector_number`
  ) as H5Dataset;

  const eventId = eventIdDs.value as Int32Array | BigInt64Array;
  const eventTimeOffset = etoDs.value as Int32Array | BigInt64Array;
  const detectorNumber = detNumDs.value as Int32Array;
  const detectorShape: [number, number] = [
    detNumDs.shape![0],
    detNumDs.shape![1],
  ];

  // Find panelPixelIdMin from detector_number
  let minId = Number.MAX_SAFE_INTEGER;
  for (let i = 0; i < detectorNumber.length; i++) {
    if (detectorNumber[i] < minId) minId = detectorNumber[i];
  }

  return {
    eventId,
    eventTimeOffset,
    detectorNumber,
    detectorShape,
    panelPixelIdMin: minId,
  };
}

// ── NXlauetof panels ────────────────────────────────────────

export interface LauetofPanelInfo {
  path: string;
  name: string;
  shape: [number, number, number]; // [rows, cols, numTofBins]
  tofBins: Float64Array; // TOF bin centers (ns)
}

export function findLauetofPanels(h5file: H5File): LauetofPanelInfo[] {
  const panels: LauetofPanelInfo[] = [];
  const instrument = h5file.get("entry/instrument");
  if (!instrument || !(instrument instanceof H5Group)) return panels;

  for (const key of instrument.keys()) {
    if (!key.startsWith("detector_panel")) continue;
    const panelPath = `entry/instrument/${key}`;
    const dataDs = h5file.get(`${panelPath}/data`) as H5Dataset | null;
    if (!dataDs || !dataDs.shape || dataDs.shape.length !== 3) continue;

    const tofDs = h5file.get(`${panelPath}/time_of_flight`) as H5Dataset | null;
    if (!tofDs) continue;

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
  const dataDs = h5file.get(`${panelPath}/data`) as H5Dataset;
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
