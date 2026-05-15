// ── React components ── depends on helpers.js, geo.js, graph.js ──────────────

function WeightSliders({ weights, onChange }) {
  const rows = [
    { key: 'temporal', color: '#5b8dd9', label: 'Temporal' },
    { key: 'spatial',  color: '#5dbb7d', label: 'Spatial'  },
    { key: 'material', color: '#e0994a', label: 'Material' },
  ];
  return (
    <div className="ctrl-section">
      <p className="ctrl-label">Edge strength weights</p>
      {rows.map(({ key, color, label }) => (
        <div key={key} className="slider-row">
          <span className="dot" style={{ background: color }} />
          <span className="slider-type-label">{label}</span>
          <input type="range" min="0" max="1" step="0.05" value={weights[key]}
            onChange={e => onChange({ ...weights, [key]: parseFloat(e.target.value) })} />
          <span className="slider-val">{weights[key].toFixed(2)}</span>
        </div>
      ))}
    </div>
  );
}

function ArtifactSearch({ allNodes, onApply, onReset, hint }) {
  const [query, setQuery]  = React.useState('');
  const [focusId, setFocus] = React.useState('');
  const [k, setK]          = React.useState(5);
  const filtered = React.useMemo(() => {
    if (!query || query.length < 2) return [];
    const q = query.toLowerCase();
    return (allNodes || []).filter(n => n.label.toLowerCase().includes(q)).slice(0, 8);
  }, [query, allNodes]);

  return (
    <div className="ctrl-section">
      <p className="ctrl-label">K-nearest to artifact</p>
      <input className="artifact-select" placeholder="Search artifact…" value={query}
        onChange={e => { setQuery(e.target.value); setFocus(''); }} />
      {filtered.length > 0 && (
        <div className="search-dropdown">
          {filtered.map(n => (
            <div key={n.id} className={`search-item${focusId === n.id ? ' active' : ''}`}
              onClick={() => { setFocus(n.id); setQuery(n.label); }}>
              {trunc(n.label, 42)}
            </div>
          ))}
        </div>
      )}
      <div className="knear-row" style={{ marginTop: 6 }}>
        <span className="k-label">K =</span>
        <input type="number" min="1" max="99" value={k}
          onChange={e => setK(Math.max(1, parseInt(e.target.value) || 5))} className="k-input" />
        <button className="btn" onClick={() => { if (focusId) onApply(focusId, k); }}>Apply</button>
        <button className="btn" onClick={() => { setFocus(''); setQuery(''); onReset(); }}>Reset</button>
      </div>
      <p className="knear-hint">{hint}</p>
    </div>
  );
}

function ClusterList({ artifacts, onSelect }) {
  return (
    <div>
      <p className="field-label">{artifacts.length} artifacts at this location</p>
      {artifacts.map(art => (
        <div key={art.id} className="cluster-item" onClick={() => onSelect(art)}>
          <p className="cluster-item-label">{art.label || art.id}</p>
          {art.era?.name && <p className="cluster-item-era">{art.era.name}</p>}
        </div>
      ))}
    </div>
  );
}

