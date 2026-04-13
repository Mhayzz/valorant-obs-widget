// ── Valorant OBS Widget - Overlay Logic ──────────────────────
// Main client-side logic for the overlay widget

let cfg = null;
let prevChange = undefined;
let IS_PREVIEW = false;
try { IS_PREVIEW = new URLSearchParams(window.location.search).has('preview') || window.self !== window.top; } catch(e) { IS_PREVIEW = true; }

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
  document.body.style.width = (d.widget_width || 300) + 'px';

  // Peak rank: inline (next to rank name) or below
  const peakInline = d.peak_inline ?? false;
  const peakAlignEl = document.getElementById('peakInline');
  peakAlignEl.className = 'peak-inline align-' + (d.peak_align || 'left');
  if (!(d.show_peak_rank ?? true)) {
    document.getElementById('peakRank').style.display = 'none';
    peakAlignEl.style.display = 'none';
  } else if (peakInline) {
    document.getElementById('peakRank').style.display = 'none';
    peakAlignEl.style.display = 'flex';
  } else {
    document.getElementById('peakRank').style.display = 'block';
    peakAlignEl.style.display = 'none';
  }
  document.getElementById('matchCard').style.display =
    (d.show_last_match ?? true) ? 'flex' : 'none';
  document.getElementById('streakCard').style.display =
    (d.show_streak ?? true) ? 'flex' : 'none';
}

// ── Animations ──────────────────────────────────────────────
let lastRankTier = null;
let lastMatchId = null;

function triggerAnimation(type) {
  const rankCard = document.querySelector('.rank-card');
  if (!rankCard) return;

  // Ensure overlay is visible
  showOverlay();

  rankCard.classList.remove('animate-rankup', 'animate-rankdown', 'animate-win', 'animate-lose');
  void rankCard.offsetWidth; // Trigger reflow to reset animation
  rankCard.classList.add(`animate-${type}`);

  setTimeout(() => {
    rankCard.classList.remove('animate-rankup', 'animate-rankdown', 'animate-win', 'animate-lose');
  }, 800);
}

// ── Rank (real API - only used in OBS mode) ──────────────────
function showOverlay() {
  document.getElementById('loadingMsg').classList.add('hidden');
  document.querySelectorAll('.overlay-content').forEach(el => el.classList.remove('hidden'));
}

