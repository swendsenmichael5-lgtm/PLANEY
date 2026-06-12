import * as THREE from 'three';

// ===========================================================================
// Constants (must match server/index.js)
// ===========================================================================
const ROWS = 18;
const rowZ = (r) => -20 + r * 2.2;
const SEAT_XS = [-2.2, -1.5, -0.8, 0.8, 1.5, 2.2];
const CABIN_FRONT = -24;       // cockpit door plane
const CABIN_BACK = 20.5;       // galley wall
const COCKPIT_BACK = -28;
const DOOR_ZONE = { z: -23.0, radius: 1.6 };
const EYE = 1.55, EYE_SEATED = 1.05;
const WALK = 2.3, SPRINT = 4.2, RADIUS = 0.32;
const INSPECT_RANGE = 2.2;

// ===========================================================================
// HUD helpers
// ===========================================================================
const $ = (id) => document.getElementById(id);
const feed = (text, kind = 'info') => {
  const d = document.createElement('div');
  d.className = kind; d.textContent = text;
  $('feed').prepend(d);
  while ($('feed').children.length > 7) $('feed').lastChild.remove();
  setTimeout(() => d.remove(), 9000);
};
const setPrompt = (t) => { $('prompt').style.display = t ? 'block' : 'none'; $('prompt').innerHTML = t || ''; };
const setProgress = (label, frac) => {
  const w = $('progressWrap');
  if (frac == null) { w.style.display = 'none'; return; }
  w.style.display = 'block';
  $('progressLabel').textContent = label;
  $('progressBar').style.width = `${Math.round(frac * 100)}%`;
};

// Tiny WebAudio blips so clinks and rattles are audible
let actx;
function blip(freq, dur = 0.08, gain = 0.15) {
  try {
    actx = actx || new AudioContext();
    const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = freq; o.type = 'triangle';
    g.gain.setValueAtTime(gain, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + dur);
    o.connect(g).connect(actx.destination);
    o.start(); o.stop(actx.currentTime + dur);
  } catch {}
}

// ===========================================================================
// Scene
// ===========================================================================
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0e16);
const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.05, 120);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

scene.add(new THREE.HemisphereLight(0xeef3ff, 0x30343f, 1.0));
const sun = new THREE.DirectionalLight(0xfff3df, 0.5);
sun.position.set(3, 6, 2);
scene.add(sun);

const colliders = []; // {minX,maxX,minZ,maxZ}
const box = (minX, maxX, minZ, maxZ) => colliders.push({ minX, maxX, minZ, maxZ });

