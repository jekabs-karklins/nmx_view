import React, { useCallback } from "react";

interface FileLoaderProps {
  onFileLoaded: (file: File) => void;
  onLoadDemo: () => void;
  loading: boolean;
  progress?: number;
  progressLabel?: string;
}

export const FileLoader: React.FC<FileLoaderProps> = ({
  onFileLoaded,
  onLoadDemo,
  loading,
  progress = 0,
  progressLabel = "",
}) => {
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const file = e.dataTransfer.files[0];
      if (file) onFileLoaded(file);
    },
    [onFileLoaded]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) onFileLoaded(file);
    },
    [onFileLoaded]
  );

  return (
    <div
      className="file-loader"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      <div className="file-loader-content">
        <h2>NMX Event Data Viewer</h2>
        <p>Load an HDF5/NeXus file containing NXEventData</p>
        <p>Uses <a href="https://h5web.panosc.eu">h5web</a> to load and process data.</p>
        <p>All processing happens locally in the browser- no remote loading of data!</p>
        {loading ? (
          <div className="loading-progress">
            <div className="progress-bar-container">
              <div
                className="progress-bar-fill"
                style={{ width: `${Math.min(progress, 100)}%` }}
              />
            </div>
            <p className="progress-label">{progressLabel || "Loading file..."}</p>
            <p className="progress-percent">{Math.round(progress)}%</p>
          </div>
        ) : (
          <>
            <div className="drop-zone">
              <p>Drag & drop an HDF5 file here</p>
              <p>or</p>
              <label className="file-input-label">
                Browse files
                <input
                  type="file"
                  accept=".h5,.hdf5,.nxs,.nx5,.nxspe"
                  onChange={handleFileInput}
                  hidden
                />
              </label>
            </div>
            <div className="demo-section">
              <p>No file? Try the interactive demo:</p>
              <button className="demo-button" onClick={onLoadDemo}>
                Load Demo Data
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
