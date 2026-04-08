const express = require("express");
const fetch = require("node-fetch");
const path = require("path");
const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.static(path.join(__dirname, "public")));

// ── Config fichier ─────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, "data", "config.json");

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
    twitch_channel: fileConfig.twitch_channel || process.env.TWITCH_CHANNEL || "",
    henrik_api_key: fileConfig.henrik_api_key || process.env.HENRIK_API_KEY || "",
  };
}

// ── Env config ──────────────────────────────────────────────
const CLIENT_ID      = () => process.env.TWITCH_CLIENT_ID;
const CLIENT_SECRET  = () => process.env.TWITCH_CLIENT_SECRET;
const BASE_URL       = () => process.env.BASE_URL || "https://valorantbot-production.up.railway.app";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "valooverlay2024secret";
const SETUP_PASSWORD = process.env.SETUP_PASSWORD || "";

// ── Caches ─────────────────────────────────────────────────
let rankCache   = { data: null, ts: 0 };
let streamCache = { data: null, ts: 0 };
let matchCache  = { data: null, ts: 0 };
let appToken    = { token: null, ts: 0 };
let userToken   = { access: process.env.TWITCH_USER_TOKEN || null, refresh: process.env.TWITCH_REFRESH_TOKEN || null };
let broadcasterId = null;

function invalidateCaches() {
  rankCache   = { data: null, ts: 0 };
  streamCache = { data: null, ts: 0 };
  matchCache  = { data: null, ts: 0 };
  broadcasterId = null;
}

// ── WebSocket broadcast ────────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

wss.on("connection", ws => {
  console.log("WS client connected");
  ws.on("error", console.error);
});

// ── App Token ──────────────────────────────────────────────
async function getAppToken() {
  const now = Date.now();
  if (appToken.token && now - appToken.ts < 3500000) return appToken.token;
  const r = await fetch(`https://id.twitch.tv/oauth2/token?client_id=${CLIENT_ID()}&client_secret=${CLIENT_SECRET()}&grant_type=client_credentials`, { method: "POST" });
  const j = await r.json();
  appToken = { token: j.access_token, ts: now };
  return j.access_token;
}

// ── Refresh user token ─────────────────────────────────────
async function refreshUserToken() {
  if (!userToken.refresh) return false;
  try {
    const r = await fetch(`https://id.twitch.tv/oauth2/token?client_id=${CLIENT_ID()}&client_secret=${CLIENT_SECRET()}&refresh_token=${encodeURIComponent(userToken.refresh)}&grant_type=refresh_token`, { method: "POST" });
    const j = await r.json();
    if (j.access_token) { userToken = { access: j.access_token, refresh: j.refresh_token }; return true; }
  } catch(e) {}
  return false;
}

// ── Twitch fetch helper ────────────────────────────────────
async function twitchFetch(url, useUser = false) {
  const token = useUser ? userToken.access : await getAppToken();
  if (!token) return null;
  let r = await fetch(url, { headers: { "Client-ID": CLIENT_ID(), "Authorization": `Bearer ${token}` } });
  if (r.status === 401 && useUser) {
    if (await refreshUserToken()) {
      r = await fetch(url, { headers: { "Client-ID": CLIENT_ID(), "Authorization": `Bearer ${userToken.access}` } });
    }
  }
  return r.ok ? r.json() : null;
}

// ── Broadcaster ID ─────────────────────────────────────────
async function getBroadcasterId() {
  if (broadcasterId) return broadcasterId;
  const channel = getCfg().twitch_channel;
  if (!channel) return null;
  const j = await twitchFetch(`https://api.twitch.tv/helix/users?login=${channel}`);
  broadcasterId = j?.data?.[0]?.id || null;
  return broadcasterId;
}

// ── OAuth ──────────────────────────────────────────────────
app.get("/auth", (req, res) => {
  const scopes = "channel:read:subscriptions moderator:read:followers channel:read:redemptions";
  res.redirect(`https://id.twitch.tv/oauth2/authorize?client_id=${CLIENT_ID()}&redirect_uri=${BASE_URL()}/callback&response_type=code&scope=${encodeURIComponent(scopes)}`);
});

app.get("/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send("Erreur: pas de code");
  try {
    const r = await fetch(`https://id.twitch.tv/oauth2/token?client_id=${CLIENT_ID()}&client_secret=${CLIENT_SECRET()}&code=${code}&grant_type=authorization_code&redirect_uri=${BASE_URL()}/callback`, { method: "POST" });
    const j = await r.json();
    userToken = { access: j.access_token, refresh: j.refresh_token };
    await registerEventSubs();
    res.send(`<html><body style="background:#0e0e10;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2 style="color:#9147ff">✅ Auth réussie !</h2><p style="opacity:.6;margin-top:8px">Les alertes sont actives. Tu peux fermer cette page.</p></div></body></html>`);
  } catch(e) { res.send("Erreur: " + e.message); }
});