// ---- Fuselage -------------------------------------------------------------
{
  const len = CABIN_BACK - COCKPIT_BACK + 4;
  const tube = new THREE.Mesh(
    new THREE.CylinderGeometry(3.2, 3.2, len, 28, 1, true),
    new THREE.MeshStandardMaterial({ color: 0xd8dde6, side: THREE.BackSide, roughness: 0.9 })
  );
  tube.rotation.x = Math.PI / 2;
  tube.position.set(0, 1.2, (CABIN_BACK + COCKPIT_BACK) / 2);
  scene.add(tube);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(5.6, len),
    new THREE.MeshStandardMaterial({ color: 0x2e3340, roughness: 0.95 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0.001, (CABIN_BACK + COCKPIT_BACK) / 2);
  scene.add(floor);

  // Aisle carpet
  const carpet = new THREE.Mesh(
    new THREE.PlaneGeometry(1.0, CABIN_BACK - CABIN_FRONT),
    new THREE.MeshStandardMaterial({ color: 0x44506e, roughness: 1 })
  );
  carpet.rotation.x = -Math.PI / 2;
  carpet.position.set(0, 0.005, (CABIN_BACK + CABIN_FRONT) / 2);
  scene.add(carpet);

  // Windows + overhead bins + cabin lights
  const winMat = new THREE.MeshBasicMaterial({ color: 0x87b8e8 });
  const binMat = new THREE.MeshStandardMaterial({ color: 0xbfc6d2, roughness: 0.7 });
  for (const side of [-1, 1]) {
    const bin = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.5, CABIN_BACK - CABIN_FRONT), binMat);
    bin.position.set(side * 1.9, 2.45, (CABIN_BACK + CABIN_FRONT) / 2);
    bin.rotation.z = side * 0.35;
    scene.add(bin);
    for (let r = 0; r < ROWS; r++) {
      const w = new THREE.Mesh(new THREE.CircleGeometry(0.18, 12), winMat);
      w.position.set(side * 2.92, 1.55, rowZ(r));
      w.rotation.y = side * -Math.PI / 2;
      w.scale.y = 1.4;
      scene.add(w);
    }
  }
  const stripMat = new THREE.MeshBasicMaterial({ color: 0xfff7e0 });
  for (let z = CABIN_FRONT + 2; z < CABIN_BACK; z += 4) {
    const s = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 1.6), stripMat);
    s.position.set(0, 2.78, z);
    s.rotation.x = Math.PI / 2;
    scene.add(s);
  }

  // Rear galley wall + front bulkhead around the door
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xcdd3dd });
  const back = new THREE.Mesh(new THREE.BoxGeometry(6.4, 3.4, 0.2), wallMat);
  back.position.set(0, 1.5, CABIN_BACK + 0.1);
  scene.add(back);
  box(-3.2, 3.2, CABIN_BACK, CABIN_BACK + 1);
  for (const side of [-1, 1]) {
    const bh = new THREE.Mesh(new THREE.BoxGeometry(2.4, 3.4, 0.2), wallMat);
    bh.position.set(side * 1.75, 1.5, CABIN_FRONT);
    scene.add(bh);
    box(side === -1 ? -3.2 : 0.55, side === -1 ? -0.55 : 3.2, CABIN_FRONT - 0.15, CABIN_FRONT + 0.15);
  }
  // EXIT sign over the door
  const cnv = document.createElement('canvas'); cnv.width = 256; cnv.height = 64;
  const c2 = cnv.getContext('2d');
  c2.fillStyle = '#13315c'; c2.fillRect(0, 0, 256, 64);
  c2.fillStyle = '#9ce2ff'; c2.font = 'bold 34px sans-serif'; c2.textAlign = 'center';
  c2.fillText('COCKPIT', 128, 44);
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.3), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cnv) }));
  sign.position.set(0, 2.55, CABIN_FRONT + 0.02);
  scene.add(sign);
}

// ---- Cockpit (behind the door) ---------------------------------------------
{
  const dash = new THREE.Mesh(new THREE.BoxGeometry(4, 1, 1), new THREE.MeshStandardMaterial({ color: 0x222833 }));
  dash.position.set(0, 0.9, COCKPIT_BACK + 0.7);
  scene.add(dash);
  box(-2, 2, COCKPIT_BACK, COCKPIT_BACK + 1.3);
  const screenMat = new THREE.MeshBasicMaterial({ color: 0x2bd96a });
  for (let i = -1; i <= 1; i++) {
    const s = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.35), screenMat);
    s.position.set(i * 0.9, 1.25, COCKPIT_BACK + 1.22);
    scene.add(s);
  }
  const seatMat = new THREE.MeshStandardMaterial({ color: 0x4a2c1a });
  for (const x of [-0.8, 0.8]) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.2, 0.7), seatMat);
    s.position.set(x, 0.6, COCKPIT_BACK + 2);
    scene.add(s);
    box(x - 0.35, x + 0.35, COCKPIT_BACK + 1.65, COCKPIT_BACK + 2.35);
  }
  // windshield
  const ws = new THREE.Mesh(new THREE.PlaneGeometry(4.5, 1.4), new THREE.MeshBasicMaterial({ color: 0x0c1f3d }));
  ws.position.set(0, 1.9, COCKPIT_BACK + 0.05);
  scene.add(ws);
}

