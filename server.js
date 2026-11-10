/* =========================================================
   EL BOTÓN — juego "el primero que presione gana"
   Páginas:
     /          → jugadores (lo que abre el QR)
     /pantalla  → pantalla grande con el QR y el ganador
     /admin     → cabina para activar el botón (pide contraseña)
     /qr.svg    → el código QR para imprimir
     /jeopardy  → botones de los concursantes del Jeopardy (ver jeopardy-buzzer.js)
   ========================================================= */
const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS) || 5000;

const app = express();
app.set('trust proxy', true);
const server = http.createServer(app);
// cors abierto: la cabina del Jeopardy se abre como archivo local y se conecta desde ahí
const io = new Server(server, { pingInterval: 10000, pingTimeout: 8000, maxHttpBufferSize: 1e4, cors: { origin: true } });

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

/* ---------- URL para el QR ---------- */
function lanIp() {
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  return 'localhost';
}
function joinUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL + '/';
  const host = req.get('host') || `localhost:${PORT}`;
  const hostname = host.replace(/:\d+$/, '');
  if (['localhost', '127.0.0.1', '[::1]'].includes(hostname)) return `http://${lanIp()}:${PORT}/`;
  return `${req.protocol}://${host}/`;
}
app.get('/api/info', (req, res) => res.json({ joinUrl: joinUrl(req) }));
app.get('/qr.svg', async (req, res) => {
  const svg = await QRCode.toString(joinUrl(req), { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
  res.type('image/svg+xml').send(svg);
});
app.get('/salud', (req, res) => res.set('Access-Control-Allow-Origin', '*').send('ok'));
require('./jeopardy-buzzer')({ io, app, QRCode, joinUrl, ADMIN_PASSWORD });

/* ---------- estado del juego ---------- */
const players = new Map(); // token -> { token, name, sockets:Set, wins, banned, joinedAt }
const MAX_DELAY = 600; // 10 minutos
const settings = { excludeWinners: true, penalizeEarly: true, minDelay: 2, maxDelay: 6 };
const history = []; // ganadores anteriores
let round = newRound(0);
let armTimer = null;

function newRound(no) {
  // estados: idle → armed ("¡prepárate!" durante toda la espera) → open → won
  return { no, state: 'idle', openedAt: 0, openAt: 0, presses: [], pressed: new Map(), locked: new Set(), winner: null };
}
const isConnected = p => p.sockets.size > 0 && !p.banned;
const playerCount = () => { let n = 0; for (const p of players.values()) if (isConnected(p)) n++; return n; };
const cleanName = s => String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
const code4 = () => String(crypto.randomInt(1000, 10000));

function publicRound() {
  return {
    no: round.no, state: round.state, count: playerCount(), penalizeEarly: settings.penalizeEarly,
    winner: round.winner ? { name: round.winner.name, code: round.winner.code, ms: round.winner.ms } : null,
  };
}
function meFor(p) {
  const entry = round.pressed.get(p.token) || null;
  return {
    name: p.name, banned: p.banned, wins: p.wins, round: round.no,
    locked: round.locked.has(p.token),
    ineligible: settings.excludeWinners && p.wins > 0 && !(round.winner && round.winner.token === p.token),
    pressed: entry ? { pos: entry.pos, ms: entry.ms } : null,
    isWinner: !!(round.winner && round.winner.token === p.token),
    code: round.winner && round.winner.token === p.token ? round.winner.code : null,
  };
}
function sendMe(p) { const m = meFor(p); for (const id of p.sockets) io.to(id).emit('me', m); }
function sendMeAll() { for (const p of players.values()) if (p.sockets.size) sendMe(p); }
function broadcastRound() { io.emit('round', publicRound()); scheduleAdmin(); }

let countTimer = null;
function scheduleCount() { if (countTimer) return; countTimer = setTimeout(() => { countTimer = null; broadcastRound(); }, 400); }

let adminTimer = null;
function scheduleAdmin() { if (adminTimer) return; adminTimer = setTimeout(() => { adminTimer = null; io.to('admin').emit('admin:state', adminState()); }, 250); }
function adminState() {
  const list = [...players.values()]
    .sort((a, b) => (isConnected(b) - isConnected(a)) || a.name.localeCompare(b.name, 'es'))
    .slice(0, 1000)
    .map(p => ({ token: p.token, name: p.name, online: p.sockets.size > 0, wins: p.wins, banned: p.banned }));
  return {
    round: { ...publicRound(), state: round.state, msToOpen: round.openAt ? Math.max(0, round.openAt - Date.now()) : 0 },
    maxDelay: MAX_DELAY, settings, history: history.slice(0, 50),
    presses: round.presses.slice(0, 30).map(e => ({ pos: e.pos, name: e.name, ms: e.ms })),
    totalPresses: round.presses.length, falseStarts: round.locked.size,
    players: list, totalPlayers: players.size, online: playerCount(),
  };
}

function clearTimers() { clearTimeout(armTimer); armTimer = null; }
function startRound(state) {
  clearTimers();
  round = newRound(round.no + 1);
  round.state = state;
  if (state === 'open') round.openedAt = Date.now();
  sendMeAll(); broadcastRound();
}
function openNow() {
  clearTimers();
  round.state = 'open'; round.openedAt = Date.now();
  broadcastRound();
}

/* ---------- conexiones ---------- */
io.on('connection', socket => {
  socket.emit('round', publicRound());

  socket.on('player:join', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const token = String((data && data.token) || '').replace(/[^\w-]/g, '').slice(0, 64);
    const name = cleanName(data && data.name);
    if (token.length < 8) return cb({ ok: false, error: 'Recarga la página e intenta de nuevo.' });
    if (!name) return cb({ ok: false, error: 'Escribe tu nombre.' });
    let p = players.get(token);
    if (!p) {
      if (players.size >= MAX_PLAYERS) return cb({ ok: false, error: 'El juego está lleno, lo sentimos.' });
      p = { token, name, sockets: new Set(), wins: 0, banned: false, joinedAt: Date.now() };
      players.set(token, p);
    } else if (!p.banned) p.name = name;
    if (socket.data.player && socket.data.player !== token) players.get(socket.data.player)?.sockets.delete(socket.id);
    socket.data.player = token;
    p.sockets.add(socket.id);
    cb({ ok: true });
    socket.emit('round', publicRound());
    sendMe(p); scheduleCount(); scheduleAdmin();
  });

  socket.on('player:press', () => {
    const now = Date.now();
    const p = socket.data.player && players.get(socket.data.player);
    if (!p || p.banned) return;
    if (round.state === 'armed') {
      if (settings.penalizeEarly && !round.locked.has(p.token)) { round.locked.add(p.token); sendMe(p); scheduleAdmin(); }
      return;
    }
    if (round.state !== 'open' && round.state !== 'won') return;
    if (round.locked.has(p.token) || round.pressed.has(p.token)) return;
    if (settings.excludeWinners && p.wins > 0) return sendMe(p);
    const entry = { token: p.token, name: p.name, ms: now - round.openedAt, pos: round.presses.length + 1 };
    round.presses.push(entry); round.pressed.set(p.token, entry);
    if (!round.winner) {
      round.winner = { ...entry, code: code4() };
      round.state = 'won';
      p.wins++;
      history.unshift({ round: round.no, name: p.name, ms: entry.ms, code: round.winner.code, at: now });
      broadcastRound();
    }
    sendMe(p); scheduleAdmin();
  });

  socket.on('disconnect', () => {
    const p = socket.data.player && players.get(socket.data.player);
    if (p) { p.sockets.delete(socket.id); scheduleCount(); scheduleAdmin(); }
  });

  /* ----- cabina ----- */
  socket.on('admin:auth', (pw, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    if (String(pw) !== ADMIN_PASSWORD) return cb({ ok: false });
    socket.data.admin = true; socket.join('admin');
    cb({ ok: true }); socket.emit('admin:state', adminState());
  });
  const admin = (ev, fn) => socket.on(ev, (...a) => { if (socket.data.admin) fn(...a); });

  admin('admin:arm', () => {
    const min = Math.max(0, settings.minDelay), max = Math.max(min, settings.maxDelay);
    const delay = (min + Math.random() * (max - min)) * 1000;
    startRound('armed');
    round.openAt = Date.now() + delay;
    armTimer = setTimeout(openNow, delay);
    scheduleAdmin();
  });
  admin('admin:open', () => { if (round.state === 'armed') openNow(); else startRound('open'); });
  admin('admin:stop', () => startRound('idle'));
  admin('admin:settings', s => {
    if (!s || typeof s !== 'object') return;
    if ('excludeWinners' in s) settings.excludeWinners = !!s.excludeWinners;
    if ('penalizeEarly' in s) settings.penalizeEarly = !!s.penalizeEarly;
    if ('minDelay' in s) settings.minDelay = Math.min(MAX_DELAY, Math.max(0, Number(s.minDelay) || 0));
    if ('maxDelay' in s) settings.maxDelay = Math.min(MAX_DELAY, Math.max(0, Number(s.maxDelay) || 0));
    if (settings.maxDelay < settings.minDelay) settings.maxDelay = settings.minDelay;
    sendMeAll(); broadcastRound();
  });
  admin('admin:kick', token => {
    const p = players.get(token); if (!p) return;
    p.banned = true; sendMe(p); scheduleCount(); scheduleAdmin();
  });
  admin('admin:unban', token => {
    const p = players.get(token); if (!p) return;
    p.banned = false; sendMe(p); scheduleCount(); scheduleAdmin();
  });
  admin('admin:resetwins', () => { for (const p of players.values()) p.wins = 0; history.length = 0; sendMeAll(); broadcastRound(); });
  admin('admin:clearplayers', () => {
    for (const p of players.values()) if (!p.sockets.size) players.delete(p.token);
    scheduleAdmin();
  });
});

server.listen(PORT, () => {
  console.log('\n🎮  El Botón está funcionando');
  console.log(`   Jugadores : http://${lanIp()}:${PORT}/`);
  console.log(`   Pantalla  : http://localhost:${PORT}/pantalla`);
  console.log(`   Cabina    : http://localhost:${PORT}/admin`);
  console.log(`   Jeopardy  : http://${lanIp()}:${PORT}/jeopardy (concursantes)`);
  if (!process.env.ADMIN_PASSWORD) console.log('   ⚠️  Contraseña de cabina por defecto: admin123 (cámbiala con ADMIN_PASSWORD)');
  if (PUBLIC_URL) console.log(`   QR apunta a: ${PUBLIC_URL}/`);
  console.log('');
});
