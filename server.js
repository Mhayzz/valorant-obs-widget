const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const fetch = require("node-fetch");
const path = require("path");
const fs = require("fs");
const { createServer } = require("http");
const { Server } = require("socket.io");

// ── Constants ────────────────────────────────────────────────
const RANK_POLL_INTERVAL = 15000;   // 15 seconds
const MATCH_POLL_INTERVAL = 6000;   // 6 seconds
const FETCH_TIMEOUT = 10000;        // 10 seconds
const MAX_RETRIES = 2;
const RETRY_DELAY = 1000;           // 1 second

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.ALLOWED_ORIGINS?.split(",") || "http://localhost:3000",
    methods: ["GET", "POST"]
  },
  transports: ["websocket", "polling"],
  // OBS CEF can silently lose the connection; shorter ping catches it fast
  pingInterval: 8000,
  pingTimeout: 6000,
});
const PORT = process.env.PORT || 3000;

app.use(helmet({
  // Inline <script> in index.html/setup.html would be blocked by the default CSP,
  // and the setup preview iframes '/' so frameguard must allow same-origin.
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  frameguard: { action: "sameorigin" },
}));
app.use(express.json({ limit: "16kb" }));
// OBS's CEF caches aggressively; force a fresh fetch every load so users
// don't have to "Refresh cache of current page" after a redeploy.
app.use(express.static(path.join(__dirname, "public"), {
  etag: false,
  lastModified: false,
  setHeaders: (res, filePath) => {
    if (/\.(html|js|css)$/i.test(filePath)) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }
  },
}));

const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});
const configWriteLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});
app.use("/api/", apiLimiter);

// ── Utility functions ───────────────────────────────────────
function getApiHeaders(apiKey) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = apiKey;
  return headers;
}

function generateMatchKey(agentId, kills, deaths, assists, timestamp) {
  return `${agentId}|${kills}|${deaths}|${assists}|${timestamp}`;
}

function determineMatchWin(playerTeam, redRounds, blueRounds) {
  if (redRounds === blueRounds) return null;
  if (playerTeam !== 'red' && playerTeam !== 'blue') return null;
  return playerTeam === 'red' ? redRounds > blueRounds : blueRounds > redRounds;
}

async function fetchWithRetry(url, options = {}, retries = MAX_RETRIES) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return response;
  } catch (error) {
    clearTimeout(timeout);
    if (retries > 0 && (error.name === 'AbortError' || error.code === 'ETIMEDOUT')) {
      console.warn(`Fetch timeout/error, retrying (${MAX_RETRIES - retries + 1}/${MAX_RETRIES})...`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      return fetchWithRetry(url, options, retries - 1);
    }
    throw error;
  }
}

// ── Config fichier ──────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, "data", "config.json");

const DEFAULT_DISPLAY = {
  bg_opacity:             0.50,
  accent_color:           "#ffffff",
  text_primary:           "#ffffff",
  text_secondary:         "rgba(255,255,255,0.6)",
  text_tertiary:          "rgba(255,255,255,0.3)",
  show_peak_rank:         false,
  peak_inline:            false,
  peak_align:             "left",
  show_last_match:        true,
  show_streak:            true,
  widget_width:           300,
  realtime_notifications: true,
  animation_type:         "both",
  show_account:           true,
  stat_animations:        "fade",
  corner_radius:          10,
  show_agent_icon:        true,
  agent_icon_size:        "small",
  winrate_format:         "detailed",
  show_rr_chart:          true,
  rr_chart_games:         20,
  layout_preset:          "default",
};

