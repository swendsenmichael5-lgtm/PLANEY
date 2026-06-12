// ===========================================================================
// PLANEY host logic — runs in the room host's browser (authoritative peer).
// Talks to clients (and the host's own UI via loopback) through sendTo().
// ===========================================================================

export const C = {
  GAME_LENGTH_MS: 8 * 60 * 1000,
  LOCKPICK_TIME_MS: 9000,
  LOCKPICK_DECAY_PER_S: 0.04,
  INSPECT_TIME_MS: 2500,
  INSPECT_RANGE: 2.2,
  FALSE_ACCUSE_STUN_MS: 8000,
  RESTRAIN_RANGE: 1.8,
  RESTRAIN_MS: 15000,
  RESTRAIN_COOLDOWN_MS: 30000,
  COMMOTION_MS: 12000,
  COMMOTION_LOCKPICK_MULT: 2.5,
  DOOR_ZONE: { z: -23.0, radius: 1.6 },
  COCKPIT_Z: -24.2,
  TICK_MS: 50,
};

const COLORS = [0xe74c3c, 0x3498db, 0x2ecc71, 0xf1c40f, 0x9b59b6, 0xe67e22, 0x1abc9c, 0xfd79a8, 0x95a5a6, 0x6c5ce7];
const BOT_NAMES = ['Brad', 'Tina', 'Earl', 'Donna', 'Phil', 'Gloria', 'Chuck', 'Rhonda', 'Vern', 'Patty'];
const MIN_FLIERS = 6; // empty seats are filled with CPU passengers
const PLAYER_SEATS = [];
for (let i = 2; i < 17; i += 2) {
  PLAYER_SEATS.push({ row: i, x: -1.5 });
  PLAYER_SEATS.push({ row: i + 1, x: 1.5 });
}
const rowZ = (row) => -20 + row * 2.2;
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const SERVE_LINES = ['Peanuts?', 'Coke or Sprite?', 'Pretzels, anyone?', 'More peanuts, hon?', 'Coke? Diet Coke?', 'Please keep the aisle clear.'];

export class HostLogic {
  constructor(hostId, sendTo) {
    this.hostId = hostId;       // host's own peer id (loopback target)
    this.sendTo = sendTo;       // (peerIdOrNull, msg) -> deliver; null = everyone
    this.phase = 'lobby';
    this.players = new Map();
    this.evilId = null;
    this.endsAt = 0;
    this.doorOpen = false;
    this.lockpick = { progress: 0, picking: false, lastRattle: 0 };
    this.inspections = new Map();
    this.commotionUntil = 0;
    this.nextSeat = 0;
    this.lastServe = 0;
    this.botCount = 0;
    this.suspicion = new Map();   // playerId -> score the CPU crew uses to hunt
    this.cleared = new Set();     // verified-clean players (CPUs ignore them)
    this.attendants = [
      { z: 18, dir: -1, pauseUntil: 0, speed: 0.9, name: 'Brenda' },
      { z: -16, dir: 1, pauseUntil: 0, speed: 0.8, name: 'Doug' },
    ];
  }

  pub(p) {
    return { id: p.id, name: p.name, color: p.color, pos: p.pos, ry: p.ry, seated: p.seated };
  }
  all(msg) { this.sendTo(null, msg); }
  one(id, msg) { this.sendTo(id, msg); }

  // ---- lifecycle -----------------------------------------------------------
  addPlayer(id, name) {
    if (this.players.has(id)) return;
    const seat = PLAYER_SEATS[this.nextSeat++ % PLAYER_SEATS.length];
    const p = {
      id, seat,
      name: String(name || 'Passenger').slice(0, 16) || 'Passenger',
      color: COLORS[this.players.size % COLORS.length],
      pos: { x: seat.x, z: rowZ(seat.row) },
      ry: 0, seated: true,
      stunnedUntil: 0, restrainedUntil: 0, restrainCooldownUntil: 0,
      inspectCharges: 1,
    };
    this.players.set(id, p);
    this.one(id, {
      type: 'init', id, phase: this.phase, hostId: this.hostId, doorOpen: this.doorOpen,
      timeLeft: this.phase === 'playing' ? this.endsAt - Date.now() : 0,
      players: [...this.players.values()].map(x => this.pub(x)), seat,
    });
    if (this.phase === 'playing') this.one(id, { type: 'role', evil: false });
    this.all({ type: 'joined', p: this.pub(p) });
    this.broadcastLobby();
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this.cancelInspection(id, 'left');
    for (const [insId, ins] of this.inspections) if (ins.targetId === id) this.cancelInspection(insId, 'target left');
    this.all({ type: 'left', id });
    if (this.phase === 'playing' && id === this.evilId) {
      this.endGame('crew', `${p.name} parachuted out of the plane (disconnected).`);
    }
    this.broadcastLobby();
  }

