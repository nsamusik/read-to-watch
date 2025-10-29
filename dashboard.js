// Parent Dashboard JavaScript

const BANNED_WORDS = ['fuck', 'shit', 'damn', 'hell', 'bitch', 'ass', 'cock', 'dick', 'pussy', 'cunt', 'bastard', 'whore', 'slut', 'kill', 'murder', 'rape', 'sex', 'porn', 'xxx'];

let sessionData = null;
let progressData = null;
let strugglingWords = null;
let focusWords = null;

async function loadData() {
  return new Promise(resolve => {
    chrome.storage.local.get(['sessionData', 'progress', 'strugglingWords', 'focusWords'], (res) => {
      sessionData = res.sessionData || {sessions: [], screenTime: {}};
      progressData = res.progress || {};
      strugglingWords = res.strugglingWords || {};
      focusWords = res.focusWords || [];
      resolve();
    });
  });
}

async function saveData() {
  return new Promise(resolve => {
    chrome.storage.local.set({
      sessionData,
      strugglingWords,
      focusWords
    }, resolve);
  });
}

function calculateStreak() {
  const dates = Object.keys(progressData).sort().reverse();
  let streak = 0;
  
  for (let i = 0; i < dates.length; i++) {
    const expectedDate = new Date();
    expectedDate.setDate(expectedDate.getDate() - i);
    const expected = expectedDate.toISOString().split('T')[0];
    
    if (dates[i] === expected) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

function calculateMasteryPercent() {
  if (!sessionData.sessions || sessionData.sessions.length === 0) return 0;
  
  const total = sessionData.sessions.reduce((sum, s) => sum + parseFloat(s.firstAttemptMastery || 0), 0);
  return (total / sessionData.sessions.length).toFixed(1);
}

function renderOverview() {
  document.getElementById('totalSessions').textContent = sessionData.sessions?.length || 0;
  document.getElementById('currentStreak').textContent = calculateStreak();
  document.getElementById('masteryPercent').textContent = calculateMasteryPercent() + '%';
}

function renderScreenTimeChart() {
  const container = document.getElementById('screenTimeChart');
  container.innerHTML = '';
  
  const dates = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().split('T')[0]);
  }
  
  const maxMinutes = Math.max(
    ...dates.map(date => {
      const data = sessionData.screenTime?.[date];
      if (!data) return 0;
      return (data.youtube || 0) + (data.disneyplus || 0);
    }),
    60 // Minimum scale
  );
  
  dates.forEach(date => {
    const data = sessionData.screenTime?.[date] || {youtube: 0, disneyplus: 0};
    const youtube = data.youtube || 0;
    const disneyplus = data.disneyplus || 0;
    
    const group = document.createElement('div');
    group.className = 'chart-bar-group';
    
    const youtubeBar = document.createElement('div');
    youtubeBar.className = 'chart-bar youtube';
    youtubeBar.style.height = (youtube / maxMinutes * 100) + '%';
    youtubeBar.title = `YouTube: ${Math.round(youtube)}m`;
    
    const disneyBar = document.createElement('div');
    disneyBar.className = 'chart-bar disneyplus';
    disneyBar.style.height = (disneyplus / maxMinutes * 100) + '%';
    disneyBar.title = `Disney+: ${Math.round(disneyplus)}m`;
    
    const label = document.createElement('div');
    label.className = 'chart-label';
    const dateObj = new Date(date + 'T00:00:00');
    label.textContent = (dateObj.getMonth() + 1) + '/' + dateObj.getDate();
    
    if (disneyplus > 0) group.appendChild(disneyBar);
    if (youtube > 0) group.appendChild(youtubeBar);
    group.appendChild(label);
    
    container.appendChild(group);
  });
}

