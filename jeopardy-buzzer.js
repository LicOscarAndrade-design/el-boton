/* =========================================================
   BOTONES DEL JEOPARDY (modo aparte del Botón sorpresa)
     /jeopardy        → página para los concursantes (eligen equipo)
     /qr-jeopardy.svg → QR que lleva a /jeopardy
   La cabina del Jeopardy (jeopardy.html) se conecta al espacio "/jp"
   con la misma contraseña de cabina (ADMIN_PASSWORD).
   ========================================================= */
module.exports = function setupJeopardy({ io, app, QRCode, joinUrl, ADMIN_PASSWORD }) {
  app.get('/qr-jeopardy.svg', async (req, res) => {
    const svg = await QRCode.toString(joinUrl(req) + 'jeopardy', { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').set('Access-Control-Allow-Origin', '*').send(svg);
  });
  app.get('/api/jeopardy-info', (req, res) => res.set('Access-Control-Allow-Origin', '*').json({ joinUrl: joinUrl(req) + 'jeopardy' }));

  const nsp = io.of('/jp');
  const players = new Map(); // token -> { token, name, team, sockets:Set, kicked }
  const S = { teams: [], open: false, qid: null, locked: new Set(), winner: null, openedAt: 0, presses: 0 };

  const cleanName = s => String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
  const online = p => p.sockets.size > 0 && !p.kicked;

  function pub() {
    return {
      teams: S.teams, open: S.open, qid: S.qid, locked: [...S.locked],
      winner: S.winner ? { name: S.winner.name, team: S.winner.team, ms: S.winner.ms } : null,
    };
  }
  function cabState() {
    const list = [...players.values()].filter(p => !p.kicked)
      .sort((a, b) => (a.team ?? 99) - (b.team ?? 99) || a.name.localeCompare(b.name, 'es'))
      .map(p => ({ token: p.token, name: p.name, team: p.team, online: online(p) }));
    return { ...pub(), players: list };
  }
  function me(p) {
    return { name: p.name, team: p.team, kicked: !!p.kicked, isWinner: !!(S.winner && S.winner.token === p.token) };
  }
  function sendMe(p) { const m = me(p); for (const id of p.sockets) nsp.to(id).emit('me', m); }
  let t = null;
  function broadcast() {
    nsp.emit('round', pub());
    clearTimeout(t); t = setTimeout(() => nsp.to('cab').emit('cab:state', cabState()), 60);
  }

  nsp.on('connection', socket => {
    socket.emit('round', pub());

    socket.on('join', (d, cb) => {
      cb = typeof cb === 'function' ? cb : () => {};
      const token = String((d && d.token) || '').replace(/[^\w-]/g, '').slice(0, 64);
      const name = cleanName(d && d.name);
      const team = Number.isInteger(d && d.team) && d.team >= 0 && d.team < S.teams.length ? d.team : null;
      if (token.length < 8) return cb({ ok: false, error: 'Recarga la página e intenta de nuevo.' });
      if (!name) return cb({ ok: false, error: 'Escribe tu nombre.' });
      if (players.size > 500 && !players.has(token)) return cb({ ok: false, error: 'Demasiados concursantes conectados.' });
      let p = players.get(token);
      if (!p) { p = { token, name, team, sockets: new Set(), kicked: false }; players.set(token, p); }
      else if (!p.kicked) { p.name = name; p.team = team; }
      if (socket.data.token && socket.data.token !== token) players.get(socket.data.token)?.sockets.delete(socket.id);
      socket.data.token = token; p.sockets.add(socket.id);
      cb({ ok: true, team: p.team });
      sendMe(p); broadcast();
    });

    socket.on('press', () => {
      const now = Date.now();
      const p = socket.data.token && players.get(socket.data.token);
      if (!p || p.kicked || p.team === null || p.team === undefined) return;
      if (!S.open || S.winner || S.locked.has(p.team)) return;
      S.winner = { token: p.token, name: p.name, team: p.team, ms: now - S.openedAt };
      S.open = false; S.presses++;
      broadcast(); for (const q of players.values()) if (q.sockets.size) sendMe(q);
    });

    socket.on('disconnect', () => {
      const p = socket.data.token && players.get(socket.data.token);
      if (p) { p.sockets.delete(socket.id); broadcast(); }
    });

    /* ----- cabina del Jeopardy ----- */
    socket.on('cab:auth', (pw, cb) => {
      cb = typeof cb === 'function' ? cb : () => {};
      if (String(pw) !== ADMIN_PASSWORD) return cb({ ok: false });
      socket.data.cab = true; socket.join('cab'); cb({ ok: true });
      socket.emit('cab:state', cabState());
    });
    const cab = (ev, fn) => socket.on(ev, (...a) => { if (socket.data.cab) fn(...a); });
    const allLocked = () => S.teams.length > 0 && S.teams.every((_, i) => S.locked.has(i));
    const notifyAll = () => { for (const q of players.values()) if (q.sockets.size) sendMe(q); };

    cab('cab:teams', teams => {
      if (!Array.isArray(teams)) return;
      S.teams = teams.map(x => cleanName(x)).filter(Boolean).slice(0, 12);
      for (const p of players.values()) if (p.team !== null && p.team >= S.teams.length) p.team = null;
      notifyAll(); broadcast();
    });
    // abre los botones; si es una pregunta nueva, se limpian los bloqueos
    cab('cab:open', qid => {
      qid = String(qid ?? '');
      if (qid !== S.qid) { S.qid = qid; S.locked.clear(); }
      if (allLocked()) return broadcast();
      S.winner = null; S.open = true; S.openedAt = Date.now();
      notifyAll(); broadcast();
    });
    // respuesta incorrecta: se bloquea a ese equipo y el botón rebota a los demás
    cab('cab:wrong', team => {
      const tm = Number.isInteger(team) ? team : S.winner ? S.winner.team : null;
      if (tm !== null) S.locked.add(tm);
      S.winner = null;
      S.open = !allLocked(); S.openedAt = Date.now();
      notifyAll(); broadcast();
    });
    cab('cab:close', () => { S.open = false; S.winner = null; S.qid = null; S.locked.clear(); notifyAll(); broadcast(); });
    cab('cab:pause', () => { S.open = false; broadcast(); });
    cab('cab:kick', token => { const p = players.get(token); if (p) { p.kicked = true; sendMe(p); broadcast(); } });
    cab('cab:clear', () => { for (const p of [...players.values()]) if (!p.sockets.size || p.kicked) players.delete(p.token); broadcast(); });
  });
};