// ---- Cockpit door (collider removed when opened) ----------------------------
const doorGroup = new THREE.Group();
const doorMesh = new THREE.Mesh(new THREE.BoxGeometry(1.1, 2.5, 0.12),
  new THREE.MeshStandardMaterial({ color: 0x9aa3b0, roughness: 0.5 }));
doorMesh.position.y = 1.25;
const handle = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.06, 0.06),
  new THREE.MeshStandardMaterial({ color: 0x333a45, metalness: 0.8 }));
handle.position.set(0.35, 1.05, 0.1);
doorGroup.add(doorMesh, handle);
doorGroup.position.set(0, 0, CABIN_FRONT);
scene.add(doorGroup);
const doorCollider = { minX: -0.6, maxX: 0.6, minZ: CABIN_FRONT - 0.15, maxZ: CABIN_FRONT + 0.15 };
colliders.push(doorCollider);
let doorOpen = false, doorRattleT = 0;
function openDoor() {
  doorOpen = true;
  const i = colliders.indexOf(doorCollider);
  if (i >= 0) colliders.splice(i, 1);
  doorGroup.rotation.y = -1.9; // swings into the cockpit
  doorGroup.position.x = -0.55;
}

// ---- Seats ------------------------------------------------------------------
const seatGeoBase = new THREE.BoxGeometry(0.62, 0.45, 0.6);
const seatGeoBack = new THREE.BoxGeometry(0.62, 0.85, 0.16);
const seatMat = new THREE.MeshStandardMaterial({ color: 0x27497a, roughness: 0.9 });
const seatMatAlt = new THREE.MeshStandardMaterial({ color: 0x2d5a8e, roughness: 0.9 });
for (let r = 0; r < ROWS; r++) {
  for (const x of SEAT_XS) {
    const m = (r + SEAT_XS.indexOf(x)) % 2 ? seatMat : seatMatAlt;
    const base = new THREE.Mesh(seatGeoBase, m);
    base.position.set(x, 0.28, rowZ(r));
    const bk = new THREE.Mesh(seatGeoBack, m);
    bk.position.set(x, 0.85, rowZ(r) + 0.28);
    scene.add(base, bk);
  }
  // one collider per seat bank per row (players walk the aisle + row gaps)
  box(-2.55, -0.5, rowZ(r) - 0.32, rowZ(r) + 0.38);
  box(0.5, 2.55, rowZ(r) - 0.32, rowZ(r) + 0.38);
}

// ===========================================================================
// People builders
// ===========================================================================
function makeNameTag(text, color = '#fff') {
  const cnv = document.createElement('canvas'); cnv.width = 256; cnv.height = 64;
  const c = cnv.getContext('2d');
  c.font = 'bold 30px sans-serif'; c.textAlign = 'center';
  c.fillStyle = 'rgba(0,0,0,0.45)';
  const w = c.measureText(text).width + 24;
  c.beginPath(); c.roundRect(128 - w / 2, 10, w, 44, 10); c.fill();
  c.fillStyle = color; c.fillText(text, 128, 42);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cnv), depthTest: false }));
  sp.scale.set(1.7, 0.42, 1);
  return sp;
}

function makePerson(color, name, opts = {}) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.55, 4, 10),
    new THREE.MeshStandardMaterial({ color, roughness: 0.85 }));
  body.position.y = 0.85;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 10),
    new THREE.MeshStandardMaterial({ color: 0xe8b990, roughness: 0.9 }));
  head.position.y = 1.42;
  g.add(body, head);
  // Everyone wears sandals.
  const sandalMat = new THREE.MeshStandardMaterial({ color: 0x7a5230, roughness: 1 });
  for (const sx of [-0.11, 0.11]) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.05, 0.3), sandalMat);
    s.position.set(sx, 0.03, 0.03);
    g.add(s);
  }
  if (name) {
    const tag = makeNameTag(name);
    tag.position.y = 1.85;
    g.add(tag);
  }
  // Badge shown after sandals are verified clean
  const badge = makeNameTag('🩴 clean', '#7dffa8');
  badge.scale.set(1.1, 0.3, 1);
  badge.position.y = 2.12;
  badge.visible = false;
  g.add(badge);
  g.userData = { body, head, badge, seatedPose: false };
  return g;
}

