import * as THREE from 'three';
import { joinRoom, selfId } from './vendor/trystero-nostr.js';
import { HostLogic, C, L, npcSeatList, rowOfZ } from './logic.js';

// ===========================================================================
// Constants (layout comes from logic.js so host AI and renderer agree)
// ===========================================================================
const ROWS = L.ROWS;
const rowZ = (r) => L.ROW0_Z + r * L.ROW_DZ;
const CABIN_FRONT = L.CABIN_FRONT, CABIN_BACK = L.CABIN_BACK, COCKPIT_BACK = L.COCKPIT_BACK;
const EYE = 1.55, EYE_SEATED = 1.05;
const WALK = 2.3, SPRINT = 4.2, RADIUS = 0.32;
const PIXEL = 4; // render at 1/4 resolution for chunky pixels

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

let actx;
function audio() {
  if (!actx) {
    actx = new AudioContext();
    startMusic();
    startAmbience();
  }
  if (actx.state === 'suspended') actx.resume();
  return actx;
}

// --- Elevator music: soft piano loop, generated live (no audio files) ------
let musicGain = null, musicOn = true, musicNextBar = 0, musicStep = 0;
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
// Cmaj7 → Am7 → Dm7 → G7, the eternal lobby loop
const PROG = [
  { bass: 36, chord: [60, 64, 67, 71] },
  { bass: 33, chord: [57, 60, 64, 67] },
  { bass: 38, chord: [57, 62, 65, 69] },
  { bass: 31, chord: [59, 62, 65, 67] },
];
const ARP = [0, 2, 1, 3, 2, 1]; // gentle broken-chord pattern
function pianoNote(t, note, dur, vel) {
  const g = actx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.2 * vel, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  // a few decaying harmonics ≈ a tired hotel-lobby piano
  for (const [mult, amp] of [[1, 1], [2, 0.35], [3, 0.12], [4.01, 0.05]]) {
    const o = actx.createOscillator();
    o.type = 'sine';
    o.frequency.value = midi(note) * mult;
    const og = actx.createGain();
    og.gain.value = amp;
    o.connect(og).connect(g);
    o.start(t);
    o.stop(t + dur + 0.1);
  }
  g.connect(musicGain);
}
function startMusic() {
  if (musicGain) return;
  const lp = actx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 2200;
  musicGain = actx.createGain();
  musicGain.gain.value = musicOn ? 0.32 : 0;
  musicGain.connect(lp).connect(actx.destination);
  musicNextBar = actx.currentTime + 0.1;
  setInterval(() => {
    // schedule a bar ahead of time so timers can be sloppy
    while (musicNextBar < actx.currentTime + 1.5) {
      const bar = PROG[musicStep % PROG.length];
      const t = musicNextBar, barLen = 2.4, n = ARP.length, sw = barLen / n;
      pianoNote(t, bar.bass, barLen, 0.5);
      pianoNote(t, bar.bass + 12, barLen, 0.25);
      for (let i = 0; i < n; i++) {
        const jitter = Math.random() * 0.02;
        pianoNote(t + i * sw + jitter, bar.chord[ARP[i]], sw * 1.8, 0.32 + Math.random() * 0.1);
      }
      // occasional sleepy grace note up top
      if (Math.random() < 0.25) pianoNote(t + barLen * 0.75, bar.chord[3] + 12, 1.2, 0.15);
      musicNextBar += barLen;
      musicStep++;
    }
  }, 400);
}
function toggleMusic() {
  musicOn = !musicOn;
  if (musicGain) musicGain.gain.linearRampToValueAtTime(musicOn ? 0.32 : 0, actx.currentTime + 0.3);
  feed(musicOn ? 'Cabin music on.' : 'Cabin music off.', 'serve');
}

