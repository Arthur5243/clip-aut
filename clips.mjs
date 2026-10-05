// clips.mjs — classe les rounds les plus "clipables" (ace, clutch, folie...)
// Valorant : Henrik API (unofficial-valorant-api). CS2 / RL : en attente (GRID).
// Node 18+. Usage CLI :  node clips.mjs [valorant|cs2|rl|all] [limit]
// Usage Express :        import { registerClipsRoute } from './clips.mjs'; registerClipsRoute(app);

import { pathToFileURL } from 'node:url';

const HENRIK = 'https://api.henrikdev.xyz';
const KEY = process.env.HENRIK_KEY || '';
// Joueurs à suivre, format "Nom#Tag@region" séparés par des virgules
const PLAYERS = (process.env.CLIP_PLAYERS || 'ManuelHexe#5777@eu')
  .split(',').map(s => s.trim()).filter(Boolean);
const MATCHES_PER_PLAYER = Number(process.env.CLIP_MATCHES || 10);
const MIN_SCORE = Number(process.env.CLIP_MIN_SCORE || 50);
const CACHE_TTL = 10 * 60 * 1000;

const MULTI = { 3: 30, 4: 80, 5: 200 };
const CLUTCH = { 1: 15, 2: 40, 3: 90, 4: 160, 5: 250 };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function henrik(path) {
  for (let i = 0; i < 3; i++) {
    const res = await fetch(HENRIK + path, { headers: { Authorization: KEY } });
    if (res.status === 429) { await sleep(2000 * (i + 1)); continue; }
    if (!res.ok) throw new Error(`Henrik ${res.status} ${path}`);
    return (await res.json()).data;
  }
  throw new Error('Henrik: rate limit');
}

// ---------- Scoring d'un match Valorant (format Henrik v3) ----------
export function scoreMatch(m) {
  const meta = m.metadata || {};
  const all = m.players.all_players;
  const info = Object.fromEntries(all.map(p => [p.puuid, p]));
  const teams = {
    Red: all.filter(p => p.team === 'Red').map(p => p.puuid),
    Blue: all.filter(p => p.team === 'Blue').map(p => p.puuid),
  };
  const byRound = {};
  for (const k of m.kills || []) (byRound[k.round] ||= []).push(k);

  const out = [];
  (m.rounds || []).forEach((r, i) => {
    const kills = (byRound[i] || []).sort((a, b) => a.kill_time_in_round - b.kill_time_in_round);
    if (!kills.length) return;
    const winner = r.winning_team;

    // Qui est le dernier en vie, et face à combien ?
    const alive = { Red: new Set(teams.Red), Blue: new Set(teams.Blue) };
    const clutch = {};
    for (const k of kills) {
      alive[k.victim_team]?.delete(k.victim_puuid);
      for (const t of ['Red', 'Blue']) {
        const o = t === 'Red' ? 'Blue' : 'Red';
        if (!clutch[t] && alive[t].size === 1 && alive[o].size > 0) {
          clutch[t] = { puuid: [...alive[t]][0], vs: alive[o].size };
        }
      }
    }

    const per = {};
    for (const k of kills) {
      if (k.killer_team !== k.victim_team) (per[k.killer_puuid] ||= []).push(k);
    }

    for (const [puuid, ks] of Object.entries(per)) {
      const p = info[puuid];
      if (!p) continue;
      const n = ks.length;
      let score = n * 10;
      const tags = [];

      if (n >= 3) {
        score += MULTI[Math.min(n, 5)];
        tags.push(n >= 5 ? 'ACE' : `${n}K`);
        if (ks[n - 1].kill_time_in_round - ks[0].kill_time_in_round <= 10000) {
          score += 25; tags.push('RAPIDE');
        }
      }

      const hs = r.player_stats?.find(s => s.player_puuid === puuid)?.headshots || 0;
      score += hs * 3;
      if (hs >= 3) tags.push(`${hs} HS`);

      const knives = ks.filter(k => /knife|melee/i.test(k.damage_weapon_name || k.weapon?.name || '')).length;
      if (knives) { score += 25 * knives; tags.push('COUTEAU'); }

      const c = clutch[p.team];
      if (c && c.puuid === puuid && winner === p.team && alive[p.team].has(puuid)) {
        score += CLUTCH[Math.min(c.vs, 5)];
        tags.push(`CLUTCH 1v${c.vs}`);
        if (r.defuse_events?.defused_by?.puuid === puuid) { score += 20; tags.push('DEFUSE'); }
      }

      out.push({
        game: 'valorant',
        matchId: meta.matchid,
        map: meta.map,
        date: meta.game_start ? new Date(meta.game_start * 1000).toISOString() : null,
        round: i + 1,
        player: `${p.name}#${p.tag}`,
        agent: p.character,
        kills: n,
        tags,
        score,
        // repères temporels depuis le début du match (ms) pour caler le clip dans la VOD
        roundStartMs: ks[0].kill_time_in_match - ks[0].kill_time_in_round,
        clipFromMs: Math.max(0, ks[0].kill_time_in_match - 8000),
        clipToMs: ks[n - 1].kill_time_in_match + 3000,
      });
    }
  });
  return out;
}

