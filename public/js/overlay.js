// ── Valorant OBS Widget - Overlay Logic ──────────────────────
// Main client-side logic for the overlay widget

// ── Constants ────────────────────────────────────────────────
const STORAGE_DISPLAY_KEY = window.VALO_KEYS?.DISPLAY || 'valo_display';
const STORAGE_ACCOUNT_CHANGE_KEY = window.VALO_KEYS?.ACCOUNT_CHANGE || 'valo_account_change';
const STORAGE_TEST_ANIMATION_KEY = window.VALO_KEYS?.TEST_ANIMATION || 'valo_test_animation';
const STORAGE_RR_HISTORY_PREFIX = 'valo_rr_history:';
const RR_HISTORY_MAX = 50;
const ANIMATION_CLASSES = ['animate-rankup', 'animate-rankdown', 'animate-win', 'animate-lose'];
const ANIMATION_DURATION = 800;
const VALORANT_TIER_API = 'https://media.valorant-api.com/competitivetiers/564d8e28-c226-3180-6285-e48a390db8b1';
const VALORANT_TIER_API_FALLBACK = 'https://media.valorant-api.com/competitivetiers/03621f52-342b-cf4e-4f86-9350a49c6d04';
const VALORANT_AGENT_API = 'https://media.valorant-api.com/agents';

// ── Global state ─────────────────────────────────────────────
let cfg = null;
let IS_PREVIEW = false;
let socket = null;
let lastRankTier = null;
let lastMatchId = null;
let lastStreakSig = null;
let lastSessionStorageCleared = null;
let playerName = "";
let rrHistory = [];
let rrSessionStart = null;
let rrSessionHistory = [];

// ── DOM element cache ────────────────────────────────────────
let domCache = {};
function getElement(id) {
  if (!domCache[id]) domCache[id] = document.getElementById(id);
  return domCache[id];
}

try { IS_PREVIEW = new URLSearchParams(window.location.search).has('preview') || window.self !== window.top; } catch(e) { IS_PREVIEW = true; }

// ── Utility functions ───────────────────────────────────────
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function todayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function rrHistoryKey() {
  return STORAGE_RR_HISTORY_PREFIX + (playerName || 'default');
}
function loadRRHistory() {
  try {
    const raw = localStorage.getItem(rrHistoryKey());
    const obj = raw ? JSON.parse(raw) : null;
    if (obj?.day === todayKey() && Array.isArray(obj.points)) {
      return obj.points.filter(n => typeof n === 'number').slice(-RR_HISTORY_MAX);
    }
    return [];
  } catch(e) { return []; }
}
function saveRRHistory() {
  try {
    localStorage.setItem(rrHistoryKey(), JSON.stringify({ day: todayKey(), points: rrHistory }));
  } catch(e) {}
}

function generatePeakRankHtml(tier) {
  return `<img src="${VALORANT_TIER_API}/${tier}/largeicon.png" alt="" class="peak-icon" onerror="this.src='${VALORANT_TIER_API_FALLBACK}/${tier}/largeicon.png'">`;
}

function renderMatchResult(resultEl, won) {
  if (won === null)  { resultEl.className = 'match-result draw'; resultEl.textContent = '?'; }
  else if (won)      { resultEl.className = 'match-result win';  resultEl.textContent = 'V'; }
  else               { resultEl.className = 'match-result loss'; resultEl.textContent = 'D'; }
}

function shouldShowGameMode(mode) {
  if (!mode) return false;
  const modeStr = mode.toLowerCase();
  return modeStr !== 'competitive' && modeStr !== 'unrated';
}

function shouldAnimate(kind) {
  if (!(cfg?.display?.realtime_notifications ?? true)) return false;
  const mode = cfg?.display?.animation_type ?? 'both';
  return mode === 'both' || mode === kind;
}