// --- Cabin ambience: hum, murmured chatter, glass clinks, chimes, coughs ----
// All generated live with WebAudio — the goal is the *inside* of a red-eye:
// low pressurized rumble, unintelligible conversations, ice in plastic cups.
let ambGain = null;
function noiseBuffer(seconds) {
  const len = Math.floor(actx.sampleRate * seconds);
  const buf = actx.createBuffer(1, len, actx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) { // brown-ish noise
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    d[i] = last * 3.5;
  }
  return buf;
}
function panTo(pan) {
  const p = actx.createStereoPanner ? actx.createStereoPanner() : actx.createGain();
  if (p.pan) p.pan.value = pan;
  p.connect(ambGain);
  return p;
}
function startAmbience() {
  if (ambGain) return;
  ambGain = actx.createGain();
  ambGain.gain.value = 1;
  ambGain.connect(actx.destination);
  // 1) cabin hum — constant pressurized rumble
  const hum = actx.createBufferSource();
  hum.buffer = noiseBuffer(3);
  hum.loop = true;
  const hlp = actx.createBiquadFilter(); hlp.type = 'lowpass'; hlp.frequency.value = 220;
  const hg = actx.createGain(); hg.gain.value = 0.4;
  hum.connect(hlp).connect(hg).connect(ambGain);
  hum.start();
  // 2) five murmuring "voices" scattered around the cabin, taking turns
  for (let v = 0; v < 5; v++) loopTimer(() => murmur(v), 1500, 6500);
  // 3) drinks, chimes, coughs
  loopTimer(glassClink, 4000, 12000);
  loopTimer(seatbeltChime, 70000, 120000);
  loopTimer(cough, 14000, 30000);
}
function loopTimer(fn, min, spread) {
  const go = () => { try { fn(); } catch {} setTimeout(go, min + Math.random() * spread); };
  setTimeout(go, Math.random() * spread);
}
function murmur(v) {
  const t0 = actx.currentTime;
  const female = v % 2 === 1;
  const f0 = female ? 165 + Math.random() * 60 : 95 + Math.random() * 40;
  const pan = panTo((Math.random() * 2 - 1) * 0.8);
  const lp = actx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 850; // muffled, unintelligible
  const bp = actx.createBiquadFilter(); bp.type = 'bandpass';
  bp.frequency.value = female ? 750 : 520; bp.Q.value = 0.7;
  const master = actx.createGain(); master.gain.value = 0.045 + Math.random() * 0.035;
  master.connect(bp).connect(lp).connect(pan);
  let t = t0;
  const syllables = 3 + Math.floor(Math.random() * 8);
  for (let i = 0; i < syllables; i++) {
    const dur = 0.1 + Math.random() * 0.16;
    const o = actx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f0 * (0.92 + Math.random() * 0.25), t);
    o.frequency.linearRampToValueAtTime(f0 * (0.85 + Math.random() * 0.3), t + dur);
    const g = actx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(1, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(master);
    o.start(t); o.stop(t + dur + 0.05);
    t += dur + 0.02 + Math.random() * 0.09;
  }
}
function glassClink() {
  const t0 = actx.currentTime;
  const pan = panTo((Math.random() * 2 - 1) * 0.7);
  const hits = 1 + Math.floor(Math.random() * 2);
  for (let i = 0; i < hits; i++) {
    const o = actx.createOscillator();
    o.type = 'sine';
    o.frequency.value = 1800 + Math.random() * 1500;
    const g = actx.createGain();
    const t = t0 + i * (0.07 + Math.random() * 0.12);
    g.gain.setValueAtTime(0.05, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    o.connect(g).connect(pan);
    o.start(t); o.stop(t + 0.3);
  }
}
function seatbeltChime() {
  const t0 = actx.currentTime;
  for (const [note, at] of [[988, 0], [784, 0.4]]) { // the classic bing-bong
    const o = actx.createOscillator(); o.type = 'sine'; o.frequency.value = note;
    const g = actx.createGain();
    g.gain.setValueAtTime(0.07, t0 + at);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 1.3);
    o.connect(g).connect(ambGain);
    o.start(t0 + at); o.stop(t0 + at + 1.4);
  }
}
function cough() {
  const t0 = actx.currentTime;
  const pan = panTo((Math.random() * 2 - 1) * 0.8);
  const lp = actx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 650;
  lp.connect(pan);
  const bursts = 1 + Math.floor(Math.random() * 2);
  for (let i = 0; i < bursts; i++) {
    const src = actx.createBufferSource();
    src.buffer = noiseBuffer(0.2);
    const g = actx.createGain();
    const t = t0 + i * 0.27;
    g.gain.setValueAtTime(0.1, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    src.connect(g).connect(lp);
    src.start(t);
  }
}

function blip(freq, dur = 0.08, gain = 0.15) {
  try {
    audio();
    const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = freq; o.type = 'square';
    g.gain.setValueAtTime(gain, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + dur);
    o.connect(g).connect(actx.destination);
    o.start(); o.stop(actx.currentTime + dur);
  } catch {}
}

// ===========================================================================
// Renderer — low internal resolution, upscaled with nearest-neighbor
// ===========================================================================
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0e16);
const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.05, 120);
const renderer = new THREE.WebGLRenderer({ canvas: $('game'), antialias: false });
renderer.setPixelRatio(1);
function resize() {
  renderer.setSize(Math.max(2, Math.floor(innerWidth / PIXEL)), Math.max(2, Math.floor(innerHeight / PIXEL)), false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
resize();
addEventListener('resize', resize);

scene.add(new THREE.HemisphereLight(0xeef3ff, 0x30343f, 1.0));
const sun = new THREE.DirectionalLight(0xfff3df, 0.5);
sun.position.set(3, 6, 2);
scene.add(sun);

const colliders = [];
const box = (minX, maxX, minZ, maxZ) => colliders.push({ minX, maxX, minZ, maxZ });
const circle = (cx, cz, r) => { const c = { cx, cz, r }; colliders.push(c); return c; };

// ---- Wide-body fuselage (twin aisle, 3-4-3) -----------------------------------
{
  const len = CABIN_BACK - COCKPIT_BACK + 4;
  const midZ = (CABIN_BACK + COCKPIT_BACK) / 2;
  const tube = new THREE.Mesh(
    new THREE.CylinderGeometry(5.3, 5.3, len, 18, 1, true),
    new THREE.MeshStandardMaterial({ color: 0xd8dde6, side: THREE.BackSide, roughness: 0.9, flatShading: true })
  );
  tube.rotation.x = Math.PI / 2;
  tube.position.set(0, 1.6, midZ);
  scene.add(tube);

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(10.4, len),
    new THREE.MeshStandardMaterial({ color: 0x2e3340, roughness: 0.95 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0.001, midZ);
  scene.add(floor);

  // Twin aisle carpets + cross-walkway + galley bands
  const carpetMat = new THREE.MeshStandardMaterial({ color: 0x44506e, roughness: 1 });
  for (const side of [-1, 1]) {
    const carpet = new THREE.Mesh(new THREE.PlaneGeometry(1.1, CABIN_BACK - CABIN_FRONT), carpetMat);
    carpet.rotation.x = -Math.PI / 2;
    carpet.position.set(side * L.AISLE_X, 0.005, (CABIN_BACK + CABIN_FRONT) / 2);
    scene.add(carpet);
  }
  for (const [cz, depth] of [[L.CROSS_Z, 3.2], [CABIN_FRONT + 1.7, 3.0], [CABIN_BACK - 1.7, 3.0]]) {
    const band = new THREE.Mesh(new THREE.PlaneGeometry(9.4, depth), carpetMat);
    band.rotation.x = -Math.PI / 2;
    band.position.set(0, 0.004, cz);
    scene.add(band);
  }

  // Windows, side bins, center bins, cabin lights
  const winMat = new THREE.MeshBasicMaterial({ color: 0x87b8e8 });
  const binMat = new THREE.MeshStandardMaterial({ color: 0xbfc6d2, roughness: 0.7, flatShading: true });
  for (const side of [-1, 1]) {
    const bin = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, CABIN_BACK - CABIN_FRONT), binMat);
    bin.position.set(side * 3.6, 2.7, (CABIN_BACK + CABIN_FRONT) / 2);
    bin.rotation.z = side * 0.3;
    scene.add(bin);
    for (let r = 0; r < ROWS; r++) {
      const w = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.5), winMat);
      w.position.set(side * 5.0, 1.7, rowZ(r));
      w.rotation.y = side * -Math.PI / 2;
      scene.add(w);
    }
  }
  const cbin = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.5, CABIN_BACK - CABIN_FRONT), binMat);
  cbin.position.set(0, 3.05, (CABIN_BACK + CABIN_FRONT) / 2);
  scene.add(cbin);
  const stripMat = new THREE.MeshBasicMaterial({ color: 0xfff7e0 });
  for (let z = CABIN_FRONT + 2; z < CABIN_BACK; z += 4) {
    for (const side of [-1, 1]) {
      const s = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 1.6), stripMat);
      s.position.set(side * L.AISLE_X, 3.0, z);
      s.rotation.x = Math.PI / 2;
      scene.add(s);
    }
  }

  // Rear galley wall, front bulkhead with center cockpit door gap
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xcdd3dd });
  const back = new THREE.Mesh(new THREE.BoxGeometry(10.8, 4.2, 0.2), wallMat);
  back.position.set(0, 1.8, CABIN_BACK + 0.1);
  scene.add(back);
  box(-5.4, 5.4, CABIN_BACK, CABIN_BACK + 1);
  // rear galley counter with coffee pots
  const counter = new THREE.Mesh(new THREE.BoxGeometry(4, 1, 0.6), new THREE.MeshStandardMaterial({ color: 0x9aa3b0 }));
  counter.position.set(0, 0.5, CABIN_BACK - 0.4);
  scene.add(counter);
  box(-2, 2, CABIN_BACK - 0.7, CABIN_BACK - 0.1);
  for (const side of [-1, 1]) {
    const bh = new THREE.Mesh(new THREE.BoxGeometry(4.7, 4.2, 0.2), wallMat);
    bh.position.set(side * 2.95, 1.8, CABIN_FRONT);
    scene.add(bh);
    box(side === -1 ? -5.4 : 0.55, side === -1 ? -0.55 : 5.4, CABIN_FRONT - 0.15, CABIN_FRONT + 0.15);
  }
  const cnv = document.createElement('canvas'); cnv.width = 128; cnv.height = 32;
  const c2 = cnv.getContext('2d');
  c2.fillStyle = '#13315c'; c2.fillRect(0, 0, 128, 32);
  c2.fillStyle = '#9ce2ff'; c2.font = 'bold 18px monospace'; c2.textAlign = 'center';
  c2.fillText('COCKPIT', 64, 23);
  const signTex = new THREE.CanvasTexture(cnv);
  signTex.magFilter = signTex.minFilter = THREE.NearestFilter;
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.3), new THREE.MeshBasicMaterial({ map: signTex }));
  sign.position.set(0, 2.55, CABIN_FRONT + 0.02);
  scene.add(sign);
}

