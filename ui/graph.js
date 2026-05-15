// ── graph.js — D3 force graph + focus mode ── depends on helpers.js, geo.js ──

// ── node DOM setup (called for enter selection) ───────────────────────────────
function setupNodeEnter(enter, defs, cfg) {
  enter.append('circle').attr('class', 'node-bg').attr('r', NODE_R).attr('fill', '#1e3a54');
  enter.append('image')
    .attr('href', d => { const p = d.data.images?.[0]; return p ? imgSrc(p) : ''; })
    .attr('x', -NODE_R).attr('y', -NODE_R).attr('width', NODE_R*2).attr('height', NODE_R*2)
    .attr('preserveAspectRatio', 'xMidYMid slice')
    .attr('clip-path', d => `url(#cp-${d.id.replace(/[^a-z0-9]/gi, '')})`)
    .style('pointer-events', 'none');
  enter.append('circle').attr('class', 'node-ring').attr('r', NODE_R);
  enter.append('text').attr('class', 'node-label').attr('y', NODE_R + 3).text(d => trunc(d.label, 16));
  enter.append('text').attr('class', 'cluster-count').attr('y', 0).text('');

  enter.call(d3.drag()
    .on('start', (ev, d) => {
      const { simulation } = cfg.d3State.current;
      if (!ev.active) simulation.alphaTarget(0.3).restart();
      d._dragging = true; d.fx = d.x; d.fy = d.y;
    })
    .on('drag', (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
    .on('end', (ev, d) => {
      const { simulation, projection } = cfg.d3State.current;
      if (!ev.active) simulation.alphaTarget(0);
      d._dragging = false;
      if (cfg.geoPinRef.current) {
        const loc = d.data?.location;
        if (loc?.lat != null) {
          const [x, y] = projection([loc.lng, loc.lat]); d.fx = x; d.fy = y;
        } else { d.fx = null; d.fy = null; }
      } else { d.fx = null; d.fy = null; }
    }));

  enter.on('click', (ev, d) => {
    ev.stopPropagation();
    if (cfg.geoPinRef.current) {
      const { clusters, allData } = cfg.d3State.current;
      if (clusters) {
        const members = clusters.grid.get(d.id);
        if (members && members.length > 1) { cfg.onClusterClick(members, allData.nodes); return; }
      }
    }
    cfg.d3State.current.nodeSel?.classed('selected', false);
    d3.select(ev.currentTarget).classed('selected', true);
    cfg.onNodeClick(d.data, d.id);
    expandNeighborhood(d.id, cfg);
  });
}

// ── ensure clipPath defs exist for a node id ─────────────────────────────────
function ensureClipPath(defs, id) {
  const safeId = 'cp-' + id.replace(/[^a-z0-9]/gi, '');
  if (defs.select('#' + safeId).empty()) {
    defs.append('clipPath').attr('id', safeId).append('circle').attr('r', NODE_R);
  }
}

// ── update D3 DOM + simulation to match current visibleIds ───────────────────
function updateFocusView(cfg) {
  const st = cfg.d3State.current;
  const { allData, visibleIds, simulation, nodeGroup, linkGroup, defs, W, H } = st;
  if (!allData || !nodeGroup) return;

  const w = cfg.weightsRef.current;
  const k = cfg.globalKRef.current;

  const visibleNodes = allData.nodes.filter(n => visibleIds.has(n.id));
  const visibleLinks = allData.links
    .filter(l => {
      const s = typeof l.source === 'object' ? l.source.id : l.source;
      const t = typeof l.target === 'object' ? l.target.id : l.target;
      return visibleIds.has(s) && visibleIds.has(t);
    })
    .map(l => ({
      ...l,
      source: typeof l.source === 'object' ? l.source.id : l.source,
      target: typeof l.target === 'object' ? l.target.id : l.target,
    }));

  // Preserve positions of nodes already in simulation
  const existingPos = new Map(
    (simulation.nodes() || []).map(n => [n.id, { x: n.x, y: n.y }])
  );
  const simNodes = visibleNodes.map(n => ({
    ...n, ...(existingPos.get(n.id) || {
      x: W / 2 + (Math.random() - 0.5) * 200,
      y: H / 2 + (Math.random() - 0.5) * 200,
    }),
  }));

  // Ensure clipPath defs for new nodes
  visibleNodes.forEach(n => ensureClipPath(defs, n.id));

  // Enter / update / exit nodes
  const nodeSel = nodeGroup.selectAll('.node')
    .data(simNodes, d => d.id)
    .join(
      enter => { const g = enter.append('g').attr('class', 'node'); setupNodeEnter(g, defs, cfg); return g; },
      update => update,
      exit   => exit.remove()
    );
  st.nodeSel = nodeSel;

  // Enter / update / exit links
  const linkSel = linkGroup.selectAll('path')
    .data(visibleLinks, l => [l.source, l.target].sort().join('|'))
    .join(
      enter  => enter.append('path').attr('class', 'link').style('stroke', '#6699cc'),
      update => update,
      exit   => exit.remove()
    );
  linkSel.attr('stroke-width', d => Math.max(0.5, (NODE_R / 2) * combinedWeight(d, w)));
  linkSel.attr('marker-mid', d => cfg.showArrowsRef.current && d.temporal != null ? 'url(#arr)' : null);
  st.linkSel = linkSel;
  st.links   = visibleLinks;
  st.nodes   = simNodes;

  applyLinkDisplay(linkSel, visibleLinks, w, k, new Set());
  applyLabelVisibility(nodeSel, st.clusters || null, cfg.geoPinRef.current);

  // Update simulation
  simulation.nodes(simNodes);
  simulation.force('link',
    d3.forceLink(visibleLinks).id(d => d.id)
      .distance(d => 200 - combinedWeight(d, w) * 100)
      .strength(d => Math.max(0.02, combinedWeight(d, w) * 0.4))
  );
  if (!cfg.geoPinRef.current) {
    simulation.force('collision', d3.forceCollide(d => (d._r || MIN_FORCE_R) + 4).iterations(3));
  }
  simulation.alpha(0.5).restart();
}

// ── expand neighbourhood of a node ───────────────────────────────────────────
function expandNeighborhood(nodeId, cfg) {
  const { allData, visibleIds } = cfg.d3State.current;
  if (!allData) return;

  const w = cfg.weightsRef.current;
  const scores = {};
  allData.links.forEach(l => {
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    if (s === nodeId || t === nodeId) {
      const other = s === nodeId ? t : s;
      const cw = combinedWeight(l, w);
      scores[other] = Math.max(scores[other] ?? 0, cw);
    }
  });
  const newIds = Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, EXPAND_K)
    .map(([id]) => id)
    .filter(id => !visibleIds.has(id));

  if (newIds.length === 0) return;
  newIds.forEach(id => visibleIds.add(id));
  updateFocusView(cfg);
}

// ── resample: pick a new random set of nodes ─────────────────────────────────
function resampleNodes(cfg) {
  const { allData, visibleIds } = cfg.d3State.current;
  if (!allData) return;
  visibleIds.clear();
  randomSample(allData.nodes, INITIAL_DISPLAY).forEach(n => visibleIds.add(n.id));
  cfg.d3State.current.clusters = null;
  updateFocusView(cfg);
}

// ── initD3 ────────────────────────────────────────────────────────────────────
function initD3(data, svgEl, cfg) {
  const svg = d3.select(svgEl);
  svg.selectAll('*').remove();

  const container = svgEl.parentElement;
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

  const defs = svg.append('defs');
  defs.append('marker').attr('id', 'arr')
    .attr('markerWidth', 8).attr('markerHeight', 8)
    .attr('refX', 4).attr('refY', 4)
    .attr('orient', 'auto').attr('markerUnits', 'userSpaceOnUse')
    .append('path').attr('d', 'M0,1 L8,4 L0,7 z')
    .attr('fill', '#6699cc').attr('opacity', 0.9);

  const g        = svg.append('g');
  const mapG     = g.append('g').attr('class', 'map-layer').style('display', 'none');
  const linkGroup = g.append('g');
  const nodeGroup = g.append('g');

  const simulation = d3.forceSimulation([])
    .force('charge', d3.forceManyBody().strength(-300))
    .force('center',  d3.forceCenter(W / 2, H / 2))
    .on('tick', () => {
      const { nodeSel: ns, linkSel: ls, nodes: _n } = cfg.d3State.current;
      if (!ls || !ns) return;
      ls.attr('d', d => {
        let [sx, sy, tx, ty] = [d.source.x, d.source.y, d.target.x, d.target.y];
        if (cfg.showArrowsRef.current && d.temporal != null) {
          const ms = temporalMid(d.source), mt = temporalMid(d.target);
          if (ms != null && mt != null && mt < ms) [sx, sy, tx, ty] = [tx, ty, sx, sy];
        }
        const mx = (sx + tx) / 2, my = (sy + ty) / 2;
        return `M${sx},${sy}L${mx},${my}L${tx},${ty}`;
      });
      ns.attr('transform', d => `translate(${d.x},${d.y})`);
      if (!cfg.geoPinRef.current && _n) adaptNodeSizes(ns, cfg.d3State.current.defs, _n);
    });

  const zoom = d3.zoom().scaleExtent([0.05, 150]).on('zoom', e => {
    g.attr('transform', e.transform);
    cfg.d3State.current.lastTransform = e.transform;
    const st = cfg.d3State.current;
    if (!st.nodeSel) return;
    if (cfg.geoPinRef.current && st.nodes && st.projection) {
      const clusters = computeGeoClusters(st.nodes, st.projection, e.transform);
      st.clusters = clusters;
      applyClusterVisibility(st.nodeSel, clusters);
      rescaleNodes(st.nodeSel, st.defs, clusters, true, e.transform);
      applyLabelVisibility(st.nodeSel, clusters, true);
      applyLinkDisplay(st.linkSel, st.links, cfg.weightsRef.current, cfg.globalKRef.current, new Set());
    }
  });
  svg.call(zoom);
  svg.on('click', () => {
    cfg.d3State.current.nodeSel?.classed('selected', false);
    cfg.onNodeClick(null, null);
  });

  // Initialise shared state
  const visibleIds = new Set();
  randomSample(data.nodes, INITIAL_DISPLAY).forEach(n => visibleIds.add(n.id));
  cfg.d3State.current = {
    ...cfg.d3State.current,
    allData: data, visibleIds, simulation, nodeGroup, linkGroup,
    defs, mapG, projection, W, H, clusters: null, lastTransform: d3.zoomIdentity,
  };

  updateFocusView(cfg);
}

// ── effects called from React ─────────────────────────────────────────────────
function handleGeoPinChange(geoPin, cfg) {
  const st = cfg.d3State.current;
  const { simulation, nodeSel, linkSel, links, nodes, defs, mapG, projection } = st;
  if (!simulation) return;
  const transform = st.lastTransform || d3.zoomIdentity;

  if (geoPin) {
    pinNodesToGeo(simulation, true, projection);
    const clusters = computeGeoClusters(nodes, projection, transform);
    st.clusters = clusters;
    applyClusterVisibility(nodeSel, clusters);
    rescaleNodes(nodeSel, defs, clusters, true, transform);
    applyLabelVisibility(nodeSel, clusters, true);
    applyLinkDisplay(linkSel, links, cfg.weightsRef.current, cfg.globalKRef.current, new Set());
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
    st.clusters = null;
    rescaleNodes(nodeSel, defs, null, false, d3.zoomIdentity);
    applyLabelVisibility(nodeSel, null, false);
    applyLinkDisplay(linkSel, links, cfg.weightsRef.current, cfg.globalKRef.current, new Set());
    simulation.force('center', d3.forceCenter(st.W / 2, st.H / 2));
    simulation.force('charge', d3.forceManyBody().strength(-300));
    simulation.force('collision', d3.forceCollide(d => (d._r || MIN_FORCE_R) + 4).iterations(3));
    mapG.style('display', 'none');
  }
  simulation.alpha(0.8).restart();
}

function handleWeightsKChange(cfg) {
  const { linkSel, links, simulation } = cfg.d3State.current;
  if (!simulation || !linkSel || !links) return;
  const w = cfg.weightsRef.current, k = cfg.globalKRef.current;
  linkSel.attr('stroke-width', d => Math.max(0.5, (NODE_R / 2) * combinedWeight(d, w)));
  applyLinkDisplay(linkSel, links, w, k, new Set());
  simulation.force('link',
    d3.forceLink(links).id(d => d.id)
      .distance(d => 200 - combinedWeight(d, w) * 100)
      .strength(d => Math.max(0.02, combinedWeight(d, w) * 0.4))
  );
  simulation.alpha(0.3).restart();
}

function handleShowArrowsChange(showArrows, cfg) {
  const { linkSel } = cfg.d3State.current;
  if (!linkSel) return;
  linkSel.attr('marker-mid', d => showArrows && d.temporal != null ? 'url(#arr)' : null);
}