  broadcastLobby() {
    this.all({ type: 'lobby', phase: this.phase, hostId: this.hostId, players: [...this.players.values()].map(p => this.pub(p)) });
  }

  addBot() {
    const id = 'cpu-' + Math.random().toString(36).slice(2, 8);
    const seat = PLAYER_SEATS[this.nextSeat++ % PLAYER_SEATS.length];
    const p = {
      id, seat, bot: true,
      name: BOT_NAMES[this.botCount++ % BOT_NAMES.length] + ' [CPU]',
      color: COLORS[this.players.size % COLORS.length],
      pos: { x: seat.x, z: rowZ(seat.row) },
      ry: 0, seated: true,
      stunnedUntil: 0, restrainedUntil: 0, restrainCooldownUntil: 0,
      inspectCharges: 1,
      ai: { state: 'seated', t: 0 },
    };
    this.players.set(id, p);
    this.all({ type: 'joined', p: this.pub(p) });
    return p;
  }

  removeBots() {
    for (const [id, p] of [...this.players]) {
      if (p.bot) { this.players.delete(id); this.all({ type: 'left', id }); }
    }
  }

  resetToLobby() {
    this.phase = 'lobby';
    this.evilId = null;
    this.removeBots();
    this.suspicion.clear();
    this.cleared.clear();
    this.doorOpen = false;
    this.lockpick = { progress: 0, picking: false, lastRattle: 0 };
    this.inspections.clear();
    this.commotionUntil = 0;
    for (const p of this.players.values()) {
      Object.assign(p, {
        seated: true, pos: { x: p.seat.x, z: rowZ(p.seat.row) },
        stunnedUntil: 0, restrainedUntil: 0, restrainCooldownUntil: 0, inspectCharges: 1,
      });
    }
    this.broadcastLobby();
  }

  startGame() {
    if (this.phase !== 'lobby' || this.players.size < 1) return;
    while (this.players.size < MIN_FLIERS) this.addBot();
    const list = [...this.players.values()];
    this.phase = 'playing';
    this.suspicion.clear();
    this.cleared.clear();
    this.doorOpen = false;
    this.lockpick = { progress: 0, picking: false, lastRattle: 0 };
    this.inspections.clear();
    this.commotionUntil = 0;
    this.evilId = list[Math.floor(Math.random() * list.length)].id;
    this.endsAt = Date.now() + C.GAME_LENGTH_MS;
    const now = Date.now();
    for (const p of list) {
      Object.assign(p, {
        seated: true, pos: { x: p.seat.x, z: rowZ(p.seat.row) },
        stunnedUntil: 0, restrainedUntil: 0, restrainCooldownUntil: 0, inspectCharges: 1,
      });
      if (p.bot) {
        p.ai = { state: 'seated', t: now + 6000 + Math.random() * 20000 };
        if (p.id === this.evilId) p.ai.missionAt = now + 25000 + Math.random() * 60000;
      } else {
        this.one(p.id, { type: 'role', evil: p.id === this.evilId });
      }
    }
    this.all({ type: 'started', timeLeft: C.GAME_LENGTH_MS, players: list.map(p => this.pub(p)) });
  }

  endGame(winner, reason) {
    if (this.phase !== 'playing') return;
    this.phase = 'over';
    const evil = this.players.get(this.evilId);
    this.all({ type: 'over', winner, reason, evilId: this.evilId, evilName: evil?.name || '???' });
    setTimeout(() => this.resetToLobby(), 8000);
  }

  cancelInspection(inspectorId, why) {
    const ins = this.inspections.get(inspectorId);
    if (!ins) return;
    this.inspections.delete(inspectorId);
    this.all({ type: 'insCancel', inspectorId, targetId: ins.targetId, why });
  }

