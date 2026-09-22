import './style.css';
import { initializeApp } from 'firebase/app';
import { getDatabase, ref, set, update, onValue, onDisconnect, remove, runTransaction } from 'firebase/database';

const firebaseConfig={
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || '',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || '',
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL || '',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || '',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || '',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || ''
};
const hasFirebase=Object.values(firebaseConfig).every(Boolean);
let db=null;
if(hasFirebase){try{db=getDatabase(initializeApp(firebaseConfig));}catch(e){console.error(e)}}

const questions=[
['Which planet is known as the Red Planet?',['Earth','Mars','Jupiter','Venus'],1],
['What is 12 × 8?',['86','96','108','112'],1],
['Which language runs in a web browser?',['Python','C++','JavaScript','SQL'],2],
['What is the largest ocean?',['Atlantic','Indian','Arctic','Pacific'],3],
['Which gas do plants absorb?',['Oxygen','Nitrogen','Carbon dioxide','Hydrogen'],2],
['How many sides does a hexagon have?',['5','6','7','8'],1],
['Who painted the Mona Lisa?',['Van Gogh','Da Vinci','Picasso','Monet'],1],
['What is H2O?',['Salt','Water','Oxygen','Hydrogen'],1],
['Which continent is India in?',['Europe','Asia','Africa','Australia'],1],
['What is the capital of Japan?',['Seoul','Beijing','Tokyo','Bangkok'],2]
];
const app=document.querySelector('#root');
let room='',playerId=crypto.randomUUID(),name='',unsubscribe=null,local={answers:0};
const esc=s=>String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
function shell(){app.innerHTML=`<main class="wrap"><header><div><span class="badge">LIVE MULTIPLAYER</span><h1>Quiz Battle Arena</h1><p>2–4 players · 10 questions · highest score wins</p></div><div class="logo">⚡</div></header><section id="screen"></section><footer>Join with a room code • Works on mobile & desktop</footer></main>`;}
function home(msg=''){shell();document.querySelector('#screen').innerHTML=`<div class="card hero"><h2>Create or Join a Room</h2><p class="muted">Invite friends by sharing the 4-character room code.</p>${msg?`<div class="error">${esc(msg)}</div>`:''}<label>Your name<input id="name" maxlength="18" placeholder="Player name"></label><div class="twocol"><button id="create" class="primary">Create Room</button><div><label>Room code<input id="code" maxlength="4" placeholder="ABCD" style="text-transform:uppercase"></label><button id="join">Join Room</button></div></div><div class="rules"><b>Rules</b><ul><li>Each player answers 10 questions.</li><li>Correct answer = 1 point.</li><li>Highest score after question 10 wins.</li></ul></div></div>`;
document.querySelector('#create').onclick=()=>startCreate();document.querySelector('#join').onclick=()=>startJoin();}
function validName(){const n=document.querySelector('#name').value.trim();if(!n){home('Enter your name first.');return null}return n}
function randomCode(){return Math.random().toString(36).slice(2,6).toUpperCase()}
async function startCreate(){name=validName();if(!name)return;if(!db){home('Firebase is not configured. Add the VITE_FIREBASE_* values in .env.local before deploying.');return}room=randomCode();const roomRef=ref(db,`rooms/${room}`);await set(roomRef,{status:'lobby',question:0,createdAt:Date.now(),players:{[playerId]:{name,score:0,question:0,online:true}}});await onDisconnect(ref(db,`rooms/${room}/players/${playerId}`)).remove();listen();}
async function startJoin(){name=validName();if(!name)return;if(!db){home('Firebase is not configured. Add the VITE_FIREBASE_* values in .env.local before deploying.');return}room=document.querySelector('#code').value.trim().toUpperCase();if(!/^[A-Z0-9]{4}$/.test(room)){home('Room code must be 4 characters.');return}const r=ref(db,`rooms/${room}`);onValue(r,s=>{if(!s.exists())home('Room not found. Check the code.');else if(Object.keys(s.val().players||{}).length>=4&&!s.val().players[playerId])home('Room is full.');},{onlyOnce:true});await update(ref(db,`rooms/${room}/players/${playerId}`),{name,score:0,question:0,online:true});await onDisconnect(ref(db,`rooms/${room}/players/${playerId}`)).remove();listen();}
function listen(){if(unsubscribe)unsubscribe();unsubscribe=onValue(ref(db,`rooms/${room}`),snap=>{const data=snap.val();if(!data){home('The room was closed.');return}renderRoom(data)});}
function renderRoom(data){const players=Object.values(data.players||{});const me=(data.players||{})[playerId];if(!me)return;const allReady=players.length>=2;document.querySelector('#screen').innerHTML=`<div class="card"><div class="roombar"><div><span class="muted">ROOM CODE</span><strong>${room}</strong></div><button id="copy">Copy code</button></div><h2>${data.status==='playing'?'Game in progress':'Waiting for players'}</h2><p class="muted">${players.length}/4 players connected. ${allReady?'The host can start when everyone is ready.':'Need at least 2 players to start.'}</p><div class="players">${players.map(p=>`<div class="player"><span class="avatar">${esc(p.name[0]||'?')}</span><div><b>${esc(p.name)}</b><small>${p.question>=10?'Finished':'Ready'}</small></div><span class="score">${p.score} pts</span></div>`).join('')}</div>${data.status==='lobby'?`<button id="start" class="primary full" ${players.length<2?'disabled':''}>Start Quiz</button>`:''}</div>`;document.querySelector('#copy').onclick=()=>navigator.clipboard?.writeText(room);const start=document.querySelector('#start');if(start)start.onclick=()=>update(ref(db,`rooms/${room}`),{status:'playing',question:0});if(data.status==='playing')renderQuestion(data,me);}
function renderQuestion(data,me){const qIndex=Math.min(me.question||0,9);const q=questions[qIndex];const answered=me.question>qIndex;const progress=Math.round((qIndex/10)*100);const ranking=Object.values(data.players||{}).sort((a,b)=>b.score-a.score);document.querySelector('#screen').innerHTML=`<div class="gamegrid"><div class="card"><div class="qtop"><span>Question ${qIndex+1} of 10</span><span>${progress}%</span></div><div class="progress"><i style="width:${progress}%"></i></div><h2>${esc(q[0])}</h2><div class="answers">${q[1].map((a,i)=>`<button data-i="${i}" ${answered?'disabled':''}>${String.fromCharCode(65+i)}. ${esc(a)}</button>`).join('')}</div>${answered?`<div class="notice">Answer submitted. Waiting for the next question…</div>`:''}</div><div class="card"><h3>Leaderboard</h3>${ranking.map((p,i)=>`<div class="rank"><span>${i+1}</span><b>${esc(p.name)}</b><strong>${p.score}</strong></div>`).join('')}<div class="muted mini">Your score: ${me.score}</div></div></div>`;document.querySelectorAll('[data-i]').forEach(b=>b.onclick=()=>answer(Number(b.dataset.i),q[2],me));}
async function answer(choice,correct,me){if(me.question>=10)return;const updates={};if(choice===correct)updates[`rooms/${room}/players/${playerId}/score`]=(me.score||0)+1;updates[`rooms/${room}/players/${playerId}/question`]=(me.question||0)+1;await update(ref(db),updates);}
shell();home();