// ── Input validation ───────────────────────────────────────
const REGIONS = new Set(["eu", "na", "ap", "kr", "latam", "br"]);
const ANIMATION_TYPES = new Set(["rank", "match", "both", "none"]);
const PEAK_ALIGN = new Set(["left", "right"]);
const STAT_ANIMATIONS = new Set(["none", "fade", "slide"]);
const AGENT_ICON_SIZES = new Set(["small", "large"]);
const WINRATE_FORMATS = new Set(["detailed", "short", "percentage"]);
const LAYOUT_PRESETS = new Set(["default", "compact", "split", "row", "grid", "minimal", "tall"]);
// Accepts #RGB/#RGBA/#RRGGBB/#RRGGBBAA or rgb()/rgba() with 0-255 components.
const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$/;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

function cleanStr(v, max) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || t.length > max || CONTROL_CHARS.test(t)) return null;
  return t;
}
function cleanColor(v, fallback) {
  return typeof v === "string" && v.length <= 48 && COLOR_RE.test(v.trim()) ? v.trim() : fallback;
}
function clampNum(v, lo, hi, fallback) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

function sanitizeDisplay(d) {
  if (!d || typeof d !== "object") return { ...DEFAULT_DISPLAY };
  return {
    bg_opacity:             clampNum(d.bg_opacity, 0, 1, DEFAULT_DISPLAY.bg_opacity),
    accent_color:           cleanColor(d.accent_color,   DEFAULT_DISPLAY.accent_color),
    text_primary:           cleanColor(d.text_primary,   DEFAULT_DISPLAY.text_primary),
    text_secondary:         cleanColor(d.text_secondary, DEFAULT_DISPLAY.text_secondary),
    text_tertiary:          cleanColor(d.text_tertiary,  DEFAULT_DISPLAY.text_tertiary),
    show_peak_rank:         !!d.show_peak_rank,
    peak_inline:            !!d.peak_inline,
    peak_align:             PEAK_ALIGN.has(d.peak_align) ? d.peak_align : DEFAULT_DISPLAY.peak_align,
    show_last_match:        d.show_last_match        === undefined ? DEFAULT_DISPLAY.show_last_match        : !!d.show_last_match,
    show_streak:            d.show_streak            === undefined ? DEFAULT_DISPLAY.show_streak            : !!d.show_streak,
    widget_width:           Math.floor(clampNum(d.widget_width, 100, 2000, DEFAULT_DISPLAY.widget_width)),
    realtime_notifications: d.realtime_notifications === undefined ? DEFAULT_DISPLAY.realtime_notifications : !!d.realtime_notifications,
    animation_type:         ANIMATION_TYPES.has(d.animation_type) ? d.animation_type : DEFAULT_DISPLAY.animation_type,
    show_account:           d.show_account            === undefined ? DEFAULT_DISPLAY.show_account            : !!d.show_account,
    stat_animations:        STAT_ANIMATIONS.has(d.stat_animations) ? d.stat_animations : DEFAULT_DISPLAY.stat_animations,
    corner_radius:          Math.floor(clampNum(d.corner_radius, 0, 20, DEFAULT_DISPLAY.corner_radius)),
    show_agent_icon:        d.show_agent_icon === undefined ? DEFAULT_DISPLAY.show_agent_icon : !!d.show_agent_icon,
    agent_icon_size:        AGENT_ICON_SIZES.has(d.agent_icon_size) ? d.agent_icon_size : DEFAULT_DISPLAY.agent_icon_size,
    winrate_format:         WINRATE_FORMATS.has(d.winrate_format) ? d.winrate_format : DEFAULT_DISPLAY.winrate_format,
    show_rr_chart:          d.show_rr_chart === undefined ? DEFAULT_DISPLAY.show_rr_chart : !!d.show_rr_chart,
    rr_chart_games:         Math.floor(clampNum(d.rr_chart_games, 5, 50, DEFAULT_DISPLAY.rr_chart_games)),
    layout_preset:          LAYOUT_PRESETS.has(d.layout_preset) ? d.layout_preset : DEFAULT_DISPLAY.layout_preset,
  };
}

function loadFileConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch(e) {
    if (e.code !== "ENOENT") console.error("loadFileConfig:", e.message);
    return {};
  }
}

function saveFileConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    return true;
  } catch(e) { console.error("saveFileConfig:", e.message); return false; }
}

let fileConfig = loadFileConfig();

function getCfg() {
  const region = fileConfig.riot_region || process.env.RIOT_REGION || "eu";
  return {
    riot_name:      fileConfig.riot_name      || process.env.RIOT_NAME      || "",
    riot_tag:       fileConfig.riot_tag       || process.env.RIOT_TAG       || "",
    riot_region:    REGIONS.has(region) ? region : "eu",
    henrik_api_key: fileConfig.henrik_api_key || process.env.HENRIK_API_KEY || "",
    display: sanitizeDisplay(fileConfig.display),
  };
}

const SETUP_PASSWORD = process.env.SETUP_PASSWORD || "";

// ── Caches ──────────────────────────────────────────────────
let rankCache  = { data: null, ts: 0 };
let matchCache = { data: null, ts: 0, size: 0 };
let rankHistory = {}; // Track rank changes per account
let matchHistory = {}; // Track last match per account

function invalidateCaches() {
  rankCache  = { data: null, ts: 0 };
  matchCache = { data: null, ts: 0, size: 0 };
  rankHistory = {};
  matchHistory = {};
}

// ── WebSocket connections ────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[WebSocket] Client connected: ${socket.id}`);
  // Push current state immediately so new clients don't wait for next poll
  if (rankCache.data) {
    socket.emit("rank", { ...rankCache.data, animation: null });
  }
  socket.on("disconnect", () => {
    console.log(`[WebSocket] Client disconnected: ${socket.id}`);
  });
});


// Poll rank every 30 seconds and notify clients of changes
setInterval(async () => {
  const cfg = getCfg();
  if (!cfg.riot_name || !cfg.riot_tag) return;

  const accountKey = `${cfg.riot_name}#${cfg.riot_tag}`;

  try {
    const r = await fetchWithRetry(
      `https://api.henrikdev.xyz/valorant/v3/mmr/${cfg.riot_region}/pc/${encodeURIComponent(cfg.riot_name)}/${encodeURIComponent(cfg.riot_tag)}`,
      { headers: getApiHeaders(cfg.henrik_api_key) }
    );
    if (!r.ok) {
      console.warn(`Rank poll failed: ${r.status}`);
      return;
    }

    const json = await r.json();
    if (!json.data?.current) {
      console.warn('Invalid rank response in poll');
      return;
    }
    const current = json.data.current;
    const peak = json.data.peak;
    const newTier = current.tier?.id ?? 0;
    const newRank = current.tier?.name || "Unranked";
    const newRR = current.rr ?? 0;

    const lastRank = rankHistory[accountKey];
    const rankChanged = lastRank && (lastRank.tier !== newTier || lastRank.rank !== newRank);
    const rrChanged = lastRank && lastRank.rr !== newRR;

    // Always keep rankCache up to date so new socket clients get fresh data
    const fresh = {
      rank: current.tier?.name || "Unranked",
      rr: newRR,
      rr_change: current.last_change ?? null,
      tier: newTier,
      rank_icon: current.images?.large || current.images?.small ||
        `https://media.valorant-api.com/competitivetiers/03621f52-342b-cf4e-4f86-9350a49c6d04/${newTier}/largeicon.png`,
      peak_rank: peak?.tier?.name || null,
      peak_tier: peak?.tier?.id ?? 0,
      peak_season: peak?.season?.short || null,
      player: `${cfg.riot_name}#${cfg.riot_tag}`,
    };
    rankCache = { data: fresh, ts: Date.now() };

    if (rankChanged || rrChanged) {
      const change = rankChanged && newTier > lastRank.tier ? "rankup" : rankChanged && newTier < lastRank.tier ? "rankdown" : null;
      rankHistory[accountKey] = { tier: newTier, rank: newRank, rr: newRR };
      io.emit("rank", { ...fresh, animation: change });
    } else if (!lastRank) {
      rankHistory[accountKey] = { tier: newTier, rank: newRank, rr: newRR };
    }
  } catch(e) {
    console.error("rank-stream poll error:", e.message);
  }
}, RANK_POLL_INTERVAL);