  // ---- message handling ------------------------------------------------------
  handle(id, m) {
    const p = this.players.get(id);
    const now = Date.now();
    switch (m.type) {
      case 'join': return this.addPlayer(id, m.name);
      case 'start': if (id === this.hostId) this.startGame(); return;

      case 'move': {
        if (!p || now < p.stunnedUntil || now < p.restrainedUntil) return;
        p.pos = { x: +m.pos.x || 0, z: +m.pos.z || 0 };
        p.ry = +m.ry || 0;
        p.seated = !!m.seated;
        const myIns = this.inspections.get(id);
        if (myIns && dist(p.pos, myIns.startPos) > 0.4) this.cancelInspection(id, 'inspector moved');
        for (const [insId, ins] of this.inspections) {
          if (ins.targetId === id && dist(p.pos, ins.targetStart) > 0.6) {
            this.cancelInspection(insId, 'target pulled away');
            this.susAdd(id, 2);
            this.all({ type: 'msg', text: `${p.name} pulled their feet away from an inspection...`, kind: 'sus' });
          }
        }
        return;
      }

      case 'inspect': {
        const t = this.players.get(m.targetId);
        if (this.phase !== 'playing' || !p || !t || p === t) return;
        if (now < p.stunnedUntil || now < p.restrainedUntil) return;
        if (p.inspectCharges <= 0) return this.one(id, { type: 'msg', text: 'You have no inspections left.', kind: 'err' });
        if (t.seated) return this.one(id, { type: 'msg', text: `${t.name}'s feet are tucked under the seat. They must be standing.`, kind: 'err' });
        if (dist(p.pos, t.pos) > C.INSPECT_RANGE) return;
        if (this.inspections.has(id)) return;
        this.inspections.set(id, { targetId: m.targetId, startedAt: now, startPos: { ...p.pos }, targetStart: { ...t.pos } });
        this.all({ type: 'insStart', inspectorId: id, targetId: m.targetId, durationMs: C.INSPECT_TIME_MS });
        return;
      }
      case 'inspectAbort': return this.cancelInspection(id, 'aborted');

      case 'restrain': {
        const t = this.players.get(m.targetId);
        if (this.phase !== 'playing' || !p || !t || p === t) return;
        if (now < p.stunnedUntil || now < p.restrainedUntil || p.seated) return;
        if (now < p.restrainCooldownUntil)
          return this.one(id, { type: 'msg', text: `You're still catching your breath (${Math.ceil((p.restrainCooldownUntil - now) / 1000)}s).`, kind: 'err' });
        if (t.seated) return this.one(id, { type: 'msg', text: `${t.name} is buckled into their seat.`, kind: 'err' });
        if (now < t.restrainedUntil) return this.one(id, { type: 'msg', text: `${t.name} is already restrained.`, kind: 'err' });
        if (dist(p.pos, t.pos) > C.RESTRAIN_RANGE) return;
        t.restrainedUntil = now + C.RESTRAIN_MS;
        p.restrainCooldownUntil = now + C.RESTRAIN_COOLDOWN_MS;
        // Any tackle throws the cabin into chaos — if the Evil is still free,
        // this is their window: the lock picks faster and nobody hears the door.
        this.commotionUntil = now + C.COMMOTION_MS;
        this.cancelInspection(m.targetId, 'restrained mid-inspection');
        this.all({
          type: 'restrained', id: m.targetId, by: id, byName: p.name, name: t.name,
          restrainMs: C.RESTRAIN_MS, cooldownMs: C.RESTRAIN_COOLDOWN_MS, commotionMs: C.COMMOTION_MS,
        });
        this.all({ type: 'msg', text: `${p.name} tackled ${t.name} and zip-tied them with seatbelt extenders! The cabin is in uproar!`, kind: 'alert' });
        return;
      }

      case 'show': {
        if (this.phase !== 'playing' || !p || p.seated || now < p.restrainedUntil) return;
        if (id === this.evilId) {
          this.all({ type: 'msg', text: `${p.name} showed their sandals... THERE'S A KNIFE IN THEM!`, kind: 'alert' });
          return this.endGame('crew', `${p.name} revealed the knife in their own sandal. Bold strategy.`);
        }
        this.cleared.add(id);
        this.suspicion.delete(id);
        this.all({ type: 'sandals', id, name: p.name });
        return;
      }

      case 'lockpick': {
        if (this.phase !== 'playing' || !p) return;
        if (id !== this.evilId) {
          if (m.active) this.one(id, { type: 'msg', text: 'The cockpit door is locked. You have no reason to open it.', kind: 'err' });
          return;
        }
        this.lockpick.picking = !!m.active;
        return;
      }

      case 'knife': {
        if (this.phase !== 'playing' || !p) return;
        if (id !== this.evilId) return this.one(id, { type: 'msg', text: 'You check your sandal. Just a sandal.', kind: 'err' });
        if (p.pos.z > C.COCKPIT_Z) return this.one(id, { type: 'msg', text: 'You must be inside the cockpit.', kind: 'err' });
        this.all({ type: 'knifePulled', id, name: p.name });
        return this.endGame('evil', `${p.name} pulled the knife from their sandal inside the cockpit!`);
      }

      case 'chat': {
        if (!p || !m.text) return;
        this.all({ type: 'chat', name: p.name, color: p.color, text: String(m.text).slice(0, 140) });
        return;
      }
    }
  }