function setPose(g, seated) {
  if (g.userData.seatedPose === seated) return;
  g.userData.seatedPose = seated;
  g.userData.body.position.y = seated ? 0.55 : 0.85;
  g.userData.head.position.y = seated ? 1.1 : 1.42;
  g.userData.body.scale.y = seated ? 0.72 : 1;
}

// ---- NPC passengers (decoys — outer & inner seats; players get the ±1.5 seats)
const NPC_COLORS = [0x8d6e63, 0x78909c, 0x6d8b74, 0xa1887f, 0x607d8b, 0x9575cd, 0xbcaaa4, 0x4db6ac];
const NPC_NAMES = ['Gary', 'Linda', 'Trevor', 'Pam', 'Dale', 'Ruth', 'Kevin', 'Marge', 'Stan', 'Carol', 'Bert', 'Nadine'];
let npcSeed = 0;
for (let r = 0; r < ROWS; r++) {
  for (const x of [-2.2, -0.8, 0.8, 2.2]) {
    if (Math.sin(r * 7.13 + x * 3.7) > -0.35) {
      const npc = makePerson(NPC_COLORS[npcSeed % NPC_COLORS.length], NPC_NAMES[npcSeed % NPC_NAMES.length]);
      npcSeed++;
      npc.position.set(x, 0, rowZ(r));
      npc.rotation.y = Math.PI; // face forward (toward -z)
      setPose(npc, true);
      scene.add(npc);
    }
  }
}

// ---- Flight attendants with carts -------------------------------------------
const attendantObjs = [];
for (const name of ['Brenda', 'Doug']) {
  const g = makePerson(0xf2f4f7, name + ' ✈');
  scene.add(g);
  const cart = new THREE.Group();
  const cbody = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.9, 0.85),
    new THREE.MeshStandardMaterial({ color: 0xb9c0cb, metalness: 0.5, roughness: 0.4 }));
  cbody.position.y = 0.45;
  cart.add(cbody);
  for (let i = 0; i < 5; i++) {
    const can = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.12, 8),
      new THREE.MeshStandardMaterial({ color: i % 2 ? 0xd22b2b : 0x2bd96a }));
    can.position.set((i % 3 - 1) * 0.15, 0.96, (Math.floor(i / 3) - 0.5) * 0.3);
    cart.add(can);
  }
  const peanuts = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.1, 0.2),
    new THREE.MeshStandardMaterial({ color: 0xe8c468 }));
  peanuts.position.set(0, 0.95, 0.25);
  cart.add(peanuts);
  scene.add(cart);
  const collider = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  colliders.push(collider);
  attendantObjs.push({ g, cart, collider, z: 0, dir: 1 });
}

// ===========================================================================
// Networking + player state
// ===========================================================================
const socket = io();
let myId = null, isEvil = false, phase = 'lobby', hostId = null, endsAt = 0;
let mySeat = null, seated = true, stunnedUntil = 0;
const remotes = new Map();   // id -> {g, name, target:{pos,ry,seated}, shownUntil}
const playerInfo = new Map(); // id -> {name, color}

const me = { x: 0, z: 0, ry: 0 };
let yaw = 0, pitch = 0;
let inspecting = null;       // {targetId, until}
let beingInspectedBy = null;
let lockpicking = false, lockpickProgress = 0;

function addRemote(p) {
  if (p.id === myId || remotes.has(p.id)) return;
  playerInfo.set(p.id, { name: p.name, color: p.color });
  const g = makePerson(p.color, p.name);
  g.position.set(p.pos.x, 0, p.pos.z);
  setPose(g, p.seated);
  scene.add(g);
  remotes.set(p.id, { g, name: p.name, target: { ...p.pos, ry: p.ry, seated: p.seated }, shownUntil: 0 });
}
function removeRemote(id) {
  const r = remotes.get(id);
  if (r) { scene.remove(r.g); remotes.delete(id); }
  playerInfo.delete(id);
}