// ---- Cockpit ------------------------------------------------------------------
{
  const dash = new THREE.Mesh(new THREE.BoxGeometry(7, 1, 1), new THREE.MeshStandardMaterial({ color: 0x222833 }));
  dash.position.set(0, 0.9, COCKPIT_BACK + 0.7);
  scene.add(dash);
  box(-3.5, 3.5, COCKPIT_BACK, COCKPIT_BACK + 1.3);
  const screenMat = new THREE.MeshBasicMaterial({ color: 0x2bd96a });
  for (let i = -2; i <= 2; i++) {
    const s = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.35), screenMat);
    s.position.set(i * 0.9, 1.25, COCKPIT_BACK + 1.22);
    scene.add(s);
  }
  const seatMat = new THREE.MeshStandardMaterial({ color: 0x4a2c1a });
  for (const x of [-0.9, 0.9]) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.2, 0.7), seatMat);
    s.position.set(x, 0.6, COCKPIT_BACK + 2.2);
    scene.add(s);
    box(x - 0.35, x + 0.35, COCKPIT_BACK + 1.85, COCKPIT_BACK + 2.55);
  }
  const ws = new THREE.Mesh(new THREE.PlaneGeometry(7, 1.5), new THREE.MeshBasicMaterial({ color: 0x0c1f3d }));
  ws.position.set(0, 2.0, COCKPIT_BACK + 0.05);
  scene.add(ws);
  // cockpit side walls (the fuselage is wider than the cockpit room)
  for (const side of [-1, 1]) {
    box(side === -1 ? -5.4 : 3.6, side === -1 ? -3.6 : 5.4, COCKPIT_BACK, CABIN_FRONT);
  }
}

// ---- Cockpit door ---------------------------------------------------------------
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
  doorGroup.rotation.y = -1.9;
  doorGroup.position.x = -0.55;
}
function closeDoor() {
  doorOpen = false;
  doorGroup.rotation.y = 0;
  doorGroup.position.x = 0;
  if (!colliders.includes(doorCollider)) colliders.push(doorCollider);
}

// ---- Seats --------------------------------------------------------------------
const seatGeoBase = new THREE.BoxGeometry(0.62, 0.45, 0.6);
const seatGeoBack = new THREE.BoxGeometry(0.62, 0.85, 0.16);
const seatMatA = new THREE.MeshStandardMaterial({ color: 0x27497a, roughness: 0.9 });
const seatMatB = new THREE.MeshStandardMaterial({ color: 0x2d5a8e, roughness: 0.9 });
for (let r = 0; r < ROWS; r++) {
  if (L.CROSS_ROWS.includes(r)) continue; // open cross-walkway
  let si = 0;
  for (const block of L.BLOCKS) {
    for (const x of block) {
      const m = (r + si++) % 2 ? seatMatA : seatMatB;
      const base = new THREE.Mesh(seatGeoBase, m);
      base.position.set(x, 0.28, rowZ(r));
      const bk = new THREE.Mesh(seatGeoBack, m);
      bk.position.set(x, 0.85, rowZ(r) + 0.28);
      scene.add(base, bk);
    }
    box(block[0] - 0.35, block[block.length - 1] + 0.35, rowZ(r) - 0.32, rowZ(r) + 0.38);
  }
}