async function refreshRank() {
  try {
    const res = await fetch('/api/rank');
    let d = await res.json();
    if (!res.ok) {
      console.error('Rank API error:', d);
      document.getElementById('loadingMsg').textContent = 'Erreur: ' + (d.error || 'Compte non trouvé');
      return;
    }

    showOverlay();

    // Detect rank changes for animation
    if ((cfg?.display?.realtime_notifications ?? true) && (cfg?.display?.animation_type ?? 'rank') === 'rank' && lastRankTier !== null) {
      if (d.tier > lastRankTier) triggerAnimation('rankup');
      else if (d.tier < lastRankTier) triggerAnimation('rankdown');
    }
    lastRankTier = d.tier;

    document.getElementById('rankName').textContent = d.rank;
    document.getElementById('rrLabel').textContent  = d.rr + ' RR';
    document.getElementById('fill').style.width     = Math.min(100, Math.max(0, d.rr)) + '%';

    if (d.tier > 0) {
      const ico = document.getElementById('ico');
      ico.style.display = 'block';
      ico.src = d.rank_icon;
      ico.onerror = () => {
        ico.src = `https://media.valorant-api.com/competitivetiers/564d8e28-c226-3180-6285-e48a390db8b1/${d.tier}/largeicon.png`;
      };
    }

    const peakEl = document.getElementById('peakRank');
    const peakInline = document.getElementById('peakInline');
    // Always populate peak rank data if available (visibility controlled by applyDisplay)
    if (d.peak_rank) {
      const tier = d.peak_tier;
      const peakImg = `<img src="https://media.valorant-api.com/competitivetiers/564d8e28-c226-3180-6285-e48a390db8b1/${tier}/largeicon.png" alt="" class="peak-icon" onerror="this.src='https://media.valorant-api.com/competitivetiers/03621f52-342b-cf4e-4f86-9350a49c6d04/${tier}/largeicon.png'">`;
      peakEl.innerHTML = `PEAK ${peakImg}`;
      peakInline.innerHTML = 'PEAK ' + peakImg;
      peakInline.className = 'peak-inline align-' + (cfg?.display?.peak_align || 'left');

      // Show/hide based on settings
      if ((cfg?.display?.show_peak_rank ?? true)) {
        if (cfg?.display?.peak_inline) {
          peakEl.style.display = 'none';
          peakInline.style.display = 'flex';
        } else {
          peakEl.style.display = 'block';
          peakInline.style.display = 'none';
        }
      } else {
        peakEl.style.display = 'none';
        peakInline.style.display = 'none';
      }
    } else {
      peakEl.style.display = 'none';
      peakInline.style.display = 'none';
    }

    const chg = d.rr_change;
    const badge = document.getElementById('badge');
    badge.className = 'rr-badge ' + (chg === null ? 'neu' : chg > 0 ? 'pos' : chg < 0 ? 'neg' : 'neu');
    document.getElementById('badgeNum').textContent = chg === null ? '—' : (chg > 0 ? '+' : '') + chg;
    prevChange = chg;
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

      // Detect match result changes for animation
      const matchKey = `${m.agent}${m.kills}${m.deaths}${m.assists}`;
      if ((cfg?.display?.realtime_notifications ?? true) && (cfg?.display?.animation_type ?? 'rank') === 'match' && lastMatchId !== null && lastMatchId !== matchKey) {
        if (m.won === true) triggerAnimation('win');
        else if (m.won === false) triggerAnimation('lose');
      }

      // When match changes, also refresh rank to update RR
      if (lastMatchId !== null && lastMatchId !== matchKey) {
        refreshRank();
      }
      lastMatchId = matchKey;

      document.getElementById('matchCard').style.display = 'flex';
      const icon = document.getElementById('matchIcon');
      if (m.agent_icon) {
        icon.src = m.agent_icon;
        icon.style.display = 'block';
        icon.onerror = () => { icon.style.display = 'none'; };
      }
      document.getElementById('matchAgent').textContent = m.agent;
      document.getElementById('matchKda').textContent =
        `${m.kills}/${m.deaths}/${m.assists}${m.map ? ' • ' + m.map : ''}`;
      const res2 = document.getElementById('matchResult');
      if (m.won === null)  { res2.className = 'match-result draw'; res2.textContent = '?'; }
      else if (m.won)      { res2.className = 'match-result win';  res2.textContent = 'V'; }
      else                 { res2.className = 'match-result loss'; res2.textContent = 'D'; }
    }

    if (showStreak) {
      document.getElementById('streakCard').style.display = 'flex';
      const dots = document.getElementById('streakDots');
      dots.innerHTML = '';
      const filled = matches.slice(0, 5).reverse();
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
  } catch(e) {
    console.error('refreshMatches error:', e);
  }
}

// ── WebSocket connection management ────────────────────────────
let socket = null;
let lastSessionStorageCleared = null;

