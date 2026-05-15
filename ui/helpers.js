// ── constants ─────────────────────────────────────────────────────────────────
const BASE             = new URL("../", window.location.href).href;
const NODE_R           = 11;
const GEO_NODE_R       = 22;
const GEO_CLUSTER_R    = 30;
const CLUSTER_THRESHOLD = GEO_CLUSTER_R * 2 + 2;
const MIN_FORCE_R      = 20;
const MAX_FORCE_R      = 80;
const INITIAL_DISPLAY  = 50;   // random nodes shown on load
const EXPAND_K         = 15;   // neighbors added per click

// ── world tile cache ──────────────────────────────────────────────────────────
let _worldCache = null;
async function fetchWorld() {
  if (_worldCache) return _worldCache;
  const r = await fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json');
  _worldCache = await r.json();
  return _worldCache;
}

// ── pure graph helpers ────────────────────────────────────────────────────────
function combinedWeight(link, w) {
  let sum = 0, denom = 0;
  if (link.temporal != null) { sum += link.temporal * w.temporal; denom += w.temporal; }
  if (link.spatial  != null) { sum += link.spatial  * w.spatial;  denom += w.spatial;  }
  if (link.material != null) { sum += link.material * w.material; denom += w.material; }
  return denom > 0 ? sum / denom : 0;
}

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

// ── display helpers ───────────────────────────────────────────────────────────
function temporalMid(node) {
  const era = node?.data?.era;
  if (!era || era.year_start == null || era.year_end == null) return null;
  return (era.year_start + era.year_end) / 2;
}

function fmtYear(y) { return y == null ? '?' : y < 0 ? `${Math.abs(y)} BCE` : `${y} CE`; }
function imgSrc(p)  { return p?.startsWith('http') ? p : BASE + p; }
function trunc(s, n){ return s && s.length > n ? s.slice(0, n - 1) + '…' : (s || ''); }

// ── random sample ─────────────────────────────────────────────────────────────
function randomSample(arr, n) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(n, copy.length));
}

// ── open context lazy fetch ───────────────────────────────────────────────────
function _walkImages(obj, out) {
  if (!obj || typeof obj !== 'object') return;
  for (const [, v] of Object.entries(obj)) {
    if (typeof v === 'string' && /\.(jpg|jpeg|png|gif|webp)/i.test(v) && v.startsWith('http')) {
      out.add(v);
    } else if (typeof v === 'object') {
      _walkImages(v, out);
    }
  }
}

async function fetchArtifactDetail(url) {
  try {
    const r = await fetch(url + '.json');
    if (!r.ok) return null;
    const raw = await r.json();
    const imgSet = new Set();
    _walkImages(raw, imgSet);
    const gcs    = [...imgSet].filter(u => u.includes('storage.googleapis.com'));
    const others = [...imgSet].filter(u => !u.includes('storage.googleapis.com'));
    const images = [...gcs, ...others];
    const desc = raw?.['dc:description'] || raw?.description || raw?.['rdfs:comment'] || '';
    return { images, description: typeof desc === 'string' ? desc : '' };
  } catch {
    return null;
  }
}