// ===========================================================================
// People
// ===========================================================================
function tagSprite(text, color = '#fff', w = 1.7, h = 0.42) {
  const cnv = document.createElement('canvas'); cnv.width = 128; cnv.height = 32;
  const c = cnv.getContext('2d');
  c.font = 'bold 16px monospace'; c.textAlign = 'center';
  c.fillStyle = 'rgba(0,0,0,0.5)';
  c.fillRect(64 - Math.min(60, c.measureText(text).width / 2 + 8), 4, Math.min(120, c.measureText(text).width + 16), 24);
  c.fillStyle = color; c.fillText(text, 64, 21);
  const tex = new THREE.CanvasTexture(cnv);
  tex.magFilter = tex.minFilter = THREE.NearestFilter;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  sp.scale.set(w, h, 1);
  return sp;
}

function makePerson(color, name, lite = false) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.85, 0.26),
    new THREE.MeshStandardMaterial({ color, roughness: 0.85, flatShading: true }));
  body.position.y = 0.85;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3),
    new THREE.MeshStandardMaterial({ color: 0xe8b990, roughness: 0.9 }));
  head.position.y = 1.45;
  g.add(body, head);
  const sandalMat = new THREE.MeshStandardMaterial({ color: 0x7a5230, roughness: 1 });
  for (const sx of [-0.11, 0.11]) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.05, 0.3), sandalMat);
    s.position.set(sx, 0.03, 0.03);
    g.add(s);
  }
  if (name) {
    const tag = tagSprite(name);
    tag.position.y = 1.9;
    g.add(tag);
  }
  if (!lite) {
    const badge = tagSprite('CLEAN', '#7dffa8', 1.0, 0.28);
    badge.position.y = 2.16;
    badge.visible = false;
    const cuff = tagSprite('RESTRAINED', '#ff7a7a', 1.4, 0.3);
    cuff.position.y = 1.0;
    cuff.visible = false;
    g.add(badge, cuff);
    g.userData = { body, head, badge, cuff, seatedPose: false };
  } else {
    g.userData = { body, head, seatedPose: false };
  }
  return g;
}

function setPose(g, seated) {
  if (g.userData.seatedPose === seated) return;
  g.userData.seatedPose = seated;
  g.userData.body.position.y = seated ? 0.55 : 0.85;
  g.userData.head.position.y = seated ? 1.12 : 1.45;
  g.userData.body.scale.y = seated ? 0.72 : 1;
}

// NPC decoys fill the seats players don't use. The list is deterministic and
// shared with the host (logic.js), so the host can puppet some of them
// ("extras") who stand up and wander the cabin — perfect cover for the Evil.
const NPC_COLORS = [0x8d6e63, 0x78909c, 0x6d8b74, 0xa1887f, 0x607d8b, 0x9575cd, 0xbcaaa4, 0x4db6ac];
const NPC_NAMES = ['Gary', 'Linda', 'Trevor', 'Pam', 'Dale', 'Ruth', 'Kevin', 'Marge', 'Bert', 'Nadine', 'Hank', 'Lois'];
const npcGroups = [];
{
  const seats = npcSeatList();
  for (let i = 0; i < seats.length; i++) {
    const s = seats[i];
    const npc = makePerson(NPC_COLORS[i % NPC_COLORS.length], NPC_NAMES[i % NPC_NAMES.length], true);
    npc.position.set(s.x, 0, s.z);
    npc.rotation.y = Math.PI;
    setPose(npc, true);
    scene.add(npc);
    npcGroups.push({ g: npc, seat: s, target: null }); // target set by snap for extras
  }
}

// Flight attendants + carts (two per aisle). Positions are lerped toward the
// host's snapshots so they glide instead of stuttering, and both the body and
// the cart are solid.
const attendantObjs = [];
for (const [name, ax] of [['Brenda', -L.AISLE_X], ['Doug', -L.AISLE_X], ['Carol', L.AISLE_X], ['Stan', L.AISLE_X]]) {
  const g = makePerson(0xf2f4f7, name, true);
  scene.add(g);
  const cart = new THREE.Group();
  const cbody = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.9, 0.85),
    new THREE.MeshStandardMaterial({ color: 0xb9c0cb, metalness: 0.5, roughness: 0.4 }));
  cbody.position.y = 0.45;
  cart.add(cbody);
  for (let i = 0; i < 5; i++) {
    const can = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.12, 0.09),
      new THREE.MeshStandardMaterial({ color: i % 2 ? 0xd22b2b : 0x2bd96a }));
    can.position.set((i % 3 - 1) * 0.15, 0.96, (Math.floor(i / 3) - 0.5) * 0.3);
    cart.add(can);
  }
  const peanuts = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.1, 0.2),
    new THREE.MeshStandardMaterial({ color: 0xe8c468 }));
  peanuts.position.set(0, 0.95, 0.25);
  cart.add(peanuts);
  scene.add(cart);
  const cartCollider = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  colliders.push(cartCollider);
  const bodyCollider = circle(ax, 0, 0.36);
  attendantObjs.push({ g, cart, cartCollider, bodyCollider, x: ax, z: 0, dir: 1, cx: ax, cz: 0 });
}

// ===========================================================================
// Networking — P2P via Trystero; the flight's creator is the authority
// ===========================================================================
const myId = selfId;
let room = null, sendC2H = null, sendH2C = null;
let isHost = false, logic = null, hostTick = null;
let hostId = null, phase = 'menu', endsAt = 0;
let mySeat = null, seated = true;
let stunnedUntil = 0, restrainedUntil = 0, restrainCooldownUntil = 0;
let isEvil = false, commotion = false;
const remotes = new Map();
const playerInfo = new Map();
const me = { x: 0, z: 0 };
let yaw = 0, pitch = 0;
let inspecting = null, lockpicking = false, lockpickProgress = 0;
let joinRetry = null;

function send(msg) {
  if (isHost) logic.handle(myId, msg);
  else if (sendC2H) sendC2H(msg);
}

