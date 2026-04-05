const express = require("express");
const fetch = require("node-fetch");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

// Cache 30s
let cache = { data: null, ts: 0 };

app.get("/api/rank", async (req, res) => {
  const name = process.env.RIOT_NAME;
  const tag  = process.env.RIOT_TAG;
  const region = process.env.RIOT_REGION || "eu";
  const apiKey = process.env.HENRIK_API_KEY || "";

  if (!name || !tag) {
    return res.status(400).json({ error: "Configure RIOT_NAME et RIOT_TAG dans Railway Variables" });
  }

  const now = Date.now();
  if (cache.data && now - cache.ts < 30000) return res.json(cache.data);

  try {
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = apiKey;

    const url = `https://api.henrikdev.xyz/valorant/v3/mmr/${region}/pc/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`;
    const r = await fetch(url, { headers });
    const json = await r.json();

    console.log("Henrik API response:", JSON.stringify(json).slice(0, 500));

    if (!r.ok) return res.status(r.status).json({ error: json.errors?.[0]?.message || json.message || "Erreur Henrik API" });

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

    cache = { data: result, ts: now };
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

app.get("/health", (_, res) => res.send("ok"));

app.listen(PORT, "0.0.0.0", () => console.log(`Running on ${PORT}`));