// ── EventSub registration ──────────────────────────────────
async function registerEventSubs() {
  const bid = await getBroadcasterId();
  if (!bid) { console.log("Broadcaster ID introuvable"); return; }

  const token = await getAppToken();
  const callbackUrl = `${BASE_URL()}/eventsub`;

  const subs = [
    { type: "channel.follow",             version: "2", condition: { broadcaster_user_id: bid, moderator_user_id: bid } },
    { type: "channel.subscribe",          version: "1", condition: { broadcaster_user_id: bid } },
    { type: "channel.subscription.gift",  version: "1", condition: { broadcaster_user_id: bid } },
    { type: "channel.cheer",              version: "1", condition: { broadcaster_user_id: bid } },
  ];

  for (const sub of subs) {
    try {
      const r = await fetch("https://api.twitch.tv/helix/eventsub/subscriptions", {
        method: "POST",
        headers: { "Client-ID": CLIENT_ID(), "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ type: sub.type, version: sub.version, condition: sub.condition, transport: { method: "webhook", callback: callbackUrl, secret: WEBHOOK_SECRET } })
      });
      const j = await r.json();
      console.log(`EventSub ${sub.type}:`, j.data?.[0]?.status || j.error || "ok");
    } catch(e) { console.error(`EventSub ${sub.type} error:`, e.message); }
  }
}

// ── EventSub webhook ───────────────────────────────────────
app.post("/eventsub", (req, res) => {
  const msgId        = req.headers["twitch-eventsub-message-id"];
  const msgTimestamp = req.headers["twitch-eventsub-message-timestamp"];
  const msgSignature = req.headers["twitch-eventsub-message-signature"];
  const hmac = "sha256=" + crypto.createHmac("sha256", WEBHOOK_SECRET).update(msgId + msgTimestamp + req.rawBody).digest("hex");

  if (hmac !== msgSignature) return res.status(403).send("Forbidden");

  const msgType = req.headers["twitch-eventsub-message-type"];
  if (msgType === "webhook_callback_verification") return res.status(200).send(req.body.challenge);

  if (msgType === "notification") {
    const { subscription, event } = req.body;
    console.log("EventSub event:", subscription.type, event);
    switch (subscription.type) {
      case "channel.follow":
        broadcast({ type: "follow", user: event.user_name });
        streamCache = { data: null, ts: 0 };
        break;
      case "channel.subscribe":
        broadcast({ type: "sub", user: event.user_name, tier: event.tier, gifted: event.is_gift });
        streamCache = { data: null, ts: 0 };
        break;
      case "channel.subscription.gift":
        broadcast({ type: "subgift", user: event.user_name, count: event.total, tier: event.tier });
        streamCache = { data: null, ts: 0 };
        break;
      case "channel.cheer":
        broadcast({ type: "cheer", user: event.user_name, bits: event.bits });
        break;
    }
  }
  res.status(200).send("ok");
});

// ── Config API ─────────────────────────────────────────────
app.get("/api/config", (req, res) => {
  const cfg = getCfg();
  res.json({
    riot_name:         cfg.riot_name,
    riot_tag:          cfg.riot_tag,
    riot_region:       cfg.riot_region,
    twitch_channel:    cfg.twitch_channel,
    has_henrik_key:    !!cfg.henrik_api_key,
    password_required: !!SETUP_PASSWORD,
    base_url:          BASE_URL(),
  });
});

app.post("/api/config", (req, res) => {
  if (SETUP_PASSWORD && req.body.password !== SETUP_PASSWORD) {
    return res.status(401).json({ error: "Mot de passe incorrect" });
  }
  const { riot_name, riot_tag, riot_region, twitch_channel, henrik_api_key } = req.body;
  const newCfg = {
    ...fileConfig,
    ...(riot_name      !== undefined && { riot_name }),
    ...(riot_tag       !== undefined && { riot_tag }),
    ...(riot_region    !== undefined && { riot_region }),
    ...(twitch_channel !== undefined && { twitch_channel }),
    ...(henrik_api_key !== undefined && henrik_api_key !== "" && { henrik_api_key }),
  };
  if (!saveFileConfig(newCfg)) return res.status(500).json({ error: "Erreur de sauvegarde" });
  fileConfig = newCfg;
  invalidateCaches();
  res.json({ ok: true });
});

// ── Valorant rank ───────────────────────────────────────────
app.get("/api/rank", async (req, res) => {
  const { riot_name: name, riot_tag: tag, riot_region: region, henrik_api_key: apiKey } = getCfg();
  if (!name || !tag) return res.status(400).json({ error: "RIOT_NAME / RIOT_TAG manquants — configure via /setup" });

  const now = Date.now();
  if (rankCache.data && now - rankCache.ts < 30000) return res.json(rankCache.data);

  try {
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = apiKey;
    const r = await fetch(`https://api.henrikdev.xyz/valorant/v3/mmr/${region}/pc/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`, { headers });
    const json = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: json.errors?.[0]?.message || "Erreur Henrik" });
    const current = json.data?.current;
    const tier = current?.tier?.id ?? 0;
    const result = {
      rank:      current?.tier?.name || "Unranked",
      rr:        current?.rr ?? 0,
      rr_change: current?.last_change ?? null,
      tier,
      rank_icon: current?.images?.large || current?.images?.small || `https://media.valorant-api.com/competitivetiers/03621f52-342b-cf4e-4f86-9350a49c6d04/0/${tier}/largeicon.png`,
      player:    `${name}#${tag}`,
    };
    rankCache = { data: result, ts: now };
    res.json(result);
  } catch(e) { res.status(500).json({ error: "Erreur serveur" }); }
});

