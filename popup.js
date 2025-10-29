// Popup UI logic (v0.4.2)
const defaults = {
  enabled: true,
  level: 1,
  gateYouTube: true,
  gateDisneyPlus: true,
  parentCode: "0429",
  toggleAutoplay: true,
  requireFullPass: false,
  soundEffects: true,
  showProgress: true,
  breakLength: 60,
  maxAttempts: 2,
  autoStartAfterBreak: true,
  askRetell: false,
  retellLength: 60,
  voicePrompts: true,
  dailyScreenLimit: 0,
  debugMode: false
};

const $ = (sel) => document.querySelector(sel);

async function loadLevels() {
  const url = chrome.runtime.getURL("words.json");
  const res = await fetch(url);
  const data = await res.json();
  const sel = $("#level");
  sel.innerHTML = "";
  (data.levels || []).forEach(l => {
    const opt = document.createElement("option");
    opt.value = l.id;
    opt.textContent = `Level ${l.id} — ${l.name}`;
    sel.appendChild(opt);
  });
}

async function loadProgress() {
  return new Promise(resolve => {
    chrome.storage.local.get(['progress'], (res) => {
      resolve(res.progress || {});
    });
  });
}

function calculateStreak(progressData) {
  const dates = Object.keys(progressData).sort().reverse();
  let streak = 0;
  for (let i = 0; i < dates.length; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const expected = d.toISOString().split('T')[0];
    if (dates[i] === expected) streak++; else break;
  }
  return streak;
}

function getTodayStats(progressData) {
  const today = new Date().toISOString().split('T')[0];
  const todayData = progressData[today] || {count: 0};
  return { count: todayData.count || 0, streak: calculateStreak(progressData) };
}

async function updateStatsDisplay() {
  const progressData = await loadProgress();
  const stats = getTodayStats(progressData);
  $("#todayCount").textContent = stats.count;
  $("#streakCount").textContent = stats.streak;
}

async function loadSettings() {
  const s = (await chrome.storage.sync.get(Object.keys(defaults))) || {};
  $("#enabled").checked = s.enabled ?? defaults.enabled;
  $("#level").value = s.level ?? defaults.level;
  $("#yt").checked = s.gateYouTube ?? defaults.gateYouTube;
  $("#dplus").checked = s.gateDisneyPlus ?? defaults.gateDisneyPlus;
  $("#code").value = s.parentCode ?? defaults.parentCode;
  $("#toggleAutoplay").checked = s.toggleAutoplay ?? defaults.toggleAutoplay;
  $("#requireFullPass").checked = s.requireFullPass ?? defaults.requireFullPass;
  $("#soundEffects").checked = s.soundEffects ?? defaults.soundEffects;
  $("#showProgress").checked = s.showProgress ?? defaults.showProgress;
  $("#breakLength").value = s.breakLength ?? defaults.breakLength;
  $("#maxAttempts").value = s.maxAttempts ?? defaults.maxAttempts;
  $("#autoStartAfterBreak").checked = s.autoStartAfterBreak ?? defaults.autoStartAfterBreak;
  $("#askRetell").checked = s.askRetell ?? defaults.askRetell;
  $("#retellLength").value = s.retellLength ?? defaults.retellLength;
  $("#voicePrompts").checked = s.voicePrompts ?? defaults.voicePrompts;
  $("#dailyScreenLimit").value = s.dailyScreenLimit ?? defaults.dailyScreenLimit;
  if ($("#debugMode")) $("#debugMode").checked = s.debugMode ?? defaults.debugMode;
}

async function saveSettings() {
  const codeValue = $("#code").value.replace(/\s+/g, "");
  if (codeValue.length < 4) {
    alert("⚠️ Skip code must be at least 4 digits");
    return;
  }

  const breakLength = parseInt($("#breakLength").value);
  if (breakLength < 15 || breakLength > 300) {
    alert("⚠️ Break length must be between 15-300 seconds");
    return;
  }

  const maxAttempts = parseInt($("#maxAttempts").value);
  if (maxAttempts < 1 || maxAttempts > 5) {
    alert("⚠️ Max attempts must be between 1-5");
    return;
  }

  const payload = {
    enabled: $("#enabled").checked,
    level: Number($("#level").value),
    gateYouTube: $("#yt").checked,
    gateDisneyPlus: $("#dplus").checked,
    parentCode: codeValue,
    toggleAutoplay: $("#toggleAutoplay").checked,
    requireFullPass: $("#requireFullPass").checked,
    soundEffects: $("#soundEffects").checked,
    showProgress: $("#showProgress").checked,
    breakLength,
    maxAttempts,
    autoStartAfterBreak: $("#autoStartAfterBreak").checked,
    askRetell: $("#askRetell").checked,
    retellLength: parseInt($("#retellLength").value),
    voicePrompts: $("#voicePrompts").checked,
    dailyScreenLimit: parseInt($("#dailyScreenLimit").value),
    debugMode: $("#debugMode") ? $("#debugMode").checked : false
  };

  await chrome.storage.sync.set(payload);

  const saveBtn = $("#save");
  const originalText = saveBtn.textContent;
  saveBtn.textContent = "✅ Saved!";
  saveBtn.style.background = "linear-gradient(135deg, #10b981 0%, #059669 100%)";
  setTimeout(() => {
    saveBtn.textContent = originalText;
    saveBtn.style.background = "";
  }, 1500);
}

async function resetProgress() {
  if (!confirm("⚠️ Are you sure you want to reset all progress? This cannot be undone.")) return;
  await chrome.storage.local.set({progress: {}});
  await updateStatsDisplay();
  alert("✅ Progress has been reset!");
}

function openDashboard() {
  chrome.tabs.create({url: chrome.runtime.getURL("dashboard.html")});
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadLevels();
  await loadSettings();
  await updateStatsDisplay();

  $("#save").addEventListener("click", saveSettings);
  $("#reset").addEventListener("click", resetProgress);
  $("#dashboard").addEventListener("click", openDashboard);

  if ($("#launchGate")) {
    $("#launchGate").addEventListener("click", async () => {
      const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
      if (!tab || !tab.id) { alert("No active tab to send message to."); return; }
      try {
        await chrome.tabs.sendMessage(tab.id, {type: "RTW_DEBUG_GATE"});
      } catch (e) {
        alert("Could not reach content script on this tab (it must be a YouTube/Disney+ page).");
      }
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.tagName !== "BUTTON") saveSettings();
  });
});
