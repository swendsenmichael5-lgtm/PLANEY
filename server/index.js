const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/vendor/three', express.static(path.join(__dirname, '..', 'node_modules', 'three', 'build')));

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Game constants (mirrored on the client)
// ---------------------------------------------------------------------------
const GAME_LENGTH_MS = 8 * 60 * 1000;   // plane lands after 8 minutes -> crew wins
const LOCKPICK_TIME_MS = 9000;           // time Evil must spend at the cockpit door
const LOCKPICK_DECAY = 0.5;              // progress decay per second when not picking
const INSPECT_TIME_MS = 2500;            // time to inspect someone's sandals
const INSPECT_RANGE = 2.2;
const FALSE_ACCUSE_STUN_MS = 8000;
const DOOR_ZONE = { z: -23.0, radius: 1.6 };  // standing zone in front of cockpit door
const COCKPIT_Z = -24.2;                 // past this you are inside the cockpit
const TICK_MS = 50;

const COLORS = [0xe74c3c, 0x3498db, 0x2ecc71, 0xf1c40f, 0x9b59b6, 0xe67e22, 0x1abc9c, 0xfd79a8, 0x95a5a6, 0x6c5ce7];

// Seat slots handed to players as they join (window/middle seats, varied rows)
const PLAYER_SEATS = [];
for (let i = 2; i < 17; i += 2) {
  PLAYER_SEATS.push({ row: i, x: -1.5 });
  PLAYER_SEATS.push({ row: i + 1, x: 1.5 });
}
const rowZ = (row) => -20 + row * 2.2;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let phase = 'lobby';                 // lobby | playing | over
let players = new Map();             // socket.id -> player
let evilId = null;
let hostId = null;
let gameEndsAt = 0;
let gameTimer = null;
let lockpick = { progress: 0, picking: false, lastRattle: 0 };
let doorOpen = false;
let inspections = new Map();         // inspectorId -> {targetId, startedAt, startPos}
let nextSeat = 0;

// Two flight attendants patrolling the aisle with carts
const attendants = [
  { x: 0, z: 18, dir: -1, pauseUntil: 0, speed: 0.9, name: 'Brenda' },
  { x: 0, z: -16, dir: 1, pauseUntil: 0, speed: 0.8, name: 'Doug' },
];
const SERVE_LINES = ['Peanuts?', 'Coke or Sprite?', 'Pretzels, anyone?', 'More peanuts, hon?', 'Coke? Diet Coke?', 'Please keep the aisle clear.'];

function publicPlayer(p) {
  return { id: p.id, name: p.name, color: p.color, pos: p.pos, ry: p.ry, seated: p.seated,
           stunned: Date.now() < p.stunnedUntil, inspectCharges: p.inspectCharges, shownSandals: p.shownSandals };
}

function broadcastLobby() {
  io.emit('lobby', { phase, hostId, players: [...players.values()].map(publicPlayer) });
}

function resetToLobby() {
  phase = 'lobby';
  evilId = null;
  doorOpen = false;
  lockpick = { progress: 0, picking: false, lastRattle: 0 };
  inspections.clear();
  if (gameTimer) { clearTimeout(gameTimer); gameTimer = null; }
  for (const p of players.values()) {
    p.seated = true;
    p.pos = { x: p.seat.x, y: 0, z: rowZ(p.seat.row) };
    p.stunnedUntil = 0;
    p.inspectCharges = 1;
    p.shownSandals = false;
  }
  broadcastLobby();
}

function endGame(winner, reason) {
  if (phase !== 'playing') return;
  phase = 'over';
  if (gameTimer) { clearTimeout(gameTimer); gameTimer = null; }
  io.emit('gameOver', { winner, reason, evilId, evilName: players.get(evilId)?.name || '???' });
  setTimeout(resetToLobby, 8000);
}

function startGame() {
  const list = [...players.values()];
  if (list.length < 1) return;
  phase = 'playing';
  doorOpen = false;
  lockpick = { progress: 0, picking: false, lastRattle: 0 };
  inspections.clear();
  evilId = list[Math.floor(Math.random() * list.length)].id;
  gameEndsAt = Date.now() + GAME_LENGTH_MS;
  for (const p of list) {
    p.seated = true;
    p.pos = { x: p.seat.x, y: 0, z: rowZ(p.seat.row) };
    p.stunnedUntil = 0;
    p.inspectCharges = 1;
    p.shownSandals = false;
    io.to(p.id).emit('role', { evil: p.id === evilId });
  }
  io.emit('gameStarted', { endsAt: gameEndsAt, players: list.map(publicPlayer) });
  gameTimer = setTimeout(() => endGame('crew', 'The plane landed safely. The Evil never reached the cockpit.'), GAME_LENGTH_MS);
}

