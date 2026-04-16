// ── constants ─────────────────────────────────────────────────────────────────
const BASE          = new URL("../", window.location.href).href;
const NODE_R        = 11;
const GEO_NODE_R    = 22;
const GEO_CLUSTER_R = 30;
const CLUSTER_THRESHOLD = GEO_CLUSTER_R * 2 + 2; // 28px — guarantees leader separation

let _worldCache = null;
async function fetchWorld() {
  if (_worldCache) return _worldCache;
  const r = await fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json');
  _worldCache = await r.json();
  return _worldCache;
}

// ── math / display helpers ────────────────────────────────────────────────────

function combinedWeight(link, w) {
  let sum = 0, denom = 0;
  if (link.temporal != null) { sum += link.temporal * w.temporal; denom += w.temporal; }
  if (link.spatial  != null) { sum += link.spatial  * w.spatial;  denom += w.spatial;  }
  if (link.material != null) { sum += link.material * w.material; denom += w.material; }
  return denom > 0 ? sum / denom : 0;
}

function temporalMid(node) {
  const era = node?.data?.era;
  if (!era || era.year_start == null || era.year_end == null) return null;
  return (era.year_start + era.year_end) / 2;
}

function fmtYear(y) { return y == null ? '?' : y < 0 ? `${Math.abs(y)} BCE` : `${y} CE`; }
function imgSrc(p)  { return p?.startsWith('http') ? p : BASE + p; }
function trunc(s, n){ return s && s.length > n ? s.slice(0, n - 1) + '…' : (s || ''); }

// ── link helpers ──────────────────────────────────────────────────────────────

function buildKeptLinks(links, w, k) {
  const adj = new Map();
  links.forEach(l => {
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    const key = [s, t].sort().join('|');
    const score = combinedWeight(l, w);
    if (!adj.has(s)) adj.set(s, []);
    if (!adj.has(t)) adj.set(t, []);
    adj.get(s).push({ key, score });
    adj.get(t).push({ key, score });
  });
  const kept = new Set();
  adj.forEach(edges => {
    edges.sort((a, b) => b.score - a.score);
    edges.slice(0, k).forEach(e => kept.add(e.key));
  });
  return kept;
}

function applyLinkDisplay(linkSel, links, w, k, hiddenNodes) {
  const kept = buildKeptLinks(links, w, k);
  linkSel.style('display', d => {
    const s = typeof d.source === 'object' ? d.source.id : d.source;
    const t = typeof d.target === 'object' ? d.target.id : d.target;
    if (hiddenNodes.has(s) || hiddenNodes.has(t)) return 'none';
    if (combinedWeight(d, w) <= 0) return 'none';
    return kept.has([s, t].sort().join('|')) ? null : 'none';
  });
}

// ── geo helpers ───────────────────────────────────────────────────────────────

function pinNodesToGeo(sim, pin, projection) {
  if (!projection) return;
  sim.nodes().forEach(d => {
    const loc = d.data?.location;
    if (pin && loc?.lat != null && loc?.lng != null) {
      const [x, y] = projection([loc.lng, loc.lat]);
      d.fx = x; d.fy = y;
    } else {
      if (!d._dragging) { d.fx = null; d.fy = null; }
    }
  });
}

function computeGeoClusters(nodes, projection, transform) {
  const withPos = [];
  nodes.forEach(n => {
    const loc = n.data?.location;
    if (!loc?.lat) return;
    const [px, py] = projection([loc.lng, loc.lat]);
    withPos.push({ id: n.id, sx: transform.applyX(px), sy: transform.applyY(py) });
  });
  withPos.sort((a, b) => a.sx - b.sx || a.sy - b.sy);

  const memberToLeader = new Map();
  const grid           = new Map();
  const leaderPos      = [];

  withPos.forEach(p => {
    let bestLeader = null, bestDist = Infinity;
    for (const lp of leaderPos) {
      const d = Math.hypot(p.sx - lp.sx, p.sy - lp.sy);
      if (d < CLUSTER_THRESHOLD && d < bestDist) { bestDist = d; bestLeader = lp.id; }
    }
    if (bestLeader) {
      memberToLeader.set(p.id, bestLeader);
      grid.get(bestLeader).push(p.id);
    } else {
      memberToLeader.set(p.id, p.id);
      grid.set(p.id, [p.id]);
      leaderPos.push({ id: p.id, sx: p.sx, sy: p.sy });
    }
  });

  return { grid, memberToLeader };
}