// ── Dernière partie ─────────────────────────────────────────
app.get("/api/lastmatch", async (req, res) => {
  const { riot_name: name, riot_tag: tag, riot_region: region, henrik_api_key: apiKey } = getCfg();
  if (!name || !tag) return res.status(400).json({ error: "Config manquante" });

  const now = Date.now();
  if (matchCache.data && now - matchCache.ts < 60000) return res.json(matchCache.data);

  try {
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = apiKey;
    const r = await fetch(
      `https://api.henrikdev.xyz/valorant/v3/matches/${region}/pc/${encodeURIComponent(name)}/${encodeURIComponent(tag)}?size=1`,
      { headers }
    );
    const json = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: json.errors?.[0]?.message || "Erreur Henrik" });

    const match = json.data?.[0];
    if (!match) return res.json(null);

    const player = match.players?.find(p =>
      p.name?.toLowerCase() === name.toLowerCase() &&
      p.tag?.toLowerCase()  === tag.toLowerCase()
    );
    if (!player) return res.json(null);

    const team = match.teams?.find(t => t.team_id === player.team_id);

    const result = {
      agent:      player.agent?.name || "Unknown",
      agent_icon: player.agent?.assets?.bust_portrait || null,
      kills:      player.stats?.kills   ?? 0,
      deaths:     player.stats?.deaths  ?? 0,
      assists:    player.stats?.assists ?? 0,
      won:        team?.won ?? null,
      map:        match.metadata?.map?.name || match.metadata?.map || "Unknown",
      mode:       match.metadata?.queue?.name || match.metadata?.queue?.id || "",
    };
    matchCache = { data: result, ts: now };
    res.json(result);
  } catch(e) { res.status(500).json({ error: "Erreur serveur" }); }
});

// ── Stream info ─────────────────────────────────────────────
app.get("/api/stream", async (req, res) => {
  const { twitch_channel } = getCfg();
  if (!CLIENT_ID() || !twitch_channel) return res.status(400).json({ error: "Config manquante" });
  const now = Date.now();
  if (streamCache.data && now - streamCache.ts < 20000) return res.json(streamCache.data);

  try {
    const bid = await getBroadcasterId();
    const [streamData, fData, subData] = await Promise.all([
      twitchFetch(`https://api.twitch.tv/helix/streams?user_login=${twitch_channel}`),
      bid ? twitchFetch(`https://api.twitch.tv/helix/channels/followers?broadcaster_id=${bid}&first=1`) : null,
      bid && userToken.access ? twitchFetch(`https://api.twitch.tv/helix/subscriptions?broadcaster_id=${bid}`, true) : null,
    ]);

    const stream = streamData?.data?.[0];
    const result = {
      live:          !!stream,
      viewers:       stream?.viewer_count ?? 0,
      started_at:    stream?.started_at ?? null,
      title:         stream?.title ?? "",
      game:          stream?.game_name ?? "",
      followers:     fData?.total ?? 0,
      last_follower: fData?.data?.[0]?.user_name || null,
      subs:          subData?.total ?? null,
      auth_needed:   !userToken.access,
    };
    streamCache = { data: result, ts: now };
    res.json(result);
  } catch(e) { res.status(500).json({ error: "Erreur Twitch" }); }
});

// ── Test alert (debug) ──────────────────────────────────────
app.get("/test/:type", (req, res) => {
  const t = req.params.type;
  if (t === "follow")  broadcast({ type: "follow",  user: "TestUser" });
  if (t === "sub")     broadcast({ type: "sub",     user: "TestUser", tier: "1000" });
  if (t === "subgift") broadcast({ type: "subgift", user: "TestUser", count: 5, tier: "1000" });
  if (t === "cheer")   broadcast({ type: "cheer",   user: "TestUser", bits: 100 });
  res.send("Alert sent: " + t);
});

app.get("/health", (_, res) => res.send("ok"));
server.listen(PORT, "0.0.0.0", () => console.log(`Running on port ${PORT}`));
