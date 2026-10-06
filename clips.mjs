// clips.mjs — meilleurs moments des matchs Valorant PRO (données VLR.gg via l'API Henrik)
// CS2 / RL : en attente (GRID). Limite Henrik : 30 requêtes/min -> file d'attente à ~27/min,
// cache en mémoire (un match terminé n'est analysé qu'une fois), analyse en arrière-plan.

const HENRIK = 'https://api.henrikdev.xyz';
const num = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);
const cfg = () => ({
  key: process.env.HENRIK_KEY || '',
  interval: num(process.env.HENRIK_INTERVAL_MS, 2200), // 2,2 s => ~27 req/min
  regions: (process.env.CLIP_REGIONS || 'europe,north_america,asia_pacific').split(',').map(s => s.trim()).filter(Boolean),
  eventsPerRegion: num(process.env.CLIP_EVENTS, 2),
  maxMatches: num(process.env.CLIP_MAX_MATCHES, 40),
  refreshMs: num(process.env.CLIP_REFRESH_MIN, 30) * 60000,
  minScore: num(process.env.CLIP_MIN_SCORE, 40),
  eventMatchesPath: process.env.EVENT_MATCHES_PATH || '/valorant/v2/esports/vlr/events/{id}/matches',
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Limiteur global : jamais plus d'1 requête toutes les `interval` ms ----------
let chain = Promise.resolve();
let lastCall = 0;
function limited(fn) {
  const run = chain.then(async () => {
    const wait = lastCall + cfg().interval - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    return fn();
  });
  chain = run.catch(() => {});
  return run;
}

async function henrik(path, query = {}) {
  const qs = new URLSearchParams(query).toString();
  const url = HENRIK + path + (qs ? '?' + qs : '');
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await limited(() => fetch(url, { headers: { Authorization: cfg().key } }));
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after'));
      await sleep(ra > 0 ? ra * 1000 : 30000 * (attempt + 1)); // on laisse la fenêtre se vider
      continue;
    }
    if (!res.ok) throw new Error(`Henrik ${res.status} ${path}`);
    return (await res.json()).data;
  }
  throw new Error('Henrik : limite de requêtes (429) persistante');
}

// ---------- Score d'un match pro ----------
const MK = [['5k', 200, 'ACE'], ['4k', 80, '4K'], ['3k', 30, '3K']];
const CL = [['1v5', 400], ['1v4', 200], ['1v3', 90], ['1v2', 30], ['1v1', 5]];

export function momentsFromMatch(d, id) {
  const perfBy = new Map((d?.performance?.player_performances || []).map(pp => [String(pp.player?.id), pp]));
  const info = new Map();
  for (const g of d?.games || []) {
    for (const t of g.teams || []) {
      for (const p of t.players || []) {
        const pid = p.player?.id;
        if (pid == null) continue;
        const i = info.get(String(pid)) || { name: p.player?.name, team: t.name, agents: new Set(), acs: 0, kills: 0, fk: 0 };
        i.agents.add(p.agent);
        const st = p.stats || {};
        i.acs = Math.max(i.acs, st.acs || 0);
        i.kills = Math.max(i.kills, st.kills || 0);
        i.fk = Math.max(i.fk, st.first_kills || 0);
        info.set(String(pid), i);
      }
    }
  }
  const out = [];
  for (const pid of new Set([...info.keys(), ...perfBy.keys()])) {
    const pp = perfBy.get(pid), i = info.get(pid);
    const mk = pp?.multi_kills || {}, cl = pp?.clutches || {};
    let score = 0;
    const tags = [];
    for (const [k, pts, label] of MK) {
      if (mk[k]) { score += pts * mk[k]; tags.push(mk[k] > 1 ? `${label} ×${mk[k]}` : label); }
    }
    for (const [k, pts] of CL) {
      if (cl[k]) { score += pts * cl[k]; if (k !== '1v1') tags.push(`CLUTCH ${k}${cl[k] > 1 ? ` ×${cl[k]}` : ''}`); }
    }
    // Secours / bonus : grosses stats sur une map
    if (i) {
      if (i.kills >= 28) { score += (i.kills - 25) * 10; tags.push(`${i.kills} kills sur une map`); }
      if (i.acs >= 350) { score += Math.round((i.acs - 300) / 2); tags.push(`ACS ${i.acs}`); }
      if (i.fk >= 8) { score += (i.fk - 6) * 5; tags.push(`${i.fk} first kills`); }
    }
    if (!score) continue;
    out.push({
      game: 'valorant',
      matchId: Number(id),
      url: `https://www.vlr.gg/${id}`,
      vod: (d.vods || [])[0]?.link || null,
      event: d.metadata?.event?.title || null,
      date: d.metadata?.date || null,
      teams: (d.teams || []).map(t => t.name),
      maps: (d.games || []).map(g => g.map),
      player: pp?.player?.name || i?.name,
      team: i?.team || null,
      agents: i ? [...i.agents] : [],
      tags,
      score,
    });
  }
  return out;
}

// ---------- État + worker (une seule file => une seule requête à la fois) ----------
const matchCache = new Map();   // id -> moments[]
const failures = new Map();     // id -> nb d'échecs
const queue = new Set();
const progress = { running: false, lastRefresh: null, errors: [], stats: { withPerf: 0, noPerf: 0, skipped: 0 }, empty: [] };
let working = false;
let discovering = false;

