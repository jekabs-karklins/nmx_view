import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import "@h5web/lib/dist/styles.css";
import { ScaleType } from "@h5web/lib";
import { ViridisColorBar } from "./components/ViridisColorBar";
import type { ColorScaleType, Domain } from "@h5web/lib";
import { FileLoader } from "./components/FileLoader";
import { DetectorImage } from "./components/DetectorImage";
import { TofRangeSlider } from "./components/TofRangeSlider";
import {
  openFile,
  detectFileType,
  findDetectorPanels,
  readEventData,
  findLauetofPanels,
  readLauetofSingleSlice,
  type NexusFileType,
  type DetectorPanelInfo,
  type LauetofPanelInfo,
  type EventData,
} from "./lib/h5wasm-loader";
import {
  computeTofHistogram,
  computeDetectorImage,
  type DetectorImageResult,
} from "./lib/event-data";
import type { File as H5File } from "h5wasm";
import "./App.css";

/** Reserve px for header, TOF slider, status bar, padding */
const CHROME_HEIGHT = 160;
/** Width reserved for the shared color bar + domain inputs */
const COLORBAR_WIDTH = 80;

function useChartSize(panelCount: number) {
  const compute = () => {
    const gap = 8; // gap between panels
    const totalGap = (Math.max(panelCount, 1) - 1) * gap;
    const availW = window.innerWidth - 40 - totalGap - COLORBAR_WIDTH;
    const availH = window.innerHeight - CHROME_HEIGHT;
    const perPanel = availW / Math.max(panelCount, 1);
    const s = Math.min(perPanel, availH);
    return Math.max(Math.floor(s), 100);
  };

  const [size, setSize] = useState(compute);

  useEffect(() => {
    const onResize = () => setSize(compute());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelCount]);

  // Recompute when panelCount changes
  useEffect(() => {
    setSize(compute());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelCount]);

  return size;
}

