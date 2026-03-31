import { useState, useCallback, useRef, useEffect } from "react";
import "@h5web/lib/dist/styles.css";
import { ScaleType } from "@h5web/lib";
import type { ColorScaleType } from "@h5web/lib";
import { FileLoader } from "./components/FileLoader";
import { DetectorImage } from "./components/DetectorImage";
import { TofRangeSlider } from "./components/TofRangeSlider";
import {
  openFile,
  findDetectorPanels,
  readEventData,
  type DetectorPanelInfo,
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

function useChartSize() {
  const [size, setSize] = useState(() => {
    const s = Math.min(
      window.innerWidth - 40,
      window.innerHeight - CHROME_HEIGHT
    );
    return Math.max(s, 200);
  });

  useEffect(() => {
    const onResize = () => {
      const s = Math.min(
        window.innerWidth - 40,
        window.innerHeight - CHROME_HEIGHT
      );
      setSize(Math.max(s, 200));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return size;
}

function App() {
  const chartSize = useChartSize();
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [panels, setPanels] = useState<DetectorPanelInfo[]>([]);
  const [selectedPanel, setSelectedPanel] = useState(0);
  const [detectorImage, setDetectorImage] =
    useState<DetectorImageResult | null>(null);
  const [tofRange, setTofRange] = useState<[number, number]>([0, 0]);
  const [tofUnit, setTofUnit] = useState("µs");
  const [tofAbsMin, setTofAbsMin] = useState(0);
  const [tofAbsMax, setTofAbsMax] = useState(0);
  const [colorScale, setColorScale] = useState<ColorScaleType>(ScaleType.Log);
  const [numBins] = useState(500);
  const [imageComputing, setImageComputing] = useState(false);
  const [domainMin, setDomainMin] = useState<string>("");
  const [domainMax, setDomainMax] = useState<string>("");

  const h5fileRef = useRef<H5File | null>(null);
  const eventDataRef = useRef<Map<number, EventData>>(new Map());
  const browserFileRef = useRef<File | null>(null);

  const handleFileLoaded = useCallback(
    async (file: File) => {
      setLoading(true);
      setStatus("Opening HDF5 file...");
      try {
        browserFileRef.current = file;
        const h5file = await openFile(file);
        h5fileRef.current = h5file;

        setStatus("Scanning for detector panels...");
        const foundPanels = findDetectorPanels(h5file);

        if (foundPanels.length === 0) {
          setStatus("No NXEventData detector panels found in this file.");
          setLoading(false);
          return;
        }

        setPanels(foundPanels);
        setSelectedPanel(0);
        eventDataRef.current = new Map();

        // Load first panel
        setStatus(
          `Reading event data from ${foundPanels[0].name} (${foundPanels[0].numEvents.toLocaleString()} events)...`
        );
        const ed = readEventData(h5file, foundPanels[0].path);
        eventDataRef.current.set(0, ed);

        const hist = computeTofHistogram(ed, numBins);
        const initialRange: [number, number] = [hist.tofMin, hist.tofMax];
        setTofRange(initialRange);
        setTofAbsMin(hist.tofMin);
        setTofAbsMax(hist.tofMax);

        setStatus("Computing detector image...");
        const img = computeDetectorImage(ed, initialRange);
        setDetectorImage(img);

        setStatus(
          `Loaded ${foundPanels[0].name}: ${foundPanels[0].numEvents.toLocaleString()} events`
        );
      } catch (err) {
        setStatus(`Error: ${(err as Error).message}`);
        console.error(err);
      } finally {
        setLoading(false);
      }
    },
    [numBins]
  );

  const handlePanelChange = useCallback(
    async (panelIdx: number) => {
      if (!h5fileRef.current) return;
      setSelectedPanel(panelIdx);
      setImageComputing(true);
      setStatus(`Loading ${panels[panelIdx].name}...`);

      try {
        let ed = eventDataRef.current.get(panelIdx);
        if (!ed) {
          ed = readEventData(h5fileRef.current, panels[panelIdx].path);
          eventDataRef.current.set(panelIdx, ed);
        }

        const hist = computeTofHistogram(ed, numBins);
        const range: [number, number] = [hist.tofMin, hist.tofMax];
        setTofRange(range);
        setTofAbsMin(hist.tofMin);
        setTofAbsMax(hist.tofMax);

        const img = computeDetectorImage(ed, range);
        setDetectorImage(img);

        setStatus(
          `${panels[panelIdx].name}: ${panels[panelIdx].numEvents.toLocaleString()} events`
        );
      } catch (err) {
        setStatus(`Error: ${(err as Error).message}`);
      } finally {
        setImageComputing(false);
      }
    },
    [panels, numBins]
  );

  const handleReload = useCallback(async () => {
    if (!browserFileRef.current) return;
    setLoading(true);
    setStatus("Reloading file...");
    try {
      // Close existing h5 file
      if (h5fileRef.current) {
        h5fileRef.current.close();
        h5fileRef.current = null;
      }
      // Re-read the browser File (picks up new SWMR data)
      const file = browserFileRef.current;
      const h5file = await openFile(file);
      h5fileRef.current = h5file;

      const foundPanels = findDetectorPanels(h5file);
      if (foundPanels.length === 0) {
        setStatus("No NXEventData detector panels found after reload.");
        setLoading(false);
        return;
      }

      setPanels(foundPanels);
      // Clear cached event data so panels are re-read
      eventDataRef.current = new Map();

      // Reload the currently selected (or first) panel
      const idx = Math.min(selectedPanel, foundPanels.length - 1);
      setSelectedPanel(idx);

      setStatus(
        `Re-reading ${foundPanels[idx].name} (${foundPanels[idx].numEvents.toLocaleString()} events)...`
      );
      const ed = readEventData(h5file, foundPanels[idx].path);
      eventDataRef.current.set(idx, ed);

      const hist = computeTofHistogram(ed, numBins);
      const range: [number, number] = [hist.tofMin, hist.tofMax];
      setTofRange(range);
      setTofAbsMin(hist.tofMin);
      setTofAbsMax(hist.tofMax);

      const img = computeDetectorImage(ed, range);
      setDetectorImage(img);

      setStatus(
        `Reloaded ${foundPanels[idx].name}: ${foundPanels[idx].numEvents.toLocaleString()} events`
      );
    } catch (err) {
      setStatus(`Reload error: ${(err as Error).message}`);
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [selectedPanel, numBins]);

  const handleTofRangeChange = useCallback(
    (range: [number, number]) => {
      setTofRange(range);
      const panelEd = eventDataRef.current.get(selectedPanel);
      if (!panelEd) return;
      setImageComputing(true);
      // Use setTimeout to let the UI update before heavy computation
      setTimeout(() => {
        const img = computeDetectorImage(panelEd, range);
        setDetectorImage(img);
        setImageComputing(false);
        setStatus(
          `${panels[selectedPanel]?.name}: ${img.totalEvents.toLocaleString()} events in TOF range`
        );
      }, 0);
    },
    [selectedPanel, panels]
  );

  // If no file loaded yet, show file loader
  if (panels.length === 0) {
    return (
      <div className="app">
        <FileLoader onFileLoaded={handleFileLoaded} loading={loading} />
        {status && <div className="status-bar">{status}</div>}
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>NMX Event Data Viewer</h1>
        <div className="controls">
          <button
            className="reload-btn"
            onClick={handleReload}
            disabled={loading}
            title="Reload file (for SWMR / live data)"
          >
            &#x21bb; Reload
          </button>
          <div className="control-group">
            <label>Panel:</label>
            <select
              value={selectedPanel}
              onChange={(e) => handlePanelChange(Number(e.target.value))}
            >
              {panels.map((p, i) => (
                <option key={p.path} value={i}>
                  {p.name} ({p.numEvents.toLocaleString()} events)
                </option>
              ))}
            </select>
          </div>
          <div className="control-group">
            <label>TOF unit:</label>
            <select value={tofUnit} onChange={(e) => setTofUnit(e.target.value)}>
              <option value="ns">ns</option>
              <option value="µs">µs</option>
              <option value="ms">ms</option>
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

        </div>
      </header>

      <main className="app-main">
        {detectorImage && (
          <>
            <div className="detector-panel-wrapper">
              {imageComputing && (
                <div className="computing-overlay">Recomputing...</div>
              )}
              <DetectorImage
                imageResult={detectorImage}
                panelName={panels[selectedPanel].name}
                colorScale={colorScale}
                size={chartSize}
                userDomain={[
                  domainMin !== "" ? Number(domainMin) : null,
                  domainMax !== "" ? Number(domainMax) : null,
                ]}
                domainMinStr={domainMin}
                domainMaxStr={domainMax}
                onDomainChange={(which, val) =>
                  which === "min" ? setDomainMin(val) : setDomainMax(val)
                }
              />
            </div>
            <TofRangeSlider
              tofMin={tofAbsMin}
              tofMax={tofAbsMax}
              tofRange={tofRange}
              onTofRangeChange={handleTofRangeChange}
              unit={tofUnit}
            />
          </>
        )}
      </main>

      <div className="status-bar">{status}</div>
    </div>
  );
}

export default App;