function cancelInspection(inspectorId, why) {
  const ins = inspections.get(inspectorId);
  if (!ins) return;
  inspections.delete(inspectorId);
  io.emit('inspectCancelled', { inspectorId, targetId: ins.targetId, why });
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

// ---------------------------------------------------------------------------
// Sockets
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  socket.on('join', ({ name }) => {
    if (players.has(socket.id)) return;
    const seat = PLAYER_SEATS[nextSeat % PLAYER_SEATS.length];
    nextSeat++;
    const p = {
      id: socket.id,
      name: String(name || 'Passenger').slice(0, 16) || 'Passenger',
      color: COLORS[players.size % COLORS.length],
      seat,
      pos: { x: seat.x, y: 0, z: rowZ(seat.row) },
      ry: 0,
      seated: true,
      stunnedUntil: 0,
      inspectCharges: 1,
      shownSandals: false,
    };
    players.set(socket.id, p);
    if (!hostId) hostId = socket.id;
    socket.emit('init', {
      id: socket.id, phase, hostId, doorOpen,
      endsAt: phase === 'playing' ? gameEndsAt : 0,
      players: [...players.values()].map(publicPlayer),
      seat,
    });
    if (phase === 'playing') socket.emit('role', { evil: false }); // late joiners are crew
    socket.broadcast.emit('playerJoined', publicPlayer(p));
    broadcastLobby();
  });

  socket.on('startGame', () => {
    if (socket.id === hostId && phase === 'lobby') startGame();
  });

  socket.on('move', ({ pos, ry, seated }) => {
    const p = players.get(socket.id);
    if (!p) return;
    if (Date.now() < p.stunnedUntil) return;
    p.pos = { x: +pos.x || 0, y: 0, z: +pos.z || 0 };
    p.ry = +ry || 0;
    p.seated = !!seated;
    // Moving cancels any inspection you are performing, and dodging cancels one on you
    const myIns = inspections.get(socket.id);
    if (myIns && dist(p.pos, myIns.startPos) > 0.4) cancelInspection(socket.id, 'inspector moved');
    for (const [insId, ins] of inspections) {
      if (ins.targetId === socket.id && dist(p.pos, ins.targetStart) > 0.6) {
        cancelInspection(insId, 'target pulled away');
        io.emit('msg', { text: `${p.name} pulled their feet away from an inspection...`, kind: 'sus' });
      }
    }
  });

  // --- Sandal inspection: the core deduction tool -------------------------
  socket.on('inspectStart', ({ targetId }) => {
    const p = players.get(socket.id), t = players.get(targetId);
    if (phase !== 'playing' || !p || !t || p === t) return;
    if (Date.now() < p.stunnedUntil) return;
    if (p.inspectCharges <= 0) return socket.emit('msg', { text: 'You have no inspections left.', kind: 'err' });
    if (t.seated) return socket.emit('msg', { text: `${t.name}'s feet are tucked under the seat. They must be standing.`, kind: 'err' });
    if (dist(p.pos, t.pos) > INSPECT_RANGE) return;
    if (inspections.has(socket.id)) return;
    inspections.set(socket.id, { targetId, startedAt: Date.now(), startPos: { ...p.pos }, targetStart: { ...t.pos } });
    io.emit('inspectStarted', { inspectorId: socket.id, targetId, durationMs: INSPECT_TIME_MS });
  });

  socket.on('inspectAbort', () => cancelInspection(socket.id, 'aborted'));

  // --- Voluntarily show your sandals (innocents can clear their name) -----
  socket.on('showSandals', () => {
    const p = players.get(socket.id);
    if (phase !== 'playing' || !p || p.seated) return;
    if (socket.id === evilId) {
      // Showing your sandals with a knife in them is instant defeat — the Evil never will.
      io.emit('msg', { text: `${p.name} showed their sandals... THERE'S A KNIFE IN THEM!`, kind: 'alert' });
      return endGame('crew', `${p.name} revealed the knife in their own sandal. Bold strategy.`);
    }
    p.shownSandals = true;
    io.emit('sandalsShown', { id: socket.id, name: p.name });
  });

  // --- Cockpit door ---------------------------------------------------------
  socket.on('lockpick', ({ active }) => {
    if (phase !== 'playing') return;
    if (socket.id !== evilId) {
      if (active) socket.emit('msg', { text: 'The cockpit door is locked. You have no reason to open it.', kind: 'err' });
      return;
    }
    lockpick.picking = !!active;
  });

  socket.on('pullKnife', () => {
    const p = players.get(socket.id);
    if (phase !== 'playing' || !p) return;
    if (socket.id !== evilId) return socket.emit('msg', { text: 'You check your sandal. Just a sandal.', kind: 'err' });
    if (p.pos.z > COCKPIT_Z) return socket.emit('msg', { text: 'You must be inside the cockpit.', kind: 'err' });
    io.emit('knifePulled', { id: p.id, name: p.name });
    endGame('evil', `${p.name} pulled the knife from their sandal inside the cockpit!`);
  });

  socket.on('chat', ({ text }) => {
    const p = players.get(socket.id);
    if (!p || !text) return;
    io.emit('chat', { name: p.name, color: p.color, text: String(text).slice(0, 140) });
  });

  socket.on('disconnect', () => {
    const p = players.get(socket.id);
    players.delete(socket.id);
    cancelInspection(socket.id, 'left');
    for (const [insId, ins] of inspections) if (ins.targetId === socket.id) cancelInspection(insId, 'target left');
    if (socket.id === hostId) hostId = players.keys().next().value || null;
    if (p) io.emit('playerLeft', { id: socket.id });
    if (phase === 'playing' && socket.id === evilId) {
      endGame('crew', `${p?.name || 'The Evil'} parachuted out of the plane (disconnected).`);
    }
    broadcastLobby();
  });
});