  // ---- CPU passengers ------------------------------------------------------
  susAdd(id, amt) {
    if (this.cleared.has(id)) return;
    if (!this.players.has(id)) return;
    this.suspicion.set(id, (this.suspicion.get(id) || 0) + amt);
  }

  // Walk a bot toward (tx, tz) through the aisle. Returns true when arrived.
  // Movement goes through handle('move') so inspection-dodging, restraint
  // blocking and clink detection all apply to CPUs exactly like humans.
  botStep(p, tx, tz, sp, dt) {
    const { x, z } = p.pos;
    let dx = 0, dz = 0;
    if (Math.abs(z - tz) > 0.2 && Math.abs(x) > 0.3) dx = -Math.sign(x); // get to the aisle first
    else if (Math.abs(z - tz) > 0.2) dz = Math.sign(tz - z);
    else if (Math.abs(x - tx) > 0.15) dx = Math.sign(tx - x);
    else return true;
    this.handle(p.id, {
      type: 'move',
      pos: { x: x + dx * sp * dt, z: z + dz * sp * dt },
      ry: Math.atan2(-dx, -dz),
      seated: false,
    });
    return false;
  }

  botStand(p) {
    this.handle(p.id, { type: 'move', pos: { x: p.seat.x > 0 ? 0.2 : -0.2, z: rowZ(p.seat.row) + 0.85 }, ry: 0, seated: false });
  }

  updateBots(now, dt) {
    // hottest suspect the cabin is muttering about
    let topId = null, topS = 3.5;
    for (const [id, s] of this.suspicion) {
      if (this.cleared.has(id) || !this.players.has(id)) continue;
      if (s > topS) { topS = s; topId = id; }
    }
    for (const p of this.players.values()) {
      if (!p.bot) continue;
      if (now < p.restrainedUntil || now < p.stunnedUntil) continue;
      if (p.id === this.evilId) { this.updateEvilBot(p, now, dt); continue; }
      const ai = p.ai;
      // take up the hunt if nobody else has
      if (topId && topId !== p.id && ai.state !== 'hunt' &&
          (p.inspectCharges > 0 || now >= p.restrainCooldownUntil)) {
        const taken = [...this.players.values()].some(q => q.bot && q.ai?.state === 'hunt' && q.ai.targetId === topId);
        if (!taken) { ai.state = 'hunt'; ai.targetId = topId; ai.t = now + 20000; }
      }
      switch (ai.state) {
        case 'seated':
          if (now >= ai.t) {
            ai.state = 'stroll';
            ai.tz = Math.random() < 0.35 ? 19 : rowZ(Math.floor(Math.random() * 18));
            ai.t = now + 25000;
            this.botStand(p);
          }
          break;
        case 'stroll':
          if (this.botStep(p, 0, ai.tz, 1.8, dt) || now >= ai.t) {
            ai.state = 'pause'; ai.t = now + 2000 + Math.random() * 4000;
          }
          break;
        case 'pause':
          if (now >= ai.t) ai.state = 'return';
          break;
        case 'return':
          if (this.botStep(p, p.seat.x > 0 ? 0.2 : -0.2, rowZ(p.seat.row) + 0.85, 1.8, dt)) {
            this.handle(p.id, { type: 'move', pos: { x: p.seat.x, z: rowZ(p.seat.row) }, ry: Math.PI, seated: true });
            ai.state = 'seated'; ai.t = now + 8000 + Math.random() * 25000;
          }
          break;
        case 'hunt': {
          const t = this.players.get(ai.targetId);
          const sus = this.suspicion.get(ai.targetId) || 0;
          if (!t || this.cleared.has(ai.targetId) || now >= ai.t || sus < 1.5) { ai.state = 'return'; break; }
          if (this.inspections.has(p.id)) break; // hold still mid-inspection
          if (t.seated) { this.botStep(p, 0, t.pos.z + 1.5, 1.8, dt); break; } // hover, wait them out
          if (dist(p.pos, t.pos) > 1.4) { this.botStep(p, t.pos.x * 0.5, t.pos.z, 2.2, dt); break; }
          if (now >= t.restrainedUntil && sus >= 5.5 && now >= p.restrainCooldownUntil) {
            this.handle(p.id, { type: 'restrain', targetId: ai.targetId });
          } else if (p.inspectCharges > 0) {
            this.handle(p.id, { type: 'inspect', targetId: ai.targetId });
          } else {
            ai.t = Math.min(ai.t, now + 4000); // nothing left to do, lose interest
          }
          break;
        }
      }
    }
  }