// ---------- Providers ----------
async function valorantClips(players = PLAYERS) {
  const seen = new Set();
  const clips = [];
  const errors = [];
  for (const entry of players) {
    try {
      const [id, region = 'eu'] = entry.split('@');
      const [name, tag] = id.split('#');
      const matches = await henrik(
        `/valorant/v3/matches/${region}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}?size=${MATCHES_PER_PLAYER}`
      );
      for (const m of matches || []) {
        const mid = m.metadata?.matchid;
        if (!mid || seen.has(mid)) continue;
        seen.add(mid);
        clips.push(...scoreMatch(m));
      }
    } catch (e) {
      errors.push(`${entry} : ${e.message}`);
    }
    await sleep(500);
  }
  return { clips, errors };
}

// TODO GRID : brancher ici (série -> matchs -> events kills/rounds), puis réutiliser la même logique de score
const PROVIDERS = {
  valorant: valorantClips,
  cs2: null,
  rl: null,
};

// ---------- API publique ----------
const cache = {};
export async function getClips({ game = 'valorant', limit = 30, players = PLAYERS } = {}) {
  const games = game === 'all' ? Object.keys(PROVIDERS) : [game];
  const clips = [];
  const pending = [];
  const errors = [];
  for (const g of games) {
    if (!(g in PROVIDERS)) throw new Error(`jeu inconnu: ${g}`);
    if (!PROVIDERS[g]) { pending.push(g); continue; }
    const key = g + ':' + players.join(',');
    const c = cache[key];
    if (!c || Date.now() - c.t > CACHE_TTL) {
      const data = await PROVIDERS[g](players);
      if (data.clips.length || !data.errors.length) cache[key] = { t: Date.now(), data };
      else { errors.push(...data.errors); continue; }
    }
    clips.push(...cache[key].data.clips);
    errors.push(...cache[key].data.errors);
  }
  clips.sort((a, b) => b.score - a.score);
  return {
    pending, // jeux en attente de l'API GRID
    errors,
    players,
    clips: clips.filter(c => c.score >= MIN_SCORE).slice(0, limit),
  };
}

export function registerClipsRoute(app, path = '/api/clips') {
  app.get(path, async (req, res) => {
    try {
      res.json(await getClips({ game: req.query.game || 'valorant', limit: Number(req.query.limit) || 30 }));
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });
}

// ---------- CLI ----------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [game = 'valorant', limit = 15] = process.argv.slice(2);
  const { clips, pending } = await getClips({ game, limit: Number(limit) });
  if (pending.length) console.log(`(en attente GRID : ${pending.join(', ')})\n`);
  for (const c of clips) {
    console.log(`${String(c.score).padStart(4)}  ${c.player} · ${c.agent} · ${c.map} R${c.round}  [${c.tags.join(' | ')}]`);
  }
}