// ── Render helpers (shared by HTTP refresh and WebSocket handlers) ──
function applyRankData(d) {
  const newPlayer = d.player || "";
  if (newPlayer !== playerName) {
    playerName = newPlayer;
    rrHistory = loadRRHistory();
    rrSessionStart = null;
    rrSessionHistory = [];
  }

  if (cfg?.display?.show_account) {
    const rankEl = getElement('rankName');
    rankEl.innerHTML = `<span style="display:block;font-size:8px;opacity:0.6;margin-bottom:2px;">${playerName}</span>${d.rank}`;
  } else {
    getElement('rankName').textContent = d.rank;
  }
  getElement('rrLabel').textContent  = d.rr + ' RR';
  getElement('fill').style.width     = clamp(d.rr, 0, 100) + '%';

  if (typeof d.rr === 'number') {
    if (rrSessionStart === null) {
      rrSessionStart = d.rr;
      rrSessionHistory = [0];
    } else if (rrSessionHistory.length === 0 || rrSessionHistory[rrSessionHistory.length - 1] !== d.rr - rrSessionStart) {
      rrSessionHistory.push(d.rr - rrSessionStart);
      if (rrSessionHistory.length > RR_HISTORY_MAX) rrSessionHistory.shift();
    }
    renderRRChart();
  }
  renderRRChart();

  if (d.tier > 0) {
    const ico = getElement('ico');
    ico.style.display = 'block';
    ico.src = d.rank_icon;
    ico.onerror = () => { ico.src = `${VALORANT_TIER_API}/${d.tier}/largeicon.png`; };
  }

  const peakEl = getElement('peakRank');
  const peakInline = getElement('peakInline');
  if (d.peak_rank) {
    const peakImg = generatePeakRankHtml(d.peak_tier);
    peakEl.innerHTML = `PEAK ${peakImg}`;
    peakInline.innerHTML = 'PEAK ' + peakImg;
    peakInline.className = 'peak-inline align-' + (cfg?.display?.peak_align || 'left');
    const showPeak = cfg?.display?.show_peak_rank ?? true;
    const inline = !!cfg?.display?.peak_inline;
    peakEl.style.display     = (showPeak && !inline) ? 'block' : 'none';
    peakInline.style.display = (showPeak && inline)  ? 'flex'  : 'none';
  } else {
    peakEl.style.display = 'none';
    peakInline.style.display = 'none';
  }

  const chg = d.rr_change;
  const badge = getElement('badge');
  badge.className = 'rr-badge ' + (chg === null ? 'neu' : chg > 0 ? 'pos' : chg < 0 ? 'neg' : 'neu');
  getElement('badgeNum').textContent = chg === null ? '—' : (chg > 0 ? '+' : '') + chg;
}

function renderMatch(m) {
  getElement('matchCard').style.display = 'flex';
  const icon = getElement('matchIcon');
  const iconUrl = m.agent_icon || (m.agent_id ? `${VALORANT_AGENT_API}/${m.agent_id}/displayicon.png` : null);
  if (iconUrl) {
    icon.src = iconUrl;
    icon.style.display = 'block';
    icon.onerror = () => { icon.style.display = 'none'; };
  }
  getElement('matchAgent').textContent = m.agent;
  let kdaStr = `${m.kills}/${m.deaths}/${m.assists}`;
  if (m.map) kdaStr += ' • ' + m.map;
  if (shouldShowGameMode(m.mode)) kdaStr += ` • ${m.mode}`;
  getElement('matchKda').textContent = kdaStr;
  renderMatchResult(getElement('matchResult'), m.won);
}

function matchKeyOf(m) {
  return `${m.agent}|${m.kills}|${m.deaths}|${m.assists}`;
}

function calculateStreak(matches) {
  if (!matches?.length) return { type: '', count: 0 };
  const first = matches[0];
  if (first.won === null) return { type: '', count: 0 };
  const firstType = first.won ? 'w' : 'l';
  let count = 0;
  for (const m of matches) {
    const t = m.won === null ? null : m.won ? 'w' : 'l';
    if (t === firstType) count++;
    else break;
  }
  return { type: firstType, count };
}