function connect(code) {
  const appConfig = { appId: 'planey-sandal-knife-v1' };
  room = joinRoom(appConfig, code.toUpperCase(), {
    onJoinError: (err) => { $('netStatus').textContent = `Connection problem: ${err.error}`; },
  });
  const c2h = room.makeAction('c2h');
  const h2c = room.makeAction('h2c');
  sendC2H = (msg) => c2h.send(msg).catch(() => {});
  sendH2C = (msg, target) => h2c.send(msg, target ? { target } : undefined).catch(() => {});

  if (isHost) {
    logic = new HostLogic(myId, (target, msg) => {
      if (target === null) { onMsg(msg); sendH2C(msg); }
      else if (target === myId) onMsg(msg);
      else sendH2C(msg, target);
    });
    c2h.onMessage = (msg, { peerId }) => logic.handle(peerId, msg);
    hostTick = setInterval(() => logic.tick(), C.TICK_MS);
    room.onPeerLeave = (peerId) => logic.removePlayer(peerId);
    logic.handle(myId, { type: 'join', name: myName });
  } else {
    h2c.onMessage = (msg) => onMsg(msg);
    room.onPeerLeave = (peerId) => {
      if (peerId === hostId) {
        alert('The flight host left. Returning to the gate.');
        location.href = location.pathname;
      }
    };
    // Keep knocking until the host answers with init
    joinRetry = setInterval(() => send({ type: 'join', name: myName }), 1500);
    send({ type: 'join', name: myName });
  }
}