// Poll matches every 10 seconds and notify clients of new matches
setInterval(async () => {
  const cfg = getCfg();
  if (!cfg.riot_name || !cfg.riot_tag) return;

  const accountKey = `${cfg.riot_name}#${cfg.riot_tag}`;

  try {
    const r = await fetchWithRetry(
      `https://api.henrikdev.xyz/valorant/v1/lifetime/matches/${cfg.riot_region}/${encodeURIComponent(cfg.riot_name)}/${encodeURIComponent(cfg.riot_tag)}?size=1`,
      { headers: getApiHeaders(cfg.henrik_api_key) }
    );
    if (!r.ok) {
      console.warn(`Match poll failed: ${r.status}`);
      return;
    }

    const json = await r.json();
    const matches = json.data || [];
    if (!Array.isArray(matches) || !matches.length) return;

    const lastMatch = matchHistory[accountKey];
    const currentMatch = matches[0];
    const stats = currentMatch.stats;
    const matchKey = generateMatchKey(stats?.character?.id, stats?.kills, stats?.deaths, stats?.assists, currentMatch.meta?.started_at);

    if (lastMatch && lastMatch !== matchKey) {
      const redRounds = currentMatch.teams?.red ?? 0;
      const blueRounds = currentMatch.teams?.blue ?? 0;
      const playerTeam = (stats?.team || "").toLowerCase();
      const won = determineMatchWin(playerTeam, redRounds, blueRounds);

      matchCache = { data: null, ts: 0, size: 0 };

      const msg = {
        type: won === null ? "draw" : (won ? "win" : "lose"),
        agent: stats?.character?.name || "Unknown",
        agent_id: stats?.character?.id,
        kills: stats?.kills ?? 0,
        deaths: stats?.deaths ?? 0,
        assists: stats?.assists ?? 0,
        map: currentMatch.meta?.map?.name || "Unknown",
        mode: currentMatch.meta?.mode || "",
        won: won,
      };
      io.emit("match", msg);
    }
    matchHistory[accountKey] = matchKey;
  } catch(e) {
    console.error("match-stream poll error:", e.message);
  }
}, MATCH_POLL_INTERVAL);

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

app.post("/api/config", configWriteLimiter, (req, res) => {
  if (SETUP_PASSWORD && req.body.password !== SETUP_PASSWORD) {
    return res.status(401).json({ error: "Mot de passe incorrect" });
  }
  const { riot_name, riot_tag, riot_region, henrik_api_key, display } = req.body;
  const patch = {};
  const reject = (msg) => res.status(400).json({ error: msg });

  if (riot_name !== undefined) {
    const v = cleanStr(riot_name, 32);
    if (v === null) return reject("riot_name invalide");
    patch.riot_name = v;
  }
  if (riot_tag !== undefined) {
    const v = cleanStr(riot_tag, 16);
    if (v === null) return reject("riot_tag invalide");
    patch.riot_tag = v;
  }
  if (riot_region !== undefined) {
    if (!REGIONS.has(riot_region)) return reject("riot_region invalide");
    patch.riot_region = riot_region;
  }
  if (henrik_api_key !== undefined && henrik_api_key !== "") {
    const v = cleanStr(henrik_api_key, 256);
    if (v === null) return reject("henrik_api_key invalide");
    patch.henrik_api_key = v;
  }
  if (display !== undefined) {
    patch.display = sanitizeDisplay(display);
  }

  const accountChanged =
    (patch.riot_name      !== undefined && patch.riot_name      !== fileConfig.riot_name) ||
    (patch.riot_tag       !== undefined && patch.riot_tag       !== fileConfig.riot_tag) ||
    (patch.riot_region    !== undefined && patch.riot_region    !== fileConfig.riot_region) ||
    (patch.henrik_api_key !== undefined && patch.henrik_api_key !== fileConfig.henrik_api_key);

  const newCfg = { ...fileConfig, ...patch };
  if (!saveFileConfig(newCfg)) return res.status(500).json({ error: "Erreur de sauvegarde" });
  fileConfig = newCfg;
  if (accountChanged) invalidateCaches();
  // Broadcast config changes to all connected widgets (including OBS) so they
  // update without the user needing to refresh the source
  if (patch.display !== undefined) io.emit("display", patch.display);
  if (accountChanged) io.emit("account_change", {});
  res.json({ ok: true });
});