function calculateWinRate(matches) {
  if (!matches?.length) return { wins: 0, losses: 0, draws: 0, pct: 0 };
  let wins = 0, losses = 0, draws = 0;
  for (const m of matches) {
    if (m.won === true) wins++;
    else if (m.won === false) losses++;
    else draws++;
  }
  const total = wins + losses + draws;
  const pct = total ? Math.round(wins * 100 / total) : 0;
  return { wins, losses, draws, pct };
}

function formatWinRate(wr, format) {
  if (wr.wins + wr.losses + wr.draws === 0) return '';
  switch (format) {
    case 'percentage': return wr.pct + '%';
    case 'short': return `${wr.wins}-${wr.losses}${wr.draws > 0 ? '-' + wr.draws : ''}`;
    case 'detailed':
    default: return `${wr.wins}-${wr.losses}${wr.draws > 0 ? '-' + wr.draws : ''} (${wr.pct}%)`;
  }
}

// ── Applique les options d'affichage ────────────────────────
function applyDisplay(d) {
  const r = document.documentElement;
  let opacity = d.bg_opacity ?? 0.75;
  if (opacity > 1) opacity = opacity / 100;
  r.style.setProperty('--card-bg', `rgba(0,0,0,${opacity})`);
  // OBS: dark solid background matching preview look
  r.style.setProperty('--card-bg-obs', `rgba(18,18,22,${Math.min(1, opacity + 0.25)})`);
  r.style.setProperty('--accent', d.accent_color || '#ffffff');
  r.style.setProperty('--text-primary', d.text_primary || '#ffffff');
  r.style.setProperty('--text-secondary', d.text_secondary || 'rgba(255,255,255,0.6)');
  r.style.setProperty('--text-tertiary', d.text_tertiary || 'rgba(255,255,255,0.3)');
  r.style.setProperty('--w', (d.widget_width || 300) + 'px');
  r.style.setProperty('--radius', (d.corner_radius ?? 10) + 'px');
  document.body.style.width = (d.widget_width || 300) + 'px';

  // Theme
  document.body.className = 'overlay ' + (d.stat_animations ? d.stat_animations + '-anim' : '');

  // Peak rank: inline (next to rank name) or below
  const peakInline = d.peak_inline ?? false;
  const peakAlignEl = getElement('peakInline');
  peakAlignEl.className = 'peak-inline align-' + (d.peak_align || 'left');
  if (!(d.show_peak_rank ?? true)) {
    getElement('peakRank').style.display = 'none';
    peakAlignEl.style.display = 'none';
  } else if (peakInline) {
    getElement('peakRank').style.display = 'none';
    peakAlignEl.style.display = 'flex';
  } else {
    getElement('peakRank').style.display = 'block';
    peakAlignEl.style.display = 'none';
  }
  getElement('matchCard').style.display =
    (d.show_last_match ?? true) ? 'flex' : 'none';
  getElement('streakCard').style.display =
    (d.show_streak ?? true) ? 'flex' : 'none';

  // Agent icon visibility
  const matchIcon = getElement('matchIcon');
  if (d.show_agent_icon === false) {
    matchIcon.style.display = 'none';
  } else {
    matchIcon.style.display = 'block';
    matchIcon.style.width = (d.agent_icon_size === 'large' ? '50px' : '30px');
    matchIcon.style.height = (d.agent_icon_size === 'large' ? '50px' : '30px');
  }

  // RR chart visibility
  getElement('rrChartCard').style.display =
    (d.show_rr_chart ?? true) ? 'flex' : 'none';
}

// ── Animations ──────────────────────────────────────────────
function triggerAnimation(type) {
  const rankCard = document.querySelector('.rank-card');
  if (!rankCard) return;

  // Ensure overlay is visible
  showOverlay();

  rankCard.classList.remove(...ANIMATION_CLASSES);
  void rankCard.offsetWidth; // Trigger reflow to reset animation
  rankCard.classList.add(`animate-${type}`);

  setTimeout(() => {
    rankCard.classList.remove(...ANIMATION_CLASSES);
  }, ANIMATION_DURATION);
}

