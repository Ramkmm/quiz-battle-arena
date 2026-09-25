import './style.css';
import { initializeApp } from 'firebase/app';
import {
  getDatabase,
  ref as fbRef,
  set as fbSet,
  update as fbUpdate,
  onValue as fbOnValue,
  onDisconnect as fbOnDisconnect,
  runTransaction as fbRunTransaction
} from 'firebase/database';
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged
} from 'firebase/auth';
import {
  QUESTION_BANK,
  getQuestionById,
  selectMatchQuestions
} from './questions.js';

// Authoritative Question Timer Configuration (Exactly 30 Seconds)
const QUESTION_DURATION_SEC = 30;
const QUESTION_DURATION_MS = 30000;

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

// Check if a configuration value is missing or a placeholder/template string
function isConfigPlaceholder(val) {
  if (!val || typeof val !== 'string') return true;
  const s = val.trim().toLowerCase();
  return (
    s === '' ||
    s === 'your_api_key' ||
    s === 'your_project_id' ||
    s === 'your_app_id' ||
    s === 'your_sender_id' ||
    s.includes('your_') ||
    s.includes('placeholder') ||
    s.includes('example.com')
  );
}

// Required for Firebase Realtime Database
const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey &&
  !isConfigPlaceholder(firebaseConfig.apiKey) &&
  firebaseConfig.databaseURL &&
  !isConfigPlaceholder(firebaseConfig.databaseURL) &&
  firebaseConfig.projectId &&
  !isConfigPlaceholder(firebaseConfig.projectId)
);

let hasFirebase = isFirebaseConfigured;

let firebaseApp = null;
let db = null;
let auth = null;
let firebaseInitError = null;
let isConnected = false;