function connectWebSocket() {
  if (!(cfg?.display?.realtime_notifications ?? true)) return;

  if (!socket) {
    socket = io();

    socket.on('connect', () => {
      console.log('WebSocket connected');
    });

    socket.on('rank', (msg) => {
      try {
        console.log('Rank event, refreshing...', msg);
        if ((cfg?.display?.animation_type ?? 'rank') === 'rank' && (msg.type === 'rankup' || msg.type === 'rankdown')) {
          triggerAnimation(msg.type);
          lastRankTier = msg.tier;
        }
        refreshRank().catch(e => console.error('refreshRank error:', e));
      } catch(e) {
        console.error('Rank parse error:', e);
      }
    });

    socket.on('match', (msg) => {
      try {
        console.log('Match event received:', msg);
        if ((cfg?.display?.animation_type ?? 'rank') === 'match' && (msg.type === 'win' || msg.type === 'lose' || msg.type === 'draw')) {
          console.log('Triggering animation:', msg.type);
          triggerAnimation(msg.type);
        }
        lastMatchId = null;
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
}

// ── Init ──────────────────────────────────────────────────────
async function init() {
  // 1. Load display settings from localStorage (instant, synchronous)
  try {
    const stored = localStorage.getItem('valo_display');
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
  document.getElementById('container').classList.add('show');

  // 4. Initialize display tracking
  lastSessionStorageCleared = localStorage.getItem('valo_display');

  // ── Common listeners (both preview and OBS modes) ──────────────
  // Listen for account changes from setup page (real-time refresh)
  window.addEventListener('storage', (e) => {
    if (e.key === 'valo_account_change') {
      // Account changed, clear session and refresh
      console.log('Account change detected, refreshing...');
      sessionStorage.clear();
      lastRankTier = null;
      lastMatchId = null;
      document.getElementById('loadingMsg').textContent = 'Chargement des données...';
      document.getElementById('loadingMsg').classList.remove('hidden');
      refreshRank();
      refreshMatches();
    }
    if (e.key === 'valo_test_animation') {
      // Test animation from setup page
      try {
        const msg = JSON.parse(e.newValue);
        console.log('Test animation:', msg);
        triggerAnimation(msg.type);
      } catch(e) {}
    }
    // Monitor for config changes
    if (e.key === 'valo_display' && e.newValue !== lastSessionStorageCleared) {
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
    let lastCheck = localStorage.getItem('valo_display');
    setInterval(() => {
      try {
        const stored = localStorage.getItem('valo_display');
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
  setInterval(refreshRank, 15000);
  setInterval(refreshMatches, 15000);

  // Connect to WebSocket streams for real-time updates
  connectWebSocket();

  // Poll localStorage every 50ms for OBS (faster refresh detection)
  let lastCheck = localStorage.getItem('valo_display');
  let lastAccountChange = localStorage.getItem('valo_account_change');
  setInterval(() => {
    try {
      const stored = localStorage.getItem('valo_display');
      if (stored !== lastCheck) {
        lastCheck = stored;
        cfg.display = JSON.parse(stored);
        applyDisplay(cfg.display);
        // Force DOM refresh in OBS
        void document.documentElement.offsetHeight;
      }

      // Also check for account change events in case storage events don't fire in OBS
      const accountChange = localStorage.getItem('valo_account_change');
      if (accountChange !== lastAccountChange) {
        lastAccountChange = accountChange;
        console.log('Account change detected via localStorage polling');
        sessionStorage.clear();
        lastRankTier = null;
        lastMatchId = null;
        document.getElementById('loadingMsg').textContent = 'Chargement des données...';
        document.getElementById('loadingMsg').classList.remove('hidden');
        // Trigger immediate refresh
        setTimeout(() => {
          refreshRank();
          refreshMatches();
        }, 100);
      }
    } catch(e) {}
  }, 50);

  // Reload config from API every 1 second (instant account/data updates in OBS)
  let lastConfigAccount = `${cfg?.riot_name}#${cfg?.riot_tag}`;
  setInterval(async () => {
    try {
      const res = await fetch('/api/config');
      if (res.ok) {
        const newCfg = await res.json();
        const currentAccount = `${newCfg?.riot_name}#${newCfg?.riot_tag}`;

        // Check if account changed
        const accountChanged = lastConfigAccount !== currentAccount;

        cfg = newCfg;
        applyDisplay(cfg.display || {});

        // Only reconnect WebSocket if account actually changed
        if (accountChanged) {
          connectWebSocket();
        }

        // Refresh data if account changed
        if (accountChanged) {
          lastConfigAccount = currentAccount;
          sessionStorage.clear();
          lastRankTier = null;
          lastMatchId = null;
          // Show loading message and ensure overlay is visible
          document.getElementById('loadingMsg').textContent = 'Chargement des données...';
          document.getElementById('loadingMsg').classList.remove('hidden');
          refreshRank();
          refreshMatches();
        }
      }
    } catch(e) {}
  }, 1000);
}

// Initialize on page load
init();
