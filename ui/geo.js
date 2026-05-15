// ── geo helpers ── depends on helpers.js ─────────────────────────────────────

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
    if (leaderId !== d.id)      { d3.select(this).style('display', 'none'); return; }

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
