import './style.css';
import { initializeApp } from 'firebase/app';
import {
  getDatabase,
  ref as fbRef,
  set as fbSet,
  update as fbUpdate,
  onValue as fbOnValue,
  onDisconnect as fbOnDisconnect
} from 'firebase/database';

// -------------------------------------------------------------
// 1. Firebase Web Configuration
// -------------------------------------------------------------
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || '',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || '',
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL || '',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || '',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || '',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || ''
};

// Required for Firebase Realtime Database
const hasFirebase = Boolean(
  firebaseConfig.apiKey &&
  firebaseConfig.databaseURL &&
  firebaseConfig.projectId
);

let db = null;
let firebaseInitError = null;
let isConnected = false;

if (hasFirebase) {
  try {
    const app = initializeApp(firebaseConfig);
    db = getDatabase(app);
  } catch (err) {
    console.error('Firebase initialization error:', err);
    firebaseInitError = err.message;
  }
}

if (!db) {
  db = { isMock: true };
}

// -------------------------------------------------------------
// 2. Development Fallback (Cross-tab sync via BroadcastChannel & localStorage)
// -------------------------------------------------------------
const mockChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('quiz_arena_local_bus') : null;
let mockData = {};
try {
  const saved = localStorage.getItem('quiz_arena_mock_data');
  if (saved) mockData = JSON.parse(saved);
} catch (e) {}

const mockListeners = new Set();

function saveMockData(path) {
  try {
    localStorage.setItem('quiz_arena_mock_data', JSON.stringify(mockData));
  } catch (e) {}
  if (mockChannel) {
    mockChannel.postMessage({ type: 'sync', data: mockData, path });
  }
  notifyMockListeners(path);
}

if (mockChannel) {
  mockChannel.onmessage = (event) => {
    if (event.data?.type === 'sync' && event.data.data) {
      mockData = event.data.data;
      notifyMockListeners(event.data.path || '');
    }
  };
}

window.addEventListener('storage', (e) => {
  if (e.key === 'quiz_arena_mock_data' && e.newValue) {
    try {
      mockData = JSON.parse(e.newValue);
      notifyMockListeners('');
    } catch (err) {}
  }
});

function notifyMockListeners(changedPath) {
  for (const listener of Array.from(mockListeners)) {
    if (!listener.path || !changedPath || changedPath.startsWith(listener.path) || listener.path.startsWith(changedPath)) {
      listener.cb(createMockSnapshot(listener.path));
    }
  }
}

function getMockValue(path) {
  if (!path) return mockData;
  const parts = path.split('/').filter(Boolean);
  let cur = mockData;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function setMockValue(path, val) {
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) {
    mockData = val || {};
    return;
  }
  let cur = mockData;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p];
  }
  const last = parts[parts.length - 1];
  if (val === null || val === undefined) {
    delete cur[last];
  } else {
    cur[last] = val;
  }
}

function createMockSnapshot(path) {
  const raw = getMockValue(path);
  return {
    exists: () => raw !== undefined && raw !== null,
    val: () => (raw === undefined || raw === null ? null : JSON.parse(JSON.stringify(raw)))
  };
}

// Universal database abstraction wrappers
function ref(database, path = '') {
  const cleanPath = String(path).replace(/^\/+|\/+$/g, '');
  if (database && database.isMock) {
    return { isMock: true, path: cleanPath };
  }
  return fbRef(database, cleanPath);
}

async function set(refObj, value) {
  if (refObj && refObj.isMock) {
    setMockValue(refObj.path, value);
    saveMockData(refObj.path);
    return;
  }
  return fbSet(refObj, value);
}

async function update(refObj, updates) {
  if (refObj && refObj.isMock) {
    for (const [key, val] of Object.entries(updates)) {
      const fullPath = refObj.path ? `${refObj.path}/${key}` : key;
      setMockValue(fullPath, val);
    }
    saveMockData(refObj.path);
    return;
  }
  return fbUpdate(refObj, updates);
}