function applyClusterVisibility(nodeSel, clusters) {
  nodeSel.each(function(d) {
    const loc = d.data?.location;
    if (!loc?.lat) {
      d3.select(this).style('display', null).classed('cluster', false);
      d3.select(this).select('.cluster-count').text('');
      return;
    }
    const leaderId = clusters.memberToLeader.get(d.id);
    if (leaderId === undefined) { d3.select(this).style('display', null); return; }
    if (leaderId !== d.id) { d3.select(this).style('display', 'none'); return; }

    const members     = clusters.grid.get(d.id) || [];
    const isClustered = members.length > 1;
    d3.select(this).style('display', null).classed('cluster', isClustered);
    d3.select(this).select('.cluster-count').text(isClustered ? members.length : '');
  });
}

function getNodeVisualR(d, clusters, geoPinned) {
  if (!geoPinned) return NODE_R;
  const loc = d.data?.location;
  if (!loc?.lat) return GEO_NODE_R;
  if (!clusters) return GEO_NODE_R;
  const leader  = clusters.memberToLeader.get(d.id);
  const members = (leader === d.id) ? (clusters.grid.get(d.id) || []) : [];
  return members.length > 1 ? GEO_CLUSTER_R : GEO_NODE_R;
}

function rescaleNodes(nodeSel, defs, clusters, geoPinned, transform) {
  const k = transform.k;
  nodeSel.each(function(d) {
    const r   = getNodeVisualR(d, clusters, geoPinned) / k;
    const sel = d3.select(this);
    sel.select('.node-bg').attr('r', r);
    sel.select('.node-ring').attr('r', r);
    sel.select('image').attr('x', -r).attr('y', -r).attr('width', r*2).attr('height', r*2);
    sel.select('.node-label').attr('y', r + 3/k).style('font-size', (9/k) + 'px');
    sel.select('.cluster-count').style('font-size', (11/k) + 'px');
    defs.select('#cp-' + d.id.replace(/[^a-z0-9]/gi, '') + ' circle').attr('r', r);
  });
}

const MIN_FORCE_R = 20;
const MAX_FORCE_R = 80;

function adaptNodeSizes(nodeSel, defs, nodes) {
  nodeSel.each(function(d) {
    let minDist = Infinity;
    for (const n of nodes) {
      if (n.id === d.id) continue;
      const dist = Math.hypot(d.x - n.x, d.y - n.y);
      if (dist < minDist) minDist = dist;
    }
    const r = Math.min(MAX_FORCE_R, Math.max(MIN_FORCE_R, minDist / 2.2));
    d._r = r;
    const sel = d3.select(this);
    sel.select('.node-bg').attr('r', r);
    sel.select('.node-ring').attr('r', r);
    sel.select('image').attr('x', -r).attr('y', -r).attr('width', r*2).attr('height', r*2);
    sel.select('.node-label').attr('y', r + 4);
    defs.select('#cp-' + d.id.replace(/[^a-z0-9]/gi, '') + ' circle').attr('r', r);
  });
}

function applyLabelVisibility(nodeSel, clusters, geoPinned) {
  nodeSel.each(function(d) {
    let show = true;
    if (geoPinned && clusters) {
      const leader = clusters.memberToLeader.get(d.id);
      show = leader === d.id && (clusters.grid.get(d.id) || []).length === 1;
    }
    d3.select(this).select('.node-label').style('display', show ? null : 'none');
  });
}

function getHiddenNodes(clusters) {
  const hidden = new Set();
  if (!clusters) return hidden;
  clusters.memberToLeader.forEach((leader, id) => { if (leader !== id) hidden.add(id); });
  return hidden;
}

// ── React components ──────────────────────────────────────────────────────────

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