function App() {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [fileType, setFileType] = useState<NexusFileType>("unknown");
  // NXeventdata state
  const [panels, setPanels] = useState<DetectorPanelInfo[]>([]);
  // NXlauetof state
  const [lauetofPanels, setLauetofPanels] = useState<LauetofPanelInfo[]>([]);
  // Shared state
  const [detectorImages, setDetectorImages] = useState<
    (DetectorImageResult | null)[]
  >([]);
  const [tofRange, setTofRange] = useState<[number, number]>([0, 0]);
  const tofUnit = "µs";
  const [tofAbsMin, setTofAbsMin] = useState(0);
  const [tofAbsMax, setTofAbsMax] = useState(0);
  const [colorScale, setColorScale] = useState<ColorScaleType>(ScaleType.Linear);
  const [numBins] = useState(500);
  const [imageComputing, setImageComputing] = useState(false);
  const [domainMin, setDomainMin] = useState<string>("");
  const [domainMax, setDomainMax] = useState<string>("");
  const [loadProgress, setLoadProgress] = useState(0);
  const [loadProgressLabel, setLoadProgressLabel] = useState("");
  const [fileName, setFileName] = useState("");
  const [viewMode, setViewMode] = useState<"overview" | number>("overview");
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "h" || e.key === "H") {
        e.preventDefault();
        setShowHelp((v) => !v);
      }
      if (e.key === "Escape") setShowHelp(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const activePanelCount = fileType === "NXlauetof" ? lauetofPanels.length : panels.length;
  const displayPanelCount = viewMode === "overview" ? activePanelCount : 1;
  const chartSize = useChartSize(displayPanelCount);

  const h5fileRef = useRef<H5File | null>(null);
  const eventDataRef = useRef<Map<number, EventData>>(new Map());
  const browserFileRef = useRef<File | null>(null);

  /** Yield to the event loop so React can render progress updates */
  const yieldToUI = () =>
    new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));

  /** Load ALL NXeventdata panels from the file */
  const loadAllPanels = useCallback(
    async (h5file: H5File, foundPanels: DetectorPanelInfo[]) => {
      eventDataRef.current = new Map();
      let globalTofMin = Infinity;
      let globalTofMax = -Infinity;
      const totalSteps = foundPanels.length * 2 + 1; // read + image per panel + final
      let step = 0;

      // Read event data for all panels
      for (let i = 0; i < foundPanels.length; i++) {
        const label = `Reading ${foundPanels[i].name} (${foundPanels[i].numEvents.toLocaleString()} events)...`;
        setLoadProgressLabel(label);
        setLoadProgress(((++step) / totalSteps) * 100);
        setStatus(label);
        await yieldToUI();

        const ed = readEventData(h5file, foundPanels[i].path);
        eventDataRef.current.set(i, ed);
        const hist = computeTofHistogram(ed, numBins);
        if (hist.tofMin < globalTofMin) globalTofMin = hist.tofMin;
        if (hist.tofMax > globalTofMax) globalTofMax = hist.tofMax;
      }

      const range: [number, number] = [globalTofMin, globalTofMax];
      setTofRange(range);
      setTofAbsMin(globalTofMin);
      setTofAbsMax(globalTofMax);

      // Compute images for all panels
      const images: DetectorImageResult[] = [];
      for (let i = 0; i < foundPanels.length; i++) {
        const label = `Computing image for ${foundPanels[i].name}...`;
        setLoadProgressLabel(label);
        setLoadProgress(((++step) / totalSteps) * 100);
        setStatus(label);
        await yieldToUI();

        const ed = eventDataRef.current.get(i)!;
        images.push(computeDetectorImage(ed, range));
      }
      setDetectorImages(images);

      setLoadProgress(100);
      setLoadProgressLabel("Done!");
      const totalEvents = images.reduce((s, img) => s + img.totalEvents, 0);
      setStatus(
        `Loaded ${foundPanels.length} panels — ${totalEvents.toLocaleString()} total events`
      );
    },
    [numBins]
  );

  /** Load ALL NXlauetof panels — read TOF bins and show first slice */
  const loadAllLauetofPanels = useCallback(
    async (h5file: H5File, foundPanels: LauetofPanelInfo[]) => {
      const totalSteps = foundPanels.length + 1;
      let step = 0;

      // Compute global TOF range across all panels
      let globalTofMin = Infinity;
      let globalTofMax = -Infinity;
      for (const p of foundPanels) {
        const pMin = p.tofBins[0];
        const pMax = p.tofBins[p.tofBins.length - 1];
        if (pMin < globalTofMin) globalTofMin = pMin;
        if (pMax > globalTofMax) globalTofMax = pMax;
      }

      // Bin width = spacing between consecutive TOF bin centers
      const binWidth = foundPanels[0].tofBins.length > 1
        ? foundPanels[0].tofBins[1] - foundPanels[0].tofBins[0]
        : 1;

      setTofAbsMin(globalTofMin);
      setTofAbsMax(globalTofMax);
      // Set initial range to first bin
      const initialRange: [number, number] = [
        globalTofMin,
        globalTofMin + binWidth,
      ];
      setTofRange(initialRange);

      // Read first slice for all panels
      const images: DetectorImageResult[] = [];
      for (let i = 0; i < foundPanels.length; i++) {
        const p = foundPanels[i];
        const label = `Reading ${p.name} slice 1/${p.shape[2]}...`;
        setLoadProgressLabel(label);
        setLoadProgress(((++step) / totalSteps) * 100);
        setStatus(label);
        await yieldToUI();

        images.push(readLauetofSingleSlice(h5file, p.path, 0));
      }
      setDetectorImages(images);

      setLoadProgress(100);
      setLoadProgressLabel("Done!");
      const totalCounts = images.reduce((s, img) => s + img.totalEvents, 0);
      setStatus(
        `Loaded ${foundPanels.length} panels — slice 1/${foundPanels[0]?.shape[2] ?? 0} — ${totalCounts.toLocaleString()} counts`
      );
    },
    []
  );

  const handleFileLoaded = useCallback(
    async (file: File) => {
      setLoading(true);
      setStatus("Opening HDF5 file...");
      try {
        browserFileRef.current = file;
        setFileName(file.name);
        const h5file = await openFile(file);
        h5fileRef.current = h5file;

        setStatus("Detecting file type...");
        const detectedType = detectFileType(h5file);
        setFileType(detectedType);

        setLoadProgress(0);
        setLoadProgressLabel("Starting...");

        if (detectedType === "NXlauetof") {
          const foundPanels = findLauetofPanels(h5file);
          if (foundPanels.length === 0) {
            setStatus("No detector panels found in NXlauetof file.");
            setLoading(false);
            return;
          }
          await loadAllLauetofPanels(h5file, foundPanels);
          setLauetofPanels(foundPanels);
        } else {
          setStatus("Scanning for detector panels...");
          const foundPanels = findDetectorPanels(h5file);
          if (foundPanels.length === 0) {
            setStatus("No NXEventData detector panels found in this file.");
            setLoading(false);
            return;
          }
          await loadAllPanels(h5file, foundPanels);
          setPanels(foundPanels);
        }
      } catch (err) {
        setStatus(`Error: ${(err as Error).message}`);
        console.error(err);
      } finally {
        setLoading(false);
      }
    },
    [loadAllPanels, loadAllLauetofPanels]
  );

  const handleReload = useCallback(async () => {
    if (!browserFileRef.current) return;
    setLoading(true);
    setStatus("Reloading file...");
    try {
      if (h5fileRef.current) {
        h5fileRef.current.close();
        h5fileRef.current = null;
      }
      const file = browserFileRef.current;
      const h5file = await openFile(file);
      h5fileRef.current = h5file;

      const detectedType = detectFileType(h5file);
      setFileType(detectedType);
      setLoadProgress(0);
      setLoadProgressLabel("Reloading...");

      if (detectedType === "NXlauetof") {
        const foundPanels = findLauetofPanels(h5file);
        if (foundPanels.length === 0) {
          setStatus("No detector panels found after reload.");
          setLoading(false);
          return;
        }
        setLauetofPanels(foundPanels);
        await loadAllLauetofPanels(h5file, foundPanels);
      } else {
        const foundPanels = findDetectorPanels(h5file);
        if (foundPanels.length === 0) {
          setStatus("No NXEventData detector panels found after reload.");
          setLoading(false);
          return;
        }
        setPanels(foundPanels);
        await loadAllPanels(h5file, foundPanels);
      }
    } catch (err) {
      setStatus(`Reload error: ${(err as Error).message}`);
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [loadAllPanels, loadAllLauetofPanels]);

  const handleTofRangeChange = useCallback(
    (range: [number, number]) => {
      setTofRange(range);
      setImageComputing(true);
      setTimeout(() => {
        if (fileType === "NXlauetof" && h5fileRef.current) {
          // NXlauetof: find closest bin center and read that single slice
          const images: (DetectorImageResult | null)[] = [];
          const center = (range[0] + range[1]) / 2;
          for (let i = 0; i < lauetofPanels.length; i++) {
            const p = lauetofPanels[i];
            // Find closest bin index to center of range
            let bestIdx = 0;
            let bestDist = Math.abs(p.tofBins[0] - center);
            for (let j = 1; j < p.tofBins.length; j++) {
              const dist = Math.abs(p.tofBins[j] - center);
              if (dist < bestDist) {
                bestDist = dist;
                bestIdx = j;
              }
            }
            images.push(readLauetofSingleSlice(h5fileRef.current!, p.path, bestIdx));
          }
          setDetectorImages(images);
          setImageComputing(false);
          const sliceIdx = (() => {
            const p = lauetofPanels[0];
            if (!p) return 0;
            let best = 0;
            let bestD = Math.abs(p.tofBins[0] - center);
            for (let j = 1; j < p.tofBins.length; j++) {
              const d = Math.abs(p.tofBins[j] - center);
              if (d < bestD) { bestD = d; best = j; }
            }
            return best;
          })();
          const totalCounts = images.reduce((s, img) => s + (img?.totalEvents ?? 0), 0);
          setStatus(`${lauetofPanels.length} panels — slice ${sliceIdx + 1}/${lauetofPanels[0]?.shape[2] ?? 0} — ${totalCounts.toLocaleString()} counts`);
        } else {
          // NXeventdata: bin events on the fly
          const images: (DetectorImageResult | null)[] = [];
          for (let i = 0; i < panels.length; i++) {
            const ed = eventDataRef.current.get(i);
            if (ed) {
              images.push(computeDetectorImage(ed, range));
            } else {
              images.push(null);
            }
          }
          setDetectorImages(images);
          setImageComputing(false);
          const totalEvents = images.reduce(
            (s, img) => s + (img?.totalEvents ?? 0),
            0
          );
          setStatus(
            `${panels.length} panels — ${totalEvents.toLocaleString()} events in TOF range`
          );
        }
      }, 0);
    },
    [fileType, panels, lauetofPanels]
  );

  // Compute auto domain: min=0, max=min(vals.max(), mu + 2*sigma)
  const LOG_SCALES: readonly string[] = [ScaleType.Log, ScaleType.SymLog];
  const autoDomain: Domain = useMemo(() => {
    // Gather all non-zero pixel values across all panels
    const allVals: number[] = [];
    let valMax = 0;
    for (const img of detectorImages) {
      if (!img) continue;
      for (let j = 0; j < img.image.length; j++) {
        const v = img.image[j];
        if (v > valMax) valMax = v;
        if (v > 0) allVals.push(v);
      }
    }
    if (allVals.length === 0) return [0.1, 1];
    // Compute mean and std of non-zero values
    const n = allVals.length;
    let sum = 0;
    for (let j = 0; j < n; j++) sum += allVals[j];
    const mu = sum / n;
    let sumSq = 0;
    for (let j = 0; j < n; j++) sumSq += (allVals[j] - mu) ** 2;
    const sigma = Math.sqrt(sumSq / n);
    const hi = Math.min(valMax, mu + 2 * sigma);
    return [0, Math.max(hi, 1)];
  }, [detectorImages]);

  const sharedDomain: Domain = useMemo(() => {
    let lo = autoDomain[0];
    let hi = autoDomain[1];
    // Apply user overrides
    if (domainMin !== "") lo = Number(domainMin);
    if (domainMax !== "") hi = Number(domainMax);
    if (LOG_SCALES.includes(colorScale)) lo = Math.max(lo, 0.1);
    if (hi <= lo) hi = lo + 1;
    return [lo, hi];
  }, [autoDomain, colorScale, domainMin, domainMax]);

  const handleAutoDomain = useCallback(() => {
    setDomainMin("");
    setDomainMax("");
  }, []);

  // Show file loader during initial load (no panels yet) or while loading without images
  const hasPanels = fileType === "NXlauetof" ? lauetofPanels.length > 0 : panels.length > 0;
  if (!hasPanels || (loading && detectorImages.every((d) => !d))) {
    return (
      <div className="app" data-filetype={fileType}>
        <FileLoader
          onFileLoaded={handleFileLoaded}
          loading={loading}
          progress={loadProgress}
          progressLabel={loadProgressLabel}
        />
        {status && <div className="status-bar">{status}</div>}
      </div>
    );
  }

  return (
    <div className="app" data-filetype={fileType}>
      <header className="app-header">
        <h1>NMX Event Data Viewer</h1>
        {fileName && <span className="file-name-badge">{fileName}</span>}
        <div className="controls">
          <button
            className="reload-btn"
            onClick={() => {
              if (h5fileRef.current) {
                h5fileRef.current.close();
                h5fileRef.current = null;
              }
              browserFileRef.current = null;
              eventDataRef.current = new Map();
              setFileName("");
              setFileType("unknown");
              setPanels([]);
              setLauetofPanels([]);
              setDetectorImages([]);
              setTofRange([0, 0]);
              setTofAbsMin(0);
              setTofAbsMax(0);
              setDomainMin("");
              setDomainMax("");
              setStatus("");
            }}
            title="Load a different file"
          >
            &#x1F4C2; New File
          </button>
          <button
            className="reload-btn"
            onClick={handleReload}
            disabled={loading}
            title="Reload file (for SWMR / live data)"
          >
            &#x21bb; Reload
          </button>
          <div className="control-group">
            <label>View:</label>
            <select
              value={viewMode === "overview" ? "overview" : String(viewMode)}
              onChange={(e) => {
                const v = e.target.value;
                setViewMode(v === "overview" ? "overview" : Number(v));
              }}
            >
              <option value="overview">Overview</option>
              {(fileType === "NXlauetof" ? lauetofPanels : panels).map((p, i) => (
                <option key={p.path} value={i}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div className="control-group">
            <label>Color scale:</label>
            <select
              value={colorScale}
              onChange={(e) => setColorScale(e.target.value as ColorScaleType)}
            >
              <option value={ScaleType.Log}>Log</option>
              <option value={ScaleType.Linear}>Linear</option>
              <option value={ScaleType.SymLog}>SymLog</option>
              <option value={ScaleType.Sqrt}>Sqrt</option>
            </select>
          </div>
          {fileType === "NXlauetof" && (
            <span className="filetype-badge">NXLaueTOF</span>
          )}
          <button
            className="help-btn"
            onClick={() => setShowHelp((v) => !v)}
            title="Help (H)"
          >
            ?
          </button>
        </div>
      </header>

      <main className="app-main">
        {detectorImages.length > 0 && (
          <>
            <div className="detector-panels-row">
              {imageComputing && (
                <div className="computing-overlay">Recomputing...</div>
              )}
              {(fileType === "NXlauetof" ? lauetofPanels : panels)
                .map((panel, i) => ({ panel, i }))
                .filter(({ i }) => viewMode === "overview" || i === viewMode)
                .map(({ panel, i }) => {
                  const img = detectorImages[i];
                  if (!img) return null;
                  return (
                    <DetectorImage
                      key={panel.path}
                      imageResult={img}
                      panelName={panel.name}
                      colorScale={colorScale}
                      size={chartSize}
                      domain={sharedDomain}
                      singlePanel={viewMode !== "overview"}
                    />
                  );
                })}
              <div className="shared-colorbar" style={{ height: chartSize }}>
                <input
                  type="number"
                  className="colorbar-domain-input colorbar-domain-max"
                  value={domainMax}
                  placeholder={String(Math.round(sharedDomain[1]))}
                  title="Color bar max"
                  onChange={(e) => setDomainMax(e.target.value)}
                />
                <div className="colorbar-gradient-wrapper">
                  <ViridisColorBar width={30} height={chartSize - 70} />
                </div>
                <input
                  type="number"
                  className="colorbar-domain-input colorbar-domain-min"
                  value={domainMin}
                  placeholder={String(Math.round(sharedDomain[0]))}
                  title="Color bar min"
                  onChange={(e) => setDomainMin(e.target.value)}
                />
                <button
                  className="colorbar-auto-btn"
                  onClick={handleAutoDomain}
                  title="Reset to optimal range (µ + 2σ)"
                >
                  Auto
                </button>
              </div>
            </div>
            <TofRangeSlider
              tofMin={tofAbsMin}
              tofMax={tofAbsMax}
              tofRange={tofRange}
              onTofRangeChange={handleTofRangeChange}
              unit={tofUnit}
              forceWindowMode={fileType === "NXlauetof"}
              fixedWindowWidthNs={
                fileType === "NXlauetof" && lauetofPanels.length > 0 && lauetofPanels[0].tofBins.length > 1
                  ? lauetofPanels[0].tofBins[1] - lauetofPanels[0].tofBins[0]
                  : undefined
              }
              snapValuesNs={
                fileType === "NXlauetof" && lauetofPanels.length > 0
                  ? Array.from(lauetofPanels[0].tofBins)
                  : undefined
              }
            />
          </>
        )}
      </main>

      <div className="status-bar">{status}</div>

      {showHelp && (
        <div className="help-overlay" onClick={() => setShowHelp(false)}>
          <div className="help-modal" onClick={(e) => e.stopPropagation()}>
            <button className="help-close" onClick={() => setShowHelp(false)}>✕</button>
            <h2>NMX Event Data Viewer — Help</h2>
            <h3>Loading Data</h3>
            <ul>
              <li>Drag & drop an HDF5/NeXus file onto the drop zone, or click to browse</li>
              <li>Supported formats: <strong>NXevent_data</strong> (raw events) and <strong>NXLaueTOF</strong> (pre-binned)</li>
              <li>Use <strong>↻ Reload</strong> to re-read the file (useful for SWMR live data)</li>
              <li>Use <strong>📂 New File</strong> to load a different file</li>
            </ul>
            <h3>TOF Slider</h3>
            <ul>
              <li>Drag the two thumbs to set a TOF range for filtering events</li>
              <li>Enable <strong>Window</strong> mode to lock the range width and slide it as a unit</li>
              <li>In window mode, press <strong>← / →</strong> arrow keys to step by one window width</li>
              <li>For NXLaueTOF files, the slider snaps to TOF bin centers</li>
            </ul>
            <h3>Views</h3>
            <ul>
              <li><strong>Overview</strong>: all detector panels side by side</li>
              <li><strong>Single panel</strong>: select a panel from the View dropdown for a larger view with zoom</li>
            </ul>
            <h3>Zoom (Single Panel View)</h3>
            <ul>
              <li><strong>Click & drag</strong> to draw a selection box and zoom in</li>
              <li><strong>Shift + drag</strong> to pan</li>
              <li>Click <strong>Reset Zoom</strong> to return to the full view</li>
            </ul>
            <h3>Color Scale</h3>
            <ul>
              <li>Choose scale type (Linear, Log, SymLog, Sqrt) from the dropdown</li>
              <li>Type values in the <strong>Min / Max</strong> inputs on the color bar to override the range</li>
              <li>Click <strong>Auto</strong> to reset to the optimal range (µ&nbsp;+&nbsp;2σ outlier rejection)</li>
            </ul>
            <p className="help-shortcut">Press <kbd>H</kbd> to toggle this help</p>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