  updateEvilBot(p, now, dt) {
    const ai = p.ai;
    // someone's reaching for our sandals — jerk away (cancels the inspection)
    for (const ins of this.inspections.values()) {
      if (ins.targetId === p.id) {
        this.botStep(p, 0, p.pos.z > -19 ? p.pos.z - 2.5 : p.pos.z + 2.5, 4, dt);
        return;
      }
    }
    const commotion = now < this.commotionUntil;
    const threat = [...this.players.values()].some(q =>
      q.id !== p.id && !q.seated && now >= q.restrainedUntil &&
      dist(q.pos, { x: 0, z: C.DOOR_ZONE.z }) < 7);
    switch (ai.state) {
      case 'seated':
        if (now >= (ai.missionAt || 0) || (commotion && now >= (ai.missionAt || 0) - 30000)) {
          ai.state = 'mission';
          this.botStand(p);
        }
        break;
      case 'mission': {
        if (this.doorOpen) { ai.state = 'breach'; break; }
        if (this.botStep(p, 0, C.DOOR_ZONE.z + 0.3, commotion ? 3.6 : 1.9, dt)) {
          if (threat && !commotion) {
            this.handle(p.id, { type: 'lockpick', active: false });
            ai.state = 'loiter'; ai.t = now + 5000 + Math.random() * 6000;
          } else {
            this.handle(p.id, { type: 'lockpick', active: true });
          }
        }
        break;
      }
      case 'loiter':
        this.handle(p.id, { type: 'lockpick', active: false });
        if (this.botStep(p, 0.2, -13, 1.8, dt) && now >= ai.t) ai.state = 'mission';
        if (this.doorOpen) ai.state = 'breach';
        break;
      case 'breach':
        this.handle(p.id, { type: 'lockpick', active: false });
        if (this.botStep(p, 0, C.COCKPIT_Z - 1.3, 4.2, dt)) this.handle(p.id, { type: 'knife' });
        break;
    }
  }

