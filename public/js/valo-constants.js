// Shared constants for the Valorant OBS widget. Loaded by both
// setup.html and overlay.js so rename/change stays in one place.
window.VALO_KEYS = Object.freeze({
  DISPLAY:         'valo_display',
  ACCOUNT_CHANGE:  'valo_account_change',
  TEST_ANIMATION:  'valo_test_animation',
  RR_TEST:         'valo_rr_test',
});

window.VALO_MESSAGE_TYPES = Object.freeze({
  RR_ADDGAME: 'rr_addgame',
  RR_RESET:   'rr_reset',
});

window.VALO_RR_DELTA_MAX = 25;