// ---- Join / lobby -----------------------------------------------------------
$('joinBtn').onclick = () => {
  const name = $('nameInput').value.trim() || 'Passenger';
  socket.emit('join', { name });
  $('joinScreen').style.display = 'none';
  $('lobbyScreen').style.display = 'flex';
};
$('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });
$('startBtn').onclick = () => socket.emit('startGame');

socket.on('init', (d) => {
  myId = d.id; phase = d.phase; hostId = d.hostId; endsAt = d.endsAt;
  mySeat = d.seat;
  me.x = mySeat.x; me.z = rowZ(mySeat.row);
  yaw = Math.PI; // face the front of the plane
  if (d.doorOpen) openDoor();
  for (const p of d.players) addRemote(p);
  if (phase === 'playing') enterGame();
});
socket.on('lobby', (d) => {
  hostId = d.hostId;
  if (phase !== 'lobby' && d.phase === 'lobby') { // round reset
    phase = 'lobby';
    $('gameOverScreen').style.display = 'none';
    $('lobbyScreen').style.display = 'flex';
    $('roleCard').style.display = 'none';
    isEvil = false; seated = true;
    me.x = mySeat.x; me.z = rowZ(mySeat.row);
    if (doorOpen) { doorOpen = false; doorGroup.rotation.y = 0; doorGroup.position.x = 0; colliders.push(doorCollider); }
    lockpickProgress = 0; lockpicking = false;
    setProgress(null);
  }
  $('lobbyList').innerHTML = d.players.map(p =>
    `<span style="color:#${p.color.toString(16).padStart(6, '0')}">●</span> ${p.name}${p.id === d.hostId ? ' (host)' : ''}`
  ).join('<br>');
  const amHost = myId === d.hostId;
  $('startBtn').style.display = amHost ? 'block' : 'none';
  $('lobbyWait').style.display = amHost ? 'none' : 'block';
});
socket.on('playerJoined', (p) => { addRemote(p); feed(`${p.name} boarded the plane.`); });
socket.on('playerLeft', ({ id }) => removeRemote(id));

socket.on('role', ({ evil }) => {
  isEvil = evil;
  const rc = $('roleCard');
  rc.style.display = 'block';
  rc.className = evil ? 'evil' : 'crew';
  rc.innerHTML = evil
    ? '🔪 YOU ARE THE EVIL — there is a knife in your sandal. Open the cockpit door (hold E), get inside, pull the knife (Q).'
    : '🩴 PASSENGER — someone on board has a knife in their sandal. Inspect sandals (F) before they reach the cockpit.';
});
socket.on('gameStarted', (d) => {
  endsAt = d.endsAt; phase = 'playing';
  seated = true;
  me.x = mySeat.x; me.z = rowZ(mySeat.row);
  for (const p of d.players) {
    const r = remotes.get(p.id);
    if (r) { r.target = { ...p.pos, ry: p.ry, seated: p.seated }; setPose(r.g, true); r.g.userData.badge.visible = false; }
  }
  enterGame();
  feed('The seatbelt sign is off. Welcome aboard.', 'serve');
});
function enterGame() {
  $('lobbyScreen').style.display = 'none';
  $('gameOverScreen').style.display = 'none';
  renderer.domElement.requestPointerLock();
}

socket.on('snap', (d) => {
  for (const p of d.players) {
    if (p.id === myId) continue;
    const r = remotes.get(p.id);
    if (r) r.target = { x: p.pos.x, z: p.pos.z, ry: p.ry, seated: p.seated };
  }
  for (let i = 0; i < d.attendants.length; i++) {
    const a = attendantObjs[i], s = d.attendants[i];
    a.z = s.z; a.dir = s.dir;
  }
  if (d.doorOpen && !doorOpen) openDoor();
});

// ---- Game events --------------------------------------------------------------
socket.on('msg', (m) => feed(m.text, m.kind));
socket.on('serve', (s) => {
  const row = Math.max(1, Math.round((s.z + 20) / 2.2) + 1);
  feed(`${s.name} (row ${row}): “${s.text}”`, 'serve');
});
socket.on('clink', (c) => {
  const row = Math.max(1, Math.round((c.z + 20) / 2.2) + 1);
  feed(`You hear a faint metallic *clink* near row ${row}...`, 'sus');
  blip(2200, 0.06, 0.12);
});
socket.on('doorRattle', () => {
  doorRattleT = 0.5;
  blip(180, 0.15, 0.1);
  if (!socket._lastRattleFeed || Date.now() - socket._lastRattleFeed > 6000) {
    socket._lastRattleFeed = Date.now();
    feed('The cockpit door handle is rattling...', 'sus');
  }
});
socket.on('doorOpened', () => {
  openDoor();
  feed('THE COCKPIT DOOR IS OPEN!', 'alert');
  blip(90, 0.4, 0.2);
});
socket.on('lockpickProgress', ({ progress }) => {
  lockpickProgress = progress;
  if (lockpicking) setProgress('Picking the cockpit lock...', progress);
});
socket.on('inspectStarted', ({ inspectorId, targetId, durationMs }) => {
  if (inspectorId === myId) inspecting = { targetId, until: Date.now() + durationMs, durationMs };
  if (targetId === myId) {
    beingInspectedBy = inspectorId;
    const n = playerInfo.get(inspectorId)?.name || 'Someone';
    feed(`${n} is inspecting YOUR sandals! (move to pull away — looks suspicious)`, 'sus');
  }
});
socket.on('inspectCancelled', ({ inspectorId, targetId }) => {
  if (inspectorId === myId) { inspecting = null; setProgress(null); }
  if (targetId === myId) beingInspectedBy = null;
});
socket.on('inspectResult', ({ inspectorId, targetId, clean, stunMs }) => {
  if (inspectorId === myId) {
    inspecting = null; setProgress(null);
    if (clean) {
      stunnedUntil = Date.now() + stunMs;
      $('stunOverlay').style.display = 'flex';
      setTimeout(() => $('stunOverlay').style.display = 'none', stunMs);
    }
  }
  if (targetId === myId) beingInspectedBy = null;
  const r = remotes.get(targetId);
  if (r && clean) { r.g.userData.badge.visible = true; }
});
socket.on('sandalsShown', ({ id, name }) => {
  feed(`${name} shows everyone their sandals. Clean. 🩴`);
  const r = remotes.get(id);
  if (r) r.g.userData.badge.visible = true;
});
socket.on('knifePulled', () => blip(60, 0.8, 0.3));
socket.on('gameOver', ({ winner, reason, evilName }) => {
  phase = 'over';
  document.exitPointerLock();
  setPrompt(null); setProgress(null);
  inspecting = null; lockpicking = false;
  $('gameOverScreen').style.display = 'flex';
  const t = $('goTitle');
  if (winner === 'evil') { t.textContent = 'THE EVIL WINS'; t.style.color = '#ff5a5a'; }
  else { t.textContent = 'CREW WINS'; t.style.color = '#7dffa8'; }
  $('goReason').textContent = `${reason} The Evil was ${evilName}.`;
});

// ---- Chat ---------------------------------------------------------------------
const chatInput = $('chatInput');
let chatOpen = false;
socket.on('chat', (m) => {
  const d = document.createElement('div');
  d.innerHTML = `<b style="color:#${m.color.toString(16).padStart(6, '0')}">${m.name}:</b> `;
  d.append(m.text);
  $('chatLog').appendChild(d);
  $('chatLog').scrollTop = 1e6;
  while ($('chatLog').children.length > 30) $('chatLog').firstChild.remove();
});

// ===========================================================================
// Input
// ===========================================================================
const keys = {};
addEventListener('keydown', (e) => {
  if (chatOpen) {
    if (e.key === 'Enter') {
      if (chatInput.value.trim()) socket.emit('chat', { text: chatInput.value.trim() });
      chatInput.value = '';
      closeChat();
    } else if (e.key === 'Escape') closeChat();
    return;
  }
  keys[e.code] = true;
  if (e.code === 'Enter') { openChat(); e.preventDefault(); }
  if (phase !== 'playing' || Date.now() < stunnedUntil) return;
  if (e.code === 'KeyF') tryInspect();
  if (e.code === 'KeyG' && !seated) socket.emit('showSandals');
  if (e.code === 'KeyQ') socket.emit('pullKnife');
  if (e.code === 'KeyE') onUse();
});
addEventListener('keyup', (e) => {
  keys[e.code] = false;
  if (e.code === 'KeyE' && lockpicking) stopLockpick();
});
function openChat() { chatOpen = true; chatInput.style.display = 'block'; document.exitPointerLock(); chatInput.focus(); }
function closeChat() { chatOpen = false; chatInput.style.display = 'none'; chatInput.blur(); if (phase === 'playing') renderer.domElement.requestPointerLock(); }

renderer.domElement.addEventListener('click', () => {
  if (phase === 'playing' && !chatOpen) renderer.domElement.requestPointerLock();
});
addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== renderer.domElement) return;
  yaw -= e.movementX * 0.0023;
  pitch = Math.max(-1.45, Math.min(1.45, pitch - e.movementY * 0.0023));
});

