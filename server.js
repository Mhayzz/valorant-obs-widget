const express = require("express");
const fetch = require("node-fetch");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

// ── Caches ─────────────────────────────────────────────────
let rankCache    = { data: null, ts: 0 };
let streamCache  = { data: null, ts: 0 };
let appToken     = { token: null, ts: 0 };

// Token utilisateur stocké en mémoire (persist via variable d'env idéalement)
let userToken    = { access: process.env.TWITCH_USER_TOKEN || null, refresh: process.env.TWITCH_REFRESH_TOKEN || null };

const CLIENT_ID     = () => process.env.TWITCH_CLIENT_ID;
const CLIENT_SECRET = () => process.env.TWITCH_CLIENT_SECRET;
const CHANNEL       = () => process.env.TWITCH_CHANNEL;
const BASE_URL      = () => process.env.BASE_URL || `https://valorantbot-production.up.railway.app`;

// ── App token (pour followers/stream) ──────────────────────
async function getAppToken() {
  const now = Date.now();
  if (appToken.token && now - appToken.ts < 3600000) return appToken.token;
  const r = await fetch(`https://id.twitch.tv/oauth2/token?client_id=${CLIENT_ID()}&client_secret=${CLIENT_SECRET()}&grant_type=client_credentials`, { method: "POST" });
  const j = await r.json();
  appToken = { token: j.access_token, ts: now };
  return j.access_token;
}

// ── OAuth flow pour user token (subs) ──────────────────────
app.get("/auth", (req, res) => {
  const scopes = "channel:read:subscriptions moderator:read:followers";
  const url = `https://id.twitch.tv/oauth2/authorize?client_id=${CLIENT_ID()}&redirect_uri=${BASE_URL()}/callback&response_type=code&scope=${encodeURIComponent(scopes)}`;
  res.redirect(url);
});

app.get("/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send("Erreur: pas de code");
  try {
    const r = await fetch(`https://id.twitch.tv/oauth2/token?client_id=${CLIENT_ID()}&client_secret=${CLIENT_SECRET()}&code=${code}&grant_type=authorization_code&redirect_uri=${BASE_URL()}/callback`, { method: "POST" });
    const j = await r.json();
    userToken = { access: j.access_token, refresh: j.refresh_token };
    res.send(`<html><body style="background:#0e0e10;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2 style="color:#9147ff">✅ Authentification réussie !</h2><p style="opacity:.6;margin-top:8px">Tu peux fermer cette page.</p></div></body></html>`);
  } catch(e) {
    res.send("Erreur auth: " + e.message);
  }
});

// Refresh user token si expiré
async function refreshUserToken() {
  if (!userToken.refresh) return false;
  try {
    const r = await fetch(`https://id.twitch.tv/oauth2/token?client_id=${CLIENT_ID()}&client_secret=${CLIENT_SECRET()}&refresh_token=${encodeURIComponent(userToken.refresh)}&grant_type=refresh_token`, { method: "POST" });
    const j = await r.json();
    if (j.access_token) {
      userToken = { access: j.access_token, refresh: j.refresh_token };
      return true;
    }
  } catch(e) {}
  return false;
}

// Helper fetch Twitch avec retry sur 401
async function twitchFetch(url, useUserToken = false) {
  const token = useUserToken ? userToken.access : await getAppToken();
  if (!token) return null;
  let r = await fetch(url, { headers: { "Client-ID": CLIENT_ID(), "Authorization": `Bearer ${token}` } });
  if (r.status === 401 && useUserToken) {
    const ok = await refreshUserToken();
    if (ok) {
      r = await fetch(url, { headers: { "Client-ID": CLIENT_ID(), "Authorization": `Bearer ${userToken.access}` } });
    }
  }
  if (!r.ok) return null;
  return r.json();
}

// ── Get broadcaster ID ──────────────────────────────────────
let broadcasterId = null;
async function getBroadcasterId() {
  if (broadcasterId) return broadcasterId;
  const j = await twitchFetch(`https://api.twitch.tv/helix/users?login=${CHANNEL()}`);
  broadcasterId = j?.data?.[0]?.id || null;
  return broadcasterId;
}

// ── Valorant rank ───────────────────────────────────────────
app.get("/api/rank", async (req, res) => {
  const name   = process.env.RIOT_NAME;
  const tag    = process.env.RIOT_TAG;
  const region = process.env.RIOT_REGION || "eu";
  const apiKey = process.env.HENRIK_API_KEY || "";
  if (!name || !tag) return res.status(400).json({ error: "RIOT_NAME / RIOT_TAG manquants" });

  const now = Date.now();
  if (rankCache.data && now - rankCache.ts < 30000) return res.json(rankCache.data);

  try {
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = apiKey;
    const r = await fetch(`https://api.henrikdev.xyz/valorant/v3/mmr/${region}/pc/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`, { headers });
    const json = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: json.errors?.[0]?.message || "Erreur Henrik API" });

    const current = json.data?.current;
    const tier = current?.tier?.id ?? 0;
    const result = {
      rank: current?.tier?.name || "Unranked",
      rr: current?.rr ?? 0,
      rr_change: current?.last_change ?? null,
      tier,
      rank_icon: current?.images?.large || current?.images?.small || `https://media.valorant-api.com/competitivetiers/03621f52-342b-cf4e-4f86-9350a49c6d04/0/${tier}/largeicon.png`,
    };
    rankCache = { data: result, ts: now };
    res.json(result);
  } catch(e) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ── Stream info complète ────────────────────────────────────
app.get("/api/stream", async (req, res) => {
  if (!CLIENT_ID() || !CHANNEL()) return res.status(400).json({ error: "Config manquante" });

  const now = Date.now();
  if (streamCache.data && now - streamCache.ts < 20000) return res.json(streamCache.data);

  try {
    const bid = await getBroadcasterId();

    // Stream live
    const streamData = await twitchFetch(`https://api.twitch.tv/helix/streams?user_login=${CHANNEL()}`);
    const stream = streamData?.data?.[0];

    // Followers (app token)
    let followers = 0;
    if (bid) {
      const fData = await twitchFetch(`https://api.twitch.tv/helix/channels/followers?broadcaster_id=${bid}&first=1`);
      followers = fData?.total ?? 0;
    }

    // Dernier follow
    let lastFollower = null;
    if (bid) {
      const lfData = await twitchFetch(`https://api.twitch.tv/helix/channels/followers?broadcaster_id=${bid}&first=1`);
      lastFollower = lfData?.data?.[0]?.user_name || null;
    }

    // Subs (user token requis)
    let subs = null;
    if (bid && userToken.access) {
      const subData = await twitchFetch(`https://api.twitch.tv/helix/subscriptions?broadcaster_id=${bid}`, true);
      subs = subData?.total ?? null;
    }

    const result = {
      live: !!stream,
      viewers: stream?.viewer_count ?? 0,
      started_at: stream?.started_at ?? null,
      title: stream?.title ?? "",
      game: stream?.game_name ?? "",
      followers,
      last_follower: lastFollower,
      subs,
      auth_needed: !userToken.access,
    };

    streamCache = { data: result, ts: now };
    res.json(result);
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: "Erreur Twitch" });
  }
});

app.get("/health", (_, res) => res.send("ok"));
app.listen(PORT, "0.0.0.0", () => console.log(`Running on port ${PORT}`));