function onValue(refObj, callback, options) {
  if (refObj && refObj.isMock) {
    const path = refObj.path;
    callback(createMockSnapshot(path));
    if (options?.onlyOnce) {
      return () => {};
    }
    const listener = { path, cb: callback };
    mockListeners.add(listener);
    return () => mockListeners.delete(listener);
  }
  return fbOnValue(refObj, callback, options);
}

function onDisconnect(refObj) {
  if (refObj && refObj.isMock) {
    const cleanup = () => {
      setMockValue(refObj.path, false);
      saveMockData(refObj.path);
    };
    window.addEventListener('beforeunload', cleanup, { once: true });
    return {
      set: async (val) => {
        setMockValue(refObj.path, val);
      },
      remove: async () => {
        setMockValue(refObj.path, null);
      },
      cancel: () => window.removeEventListener('beforeunload', cleanup)
    };
  }
  return fbOnDisconnect(refObj);
}

// Listen to Firebase connection state
if (hasFirebase && db && !db.isMock) {
  try {
    fbOnValue(fbRef(db, '.info/connected'), (snap) => {
      isConnected = snap.val() === true;
      updateStatusBadge();
    });
  } catch (e) {
    console.warn('Could not listen to .info/connected:', e);
  }
}

// -------------------------------------------------------------
// 3. Quiz Data (10 Varied, Curated Questions)
// -------------------------------------------------------------
const questions = [
  ['Which planet in our solar system is known as the Red Planet?', ['Venus', 'Mars', 'Jupiter', 'Mercury'], 1],
  ['What is 15 × 12?', ['160', '170', '180', '190'], 2],
  ['Which programming language runs natively in modern web browsers?', ['Python', 'Ruby', 'JavaScript', 'C#'], 2],
  ['What is the largest ocean on Earth by surface area?', ['Atlantic Ocean', 'Indian Ocean', 'Arctic Ocean', 'Pacific Ocean'], 3],
  ['What gas do green plants primarily absorb during photosynthesis?', ['Oxygen', 'Carbon Dioxide', 'Nitrogen', 'Helium'], 1],
  ['How many sides does a regular hexagon have?', ['5', '6', '7', '8'], 1],
  ['Who painted the famous masterpiece Mona Lisa?', ['Michelangelo', 'Leonardo da Vinci', 'Pablo Picasso', 'Vincent van Gogh'], 1],
  ['What is the chemical formula for water?', ['CO2', 'NaCl', 'H2O', 'O2'], 2],
  ['What is the largest continent on Earth by land area?', ['Africa', 'Asia', 'North America', 'Europe'], 1],
  ['What is the capital city of Japan?', ['Kyoto', 'Osaka', 'Tokyo', 'Sapporo'], 2]
];

// -------------------------------------------------------------
// 4. Session & State Management
// -------------------------------------------------------------
const app = document.querySelector('#root');
const SESSION_KEY = 'quiz_battle_arena_session';

function getStoredSession() {
  try {
    const s = sessionStorage.getItem(SESSION_KEY);
    return s ? JSON.parse(s) : null;
  } catch (e) {
    return null;
  }
}

function saveStoredSession(data) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(data));
  } catch (e) {}
}

function clearStoredSession() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch (e) {}
}

const session = getStoredSession();
let room = session?.room || '';
let playerId = session?.playerId || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : 'p_' + Math.random().toString(36).slice(2, 10));
let playerName = session?.name || '';
let unsubscribe = null;

// Submission lock to prevent duplicate answers & race conditions
let isAnswering = false;
let selectedChoice = null;
let lastAnsweredQuestion = -1;