function renderStrugglingWords() {
  const container = document.getElementById('strugglingWords');
  container.innerHTML = '';
  
  const sorted = Object.entries(strugglingWords).sort((a, b) => b[1] - a[1]);
  
  if (sorted.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🎉</div>
        <div>No struggling words yet! Keep practicing.</div>
      </div>
    `;
    return;
  }
  
  sorted.slice(0, 20).forEach(([word, count]) => {
    const chip = document.createElement('div');
    chip.className = 'word-chip';
    chip.innerHTML = `
      ${word}
      <span class="word-chip-count">${count}</span>
    `;
    container.appendChild(chip);
  });
}

function renderFocusWords() {
  const container = document.getElementById('focusWordList');
  container.innerHTML = '';
  
  if (focusWords.length === 0) {
    container.innerHTML = '<div style="color: #6b7280; font-size: 14px;">No focus words yet. Add words you want to practice!</div>';
    return;
  }
  
  focusWords.forEach(word => {
    const chip = document.createElement('div');
    chip.className = 'focus-word';
    chip.innerHTML = `
      ${word}
      <span class="remove-word">×</span>
    `;
    chip.onclick = () => removeFocusWord(word);
    container.appendChild(chip);
  });
}

function renderSessions() {
  const container = document.getElementById('sessionList');
  container.innerHTML = '';
  
  if (!sessionData.sessions || sessionData.sessions.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📚</div>
        <div>No sessions yet. Start watching videos to see progress!</div>
      </div>
    `;
    return;
  }
  
  const recent = sessionData.sessions.slice(-50).reverse();
  
  recent.forEach(session => {
    const item = document.createElement('div');
    item.className = 'session-item';
    
    const date = new Date(session.timestamp);
    const timeStr = date.toLocaleString();
    const mastery = parseFloat(session.firstAttemptMastery);
    const masteryClass = mastery >= 80 ? '' : 'low';
    
    item.innerHTML = `
      <div class="session-header">
        <div class="session-sentence">"${session.sentence}"</div>
        <div class="session-time">${timeStr}</div>
      </div>
      <div class="session-stats">
        <span>📍 ${session.site}</span>
        <span>📊 ${session.wordsCorrect}/${session.wordsTotal} correct</span>
        ${session.wordsHelped > 0 ? `<span>💡 ${session.wordsHelped} helped</span>` : ''}
        <span class="session-mastery ${masteryClass}">🎯 ${mastery}% mastery</span>
        ${session.retellFile ? '<span>🎤 Retell recorded</span>' : ''}
      </div>
    `;
    
    container.appendChild(item);
  });
}

function addFocusWord() {
  const input = document.getElementById('focusWordInput');
  const word = input.value.trim().toLowerCase().replace(/[^a-z]/g, '');
  
  if (!word) {
    alert('Please enter a valid word (letters only)');
    return;
  }
  
  if (BANNED_WORDS.some(banned => word.includes(banned))) {
    alert('⚠️ This word is not appropriate for practice.');
    return;
  }
  
  if (focusWords.includes(word)) {
    alert('This word is already in your focus list.');
    return;
  }
  
  focusWords.push(word);
  saveData();
  renderFocusWords();
  input.value = '';
}

function removeFocusWord(word) {
  focusWords = focusWords.filter(w => w !== word);
  saveData();
  renderFocusWords();
}

function exportData() {
  if (!sessionData.sessions || sessionData.sessions.length === 0) {
    alert('No data to export yet!');
    return;
  }
  
  // CSV format
  let csv = 'Timestamp,Sentence,Words Total,Words Correct,Words Helped,First-Attempt Mastery %,Site,Retell File\n';
  
  sessionData.sessions.forEach(s => {
    const date = new Date(s.timestamp).toISOString();
    const sentence = `"${s.sentence.replace(/"/g, '""')}"`;
    csv += `${date},${sentence},${s.wordsTotal},${s.wordsCorrect},${s.wordsHelped},${s.firstAttemptMastery},${s.site},${s.retellFile || ''}\n`;
  });
  
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `read-to-watch-data-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function resetAllData() {
  if (!confirm('⚠️ Are you SURE you want to reset ALL data? This includes:\n\n• All reading sessions\n• Progress and streaks\n• Screen time tracking\n• Struggling words\n• Focus words\n\nThis CANNOT be undone!')) {
    return;
  }
  
  if (!confirm('Really sure? This is permanent!')) {
    return;
  }
  
  chrome.storage.local.set({
    sessionData: {sessions: [], screenTime: {}},
    progress: {},
    strugglingWords: {},
    focusWords: [],
    masteredWords: []
  }, () => {
    alert('✅ All data has been reset.');
    location.reload();
  });
}

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  await loadData();
  renderOverview();
  renderScreenTimeChart();
  renderStrugglingWords();
  renderFocusWords();
  renderSessions();
  
  // Enter key for focus word input
  document.getElementById('focusWordInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      addFocusWord();
    }
  });
});