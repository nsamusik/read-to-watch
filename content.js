// Read To Watch — Content Script (v0.4.4)
// ------------------------------------------------------------
// Hardened for production:
//  • Audio tones: START before STOP (no InvalidStateError)
//  • Word recognition: match only latest FINAL result, last 4 tokens, threshold 0.68
//  • Voice pickup meter (RMS) for debugging
//  • Gesture fallback: "Tap to enable mic" when Chrome blocks start()
//  • Debug gate support via message: {type: "RTW_DEBUG_GATE"}
//  • Confetti, progress tracking, screen time limit, optional retell
//  • Fixed: onspeechend delay to prevent premature word errors (v0.4.4)
// ------------------------------------------------------------
(function () {
  'use strict';

  // ========== 0) ENV & HELPERS ==========

  const HOST = location.host;
  const IS_YT = HOST.includes('youtube.com');
  const IS_DP = HOST.includes('disneyplus.com');

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function isExtensionAlive() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); }
    catch (e) { return false; }
  }

  // ========== 1) SETTINGS & STATE ==========

  const DEFAULTS = {
    enabled: true,
    level: 1,
    gateYouTube: true,
    gateDisneyPlus: true,
    parentCode: '0429',
    toggleAutoplay: true,
    requireFullPass: false,
    soundEffects: true,
    showProgress: true,
    breakLength: 15,
    maxAttempts: 2,
    autoStartAfterBreak: true,
    askRetell: false,
    retellLength: 60,
    voicePrompts: true,
    dailyScreenLimit: 0, // 0 = unlimited
    debugMode: false     // honored if popup stores it
  };

  let settings = { ...DEFAULTS };

  let wordsData = null;
  let progressData = {};
  let sessionData = { sessions: [], screenTime: {} };
  let masteredWords = new Set();
  let strugglingWords = {};
  let focusWords = [];

  // Session / challenge state
  let challengeActive = false;
  let lastChallengedKey = null;
  let breakTimerInterval = null;
  let currentVideo = null;
  let sessionStartTime = null;

  // Reading flow state
  let currentSentence = '';
  let wordsArray = [];
  let currentWordIndex = 0;
  let wordAttempts = [];
  let wordsHelped = [];

  // Audio
  let audioContext = null;

  // Voice meter
  let meterStream = null, meterSource = null, meterAnalyser = null, meterRAF = null;

  // Speech Recognition
  let recog = null;
  let recogActive = false;
  let recogShouldRun = false;
  let recogRestartAttempts = 0;
  const MAX_RESTARTS = 8;
  let speechEndTimer = null;

  // ========== 2) STORAGE IO ==========

  async function loadSettings() {
    return new Promise((resolve) => {
      try {
        if (!isExtensionAlive()) { settings = { ...DEFAULTS }; return resolve(settings); }
        chrome.storage.sync.get(Object.keys(DEFAULTS), (res) => {
          settings = { ...DEFAULTS, ...(res || {}) };
          resolve(settings);
        });
      } catch (e) { settings = { ...DEFAULTS }; resolve(settings); }
    });
  }

  async function loadWords() {
    if (wordsData) return wordsData;
    try {
      const url = chrome.runtime.getURL('words.json');
      const res = await fetch(url);
      wordsData = await res.json();
    } catch (e) {
      wordsData = { levels: [{ id: 1, name: 'Fallback', sentences: ['Read this sentence.'] }] };
    }
    return wordsData;
  }

  async function loadProgress() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(['progress', 'sessionData', 'masteredWords', 'strugglingWords', 'focusWords'], (res) => {
          progressData    = res.progress || {};
          sessionData     = res.sessionData || { sessions: [], screenTime: {} };
          masteredWords   = new Set(res.masteredWords || []);
          strugglingWords = res.strugglingWords || {};
          focusWords      = res.focusWords || [];
          resolve();
        });
      } catch (e) { resolve(); }
    });
  }

  async function saveProgress() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set({
          progress: progressData,
          sessionData,
          masteredWords: Array.from(masteredWords),
          strugglingWords,
          focusWords
        }, resolve);
      } catch (e) { resolve(); }
    });
  }

  // ========== 3) ANALYTICS & LIMITS ==========

  function recordSession(sentence, wordsTotal, wordsCorrect, helpedCount, ts) {
    const today = new Date().toISOString().split('T')[0];
    if (!progressData[today]) progressData[today] = { sentences: [], count: 0 };
    progressData[today].sentences.push(sentence);
    progressData[today].count++;

    if (!sessionData.sessions) sessionData.sessions = [];
    const fam = ((wordsCorrect - helpedCount) / Math.max(1, wordsTotal)) * 100;
    sessionData.sessions.push({
      sentence,
      wordsTotal,
      wordsCorrect,
      wordsHelped: helpedCount,
      firstAttemptMastery: fam.toFixed(1),
      timestamp: ts,
      site: IS_YT ? 'YouTube' : 'Disney+',
      retellFile: null
    });
    if (sessionData.sessions.length > 200) sessionData.sessions = sessionData.sessions.slice(-200);
    saveProgress();
  }

  function recordScreenTime(minutes) {
    const today = new Date().toISOString().split('T')[0];
    const platform = IS_YT ? 'youtube' : 'disneyplus';
    if (!sessionData.screenTime) sessionData.screenTime = {};
    if (!sessionData.screenTime[today]) sessionData.screenTime[today] = { youtube: 0, disneyplus: 0 };
    sessionData.screenTime[today][platform] += minutes;
    saveProgress();
  }

  function getTodayScreenTime() {
    const today = new Date().toISOString().split('T')[0];
    const st = sessionData.screenTime?.[today]; if (!st) return 0;
    return (st.youtube || 0) + (st.disneyplus || 0);
  }

  function calculateStreak() {
    const dates = Object.keys(progressData).sort().reverse();
    let streak = 0;
    for (let i = 0; i < dates.length; i++) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const expected = d.toISOString().split('T')[0];
      if (dates[i] === expected) streak++; else break;
    }
    return streak;
  }

  function getTodayStats() {
    const today = new Date().toISOString().split('T')[0];
    const td = progressData[today] || { count: 0 };
    return { count: td.count || 0, streak: calculateStreak() };
  }

  function checkScreenTimeLimit() {
    return !!(settings.dailyScreenLimit && getTodayScreenTime() >= settings.dailyScreenLimit);
    // Require a parent override on the limit screen
  }

  // ========== 4) AUDIO & TTS ==========

  function initAudio() {
    if (!audioContext && settings.soundEffects) {
      try { audioContext = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { /* no-op */ }
    }
  }

  function resumeAudio() {
    if (!audioContext) return;
    if (audioContext.state === 'suspended') {
      try { audioContext.resume().catch(()=>{}); } catch(_) {}
    }
  }

  function playChime(type = 'soft') {
    try {
      if (!settings.soundEffects) return;
      if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
      resumeAudio();
      const now = audioContext.currentTime;
      const osc = audioContext.createOscillator();
      const g   = audioContext.createGain();
      osc.connect(g); g.connect(audioContext.destination);

      // ALWAYS start first, then schedule envelopes and stop (prevents InvalidStateError)
      osc.start(now);

      if (type === 'soft') {
        osc.frequency.setValueAtTime(523.25, now);
        g.gain.setValueAtTime(0.20, now);
        g.gain.exponentialRampToValueAtTime(0.01, now + 0.60);
        osc.stop(now + 0.60);
      } else if (type === 'success') {
        osc.frequency.setValueAtTime(523.25, now);
        osc.frequency.setValueAtTime(659.25, now + 0.10);
        osc.frequency.setValueAtTime(783.99, now + 0.20);
        g.gain.setValueAtTime(0.30, now);
        g.gain.exponentialRampToValueAtTime(0.01, now + 0.50);
        osc.stop(now + 0.50);
      } else if (type === 'error') {
        osc.frequency.setValueAtTime(200.00, now);
        g.gain.setValueAtTime(0.20, now);
        g.gain.exponentialRampToValueAtTime(0.01, now + 0.30);
        osc.stop(now + 0.30);
      } else {
        osc.frequency.setValueAtTime(440.00, now);
        g.gain.setValueAtTime(0.10, now);
        g.gain.exponentialRampToValueAtTime(0.01, now + 0.20);
        osc.stop(now + 0.20);
      }
    } catch (e) {
      try { console.warn('[RTW] playChime failed:', e); } catch(_) {}
    }
  }

  function playWordSound() {
    try {
      if (!settings.soundEffects) return;
      if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
      resumeAudio();
      const now = audioContext.currentTime;
      const osc = audioContext.createOscillator();
      const g   = audioContext.createGain();
      osc.connect(g); g.connect(audioContext.destination);

      // START before STOP — prevents InvalidStateError
      osc.start(now);
      osc.frequency.setValueAtTime(440.00, now);
      g.gain.setValueAtTime(0.10, now);
      g.gain.exponentialRampToValueAtTime(0.01, now + 0.12);
      osc.stop(now + 0.12);
    } catch (e) {
      try { console.warn('[RTW] playWordSound failed:', e); } catch(_) {}
    }
  }

  async function speak(text, rate = 0.9) {
    if (!settings.voicePrompts) return;
    if (!('speechSynthesis' in window)) return;
    return new Promise((resolve) => {
      try {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.rate = rate; u.pitch = 1.1; u.volume = 0.9;
        u.onend = resolve; u.onerror = resolve;
        window.speechSynthesis.speak(u);
      } catch (e) { resolve(); }
    });
  }

  // ========== 5) TEXT HELPERS ==========

  function levenshtein(a, b) {
    const al = a.length, bl = b.length;
    if (!al) return bl; if (!bl) return al;
    const dp = Array.from({ length: al + 1 }, () => new Array(bl + 1).fill(0));
    for (let i = 0; i <= al; i++) dp[i][0] = i;
    for (let j = 0; j <= bl; j++) dp[0][j] = j;
    for (let i = 1; i <= al; i++) {
      for (let j = 1; j <= bl; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      }
    }
    return dp[al][bl];
  }

  function similarity(a, b) {
    a = (a || '').toLowerCase();
    b = (b || '').toLowerCase();
    const dist = levenshtein(a, b);
    const denom = Math.max(a.length, b.length) || 1;
    return 1 - (dist / denom);
  }

  function normalize(s) {
    return (s || '').toLowerCase().replace(/[^a-z0-9\s']/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function tokenize(s) {
    return normalize(s).split(' ').filter(Boolean);
  }

  function chooseSentence(levelId) {
    const levels = (wordsData && wordsData.levels) || [];
    const lvl = levels.find(l => l.id === levelId) || levels[0];
    let arr = lvl ? (lvl.sentences || []) : [];
    if (arr.length === 0) return 'Read this sentence.';

    // Prefer sentences containing struggling/focus words
    const targets = [...Object.keys(strugglingWords), ...(focusWords || [])];
    if (targets.length) {
      const filtered = arr.filter(sent => tokenize(sent).some(w => targets.includes(w)));
      if (filtered.length) arr = filtered;
    }
    return arr[Math.floor(Math.random() * arr.length)];
  }

  // ========== 6) OVERLAY UI ==========

  function ensureOverlay() {
    if (document.getElementById('rtw-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'rtw-overlay';
    overlay.innerHTML = `
      <div id="rtw-card" role="dialog" aria-label="Reading time">
        <div id="rtw-break-screen">
          <h2 id="rtw-break-title">🌟 Time for a break!</h2>
          <div id="rtw-break-message">
            <p>Let's take a quick break together:</p>
            <ul><li>💧 Water</li><li>🤸 Stretch</li><li>🚽 Potty</li></ul>
            <p>Then we'll practice some reading!</p>
          </div>
          <div id="rtw-timer-container">
            <div id="rtw-timer-display">60</div>
            <div id="rtw-timer-progress-bg"><div id="rtw-timer-progress-fill"></div></div>
          </div>
        </div>

        <div id="rtw-reading-screen" style="display:none;">
          <h2 id="rtw-title">📚 Read each word</h2>
          <div id="rtw-instructions">Say each word clearly. I'll help if you get stuck!</div>
          <div id="rtw-sentence"></div>
          <div id="rtw-mic-indicator" style="display:none;">
            <div class="rtw-pulse"></div><span>Listening...</span>
          </div>
          <div id="rtw-meter" style="height:10px;background:rgba(255,255,255,0.1);border-radius:6px;overflow:hidden;margin:8px auto;max-width:420px;">
            <div id="rtw-meter-fill" style="height:100%;width:0%;background:#10b981;transition:width 100ms linear;"></div>
          </div>
          <button id="rtw-gesture-cta" class="rtw-solid" style="display:none;margin:8px auto;">Tap to enable mic</button>
          <div id="rtw-status"></div>
          <div id="rtw-controls">
            <button id="rtw-help-word" class="rtw-secondary" style="display:none;">🔊 Help with this word</button>
            <button id="rtw-skip-word" class="rtw-secondary" style="display:none;">⏭️ Skip this word</button>
          </div>
          <button id="rtw-skip" class="rtw-link">Parent skip →</button>
          <div id="rtw-code-wrap" style="display:none;">
            <input id="rtw-code" maxlength="8" inputmode="numeric" pattern="[0-9]*" placeholder="Enter code" />
            <button id="rtw-code-ok" class="rtw-solid">Unlock</button>
            <button id="rtw-code-cancel" class="rtw-ghost">Cancel</button>
          </div>
          <div id="rtw-stats"></div>
        </div>

        <div id="rtw-retell-screen" style="display:none;">
          <h2>🎤 Tell me about the video!</h2>
          <div id="rtw-retell-message">What happened in the video? Tell me the story!</div>
          <div id="rtw-retell-timer">Recording: <span id="rtw-retell-countdown">60</span>s</div>
          <div class="rtw-pulse" style="margin: 20px auto;"></div>
          <button id="rtw-retell-done" class="rtw-solid">I'm done talking</button>
        </div>

        <div id="rtw-limit-screen" style="display:none;">
          <h2>⏰ Screen time's up for today!</h2>
          <div id="rtw-limit-message">
            <p>You've watched for <strong id="rtw-limit-minutes">0</strong> minutes today.</p>
            <p>Great job reading! Come back tomorrow for more.</p>
          </div>
          <button id="rtw-limit-skip" class="rtw-link">Parent override →</button>
          <div id="rtw-limit-code-wrap" style="display:none;">
            <input id="rtw-limit-code" maxlength="8" inputmode="numeric" pattern="[0-9]*" placeholder="Enter code" />
            <button id="rtw-limit-code-ok" class="rtw-solid">Override</button>
          </div>
        </div>

        <div id="rtw-brand">Read To Watch v0.4.4 ✨</div>
      </div>
    `;
    document.documentElement.appendChild(overlay);

    // Parent skip
    overlay.querySelector('#rtw-skip').addEventListener('click', () => {
      overlay.querySelector('#rtw-code-wrap').style.display = 'flex';
      overlay.querySelector('#rtw-skip').style.display = 'none';
      overlay.querySelector('#rtw-code').focus();
    });
    overlay.querySelector('#rtw-code-cancel').addEventListener('click', () => {
      overlay.querySelector('#rtw-code-wrap').style.display = 'none';
      overlay.querySelector('#rtw-skip').style.display = 'block';
      overlay.querySelector('#rtw-code').value = '';
    });
    overlay.querySelector('#rtw-code-ok').addEventListener('click', () => {
      const val = (overlay.querySelector('#rtw-code').value || '').trim();
      if (val && val === (settings.parentCode || '0429')) hideOverlay(true);
      else { setStatus('❌ Wrong code.'); overlay.querySelector('#rtw-code').value = ''; }
    });

    // Limit override
    overlay.querySelector('#rtw-limit-skip').addEventListener('click', () => {
      overlay.querySelector('#rtw-limit-code-wrap').style.display = 'flex';
      overlay.querySelector('#rtw-limit-skip').style.display = 'none';
      overlay.querySelector('#rtw-limit-code').focus();
    });
    overlay.querySelector('#rtw-limit-code-ok').addEventListener('click', () => {
      const val = (overlay.querySelector('#rtw-limit-code').value || '').trim();
      if (val && val === (settings.parentCode || '0429')) hideOverlay(true);
      else {
        document.getElementById('rtw-limit-message').innerHTML = '<p>❌ Wrong code. Try again.</p>';
        overlay.querySelector('#rtw-limit-code').value = '';
      }
    });
  }

  function showScreen(id) {
    ['rtw-break-screen', 'rtw-reading-screen', 'rtw-retell-screen', 'rtw-limit-screen']
      .forEach(sid => {
        const el = document.getElementById(sid);
        if (el) el.style.display = sid === id ? 'block' : 'none';
      });
  }

  function setStatus(text) {
    const el = document.getElementById('rtw-status');
    if (el) el.textContent = text || '';
  }

  function updateProgressDisplay() {
    if (!settings.showProgress) return;
    const s = getTodayStats();
    const el = document.getElementById('rtw-stats'); if (!el) return;
    el.innerHTML = `
      <div class="rtw-stat-item"><span class="rtw-stat-number">${s.count}</span><span class="rtw-stat-label">today</span></div>
      <div class="rtw-stat-item"><span class="rtw-stat-number">${s.streak}</span><span class="rtw-stat-label">day streak 🔥</span></div>
    `;
  }

  function showOverlay() {
    ensureOverlay();
    initAudio();
    if (checkScreenTimeLimit()) { showLimitScreen(); return; }
    const ov = document.getElementById('rtw-overlay');
    ov.style.display = 'flex'; document.body.style.overflow = 'hidden';
    challengeActive = true; sessionStartTime = Date.now();
    showScreen('rtw-break-screen'); startBreakTimer();
  }

  function showLimitScreen() {
    ensureOverlay();
    const ov = document.getElementById('rtw-overlay');
    ov.style.display = 'flex'; document.body.style.overflow = 'hidden';
    challengeActive = true; showScreen('rtw-limit-screen');
    document.getElementById('rtw-limit-minutes').textContent = Math.round(getTodayScreenTime());
  }

  function hideOverlay(unlockOnly = false) {
    const ov = document.getElementById('rtw-overlay'); if (ov) ov.style.display = 'none';
    if (breakTimerInterval) { clearInterval(breakTimerInterval); breakTimerInterval = null; }
    stopRecognition(); stopVoiceMeter(); stopRetellRecording();
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    if (sessionStartTime) { recordScreenTime((Date.now() - sessionStartTime) / 60000); sessionStartTime = null; }
    document.body.style.overflow = ''; challengeActive = false;
    if (currentVideo && currentVideo.paused) { try { currentVideo.play(); } catch (e) {} }
  }

  // ========== 7) BREAK TIMER ==========

  function startBreakTimer() {
    try { playChime('soft'); } catch (_) {}
    try {
      speak("Let's take a break. Take a sip of water, stretch your body, use the potty if you need to, and when you get back, I will be here to practice a little reading with you.");
    } catch(_) {}

    let timeRemaining = settings.debugMode ? 5 : (settings.breakLength || 60);
    const display = document.getElementById('rtw-timer-display');
    const fill = document.getElementById('rtw-timer-progress-fill');
    const total = Math.max(1, timeRemaining);

    const tick = () => {
      if (display) display.textContent = timeRemaining;
      if (fill) fill.style.width = (((total - timeRemaining) / total) * 100) + '%';
      timeRemaining--;
      if (timeRemaining < 0) {
        clearInterval(breakTimerInterval); breakTimerInterval = null; onBreakComplete();
      }
    };
    tick();
    breakTimerInterval = setInterval(tick, 1000);
  }

  function onBreakComplete() {
    try { playChime('soft'); } catch (_) {}
    showScreen('rtw-reading-screen'); updateProgressDisplay();
    try { speak('Read the sentence below'); } catch (_) {}
    if (settings.autoStartAfterBreak) { setTimeout(() => { try { startWordByWordReading(); } catch(e){} }, 300); }
  }

  // ========== 8) VOICE PICKUP METER ==========

  async function startVoiceMeter() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      meterStream = stream;
      if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
      meterSource = audioContext.createMediaStreamSource(stream);
      meterAnalyser = audioContext.createAnalyser();
      meterAnalyser.fftSize = 2048;
      meterSource.connect(meterAnalyser);
      const data = new Uint8Array(meterAnalyser.fftSize);
      const fill = document.getElementById('rtw-meter-fill');

      const draw = () => {
        if (!meterAnalyser) return;
        meterAnalyser.getByteTimeDomainData(data);
        let sum = 0; for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / data.length);
        const pct = Math.max(0, Math.min(100, Math.round(rms * 200)));
        if (fill) fill.style.width = pct + '%';
        meterRAF = requestAnimationFrame(draw);
      };
      draw();
    } catch (e) { try { console.warn('[RTW] voice meter failed:', e); } catch(_) {} }
  }

  function stopVoiceMeter() {
    if (meterRAF) cancelAnimationFrame(meterRAF); meterRAF = null;
    try { meterSource && meterSource.disconnect(); } catch(_) {}
    meterSource = null; meterAnalyser = null;
    try { if (meterStream) meterStream.getTracks().forEach(t => t.stop()); } catch(_) {}
    meterStream = null;
    const fill = document.getElementById('rtw-meter-fill'); if (fill) fill.style.width = '0%';
  }

  // ========== 9) SPEECH RECOGNITION ==========

  function makeRecognizer() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    const r = new SR();
    r.lang = 'en-US';
    r.continuous = true;
    r.interimResults = true;
    return r;
  }

  function ensureGestureCTA(show) {
    const btn = document.getElementById('rtw-gesture-cta');
    if (btn) btn.style.display = show ? 'inline-block' : 'none';
    if (btn && show && !btn._rtw_wired) {
      btn._rtw_wired = true;
      btn.addEventListener('click', () => tryStartRecognizer(true));
    }
  }

  function stopRecognition() {
    recogShouldRun = false;
    if (recog && recogActive) { try { recog.stop(); } catch (_) {} }
    recogActive = false;
    // Clear any pending error timer
    if (speechEndTimer) { clearTimeout(speechEndTimer); speechEndTimer = null; }
    const mic = document.getElementById('rtw-mic-indicator'); if (mic) mic.style.display = 'none';
    ensureGestureCTA(false);
  }

  function scheduleRestart() {
    if (!recogShouldRun) return;
    if (recogRestartAttempts >= MAX_RESTARTS) { ensureGestureCTA(true); return; }
    const delay = Math.min(1000, 100 + 100 * recogRestartAttempts++);
    setTimeout(() => tryStartRecognizer(false), delay);
  }

  function wireRecognizerHandlers() {
    recog.onresult = (ev) => {
      let finalText = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        if (res.isFinal) finalText += res[0].transcript + ' ';
      }
      if (finalText.trim().length) {
        if (checkCurrentWord(finalText)) {
          // Clear any pending error timer since word was recognized
          if (speechEndTimer) { clearTimeout(speechEndTimer); speechEndTimer = null; }
          onWordCorrect();
        }
      }
    };
    recog.onspeechstart = () => {
      const mic = document.getElementById('rtw-mic-indicator'); if (mic) mic.style.display = 'flex';
      // Clear any pending error timer when new speech starts
      if (speechEndTimer) { clearTimeout(speechEndTimer); speechEndTimer = null; }
    };
    recog.onspeechend = () => {
      // Add delay to allow final results to be processed before marking as error
      // This prevents false errors when the final result arrives after speechend event
      if (recogShouldRun && currentWordIndex < wordsArray.length) {
        const targetIndex = currentWordIndex;
        speechEndTimer = setTimeout(() => {
          // Only trigger error if still on the same word (word wasn't recognized in the meantime)
          if (currentWordIndex === targetIndex && currentWordIndex < wordsArray.length) {
            onWordError();
          }
          speechEndTimer = null;
        }, 800); // 800ms delay to allow final results to arrive
      }
    };
    recog.onend = () => {
      recogActive = false;
      if (recogShouldRun && currentWordIndex < wordsArray.length) scheduleRestart();
    };
    recog.onerror = (e) => {
      try { console.warn('[RTW] speech error:', e.error); } catch(_) {}
      if (recogShouldRun) scheduleRestart();
    };
  }

  function tryStartRecognizer(fromGesture) {
    if (!recog) { recog = makeRecognizer(); if (!recog) { setStatus('⚠️ Speech recognition not supported. Use Chrome.'); return; } wireRecognizerHandlers(); }
    try {
      recog.start(); recogActive = true; recogRestartAttempts = 0; ensureGestureCTA(false);
      const mic = document.getElementById('rtw-mic-indicator'); if (mic) mic.style.display = 'flex';
    } catch (e) {
      // Chrome may require a user gesture; show CTA
      ensureGestureCTA(true);
    }
  }

  // ========== 10) READING FLOW ==========

  function checkCurrentWord(finalTurnText) {
    if (currentWordIndex >= wordsArray.length) return false;
    const target = wordsArray[currentWordIndex];
    const toks = tokenize(finalTurnText);
    const tail = toks.slice(-4);
    const THRESH = 0.68; // tolerant for kid speech
    for (let w of tail) { if (similarity(target, w) >= THRESH) return true; }
    return false;
  }

  async function startWordByWordReading() {
    await loadWords(); await loadProgress();
    currentSentence = chooseSentence(settings.level || 1);
    wordsArray = tokenize(currentSentence);
    wordAttempts = wordsArray.map(() => 0);
    wordsHelped = [];
    currentWordIndex = 0;

    const sentEl = document.getElementById('rtw-sentence'); sentEl.innerHTML = '';
    wordsArray.forEach((w, idx) => {
      const span = document.createElement('span');
      span.textContent = w;
      span.className = idx === 0 ? 'active' : 'pending';
      span.dataset.index = String(idx);
      sentEl.appendChild(span);
      sentEl.appendChild(document.createTextNode(' '));
    });

    setStatus('');
    const mic = document.getElementById('rtw-mic-indicator'); if (mic) mic.style.display = 'flex';
    startVoiceMeter();

    recogShouldRun = true; recogRestartAttempts = 0;
    tryStartRecognizer(false);

    const helpBtn = document.getElementById('rtw-help-word');
    const skipBtn = document.getElementById('rtw-skip-word');
    if (helpBtn) { helpBtn.style.display = 'inline-block'; helpBtn.onclick = () => provideWordHelp(); }
    if (skipBtn) { skipBtn.style.display = 'inline-block'; skipBtn.onclick  = () => skipCurrentWord(); }
  }

  async function onWordCorrect() {
    playWordSound();
    const spans = document.querySelectorAll('#rtw-sentence span');
    if (spans[currentWordIndex]) {
      spans[currentWordIndex].classList.remove('active', 'error');
      spans[currentWordIndex].classList.add('ok');
    }
    currentWordIndex++;
    if (currentWordIndex < wordsArray.length) {
      if (spans[currentWordIndex]) spans[currentWordIndex].classList.add('active');
    } else {
      await onAllWordsComplete();
    }
  }

  async function onWordError() {
    if (currentWordIndex >= wordsArray.length) return;
    wordAttempts[currentWordIndex]++;
    const spans = document.querySelectorAll('#rtw-sentence span');
    if (spans[currentWordIndex]) {
      spans[currentWordIndex].classList.add('error');
      setTimeout(() => { if (spans[currentWordIndex]) spans[currentWordIndex].classList.remove('error'); }, 450);
    }
    playChime('error'); await speak('Not quite, try again!'); setStatus('Not quite! Try again 💪');
    if (wordAttempts[currentWordIndex] >= (settings.maxAttempts || 2)) await provideWordHelp();
  }

  async function provideWordHelp() {
    const word = wordsArray[currentWordIndex];
    wordsHelped.push(word);
    if (!strugglingWords[word]) strugglingWords[word] = 0;
    strugglingWords[word]++;

    const spans = document.querySelectorAll('#rtw-sentence span');
    if (spans[currentWordIndex]) {
      spans[currentWordIndex].classList.remove('active', 'error');
      spans[currentWordIndex].classList.add('helped');
    }
    playChime('soft'); await speak("Okay, this is a tricky one. This word is: "+word); 
      setStatus("The word is: "+word);

    await sleep(1100); currentWordIndex++;
    if (currentWordIndex < wordsArray.length) {
      if (spans[currentWordIndex]) spans[currentWordIndex].classList.add('active');
    } else {
      await onAllWordsComplete();
    }
  }

  async function skipCurrentWord() { await provideWordHelp(); }

  async function onAllWordsComplete() {
    stopRecognition(); stopVoiceMeter();
    const wordsCorrect = wordsArray.length - wordsHelped.length;
    playChime('success'); showCelebration(); await speak('Great job! You did it!'); setStatus('🎉 Amazing! You read the whole sentence!');
    recordSession(currentSentence, wordsArray.length, wordsCorrect, wordsHelped.length, Date.now()); updateProgressDisplay();
    await sleep(1600); if (settings.askRetell) startRetellRecording(); else hideOverlay();
  }

  function showCelebration() {
    const overlay = document.getElementById('rtw-overlay'); if (!overlay) return;
    for (let i = 0; i < 40; i++) {
      const c = document.createElement('div');
      c.className = 'rtw-confetti';
      c.style.left = Math.random() * 100 + '%';
      c.style.animationDelay = Math.random() * 0.3 + 's';
      c.style.backgroundColor = ['#ff6b6b','#4ecdc4','#45b7d1','#f7dc6f','#bb8fce','#52c41a'][Math.floor(Math.random()*6)];
      overlay.appendChild(c);
      setTimeout(() => c.remove(), 2500);
    }
  }

  // ========== 11) RETELL (Optional) ==========

  let mediaRecorder = null, audioChunks = [], retellInterval = null;

  async function startRetellRecording() {
    showScreen('rtw-retell-screen'); await speak('Tell me about the video! What happened in the story?');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream); audioChunks = [];
      mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
      mediaRecorder.onstop = () => {
        const blob = new Blob(audioChunks, { type: 'audio/webm' });
        const ts = Date.now(); const name = "retell_"+ts+".webm";
        const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
        stream.getTracks().forEach(t => t.stop());
        if (sessionData.sessions && sessionData.sessions.length > 0) {
          sessionData.sessions[sessionData.sessions.length - 1].retellFile = name; saveProgress();
        }
      };
      mediaRecorder.start();
      let timeRemaining = settings.retellLength || 60;
      const cd = document.getElementById('rtw-retell-countdown');
      retellInterval = setInterval(() => {
        timeRemaining--; if (cd) cd.textContent = timeRemaining;
        if (timeRemaining <= 0) stopRetellRecording();
      }, 1000);
      const btn = document.getElementById('rtw-retell-done'); if (btn) btn.onclick = () => stopRetellRecording();
    } catch (e) {
      try { console.error('Microphone error:', e); } catch(_) {}
      setStatus('⚠️ Could not access microphone for recording.'); await sleep(1200); hideOverlay();
    }
  }

  function stopRetellRecording() {
    if (retellInterval) { clearInterval(retellInterval); retellInterval = null; }
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    hideOverlay();
  }

  // ========== 12) VIDEO HOOKS ==========

  function gateNow(reasonKey) {
    if (challengeActive) return;
    if (lastChallengedKey && lastChallengedKey === reasonKey) return;
    lastChallengedKey = reasonKey; showOverlay();
  }

  function disableYouTubeAutoplay() {
    try {
      const btn = document.querySelector('.ytp-autonav-toggle-button-container button, .ytp-autonav-toggle-button');
      if (btn && btn.getAttribute('aria-checked') === 'true') btn.click();
    } catch (e) {}
  }

  function installVideoHooks() {
    const attach = () => {
      const v = document.querySelector('video'); if (!v) return false;
      if (v.dataset.rtwHooked === '1') return true;
      v.dataset.rtwHooked = '1'; currentVideo = v;
      v.addEventListener('ended', () => {
        if (!settings.enabled) return;
        if (IS_YT && !settings.gateYouTube) return;
        if (IS_DP && !settings.gateDisneyPlus) return;
        gateNow('ended');
      }, { passive: true });
      v.addEventListener('timeupdate', () => {
        if (!settings.enabled) return;
        if (challengeActive) return;
        if (v.duration && v.currentTime && (v.duration - v.currentTime) < 6) {
          const key = location.pathname+"|"+Math.floor(v.duration);
          gateNow(key); try { v.pause(); } catch (e) {}
        }
      }, { passive: true });
      return true;
    };
    const once = attach();
    const mo = new MutationObserver(() => {
      const ok = attach();
      if (ok && settings.toggleAutoplay && IS_YT) disableYouTubeAutoplay();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  // ========== 13) ENTRY & MESSAGING ==========

  async function main() {
    ensureOverlay();
    await loadSettings(); await loadWords(); await loadProgress();
    if ((IS_YT && settings.gateYouTube) || (IS_DP && settings.gateDisneyPlus)) installVideoHooks();

    // Listen for debug-gate message from popup (optional)
    try {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg && msg.type === 'RTW_DEBUG_GATE') {
          try { showOverlay(); sendResponse({ ok: true }); } catch (e) { sendResponse({ ok: false, error: String(e) }); }
        }
      });
    } catch (e) {}

    // Live settings updates
    try {
      chrome.storage.onChanged.addListener((changes) => {
        for (const [k, v] of Object.entries(changes)) settings[k] = v.newValue;
      });
    } catch (e) {}
  }

  main();

})();  