function KNearestFilter({ nodes, onApply, onReset, hint }) {
  const [focusId, setFocusId] = React.useState('');
  const [k, setK] = React.useState(5);
  const sorted = React.useMemo(
    () => [...(nodes || [])].sort((a, b) => a.label.localeCompare(b.label)), [nodes]
  );
  return (
    <div className="ctrl-section">
      <p className="ctrl-label">K-nearest to artifact</p>
      <select value={focusId} onChange={e => setFocusId(e.target.value)} className="artifact-select">
        <option value="">— choose artifact —</option>
        {sorted.map(n => <option key={n.id} value={n.id}>{trunc(n.label, 38)}</option>)}
      </select>
      <div className="knear-row">
        <span className="k-label">K =</span>
        <input type="number" min="1" max="99" value={k}
          onChange={e => setK(Math.max(1, parseInt(e.target.value) || 5))} className="k-input" />
        <button className="btn" onClick={() => { if (focusId) onApply(focusId, k); }}>Apply</button>
        <button className="btn" onClick={() => { setFocusId(''); onReset(); }}>Reset</button>
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

function ArtifactDetail({ artifact, chosenIdx, onChooseImage }) {
  const [lightboxSrc, setLightboxSrc] = React.useState(null);
  if (!artifact) return <p className="placeholder">Click a node to see artifact details.</p>;
  const era = artifact.era || {};
  const loc = artifact.location || {};
  const eraStr = era.name
    ? `${era.name}${era.year_start != null ? ` (${fmtYear(era.year_start)} – ${fmtYear(era.year_end)})` : ''}`
    : 'Unknown era';
  return (
    <div>
      <h2>{artifact.label || artifact.id}</h2>
      <span className="era-badge">{eraStr}</span>
      {artifact.description && <><p className="field-label">Description</p><p className="field-value">{artifact.description}</p></>}
      {artifact.material?.length > 0 && <>
        <p className="field-label">Material</p>
        <p className="field-value">{artifact.material.map((m, i) => <span key={i} className="material-pill">{m}</span>)}</p>
      </>}
      {loc.site && <>
        <p className="field-label">Site</p>
        <p className="field-value">
          {loc.site}{loc.region ? `, ${loc.region}` : ''}
          {loc.lat != null && <span className="coords">{loc.lat.toFixed(4)}, {loc.lng.toFixed(4)}</span>}
        </p>
      </>}
      {artifact.function && <><p className="field-label">Function</p><p className="field-value">{artifact.function}</p></>}
      {artifact.images?.length > 0 && <>
        <p className="field-label">Images <span className="img-hint">(click = node · double-click = zoom)</span></p>
        <div className="image-strip">
          {artifact.images.map((p, i) => (
            <img key={i} src={imgSrc(p)} alt="" className={i === chosenIdx ? 'chosen' : ''}
              onError={e => { e.target.style.display = 'none'; }}
              onClick={() => onChooseImage(artifact.id, i)}
              onDoubleClick={() => setLightboxSrc(imgSrc(p))} />
          ))}
        </div>
      </>}
      {artifact.url && <><p className="field-label">Source</p><a href={artifact.url} target="_blank" rel="noopener">{artifact.url}</a></>}
      {lightboxSrc && <div className="lightbox" onClick={() => setLightboxSrc(null)}><img src={lightboxSrc} alt="artifact" /></div>}
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
  const [kHint, setKHint]               = React.useState('Select an artifact and press Apply.');
  const [chosenImages, setChosenImages] = React.useState({});
  const [geoPin, setGeoPin]             = React.useState(false);
  const [showArrows, setShowArrows]     = React.useState(false);

  const svgRef    = React.useRef(null);
  const d3Ref     = React.useRef({});
  const weightsRef   = React.useRef(weights);    weightsRef.current   = weights;
  const globalKRef   = React.useRef(globalK);    globalKRef.current   = globalK;
  const geoPinRef    = React.useRef(false);       geoPinRef.current    = geoPin;
  const showArrowsRef = React.useRef(false);      showArrowsRef.current = showArrows;
  const onClusterClickRef = React.useRef(null);
  onClusterClickRef.current = (memberIds, allNodes) => {
    const arts = memberIds.map(id => allNodes.find(n => n.id === id)?.data).filter(Boolean);
    setClusterList(arts);
    setSelected(null);
  };

  React.useEffect(() => {
    fetch(BASE + 'graph.json')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(setGraphData)
      .catch(e => setLoadError(e.message));
  }, []);

  React.useEffect(() => {
    if (graphData && svgRef.current) initD3(graphData);
  }, [graphData]);

  React.useEffect(() => {
    const { simulation, linkSel, links } = d3Ref.current;
    if (!simulation || !linkSel || !links) return;
    const w = weights, k = globalKRef.current;
    linkSel.attr('stroke-width', d => Math.max(0.5, (NODE_R / 2) * combinedWeight(d, w)));
    applyLinkDisplay(linkSel, links, w, k, new Set());
    simulation.force('link',
      d3.forceLink(links).id(d => d.id)
        .distance(d => 200 - combinedWeight(d, w) * 100)
        .strength(d => Math.max(0.02, combinedWeight(d, w) * 0.4))
    );
    simulation.alpha(0.3).restart();
  }, [weights, globalK]);

  React.useEffect(() => {
    const { linkSel } = d3Ref.current;
    if (!linkSel) return;
    linkSel.attr('marker-mid', d => showArrows && d.temporal != null ? 'url(#arr)' : null);
  }, [showArrows]);

  React.useEffect(() => {
    const { simulation, nodeSel, linkSel, links, nodes, defs, mapG,
            projection, lastTransform } = d3Ref.current;
    if (!simulation) return;
    const transform = lastTransform || d3.zoomIdentity;

    if (geoPin) {
      pinNodesToGeo(simulation, true, projection);
      const clusters = computeGeoClusters(nodes, projection, transform);
      d3Ref.current.clusters = clusters;
      applyClusterVisibility(nodeSel, clusters);
      rescaleNodes(nodeSel, defs, clusters, true, transform);
      applyLabelVisibility(nodeSel, clusters, true);
      applyLinkDisplay(linkSel, links, weightsRef.current, globalKRef.current, new Set());
      simulation.force('center', null);
      simulation.force('charge', d3.forceManyBody().strength(-20));
      simulation.force('collision', null);
      mapG.style('display', null);
      if (mapG.selectAll('path').empty()) {
        fetchWorld().then(world => {
          const countries = topojson.feature(world, world.objects.countries);
          const path = d3.geoPath(projection);
          mapG.selectAll('path').data(countries.features).join('path')
            .attr('d', path).attr('fill', '#162016').attr('stroke', '#2a3d2a').attr('stroke-width', 0.5);
        });
      }
    } else {
      pinNodesToGeo(simulation, false, projection);
      nodeSel.style('display', null).classed('cluster', false);
      nodeSel.selectAll('.cluster-count').text('');
      d3Ref.current.clusters = null;
      rescaleNodes(nodeSel, defs, null, false, d3.zoomIdentity);
      applyLabelVisibility(nodeSel, null, false);
      applyLinkDisplay(linkSel, links, weightsRef.current, globalKRef.current, new Set());
      const { W, H } = d3Ref.current;
      simulation.force('center', d3.forceCenter(W / 2, H / 2));
      simulation.force('charge', d3.forceManyBody().strength(-300));
      simulation.force('collision', d3.forceCollide(d => (d._r || MIN_FORCE_R) + 4).iterations(3));
      mapG.style('display', 'none');
    }
    simulation.alpha(0.8).restart();
  }, [geoPin]);

  function handleChooseImage(artifactId, index) {
    setChosenImages(prev => ({ ...prev, [artifactId]: index }));
    d3Ref.current.nodeSel?.filter(d => d.id === artifactId).select('image')
      .attr('href', d => { const p = d.data.images?.[index]; return p ? imgSrc(p) : ''; });
  }

  function applyKFilter(focusId, k) {
    const { nodeSel, linkSel } = d3Ref.current;
    if (!nodeSel || !linkSel || !graphData) return;
    const w = weightsRef.current;
    const scores = {};
    graphData.links.forEach(l => {
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
    const name = graphData.nodes.find(n => n.id === focusId)?.label || focusId;
    setKHint(`Showing ${topK.length} neighbor(s) of "${trunc(name, 28)}".`);
  }

  function resetKFilter() {
    d3Ref.current.nodeSel?.classed('dimmed', false);
    d3Ref.current.linkSel?.classed('dimmed', false);
    setKHint('Select an artifact and press Apply.');
  }

  function initD3(data) {
    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const container = svgRef.current.parentElement;
    const W = container.clientWidth, H = container.clientHeight;
    svg.attr('viewBox', `0 0 ${W} ${H}`);

    const pad = Math.min(W, H) * 0.08;
    const projection = d3.geoEquirectangular();
    const coordNodes = data.nodes.filter(n => n.data?.location?.lat != null);
    if (coordNodes.length >= 2) {
      const lngs = coordNodes.map(n => n.data.location.lng);
      const lats  = coordNodes.map(n => n.data.location.lat);
      const ep = 8;
      projection.fitExtent([[pad, pad], [W-pad, H-pad]], {
        type: 'Feature', geometry: { type: 'Polygon', coordinates: [[
          [Math.min(...lngs)-ep, Math.min(...lats)-ep], [Math.max(...lngs)+ep, Math.min(...lats)-ep],
          [Math.max(...lngs)+ep, Math.max(...lats)+ep], [Math.min(...lngs)-ep, Math.max(...lats)+ep],
          [Math.min(...lngs)-ep, Math.min(...lats)-ep],
        ]] },
      });
    } else {
      projection.fitExtent([[pad, pad], [W-pad, H-pad]], { type: 'Sphere' });
    }

    const nodes = data.nodes.map(d => ({ ...d }));
    const links = data.links.map(d => ({ ...d }));
    const w = weightsRef.current;

    const defs = svg.append('defs');
    defs.append('marker').attr('id', 'arr')
      .attr('markerWidth', 8).attr('markerHeight', 8)
      .attr('refX', 4).attr('refY', 4)
      .attr('orient', 'auto').attr('markerUnits', 'userSpaceOnUse')
      .append('path').attr('d', 'M0,1 L8,4 L0,7 z')
      .attr('fill', '#6699cc').attr('opacity', 0.9);
    nodes.forEach(d => {
      defs.append('clipPath')
        .attr('id', 'cp-' + d.id.replace(/[^a-z0-9]/gi, ''))
        .append('circle').attr('r', NODE_R);
    });

    const g = svg.append('g');

    const zoom = d3.zoom().scaleExtent([0.05, 150]).on('zoom', e => {
      g.attr('transform', e.transform);
      d3Ref.current.lastTransform = e.transform;
      const { nodeSel: ns, nodes: _n, projection: _p, linkSel: ls, links: _l, defs: _d } = d3Ref.current;
      if (!ns) return;
      if (geoPinRef.current && _n && _p) {
        const clusters = computeGeoClusters(_n, _p, e.transform);
        d3Ref.current.clusters = clusters;
        applyClusterVisibility(ns, clusters);
        rescaleNodes(ns, _d, clusters, true, e.transform);
        applyLabelVisibility(ns, clusters, true);
        applyLinkDisplay(ls, _l, weightsRef.current, globalKRef.current, new Set());
      }
      // force mode: no rescaling — nodes grow with zoom so images become visible
    });
    svg.call(zoom);

    const mapG = g.append('g').attr('class', 'map-layer').style('display', 'none');

    const linkSel = g.append('g').selectAll('path')
      .data(links).join('path').attr('class', 'link')
      .style('stroke', '#6699cc')
      .attr('stroke-width', d => Math.max(0.5, (NODE_R / 2) * combinedWeight(d, w)));

    const nodeSel = g.append('g').selectAll('g')
      .data(nodes).join('g').attr('class', 'node')
      .call(d3.drag()
        .on('start', (ev, d) => { if (!ev.active) sim.alphaTarget(0.3).restart(); d._dragging = true; d.fx = d.x; d.fy = d.y; })
        .on('drag',  (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
        .on('end',   (ev, d) => {
          if (!ev.active) sim.alphaTarget(0);
          d._dragging = false;
          if (geoPinRef.current) {
            const loc = d.data?.location;
            if (loc?.lat != null) { const [x,y] = projection([loc.lng, loc.lat]); d.fx = x; d.fy = y; }
            else { d.fx = null; d.fy = null; }
          } else { d.fx = null; d.fy = null; }
        }))
      .on('click', (ev, d) => {
        ev.stopPropagation();
        if (geoPinRef.current) {
          const { clusters } = d3Ref.current;
          if (clusters) {
            const members = clusters.grid.get(d.id);
            if (members && members.length > 1) { onClusterClickRef.current?.(members, data.nodes); return; }
          }
        }
        nodeSel.classed('selected', false);
        d3.select(ev.currentTarget).classed('selected', true);
        setSelected(d.data); setClusterList(null);
      });

    nodeSel.append('circle').attr('class', 'node-bg').attr('r', NODE_R).attr('fill', '#1e3a54');
    nodeSel.append('image')
      .attr('href', d => { const p = d.data.images?.[0]; return p ? imgSrc(p) : ''; })
      .attr('x', -NODE_R).attr('y', -NODE_R).attr('width', NODE_R*2).attr('height', NODE_R*2)
      .attr('preserveAspectRatio', 'xMidYMid slice')
      .attr('clip-path', d => `url(#cp-${d.id.replace(/[^a-z0-9]/gi, '')})`)
      .style('pointer-events', 'none');
    nodeSel.append('circle').attr('class', 'node-ring').attr('r', NODE_R);
    nodeSel.append('text').attr('class', 'node-label').attr('y', NODE_R + 3).text(d => trunc(d.label, 16));
    nodeSel.append('text').attr('class', 'cluster-count').attr('y', 0).text('');

    const sim = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id(d => d.id)
        .distance(d => 200 - combinedWeight(d, w) * 100)
        .strength(d => Math.max(0.02, combinedWeight(d, w) * 0.4)))
      .force('charge',    d3.forceManyBody().strength(-400))
      .force('center',    d3.forceCenter(W / 2, H / 2))
      .force('collision', d3.forceCollide(d => (d._r || MIN_FORCE_R) + 4).iterations(3))
      .on('tick', () => {
        linkSel.attr('d', d => {
          let [sx, sy, tx, ty] = [d.source.x, d.source.y, d.target.x, d.target.y];
          if (showArrowsRef.current && d.temporal != null) {
            const ms = temporalMid(d.source), mt = temporalMid(d.target);
            if (ms != null && mt != null && mt < ms) [sx, sy, tx, ty] = [tx, ty, sx, sy];
          }
          const mx = (sx + tx) / 2, my = (sy + ty) / 2;
          return `M${sx},${sy}L${mx},${my}L${tx},${ty}`;
        });
        nodeSel.attr('transform', d => `translate(${d.x},${d.y})`);
        if (!geoPinRef.current) adaptNodeSizes(nodeSel, defs, nodes);
      });

    svg.on('click', () => { nodeSel.classed('selected', false); setSelected(null); setClusterList(null); });

    applyLinkDisplay(linkSel, links, w, globalKRef.current, new Set());

    d3Ref.current = {
      simulation: sim, nodeSel, linkSel, links, nodes, defs, mapG, projection, W, H,
      clusters: null, lastTransform: d3.zoomIdentity,
    };

    applyLabelVisibility(nodeSel, null, false);
  }

  if (loadError) return (
    <div style={{ padding: 24, color: '#c55' }}>
      <p>Could not load graph.json: {loadError}</p>
      <p style={{ marginTop: 10, color: '#888' }}>Run <code>python serve.py</code>, then open <code>http://localhost:8765/ui/</code></p>
    </div>
  );

  const selId = selectedArtifact?.id;
  const chosenIdx = selId != null ? (chosenImages[selId] ?? 0) : 0;

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
            <p className="knear-hint">Each node shows its K strongest edges under current weights.</p>
          </div>
          <div className="ctrl-section">
            <p className="ctrl-label">Geographic layout</p>
            <label className="geo-toggle">
              <input type="checkbox" checked={geoPin} onChange={e => setGeoPin(e.target.checked)} />
              <span>Pin nodes to map coordinates</span>
            </label>
            <p className="knear-hint">Zoom in to split clusters. Click a cluster to list its artifacts.</p>
          </div>
          <div className="ctrl-section">
            <p className="ctrl-label">Temporal direction</p>
            <label className="geo-toggle">
              <input type="checkbox" checked={showArrows} onChange={e => setShowArrows(e.target.checked)} />
              <span>Show arrows (older → newer)</span>
            </label>
            <p className="knear-hint">Arrows appear on edges with temporal data.</p>
          </div>
          <KNearestFilter nodes={graphData?.nodes} onApply={applyKFilter} onReset={resetKFilter} hint={kHint} />
        </div>
        <div id="detail">
          {clusterList
            ? <ClusterList artifacts={clusterList} onSelect={art => { setSelected(art); setClusterList(null); }} />
            : <ArtifactDetail artifact={selectedArtifact} chosenIdx={chosenIdx} onChooseImage={handleChooseImage} />
          }
        </div>
      </div>
      <div id="graph-container"><svg ref={svgRef} /></div>
    </>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