function nearMySeat() {
  return Math.abs(me.x - mySeat.x) < 0.9 && Math.abs(me.z - rowZ(mySeat.row)) < 0.9;
}
function inDoorZone() {
  return Math.abs(me.x) < 1.2 && Math.abs(me.z - DOOR_ZONE.z) < DOOR_ZONE.radius;
}
function onUse() {
  if (seated) { seated = false; me.x = mySeat.x > 0 ? 0.2 : -0.2; me.z = rowZ(mySeat.row) + 0.85; return; }
  if (nearMySeat()) { seated = true; me.x = mySeat.x; me.z = rowZ(mySeat.row); yaw = Math.PI; return; }
  if (!doorOpen && inDoorZone()) {
    lockpicking = true;
    socket.emit('lockpick', { active: true });
    if (isEvil) setProgress('Picking the cockpit lock...', lockpickProgress);
  }
}
function stopLockpick() {
  lockpicking = false;
  socket.emit('lockpick', { active: false });
  setProgress(null);
}

function nearestStandingPlayer() {
  let best = null, bd = INSPECT_RANGE;
  for (const [id, r] of remotes) {
    if (r.target.seated) continue;
    const d = Math.hypot(r.g.position.x - me.x, r.g.position.z - me.z);
    if (d < bd) { bd = d; best = id; }
  }
  return best;
}
function tryInspect() {
  if (inspecting || seated) return;
  const id = nearestStandingPlayer();
  if (id) socket.emit('inspectStart', { targetId: id });
  else feed('No one standing close enough to inspect.', 'err');
}

