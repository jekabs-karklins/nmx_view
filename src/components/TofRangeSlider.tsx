import React, { useState, useCallback, useRef, useEffect } from "react";

interface TofRangeSliderProps {
  tofMin: number; // absolute min (ns)
  tofMax: number; // absolute max (ns)
  tofRange: [number, number]; // current selection (ns)
  onTofRangeChange: (range: [number, number]) => void;
  unit?: string; // "ns" | "µs" | "ms"
  /** Force window mode on (for NXlauetof) */
  forceWindowMode?: boolean;
  /** Fixed window width in ns (for NXlauetof — 1 bin spacing) */
  fixedWindowWidthNs?: number;
  /** TOF bin centers in ns — slider snaps to these values */
  snapValuesNs?: number[];
}

export const TofRangeSlider: React.FC<TofRangeSliderProps> = ({
  tofMin,
  tofMax,
  tofRange,
  onTofRangeChange,
  unit = "ns",
  forceWindowMode = false,
  fixedWindowWidthNs,
  snapValuesNs,
}) => {
  const displayScale = unit === "µs" ? 1e-3 : unit === "ms" ? 1e-6 : 1;

  // Snap a value in ns to the nearest snap point
  const snapNs = useCallback(
    (ns: number): number => {
      if (!snapValuesNs || snapValuesNs.length === 0) return ns;
      let best = snapValuesNs[0];
      let bestDist = Math.abs(ns - best);
      for (let i = 1; i < snapValuesNs.length; i++) {
        const dist = Math.abs(ns - snapValuesNs[i]);
        if (dist < bestDist) {
          best = snapValuesNs[i];
          bestDist = dist;
        }
      }
      return best;
    },
    [snapValuesNs]
  );

  const [localRange, setLocalRange] = useState<[number, number]>(tofRange);
  const [windowEnabled, setWindowEnabled] = useState(forceWindowMode);
  const [windowWidth, setWindowWidth] = useState<number>(
    fixedWindowWidthNs ? fixedWindowWidthNs * displayScale : 3000
  );
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync forceWindowMode changes
  useEffect(() => {
    if (forceWindowMode) setWindowEnabled(true);
  }, [forceWindowMode]);

  // Sync fixedWindowWidth changes
  useEffect(() => {
    if (fixedWindowWidthNs != null) {
      setWindowWidth(fixedWindowWidthNs * displayScale);
    }
  }, [fixedWindowWidthNs, displayScale]);

  useEffect(() => {
    setLocalRange(tofRange);
  }, [tofRange]);

  const commitRange = useCallback(
    (range: [number, number]) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        onTofRangeChange(range);
      }, 250);
    },
    [onTofRangeChange]
  );

  // Clamp a range to [tofMin, tofMax]
  const clampRange = useCallback(
    (lo: number, hi: number): [number, number] => [
      Math.max(tofMin, Math.min(lo, tofMax)),
      Math.min(tofMax, Math.max(hi, tofMin)),
    ],
    [tofMin, tofMax]
  );

  // Handle individual min/max thumb changes (free mode)
  const handleChange = useCallback(
    (idx: 0 | 1, displayValue: number) => {
      let nsValue = displayValue / displayScale;
      nsValue = snapNs(nsValue);
      const newRange: [number, number] = [...localRange];
      newRange[idx] = nsValue;
      if (newRange[0] > newRange[1]) {
        if (idx === 0) newRange[0] = newRange[1];
        else newRange[1] = newRange[0];
      }
      const clamped = clampRange(newRange[0], newRange[1]);
      setLocalRange(clamped);
      commitRange(clamped);
    },
    [localRange, displayScale, clampRange, commitRange, snapNs]
  );

  // Handle center slider change (window mode)
  const handleCenterChange = useCallback(
    (displayCenter: number) => {
      if (windowWidth === null) return;
      const widthNs = windowWidth / displayScale;
      let centerNs = displayCenter / displayScale;
      centerNs = snapNs(centerNs);
      let lo = centerNs - widthNs / 2;
      let hi = centerNs + widthNs / 2;
      if (lo < tofMin) {
        lo = tofMin;
        hi = tofMin + widthNs;
      }
      if (hi > tofMax) {
        hi = tofMax;
        lo = tofMax - widthNs;
      }
      const clamped = clampRange(lo, hi);
      setLocalRange(clamped);
      commitRange(clamped);
    },
    [windowWidth, displayScale, tofMin, tofMax, clampRange, commitRange, snapNs]
  );

  // When window width changes, snap the current range to that width
  const handleWindowWidthChange = useCallback(
    (val: string) => {
      const parsed = parseFloat(val);
      if (isNaN(parsed) || parsed <= 0) return;
      setWindowWidth(parsed);
      if (!windowEnabled) return;
      // Snap range: keep current center, apply new width
      const widthNs = parsed / displayScale;
      const currentCenterNs = (localRange[0] + localRange[1]) / 2;
      let lo = currentCenterNs - widthNs / 2;
      let hi = currentCenterNs + widthNs / 2;
      if (lo < tofMin) {
        lo = tofMin;
        hi = tofMin + widthNs;
      }
      if (hi > tofMax) {
        hi = tofMax;
        lo = tofMax - widthNs;
      }
      const clamped = clampRange(lo, hi);
      setLocalRange(clamped);
      commitRange(clamped);
    },
    [windowEnabled, localRange, displayScale, tofMin, tofMax, clampRange, commitRange]
  );

  // Toggle window mode on/off
  const handleWindowToggle = useCallback(
    (checked: boolean) => {
      setWindowEnabled(checked);
      if (checked && windowWidth > 0) {
        const widthNs = windowWidth / displayScale;
        const currentCenterNs = (localRange[0] + localRange[1]) / 2;
        let lo = currentCenterNs - widthNs / 2;
        let hi = currentCenterNs + widthNs / 2;
        if (lo < tofMin) { lo = tofMin; hi = tofMin + widthNs; }
        if (hi > tofMax) { hi = tofMax; lo = tofMax - widthNs; }
        const clamped = clampRange(lo, hi);
        setLocalRange(clamped);
        commitRange(clamped);
      }
    },
    [windowWidth, displayScale, localRange, tofMin, tofMax, clampRange, commitRange]
  );

  // Arrow key handler: shift window by its full width
  const shiftWindow = useCallback(
    (direction: -1 | 1) => {
      if (!windowEnabled || windowWidth <= 0) return;
      const widthNs = windowWidth / displayScale;
      const currentCenter = (localRange[0] + localRange[1]) / 2;
      const newCenter = snapNs(currentCenter + direction * widthNs);
      let lo = newCenter - widthNs / 2;
      let hi = newCenter + widthNs / 2;
      if (lo < tofMin) { lo = tofMin; hi = tofMin + widthNs; }
      if (hi > tofMax) { hi = tofMax; lo = tofMax - widthNs; }
      const clamped = clampRange(lo, hi);
      setLocalRange(clamped);
      commitRange(clamped);
    },
    [windowEnabled, windowWidth, displayScale, localRange, tofMin, tofMax, clampRange, commitRange, snapNs]
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!windowEnabled || windowWidth <= 0) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        shiftWindow(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        shiftWindow(1);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [windowEnabled, windowWidth, shiftWindow]);

  const displayMin = tofMin * displayScale;
  const displayMax = tofMax * displayScale;
  const step = (displayMax - displayMin) / 1000;

  // Percentage positions for the filled track
  const fullRange = displayMax - displayMin || 1;
  const loPercent =
    ((localRange[0] * displayScale - displayMin) / fullRange) * 100;
  const hiPercent =
    ((localRange[1] * displayScale - displayMin) / fullRange) * 100;

  const isWindowMode = windowEnabled && windowWidth > 0;
  const centerDisplay = ((localRange[0] + localRange[1]) / 2) * displayScale;

  return (
    <div className="tof-slider-panel">
      <div className="tof-slider-row">
        <span className="tof-label">TOF ({unit}):</span>
        <input
          type="number"
          className="tof-number"
          value={(localRange[0] * displayScale).toFixed(1)}
          step={step}
          onChange={(e) => handleChange(0, parseFloat(e.target.value) || 0)}
        />
        <div className="dual-range-container">
          <div
            className="dual-range-track-fill"
            style={{
              left: `${loPercent}%`,
              width: `${hiPercent - loPercent}%`,
              cursor: isWindowMode ? "grab" : undefined,
            }}
          />
          {isWindowMode ? (
            <input
              type="range"
              className="dual-range-input center-slider"
              min={displayMin}
              max={displayMax}
              step={step}
              value={centerDisplay}
              onChange={(e) =>
                handleCenterChange(parseFloat(e.target.value))
              }
            />
          ) : (
            <>
              <input
                type="range"
                className="dual-range-input"
                min={displayMin}
                max={displayMax}
                step={step}
                value={localRange[0] * displayScale}
                onChange={(e) =>
                  handleChange(0, parseFloat(e.target.value))
                }
              />
              <input
                type="range"
                className="dual-range-input"
                min={displayMin}
                max={displayMax}
                step={step}
                value={localRange[1] * displayScale}
                onChange={(e) =>
                  handleChange(1, parseFloat(e.target.value))
                }
              />
            </>
          )}
        </div>
        <input
          type="number"
          className="tof-number"
          value={(localRange[1] * displayScale).toFixed(1)}
          step={step}
          onChange={(e) => handleChange(1, parseFloat(e.target.value) || 0)}
        />
        <span className="tof-window-sep">|</span>
        <label className="tof-window-toggle">
          <input
            type="checkbox"
            checked={windowEnabled}
            disabled={forceWindowMode}
            onChange={(e) => handleWindowToggle(e.target.checked)}
          />
          Window:
        </label>
        <input
          type="number"
          className="tof-number tof-window-input"
          value={windowWidth}
          step={step}
          min={0}
          disabled={!windowEnabled || forceWindowMode}
          onChange={(e) => handleWindowWidthChange(e.target.value)}
        />
        <span className="tof-label-small">{unit}</span>
      </div>
    </div>
  );
};
