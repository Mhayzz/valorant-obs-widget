# 🎮 Valorant OBS Widget

Un widget OBS élégant et temps réel pour afficher votre rank Valorant, vos dernières parties et votre win streak directement sur votre stream.

## ✨ Fonctionnalités

- 🎯 **Rank en temps réel** - Notifications instantanées lors de rank-up/rank-down
- 🎮 **Dernière partie** - Affiche votre dernier match avec K/D/A, l'agent et la map
- 🔥 **Win Streak** - Visualise tes 5 dernières parties (W/L/Draw)
- 🎨 **Totalement customisable** - Couleurs, opacité, taille, alignement, animations
- 📱 **Responsive** - Fonctionne sur tous les écrans OBS
- ⚡ **WebSocket temps réel** - Updates instantanées (pas de polling visible)
- 🔒 **Sécurisé & robuste** - Validation des données, timeouts, retry logic

## 📋 Prérequis

- Node.js 14+
- Compte Valorant
- Clé API Henrikdev (gratuite): https://developer.henrikdev.xyz/valorant

## 🚀 Installation Locale

### 1. Clone et installation
```bash
git clone https://github.com/Mhayzz/valorant-obs-widget.git
cd valorant-obs-widget
npm install
```

### 2. Configuration
Créer un fichier `.env`:
```env
PORT=3000
SETUP_PASSWORD=yourSecurePassword
ALLOWED_ORIGINS=http://localhost:3000,https://yourdomai.com
RIOT_NAME=YourName
RIOT_TAG=0000
RIOT_REGION=eu
HENRIK_API_KEY=your_api_key
```

### 3. Démarrer
```bash
npm start
```

Accédez à `http://localhost:3000`

---

## 🚂 Déploiement sur Railway (Production)

### 1. Push sur GitHub
```bash
git push origin main
```

### 2. Créer un projet Railway
1. Va sur [railway.app](https://railway.app)
2. **New Project** → **Deploy from GitHub repo**
3. Sélectionne `valorant-obs-widget`
4. Railway détecte automatiquement Node.js ✅

### 3. Variables d'environnement
Dans Railway → **Variables** :

| Variable | Description | Exemple |
|----------|-------------|---------|
| `RIOT_NAME` | Votre pseudo Valorant (exact) | `MaitreSuprème` |
| `RIOT_TAG` | Votre tag sans # | `0000` |
| `RIOT_REGION` | Région (eu, na, ap, kr, br, latam) | `eu` |
| `HENRIK_API_KEY` | Clé API (optionnelle mais recommandée) | `HDEV-xxxxx` |
| `SETUP_PASSWORD` | Mot de passe setup (optionnel) | `securepass123` |

### 4. Récupérer l'URL
Railway te donne automatiquement une URL:
```
https://valorant-obs-widget-production.up.railway.app
```

---

## 📺 Configurer OBS

### Source navigateur
1. OBS → **Sources** → **+** → **Navigateur**
2. **URL**: `https://votre-widget-url.up.railway.app`
3. **Largeur**: `300` (configurable)
4. **Hauteur**: `400` (adapté automatiquement)
5. ✅ **"Actualiser le navigateur quand la scène devient active"**

### Personnalisation
- Allez à `/setup.html` pour customiser:
  - Couleurs (accent, texte)
  - Opacité du fond
  - Taille du widget
  - Type d'animation (rank/match)
  - Quels éléments afficher (peak rank, streak, dernière partie)

---

## 🏗️ Architecture

### Serveur (Node.js + Express)
- Express pour les endpoints HTTP
- Socket.io pour le WebSocket temps réel
- Polling des APIs Henrikdev:
  - Rank: toutes les 30 secondes
  - Matches: toutes les 10 secondes

### Client (Vanilla JavaScript)
- `public/index.html` - Structure HTML + CSS
- `public/js/overlay.js` - Logique du widget
- WebSocket pour les updates temps réel
- localStorage pour la persistance des settings

### Data
- `/data/config.json` - Fichier de configuration (persiste)
- `localStorage` - Settings d'affichage (sync en temps réel)

---

## 🔑 API Henrik

Le widget utilise l'API gratuite de Henrikdev pour récupérer les données Valorant:
- Documentation: https://developer.henrikdev.xyz/valorant
- Sans clé API: ~60 requêtes/min par IP
- Avec clé API gratuite: limits plus élevés

Obtenir une clé gratuite sur le site ci-dessus.

---

## 🐛 Troubleshooting

### "Rate limit exceeded" (429)
→ Vous avez trop de requêtes. L'API vous rate-limit.
- Solution: Attendre 1 minute
- Ou: Obtenir une clé API gratuite sur henrikdev.xyz

### WebSocket ne se connecte pas
→ Vérifier les paramètres CORS
- Vérifier `ALLOWED_ORIGINS` dans `.env`
- Vérifier la console navigateur (F12) pour les erreurs

### Config ne sauvegarde pas
→ Vérifier les permissions du dossier `/data/`
- `mkdir -p data && chmod 755 data`

### Rank/Matches ne se mettent pas à jour
→ Vérifier votre config (RIOT_NAME + RIOT_TAG corrects)
→ Tester l'API manuellement:
```
https://api.henrikdev.xyz/valorant/v3/mmr/eu/pc/YourName/YourTag
```

---

## 🔒 Sécurité

✅ CORS restreint (whitelist)
✅ Timeouts sur les requêtes API (10s)
✅ Retry automatique en cas d'erreur
✅ Validation des réponses API
✅ Logging pour débugging
✅ Pas d'erreurs silencieuses

---

## 📝 License

MIT - Libre d'utilisation personnelle et commerciale

---

**Développé avec ❤️ pour les streamers Valorant**