// ===========================================================================
// Movement & collision
// ===========================================================================
function collide(x, z) {
  for (const c of colliders) {
    const cx = Math.max(c.minX, Math.min(x, c.maxX));
    const cz = Math.max(c.minZ, Math.min(z, c.maxZ));
    const dx = x - cx, dz = z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 < RADIUS * RADIUS) {
      if (d2 > 1e-6) {
        const d = Math.sqrt(d2);
        x = cx + (dx / d) * RADIUS;
        z = cz + (dz / d) * RADIUS;
      } else {
        z = c.maxZ + RADIUS; // degenerate: push back
      }
    }
  }
  x = Math.max(-2.55, Math.min(2.55, x));
  z = Math.max(COCKPIT_BACK + 0.4, Math.min(CABIN_BACK - 0.4, z));
  return [x, z];
}

// ===========================================================================
// Main loop
// ===========================================================================
let lastSend = 0, lastT = performance.now();
function loop(t) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (t - lastT) / 1000);
  lastT = t;

  const playing = phase === 'playing';
  const stunned = Date.now() < stunnedUntil;

  if (playing && !seated && !chatOpen && !stunned) {
    const sprint = keys['ShiftLeft'] || keys['ShiftRight'];
    const sp = (sprint ? SPRINT : WALK) * dt;
    let mx = 0, mz = 0;
    if (keys['KeyW']) { mx -= Math.sin(yaw); mz -= Math.cos(yaw); }
    if (keys['KeyS']) { mx += Math.sin(yaw); mz += Math.cos(yaw); }
    if (keys['KeyA']) { mx -= Math.cos(yaw); mz += Math.sin(yaw); }
    if (keys['KeyD']) { mx += Math.cos(yaw); mz -= Math.sin(yaw); }
    const l = Math.hypot(mx, mz);
    if (l > 0) {
      [me.x, me.z] = collide(me.x + (mx / l) * sp, me.z + (mz / l) * sp);
      if (lockpicking && !inDoorZone()) stopLockpick();
    }
  }

  // Camera
  camera.position.set(me.x, seated ? EYE_SEATED : EYE, me.z);
  camera.rotation.set(0, 0, 0);
  camera.rotateY(yaw);
  camera.rotateX(pitch);
  me.ry = yaw;

  // Remote players: interpolate
  for (const r of remotes.values()) {
    const g = r.g, tg = r.target;
    g.position.x += (tg.x - g.position.x) * Math.min(1, dt * 12);
    g.position.z += (tg.z - g.position.z) * Math.min(1, dt * 12);
    let dr = tg.ry - g.rotation.y;
    dr = ((dr + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    g.rotation.y += dr * Math.min(1, dt * 10);
    setPose(g, tg.seated);
  }

  // Attendants + carts (cart rolls ahead of the attendant; collider follows)
  for (const a of attendantObjs) {
    a.g.position.set(0, 0, a.z);
    a.g.rotation.y = a.dir > 0 ? 0 : Math.PI;
    const cz = a.z + a.dir * 0.85;
    a.cart.position.set(0, 0, cz);
    a.collider.minX = -0.34; a.collider.maxX = 0.34;
    a.collider.minZ = cz - 0.5; a.collider.maxZ = cz + 0.5;
  }

  // Door rattle shake
  if (doorRattleT > 0 && !doorOpen) {
    doorRattleT -= dt;
    doorGroup.position.x = Math.sin(t * 0.06) * 0.012;
    if (doorRattleT <= 0) doorGroup.position.x = 0;
  }

  // Contextual prompt
  if (playing && !chatOpen) {
    if (stunned) setPrompt(null);
    else if (seated) setPrompt('<b>E</b> stand up');
    else if (!doorOpen && inDoorZone() && !lockpicking)
      setPrompt(isEvil ? '<b>Hold E</b> pick the cockpit lock' : '<b>E</b> try the cockpit door (locked)');
    else if (doorOpen && me.z < CABIN_FRONT && isEvil) setPrompt('<b>Q</b> pull the knife from your sandal');
    else if (nearMySeat()) setPrompt('<b>E</b> sit down');
    else {
      const id = nearestStandingPlayer();
      if (id && !inspecting) {
        const n = playerInfo.get(id)?.name || '?';
        setPrompt(`<b>F</b> inspect ${n}'s sandals · <b>G</b> show yours`);
      } else if (!inspecting) setPrompt(null);
    }
    if (inspecting) {
      const left = inspecting.until - Date.now();
      const n = playerInfo.get(inspecting.targetId)?.name || '?';
      setProgress(`Inspecting ${n}'s sandals... (don't move)`, 1 - left / inspecting.durationMs);
    }
  }

  // Timer
  if (playing && endsAt) {
    const s = Math.max(0, Math.floor((endsAt - Date.now()) / 1000));
    $('timer').textContent = `🛬 ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  } else $('timer').textContent = '';

  // Network send
  if (playing && t - lastSend > 50) {
    lastSend = t;
    socket.emit('move', { pos: { x: me.x, z: me.z }, ry: yaw, seated });
  }

  renderer.render(scene, camera);
}
requestAnimationFrame(loop);