  // ---- tick (50ms) -------------------------------------------------------------
  tick() {
    const now = Date.now();
    const dt = C.TICK_MS / 1000;

    for (const a of this.attendants) {
      if (now >= a.pauseUntil) {
        a.z += a.dir * a.speed * dt;
        if (a.z > 19) { a.z = 19; a.dir = -1; a.pauseUntil = now + 3000; }
        if (a.z < -19) { a.z = -19; a.dir = 1; a.pauseUntil = now + 3000; }
        if (Math.random() < 0.012) {
          a.pauseUntil = now + 2500 + Math.random() * 3000;
          if (now - this.lastServe > 4000) {
            this.lastServe = now;
            this.all({ type: 'serve', name: a.name, z: a.z, text: SERVE_LINES[Math.floor(Math.random() * SERVE_LINES.length)] });
          }
        }
      }
    }

    if (this.phase === 'playing') {
      if (now >= this.endsAt) {
        this.endGame('crew', 'The plane landed safely. The Evil never reached the cockpit.');
        return;
      }
      const commotion = now < this.commotionUntil;
      const evil = this.players.get(this.evilId);

      if (evil) {
        const inZone = Math.abs(evil.pos.x) < 1.2 && Math.abs(evil.pos.z - C.DOOR_ZONE.z) < C.DOOR_ZONE.radius;
        const restrained = now < evil.restrainedUntil;
        if (this.lockpick.picking && inZone && !evil.seated && !restrained && !this.doorOpen) {
          const mult = commotion ? C.COMMOTION_LOCKPICK_MULT : 1;
          this.lockpick.progress = Math.min(1, this.lockpick.progress + (C.TICK_MS / C.LOCKPICK_TIME_MS) * mult);
          // During a commotion nobody hears the door over the shouting
          if (!commotion && now - this.lockpick.lastRattle > 900) {
            this.lockpick.lastRattle = now;
            this.all({ type: 'rattle', progress: this.lockpick.progress });
          }
          this.one(this.evilId, { type: 'lockProg', progress: this.lockpick.progress });
          if (this.lockpick.progress >= 1) {
            this.doorOpen = true;
            this.all({ type: 'doorOpened' });
          }
        } else if (!this.doorOpen && this.lockpick.progress > 0) {
          this.lockpick.progress = Math.max(0, this.lockpick.progress - C.LOCKPICK_DECAY_PER_S * dt);
          this.one(this.evilId, { type: 'lockProg', progress: this.lockpick.progress });
        }

        if (evil._lastPos && !commotion) {
          const speed = dist(evil.pos, evil._lastPos) / dt;
          if (speed > 3.2 && Math.random() < 0.025) {
            this.all({ type: 'clink', x: evil.pos.x, z: evil.pos.z });
            // CPUs grow suspicious of whoever was standing near the sound
            for (const q of this.players.values()) {
              if (!q.seated && dist(q.pos, evil.pos) < 2.5) this.susAdd(q.id, 1.5);
            }
          }
        }
        evil._lastPos = { ...evil.pos };
      }

      // CPUs notice who loiters at the cockpit door
      for (const q of this.players.values()) {
        if (!q.seated && Math.abs(q.pos.x) < 1.2 && Math.abs(q.pos.z - C.DOOR_ZONE.z) < C.DOOR_ZONE.radius) {
          this.susAdd(q.id, 0.035);
        }
      }
      for (const [id, s] of this.suspicion) {
        const v = s - 0.004;
        if (v <= 0) this.suspicion.delete(id); else this.suspicion.set(id, v);
      }

      this.updateBots(now, dt);

      for (const [insId, ins] of [...this.inspections]) {
        if (now - ins.startedAt >= C.INSPECT_TIME_MS) {
          this.inspections.delete(insId);
          const inspector = this.players.get(insId), target = this.players.get(ins.targetId);
          if (!inspector || !target) continue;
          if (ins.targetId === this.evilId) {
            this.all({ type: 'msg', text: `${inspector.name} inspected ${target.name}'s sandals — A KNIFE!`, kind: 'alert' });
            this.endGame('crew', `${inspector.name} found the knife hidden in ${target.name}'s sandal!`);
          } else {
            inspector.inspectCharges--;
            inspector.stunnedUntil = now + C.FALSE_ACCUSE_STUN_MS;
            this.cleared.add(ins.targetId);
            this.suspicion.delete(ins.targetId);
            this.all({ type: 'insResult', inspectorId: insId, targetId: ins.targetId, clean: true, stunMs: C.FALSE_ACCUSE_STUN_MS });
            this.all({ type: 'msg', text: `${inspector.name} searched ${target.name}'s sandals: clean. ${inspector.name} is apologizing profusely (stunned).`, kind: 'info' });
          }
        }
      }

      // Release expired restraints
      for (const p of this.players.values()) {
        if (p.restrainedUntil && p.restrainedUntil <= now && !p._released) {
          p._released = true;
          this.all({ type: 'released', id: p.id, name: p.name });
        }
        if (now < p.restrainedUntil) p._released = false;
      }
    }

    this.all({
      type: 'snap', t: now,
      players: [...this.players.values()].map(p => ({
        id: p.id, pos: p.pos, ry: p.ry, seated: p.seated,
        stunned: now < p.stunnedUntil, restrained: now < p.restrainedUntil,
      })),
      attendants: this.attendants.map(a => ({ z: a.z, dir: a.dir })),
      doorOpen: this.doorOpen,
      commotion: now < this.commotionUntil,
    });
  }
}
