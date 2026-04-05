const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const HENRIK_API_KEY = process.env.HENRIK_API_KEY || "";

// Cache pour éviter de spam l'API (30s)
let cache = { data: null, ts: 0 };
const CACHE_TTL = 30000;

app.get("/api/rank", async (req, res) => {
  const name = process.env.RIOT_NAME;
  const tag = process.env.RIOT_TAG;
  const region = process.env.RIOT_REGION || "eu";

  if (!name || !tag) {
    return res.status(400).json({ error: "RIOT_NAME et RIOT_TAG non configurés dans les variables d'environnement." });
  }

  const now = Date.now();
  if (cache.data && now - cache.ts < CACHE_TTL) {
    return res.json(cache.data);
  }

  try {
    const headers = { "Content-Type": "application/json" };
    if (HENRIK_API_KEY) headers["Authorization"] = HENRIK_API_KEY;

    const url = `https://api.henrikdev.xyz/valorant/v2/mmr/${region}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`;
    const response = await fetch(url, { headers });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: err.message || "Erreur API Henrik" });
    }

    const json = await response.json();
    const d = json.data;

    const result = {
      name: `${name}#${tag}`,
      rank: d.currenttierpatched || "Unranked",
      rr: d.ranking_in_tier ?? 0,
      elo: d.elo ?? 0,
      rr_change: d.mmr_change_to_last_game ?? null,
      peak_rank: d.highest_rank?.patched_tier || null,
      card: d.images?.small || null,
      rank_icon: `https://media.valorant-api.com/competitivetiers/03621f52-342b-cf4e-4f86-9350a49c6d04/0/${d.currenttier}/largeicon.png`,
      tier: d.currenttier ?? 0,
    };

    cache = { data: result, ts: now };
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur interne" });
  }
});

// Route santé pour Railway
app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`🎮 Valorant OBS Widget running on port ${PORT}`));