// ── Rank (real API - only used in OBS mode) ──────────────────
function showOverlay() {
  getElement('loadingMsg').classList.add('hidden');
  document.querySelectorAll('.overlay-content').forEach(el => el.classList.remove('hidden'));
}

async function refreshRank() {
  try {
    const res = await fetch('/api/rank');
    const d = await res.json();
    if (!res.ok) {
      console.error('Rank API error:', d);
      getElement('loadingMsg').textContent = 'Erreur: ' + (d.error || 'Compte non trouvé');
      return;
    }

    showOverlay();

    if (shouldAnimate('rank') && lastRankTier !== null) {
      if (d.tier > lastRankTier)      triggerAnimation('rankup');
      else if (d.tier < lastRankTier) triggerAnimation('rankdown');
    }
    lastRankTier = d.tier;

    applyRankData(d);
  } catch(e) {
    console.error('refreshRank error:', e);
  }
}

// ── Matches (real API - only used in OBS mode) ───────────────
async function refreshMatches() {
  const showMatch  = cfg?.display?.show_last_match ?? true;
  const showStreak = cfg?.display?.show_streak     ?? true;
  if (!showMatch && !showStreak) return;

  try {
    const size = showStreak ? 5 : 1;
    const res  = await fetch(`/api/matches?size=${size}`);
    if (!res.ok) return;
    const matches = await res.json();
    if (!matches?.length) return;

    if (showMatch) {
      const m = matches[0];
      const key = matchKeyOf(m);
      const changed = lastMatchId !== null && lastMatchId !== key;

      if (changed && shouldAnimate('match')) {
        if (m.won === true)       triggerAnimation('win');
        else if (m.won === false) triggerAnimation('lose');
      }
      if (changed) refreshRank();
      lastMatchId = key;

      renderMatch(m);
    }

    if (showStreak) {
      getElement('streakCard').style.display = 'flex';
      const filled = matches.slice(0, 5).reverse();
      const sig = filled.map(m => m ? (m.won === true ? 'w' : m.won === false ? 'l' : 'd') : 'e').join('') + '|' + filled.length;
      if (sig !== lastStreakSig) {
        lastStreakSig = sig;
        const dots = getElement('streakDots');
        dots.innerHTML = '';
        for (let i = 0; i < 5; i++) {
          const dot = document.createElement('div');
          const m = filled[i];
          if (!m)                     dot.className = 's-dot empty';
          else if (m.won === true)    dot.className = 's-dot win';
          else if (m.won === false)   dot.className = 's-dot loss';
          else                        dot.className = 's-dot draw';
          dots.appendChild(dot);
        }
      }
      const wr = calculateWinRate(matches);
      const wrEl = getElement('winRate');
      const fmt = cfg?.display?.winrate_format || 'detailed';
      wrEl.textContent = formatWinRate(wr, fmt);
    }
  } catch(e) {
    console.error('refreshMatches error:', e);
  }
}

