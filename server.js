const express = require("express");
const fetch = require("node-fetch");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

// Caches
let rankCache   = { data: null, ts: 0 };
let twitchCache = { data: null, ts: 0 };
let twitchToken = { token: null, ts: 0 };

// ── Valorant rank ──────────────────────────────────────────
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

    const url = `https://api.henrikdev.xyz/valorant/v3/mmr/${region}/pc/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`;
    const r = await fetch(url, { headers });
    const json = await r.json();

    if (!r.ok) return res.status(r.status).json({ error: json.errors?.[0]?.message || "Erreur Henrik API" });

    const d = json.data;
    const current = d?.current;
    const tier = current?.tier?.id ?? 0;

    const result = {
      name: `${name}#${tag}`,
      rank: current?.tier?.name || "Unranked",
      rr: current?.rr ?? 0,
      rr_change: current?.last_change ?? null,
      tier,
      rank_icon: current?.images?.large || current?.images?.small || `https://media.valorant-api.com/competitivetiers/03621f52-342b-cf4e-4f86-9350a49c6d04/0/${tier}/largeicon.png`,
    };

    rankCache = { data: result, ts: now };
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ── Twitch helpers ─────────────────────────────────────────
async function getTwitchToken() {
  const now = Date.now();
  if (twitchToken.token && now - twitchToken.ts < 3600000) return twitchToken.token;

  const clientId     = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const r = await fetch(`https://id.twitch.tv/oauth2/token?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`, { method: "POST" });
  const json = await r.json();
  twitchToken = { token: json.access_token, ts: now };
  return json.access_token;
}

// ── Twitch stream info ─────────────────────────────────────
app.get("/api/stream", async (req, res) => {
  const channel  = process.env.TWITCH_CHANNEL;
  const clientId = process.env.TWITCH_CLIENT_ID;
  if (!channel || !clientId) return res.status(400).json({ error: "TWITCH_CHANNEL / TWITCH_CLIENT_ID manquants" });

  const now = Date.now();
  if (twitchCache.data && now - twitchCache.ts < 20000) return res.json(twitchCache.data);

  try {
    const token = await getTwitchToken();
    if (!token) return res.status(500).json({ error: "Token Twitch indisponible" });

    const r = await fetch(`https://api.twitch.tv/helix/streams?user_login=${channel}`, {
      headers: { "Client-ID": clientId, "Authorization": `Bearer ${token}` }
    });
    const json = await r.json();
    const stream = json.data?.[0];

    const result = stream ? {
      live: true,
      viewers: stream.viewer_count,
      started_at: stream.started_at,
      title: stream.title,
    } : { live: false, viewers: 0, started_at: null, title: "" };

    twitchCache = { data: result, ts: now };
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur Twitch" });
  }
});

app.get("/health", (_, res) => res.send("ok"));
app.listen(PORT, "0.0.0.0", () => console.log(`Running on port ${PORT}`));