// Test animations triggered from the setup page. Broadcast to all widgets
// (cross-browser, so OBS receives it even though setup was in Chrome).
app.post("/api/test", configWriteLimiter, (req, res) => {
  const { type, detail } = req.body || {};
  const ALLOWED = new Set(["ranktest", "matchtest", "rr_addgame", "rr_reset"]);
  if (!ALLOWED.has(type)) return res.status(400).json({ error: "type invalide" });
  io.emit("test", { type, detail: detail || null, ts: Date.now() });
  res.json({ ok: true });
});

// ── Valorant rank ────────────────────────────────────────────
app.get("/api/rank", async (req, res) => {
  const { riot_name: name, riot_tag: tag, riot_region: region, henrik_api_key: apiKey } = getCfg();
  if (!name || !tag) return res.status(400).json({ error: "Configure ton compte sur /setup.html" });

  const now = Date.now();
  if (rankCache.data && now - rankCache.ts < 30000) return res.json(rankCache.data);

  try {
    const r = await fetchWithRetry(
      `https://api.henrikdev.xyz/valorant/v3/mmr/${region}/pc/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`,
      { headers: getApiHeaders(apiKey) }
    );
    const json = await r.json();
    if (!r.ok) {
      console.error(`Rank API error: ${r.status}`, json.errors?.[0]?.message);
      return res.status(r.status).json({ error: json.errors?.[0]?.message || "Erreur API" });
    }

    // Validate response structure
    if (!json.data?.current) {
      console.error('Invalid rank response structure:', json);
      return res.status(500).json({ error: "Format API invalide" });
    }

    const current = json.data.current;
    const peak    = json.data.peak;
    const tier    = current.tier?.id ?? 0;
    const result  = {
      rank:         current.tier?.name || "Unranked",
      rr:           current.rr ?? 0,
      rr_change:    current.last_change ?? null,
      tier,
      rank_icon:    current.images?.large || current.images?.small ||
        `https://media.valorant-api.com/competitivetiers/03621f52-342b-cf4e-4f86-9350a49c6d04/${tier}/largeicon.png`,
      peak_rank:    peak?.tier?.name   || null,
      peak_tier:    peak?.tier?.id     ?? 0,
      peak_season:  peak?.season?.short || null,
      player: `${name}#${tag}`,
    };
    rankCache = { data: result, ts: now };
    res.json(result);
  } catch(e) {
    console.error("Rank API request failed:", e.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
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

  const headers = getApiHeaders(apiKey);

  // Essaye v1/lifetime (le plus fiable pour l'historique par joueur)
  try {
    const r = await fetchWithRetry(
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
        const won = determineMatchWin(playerTeam, redRounds, blueRounds);

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
  } catch(e) {
    console.error("v1/lifetime error:", e.message);
  }

  // Fallback : v3 sans /pc/
  try {
    const r = await fetchWithRetry(
      `https://api.henrikdev.xyz/valorant/v3/matches/${region}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}?size=${size}`,
      { headers }
    );
    const json = await r.json();
    if (!r.ok) {
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
httpServer.listen(PORT, "0.0.0.0", () => console.log(`Running on port ${PORT}`));
