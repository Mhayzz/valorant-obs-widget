const express = require("express");
const fetch = require("node-fetch");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Config fichier ──────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, "data", "config.json");

const DEFAULT_DISPLAY = {
  bg_opacity:      0.75,
  accent_color:    "#ff4655",
  text_primary:    "#ffffff",
  text_secondary:  "rgba(255,255,255,0.6)",
  text_tertiary:   "rgba(255,255,255,0.3)",
  show_session_rr: true,
  show_peak_rank:  true,
  show_last_match: true,
  show_streak:     true,
  widget_width:    300,
  refresh_rank:    60,
};

function loadFileConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch(e) {}
  return {};
}

function saveFileConfig(cfg) {
  try {
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    return true;
  } catch(e) { console.error("saveFileConfig:", e.message); return false; }
}

let fileConfig = loadFileConfig();

function getCfg() {
  return {
    riot_name:      fileConfig.riot_name      || process.env.RIOT_NAME      || "",
    riot_tag:       fileConfig.riot_tag       || process.env.RIOT_TAG       || "",
    riot_region:    fileConfig.riot_region    || process.env.RIOT_REGION    || "eu",
    henrik_api_key: fileConfig.henrik_api_key || process.env.HENRIK_API_KEY || "",
    display: { ...DEFAULT_DISPLAY, ...(fileConfig.display || {}) },
  };
}

const SETUP_PASSWORD = process.env.SETUP_PASSWORD || "";

// ── Caches ──────────────────────────────────────────────────
let rankCache  = { data: null, ts: 0 };
let matchCache = { data: null, ts: 0, size: 0 };

function invalidateCaches() {
  rankCache  = { data: null, ts: 0 };
  matchCache = { data: null, ts: 0, size: 0 };
}

// ── Config API ──────────────────────────────────────────────
app.get("/api/config", (req, res) => {
  const cfg = getCfg();
  res.json({
    riot_name:         cfg.riot_name,
    riot_tag:          cfg.riot_tag,
    riot_region:       cfg.riot_region,
    has_henrik_key:    !!cfg.henrik_api_key,
    display:           cfg.display,
    password_required: !!SETUP_PASSWORD,
  });
});

app.post("/api/config", (req, res) => {
  if (SETUP_PASSWORD && req.body.password !== SETUP_PASSWORD) {
    return res.status(401).json({ error: "Mot de passe incorrect" });
  }
  const { riot_name, riot_tag, riot_region, henrik_api_key, display } = req.body;
  const newCfg = {
    ...fileConfig,
    ...(riot_name      !== undefined && { riot_name }),
    ...(riot_tag       !== undefined && { riot_tag }),
    ...(riot_region    !== undefined && { riot_region }),
    ...(henrik_api_key !== undefined && henrik_api_key !== "" && { henrik_api_key }),
    ...(display        !== undefined && { display: { ...DEFAULT_DISPLAY, ...display } }),
  };
  if (!saveFileConfig(newCfg)) return res.status(500).json({ error: "Erreur de sauvegarde" });
  fileConfig = newCfg;
  invalidateCaches();
  res.json({ ok: true });
});

// ── Valorant rank ────────────────────────────────────────────
app.get("/api/rank", async (req, res) => {
  const { riot_name: name, riot_tag: tag, riot_region: region, henrik_api_key: apiKey } = getCfg();
  if (!name || !tag) return res.status(400).json({ error: "Configure ton compte sur /setup.html" });

  const now = Date.now();
  if (rankCache.data && now - rankCache.ts < 30000) return res.json(rankCache.data);

  try {
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = apiKey;
    const r = await fetch(
      `https://api.henrikdev.xyz/valorant/v3/mmr/${region}/pc/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`,
      { headers }
    );
    const json = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: json.errors?.[0]?.message || "Erreur API" });

    const current = json.data?.current;
    const peak    = json.data?.peak;
    const tier    = current?.tier?.id ?? 0;
    const result  = {
      rank:         current?.tier?.name || "Unranked",
      rr:           current?.rr         ?? 0,
      rr_change:    current?.last_change ?? null,
      tier,
      rank_icon:    current?.images?.large || current?.images?.small ||
        `https://media.valorant-api.com/competitivetiers/03621f52-342b-cf4e-4f86-9350a49c6d04/${tier}/largeicon.png`,
      peak_rank:    peak?.tier?.name   || null,
      peak_tier:    peak?.tier?.id     ?? 0,
      peak_season:  peak?.season?.short || null,
      player: `${name}#${tag}`,
    };
    rankCache = { data: result, ts: now };
    res.json(result);
  } catch(e) { res.status(500).json({ error: "Erreur serveur" }); }
});