function renderRRChart() {
  if (!cfg?.display?.show_rr_chart || rrSessionHistory.length === 0) return;
  const rrChartEl = getElement('rrChart');
  if (!rrChartEl) return;

  const maxGames = cfg?.display?.rr_chart_games ?? 20;
  const dataPoints = rrSessionHistory.slice(-maxGames);
  const sessionGain = dataPoints.length > 0 ? dataPoints[dataPoints.length - 1] : 0;

  const W = 240, H = 50;
  const padding = 15;
  const chartW = W - 2 * padding;
  const chartH = H - 2 * padding;

  // Find min/max with 0 always included (baseline)
  const allVals = [0, ...dataPoints];
  const minVal = Math.min(...allVals);
  const maxVal = Math.max(...allVals);
  const range = maxVal - minVal || 1;
  const centerY = padding + ((0 - minVal) / range) * chartH;

  // Build SVG with line, dots, and text
  let svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:50px;overflow:visible;"><defs><style>
    .rr-dot { fill: var(--accent); transition: r 0.2s; }
    .rr-dot:hover { r: 3.5 !important; }
  </style></defs>`;

  // Grid line at 0
  svg += `<line x1="${padding}" y1="${centerY}" x2="${W - padding}" y2="${centerY}" stroke="var(--accent)" stroke-width="0.5" opacity="0.2"/>`;

  // Polyline
  const pts = dataPoints.map((val, i) => {
    const x = padding + (i / (dataPoints.length - 1)) * chartW;
    const y = padding + ((val - minVal) / range) * chartH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  if (pts.length > 0) {
    svg += `<polyline points="${pts.join(' ')}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
  }

  // Dots at each point
  dataPoints.forEach((val, i) => {
    const x = padding + (i / (dataPoints.length - 1)) * chartW;
    const y = padding + ((val - minVal) / range) * chartH;
    const color = val > 0 ? '#5fffb5' : val < 0 ? '#ff5060' : 'var(--accent)';
    svg += `<circle cx="${x}" cy="${y}" r="2" class="rr-dot" fill="${color}" opacity="0.8"/>`;
  });

  // Session gain text
  const lastX = padding + chartW;
  const lastY = padding + ((sessionGain - minVal) / range) * chartH;
  const gainText = sessionGain > 0 ? `+${sessionGain}` : `${sessionGain}`;
  const gainColor = sessionGain > 0 ? '#5fffb5' : sessionGain < 0 ? '#ff5060' : 'var(--accent)';
  svg += `<text x="${lastX - 3}" y="${lastY - 8}" text-anchor="end" fill="${gainColor}" font-size="9" font-family="DM Mono,monospace" font-weight="600">${gainText}</text>`;

  svg += `</svg>`;

  // Create container with session info
  const parent = rrChartEl.parentElement;
  const sessionEl = parent.querySelector('.rr-session-gain');
  if (!sessionEl) {
    const el = document.createElement('div');
    el.className = 'rr-session-gain';
    el.style.cssText = 'font-size:9px;margin-top:4px;text-align:right;font-family:DM Mono,monospace;opacity:0.7;';
    parent.appendChild(el);
  }
  parent.querySelector('.rr-session-gain').textContent = `Session: ${sessionGain > 0 ? '+' : ''}${sessionGain} RR`;

  rrChartEl.innerHTML = svg;
}

// ── WebSocket connection management ────────────────────────────
function connectWebSocket() {
  if (!(cfg?.display?.realtime_notifications ?? true)) return;

  // Clean up old listeners if socket exists
  if (socket) {
    socket.off('connect');
    socket.off('rank');
    socket.off('match');
    socket.off('disconnect');
    socket.off('error');
  } else {
    socket = io();
  }

  socket.on('connect', () => {
    console.log('WebSocket connected');
  });

  socket.on('rank', (data) => {
    try {
      showOverlay();
      lastRankTier = data.tier;
      applyRankData(data);
      if (shouldAnimate('rank') && (data.animation === 'rankup' || data.animation === 'rankdown')) {
        triggerAnimation(data.animation);
      }
    } catch(e) {
      console.error('Rank WebSocket error:', e);
    }
  });

  socket.on('match', (msg) => {
    try {
      if (shouldAnimate('match') && (msg.type === 'win' || msg.type === 'lose' || msg.type === 'draw')) {
        triggerAnimation(msg.type);
      }
      if ((cfg?.display?.show_last_match ?? true) && msg.agent && msg.kills !== undefined) {
        renderMatch(msg);
        lastMatchId = matchKeyOf(msg);
      }
      refreshMatches().catch(e => console.error('refreshMatches error:', e));
    } catch(e) {
      console.error('Match parse error:', e);
    }
  });

  socket.on('disconnect', () => {
    console.log('WebSocket disconnected');
  });

  socket.on('error', (err) => {
    console.error('WebSocket error:', err);
  });
}

