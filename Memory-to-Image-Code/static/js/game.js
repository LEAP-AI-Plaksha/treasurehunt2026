/* ===================================================
   Memory to Image — Game State Machine
   States: LOGIN → IMAGES → SWITCH → PROMPT → LOADING → SCORE
   =================================================== */

(function () {
  'use strict';

  // ---- State & Variables ----
  let currentState  = 'LOGIN';
  let authToken     = null;
  let teamName      = '';
  let displaySeconds = 10;
  let promptSeconds  = 60;
  let timerInterval  = null;

  // ---- DOM References ----
  const $  = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const screens = {
    LOGIN:   '#screen-login',
    IMAGES:  '#screen-images',
    SWITCH:  '#screen-switch',
    PROMPT:  '#screen-prompt',
    LOADING: '#screen-loading',
    SCORE:   '#screen-score',
  };

  // ---- Screen Management ----

  /**
   * Hide every .screen, then show the target and set it as active.
   * Also auto-focuses the first visible input/textarea on the new screen.
   */
  function showScreen(screenId) {
    $$('.screen').forEach((el) => el.classList.remove('active'));

    const target = $(screenId);
    if (!target) return;

    // Small delay so the CSS opacity transition triggers
    requestAnimationFrame(() => {
      target.classList.add('active');

      // Auto-focus the first input or textarea inside the screen
      const focusable = target.querySelector('input:not([type="hidden"]), textarea');
      if (focusable) {
        setTimeout(() => focusable.focus(), 80);
      }
    });
  }

  // ---- API Utility ----

  /**
   * Wrapper around fetch that auto-adds auth header and JSON content-type.
   * Returns parsed JSON on success; throws on network or HTTP errors.
   */
  async function apiFetch(url, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };

    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    const res = await fetch(url, {
      ...options,
      headers,
    });

    const data = await res.json().catch(() => null);

    if (!res.ok) {
      const msg =
        (data && (data.error || data.message || data.detail)) ||
        `Request failed (${res.status})`;
      throw new Error(msg);
    }

    return data;
  }

  // ---- Timer ----

  /**
   * Reusable countdown timer.
   * @param {number}      seconds        Total seconds.
   * @param {HTMLElement}  displayElement Element whose textContent is updated.
   * @param {Function}     onComplete     Callback when timer reaches 0.
   * @param {object}       options        { format: 'mm:ss' | 'seconds' }
   * @returns {number}     Interval ID.
   */
  function startTimer(seconds, displayElement, onComplete, options = {}) {
    let remaining = seconds;
    const fmt = options.format || 'mm:ss';
    const warnAt    = Math.floor(seconds * 0.5);
    const critAt    = Math.floor(seconds * 0.25);

    function formatTime(s) {
      if (fmt === 'seconds') return `${s}`;
      const m = String(Math.floor(s / 60)).padStart(2, '0');
      const sc = String(s % 60).padStart(2, '0');
      return `${m}:${sc}`;
    }

    function applyColor() {
      displayElement.classList.remove('warning', 'critical');
      if (remaining <= critAt) {
        displayElement.classList.add('critical');
      } else if (remaining <= warnAt) {
        displayElement.classList.add('warning');
      }
    }

    // Initial render
    displayElement.textContent = formatTime(remaining);
    applyColor();

    const id = setInterval(() => {
      remaining--;
      if (remaining < 0) remaining = 0;
      displayElement.textContent = formatTime(remaining);
      applyColor();

      if (remaining <= 0) {
        clearInterval(id);
        if (onComplete) onComplete();
      }
    }, 1000);

    return id;
  }

  // ---- Login ----

  async function login() {
    const nameInput = $('#input-team-name');
    const passInput = $('#input-password');
    const errorEl   = $('#login-error');
    const btn       = $('#btn-login');

    const team_name = nameInput.value.trim();
    const password  = passInput.value;

    errorEl.textContent = '';

    if (!team_name || !password) {
      errorEl.textContent = 'Please enter team name and password.';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Logging in…';

    try {
      const data = await apiFetch('/api/login', {
        method: 'POST',
        body: JSON.stringify({ team_name, password }),
      });

      // Store session info
      authToken      = data.token || data.access_token || '';
      teamName       = team_name;
      displaySeconds = data.display_seconds || data.displaySeconds || 10;
      promptSeconds  = data.prompt_seconds  || data.promptSeconds  || 60;

      currentState = 'IMAGES';
      startGame();
    } catch (err) {
      errorEl.textContent = err.message || 'Login failed. Try again.';
      btn.disabled = false;
      btn.textContent = 'Login';
    }
  }

  // ---- Game Flow ----

  async function startGame() {
    try {
      const data = await apiFetch('/api/game/images', {
        method: 'POST',
      });

      // Backend returns { left: "/static/images/...", right: "/static/images/..." }
      $('#img-display-1').src = data.left || '';
      $('#img-display-2').src = data.right || '';

      showScreen(screens.IMAGES);

      // Start viewing timer
      const timerEl = $('#images-timer');
      timerInterval = startTimer(displaySeconds, timerEl, () => {
        currentState = 'SWITCH';
        showScreen(screens.SWITCH);
      });
    } catch (err) {
      $('#login-error').textContent = err.message || 'Could not load images.';
      showScreen(screens.LOGIN);
      $('#btn-login').disabled = false;
      $('#btn-login').textContent = 'Login';
    }
  }

  function onSwitchReady() {
    currentState = 'PROMPT';
    showScreen(screens.PROMPT);

    const timerEl = $('#prompt-timer');
    timerInterval = startTimer(promptSeconds, timerEl, () => {
      // Auto-submit when time runs out
      submitPrompts();
    });
  }

  async function submitPrompts() {
    // Prevent double-submit
    const btn = $('#btn-submit-prompts');
    if (btn.disabled) return;

    clearInterval(timerInterval);

    const prompt_left  = $('#textarea-prompt-1').value.trim();
    const prompt_right = $('#textarea-prompt-2').value.trim();
    const errorEl      = $('#prompt-error');

    errorEl.textContent = '';

    if (!prompt_left && !prompt_right) {
      errorEl.textContent = 'Please enter at least one prompt to generate an image.';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Submitting…';

    currentState = 'LOADING';
    showScreen(screens.LOADING);

    try {
      await apiFetch('/api/game/generate', {
        method: 'POST',
        body: JSON.stringify({ prompt_left, prompt_right }),
      });

      await getScores();
    } catch (err) {
      // Return to prompt screen so user can retry
      currentState = 'PROMPT';
      showScreen(screens.PROMPT);
      errorEl.textContent = err.message || 'Generation failed. Please try again.';
      btn.disabled = false;
      btn.textContent = 'Generate Images';
    }
  }

  async function getScores() {
    try {
      const data = await apiFetch('/api/game/score', {
        method: 'POST',
      });

      const left  = data.results.left;
      const right = data.results.right;

      // Populate score screen images
      $('#img-original-1').src  = left.original  || '';
      $('#img-original-2').src  = right.original || '';
      $('#img-generated-1').src = left.generated  || '';
      $('#img-generated-2').src = right.generated || '';

      // Combined scores
      const combined1 = left.combined_pct  ?? 0;
      const combined2 = right.combined_pct ?? 0;
      const score1    = left.score  ?? 0;
      const score2    = right.score ?? 0;
      const total     = data.total_score ?? (score1 + score2);

      // Animate combined percentage
      animateValue($('#similarity-1'), combined1, '%');
      animateValue($('#similarity-2'), combined2, '%');

      // Score badges
      $('#score-badge-1').textContent = `${score1}/10`;
      $('#score-badge-2').textContent = `${score2}/10`;
      $('#total-score').textContent   = `${total}/20`;
      $('#team-name-display').textContent = teamName ? `Team: ${teamName}` : '';

      // Color-code combined similarity
      applySimilarityColor($('#similarity-1'), combined1);
      applySimilarityColor($('#similarity-2'), combined2);

      // Animate breakdown bars for Image 1
      animateBar('bar-content-1',   'val-content-1',   left.content_pct   ?? 0);
      animateBar('bar-structure-1',  'val-structure-1',  left.structure_pct ?? 0);
      animateBar('bar-color-1',     'val-color-1',     left.color_pct     ?? 0);

      // Animate breakdown bars for Image 2
      animateBar('bar-content-2',   'val-content-2',   right.content_pct   ?? 0);
      animateBar('bar-structure-2',  'val-structure-2',  right.structure_pct ?? 0);
      animateBar('bar-color-2',     'val-color-2',     right.color_pct     ?? 0);

      currentState = 'SCORE';
      showScreen(screens.SCORE);
    } catch (err) {
      const loadingSub = $('.loading-sub');
      if (loadingSub) {
        loadingSub.textContent = err.message || 'Could not retrieve scores.';
      }
    }
  }

  /**
   * Animate a breakdown bar fill and its value label.
   */
  function animateBar(barId, valueId, targetPct) {
    const bar   = document.getElementById(barId);
    const label = document.getElementById(valueId);
    if (!bar || !label) return;

    const duration = 1200;
    const start = performance.now();
    const rounded = Math.round(targetPct);

    function tick(now) {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const ease = 1 - (1 - progress) * (1 - progress); // ease-out quad
      const current = Math.round(ease * rounded);

      bar.style.width = `${current}%`;
      label.textContent = `${current}%`;

      if (progress < 1) requestAnimationFrame(tick);
    }

    requestAnimationFrame(tick);
  }

  // ---- Helpers ----

  /**
   * Animate a numeric value from 0 → target over ~1 second.
   */
  function animateValue(element, target, suffix = '') {
    const duration = 1000; // ms
    const start = performance.now();
    const rounded = Math.round(target);

    function tick(now) {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      // ease-out quad
      const ease = 1 - (1 - progress) * (1 - progress);
      const current = Math.round(ease * rounded);
      element.textContent = `${current}${suffix}`;
      if (progress < 1) requestAnimationFrame(tick);
    }

    requestAnimationFrame(tick);
  }

  /**
   * Apply .high / .medium / .low class based on similarity percentage.
   */
  function applySimilarityColor(element, value) {
    element.classList.remove('high', 'medium', 'low');
    if (value >= 70) {
      element.classList.add('high');
    } else if (value >= 40) {
      element.classList.add('medium');
    } else {
      element.classList.add('low');
    }
  }

  // ---- Event Listeners ----

  document.addEventListener('DOMContentLoaded', () => {
    // Login
    $('#btn-login').addEventListener('click', login);

    // Enter key on login fields
    $('#input-team-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') login();
    });
    $('#input-password').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') login();
    });

    // Switch screen → Ready
    $('#btn-ready').addEventListener('click', onSwitchReady);

    // Submit prompts
    $('#btn-submit-prompts').addEventListener('click', submitPrompts);

    // Ensure Enter in textareas does NOT submit (default is fine — textarea
    // naturally inserts a newline on Enter, so no special handling needed).
  });
})();