// ── Matches ──────────────────────────────────────────────────
app.get("/api/matches", async (req, res) => {
  const { riot_name: name, riot_tag: tag, riot_region: region, henrik_api_key: apiKey } = getCfg();
  if (!name || !tag) return res.status(400).json({ error: "Config manquante" });

  const size = Math.min(10, Math.max(1, parseInt(req.query.size) || 5));
  const now  = Date.now();
  if (matchCache.data && matchCache.size >= size && now - matchCache.ts < 60000) {
    return res.json(matchCache.data.slice(0, size));
  }

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = apiKey;

  // Essaye v1/lifetime (le plus fiable pour l'historique par joueur)
  try {
    const r = await fetch(
      `https://api.henrikdev.xyz/valorant/v1/lifetime/matches/${region}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}?size=${size}`,
      { headers }
    );
    const json = await r.json();

    if (r.ok && Array.isArray(json.data) && json.data.length > 0) {
      const matches = json.data.map(m => {
        const stats = m.stats;
        const meta  = m.meta;
        const teams = m.teams;
        if (!stats) return null;

        const agentId   = stats.character?.id;
        const agentName = stats.character?.name || "Unknown";
        const agentIcon = agentId
          ? `https://media.valorant-api.com/agents/${agentId}/displayicon.png`
          : null;

        const playerTeam = (stats.team || "").toLowerCase(); // "red" ou "blue"
        const redRounds  = teams?.red   ?? 0;
        const blueRounds = teams?.blue  ?? 0;
        const won = playerTeam === "red"  ? redRounds  > blueRounds
                  : playerTeam === "blue" ? blueRounds > redRounds
                  : null;

        const mapRaw  = meta?.map;
        const mapName = typeof mapRaw === "string" ? mapRaw : (mapRaw?.name || "Unknown");

        return {
          agent:      agentName,
          agent_icon: agentIcon,
          kills:      stats.kills   ?? 0,
          deaths:     stats.deaths  ?? 0,
          assists:    stats.assists ?? 0,
          won,
          map:  mapName,
          mode: meta?.mode || "",
        };
      }).filter(Boolean);

      matchCache = { data: matches, size, ts: now };
      return res.json(matches);
    }
    // Si v1/lifetime échoue ou retourne rien, fallback v3
    console.log("v1/lifetime:", r.status, json.errors?.[0]?.message || json.message || "no data");
  } catch(e) {
    console.error("v1/lifetime error:", e.message);
  }

  // Fallback : v3 sans /pc/
  try {
    const r = await fetch(
      `https://api.henrikdev.xyz/valorant/v3/matches/${region}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}?size=${size}`,
      { headers }
    );
    const json = await r.json();
    if (!r.ok) {
      console.log("v3/matches:", r.status, json.errors?.[0]?.message || json.message);
      return res.status(r.status).json({ error: json.errors?.[0]?.message || "Erreur API" });
    }

    const matches = (json.data || []).map(match => {
      const player = match.players?.find(p =>
        p.name?.toLowerCase() === name.toLowerCase() &&
        p.tag?.toLowerCase()  === tag.toLowerCase()
      );
      if (!player) return null;

      const agentId   = player.agent?.id;
      const agentIcon = agentId
        ? `https://media.valorant-api.com/agents/${agentId}/displayicon.png`
        : null;

      const teamId = player.team_id ?? player.team;
      const team   = match.teams?.find(t => (t.team_id ?? t.team) === teamId);

      const mapRaw   = match.metadata?.map;
      const mapName  = typeof mapRaw === "string" ? mapRaw : (mapRaw?.name || "Unknown");
      const queueRaw = match.metadata?.queue;
      const mode     = typeof queueRaw === "string" ? queueRaw : (queueRaw?.name || queueRaw?.id || "");

      return {
        agent:      player.agent?.name || "Unknown",
        agent_icon: agentIcon,
        kills:      player.stats?.kills   ?? 0,
        deaths:     player.stats?.deaths  ?? 0,
        assists:    player.stats?.assists ?? 0,
        won:        team?.won ?? team?.has_won ?? null,
        map:        mapName,
        mode,
      };
    }).filter(Boolean);

    matchCache = { data: matches, size, ts: now };
    res.json(matches);
  } catch(e) {
    console.error("v3/matches error:", e.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});


app.get("/health", (_, res) => res.send("ok"));
app.listen(PORT, "0.0.0.0", () => console.log(`Running on port ${PORT}`));