// ---------------------------------------------------------------------------
// Tick: attendants, lockpick progress, inspections, knife clinks
// ---------------------------------------------------------------------------
let lastServe = 0;
setInterval(() => {
  const now = Date.now();
  const dt = TICK_MS / 1000;

  // Flight attendants patrol the aisle, pausing to serve rows
  for (const a of attendants) {
    if (now >= a.pauseUntil) {
      a.z += a.dir * a.speed * dt;
      if (a.z > 19) { a.z = 19; a.dir = -1; a.pauseUntil = now + 3000; }
      if (a.z < -19) { a.z = -19; a.dir = 1; a.pauseUntil = now + 3000; }
      if (Math.random() < 0.012) {
        a.pauseUntil = now + 2500 + Math.random() * 3000;
        if (now - lastServe > 4000) {
          lastServe = now;
          io.emit('serve', { name: a.name, z: a.z, text: SERVE_LINES[Math.floor(Math.random() * SERVE_LINES.length)] });
        }
      }
    }
  }

  if (phase === 'playing') {
    const evil = players.get(evilId);

    // Lockpicking: only counts while the Evil is standing in the door zone
    if (evil) {
      const inZone = Math.abs(evil.pos.x) < 1.2 && Math.abs(evil.pos.z - DOOR_ZONE.z) < DOOR_ZONE.radius;
      if (lockpick.picking && inZone && !evil.seated && !doorOpen) {
        lockpick.progress = Math.min(1, lockpick.progress + (TICK_MS / LOCKPICK_TIME_MS));
        // The door rattles — anyone paying attention can see/hear it
        if (now - lockpick.lastRattle > 900) {
          lockpick.lastRattle = now;
          io.emit('doorRattle', { progress: lockpick.progress });
        }
        io.to(evilId).emit('lockpickProgress', { progress: lockpick.progress });
        if (lockpick.progress >= 1 && !doorOpen) {
          doorOpen = true;
          io.emit('doorOpened', {});
        }
      } else if (!doorOpen && lockpick.progress > 0) {
        lockpick.progress = Math.max(0, lockpick.progress - LOCKPICK_DECAY * dt * (TICK_MS / 1000) * 20);
        io.to(evilId).emit('lockpickProgress', { progress: lockpick.progress });
      }

      // The hidden knife occasionally clinks when the Evil hurries
      if (evil._lastPos) {
        const speed = dist(evil.pos, evil._lastPos) / dt;
        if (speed > 3.2 && Math.random() < 0.025) {
          io.emit('clink', { x: evil.pos.x, z: evil.pos.z });
        }
      }
      evil._lastPos = { ...evil.pos };
    }

    // Resolve finished inspections
    for (const [insId, ins] of [...inspections]) {
      if (now - ins.startedAt >= INSPECT_TIME_MS) {
        inspections.delete(insId);
        const inspector = players.get(insId), target = players.get(ins.targetId);
        if (!inspector || !target) continue;
        if (ins.targetId === evilId) {
          io.emit('msg', { text: `${inspector.name} inspected ${target.name}'s sandals — A KNIFE!`, kind: 'alert' });
          endGame('crew', `${inspector.name} found the knife hidden in ${target.name}'s sandal!`);
        } else {
          inspector.inspectCharges--;
          inspector.stunnedUntil = now + FALSE_ACCUSE_STUN_MS;
          target.shownSandals = true;
          io.emit('inspectResult', { inspectorId: insId, targetId: ins.targetId, clean: true, stunMs: FALSE_ACCUSE_STUN_MS });
          io.emit('msg', { text: `${inspector.name} searched ${target.name}'s sandals: clean. ${inspector.name} is apologizing profusely (stunned).`, kind: 'info' });
        }
      }
    }
  }

  // Snapshot
  io.emit('snap', {
    t: now,
    players: [...players.values()].map(p => ({ id: p.id, pos: p.pos, ry: p.ry, seated: p.seated, stunned: now < p.stunnedUntil })),
    attendants: attendants.map(a => ({ x: a.x, z: a.z, dir: a.dir })),
    doorOpen,
  });
}, TICK_MS);

server.listen(PORT, () => console.log(`PLANEY boarding at http://localhost:${PORT}`));
