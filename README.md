# 🎮 Valorant Rank Widget — OBS + Railway

Widget OBS temps réel pour afficher ton rank Valorant. Auto-refresh toutes les 30s.

---

## 📦 Déploiement sur Railway

### 1. Push sur GitHub

```bash
git init
git add .
git commit -m "init: valorant obs widget"
gh repo create valorant-obs-widget --public --push
```

### 2. Créer un projet Railway

1. Va sur [railway.app](https://railway.app)
2. **New Project** → **Deploy from GitHub repo**
3. Sélectionne ton repo `valorant-obs-widget`
4. Railway détecte automatiquement Node.js

### 3. Configurer les variables d'environnement

Dans Railway → ton projet → **Variables** :

| Variable | Valeur | Exemple |
|---|---|---|
| `RIOT_NAME` | Ton pseudo Riot (sans #tag) | `MaitreSuprème` |
| `RIOT_TAG` | Ton tagline (sans #) | `EUW` |
| `RIOT_REGION` | Ta région | `eu` |
| `HENRIK_API_KEY` | Clé API Henrik (optionnelle) | `HDEV-xxxxx` |

> ⚠️ **RIOT_NAME** : utilise exactement le nom tel qu'il apparaît dans Valorant (avec accents si besoin, Railway supporte l'UTF-8).

### 4. Récupérer l'URL

Railway te donne une URL type :
```
https://valorant-obs-widget-production.up.railway.app
```

---

## 📺 Configurer OBS

1. OBS → **Sources** → **+** → **Navigateur**
2. **URL** : `https://ton-projet.up.railway.app`
3. **Largeur** : `340`
4. **Hauteur** : `90`
5. ✅ Activer **"Actualiser le navigateur quand la scène devient active"**
6. CSS personnalisé (déjà inclus) : le fond est **transparent** ✅

---

## 🔑 API Henrik (optionnel mais recommandé)

Sans clé API → 30 req/min (suffisant pour usage solo).
Avec clé API → rate limit plus élevé.

Obtenir une clé gratuite : https://docs.henrikdev.xyz/

---

## 🎨 Aperçu

Le widget affiche :
- 🏆 Icône du rank actuel
- 📛 Pseudo#Tag
- 🎯 Nom du rang (ex: Gold 2)
- 📊 Barre de progression RR (0-100)
- ±RR du dernier match (vert/rouge)

Taille : **340×90px** — fond transparent, thème cyberpunk rouge/noir.