function note(msg) {
  progress.errors = [msg, ...progress.errors].slice(0, 5);
}

async function work() {
  if (working) return;
  working = true;
  progress.running = true;
  try {
    while (queue.size) {
      const id = Math.max(...queue);
      queue.delete(id);
      if (matchCache.has(id) || (failures.get(id) || 0) >= 2) continue;
      try {
        const d = await henrik(`/valorant/v2/esports/vlr/matches/${id}`);
        if (/upcoming|live/i.test(String(d?.metadata?.status || ''))) { progress.stats.skipped++; continue; }
        const moments = momentsFromMatch(d, id);
        matchCache.set(id, moments);
        if (d?.performance) progress.stats.withPerf++; else progress.stats.noPerf++;
        if (!moments.length) progress.empty = [id, ...progress.empty].slice(0, 5);
      } catch (e) {
        failures.set(id, (failures.get(id) || 0) + 1);
        note(`match ${id} : ${e.message}`);
      }
    }
  } finally {
    working = false;
    progress.running = false;
  }
}

async function discover() {
  const c = cfg();
  const ids = [];
  for (const region of c.regions) {
    let events = [];
    try {
      const d = await henrik('/valorant/v2/esports/vlr/events', { region });
      events = (Array.isArray(d) ? d : d?.events || [])
        .filter(e => /ongoing|completed/i.test(e.status || ''))
        .sort((a, b) => b.id - a.id)
        .slice(0, c.eventsPerRegion);
    } catch (e) { note(`événements ${region} : ${e.message}`); continue; }
    for (const ev of events) {
      try {
        const d = await henrik(c.eventMatchesPath.replace('{id}', ev.id));
        const arr = Array.isArray(d) ? d : d?.matches || [];
        for (const m of arr) {
          const mid = m.id ?? m.match?.id ?? m.match_id;
          if (mid && !/upcoming|live/i.test(String(m.status || ''))) ids.push(Number(mid));
        }
      } catch (e) { note(`matchs de l'événement ${ev.id} : ${e.message}`); }
    }
  }
  return [...new Set(ids)].sort((a, b) => b - a).slice(0, c.maxMatches);
}

export async function refresh() {
  if (discovering) return;
  discovering = true;
  progress.running = true;
  try {
    for (const id of await discover()) if (!matchCache.has(id)) queue.add(id);
    progress.lastRefresh = new Date().toISOString();
  } catch (e) { note(e.message); }
  finally { discovering = false; }
  await work();
}

export function start() {
  refresh().catch(e => note(e.message));
  setInterval(() => refresh().catch(e => note(e.message)), cfg().refreshMs).unref?.();
}

export function parseIds(raw = '') {
  return [...new Set(String(raw).split(/[\s,]+/).map(t => {
    const m = t.match(/vlr\.gg\/(\d+)/) || t.match(/^(\d{4,})$/);
    return m ? Number(m[1]) : null;
  }).filter(Boolean))];
}

// ---------- API publique ----------
export async function getClips({ game = 'valorant', limit = 30, ids = [] } = {}) {
  const games = game === 'all' ? ['valorant', 'cs2', 'rl'] : [game];
  const pending = games.filter(g => g !== 'valorant');
  let clips = [];
  if (games.includes('valorant')) {
    for (const id of ids.slice(0, 15)) if (!matchCache.has(id)) queue.add(id);
    if (queue.size) work().catch(e => note(e.message));
    const want = ids.length ? new Set(ids) : null;
    for (const [id, moments] of matchCache) if (!want || want.has(id)) clips.push(...moments);
  }
  clips = clips.filter(c => c.score >= cfg().minScore).sort((a, b) => b.score - a.score).slice(0, limit);
  return {
    pending,
    clips,
    progress: {
      running: progress.running,
      queued: queue.size,
      analysed: matchCache.size,
      lastRefresh: progress.lastRefresh,
      errors: progress.errors,
      stats: progress.stats,
      empty: progress.empty,
    },
  };
}

export async function debugMatch(id) {
  const d = await henrik(`/valorant/v2/esports/vlr/matches/${id}`);
  const g0 = d?.games?.[0];
  return {
    keys: Object.keys(d || {}),
    status: d?.metadata?.status,
    hasPerformance: !!d?.performance,
    performanceSample: (d?.performance?.player_performances || []).slice(0, 2),
    gamesCount: (d?.games || []).length,
    firstGamePlayerSample: g0?.teams?.[0]?.players?.slice(0, 2),
    vods: d?.vods,
  };
}

export function registerClipsRoute(app, path = '/api/clips') {
  app.get(path + '/debug', async (req, res) => {
    try { res.json(await debugMatch(Number(req.query.id))); }
    catch (e) { res.status(502).json({ error: e.message }); }
  });
  app.get(path, async (req, res) => {
    try {
      res.json(await getClips({
        game: req.query.game || 'valorant',
        limit: Number(req.query.limit) || 30,
        ids: parseIds(req.query.ids),
      }));
    } catch (e) { res.status(502).json({ error: e.message }); }
  });
}

// ---------- CLI : node clips.mjs ----------
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await refresh();
  const { clips, progress: p } = await getClips({ limit: 20 });
  console.log(`${p.analysed} matchs analysés`);
  for (const c of clips) console.log(`${String(c.score).padStart(4)}  ${c.player} (${c.team}) · ${c.teams.join(' vs ')} · [${c.tags.join(' | ')}] ${c.url}`);
}
