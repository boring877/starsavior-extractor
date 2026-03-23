import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useExtraction } from "./hooks/useExtraction";
import "./styles.css";

type Tab = "images" | "data";

export default function App() {
  const { status, running, logs, doFullExtract, doDecryptBundles, doDecryptTemplets, doExtractImages, doStop } = useExtraction();
  const [tab, setTab] = useState<Tab>("data");

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-header">
          <h1>StarSavior</h1>
          <div className="subtitle">Extractor</div>
        </div>

        <nav className="nav-section">
          <div className="nav-section-title">Pipeline</div>
          <button
            className="nav-item full-extract"
            onClick={() => doFullExtract()}
            disabled={running}
          >
            Run Full Extraction
          </button>
        </nav>

        <nav className="nav-section">
          <div className="nav-section-title">Steps</div>
          <button className="nav-item" onClick={() => doDecryptBundles(false)} disabled={running}>
            1. Decrypt Bundles
          </button>
          <button className="nav-item" onClick={() => doDecryptTemplets()} disabled={running}>
            2. Decrypt Templets
          </button>
          <button className="nav-item" onClick={() => doExtractImages(false)} disabled={running}>
            3. Extract Images
          </button>
        </nav>

        <nav className="nav-section">
          <div className="nav-section-title">Browse</div>
          <button
            className={`nav-item ${tab === "data" ? "active" : ""}`}
            onClick={() => setTab("data")}
          >
            Data
          </button>
          <button
            className={`nav-item ${tab === "images" ? "active" : ""}`}
            onClick={() => setTab("images")}
          >
            Images
          </button>
        </nav>

        <div className="sidebar-footer">
          <div className="status-row">
            <span className={`status-dot ${running ? "running" : "idle"}`} />
            <span className="status-text">{running ? status : "Idle"}</span>
            {running && <button className="btn-stop" onClick={doStop}>Stop</button>}
          </div>
        </div>
      </aside>

      <div className="main-content">
        {tab === "data" && <DataPanel />}
        {tab === "images" && <ImagesPanel />}
        <div className="log-panel">
          <div className="log-header">Output</div>
          <div className="log-content">
            {logs.map((line, i) => (
              <div key={i} className={`log-line ${line.startsWith("ERROR") ? "error" : ""}`}>
                {line}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function DataPanel() {
  return (
    <div className="content-area">
      <div className="content-header">
        <h2>Game Data</h2>
        <p>Decrypted templet tables (stats, skills, characters, localization)</p>
      </div>
      <div className="content-scroll">
        <TempletGrid />
      </div>
    </div>
  );
}

function ImagesPanel() {
  return (
    <div className="content-area">
      <div className="content-header">
        <h2>Images</h2>
        <p>Extracted textures and sprites from game bundles</p>
      </div>
      <div className="content-scroll">
        <ImageSummary />
      </div>
    </div>
  );
}

function TempletGrid() {
  const [items, setItems] = useState<{ name: string; size: number }[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await invoke<{ name: string; size: number }[]>("list_templets");
      setItems(data);
    } catch (e) {
      console.error("Failed to list templets", e);
    }
    setLoading(false);
  };

  return (
    <div>
      <div className="toolbar">
        <input
          className="search-input"
          placeholder="Filter templets... (e.g. STAT, SKILL, UNIT)"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button className="btn btn-secondary" onClick={load} disabled={loading}>
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>
      <div className="templet-count">{items.length} templet files</div>
      <div className="templet-grid">
        {items
          .filter((i) => !filter || i.name.toUpperCase().includes(filter.toUpperCase()))
          .slice(0, 200)
          .map((item) => (
            <div key={item.name} className="templet-card">
              <div className="templet-name">{item.name}</div>
              <div className="templet-size">{(item.size / 1024).toFixed(1)} KB</div>
            </div>
          ))}
      </div>
    </div>
  );
}

function ImageSummary() {
  return (
    <div className="info-grid">
      <InfoCard title="Textures" desc="1,613 folders" />
      <InfoCard title="Sprites" desc="557 folders" />
      <div className="info-box">
        <strong>Browse on disk</strong>
        <p>Images are saved as PNG files in the output directory.</p>
        <div className="path-info">
          <span className="path-label">Textures:</span> D:\starsavior-extractor\output\textures\
        </div>
        <div className="path-info">
          <span className="path-label">Sprites:</span> D:\starsavior-extractor\output\sprites\
        </div>
      </div>
    </div>
  );
}

function InfoCard({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="info-box">
      <strong>{title}</strong>
      <p>{desc}</p>
    </div>
  );
}