// ── Init ──────────────────────────────────────────────────────
async function init() {
  // 1. Load display settings from localStorage (instant, synchronous)
  try {
    const stored = localStorage.getItem(STORAGE_DISPLAY_KEY);
    if (stored) {
      cfg = { display: JSON.parse(stored) };
    }
  } catch(e) {}

  // 2. Fallback: load from local API (fast, same server)
  if (!cfg) {
    try {
      const res = await fetch('/api/config');
      cfg = await res.json();
    } catch(e) {
      cfg = { display: {} };
    }
  }

  // 3. Apply display and show container immediately
  applyDisplay(cfg.display || {});
  getElement('container').classList.add('show');

  // 4. Initialize display tracking
  lastSessionStorageCleared = localStorage.getItem(STORAGE_DISPLAY_KEY);

  // ── Common listeners (both preview and OBS modes) ──────────────
  // Listen for account changes from setup page (real-time refresh)
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_ACCOUNT_CHANGE_KEY) {
      // Account changed, clear session and refresh
      console.log('Account change detected, refreshing...');
      sessionStorage.clear();
      lastRankTier = null;
      lastMatchId = null;
      getElement('loadingMsg').textContent = 'Chargement des données...';
      getElement('loadingMsg').classList.remove('hidden');
      refreshRank();
      refreshMatches();
    }
    if (e.key === STORAGE_TEST_ANIMATION_KEY) {
      // Test animation from setup page
      try {
        const msg = JSON.parse(e.newValue);
        console.log('Test animation:', msg);
        triggerAnimation(msg.type);
      } catch(e) {}
    }
    // Monitor for config changes
    if (e.key === STORAGE_DISPLAY_KEY && e.newValue !== lastSessionStorageCleared) {
      lastSessionStorageCleared = e.newValue;
      try {
        cfg.display = JSON.parse(e.newValue);
        applyDisplay(cfg.display);
        // Reconnect WebSocket if realtime notifications setting changed
        connectWebSocket();
        // Refresh data when display settings change to ensure correct content is shown
        if (!IS_PREVIEW) {
          refreshRank();
          refreshMatches();
        }
      } catch(e) {}
    }
  });

  // Listen for test messages from parent window (iframe mode)
  window.addEventListener('message', (e) => {
    if (e.data?.type === 'ranktest' && e.data?.detail?.type) {
      triggerAnimation(e.data.detail.type);
    }
    if (e.data?.type === 'matchtest' && e.data?.detail?.type) {
      triggerAnimation(e.data.detail.type);
    }
  });

  // Listen for custom events (direct page mode)
  window.addEventListener('valoRankTest', (e) => {
    triggerAnimation(e.detail.type);
  });

  window.addEventListener('valoMatchTest', (e) => {
    triggerAnimation(e.detail.type);
  });

  // 5. PREVIEW MODE: show loading, fetch real data, sync settings via localStorage
  if (IS_PREVIEW) {
    refreshRank();
    refreshMatches();

    // Poll localStorage every 300ms for instant display settings sync in preview
    let lastCheck = localStorage.getItem(STORAGE_DISPLAY_KEY);
    setInterval(() => {
      try {
        const stored = localStorage.getItem(STORAGE_DISPLAY_KEY);
        if (stored !== lastCheck) {
          lastCheck = stored;
          cfg.display = JSON.parse(stored);
          applyDisplay(cfg.display);
        }
      } catch(e) {}
    }, 300);
    return;
  }

  // 6. OBS MODE: apply obs-mode class for frosted glass simulation
  document.body.classList.add('obs-mode');
  refreshRank();
  refreshMatches();

  // Connect to WebSocket for real-time updates (polling handled server-side)
  connectWebSocket();
}

// Initialize on page load
init();