function ArtifactDetail({ artifact, fetchedDetail, fetchLoading, chosenIdx, onChooseImage }) {
  const [lightboxSrc, setLightboxSrc] = React.useState(null);
  if (!artifact) return <p className="placeholder">Click a node to explore its connections.</p>;

  const era = artifact.era || {};
  const loc = artifact.location || {};
  const eraStr = era.year_start != null
    ? `${era.name ? era.name + ' · ' : ''}${fmtYear(era.year_start)} – ${fmtYear(era.year_end)}`
    : (era.name || 'Unknown era');

  const images = fetchedDetail?.images?.length ? fetchedDetail.images
               : artifact.images?.length       ? artifact.images
               : [];
  const description = fetchedDetail?.description || artifact.description || '';

  return (
    <div>
      <h2>{artifact.label || artifact.id}</h2>
      {artifact.project && <p className="field-value" style={{fontSize:'0.74rem',color:'#777',marginBottom:4}}>{artifact.project}</p>}
      <span className="era-badge">{eraStr}</span>
      {description && <><p className="field-label">Description</p><p className="field-value">{description}</p></>}
      {artifact.material?.length > 0 && <>
        <p className="field-label">Material</p>
        <p className="field-value">{artifact.material.map((m, i) => <span key={i} className="material-pill">{m}</span>)}</p>
      </>}
      {loc.lat != null && <>
        <p className="field-label">Location</p>
        <p className="field-value">
          {[loc.site, loc.region].filter(Boolean).join(', ') || ''}
          <span className="coords">{loc.lat.toFixed(4)}, {loc.lng.toFixed(4)}</span>
        </p>
      </>}
      {artifact.function && <><p className="field-label">Function</p><p className="field-value">{artifact.function}</p></>}
      {fetchLoading && <p className="knear-hint" style={{marginTop:8}}>Loading images…</p>}
      {images.length > 0 && <>
        <p className="field-label">Images <span className="img-hint">(click = node · double-click = zoom)</span></p>
        <div className="image-strip">
          {images.map((p, i) => (
            <img key={i} src={imgSrc(p)} alt="" className={i === chosenIdx ? 'chosen' : ''}
              onError={e => { e.target.style.display = 'none'; }}
              onClick={() => onChooseImage(artifact.id, i)}
              onDoubleClick={() => setLightboxSrc(imgSrc(p))} />
          ))}
        </div>
      </>}
      {artifact.url && <><p className="field-label">Source</p>
        <a href={artifact.url} target="_blank" rel="noopener">{artifact.url}</a></>}
      {lightboxSrc && <div className="lightbox" onClick={() => setLightboxSrc(null)}>
        <img src={lightboxSrc} alt="artifact" /></div>}
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────
function App() {
  const [graphData, setGraphData]       = React.useState(null);
  const [loadError, setLoadError]       = React.useState(null);
  const [selectedArtifact, setSelected] = React.useState(null);
  const [clusterList, setClusterList]   = React.useState(null);
  const [weights, setWeights]           = React.useState({ temporal: 1, spatial: 1, material: 1 });
  const [globalK, setGlobalK]           = React.useState(10);
  const [kHint, setKHint]               = React.useState('Search and apply to highlight.');
  const [chosenImages, setChosenImages] = React.useState({});
  const [geoPin, setGeoPin]             = React.useState(false);
  const [showArrows, setShowArrows]     = React.useState(false);
  const [fetchedDetails, setFetchedDetails] = React.useState({});
  const [fetchLoading, setFetchLoading]     = React.useState(false);
  const [visibleCount, setVisibleCount]     = React.useState(INITIAL_DISPLAY);

  const svgRef         = React.useRef(null);
  const d3Ref          = React.useRef({});
  const weightsRef     = React.useRef(weights);    weightsRef.current     = weights;
  const globalKRef     = React.useRef(globalK);    globalKRef.current     = globalK;
  const geoPinRef      = React.useRef(false);      geoPinRef.current      = geoPin;
  const showArrowsRef  = React.useRef(false);      showArrowsRef.current  = showArrows;

  const cfg = React.useRef(null);
  cfg.current = {
    d3State: d3Ref, weightsRef, globalKRef, geoPinRef, showArrowsRef,
    onNodeClick: (data, nodeId) => {
      if (!data) { setSelected(null); setClusterList(null); return; }
      setSelected(data);
      setClusterList(null);
      if (!data.images?.length && data.url) {
        setFetchLoading(true);
        fetchArtifactDetail(data.url).then(detail => {
          if (detail) setFetchedDetails(prev => ({ ...prev, [data.id]: detail }));
          setFetchLoading(false);
        });
      }
    },
    onClusterClick: (ids, allNodes) => {
      const arts = ids.map(id => allNodes.find(n => n.id === id)?.data).filter(Boolean);
      setClusterList(arts); setSelected(null);
    },
    setKHint,
  };

  React.useEffect(() => {
    fetch(BASE + 'graph.json')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(data => { setGraphData(data); })
      .catch(e => setLoadError(e.message));
  }, []);

  React.useEffect(() => {
    if (graphData && svgRef.current) initD3(graphData, svgRef.current, cfg.current);
  }, [graphData]);

  React.useEffect(() => {
    handleWeightsKChange(cfg.current);
  }, [weights, globalK]);

  React.useEffect(() => {
    handleShowArrowsChange(showArrows, cfg.current);
  }, [showArrows]);

  React.useEffect(() => {
    handleGeoPinChange(geoPin, cfg.current);
  }, [geoPin]);

  // Track visible node count for display
  React.useEffect(() => {
    const interval = setInterval(() => {
      const count = d3Ref.current.visibleIds?.size;
      if (count != null) setVisibleCount(count);
    }, 500);
    return () => clearInterval(interval);
  }, []);

  function handleChooseImage(artifactId, index) {
    setChosenImages(prev => ({ ...prev, [artifactId]: index }));
    const images = fetchedDetails[artifactId]?.images || selectedArtifact?.images || [];
    const p = images[index];
    d3Ref.current.nodeSel?.filter(d => d.id === artifactId).select('image')
      .attr('href', p ? imgSrc(p) : '');
  }

  function applyKFilter(focusId, k) {
    const { nodeSel, linkSel, allData } = d3Ref.current;
    if (!nodeSel || !linkSel || !allData) return;
    const w = weightsRef.current;
    const scores = {};
    allData.links.forEach(l => {
      const s = typeof l.source === 'object' ? l.source.id : l.source;
      const t = typeof l.target === 'object' ? l.target.id : l.target;
      const cw = combinedWeight(l, w);
      if (s === focusId) scores[t] = Math.max(scores[t] ?? 0, cw);
      if (t === focusId) scores[s] = Math.max(scores[s] ?? 0, cw);
    });
    const topK = Object.entries(scores).sort((a, b) => b[1] - a[1]).slice(0, k).map(e => e[0]);
    const keep = new Set([focusId, ...topK]);
    nodeSel.classed('dimmed', d => !keep.has(d.id));
    linkSel.classed('dimmed', d => {
      const s = typeof d.source === 'object' ? d.source.id : d.source;
      const t = typeof d.target === 'object' ? d.target.id : d.target;
      return !keep.has(s) || !keep.has(t);
    });
    const name = allData.nodes.find(n => n.id === focusId)?.label || focusId;
    setKHint(`Showing ${topK.length} neighbor(s) of "${trunc(name, 28)}".`);
  }

  function resetKFilter() {
    d3Ref.current.nodeSel?.classed('dimmed', false);
    d3Ref.current.linkSel?.classed('dimmed', false);
    setKHint('Search and apply to highlight.');
  }

  if (loadError) return (
    <div style={{ padding: 24, color: '#c55' }}>
      <p>Could not load graph.json: {loadError}</p>
      <p style={{ marginTop: 10, color: '#888' }}>Run <code>python serve.py</code>, then open <code>http://localhost:8765/ui/</code></p>
    </div>
  );

  const selId     = selectedArtifact?.id;
  const chosenIdx = selId ? (chosenImages[selId] ?? 0) : 0;
  const totalNodes = graphData?.nodes?.length ?? 0;

  return (
    <>
      <div id="sidebar">
        <h1>Artifact Graph</h1>
        <div id="controls">
          <WeightSliders weights={weights} onChange={setWeights} />
          <div className="ctrl-section">
            <p className="ctrl-label">Max edges per node</p>
            <div className="knear-row">
              <span className="k-label">K =</span>
              <input type="number" min="1" max="99" value={globalK}
                onChange={e => setGlobalK(Math.max(1, parseInt(e.target.value) || 10))}
                className="k-input" />
            </div>
            <p className="knear-hint">Each node shows its K strongest edges.</p>
          </div>
          <div className="ctrl-section">
            <p className="ctrl-label">Display</p>
            <div className="knear-row">
              <span className="knear-hint" style={{flex:1}}>Showing {visibleCount} / {totalNodes} artifacts</span>
              <button className="btn" onClick={() => resampleNodes(cfg.current)}>Resample</button>
            </div>
            <p className="knear-hint">Click a node to expand its neighbourhood.</p>
          </div>
          <div className="ctrl-section">
            <p className="ctrl-label">Geographic layout</p>
            <label className="geo-toggle">
              <input type="checkbox" checked={geoPin} onChange={e => setGeoPin(e.target.checked)} />
              <span>Pin nodes to map coordinates</span>
            </label>
            <p className="knear-hint">Zoom in to split clusters.</p>
          </div>
          <div className="ctrl-section">
            <p className="ctrl-label">Temporal direction</p>
            <label className="geo-toggle">
              <input type="checkbox" checked={showArrows} onChange={e => setShowArrows(e.target.checked)} />
              <span>Show arrows (older → newer)</span>
            </label>
          </div>
          <ArtifactSearch allNodes={graphData?.nodes} onApply={applyKFilter} onReset={resetKFilter} hint={kHint} />
        </div>
        <div id="detail">
          {clusterList
            ? <ClusterList artifacts={clusterList} onSelect={art => { setSelected(art); setClusterList(null); }} />
            : <ArtifactDetail artifact={selectedArtifact}
                fetchedDetail={selId ? fetchedDetails[selId] : null}
                fetchLoading={fetchLoading}
                chosenIdx={chosenIdx} onChooseImage={handleChooseImage} />
          }
        </div>
      </div>
      <div id="graph-container"><svg ref={svgRef} /></div>
    </>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