// XSS Sanitizer
const esc = (s) => String(s || '').replace(/[&<>"']/g, (m) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}[m]));

function updateStatusBadge() {
  const badge = document.querySelector('#connection-status');
  if (!badge) return;

  if (hasFirebase) {
    if (isConnected) {
      badge.className = 'status-pill online';
      badge.innerHTML = '<span class="status-dot"></span> Firebase RTDB Live';
    } else {
      badge.className = 'status-pill offline';
      badge.innerHTML = '<span class="status-dot"></span> Connecting...';
    }
  } else {
    badge.className = 'status-pill local';
    badge.innerHTML = '<span class="status-dot"></span> Local Mode (Dev)';
  }
}

function shell() {
  app.innerHTML = `
    <main class="wrap">
      <header>
        <div class="header-left">
          <div class="header-title-row">
            <h1>Quiz Battle Arena</h1>
            <div id="connection-status" class="status-pill ${hasFirebase ? (isConnected ? 'online' : 'offline') : 'local'}">
              <span class="status-dot"></span> ${hasFirebase ? (isConnected ? 'Firebase RTDB Live' : 'Connecting...') : 'Local Mode (Dev)'}
            </div>
          </div>
          <div class="header-desc">2–4 players · 10 questions · Live multiplayer quiz showdown</div>
        </div>
      </header>
      <section id="screen"></section>
      <footer>
        Quiz Battle Arena • Production-ready real-time multiplayer • Separate devices supported via Firebase
      </footer>
    </main>
  `;
}

// -------------------------------------------------------------
// 5. Landing / Home Screen
// -------------------------------------------------------------
function renderHome(errorMessage = '') {
  shell();

  const urlParams = new URLSearchParams(window.location.search);
  const roomFromUrl = urlParams.get('room') || '';

  const screen = document.querySelector('#screen');
  screen.innerHTML = `
    <div class="card hero">
      <h2>Join the Arena</h2>
      <p class="muted">Play live trivia battles with friends across different devices or tabs.</p>

      ${errorMessage ? `<div class="notice-box error">${esc(errorMessage)}</div>` : ''}

      ${!hasFirebase ? `
        <div class="notice-box warning">
          <strong>⚡ Local Development Mode:</strong> Firebase environment variables are not set in <code>.env.local</code>.
          Local fallback sync is active across browser tabs. To connect separate mobile devices and desktops, set your <code>VITE_FIREBASE_*</code> credentials.
        </div>
      ` : ''}

      <label for="player-name">Your Player Name</label>
      <input id="player-name" maxlength="16" placeholder="e.g., Alex, QuizMaster" value="${esc(playerName)}" autocomplete="off" />

      <div class="twocol">
        <div class="create-group">
          <label>Create New Game</label>
          <button id="btn-create" class="primary" type="button">⚡ Create Room</button>
        </div>
        <div class="join-group">
          <label for="room-code">Join with Code</label>
          <div style="display:flex; gap:8px;">
            <input id="room-code" maxlength="4" placeholder="ABCD" value="${esc(roomFromUrl.toUpperCase())}" style="text-transform:uppercase; letter-spacing:2px; font-weight:700;" autocomplete="off" />
            <button id="btn-join" class="secondary" style="width: auto; padding: 0 20px;" type="button">Join</button>
          </div>
        </div>
      </div>

      <div class="notice-box" style="margin-top:24px;">
        <strong style="display:block; margin-bottom:6px; color:var(--text);">🎮 Battle Rules:</strong>
        <ul style="padding-left:18px; margin:0; line-height:1.6;">
          <li>Supports 2 to 4 players per room.</li>
          <li>Every player receives the same 10 multiple-choice questions.</li>
          <li>Each correct answer earns 1 point.</li>
          <li>Scores update live on the real-time leaderboard.</li>
          <li>The player with the highest score after 10 questions wins!</li>
        </ul>
      </div>
    </div>
  `;

  document.querySelector('#btn-create').onclick = handleCreateRoom;
  document.querySelector('#btn-join').onclick = handleJoinRoom;

  // Enter key shortcuts
  document.querySelector('#room-code').onkeydown = (e) => {
    if (e.key === 'Enter') handleJoinRoom();
  };
  document.querySelector('#player-name').onkeydown = (e) => {
    if (e.key === 'Enter') {
      const code = document.querySelector('#room-code').value.trim();
      if (code) handleJoinRoom();
      else handleCreateRoom();
    }
  };
}

function getValidatedName() {
  const nameInput = document.querySelector('#player-name');
  const n = nameInput ? nameInput.value.trim() : playerName;
  if (!n) {
    renderHome('Please enter your player name before continuing.');
    return null;
  }
  playerName = n;
  return n;
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// -------------------------------------------------------------
// 6. Room Creation & Joining
// -------------------------------------------------------------
async function handleCreateRoom() {
  const name = getValidatedName();
  if (!name) return;

  room = generateRoomCode();
  saveStoredSession({ room, playerId, name });

  try {
    const roomRef = ref(db, `rooms/${room}`);
    await set(roomRef, {
      id: room,
      status: 'lobby',
      createdAt: Date.now(),
      hostId: playerId,
      players: {
        [playerId]: {
          id: playerId,
          name,
          score: 0,
          question: 0,
          online: true,
          joinedAt: Date.now()
        }
      }
    });

    // Graceful disconnect handler (mark offline, do not erase progress)
    try {
      await onDisconnect(ref(db, `rooms/${room}/players/${playerId}/online`)).set(false);
    } catch (e) {
      console.warn('onDisconnect registration warning:', e);
    }

    startListening();
  } catch (err) {
    console.error('Error creating room:', err);
    renderHome(`Failed to create room: ${err.message || 'Firebase error'}`);
  }
}

async function handleJoinRoom() {
  const name = getValidatedName();
  if (!name) return;

  const codeInput = document.querySelector('#room-code');
  const targetCode = (codeInput ? codeInput.value : room).trim().toUpperCase();

  if (!/^[A-Z0-9]{4}$/.test(targetCode)) {
    renderHome('Room code must be exactly 4 letters or digits.');
    return;
  }

  room = targetCode;

  try {
    const roomRef = ref(db, `rooms/${room}`);
    onValue(roomRef, async (snap) => {
      const roomData = snap.val();
      if (!roomData) {
        renderHome(`Room "${room}" was not found. Please double-check the code.`);
        return;
      }

      const players = roomData.players || {};
      const playerIds = Object.keys(players);
      const isExistingPlayer = Boolean(players[playerId]);

      if (playerIds.length >= 4 && !isExistingPlayer) {
        renderHome(`Room "${room}" is full (maximum 4 players allowed).`);
        return;
      }

      if (roomData.status === 'playing' && !isExistingPlayer) {
        renderHome(`The quiz in room "${room}" has already started.`);
        return;
      }

      saveStoredSession({ room, playerId, name });

      // Join or reconnect
      const existing = players[playerId] || {};
      await update(ref(db, `rooms/${room}/players/${playerId}`), {
        id: playerId,
        name,
        score: existing.score || 0,
        question: existing.question || 0,
        online: true,
        joinedAt: existing.joinedAt || Date.now()
      });

      try {
        await onDisconnect(ref(db, `rooms/${room}/players/${playerId}/online`)).set(false);
      } catch (e) {
        console.warn('onDisconnect registration warning:', e);
      }

      startListening();
    }, { onlyOnce: true });
  } catch (err) {
    console.error('Error joining room:', err);
    renderHome(`Failed to join room: ${err.message || 'Connection error'}`);
  }
}

// -------------------------------------------------------------
// 7. Realtime Room Listener
// -------------------------------------------------------------
function startListening() {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }

  const roomRef = ref(db, `rooms/${room}`);
  unsubscribe = onValue(roomRef, (snapshot) => {
    const data = snapshot.val();
    if (!data) {
      clearStoredSession();
      renderHome('The room was closed or does not exist.');
      return;
    }
    renderRoom(data);
  });
}

// -------------------------------------------------------------
// 8. Room Router & Waiting Room (Lobby)
// -------------------------------------------------------------
function renderRoom(data) {
  const players = Object.values(data.players || {});
  const me = (data.players || {})[playerId];

  if (!me) {
    clearStoredSession();
    renderHome('You have been disconnected from the room.');
    return;
  }

  // Route based on room status and player progress
  if (data.status === 'playing') {
    renderGame(data, me);
    return;
  }

  // Finished state
  if (data.status === 'finished') {
    renderResults(data, me);
    return;
  }

  // Lobby / Waiting Room
  renderLobby(data, me, players);
}

function renderLobby(data, me, players) {
  const isHost = data.hostId === playerId;
  const canStart = players.length >= 2;
  const hostPlayer = players.find(p => p.id === data.hostId) || { name: 'Host' };

  const shareUrl = `${window.location.origin}${window.location.pathname}?room=${room}`;

  const screen = document.querySelector('#screen');
  screen.innerHTML = `
    <div class="card hero">
      <div class="room-header">
        <div class="room-code-display">
          <span>ROOM CODE</span>
          <strong>${room}</strong>
        </div>
        <div class="room-actions">
          <button id="btn-copy-code" class="secondary" type="button">📋 Copy Code</button>
          <button id="btn-copy-link" class="secondary" type="button">🔗 Share Link</button>
        </div>
      </div>

      <h2>Waiting for Players</h2>
      <p class="muted">
        ${players.length}/4 players connected.
        ${canStart ? 'Ready to begin! The host can start the quiz.' : 'Need at least 2 players to start a quiz battle.'}
      </p>

      <div class="player-list-header">
        <h3>Connected Contestants</h3>
        <span class="player-count-badge">${players.length} / 4 Players</span>
      </div>

      <div class="players">
        ${players.map(p => `
          <div class="player-row">
            <div class="player-avatar">${esc(p.name[0] || '?').toUpperCase()}</div>
            <div class="player-info">
              <div class="player-name-line">
                <span>${esc(p.name)}</span>
                ${p.id === data.hostId ? '<span class="host-tag">Host</span>' : ''}
                ${p.id === playerId ? '<span class="you-tag">You</span>' : ''}
              </div>
              <div class="player-status-line">
                ${p.online ? '🟢 Connected' : '⚪ Offline / Refreshing'}
              </div>
            </div>
            <div class="player-score">${p.score || 0} pts</div>
          </div>
        `).join('')}
      </div>

      ${isHost ? `
        <button id="btn-start" class="primary" style="margin-top:12px;" ${!canStart ? 'disabled' : ''} type="button">
          ${canStart ? '🚀 Start Quiz Battle' : 'Waiting for at least 2 players...'}
        </button>
      ` : `
        <div class="notice-box">
          ⏳ Waiting for host <strong>${esc(hostPlayer.name)}</strong> to start the game...
        </div>
      `}

      <button id="btn-leave" class="danger" style="margin-top:16px;" type="button">Leave Room</button>
    </div>
  `;

  document.querySelector('#btn-copy-code').onclick = () => {
    navigator.clipboard?.writeText(room);
    const btn = document.querySelector('#btn-copy-code');
    btn.textContent = '✓ Copied!';
    setTimeout(() => { btn.textContent = '📋 Copy Code'; }, 1800);
  };

  document.querySelector('#btn-copy-link').onclick = () => {
    navigator.clipboard?.writeText(shareUrl);
    const btn = document.querySelector('#btn-copy-link');
    btn.textContent = '✓ Link Copied!';
    setTimeout(() => { btn.textContent = '🔗 Share Link'; }, 1800);
  };

  const startBtn = document.querySelector('#btn-start');
  if (startBtn && isHost) {
    startBtn.onclick = async () => {
      if (players.length < 2) return;
      const updates = {
        status: 'playing',
        startedAt: Date.now()
      };
      // Reset all players scores and question index to 0
      for (const p of players) {
        updates[`players/${p.id}/score`] = 0;
        updates[`players/${p.id}/question`] = 0;
      }
      await update(ref(db, `rooms/${room}`), updates);
    };
  }

  document.querySelector('#btn-leave').onclick = handleLeaveRoom;
}

async function handleLeaveRoom() {
  if (room && playerId) {
    try {
      await update(ref(db, `rooms/${room}/players/${playerId}`), {
        online: false
      });
    } catch (e) {}
  }
  clearStoredSession();
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  room = '';
  renderHome();
}

// -------------------------------------------------------------
// 9. In-Game Quiz Screen
// -------------------------------------------------------------
function renderGame(data, me) {
  const players = Object.values(data.players || {});
  const allFinished = players.length > 0 && players.every(p => (p.question || 0) >= 10);

  // If everyone has finished, transition to final results
  if (allFinished) {
    renderResults(data, me);
    return;
  }

  const qIndex = Math.min(me.question || 0, 10);

  // If local player finished all 10 questions but waiting for others
  if (qIndex >= 10) {
    renderWaitingForOthers(data, me, players);
    return;
  }

  const q = questions[qIndex];
  const progressPercent = Math.round((qIndex / 10) * 100);
  const ranking = [...players].sort((a, b) => (b.score || 0) - (a.score || 0));

  const screen = document.querySelector('#screen');
  screen.innerHTML = `
    <div class="game-grid">
      <!-- Main Quiz Card -->
      <div class="card quiz-card">
        <div class="quiz-top">
          <span class="q-badge">Question ${qIndex + 1} of 10</span>
          <span>Score: <strong>${me.score || 0} pts</strong></span>
        </div>

        <div class="progress-track">
          <div class="progress-bar" style="width: ${progressPercent}%;"></div>
        </div>

        <h2 class="question-text">${esc(q[0])}</h2>

        <div class="answers-grid" id="answers-container">
          ${q[1].map((answerText, idx) => {
            const letter = String.fromCharCode(65 + idx);
            let extraClass = '';
            if (isAnswering && selectedChoice !== null) {
              if (idx === selectedChoice) {
                extraClass = idx === q[2] ? 'selected-correct' : 'selected-wrong';
              } else if (idx === q[2]) {
                extraClass = 'revealed-correct';
              }
            }
            return `
              <button class="answer-btn ${extraClass}" data-index="${idx}" ${isAnswering ? 'disabled' : ''} type="button">
                <span class="answer-letter">${letter}</span>
                <span>${esc(answerText)}</span>
              </button>
            `;
          }).join('')}
        </div>

        <div id="feedback-area"></div>
      </div>

      <!-- Live Leaderboard Sidebar -->
      <div class="card leaderboard-card">
        <h3>
          <span>Live Leaderboard</span>
          <span class="player-count-badge">${players.length} Players</span>
        </h3>

        <div class="rank-list">
          ${ranking.map((p, i) => `
            <div class="rank-item ${p.id === playerId ? 'is-me' : ''}">
              <span class="rank-num">${i + 1}</span>
              <div class="rank-details">
                <span class="rank-name">
                  ${esc(p.name)}
                  ${p.id === playerId ? '<span class="you-tag">You</span>' : ''}
                </span>
                <span class="rank-prog">${(p.question || 0) >= 10 ? '✓ Finished' : `Q ${(p.question || 0) + 1}/10`}</span>
              </div>
              <span class="rank-pts">${p.score || 0} pts</span>
            </div>
          `).join('')}
        </div>

        <div class="notice-box" style="margin-top:16px; font-size:12px; padding:10px 12px;">
          Room Code: <strong>${room}</strong>
        </div>
      </div>
    </div>
  `;

  // Attach click handlers to answer buttons
  document.querySelectorAll('.answer-btn').forEach((btn) => {
    btn.onclick = () => {
      const choice = Number(btn.dataset.index);
      handleAnswerSelection(choice, q[2], qIndex, me, data);
    };
  });
}

async function handleAnswerSelection(choice, correctIndex, qIndex, me, data) {
  // Prevent double submissions or answering twice for the same question
  if (isAnswering || lastAnsweredQuestion === qIndex || (me.question || 0) !== qIndex) {
    return;
  }

  isAnswering = true;
  selectedChoice = choice;
  lastAnsweredQuestion = qIndex;

  const isCorrect = choice === correctIndex;
  const newScore = (me.score || 0) + (isCorrect ? 1 : 0);
  const nextQ = qIndex + 1;

  // Immediate visual feedback on buttons
  const buttons = document.querySelectorAll('.answer-btn');
  buttons.forEach((b) => {
    b.disabled = true;
    const idx = Number(b.dataset.index);
    if (idx === choice) {
      b.classList.add(isCorrect ? 'selected-correct' : 'selected-wrong');
    } else if (idx === correctIndex) {
      b.classList.add('revealed-correct');
    }
  });

  const feedbackArea = document.querySelector('#feedback-area');
  if (feedbackArea) {
    feedbackArea.innerHTML = isCorrect ? `
      <div class="feedback-banner correct">
        <span>✓ Correct! +1 point</span>
        <span>Score: ${newScore} / 10</span>
      </div>
    ` : `
      <div class="feedback-banner wrong">
        <span>✗ Incorrect. Correct answer was Option ${String.fromCharCode(65 + correctIndex)}.</span>
        <span>Score: ${newScore} / 10</span>
      </div>
    `;
  }

  // Synchronize state with Firebase Realtime Database
  try {
    const updates = {};
    if (isCorrect) {
      updates[`rooms/${room}/players/${playerId}/score`] = newScore;
    }
    updates[`rooms/${room}/players/${playerId}/question`] = nextQ;
    updates[`rooms/${room}/players/${playerId}/online`] = true;

    // Check if this answer finishes the room for all players
    const allPlayers = Object.values(data.players || {});
    const willAllBeFinished = allPlayers.every(p => {
      if (p.id === playerId) return nextQ >= 10;
      return (p.question || 0) >= 10;
    });

    if (willAllBeFinished) {
      updates[`rooms/${room}/status`] = 'finished';
    }

    await update(ref(db), updates);
  } catch (err) {
    console.error('Error recording answer:', err);
  }

  // Smooth delay for feedback reading before advancing
  setTimeout(() => {
    isAnswering = false;
    selectedChoice = null;
  }, 1100);
}

// -------------------------------------------------------------
// 10. Waiting for Other Players Screen
// -------------------------------------------------------------
function renderWaitingForOthers(data, me, players) {
  const ranking = [...players].sort((a, b) => (b.score || 0) - (a.score || 0));
  const finishedCount = players.filter(p => (p.question || 0) >= 10).length;

  const screen = document.querySelector('#screen');
  screen.innerHTML = `
    <div class="game-grid">
      <div class="card hero">
        <h2>🎉 All 10 Questions Complete!</h2>
        <p class="muted">
          Your final score: <strong>${me.score || 0} / 10 (${Math.round(((me.score || 0) / 10) * 100)}%)</strong>
        </p>

        <div class="notice-box warning" style="margin-top:20px;">
          ⏳ Waiting for other contestants to finish answering...
          <div style="font-weight:700; margin-top:6px;">${finishedCount} of ${players.length} players completed</div>
        </div>

        <p class="muted" style="margin-top:16px;">
          The victory podium and final rankings will appear automatically as soon as all players submit question 10.
        </p>
      </div>

      <div class="card leaderboard-card">
        <h3>Live Standings</h3>
        <div class="rank-list">
          ${ranking.map((p, i) => `
            <div class="rank-item ${p.id === playerId ? 'is-me' : ''}">
              <span class="rank-num">${i + 1}</span>
              <div class="rank-details">
                <span class="rank-name">
                  ${esc(p.name)}
                  ${p.id === playerId ? '<span class="you-tag">You</span>' : ''}
                </span>
                <span class="rank-prog">${(p.question || 0) >= 10 ? '✓ Finished' : `Q ${(p.question || 0) + 1}/10`}</span>
              </div>
              <span class="rank-pts">${p.score || 0} pts</span>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;
}

// -------------------------------------------------------------
// 11. Final Results Screen
// -------------------------------------------------------------
function renderResults(data, me) {
  const players = Object.values(data.players || {});
  const sorted = [...players].sort((a, b) => (b.score || 0) - (a.score || 0));

  const isTie = sorted.length > 1 && sorted[0].score === sorted[1].score;
  const topScore = sorted[0]?.score || 0;
  const winners = sorted.filter(p => p.score === topScore);

  const medals = ['🥇', '🥈', '🥉', '🎖️'];

  const screen = document.querySelector('#screen');
  screen.innerHTML = `
    <div class="card hero">
      <div class="winner-banner">
        <div class="winner-trophy">${isTie ? '🤝' : '🏆'}</div>
        <h2>${isTie ? "It's a Tie!" : `${esc(sorted[0].name)} Wins!`}</h2>
        <div class="winner-subtitle">
          ${isTie ? `Outstanding match! ${winners.map(w => esc(w.name)).join(' and ')} tied with ${topScore} / 10 points.` : `Champion of Quiz Battle Arena with ${topScore} / 10 points!`}
        </div>
      </div>

      <div class="player-list-header">
        <h3>Final Arena Standings</h3>
        <span class="player-count-badge">${players.length} Players</span>
      </div>

      <div class="final-podium">
        ${sorted.map((p, idx) => {
          const isWinner = p.score === topScore;
          const accuracy = Math.round(((p.score || 0) / 10) * 100);
          return `
            <div class="podium-row ${isWinner ? 'winner' : ''}">
              <div class="medal-badge">${medals[idx] || '🎖️'}</div>
              <div class="podium-info">
                <div class="podium-name">
                  ${esc(p.name)}
                  ${p.id === playerId ? '<span class="you-tag">You</span>' : ''}
                  ${isWinner ? '<span class="host-tag" style="background:#fef08a; color:#854d0e;">Winner</span>' : ''}
                </div>
                <div class="podium-stats">Accuracy: ${accuracy}% · Rank #${idx + 1}</div>
              </div>
              <div class="podium-score">${p.score || 0} pts</div>
            </div>
          `;
        }).join('')}
      </div>

      <div class="results-actions">
        <button id="btn-rematch" class="primary" type="button">🔄 Play Again (Rematch)</button>
        <button id="btn-home" class="secondary" type="button">🏠 New Game / Lobby</button>
      </div>
    </div>
  `;

  document.querySelector('#btn-rematch').onclick = async () => {
    // Reset room for a new match with the same players
    const updates = {
      status: 'lobby'
    };
    for (const p of players) {
      updates[`players/${p.id}/score`] = 0;
      updates[`players/${p.id}/question`] = 0;
    }
    await update(ref(db, `rooms/${room}`), updates);
  };

  document.querySelector('#btn-home').onclick = handleLeaveRoom;
}

// -------------------------------------------------------------
// 12. Initialization & Reconnection
// -------------------------------------------------------------
function init() {
  if (room && playerId && playerName) {
    // Attempt graceful reconnection to previous room
    try {
      const roomRef = ref(db, `rooms/${room}`);
      onValue(roomRef, (snap) => {
        if (snap.exists()) {
          startListening();
        } else {
          clearStoredSession();
          renderHome();
        }
      }, { onlyOnce: true });
    } catch (e) {
      renderHome();
    }
  } else {
    renderHome();
  }
}

init();