if (hasFirebase) {
  try {
    firebaseApp = initializeApp(firebaseConfig);
    db = getDatabase(firebaseApp);
    auth = getAuth(firebaseApp);
  } catch (err) {
    console.warn('Firebase initialization notice (using local fallback mode):', err?.message || err);
    firebaseInitError = err.message;
    hasFirebase = false;
    db = null;
    auth = null;
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

async function runTransaction(refObj, updateFunction) {
  if (refObj && refObj.isMock) {
    const curVal = getMockValue(refObj.path);
    const cloned = curVal === undefined || curVal === null ? null : JSON.parse(JSON.stringify(curVal));
    const newVal = updateFunction(cloned);
    if (newVal !== undefined) {
      setMockValue(refObj.path, newVal);
      saveMockData(refObj.path);
    }
    return { committed: true, snapshot: createMockSnapshot(refObj.path) };
  }
  return fbRunTransaction(refObj, updateFunction);
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
// 3. Match Question Resolver (Authoritative Shared 10 Questions)
// -------------------------------------------------------------
function getMatchQuestion(data, qIndex) {
  if (data && Array.isArray(data.questionIds) && data.questionIds[qIndex]) {
    const qObj = getQuestionById(data.questionIds[qIndex]);
    if (qObj) return qObj;
  }
  // Safe fallback to guaranteed question bank item
  return QUESTION_BANK[qIndex % QUESTION_BANK.length];
}

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

function updateStoredPlayerId(newId) {
  playerId = newId;
  const s = getStoredSession() || {};
  s.playerId = newId;
  if (room) s.room = room;
  if (playerName) s.name = playerName;
  saveStoredSession(s);
}

// -------------------------------------------------------------
// Firebase Anonymous Authentication Setup
// -------------------------------------------------------------
let authUser = null;
let authError = null;
let isAuthReady = !hasFirebase; // Local fallback is immediately ready
let authReadyPromise = null;

function switchToLocalFallback(reason) {
  console.warn('Switching to local development multiplayer mode:', reason);
  hasFirebase = false;
  db = { isMock: true };
  auth = null;
  authUser = null;
  authError = null;
  isAuthReady = true;
  isConnected = false;
  updateStatusBadge();
  updateAuthButtonsState();
}

if (hasFirebase && auth) {
  authReadyPromise = new Promise((resolve) => {
    let resolved = false;

    const onUserReady = (user) => {
      authUser = user;
      updateStoredPlayerId(user.uid);
      isAuthReady = true;
      authError = null;
      updateStatusBadge();
      updateAuthButtonsState();
      if (!resolved) {
        resolved = true;
        resolve(user);
      }
    };

    onAuthStateChanged(auth, async (user) => {
      if (user) {
        onUserReady(user);
      } else {
        // App started or signed out: automatically sign in anonymously with Firebase
        try {
          const cred = await signInAnonymously(auth);
          onUserReady(cred.user);
        } catch (err) {
          console.warn('Firebase Anonymous Auth notice (activating local fallback):', err?.message || err);
          switchToLocalFallback(err?.message);
          if (!resolved) {
            resolved = true;
            resolve(null);
          }
        }
      }
    });
  });
} else {
  isAuthReady = true;
  authReadyPromise = Promise.resolve(null);
}

async function ensureAuth() {
  if (!hasFirebase) return true;
  if (isAuthReady && authUser) return true;

  if (authReadyPromise) {
    await authReadyPromise;
  }

  if (authUser || !hasFirebase) return true;

  if (auth) {
    try {
      const cred = await signInAnonymously(auth);
      authUser = cred.user;
      updateStoredPlayerId(cred.user.uid);
      isAuthReady = true;
      authError = null;
      updateStatusBadge();
      updateAuthButtonsState();
      return true;
    } catch (err) {
      console.warn('Firebase Anonymous Auth sign-in failed (activating local fallback):', err?.message || err);
      switchToLocalFallback(err?.message);
      return true;
    }
  }
  return true;
}

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
    if (authError) {
      badge.className = 'status-pill offline';
      badge.innerHTML = '<span class="status-dot"></span> Auth Error';
    } else if (!isAuthReady) {
      badge.className = 'status-pill offline';
      badge.innerHTML = '<span class="status-dot"></span> Authenticating...';
    } else if (isConnected) {
      badge.className = 'status-pill online';
      badge.innerHTML = `<span class="status-dot"></span> Firebase Live <span class="uid-tag" title="Authenticated UID: ${esc(playerId)}">UID: ${esc(playerId.slice(0, 6))}…</span>`;
    } else {
      badge.className = 'status-pill offline';
      badge.innerHTML = '<span class="status-dot"></span> Connecting RTDB...';
    }
  } else {
    badge.className = 'status-pill local';
    badge.innerHTML = '<span class="status-dot"></span> Local Mode (Dev)';
  }
}

function updateAuthButtonsState() {
  const btnCreate = document.querySelector('#btn-create');
  const btnJoin = document.querySelector('#btn-join');
  const authInfo = document.querySelector('#auth-indicator');

  if (authInfo && hasFirebase) {
    if (authError) {
      authInfo.className = 'auth-status-bar error';
      authInfo.innerHTML = `⚠️ Anonymous Auth Failed: ${esc(authError)} <button id="btn-auth-retry" type="button" class="retry-link">Retry</button>`;
      const retryBtn = document.querySelector('#btn-auth-retry');
      if (retryBtn) retryBtn.onclick = () => ensureAuth();
    } else if (!isAuthReady) {
      authInfo.className = 'auth-status-bar pending';
      authInfo.innerHTML = '🔒 Authenticating player anonymously with Firebase...';
    } else if (authUser) {
      authInfo.className = 'auth-status-bar ready';
      authInfo.innerHTML = `✓ Authenticated anonymously as <span class="uid-code" title="${esc(playerId)}">UID: ${esc(playerId.slice(0, 8))}…</span>`;
    }
  }

  if (hasFirebase) {
    if (btnCreate) {
      if (!isAuthReady) {
        btnCreate.disabled = true;
        btnCreate.textContent = '⏳ Authenticating...';
      } else {
        btnCreate.disabled = false;
        btnCreate.textContent = '⚡ Create Room';
      }
    }
    if (btnJoin) {
      btnJoin.disabled = !isAuthReady;
    }
  } else {
    if (btnCreate) {
      btnCreate.disabled = false;
      btnCreate.textContent = '⚡ Create Room';
    }
    if (btnJoin) {
      btnJoin.disabled = false;
    }
  }
}

function shell() {
  let statusClass = 'local';
  let statusText = 'Local Mode (Dev)';
  if (hasFirebase) {
    if (authError) {
      statusClass = 'offline';
      statusText = 'Auth Error';
    } else if (!isAuthReady) {
      statusClass = 'offline';
      statusText = 'Authenticating...';
    } else if (isConnected) {
      statusClass = 'online';
      statusText = `Firebase Live <span class="uid-tag" title="Authenticated UID: ${esc(playerId)}">UID: ${esc(playerId.slice(0, 6))}…</span>`;
    } else {
      statusClass = 'offline';
      statusText = 'Connecting RTDB...';
    }
  }

  app.innerHTML = `
    <main class="wrap">
      <header>
        <div class="header-left">
          <div class="header-title-row">
            <div class="brand-emblem" aria-hidden="true">⚔️</div>
            <h1>Quiz Battle Arena</h1>
            <div id="connection-status" class="status-pill ${statusClass}">
              <span class="status-dot"></span> ${statusText}
            </div>
          </div>
          <div class="header-desc">
            <span>2–4 Players</span>
            <span class="header-desc-dot">·</span>
            <span>10 Questions</span>
            <span class="header-desc-dot">·</span>
            <span>30s Countdown</span>
            <span class="header-desc-dot">·</span>
            <span>Live Multiplayer</span>
          </div>
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
      <div class="spec-banner" aria-label="Game Specifications">
        <div class="spec-item">
          <span class="spec-val">👥 2–4</span>
          <span class="spec-label">Players</span>
        </div>
        <div class="spec-item">
          <span class="spec-val">🎯 10</span>
          <span class="spec-label">Questions</span>
        </div>
        <div class="spec-item">
          <span class="spec-val">⏱️ 30s</span>
          <span class="spec-label">Per Round</span>
        </div>
      </div>

      <h2>Join the Arena</h2>
      <p class="muted">Play live trivia battles with friends across different devices or browser tabs.</p>

      ${errorMessage ? `<div class="notice-box error">${esc(errorMessage)}</div>` : ''}

      ${hasFirebase ? `
        <div id="auth-indicator" class="auth-status-bar ${!isAuthReady ? 'pending' : (authError ? 'error' : 'ready')}">
          ${!isAuthReady ? '🔒 Authenticating player anonymously with Firebase...' : (authError ? `⚠️ Anonymous Auth Failed: ${esc(authError)} <button id="btn-auth-retry" type="button" class="retry-link">Retry</button>` : `✓ Authenticated anonymously as <span class="uid-code" title="${esc(playerId)}">UID: ${esc(playerId.slice(0, 8))}…</span>`)}
        </div>
      ` : `
        <div class="notice-box warning">
          <strong>⚡ Local Development Mode:</strong> Firebase environment variables are not set in <code>.env.local</code>.
          Local fallback sync is active across browser tabs. To connect separate mobile devices and desktops, set your <code>VITE_FIREBASE_*</code> credentials.
        </div>
      `}

      <label for="player-name">Your Player Name</label>
      <input id="player-name" maxlength="16" placeholder="e.g., Alex, QuizMaster" value="${esc(playerName)}" autocomplete="off" />

      <div class="twocol">
        <div class="create-group">
          <label>Create New Game</label>
          <button id="btn-create" class="primary" type="button" ${hasFirebase && !isAuthReady ? 'disabled' : ''}>
            ${hasFirebase && !isAuthReady ? '⏳ Authenticating...' : '⚡ Create Room'}
          </button>
        </div>
        <div class="join-group">
          <label for="room-code">Join with Code</label>
          <div style="display:flex; gap:8px;">
            <input id="room-code" maxlength="4" placeholder="ABCD" value="${esc(roomFromUrl.toUpperCase())}" style="text-transform:uppercase; letter-spacing:2px; font-weight:700;" autocomplete="off" />
            <button id="btn-join" class="secondary" style="width: auto; padding: 0 20px;" type="button" ${hasFirebase && !isAuthReady ? 'disabled' : ''}>Join</button>
          </div>
        </div>
      </div>

      <div class="notice-box" style="margin-top:24px;">
        <strong style="display:block; margin-bottom:8px; color:#ffffff;">🎮 Battle Arena Rules:</strong>
        <ul style="padding-left:18px; margin:0; line-height:1.65; color:var(--text-secondary);">
          <li>Supports 2 to 4 players per room in real-time.</li>
          <li>Every player receives the same 10 curated multiple-choice questions.</li>
          <li>Authoritative synchronized 30-second countdown per question.</li>
          <li>Each correct answer immediately awards 1 point.</li>
          <li>Live standings update dynamically on all contestants' screens.</li>
          <li>The contender with the highest score after 10 questions wins!</li>
        </ul>
      </div>
    </div>
  `;

  updateAuthButtonsState();

  const retryBtn = document.querySelector('#btn-auth-retry');
  if (retryBtn) retryBtn.onclick = () => ensureAuth();

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

  // Wait for Firebase authentication to complete if Firebase is active
  if (hasFirebase && !isAuthReady) {
    const btnCreate = document.querySelector('#btn-create');
    if (btnCreate) {
      btnCreate.disabled = true;
      btnCreate.textContent = '⏳ Authenticating...';
    }
    await ensureAuth();
  }

  if (hasFirebase && !authUser) {
    switchToLocalFallback('Anonymous auth unavailable');
  }

  room = generateRoomCode();
  saveStoredSession({ room, playerId, name });

  try {
    const roomRef = ref(db, `rooms/${room}`);
    await set(roomRef, {
      id: room,
      status: 'lobby',
      createdAt: Date.now(),
      hostId: playerId,
      questionIds: selectMatchQuestions(),
      currentQuestion: 0,
      questionStartTime: 0,
      questionEndTime: 0,
      questionStatus: 'idle',
      advanceTime: 0,
      players: {
        [playerId]: {
          id: playerId,
          name,
          score: 0,
          correctAnswers: 0,
          question: 0,
          answers: {},
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
    console.warn('Error creating room:', err);
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

  // Wait for Firebase authentication to complete if Firebase is active
  if (hasFirebase && !isAuthReady) {
    const btnJoin = document.querySelector('#btn-join');
    if (btnJoin) btnJoin.disabled = true;
    await ensureAuth();
  }

  if (hasFirebase && !authUser) {
    switchToLocalFallback('Anonymous auth unavailable');
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
        correctAnswers: existing.correctAnswers || 0,
        question: existing.question || 0,
        answers: existing.answers || {},
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
    console.warn('Error joining room:', err);
    renderHome(`Failed to join room: ${err.message || 'Connection error'}`);
  }
}

// -------------------------------------------------------------
// 7. Synchronized Game Timing, Watchdog & Progression Engine
// -------------------------------------------------------------
let lastRoomData = null;
let timerInterval = null;
let currentTimerQIndex = -1;
let watchdogInterval = null;
let isAdvancingQuestion = false;
let isSettingRevealed = false;
let renderedGameState = {
  qIndex: -1,
  questionStatus: '',
  hasAnswered: false,
  score: -1
};

function startWatchdog() {
  if (!watchdogInterval) {
    watchdogInterval = setInterval(runProgressionWatchdog, 400);
  }
}

function stopWatchdog() {
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
  }
}

/**
 * Deterministically ranks active contestants to coordinate progression.
 * Host is primary; earliest joined active player is backup.
 */
function getCoordinatorList(data) {
  if (!data || !data.players) return [];
  const players = Object.values(data.players);
  const onlinePlayers = players.filter(p => p.online !== false);
  const pool = onlinePlayers.length > 0 ? onlinePlayers : players;

  return [...pool].sort((a, b) => {
    if (a.id === data.hostId) return -1;
    if (b.id === data.hostId) return 1;
    const tA = a.joinedAt || 0;
    const tB = b.joinedAt || 0;
    if (tA !== tB) return tA - tB;
    return String(a.id).localeCompare(String(b.id));
  }).map(p => p.id);
}

function isPrimaryCoordinator(data) {
  const list = getCoordinatorList(data);
  return list.length > 0 && list[0] === playerId;
}

/**
 * Atomically marks the question as 'revealed' and sets the 2-second transition window.
 * Idempotent across multiple clients.
 */
async function transitionQuestionToRevealed(expectedQIndex, delayMs = 2000) {
  if (!room || isSettingRevealed) return;
  if (!lastRoomData || lastRoomData.status !== 'playing') return;
  const currentQ = lastRoomData.currentQuestion ?? 0;
  if (currentQ !== expectedQIndex) return;
  if (lastRoomData.questionStatus === 'revealed' || lastRoomData.questionStatus === 'completed') return;

  isSettingRevealed = true;
  try {
    const roomPath = `rooms/${room}`;
    await update(ref(db, roomPath), {
      questionStatus: 'revealed',
      advanceTime: Date.now() + delayMs
    });
  } catch (err) {
    console.warn('Error transitioning question to revealed:', err);
  } finally {
    isSettingRevealed = false;
  }
}

/**
 * Atomically advances to the next question or finishes the match.
 * Updates authoritative room timing and progression without touching players object.
 */
async function atomicallyAdvanceQuestion(expectedQIndex) {
  if (!room || isAdvancingQuestion) return;
  if (!lastRoomData || lastRoomData.status !== 'playing') return;
  const currentQ = lastRoomData.currentQuestion ?? 0;
  if (currentQ !== expectedQIndex) return;

  isAdvancingQuestion = true;
  try {
    const nextQ = expectedQIndex + 1;
    const now = Date.now();
    if (nextQ < 10) {
      await update(ref(db, `rooms/${room}`), {
        currentQuestion: nextQ,
        questionStartTime: now,
        questionEndTime: now + QUESTION_DURATION_MS,
        questionStatus: 'active',
        advanceTime: 0
      });
    } else {
      await update(ref(db, `rooms/${room}`), {
        currentQuestion: 10,
        status: 'finished',
        questionStatus: 'completed',
        advanceTime: 0
      });
    }
  } catch (err) {
    console.warn('Error atomically advancing question:', err);
  } finally {
    isAdvancingQuestion = false;
  }
}

/**
 * Resilient heartbeat watchdog running every 400ms.
 * Catches timer timeouts, early answer completion, and failovers even if browser intervals were throttled.
 */
function runProgressionWatchdog() {
  if (!lastRoomData || lastRoomData.status !== 'playing') return;
  const now = Date.now();
  const qIndex = lastRoomData.currentQuestion ?? 0;
  const qStatus = lastRoomData.questionStatus || 'active';
  const endTime = lastRoomData.questionEndTime || 0;
  const advanceTime = lastRoomData.advanceTime || 0;

  // 1. In active state: check early completion or timeout (including recovering stuck rooms)
  if (qStatus === 'active') {
    const players = Object.values(lastRoomData.players || {});
    const onlinePlayers = players.filter(p => p.online !== false);
    const pool = onlinePlayers.length > 0 ? onlinePlayers : players;
    const allAnswered = pool.length > 0 && pool.every(p => Boolean(p.answers && p.answers[qIndex]));

    if (allAnswered) {
      transitionQuestionToRevealed(qIndex, 2000);
      return;
    }

    // Timer expired, or recovering existing room stuck in the past
    if (endTime > 0 && now >= endTime) {
      if (isPrimaryCoordinator(lastRoomData) || now >= endTime + 800) {
        transitionQuestionToRevealed(qIndex, 2000);
        return;
      }
    }
  }

  // 2. In revealed state: check if 2-second transition time has elapsed
  if (qStatus === 'revealed' && advanceTime > 0 && now >= advanceTime) {
    if (isPrimaryCoordinator(lastRoomData) || now >= advanceTime + 800) {
      atomicallyAdvanceQuestion(qIndex);
    }
  }
}

function stopTimerLoop() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  currentTimerQIndex = -1;
}

function startTimerLoop(endTime, qIndex) {
  if (timerInterval && currentTimerQIndex === qIndex) {
    return;
  }
  stopTimerLoop();
  currentTimerQIndex = qIndex;

  function updateTimerDisplay() {
    const now = Date.now();
    const remainingSeconds = Math.max(0, Math.ceil((endTime - now) / 1000));
    const percent = Math.max(0, Math.min(100, (remainingSeconds / QUESTION_DURATION_SEC) * 100));

    const textEl = document.querySelector('#timer-text');
    const pillEl = document.querySelector('#timer-pill');
    const barEl = document.querySelector('#timer-bar');

    let mode = 'normal';
    if (remainingSeconds <= 5) {
      mode = 'urgent';
    } else if (remainingSeconds <= 10) {
      mode = 'warning';
    }

    if (textEl) {
      textEl.textContent = `Time Left: ${remainingSeconds}s`;
    }
    if (pillEl) {
      pillEl.className = `timer-pill ${mode}`;
    }
    if (barEl) {
      barEl.className = `timer-bar ${mode}`;
      barEl.style.width = `${percent}%`;
    }

    if (remainingSeconds <= 0) {
      // Disable buttons immediately on timeout
      const buttons = document.querySelectorAll('.answer-btn');
      buttons.forEach(b => { b.disabled = true; });
      transitionQuestionToRevealed(qIndex, 2000);
    }
  }

  updateTimerDisplay();
  timerInterval = setInterval(updateTimerDisplay, 250);
}

// -------------------------------------------------------------
// 8. Room Router & Realtime Listener
// -------------------------------------------------------------
function startListening() {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }

  startWatchdog();

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

function renderRoom(data) {
  lastRoomData = data;
  const players = Object.values(data.players || {});
  const me = (data.players || {})[playerId];

  if (!me) {
    clearStoredSession();
    renderHome('You have been disconnected from the room.');
    return;
  }

  // Trigger heartbeat evaluation immediately on snapshot
  runProgressionWatchdog();

  // Route based on room status
  if (data.status === 'playing') {
    renderGame(data, me);
    return;
  }

  if (data.status === 'finished') {
    stopTimerLoop();
    renderResults(data, me);
    return;
  }

  // Lobby / Waiting Room
  stopTimerLoop();
  renderLobby(data, me, players);
}

// -------------------------------------------------------------
// 9. In-Game Quiz Screen (Synchronized 30s Timer)
// -------------------------------------------------------------
function renderGame(data, me) {
  const players = Object.values(data.players || {});
  const qIndex = Math.min(data.currentQuestion ?? 0, 10);

  // If 10 questions completed, transition to final results
  if (qIndex >= 10 || data.status === 'finished') {
    stopTimerLoop();
    renderResults(data, me);
    return;
  }

  const q = getMatchQuestion(data, qIndex);
  const ranking = [...players].sort((a, b) => (b.score || 0) - (a.score || 0));

  const myAnswer = (me.answers && me.answers[qIndex]) || null;
  const hasAnswered = Boolean(myAnswer);
  const isRevealed = data.questionStatus === 'revealed';

  const now = Date.now();
  const endTime = data.questionEndTime || (now + QUESTION_DURATION_MS);
  const remainingSeconds = Math.max(0, Math.ceil((endTime - now) / 1000));
  const isTimedOut = remainingSeconds <= 0;
  const timerPercent = Math.max(0, Math.min(100, (remainingSeconds / QUESTION_DURATION_SEC) * 100));

  let timerMode = 'normal';
  if (remainingSeconds <= 5) {
    timerMode = 'urgent';
  } else if (remainingSeconds <= 10) {
    timerMode = 'warning';
  }

  if (!isRevealed && !isTimedOut) {
    startTimerLoop(endTime, qIndex);
  } else {
    stopTimerLoop();
  }

  // Smooth in-place leaderboard update if the question and status did not change
  const screen = document.querySelector('#screen');
  const existingGrid = document.querySelector('.game-grid');
  if (
    existingGrid &&
    renderedGameState.qIndex === qIndex &&
    renderedGameState.questionStatus === data.questionStatus
  ) {
    renderedGameState.hasAnswered = hasAnswered;
    renderedGameState.score = me.score || 0;

    const rankList = document.querySelector('.rank-list');
    if (rankList) {
      const medals = ['🥇', '🥈', '🥉', '4'];
      rankList.innerHTML = ranking.map((p, i) => {
        const pAns = p.answers && p.answers[qIndex];
        const statusLabel = pAns
          ? '<span style="color:var(--success); font-weight:700;">✓ Answered</span>'
          : (isRevealed || isTimedOut ? '<span style="color:var(--error); font-weight:600;">⏱️ Timed out</span>' : '<span style="color:var(--text-muted);">⏳ Thinking...</span>');
        const medalOrNum = i < 3 ? medals[i] : `${i + 1}`;
        return `
          <div class="rank-item ${p.id === playerId ? 'is-me' : ''}">
            <span class="rank-num" title="Rank ${i + 1}">${medalOrNum}</span>
            <div class="rank-details">
              <span class="rank-name">
                ${esc(p.name)}
                ${p.id === playerId ? '<span class="you-tag">You</span>' : ''}
              </span>
              <span class="rank-prog">${statusLabel}</span>
            </div>
            <span class="rank-pts">${p.score || 0} pts</span>
          </div>
        `;
      }).join('');
    }
    const scoreHead = document.querySelector('#header-my-score');
    if (scoreHead) scoreHead.textContent = `${me.score || 0} pts`;
    return;
  }

  renderedGameState = {
    qIndex,
    questionStatus: data.questionStatus || 'active',
    hasAnswered,
    score: me.score || 0
  };

  let feedbackHtml = '';
  if (hasAnswered) {
    if (myAnswer.correct) {
      feedbackHtml = `
        <div class="feedback-banner correct">
          <span>✓ Correct! +1 point</span>
          <span>Score: ${me.score || 0} / 10</span>
        </div>
      `;
    } else {
      feedbackHtml = `
        <div class="feedback-banner wrong">
          <span>✗ Incorrect. Correct answer was Option ${String.fromCharCode(65 + q.correctAnswer)}.</span>
          <span>Score: ${me.score || 0} / 10</span>
        </div>
      `;
    }
  } else if (isRevealed || isTimedOut) {
    feedbackHtml = `
      <div class="feedback-banner wrong">
        <span>⏱️ Time expired! Correct answer was Option ${String.fromCharCode(65 + q.correctAnswer)}.</span>
        <span>Score: ${me.score || 0} / 10</span>
      </div>
    `;
  }

  const isBtnDisabled = hasAnswered || isRevealed || isTimedOut || isAnswering;

  screen.innerHTML = `
    <div class="game-grid">
      <!-- Main Quiz Card -->
      <div class="card quiz-card">
        <div class="quiz-top">
          <div class="quiz-top-left">
            <span class="q-badge">Question ${qIndex + 1} of 10</span>
            <span class="q-meta-badge">
              <span>${esc(q.category)}</span>
              •
              <span class="q-diff-badge ${esc(q.difficulty.toLowerCase())}">${esc(q.difficulty)}</span>
            </span>
            <div id="timer-pill" class="timer-pill ${isRevealed || isTimedOut ? 'urgent' : timerMode}">
              <span>⏱️</span>
              <strong id="timer-text">${isRevealed || isTimedOut ? 'Time Left: 0s' : `Time Left: ${remainingSeconds}s`}</strong>
            </div>
          </div>
          <div>Score: <strong id="header-my-score">${me.score || 0} pts</strong></div>
        </div>

        <div class="timer-track" role="progressbar" aria-valuenow="${isRevealed || isTimedOut ? 0 : remainingSeconds}" aria-valuemin="0" aria-valuemax="${QUESTION_DURATION_SEC}">
          <div id="timer-bar" class="timer-bar ${isRevealed || isTimedOut ? 'urgent' : timerMode}" style="width: ${isRevealed || isTimedOut ? 0 : timerPercent}%;"></div>
        </div>

        <h2 class="question-text">${esc(q.question)}</h2>

        <div class="answers-grid" id="answers-container">
          ${q.options.map((answerText, idx) => {
            const letter = String.fromCharCode(65 + idx);
            let extraClass = '';
            if (hasAnswered) {
              if (idx === myAnswer.choice) {
                extraClass = myAnswer.correct ? 'selected-correct' : 'selected-wrong';
              } else if (idx === q.correctAnswer) {
                extraClass = 'revealed-correct';
              }
            } else if (isRevealed || isTimedOut) {
              if (idx === q.correctAnswer) {
                extraClass = 'revealed-correct';
              }
            }
            return `
              <button class="answer-btn ${extraClass}" data-index="${idx}" ${isBtnDisabled ? 'disabled' : ''} type="button">
                <span class="answer-letter">${letter}</span>
                <span>${esc(answerText)}</span>
              </button>
            `;
          }).join('')}
        </div>

        <div id="feedback-area">
          ${feedbackHtml}
        </div>

        ${isRevealed ? `
          <div class="revealed-notice">
            <span>⏳ Next question in 2 seconds...</span>
            <span class="player-count-badge">Advancing</span>
          </div>
        ` : ''}
      </div>

      <!-- Live Leaderboard Sidebar -->
      <div class="card leaderboard-card">
        <h3>
          <span>Live Leaderboard</span>
          <span class="player-count-badge">${players.length} Players</span>
        </h3>

        <div class="rank-list">
          ${ranking.map((p, i) => {
            const medals = ['🥇', '🥈', '🥉', '4'];
            const medalOrNum = i < 3 ? medals[i] : `${i + 1}`;
            const pAns = p.answers && p.answers[qIndex];
            const statusLabel = pAns
              ? '<span style="color:var(--success); font-weight:700;">✓ Answered</span>'
              : (isRevealed || isTimedOut ? '<span style="color:var(--error); font-weight:600;">⏱️ Timed out</span>' : '<span style="color:var(--text-muted);">⏳ Thinking...</span>');
            return `
              <div class="rank-item ${p.id === playerId ? 'is-me' : ''}">
                <span class="rank-num" title="Rank ${i + 1}">${medalOrNum}</span>
                <div class="rank-details">
                  <span class="rank-name">
                    ${esc(p.name)}
                    ${p.id === playerId ? '<span class="you-tag">You</span>' : ''}
                  </span>
                  <span class="rank-prog">${statusLabel}</span>
                </div>
                <span class="rank-pts">${p.score || 0} pts</span>
              </div>
            `;
          }).join('')}
        </div>

        <div class="notice-box" style="margin-top:16px; font-size:12px; padding:10px 12px;">
          Room Code: <strong>${room}</strong>
        </div>
      </div>
    </div>
  `;

  // Attach click handlers to answer buttons if not already answered
  if (!hasAnswered && !isRevealed && !isTimedOut) {
    document.querySelectorAll('.answer-btn').forEach((btn) => {
      btn.onclick = () => {
        const choice = Number(btn.dataset.index);
        handleAnswerSelection(choice, q.correctAnswer, qIndex, me, data);
      };
    });
  }
}

async function handleAnswerSelection(choice, correctIndex, qIndex, me, data) {
  // Prevent double submissions or answering when question is not active
  const alreadyAnswered = Boolean(me.answers && me.answers[qIndex]);
  const now = Date.now();
  const remainingSeconds = Math.max(0, Math.ceil(((data.questionEndTime || 0) - now) / 1000));
  if (
    isAnswering ||
    alreadyAnswered ||
    (data.currentQuestion ?? 0) !== qIndex ||
    data.questionStatus !== 'active' ||
    remainingSeconds <= 0
  ) {
    return;
  }

  isAnswering = true;
  selectedChoice = choice;
  lastAnsweredQuestion = qIndex;

  const isCorrect = choice === correctIndex;

  // Initialize and record this answer in local memory
  if (!me.answers) me.answers = {};
  me.answers[qIndex] = {
    choice,
    correct: isCorrect,
    answeredAt: now
  };

  // Derive score accurately from all recorded answers so far (prevents duplicate points or drift)
  const currentTotalScore = Object.values(me.answers).filter(a => a && a.correct).length;
  me.score = currentTotalScore;
  me.correctAnswers = currentTotalScore;

  // 1. Immediate visual feedback on buttons
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

  const headerScore = document.querySelector('#header-my-score');
  if (headerScore) {
    headerScore.textContent = `${currentTotalScore} pts`;
  }

  const feedbackArea = document.querySelector('#feedback-area');
  if (feedbackArea) {
    feedbackArea.innerHTML = isCorrect ? `
      <div class="feedback-banner correct">
        <span>✓ Correct! +1 point</span>
        <span>Score: ${currentTotalScore} / 10</span>
      </div>
    ` : `
      <div class="feedback-banner wrong">
        <span>✗ Incorrect. Correct answer was Option ${String.fromCharCode(65 + correctIndex)}.</span>
        <span>Score: ${currentTotalScore} / 10</span>
      </div>
    `;
  }

  // 2. Authoritative Atomic Persistence for this player in Firebase Realtime Database
  try {
    const playerPath = `rooms/${room}/players/${playerId}`;
    await update(ref(db, playerPath), {
      score: currentTotalScore,
      correctAnswers: currentTotalScore,
      question: qIndex + 1,
      online: true,
      [`answers/${qIndex}`]: {
        choice,
        correct: isCorrect,
        answeredAt: now
      }
    });

    // 3. Early check if all online players in room have answered
    const freshData = lastRoomData || data;
    const allPlayers = Object.values(freshData.players || {});
    const onlinePlayers = allPlayers.filter(p => p.online !== false);
    const activePool = onlinePlayers.length > 0 ? onlinePlayers : allPlayers;

    const allAnswered = activePool.length > 0 && activePool.every(p => {
      if (p.id === playerId) return true;
      return Boolean(p.answers && p.answers[qIndex]);
    });

    if (allAnswered && (lastRoomData?.questionStatus === 'active' || data.questionStatus === 'active')) {
      await transitionQuestionToRevealed(qIndex, 2000);
    }
  } catch (err) {
    console.warn('Error recording answer:', err);
  } finally {
    isAnswering = false;
  }
}

// -------------------------------------------------------------
// 10. Final Results Screen
// -------------------------------------------------------------
function renderResults(data, me) {
  stopTimerLoop();
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
    stopTimerLoop();
    // Reset room for a new match with the same players and fresh unique questions
    const updates = {
      status: 'lobby',
      currentQuestion: 0,
      questionStartTime: 0,
      questionEndTime: 0,
      questionStatus: 'idle',
      advanceTime: 0,
      questionIds: selectMatchQuestions()
    };
    for (const p of players) {
      updates[`players/${p.id}/score`] = 0;
      updates[`players/${p.id}/correctAnswers`] = 0;
      updates[`players/${p.id}/question`] = 0;
      updates[`players/${p.id}/answers`] = {};
    }
    await update(ref(db, `rooms/${room}`), updates);
  };

  document.querySelector('#btn-home').onclick = handleLeaveRoom;
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
                ${p.online !== false ? '🟢 Connected' : '⚪ Offline / Refreshing'}
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
      const now = Date.now();
      const updates = {
        status: 'playing',
        startedAt: now,
        currentQuestion: 0,
        questionStartTime: now,
        questionEndTime: now + QUESTION_DURATION_MS,
        questionStatus: 'active',
        advanceTime: 0
      };
      if (!data.questionIds || data.questionIds.length < 10) {
        updates.questionIds = selectMatchQuestions();
      }
      // Reset all players scores, question index to 0, and clear answers
      for (const p of players) {
        updates[`players/${p.id}/score`] = 0;
        updates[`players/${p.id}/correctAnswers`] = 0;
        updates[`players/${p.id}/question`] = 0;
        updates[`players/${p.id}/answers`] = {};
      }
      await update(ref(db, `rooms/${room}`), updates);
    };
  }

  document.querySelector('#btn-leave').onclick = handleLeaveRoom;
}

async function handleLeaveRoom() {
  stopTimerLoop();
  stopWatchdog();
  isAdvancingQuestion = false;
  isSettingRevealed = false;
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
// 11. Initialization & Reconnection
// -------------------------------------------------------------
async function init() {
  renderHome();

  if (hasFirebase && authReadyPromise) {
    await authReadyPromise;
  }

  if (room && playerId && playerName) {
    // Attempt graceful reconnection to previous room
    try {
      const roomRef = ref(db, `rooms/${room}`);
      onValue(roomRef, (snap) => {
        if (snap.exists()) {
          update(ref(db, `rooms/${room}/players/${playerId}`), { online: true }).catch(() => {});
          try {
            onDisconnect(ref(db, `rooms/${room}/players/${playerId}/online`)).set(false);
          } catch (err) {}
          startListening();
        } else {
          clearStoredSession();
          renderHome();
        }
      }, { onlyOnce: true });
    } catch (e) {
      renderHome();
    }
  }
}

init();