// ---- Menu ----------------------------------------------------------------------
let myName = '';
const params = new URLSearchParams(location.search);
if (params.get('room')) {
  $('codeInput').value = params.get('room').toUpperCase().slice(0, 4);
  $('codeInput').style.display = 'block';
  $('createBtn').textContent = 'Join this flight';
}
function readName() {
  myName = $('nameInput').value.trim() || 'Passenger';
  return myName;
}
$('createBtn').onclick = () => {
  readName();
  let code = params.get('room');
  if (code) { isHost = false; code = code.toUpperCase().slice(0, 4); }
  else {
    isHost = true;
    code = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]).join('');
  }
  enterLobby(code);
};
$('joinBtn').onclick = () => {
  const ci = $('codeInput');
  if (ci.style.display !== 'block') { ci.style.display = 'block'; ci.focus(); return; }
  const code = ci.value.trim().toUpperCase();
  if (code.length !== 4) { $('netStatus').textContent = 'Flight codes are 4 letters.'; return; }
  readName();
  isHost = false;
  enterLobby(code);
};
$('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });
$('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('createBtn').click(); });

function enterLobby(code) {
  try { audio(); } catch {}
  phase = 'lobby';
  $('menuScreen').style.display = 'none';
  $('lobbyScreen').style.display = 'flex';
  $('roomCode').textContent = code;
  const share = `${location.origin}${location.pathname}?room=${code}`;
  $('shareLink').value = share;
  $('copyBtn').onclick = () => { navigator.clipboard?.writeText(share); $('copyBtn').textContent = 'Copied!'; };
  $('lobbyList').textContent = isHost ? 'Opening the boarding gate...' : 'Contacting the flight host...';
  connect(code);
}
$('startBtn').onclick = () => send({ type: 'start' });

// ---- Remote player avatars --------------------------------------------------------
function addRemote(p) {
  if (p.id === myId || remotes.has(p.id)) return;
  playerInfo.set(p.id, { name: p.name, color: p.color });
  const g = makePerson(p.color, p.name);
  g.position.set(p.pos.x, 0, p.pos.z);
  setPose(g, p.seated);
  scene.add(g);
  remotes.set(p.id, { g, name: p.name, target: { x: p.pos.x, z: p.pos.z, ry: p.ry, seated: p.seated, restrained: false } });
}
function removeRemote(id) {
  const r = remotes.get(id);
  if (r) { scene.remove(r.g); remotes.delete(id); }
  playerInfo.delete(id);
}

// ===========================================================================
// Message handling (host loopback + network)
// ===========================================================================
function onMsg(m) {
  switch (m.type) {
    case 'init': {
      if (joinRetry) { clearInterval(joinRetry); joinRetry = null; }
      hostId = m.hostId;
      mySeat = m.seat;
      me.x = mySeat.x; me.z = rowZ(mySeat.row);
      yaw = Math.PI;
      if (m.doorOpen) openDoor();
      for (const p of m.players) addRemote(p);
      if (m.phase === 'playing') { phase = 'playing'; endsAt = Date.now() + m.timeLeft; enterGame(); }
      break;
    }
    case 'lobby': {
      hostId = m.hostId;
      if (phase === 'playing' || phase === 'over') {
        phase = 'lobby';
        $('gameOverScreen').style.display = 'none';
        $('lobbyScreen').style.display = 'flex';
        $('roleCard').style.display = 'none';
        isEvil = false; seated = true; commotion = false;
        stunnedUntil = restrainedUntil = restrainCooldownUntil = 0;
        $('stunOverlay').style.display = 'none';
        if (mySeat) { me.x = mySeat.x; me.z = rowZ(mySeat.row); }
        closeDoor();
        lockpickProgress = 0; lockpicking = false;
        setProgress(null);
        document.exitPointerLock();
      }
      $('lobbyList').innerHTML = m.players.map(p =>
        `<span style="color:#${p.color.toString(16).padStart(6, '0')}">■</span> ${p.name}${p.id === m.hostId ? ' (host)' : ''}`
      ).join('<br>');
      const amHost = myId === m.hostId;
      $('startBtn').style.display = amHost ? 'block' : 'none';
      $('lobbyWait').style.display = amHost ? 'none' : 'block';
      break;
    }
    case 'joined': addRemote(m.p); if (phase !== 'menu') feed(`${m.p.name} boarded the plane.`); break;
    case 'left': removeRemote(m.id); break;
    case 'role': {
      isEvil = m.evil;
      const rc = $('roleCard');
      rc.style.display = 'block';
      rc.className = m.evil ? 'evil' : 'crew';
      rc.innerHTML = m.evil
        ? '🔪 YOU ARE THE EVIL — knife in your sandal. Open the cockpit door (hold E / A), get in, pull the knife (Q / RB).'
        : '🩴 PASSENGER — someone has a knife in their sandal. Inspect (F / X) or restrain (R / B) before they reach the cockpit.';
      break;
    }
    case 'started': {
      endsAt = Date.now() + m.timeLeft;
      phase = 'playing';
      seated = true; commotion = false;
      stunnedUntil = restrainedUntil = restrainCooldownUntil = 0;
      me.x = mySeat.x; me.z = rowZ(mySeat.row);
      closeDoor();
      lockpickProgress = 0; lockpicking = false;
      for (const p of m.players) {
        const r = remotes.get(p.id);
        if (r) {
          r.target = { x: p.pos.x, z: p.pos.z, ry: p.ry, seated: true, restrained: false };
          setPose(r.g, true);
          r.g.userData.badge.visible = false;
          r.g.userData.cuff.visible = false;
        }
      }
      enterGame();
      feed('The seatbelt sign is off. Welcome aboard.', 'serve');
      break;
    }
    case 'snap': {
      for (const p of m.players) {
        if (p.id === myId) continue;
        const r = remotes.get(p.id);
        if (r) r.target = { x: p.pos.x, z: p.pos.z, ry: p.ry, seated: p.seated, restrained: p.restrained };
      }
      for (let i = 0; i < m.attendants.length && i < attendantObjs.length; i++) {
        attendantObjs[i].x = m.attendants[i].x ?? attendantObjs[i].x;
        attendantObjs[i].z = m.attendants[i].z;
        attendantObjs[i].dir = m.attendants[i].dir;
      }
      if (m.extras) {
        for (const e of m.extras) {
          const n = npcGroups[e.i];
          if (n) n.target = { x: e.x, z: e.z, seated: !!e.s };
        }
      }
      if (m.doorOpen && !doorOpen) openDoor();
      commotion = m.commotion;
      $('commotion').style.display = commotion && phase === 'playing' ? 'block' : 'none';
      break;
    }
    case 'msg': feed(m.text, m.kind); break;
    case 'serve': {
      feed(`${m.name} (row ${rowOfZ(m.z)}): “${m.text}”`, 'serve');
      break;
    }
    case 'clink': {
      feed(`You hear a faint metallic *clink* near row ${rowOfZ(m.z)}...`, 'sus');
      blip(2200, 0.06, 0.12);
      break;
    }
    case 'rattle': {
      doorRattleT = 0.5;
      blip(180, 0.15, 0.1);
      if (!onMsg._lastRattle || Date.now() - onMsg._lastRattle > 6000) {
        onMsg._lastRattle = Date.now();
        feed('The cockpit door handle is rattling...', 'sus');
      }
      break;
    }
    case 'doorOpened': openDoor(); feed('THE COCKPIT DOOR IS OPEN!', 'alert'); blip(90, 0.4, 0.2); break;
    case 'lockProg':
      lockpickProgress = m.progress;
      if (lockpicking) setProgress('Picking the cockpit lock...', m.progress);
      break;
    case 'insStart': {
      if (m.inspectorId === myId) inspecting = { targetId: m.targetId, until: Date.now() + m.durationMs, durationMs: m.durationMs };
      if (m.targetId === myId) {
        const n = playerInfo.get(m.inspectorId)?.name || 'Someone';
        feed(`${n} is inspecting YOUR sandals! (move to pull away — looks suspicious)`, 'sus');
      }
      break;
    }
    case 'insCancel': if (m.inspectorId === myId) { inspecting = null; setProgress(null); } break;
    case 'insResult': {
      if (m.inspectorId === myId) {
        inspecting = null; setProgress(null);
        if (m.clean) {
          stunnedUntil = Date.now() + m.stunMs;
          $('stunOverlay').textContent = 'Apologizing profusely...';
          $('stunOverlay').style.display = 'flex';
          setTimeout(() => { if (Date.now() >= stunnedUntil) $('stunOverlay').style.display = 'none'; }, m.stunMs);
        }
      }
      const r = remotes.get(m.targetId);
      if (r && m.clean) r.g.userData.badge.visible = true;
      break;
    }
    case 'restrained': {
      blip(140, 0.25, 0.2);
      if (m.id === myId) {
        restrainedUntil = Date.now() + m.restrainMs;
        seated = false;
        $('stunOverlay').textContent = `Zip-tied with seatbelt extenders by ${m.byName}!`;
        $('stunOverlay').style.display = 'flex';
        if (inspecting) { inspecting = null; setProgress(null); }
        if (lockpicking) stopLockpick();
      }
      if (m.by === myId) restrainCooldownUntil = Date.now() + m.cooldownMs;
      const r = remotes.get(m.id);
      if (r) r.g.userData.cuff.visible = true;
      break;
    }
    case 'released': {
      if (m.id === myId) { restrainedUntil = 0; $('stunOverlay').style.display = 'none'; }
      const r = remotes.get(m.id);
      if (r) r.g.userData.cuff.visible = false;
      feed(`${m.name} wriggled free of the seatbelt extenders.`);
      break;
    }
    case 'sandals': {
      feed(`${m.name} shows everyone their sandals. Clean.`);
      const r = remotes.get(m.id);
      if (r) r.g.userData.badge.visible = true;
      break;
    }
    case 'knifePulled': blip(60, 0.8, 0.3); break;
    case 'over': {
      phase = 'over';
      document.exitPointerLock();
      setPrompt(null); setProgress(null);
      inspecting = null; lockpicking = false;
      $('stunOverlay').style.display = 'none';
      $('commotion').style.display = 'none';
      $('gameOverScreen').style.display = 'flex';
      const t = $('goTitle');
      if (m.winner === 'evil') { t.textContent = 'THE EVIL WINS'; t.style.color = '#ff5a5a'; }
      else { t.textContent = 'CREW WINS'; t.style.color = '#7dffa8'; }
      $('goReason').textContent = `${m.reason} The Evil was ${m.evilName}.`;
      break;
    }
    case 'chat': {
      const d = document.createElement('div');
      d.innerHTML = `<b style="color:#${m.color.toString(16).padStart(6, '0')}">${m.name.replace(/[<>&]/g, '')}:</b> `;
      d.append(m.text);
      $('chatLog').appendChild(d);
      $('chatLog').scrollTop = 1e6;
      while ($('chatLog').children.length > 30) $('chatLog').firstChild.remove();
      break;
    }
  }
}

function enterGame() {
  $('lobbyScreen').style.display = 'none';
  $('gameOverScreen').style.display = 'none';
  renderer.domElement.requestPointerLock();
}

// ===========================================================================
// Input — keyboard, mouse, and gamepad
// ===========================================================================
const keys = {};
const chatInput = $('chatInput');
let chatOpen = false;

addEventListener('keydown', (e) => {
  if (chatOpen) {
    if (e.key === 'Enter') {
      if (chatInput.value.trim()) send({ type: 'chat', text: chatInput.value.trim() });
      chatInput.value = '';
      closeChat();
    } else if (e.key === 'Escape') closeChat();
    return;
  }
  keys[e.code] = true;
  if (e.code === 'KeyM') toggleMusic();
  if (e.code === 'Enter' && phase === 'playing') { openChat(); e.preventDefault(); }
  if (phase !== 'playing' || blocked()) return;
  if (e.code === 'KeyF') tryInspect();
  if (e.code === 'KeyR') tryRestrain();
  if (e.code === 'KeyG' && !seated) send({ type: 'show' });
  if (e.code === 'KeyQ') send({ type: 'knife' });
  if (e.code === 'KeyE') onUse();
});
addEventListener('keyup', (e) => {
  keys[e.code] = false;
  if (e.code === 'KeyE' && lockpicking) stopLockpick();
});
function blocked() { return Date.now() < stunnedUntil || Date.now() < restrainedUntil; }
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

// --- Gamepad (standard/Xbox mapping) ---------------------------------------
const padPrev = [];
let padSprint = false, padMove = { x: 0, y: 0 };
function pollGamepad(dt) {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let gp = null;
  for (const p of pads) if (p && p.connected) { gp = p; break; }
  padMove.x = 0; padMove.y = 0; padSprint = false;
  if (!gp) return;
  const dz = (v) => (Math.abs(v) > 0.18 ? v : 0);
  padMove.x = dz(gp.axes[0] || 0);
  padMove.y = dz(gp.axes[1] || 0);
  yaw -= dz(gp.axes[2] || 0) * 2.8 * dt;
  pitch = Math.max(-1.45, Math.min(1.45, pitch - dz(gp.axes[3] || 0) * 2.2 * dt));
  padSprint = (gp.buttons[6]?.value || 0) > 0.4 || gp.buttons[10]?.pressed;

  const now = (i) => !!gp.buttons[i]?.pressed;
  const edge = (i) => { const v = now(i) && !padPrev[i]; return v; };

  if (phase === 'lobby' && edge(9) && myId === hostId) send({ type: 'start' });
  if (phase === 'playing' && !chatOpen && !blocked()) {
    if (edge(0)) onUse();                                  // A = use / sit / lockpick
    if (!now(0) && padPrev[0] && lockpicking) stopLockpick();
    if (edge(2)) tryInspect();                             // X = inspect sandals
    if (edge(1)) tryRestrain();                            // B = restrain
    if (edge(3) && !seated) send({ type: 'show' });        // Y = show sandals
    if (edge(5)) send({ type: 'knife' });                  // RB = pull knife
  }
  for (let i = 0; i < gp.buttons.length; i++) padPrev[i] = now(i);
}

// --- Actions -------------------------------------------------------------------
function nearMySeat() { return mySeat && Math.abs(me.x - mySeat.x) < 1.1 && Math.abs(me.z - rowZ(mySeat.row)) < 1.1; }
function inDoorZone() { return Math.abs(me.x) < 1.2 && Math.abs(me.z - C.DOOR_ZONE.z) < C.DOOR_ZONE.radius; }
function onUse() {
  if (seated) {
    seated = false;
    me.x = L.AISLE_X * (mySeat.x >= 0 ? 1 : -1);
    me.z = rowZ(mySeat.row) + 0.85;
    return;
  }
  if (nearMySeat()) { seated = true; me.x = mySeat.x; me.z = rowZ(mySeat.row); yaw = Math.PI; return; }
  if (!doorOpen && inDoorZone()) {
    lockpicking = true;
    send({ type: 'lockpick', active: true });
    if (isEvil) setProgress('Picking the cockpit lock...', lockpickProgress);
  }
}
function stopLockpick() {
  lockpicking = false;
  send({ type: 'lockpick', active: false });
  setProgress(null);
}
function nearestStanding(range, excludeRestrained) {
  let best = null, bd = range;
  for (const [id, r] of remotes) {
    if (r.target.seated) continue;
    if (excludeRestrained && r.target.restrained) continue;
    const d = Math.hypot(r.g.position.x - me.x, r.g.position.z - me.z);
    if (d < bd) { bd = d; best = id; }
  }
  return best;
}
function tryInspect() {
  if (inspecting || seated) return;
  const id = nearestStanding(C.INSPECT_RANGE, false);
  if (id) send({ type: 'inspect', targetId: id });
  else feed('No one standing close enough to inspect.', 'err');
}
function tryRestrain() {
  if (seated) return;
  if (Date.now() < restrainCooldownUntil) {
    feed(`Still catching your breath (${Math.ceil((restrainCooldownUntil - Date.now()) / 1000)}s).`, 'err');
    return;
  }
  const id = nearestStanding(C.RESTRAIN_RANGE, true);
  if (id) send({ type: 'restrain', targetId: id });
  else feed('No one standing close enough to restrain.', 'err');
}

// ===========================================================================
// Movement & collision
// ===========================================================================
function collide(x, z) {
  for (const c of colliders) {
    if (c.r !== undefined) {
      // round collider (people): smooth radial push-out, no snagging
      const dx = x - c.cx, dz = z - c.cz;
      const min = c.r + RADIUS;
      const d2 = dx * dx + dz * dz;
      if (d2 < min * min) {
        const d = Math.sqrt(d2) || 0.001;
        x = c.cx + (dx / d) * min;
        z = c.cz + (dz / d) * min;
      }
      continue;
    }
    const cx = Math.max(c.minX, Math.min(x, c.maxX));
    const cz = Math.max(c.minZ, Math.min(z, c.maxZ));
    const dx = x - cx, dz = z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 < RADIUS * RADIUS) {
      if (d2 > 1e-6) {
        const d = Math.sqrt(d2);
        x = cx + (dx / d) * RADIUS;
        z = cz + (dz / d) * RADIUS;
      } else z = c.maxZ + RADIUS;
    }
  }
  x = Math.max(-L.HALF_W, Math.min(L.HALF_W, x));
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

  pollGamepad(dt);

  const playing = phase === 'playing';

  if (playing && !seated && !chatOpen && !blocked()) {
    const sprint = keys['ShiftLeft'] || keys['ShiftRight'] || padSprint;
    const sp = (sprint ? SPRINT : WALK) * dt;
    let mx = 0, mz = 0;
    if (keys['KeyW']) { mx -= Math.sin(yaw); mz -= Math.cos(yaw); }
    if (keys['KeyS']) { mx += Math.sin(yaw); mz += Math.cos(yaw); }
    if (keys['KeyA']) { mx -= Math.cos(yaw); mz += Math.sin(yaw); }
    if (keys['KeyD']) { mx += Math.cos(yaw); mz -= Math.sin(yaw); }
    // gamepad left stick: y = forward/back, x = strafe
    mx += -Math.sin(yaw) * -padMove.y + Math.cos(yaw) * padMove.x;
    mz += -Math.cos(yaw) * -padMove.y - Math.sin(yaw) * padMove.x;
    const l = Math.hypot(mx, mz);
    if (l > 0.01) {
      [me.x, me.z] = collide(me.x + (mx / l) * Math.min(1, l) * sp, me.z + (mz / l) * Math.min(1, l) * sp);
      if (lockpicking && !inDoorZone()) stopLockpick();
    }
  }

  camera.position.set(me.x, seated ? EYE_SEATED : EYE, me.z);
  camera.rotation.set(0, 0, 0);
  camera.rotateY(yaw);
  camera.rotateX(pitch);

  for (const r of remotes.values()) {
    const g = r.g, tg = r.target;
    g.position.x += (tg.x - g.position.x) * Math.min(1, dt * 12);
    g.position.z += (tg.z - g.position.z) * Math.min(1, dt * 12);
    let dr = tg.ry - g.rotation.y;
    dr = ((dr + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    g.rotation.y += dr * Math.min(1, dt * 10);
    setPose(g, tg.seated || tg.restrained); // restrained players are on the floor
    g.userData.cuff.visible = !!tg.restrained;
  }

  for (const a of attendantObjs) {
    // glide toward the host's position instead of snapping (no more bumpy hits)
    a.cx += (a.x - a.cx) * Math.min(1, dt * 8);
    a.cz += (a.z - a.cz) * Math.min(1, dt * 8);
    a.g.position.set(a.cx, 0, a.cz);
    a.g.rotation.y = a.dir > 0 ? 0 : Math.PI;
    const cz = a.cz + a.dir * 0.85;
    a.cart.position.set(a.cx, 0, cz);
    a.bodyCollider.cx = a.cx; a.bodyCollider.cz = a.cz;
    a.cartCollider.minX = a.cx - 0.34; a.cartCollider.maxX = a.cx + 0.34;
    a.cartCollider.minZ = cz - 0.5; a.cartCollider.maxZ = cz + 0.5;
  }

  // Wandering NPC extras drift toward the host's snapshots
  for (const n of npcGroups) {
    if (!n.target) continue;
    const g = n.g, t2 = n.target;
    const dx = t2.x - g.position.x, dz = t2.z - g.position.z;
    g.position.x += dx * Math.min(1, dt * 8);
    g.position.z += dz * Math.min(1, dt * 8);
    if (!t2.seated && (dx * dx + dz * dz) > 0.01) {
      const want = Math.atan2(-dx, -dz);
      let dr = want - g.rotation.y;
      dr = ((dr + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
      g.rotation.y += dr * Math.min(1, dt * 8);
    } else if (t2.seated) g.rotation.y = Math.PI;
    setPose(g, t2.seated);
  }

  if (doorRattleT > 0 && !doorOpen) {
    doorRattleT -= dt;
    doorGroup.position.x = Math.sin(t * 0.06) * 0.012;
    if (doorRattleT <= 0) doorGroup.position.x = 0;
  }

  // HUD
  if (playing && !chatOpen) {
    const now = Date.now();
    if (now < restrainedUntil) {
      setPrompt(`Restrained... ${Math.ceil((restrainedUntil - now) / 1000)}s`);
    } else if (now < stunnedUntil) setPrompt(null);
    else if (seated) setPrompt('<b>E / A</b> stand up');
    else if (!doorOpen && inDoorZone() && !lockpicking)
      setPrompt(isEvil ? '<b>Hold E / A</b> pick the cockpit lock' : '<b>E / A</b> try the cockpit door (locked)');
    else if (doorOpen && me.z < CABIN_FRONT && isEvil) setPrompt('<b>Q / RB</b> pull the knife from your sandal');
    else if (nearMySeat()) setPrompt('<b>E / A</b> sit down');
    else {
      const id = nearestStanding(C.INSPECT_RANGE, false);
      if (id && !inspecting) {
        const n = playerInfo.get(id)?.name || '?';
        setPrompt(`<b>F / X</b> inspect ${n} · <b>R / B</b> restrain ${n} · <b>G / Y</b> show yours`);
      } else if (!inspecting) setPrompt(null);
    }
    if (inspecting) {
      const left = inspecting.until - now;
      const n = playerInfo.get(inspecting.targetId)?.name || '?';
      setProgress(`Inspecting ${n}'s sandals... (don't move)`, 1 - left / inspecting.durationMs);
    }
    const cd = restrainCooldownUntil - now;
    if (cd > 0) {
      $('cooldown').style.display = 'block';
      $('cooldown').textContent = `RESTRAIN ${Math.ceil(cd / 1000)}s`;
    } else $('cooldown').style.display = 'none';
    if (now >= restrainedUntil && now >= stunnedUntil && $('stunOverlay').style.display === 'flex')
      $('stunOverlay').style.display = 'none';
  }

  if (playing && endsAt) {
    const s = Math.max(0, Math.floor((endsAt - Date.now()) / 1000));
    $('timer').textContent = `LAND ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  } else $('timer').textContent = '';

  if (playing && t - lastSend > 50) {
    lastSend = t;
    send({ type: 'move', pos: { x: me.x, z: me.z }, ry: yaw, seated });
  }

  renderer.render(scene, camera);
}
requestAnimationFrame(loop);
