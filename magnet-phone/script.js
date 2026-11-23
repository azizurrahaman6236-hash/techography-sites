/* MAGNET PHONE · made for @_techography */
(() => {
'use strict';
const M = window.Matter;
const { Engine, Bodies, Body, Composite, Events } = M;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const now = () => performance.now();
const DT = 1000 / 60, DT2 = DT * DT;

const stage = $('#stage'), homeEl = $('#home'), comboEl = $('#combo'), arena = $('#arena');
const chip = $('#chip'), chipText = $('#chipText');
const toastEl = $('#toast');
const edgeGlow = $('#edgeGlow'), magnetMark = $('#magnetMark'), holeEl = $('#hole');

const state = {
  mode: 'magnet', started: false, returnMode: 'spring', blackHole: false, antigrav: false,
  tilt: { x: 0, y: 1, on: false, seen: false }, sound: false, flip: 1, side: 'auto', meter: false,
  W: 0, H: 0, eaten: 0,
};
try { const sv = JSON.parse(localStorage.getItem('mp_prefs') || '{}'); if (sv.flip) state.flip = sv.flip; if (sv.side) state.side = sv.side; } catch (e) {}
const savePrefs = () => { try { localStorage.setItem('mp_prefs', JSON.stringify({ flip: state.flip, side: state.side })); } catch (e) {} };

/* ------------------------------------------------------------------ toast */
let toastT = 0;
function toast(msg, cls = '', ms = 1800) {
  toastEl.textContent = msg; toastEl.className = 'show ' + cls;
  clearTimeout(toastT); toastT = setTimeout(() => { toastEl.className = cls; }, ms);
}

/* ------------------------------------------------------------------ sound + haptics */
let actx = null, hum = null, humGain = null;
function audio() {
  if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; } }
  if (actx.state === 'suspended') actx.resume();
  return actx;
}
function ensureHum() {
  const a = audio(); if (!a || hum) return;
  hum = a.createOscillator(); hum.type = 'sawtooth'; hum.frequency.value = 52;
  const lp = a.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 320;
  humGain = a.createGain(); humGain.gain.value = 0;
  hum.connect(lp); lp.connect(humGain); humGain.connect(a.destination); hum.start();
}
function blip(f = 600, d = 0.07, type = 'square', vol = 0.06) {
  if (!state.sound) return; const a = audio(); if (!a) return;
  const o = a.createOscillator(), g = a.createGain(); o.type = type; o.frequency.setValueAtTime(f, a.currentTime);
  o.frequency.exponentialRampToValueAtTime(Math.max(40, f * 0.5), a.currentTime + d);
  g.gain.setValueAtTime(vol, a.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + d);
  o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + d + 0.02);
}
let lastBuzz = 0;
function buzz(p = 8) { const t = now(); if (t - lastBuzz < 45) return; lastBuzz = t; try { navigator.vibrate && navigator.vibrate(p); } catch (e) {} }

/* ------------------------------------------------------------------ quaternions ([x,y,z,w]) */
const D2R = Math.PI / 180;
function qmul(a, b) {
  return [a[3]*b[0] + a[0]*b[3] + a[1]*b[2] - a[2]*b[1],
          a[3]*b[1] - a[0]*b[2] + a[1]*b[3] + a[2]*b[0],
          a[3]*b[2] + a[0]*b[1] - a[1]*b[0] + a[2]*b[3],
          a[3]*b[3] - a[0]*b[0] - a[1]*b[1] - a[2]*b[2]];
}
const qconj = q => [-q[0], -q[1], -q[2], q[3]];
function euler(al, be, ga) { // W3C DeviceOrientation Z-X'-Y'' (degrees) -> quaternion device->earth
  const x = (be || 0) * D2R / 2, y = (ga || 0) * D2R / 2, z = (al || 0) * D2R / 2;
  const cX = Math.cos(x), cY = Math.cos(y), cZ = Math.cos(z), sX = Math.sin(x), sY = Math.sin(y), sZ = Math.sin(z);
  return [sX*cY*cZ - cX*sY*sZ, cX*sY*cZ + sX*cY*sZ, cX*cY*sZ + sX*sY*cZ, cX*cY*cZ - sX*sY*sZ];
}
function qrot(q, v) { const p = qmul(qmul(q, [v[0], v[1], v[2], 0]), qconj(q)); return [p[0], p[1], p[2]]; }
const yawOf = q => 2 * Math.atan2(q[2], q[3]) / D2R; // rotation about earth z, degrees
const wrap180 = a => { a = ((a + 180) % 360 + 360) % 360 - 180; return a; };

/* ------------------------------------------------------------------ MAGNET SENSOR
   Paths, best first:
   1. Magnetometer (Generic Sensor, Chrome Android flag): true field vector, rotation-compensated.
   2. Compass fusion (Android Chrome default): absolute heading (uses the magnetometer) minus
      gyro-only relative heading. Your own rotation cancels out; what is left is magnetic distortion.
      Sources: AbsoluteOrientationSensor/RelativeOrientationSensor, or deviceorientationabsolute/deviceorientation.
   3. iOS compass: webkitCompassHeading vs gyro alpha, plus webkitCompassAccuracy.
*/
const Mag = {
  source: 'none', strength: 0, target: 0, dirX: null, dirY: null, sign: 0, readout: '', calibrating: false,
  seen: {}, rates: {}, cnt: {}, heading: null,
  mag: null, magBase: null, magWorld0: null, magSamples: [], magDev: [0, 0, 0], magError: '',
  absQ: null, absT: 0, relQ: null, relT: 0, gsAbsQ: null, gsAbsT: 0, gsRelQ: null, gsRelT: 0,
  gyroQ: null, gyroT: 0, rot: [0, 0, 0], rotRate: 0, grav: null, gravEma: null, stillSince: 0, still: false,
  iosAcc: null, iosAcc0: null, holdQ: null,
};
window.__magnet = Mag;
function markSeen(src) { Mag.seen[src] = now(); Mag.cnt[src] = (Mag.cnt[src] || 0) + 1; }
const fresh = (src, ms = 1200) => Mag.seen[src] && now() - Mag.seen[src] < ms;
setInterval(() => { Mag.rates = Mag.cnt; Mag.cnt = {}; }, 1000);

function startSensors() {
  // 1. Magnetometer (only with the Chrome flag)
  if ('Magnetometer' in window) {
    try {
      const m = new window.Magnetometer({ frequency: 60 });
      m.addEventListener('reading', () => { if (m.x == null) return; onMagReading(m.x, m.y, m.z); });
      m.addEventListener('error', e => { Mag.magError = (e.error && e.error.name) || 'error'; });
      m.start(); Mag.mag = m;
    } catch (e) { Mag.magError = e.name || String(e); }
  } else Mag.magError = 'not in this browser';
  // 2. Orientation sensors (on by default in Chrome Android)
  const gs = (Cls, cb, key) => {
    if (!(Cls in window)) { Mag[key + 'Err'] = 'not in this browser'; return; }
    try {
      const s = new window[Cls]({ frequency: 60 });
      s.addEventListener('reading', () => { if (s.quaternion) cb(s.quaternion.slice()); });
      s.addEventListener('error', e => { Mag[key + 'Err'] = (e.error && e.error.name) || 'error'; });
      s.start(); Mag[key] = s;
    } catch (e) { Mag[key + 'Err'] = e.name || String(e); }
  };
  gs('AbsoluteOrientationSensor', q => { Mag.gsAbsQ = q; Mag.gsAbsT = now(); markSeen('gsAbs'); onAbs(q); }, 'gsA');
  gs('RelativeOrientationSensor', q => { Mag.gsRelQ = q; Mag.gsRelT = now(); markSeen('gsRel'); }, 'gsR');
  // 3. DeviceOrientation / DeviceMotion events
  window.addEventListener('deviceorientationabsolute', onAbsEvent, true);
  window.addEventListener('deviceorientation', onOrientEvent, true);
  window.addEventListener('devicemotion', onMotion, true);
}

function setTilt(x, y) { state.tilt.x = clamp(x, -1, 1); state.tilt.y = clamp(y, -1, 1); state.tilt.seen = true; }
function onAbsEvent(e) {
  if (e.alpha == null) return;
  markSeen('evAbs'); Mag.heading = e.alpha;
  const q = euler(e.alpha, e.beta, e.gamma); Mag.absQ = q; Mag.absT = now();
  if (!fresh('gsAbs', 400)) onAbs(q);
}
function onOrientEvent(e) {
  if (e.beta != null && e.gamma != null) { state.tilt.orient = true; setTilt(Math.sin(e.gamma * D2R), Math.sin(clamp(e.beta, -90, 90) * D2R)); }
  if (e.alpha == null) return;
  if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) { onIOS(e); return; }
  if (e.absolute === true) { onAbsEvent(e); return; }
  markSeen('evRel'); Mag.relQ = euler(e.alpha, e.beta, e.gamma); Mag.relT = now();
}
function onMotion(e) {
  const r = e.rotationRate, t = now();
  const g = e.accelerationIncludingGravity;
  if (g && g.x != null) {
    const v = [g.x || 0, g.y || 0, g.z || 0];
    Mag.grav = v;
    if (!Mag.gravEma) Mag.gravEma = v.slice();
    const dev = Math.hypot(v[0] - Mag.gravEma[0], v[1] - Mag.gravEma[1], v[2] - Mag.gravEma[2]);
    for (let i = 0; i < 3; i++) Mag.gravEma[i] += (v[i] - Mag.gravEma[i]) * 0.15;
    if (!state.tilt.orient) {
      let gx = -v[0] / 9.81, gy = v[1] / 9.81;
      if (/iPhone|iPad|iPod/.test(navigator.userAgent)) { gx = -gx; gy = -gy; }
      setTilt(gx, gy);
    }
  }
  if (r && r.alpha != null) {
    markSeen('gyro');
    Mag.rot = [r.beta || 0, r.gamma || 0, r.alpha || 0]; // deg/s about device x, y, z
    Mag.rotRate = Math.hypot(Mag.rot[0], Mag.rot[1], Mag.rot[2]);
    // integrate the gyro into an orientation, started from the compass orientation
    if (Mag.gyroQ) {
      const dt = clamp(Mag.gyroT ? (t - Mag.gyroT) / 1000 : (e.interval || 16) / 1000, 0, 0.1);
      const wx = Mag.rot[0] * D2R, wy = Mag.rot[1] * D2R, wz = Mag.rot[2] * D2R, w = Math.hypot(wx, wy, wz);
      if (w > 1e-6) {
        const h = w * dt / 2, s = Math.sin(h) / w;
        Mag.gyroQ = qnorm(qmul(Mag.gyroQ, [wx * s, wy * s, wz * s, Math.cos(h)]));
      }
    }
    Mag.gyroT = t;
  }
}
function qnorm(q) { const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / n, q[1] / n, q[2] / n, q[3] / n]; }
function qslerpTo(a, b, f) { // small-step blend (nlerp)
  const d = a[0]*b[0] + a[1]*b[1] + a[2]*b[2] + a[3]*b[3], sg = d < 0 ? -1 : 1;
  return qnorm([a[0] + (b[0] * sg - a[0]) * f, a[1] + (b[1] * sg - a[1]) * f, a[2] + (b[2] * sg - a[2]) * f, a[3] + (b[3] * sg - a[3]) * f]);
}
function onIOS(e) {
  markSeen('ios');
  Mag.heading = e.webkitCompassHeading; Mag.iosAcc = e.webkitCompassAccuracy;
  feedYaw('ios-compass', wrap180((360 - e.webkitCompassHeading) - e.alpha));
}

/* Every path gives a yaw: (compass orientation) vs (orientation that ignores the compass).
   No magnet -> constant. Magnet near -> it shifts, while your own hand movement cancels out. */
function onAbs(q) {
  // a. compass vs Chrome's gyro-only orientation (sensor API or events)
  if (Mag.gsRelQ && fresh('gsRel', 300) && q === Mag.gsAbsQ) feedYaw('fusion-sensor', yawOf(qmul(q, qconj(Mag.gsRelQ))));
  if (Mag.relQ && fresh('evRel', 300) && q === Mag.absQ) feedYaw('fusion-events', yawOf(qmul(q, qconj(Mag.relQ))));
  // b. compass vs our own integration of the raw gyro (DeviceMotion rotationRate)
  if (fresh('gyro', 300)) {
    if (!Mag.gyroQ) Mag.gyroQ = q.slice();
    const y = feedYaw('gyro-check', yawOf(qmul(q, qconj(Mag.gyroQ))));
    if (y && Math.abs(y.d) < 2.5 && !Mag.calibrating) Mag.gyroQ = qslerpTo(Mag.gyroQ, q, 0.01); // cancel gyro drift
  }
  // c. no (real) gyro, e.g. Redmi 12 5G: the phone's tilt comes from the accelerometer, which a magnet can't fool.
  //    While the tilt stays put (phone on a table / steady in hand) any compass turn is the magnet.
  const up = qrot(qconj(q), [0, 0, 1]);
  const moved = Mag.holdUp ? Math.acos(clamp(up[0] * Mag.holdUp[0] + up[1] * Mag.holdUp[1] + up[2] * Mag.holdUp[2], -1, 1)) / D2R : 99;
  Mag.tiltMoved = moved;
  if (!Mag.holdQ || moved > 8 || Mag.calibrating) { Mag.holdQ = q.slice(); Mag.holdUp = up; Mag.hsEma = 0; if (moved > 8 && moved < 99) Mag.relocks = (Mag.relocks || 0) + 1; }
  Mag.still = moved <= 8;
  let hd = yawOf(qmul(q, qconj(Mag.holdQ)));
  Mag.hsEma = (Mag.hsEma || 0) + (hd - (Mag.hsEma || 0)) * 0.35; // geomagnetic heading is jittery without a gyro
  if (!Mag.calibrating) {
    if (Math.abs(Mag.hsEma) < 2.5) Mag.holdQ = qslerpTo(Mag.holdQ, q, 0.02);
    else if (GYRO_PATHS.some(p => fresh(p, 600))) Mag.holdQ = qslerpTo(Mag.holdQ, q, 0.0015); // phones with a gyro: slowly forget a flat spin
  }
  feedYaw('heading-still', Mag.hsEma, true);
}

const Y = {};
function feedYaw(src, yaw, isDelta) {
  markSeen(src);
  const y = Y[src] || (Y[src] = { base: null, prev: null, unw: 0, samples: [], d: 0 });
  if (y.prev == null) { y.prev = yaw; y.unw = yaw; } else { y.unw += wrap180(yaw - y.prev); y.prev = yaw; }
  if (Mag.calibrating) { y.samples.push(y.unw); y.d = 0; return y; }
  if (y.base == null) y.base = y.unw;
  let d = isDelta ? yaw : y.unw - y.base;
  if (!isDelta && Math.abs(d) < 2.5) y.base += d * 0.02; // follow slow drift, never while a magnet is near
  if (src === 'ios-compass' && Mag.iosAcc0 != null && Mag.iosAcc != null) {
    const extra = Mag.iosAcc < 0 ? 40 : Math.max(0, Mag.iosAcc - Mag.iosAcc0 - 5) * 1.2;
    if (extra > Math.abs(d)) d = (Math.sign(d) || 1) * extra;
  }
  y.d = d; y.t = now();
  return y;
}

/* pick the answer each frame */
const GYRO_PATHS = ['fusion-sensor', 'fusion-events', 'gyro-check'];
function combineSensors() {
  if (fresh('magnetometer', 600)) { Mag.source = 'magnetometer'; return; }
  let best = null;
  for (const p of GYRO_PATHS) if (fresh(p, 600) && Y[p] && (!best || Math.abs(Y[p].d) > Math.abs(Y[best].d))) best = p;
  if (fresh('ios-compass', 600)) best = 'ios-compass';
  // phones whose "gyro" is computed from the compass: gyro paths see nothing, the still-check sees the magnet
  const hs = Y['heading-still'];
  if (hs && fresh('heading-still', 600) && Math.abs(hs.d) > 8 && (!best || Math.abs(Y[best].d) < 4)) best = best ? best + '+still' : 'heading-still';
  if (!best && hs && fresh('heading-still', 600)) best = 'heading-still';
  if (!best) { Mag.target = 0; if (!fresh('evAbs') && !fresh('gsAbs')) Mag.source = 'none'; return; }
  const key = best.endsWith('+still') ? 'heading-still' : best;
  const d = Y[key].d, a = Math.abs(d);
  Mag.source = best;
  Mag.target = Math.pow(clamp((a - 5) / 40, 0, 1), 0.8);
  if (a > 5) Mag.sign = Math.sign(d);
  Mag.dirX = null; Mag.dirY = null;
  Mag.readout = d.toFixed(0) + '°';
}
function onMagReading(x, y, z) {
  markSeen('magnetometer');
  const v = [x, y, z];
  const rq = (Mag.gsRelQ && fresh('gsRel', 300)) ? Mag.gsRelQ : (Mag.relQ && fresh('evRel', 300)) ? Mag.relQ : null;
  if (Mag.calibrating) { Mag.magSamples.push({ v, w: rq ? qrot(rq, v) : null }); return; }
  if (!Mag.magBase) Mag.magBase = v.slice();
  let exp = Mag.magBase;
  if (rq && Mag.magWorld0) exp = qrot(qconj(rq), Mag.magWorld0); // earth field as it should read in today's pose
  const d = [v[0] - exp[0], v[1] - exp[1], v[2] - exp[2]];
  const m = Math.hypot(d[0], d[1], d[2]);
  if (m < 6 && !Mag.magWorld0) for (let i = 0; i < 3; i++) Mag.magBase[i] += d[i] * 0.02;
  Mag.magDev = d; Mag.magMag = m;
  Mag.target = Math.pow(clamp((m - 10) / 110, 0, 1), 0.7);
  const xy = Math.hypot(d[0], d[1]);
  if (xy > 0.35 * m && m > 8) { Mag.dirX = d[0] / xy; Mag.dirY = -d[1] / xy; } else { Mag.dirX = 0; Mag.dirY = -1; }
  Mag.sign = Math.sign(d[0]) || 1;
  Mag.readout = Math.round(m) + ' µT';
}
function bestSource() {
  if (fresh('magnetometer', 1500)) return 'magnetometer';
  for (const s of ['fusion-sensor', 'fusion-events', 'gyro-check', 'ios-compass', 'heading-still']) if (fresh(s, 1500)) return s;
  return 'none';
}

function finishCalibration() {
  Mag.calibrating = false;
  for (const k in Y) {
    const y = Y[k];
    if (y.samples.length) { const s = y.samples.slice(Math.floor(y.samples.length / 3)); y.base = s.reduce((a, b) => a + b, 0) / s.length; }
    y.samples = []; y.d = 0;
  }
  if (Mag.magSamples.length) {
    const s = Mag.magSamples.slice(Math.floor(Mag.magSamples.length / 3));
    Mag.magBase = [0, 1, 2].map(i => s.reduce((a, b) => a + b.v[i], 0) / s.length);
    const ws = s.filter(o => o.w);
    Mag.magWorld0 = ws.length > s.length * 0.6 ? [0, 1, 2].map(i => ws.reduce((a, b) => a + b.w[i], 0) / ws.length) : null;
  }
  Mag.magSamples = [];
  Mag.iosAcc0 = (Mag.iosAcc != null && Mag.iosAcc >= 0) ? Mag.iosAcc : null;
  const q = Mag.gsAbsQ || Mag.absQ; if (q) { Mag.gyroQ = q.slice(); Mag.holdQ = q.slice(); Mag.holdUp = qrot(qconj(q), [0, 0, 1]); Mag.hsEma = 0; }
  if (Y['gyro-check']) { Y['gyro-check'].base = null; Y['gyro-check'].prev = null; }
  Mag.strength = 0; Mag.target = 0;
}

function sensorLabel(src) {
  const base = src.replace('+still', '');
  const L = {
    'magnetometer': 'Real magnetometer (direction-aware)',
    'fusion-sensor': 'Compass vs gyro (orientation sensors)',
    'fusion-events': 'Compass vs gyro (orientation events)',
    'gyro-check': 'Compass vs raw gyro (motion events)',
    'ios-compass': 'iPhone compass vs gyro',
    'heading-still': 'Compass jump while phone is still',
    'none': 'No compass sensor found here',
  };
  return (L[base] || base) + (src.endsWith('+still') ? ' + still-check' : '');
}

/* where is the magnet, in stage pixels */
function sensorMagnetPos() {
  const W = state.W, H = state.H, pad = 10;
  const side = state.side;
  if (side === 'top') return [W / 2, pad];
  if (side === 'bottom') return [W / 2, H - pad];
  if (side === 'left') return [pad, H * 0.42];
  if (side === 'right') return [W - pad, H * 0.42];
  if (side === 'center') return [W / 2, H / 2];
  let dx, dy;
  if (Mag.dirX != null) { dx = Mag.dirX * state.flip; dy = Mag.dirY * (Mag.source === 'magnetometer' ? state.flip : 1); }
  else { dx = (Mag.sign || 1) * state.flip; dy = -0.35; }
  const cx = W / 2, cy = H * 0.45, n = Math.hypot(dx, dy) || 1; dx /= n; dy /= n;
  const tx = dx > 0 ? (W - pad - cx) / dx : dx < 0 ? (pad - cx) / dx : Infinity;
  const ty = dy > 0 ? (H - pad - cy) / dy : dy < 0 ? (pad - cy) / dy : Infinity;
  const t = Math.min(tx, ty);
  return [cx + dx * t, cy + dy * t];
}

/* ------------------------------------------------------------------ status chip */
let chipLast = '';
function updateChip() {
  let txt, cls;
  if (!state.started) { txt = 'Tap Start 🧲'; cls = 'warn'; }
  else if (Mag.calibrating) { txt = 'Calibrating… phone still rakho'; cls = 'warn'; }
  else if (Mag.source === 'none') { txt = 'No sensor · hold screen = magnet'; cls = 'warn'; }
  else if (Mag.strength > 0.12) { txt = '🧲 MAGNET DETECTED · ' + Mag.readout; cls = 'ok live'; }
  else { txt = Mag.source === 'magnetometer' ? '🧲 Real magnet sensor ON' : '🧲 Magnet sensor ON'; cls = 'ok'; }
  const key = txt + cls;
  if (key !== chipLast) { chipLast = key; chipText.textContent = txt; chip.className = 'chip ' + cls; }
}

/* ------------------------------------------------------------------ HOME PHYSICS */
const CAT_WALL = 0x1, CAT_ITEM = 0x2;
const engine = Engine.create({ gravity: { x: 0, y: 0, scale: 0.001 }, positionIterations: 8, velocityIterations: 6 });
let walls = [], items = [];

function makeWalls(eng, W, H, list) {
  list.forEach(w => Composite.remove(eng.world, w));
  const t = 200, o = { isStatic: true, restitution: 0.4, friction: 0.1, collisionFilter: { category: CAT_WALL } };
  const nw = [
    Bodies.rectangle(W / 2, -t / 2, W + 2 * t, t, o), Bodies.rectangle(W / 2, H + t / 2, W + 2 * t, t, o),
    Bodies.rectangle(-t / 2, H / 2, t, H + 2 * t, o), Bodies.rectangle(W + t / 2, H / 2, t, H + 2 * t, o)];
  Composite.add(eng.world, nw); return nw;
}

function fitHome() {
  const H = stage.clientHeight; let s = window.innerHeight < 620 ? 0.74 : window.innerHeight < 700 ? 0.86 : 1;
  homeEl.style.setProperty('--s', s);
  for (let i = 0; i < 8 && homeEl.scrollHeight > H + 1 && s > 0.55; i++) { s -= 0.05; homeEl.style.setProperty('--s', s.toFixed(2)); }
}

function buildHome() {
  state.W = stage.clientWidth; state.H = stage.clientHeight;
  items.forEach(it => Composite.remove(engine.world, it.body));
  items = [];
  homeEl.classList.remove('phys');
  const els = $$('.it', homeEl);
  els.forEach(el => { el.style.transform = ''; el.style.width = ''; el.style.height = ''; el.classList.remove('eaten'); el.style.opacity = ''; });
  fitHome();
  const hr = homeEl.getBoundingClientRect();
  const rects = els.map(el => el.getBoundingClientRect());
  homeEl.classList.add('phys');
  walls = makeWalls(engine, state.W, state.H, walls);
  els.forEach((el, i) => {
    const r = rects[i], w = r.width, h = r.height, x = r.left - hr.left + w / 2, y = r.top - hr.top + h / 2;
    el.style.width = w + 'px'; el.style.height = h + 'px';
    const body = Bodies.rectangle(x, y, w, h, {
      chamfer: { radius: Math.min(w, h) * 0.22 }, restitution: 0.3, friction: 0.08, frictionAir: 0.015,
      density: 0.0012, collisionFilter: { category: CAT_ITEM, mask: CAT_WALL | CAT_ITEM }, slop: 0.02,
    });
    // farther-from-edge, bigger things hold on harder; small letters break away first
    const th = clamp(0.18 + Math.random() * 0.5 + Math.sqrt(w * h) / 900, 0.15, 0.95);
    const it = { el, body, w, h, hx: x, hy: y, th, st: 'held', sc: 1 };
    Composite.add(engine.world, body);
    items.push(it); render1(it);
  });
  state.eaten = 0;
  if (state.mode === 'gravity') items.forEach(freeIt);
}

function setMask(it, on) { it.body.collisionFilter.mask = on ? (CAT_WALL | CAT_ITEM) : 0; }
function freeIt(it) { if (it.st === 'eaten') return; it.st = 'free'; setMask(it, true); }
function homeAll() { items.forEach(it => { if (it.st === 'free') { it.st = 'homing'; setMask(it, false); } }); }
function resetAll() {
  items.forEach(it => {
    if (it.st === 'eaten') { it.st = 'homing'; it.sc = 1; it.el.classList.remove('eaten'); Body.setPosition(it.body, { x: it.hx, y: state.H + 60 }); }
    else if (it.st === 'free') it.st = 'homing';
    setMask(it, false);
  });
  state.eaten = 0;
}

function render1(it) {
  const p = it.body.position;
  it.el.style.transform = `translate3d(${(p.x - it.w / 2).toFixed(1)}px,${(p.y - it.h / 2).toFixed(1)}px,0) rotate(${it.body.angle.toFixed(3)}rad)` + (it.sc !== 1 ? ` scale(${it.sc.toFixed(3)})` : '');
}

/* magnets this frame: [{x,y,s}] */
const touches = new Map();
function currentMagnets() {
  const list = [];
  if (Mag.source !== 'none' && Mag.strength > 0.02) { const [x, y] = sensorMagnetPos(); list.push({ x, y, s: Mag.strength, sensor: true }); }
  const touchAllowed = Mag.source === 'none' || !state.started;
  if (touchAllowed || state.mode === 'gravity') {
    const t = now();
    touches.forEach(tp => { if (tp.hold && (touchAllowed)) list.push({ x: tp.x, y: tp.y, s: Math.min(1, (t - tp.t0 - 120) / 450), touch: true }); });
  }
  return list.filter(m => m.s > 0.02);
}

let lastActive = 0;
function stepHome() {
  const mags = currentMagnets();
  const t = now(), W = state.W, H = state.H, diag = Math.hypot(W, H);
  const active = mags.some(m => m.s > 0.04);
  if (active) lastActive = t;
  const released = t - lastActive > 350;

  // gravity
  if (state.mode === 'gravity' || (state.mode === 'magnet' && state.returnMode === 'drop' && released)) {
    let gx = 0, gy = 1;
    if (state.tilt.on && state.tilt.seen) { gx = state.tilt.x; gy = state.tilt.y; }
    const k = state.antigrav && state.mode === 'gravity' ? -1 : 1;
    engine.gravity.x = gx * k; engine.gravity.y = gy * k;
  } else { engine.gravity.x = 0; engine.gravity.y = 0; }

  if (state.mode === 'magnet' && released && state.returnMode === 'spring') homeAll();
  if (state.mode === 'magnet' && released && state.returnMode === 'drop') items.forEach(it => { if (it.st === 'held') { /* stays */ } });

  const R0 = diag * 0.42;
  for (const it of items) {
    const b = it.body, p = b.position;
    if (it.st === 'eaten') continue;
    // strongest pull on this item
    let P = 0, best = null, bd = 1e9;
    for (const m of mags) {
      const r = Math.hypot(m.x - p.x, m.y - p.y);
      const pull = m.s * clamp(Math.pow(R0 / Math.max(r, 30), 1.35), 0, 1.2);
      if (pull > P) { P = pull; best = m; bd = r; }
    }
    if (it.st === 'held') {
      if (P > it.th && state.mode !== 'gravity') {
        it.st = 'free'; setMask(it, true); buzz(6); blip(300 + Math.random() * 500, 0.05, 'triangle', 0.05);
        const dx = best.x - p.x, dy = best.y - p.y, n = Math.hypot(dx, dy) || 1;
        Body.setVelocity(b, { x: dx / n * 3, y: dy / n * 3 }); Body.setAngularVelocity(b, (Math.random() - 0.5) * 0.12);
      } else {
        const k = best ? P / it.th : 0;
        let ox = 0, oy = 0, a = 0;
        if (best && k > 0.2) {
          const dx = best.x - p.x, dy = best.y - p.y, n = Math.hypot(dx, dy) || 1, kk = (k - 0.2) / 0.8;
          ox = dx / n * kk * kk * 9 + (Math.random() - 0.5) * 3 * kk; oy = dy / n * kk * kk * 9 + (Math.random() - 0.5) * 3 * kk;
          a = (Math.random() - 0.5) * 0.12 * kk;
        }
        Body.setPosition(b, { x: it.hx + ox, y: it.hy + oy }); Body.setAngle(b, a);
        Body.setVelocity(b, { x: 0, y: 0 }); Body.setAngularVelocity(b, 0);
        continue;
      }
    }
    if (it.st === 'homing') {
      if (P > it.th * 0.8 && mags.length) { it.st = 'free'; setMask(it, true); }
      else {
        const dx = it.hx - p.x, dy = it.hy - p.y;
        Body.setVelocity(b, { x: b.velocity.x * 0.72 + dx * 0.09, y: b.velocity.y * 0.72 + dy * 0.09 });
        Body.setAngularVelocity(b, b.angularVelocity * 0.7 - b.angle * 0.08);
        if (Math.abs(dx) < 0.8 && Math.abs(dy) < 0.8 && Math.hypot(b.velocity.x, b.velocity.y) < 0.8 && Math.abs(b.angle) < 0.02) {
          it.st = 'held'; Body.setPosition(b, { x: it.hx, y: it.hy }); Body.setAngle(b, 0); setMask(it, true);
        }
        continue;
      }
    }
    // free: magnet forces (inverse-square-ish, clamped)
    let near = false;
    for (const m of mags) {
      const dx = m.x - p.x, dy = m.y - p.y, r = Math.max(Math.hypot(dx, dy), 1);
      const acc = m.s * 2.4 * Math.max(0.16, Math.min(1, Math.pow(160 / r, 2)));
      Body.applyForce(b, p, { x: dx / r * acc * b.mass / DT2, y: dy / r * acc * b.mass / DT2 });
      if (r < 70 + Math.max(it.w, it.h) * 0.6 && m.s > 0.15) near = true;
      if (state.blackHole && state.mode === 'magnet' && m.s > 0.25 && r < 34 + 40 * m.s) eat(it, m);
    }
    b.frictionAir = near ? 0.14 : (state.mode === 'gravity' ? 0.01 : 0.018);
    const sp = Math.hypot(b.velocity.x, b.velocity.y);
    if (sp > 38) Body.setVelocity(b, { x: b.velocity.x * 38 / sp, y: b.velocity.y * 38 / sp });
  }
  // eaten animation
  for (const it of items) if (it.st === 'eaten' && it.sc > 0) {
    const b = it.body, m = it.eatAt; it.sc = Math.max(0, it.sc - 0.06);
    Body.setPosition(b, { x: b.position.x + (m.x - b.position.x) * 0.25, y: b.position.y + (m.y - b.position.y) * 0.25 });
    Body.setAngle(b, b.angle + 0.35); Body.setVelocity(b, { x: 0, y: 0 });
  }
  Engine.update(engine, DT);
  return mags;
}
function eat(it, m) {
  if (it.st === 'eaten') return;
  it.st = 'eaten'; it.eatAt = { x: m.x, y: m.y }; setMask(it, false); it.el.classList.add('eaten'); state.eaten++;
  buzz(12); blip(900, 0.12, 'sine', 0.05);
  if (state.eaten === items.length) setTimeout(() => toast('Sab kha gaya 😈 · tap ↺ Reset'), 300);
}

// collisions: snap feedback
Events.on(engine, 'collisionStart', e => {
  for (const pr of e.pairs) {
    const a = pr.bodyA, b = pr.bodyB; if (a.isStatic || b.isStatic) continue;
    const rv = Math.hypot(a.velocity.x - b.velocity.x, a.velocity.y - b.velocity.y);
    if (rv > 6) { buzz(5); blip(180 + rv * 18, 0.04, 'square', 0.03); }
  }
});

/* ------------------------------------------------------------------ magnet visuals */
let visS = 0;
function drawMagnetVis(mags) {
  const m = mags.length ? mags.reduce((a, b) => (b.s > a.s ? b : a)) : null;
  const s = m ? m.s : 0; visS += (s - visS) * 0.2;
  if (visS < 0.01 || !m) { edgeGlow.style.opacity = 0; magnetMark.style.opacity = 0; holeEl.style.opacity = 0; return; }
  if (state.blackHole && state.mode === 'magnet') {
    holeEl.style.opacity = Math.min(1, visS * 1.6);
    holeEl.style.transform = `translate3d(${m.x}px,${m.y}px,0) scale(${0.45 + visS * 0.75})`;
    magnetMark.style.opacity = 0; edgeGlow.style.opacity = visS * 0.6;
  } else {
    holeEl.style.opacity = 0;
    edgeGlow.style.opacity = Math.min(1, visS * 1.3);
    const cx = clamp(m.x, 24, state.W - 24), cy = clamp(m.y, 24, state.H - 24);
    const ang = Math.atan2(state.H / 2 - m.y, state.W / 2 - m.x) * 180 / Math.PI + 45 + 180;
    magnetMark.style.opacity = m.touch ? 0.85 : Math.min(1, visS * 1.5);
    magnetMark.style.transform = `translate3d(${cx}px,${cy}px,0) rotate(${ang.toFixed(0)}deg) scale(${0.8 + visS * 0.4})`;
  }
  edgeGlow.style.transform = `translate3d(${m.x}px,${m.y}px,0) scale(${0.6 + visS * 0.8})`;
}

/* ------------------------------------------------------------------ COMBINE LAB */
const ELEM = {
  water: ['💧', 'Water'], fire: ['🔥', 'Fire'], earth: ['🌍', 'Earth'], air: ['💨', 'Air'], energy: ['⚡', 'Energy'], plus: ['➕', 'Plus'],
  steam: ['♨️', 'Steam'], plant: ['🌱', 'Plant'], lava: ['🌋', 'Lava'], sand: ['🏖️', 'Sand'], cloud: ['☁️', 'Cloud'], storm: ['⛈️', 'Storm'],
  boom: ['💥', 'Boom'], multiply: ['✖️', 'Multiply'], math: ['🔢', 'Math'], calc: ['🧮', 'Calculator'], stone: ['🪨', 'Stone'], metal: ['🔩', 'Metal'],
  glass: ['🪟', 'Glass'], chip: ['🔲', 'Chip'], battery: ['🔋', 'Battery'], turbo: ['🚀', 'Turbo Charge'], brain: ['🧠', 'Brain'],
  computer: ['🖥️', 'Computer'], phone: ['📱', 'Phone'], internet: ['🌐', 'Internet'], ai: ['🤖', 'AI'], laptop: ['💻', 'Laptop'],
  server: ['🗄️', 'Data Center'], reels: ['🎬', 'Reels'], creator: ['🤳', 'Creator'], viral: ['🌟', 'Viral'], chatbot: ['💬', 'Chatbot'],
  aivideo: ['🎥', 'AI Video'], password: ['🔐', 'Password'], hacker: ['🕵️', 'Hacker'], satellite: ['🛰️', 'Satellite'], gps: ['📍', 'GPS'],
  autodm: ['📩', 'Auto DM'], robot: ['🦾', 'Robot'], blast: ['🧨', 'Phone Blast'], techography: ['👑', 'TECHOGRAPHY'],
};
const BASE = ['water', 'fire', 'earth', 'air', 'energy', 'plus'];
const RECIPES = [
  ['water', 'fire', 'steam'], ['earth', 'water', 'plant'], ['earth', 'fire', 'lava'], ['earth', 'air', 'sand'], ['water', 'air', 'cloud'],
  ['cloud', 'energy', 'storm'], ['fire', 'fire', 'boom'], ['plus', 'plus', 'multiply'], ['plus', 'multiply', 'math'], ['math', 'plus', 'calc'],
  ['lava', 'water', 'stone'], ['stone', 'fire', 'metal'], ['sand', 'fire', 'glass'], ['sand', 'energy', 'chip'], ['metal', 'energy', 'battery'],
  ['battery', 'energy', 'turbo'], ['plant', 'energy', 'brain'], ['chip', 'math', 'computer'], ['chip', 'glass', 'phone'],
  ['computer', 'computer', 'internet'], ['computer', 'brain', 'ai'], ['computer', 'battery', 'laptop'], ['cloud', 'computer', 'server'],
  ['phone', 'internet', 'reels'], ['phone', 'reels', 'creator'], ['creator', 'internet', 'viral'], ['ai', 'internet', 'chatbot'],
  ['reels', 'ai', 'aivideo'], ['math', 'internet', 'password'], ['password', 'ai', 'hacker'], ['turbo', 'internet', 'satellite'],
  ['satellite', 'phone', 'gps'], ['chatbot', 'creator', 'autodm'], ['ai', 'metal', 'robot'], ['battery', 'fire', 'blast'],
  ['viral', 'creator', 'techography'],
];
const RMAP = {}; RECIPES.forEach(([a, b, c]) => { RMAP[[a, b].sort().join('+')] = c; });
const TOTAL = Object.keys(ELEM).length;
window.__combine = { ELEM, RECIPES, RMAP };

let disc = [];
try { disc = JSON.parse(localStorage.getItem('mp_disc') || '[]').filter(k => ELEM[k]); } catch (e) {}
disc = Array.from(new Set(BASE.concat(disc)));
const saveDisc = () => { try { localStorage.setItem('mp_disc', JSON.stringify(disc)); } catch (e) {} };

const cEngine = Engine.create({ gravity: { x: 0, y: 0 }, positionIterations: 8 });
let cWalls = [], els = [], grab = null, mergeQ = [];
const ER = 38;

function renderShelf() {
  const sh = $('#shelf'); sh.innerHTML = '';
  disc.forEach(k => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'sh'; b.dataset.k = k;
    b.innerHTML = `${ELEM[k][0]}<small>${ELEM[k][1]}</small>`; b.setAttribute('aria-label', 'Add ' + ELEM[k][1]);
    sh.appendChild(b);
  });
  $('#discCount').textContent = `Discovered ${disc.length}/${TOTAL}`;
}
function spawn(k, x, y, pop) {
  if (els.length >= 22) killEl(els[0]);
  const d = document.createElement('div'); d.className = 'el' + (k === 'techography' ? ' crown' : '') + (pop ? ' pop' : '');
  d.innerHTML = `<span class="e">${ELEM[k][0]}</span><span class="n">${ELEM[k][1]}</span>`;
  arena.appendChild(d);
  const W = state.W, H = state.H - 62;
  const body = Bodies.circle(clamp(x, ER + 4, W - ER - 4), clamp(y, ER + 40, H - ER), ER, { restitution: 0.5, friction: 0.02, frictionAir: 0.05, density: 0.002 });
  body.plugin.el = true;
  const e = { k, d, body, dead: false }; body.plugin.ref = e;
  Composite.add(cEngine.world, body); els.push(e);
  if (pop) setTimeout(() => d.classList.remove('pop'), 500);
  return e;
}
function killEl(e) { e.dead = true; Composite.remove(cEngine.world, e.body); e.d.remove(); els = els.filter(x => x !== e); if (grab && grab.e === e) grab = null; }
function buildCombo() {
  state.W = stage.clientWidth; state.H = stage.clientHeight;
  cWalls = makeWalls(cEngine, state.W, state.H - 58, cWalls);
  if (!els.length) seedArena();
  else els.forEach(e => Body.setPosition(e.body, { x: clamp(e.body.position.x, ER, state.W - ER), y: clamp(e.body.position.y, ER, state.H - 62 - ER) }));
}
function seedArena() {
  els.slice().forEach(killEl);
  const W = state.W, H = state.H - 62;
  BASE.forEach((k, i) => { const c = i % 3, r = Math.floor(i / 3); spawn(k, W * (0.22 + c * 0.28), H * (0.3 + r * 0.32), true); });
  spawn('plus', W * 0.5, H * 0.12 + 40, true);
}
function sparks(x, y, n = 16, col) {
  for (let i = 0; i < n; i++) {
    const s = document.createElement('span'); s.className = 'spark';
    const a = Math.random() * Math.PI * 2, d = 40 + Math.random() * 70;
    s.style.left = x + 'px'; s.style.top = y + 'px';
    s.style.background = col || ['#00f0ff', '#ff2bd6', '#a6ff00', '#ffd400'][i % 4];
    s.style.setProperty('--dx', Math.cos(a) * d + 'px'); s.style.setProperty('--dy', Math.sin(a) * d + 'px');
    stage.appendChild(s); setTimeout(() => s.remove(), 650);
  }
}
Events.on(cEngine, 'collisionStart', ev => handlePairs(ev.pairs, false));
Events.on(cEngine, 'collisionActive', ev => handlePairs(ev.pairs, true));
function handlePairs(pairs, activeOnly) {
  for (const pr of pairs) {
    const A = pr.bodyA.plugin.ref, B = pr.bodyB.plugin.ref; if (!A || !B || A.dead || B.dead) continue;
    const grabbed = grab && (grab.e === A || grab.e === B);
    if (activeOnly && !grabbed) continue;
    const rv = Math.hypot(pr.bodyA.velocity.x - pr.bodyB.velocity.x, pr.bodyA.velocity.y - pr.bodyB.velocity.y);
    if (!grabbed && rv < 2.5) continue;
    const out = RMAP[[A.k, B.k].sort().join('+')];
    if (out) mergeQ.push([A, B, out]);
    else if (!activeOnly && grabbed && rv > 1) { blip(140, 0.05, 'square', 0.03); }
  }
}
function processMerges() {
  for (const [A, B, out] of mergeQ) {
    if (A.dead || B.dead) continue;
    const x = (A.body.position.x + B.body.position.x) / 2, y = (A.body.position.y + B.body.position.y) / 2;
    const ka = A.k, kb = B.k; killEl(A); killEl(B);
    const e = spawn(out, x, y, true);
    const isNew = !disc.includes(out);
    if (isNew) { disc.push(out); saveDisc(); renderShelf(); }
    sparks(x, y, isNew ? 26 : 14);
    buzz(isNew ? 30 : 12);
    if (state.sound) { blip(523, 0.12, 'sine', 0.07); setTimeout(() => blip(784, 0.18, 'sine', 0.07), 90); if (isNew) setTimeout(() => blip(1046, 0.25, 'sine', 0.06), 190); }
    const line = `${ELEM[ka][0]} + ${ELEM[kb][0]} = ${ELEM[out][0]} ${ELEM[out][1]}`;
    if (out === 'techography') { toast('👑 TECHOGRAPHY unlocked! Follow karo 🔥', 'newd', 3200); sparks(x, y, 40, '#ffd400'); }
    else toast(isNew ? `NEW! ${line}` : line, isNew ? 'newd' : '', 1800);
  }
  mergeQ = [];
}
function stepCombo() {
  if (grab && !grab.e.dead) {
    const b = grab.e.body, dx = grab.x - b.position.x, dy = grab.y - b.position.y;
    Body.setVelocity(b, { x: clamp(dx * 0.35, -30, 30), y: clamp(dy * 0.35, -30, 30) });
  }
  Engine.update(cEngine, DT);
  processMerges();
  for (const e of els) { const p = e.body.position; e.d.style.transform = `translate3d(${(p.x - ER).toFixed(1)}px,${(p.y - ER).toFixed(1)}px,0) rotate(${e.body.angle.toFixed(3)}rad)`; }
}
function hint() {
  const opts = RECIPES.filter(([a, b, c]) => disc.includes(a) && disc.includes(b) && !disc.includes(c));
  if (!opts.length) { toast('Sab discover ho gaya! 👑'); return; }
  const [a, b] = opts[Math.floor(Math.random() * opts.length)];
  toast(`Try ${ELEM[a][0]} + ${ELEM[b][0]} 🤔`, '', 2400);
}

/* ------------------------------------------------------------------ input */
function stagePt(e) { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
stage.addEventListener('pointerdown', e => {
  if (e.target.closest('#shelfWrap') || e.target.closest('a')) return;
  const p = stagePt(e);
  if (state.mode === 'combine') {
    const elx = e.target.closest('.el');
    if (elx) { const ref = els.find(x => x.d === elx); if (ref) { grab = { e: ref, x: p.x, y: p.y, id: e.pointerId }; elx.classList.add('grab'); } }
    try { stage.setPointerCapture(e.pointerId); } catch (_) {}
    return;
  }
  touches.set(e.pointerId, { x: p.x, y: p.y, x0: p.x, y0: p.y, t0: now(), hold: true });
  try { stage.setPointerCapture(e.pointerId); } catch (_) {}
  if (state.sound) ensureHum();
});
stage.addEventListener('pointermove', e => {
  const p = stagePt(e);
  if (grab && grab.id === e.pointerId) { grab.x = p.x; grab.y = p.y; return; }
  const tp = touches.get(e.pointerId); if (tp) { tp.x = p.x; tp.y = p.y; }
});
function endPtr(e) {
  if (grab && grab.id === e.pointerId) { if (!grab.e.dead) grab.e.d.classList.remove('grab'); grab = null; }
  const tp = touches.get(e.pointerId);
  if (tp) {
    touches.delete(e.pointerId);
    const dt = now() - tp.t0, mv = Math.hypot(tp.x - tp.x0, tp.y - tp.y0);
    if (dt < 220 && mv < 12 && state.mode !== 'combine') blast(tp.x, tp.y);
  }
}
stage.addEventListener('pointerup', endPtr);
stage.addEventListener('pointercancel', endPtr);
function blast(x, y) {
  if (state.mode === 'magnet' && Mag.source !== 'none' && state.started) return; // main mode: the magnet does the work
  sparks(x, y, 12); buzz(15); blip(120, 0.15, 'sawtooth', 0.06);
  for (const it of items) {
    if (it.st === 'eaten') continue;
    const p = it.body.position, dx = p.x - x, dy = p.y - y, r = Math.max(Math.hypot(dx, dy), 20);
    if (r > 260) continue;
    if (it.st !== 'free') freeIt(it);
    const k = (1 - r / 260) * 22;
    Body.setVelocity(it.body, { x: it.body.velocity.x + dx / r * k, y: it.body.velocity.y + dy / r * k });
    Body.setAngularVelocity(it.body, (Math.random() - 0.5) * 0.4);
  }
  lastActive = now();
}
$('#shelf').addEventListener('click', e => {
  const b = e.target.closest('.sh'); if (!b) return;
  spawn(b.dataset.k, state.W * (0.2 + Math.random() * 0.6), 60 + Math.random() * 60, true); buzz(6); blip(660, 0.05, 'sine', 0.05);
});
// no pull-to-refresh / page scroll, but allow the shelf & sheet to scroll
document.addEventListener('touchmove', e => { if (!e.target.closest('#shelf') && !e.target.closest('.sheetcard') && !e.target.closest('#controls')) e.preventDefault(); }, { passive: false });
document.addEventListener('gesturestart', e => e.preventDefault());

/* ------------------------------------------------------------------ controls & modes */
const controls = $('#controls');
function pill(label, on, fn, id) { const b = document.createElement('button'); b.type = 'button'; b.className = 'pillbtn' + (on ? ' on' : ''); b.textContent = label; if (id) b.id = id; b.addEventListener('click', fn); controls.appendChild(b); return b; }
function renderControls() {
  controls.innerHTML = '';
  if (state.mode === 'magnet') {
    pill(state.returnMode === 'spring' ? '🧲 Spring' : '⬇️ Drop', false, () => { state.returnMode = state.returnMode === 'spring' ? 'drop' : 'spring'; renderControls(); });
    pill('🕳️ Black hole', state.blackHole, () => { state.blackHole = !state.blackHole; if (!state.blackHole) resetAll(); renderControls(); toast(state.blackHole ? 'Black hole ON · magnet sab kha jayega 😈' : 'Magnet mode 🧲'); });
    pill('⇄ Flip', state.flip < 0, () => { state.flip *= -1; savePrefs(); renderControls(); toast('Direction flipped ⇄'); });
    pill('↺ Reset', false, () => { resetAll(); buzz(8); });
  } else if (state.mode === 'gravity') {
    pill('🙃 Anti-gravity', state.antigrav, () => { state.antigrav = !state.antigrav; items.forEach(freeIt); renderControls(); buzz(10); });
    pill(state.tilt.on ? '📱 Tilt ON' : '📱 Tilt OFF', state.tilt.on, async () => { if (!state.tilt.on) await askMotion(); state.tilt.on = !state.tilt.on; renderControls(); });
    pill('💥 Tap', false, () => toast('Screen pe tap karo 💥'));
    pill('↺ Reset', false, () => { state.mode = 'magnet'; resetAll(); state.mode = 'gravity'; setTimeout(() => items.forEach(freeIt), 1200); });
  } else {
    pill('💡 Hint', false, hint);
    pill('🧹 Clear', false, () => { els.slice().forEach(killEl); toast('Neeche se elements tap karke daalo 👇'); });
    pill('↺ Restart', false, seedArena);
  }
}
function setMode(m) {
  if (m === state.mode) return;
  const prev = state.mode; state.mode = m;
  $$('.tab').forEach(t => t.classList.toggle('on', t.dataset.mode === m));
  homeEl.classList.toggle('hidden', m === 'combine'); comboEl.classList.toggle('hidden', m !== 'combine');
  edgeGlow.style.opacity = 0; magnetMark.style.opacity = 0; holeEl.style.opacity = 0;
  if (m === 'combine') { buildCombo(); toast('Do cheezein milao ➕ kuch naya banao'); }
  if (m === 'gravity') { state.tilt.on = state.tilt.seen; items.forEach(freeIt); toast(state.tilt.seen ? 'Phone tilt karo 📱' : 'Tap = blast 💥'); }
  if (m === 'magnet') { state.blackHole = false; resetAll(); }
  if (prev === 'combine' && m !== 'combine') { /* home world untouched */ }
  renderControls(); buzz(6);
}
$$('.tab').forEach(t => t.addEventListener('click', () => setMode(t.dataset.mode)));

/* sound */
$('#soundBtn').addEventListener('click', () => {
  state.sound = !state.sound; $('#soundBtn').textContent = state.sound ? '🔊' : '🔇';
  if (state.sound) { ensureHum(); blip(880, 0.08, 'sine', 0.06); } else if (humGain) humGain.gain.value = 0;
});
/* help sheet */
const sheet = $('#sheet');
function openSheet() { $('#sensorLine').textContent = 'Sensor: ' + (state.started ? sensorLabel(Mag.source) : 'tap Start first'); syncSheet(); sheet.classList.remove('hidden'); }
function syncSheet() {
  $$('#sideSeg button').forEach(b => b.classList.toggle('on', b.dataset.side === state.side));
  $('#flipBtn').classList.toggle('on', state.flip < 0); $('#meterBtn').classList.toggle('on', state.meter);
}
chip.addEventListener('click', openSheet); $('#helpBtn').addEventListener('click', openSheet);
$('#sheetClose').addEventListener('click', () => sheet.classList.add('hidden'));
sheet.addEventListener('click', e => { if (e.target === sheet) sheet.classList.add('hidden'); });
$('#sideSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; state.side = b.dataset.side; savePrefs(); syncSheet(); });
$('#flipBtn').addEventListener('click', () => { state.flip *= -1; savePrefs(); syncSheet(); renderControls(); });
function toggleDebug() { state.meter = !state.meter; dbgEl.classList.toggle('hidden', !state.meter); $('#dbgBtn').classList.toggle('on', state.meter); syncSheet(); if (state.meter) drawDebug(); }
$('#meterBtn').addEventListener('click', toggleDebug);
$('#dbgBtn').addEventListener('click', toggleDebug);
$('#recalBtn').addEventListener('click', () => { sheet.classList.add('hidden'); calibrate(); });

/* ------------------------------------------------------------------ start + calibration */
async function askMotion() {
  const reqs = [];
  try { if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function') reqs.push(DeviceOrientationEvent.requestPermission()); } catch (e) {}
  try { if (window.DeviceMotionEvent && typeof DeviceMotionEvent.requestPermission === 'function') reqs.push(DeviceMotionEvent.requestPermission()); } catch (e) {}
  try { const r = await Promise.all(reqs.map(p => p.catch(() => 'denied'))); return r.every(x => x === 'granted'); } catch (e) { return false; }
}
async function queryPerms() {
  if (!navigator.permissions) return;
  for (const name of ['magnetometer', 'accelerometer', 'gyroscope']) { try { await navigator.permissions.query({ name }); } catch (e) {} }
}
let sensorsStarted = false;
$('#startBtn').addEventListener('click', async () => {
  audio(); // unlock audio on the gesture
  const p = askMotion(); // must be called inside the tap on iOS
  $('#start').classList.add('hidden');
  state.started = true;
  await p; queryPerms();
  if (!sensorsStarted) { sensorsStarted = true; startSensors(); }
  calibrate();
});
function calibrate() {
  const ov = $('#calib'), arc = $('#ringArc'); ov.classList.remove('hidden');
  $('#calibTitle').textContent = 'Calibrating…'; $('#calibSub').textContent = 'Phone still rakho, magnet abhi door rakho';
  for (const k in Y) { Y[k].samples = []; }
  Mag.magSamples = []; Mag.calibrating = true; Mag.strength = 0; Mag.target = 0;
  const T0 = now(), DUR = 1800;
  const tick = () => {
    const f = clamp((now() - T0) / DUR, 0, 1); arc.style.strokeDashoffset = (276.5 * (1 - f)).toFixed(1);
    if (f < 1) return requestAnimationFrame(tick);
    const src = bestSource();
    if (src === 'none' && now() - T0 < 3200) { $('#calibSub').textContent = 'Sensor dhoondh rahe hain…'; return requestAnimationFrame(tick); }
    finishCalibration(); Mag.source = bestSource();
    ov.classList.add('hidden');
    if (Mag.source === 'none') toast('Is browser mein compass sensor nahi mila. Screen ko hold karo = magnet 🧲', 'warn', 4200);
    else toast('Ready! Ab magnet paas lao 🧲', 'newd', 2600);
    buzz(20);
  };
  requestAnimationFrame(tick);
}

/* ------------------------------------------------------------------ clock */
function tickClock() {
  const d = new Date(), hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
  const t = `${hh}:${mm}`;
  if ($('#bigTime').textContent !== t) { $('#bigTime').textContent = t; $('#sbTime').textContent = t; }
  $('#bigDate').textContent = d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
}

/* ------------------------------------------------------------------ main loop */
let acc = 0, lastT = now(), lastDbg = 0;
const dbgEl = $('#debug');
const f1 = v => (v == null || isNaN(v)) ? '—' : (+v).toFixed(1);
function drawDebug() {
  const r = Mag.rates, yd = k => Y[k] && fresh(k, 1500) ? f1(Y[k].d) + '°' : '—';
  const lines = [
    'PATH  ' + (state.started ? sensorLabel(Mag.source) : 'not started'),
    'STRENGTH ' + (Mag.strength * 100).toFixed(0) + '%   ' + (Mag.readout || '') + '   side ' + state.side + (state.flip < 0 ? ' (flipped)' : ''),
    'HEADING ' + f1(Mag.heading) + '°   tilt Δ ' + f1(Mag.tiltMoved) + '° ' + (Mag.still ? '(steady)' : '(moved)') + '   gyro ' + (fresh('gyro') ? f1(Mag.rotRate) + '°/s' : 'none'),
    'Δ compass-vs-gyro  sensor ' + yd('fusion-sensor') + '  events ' + yd('fusion-events'),
    'Δ raw-gyro ' + yd('gyro-check') + '   still-jump ' + yd('heading-still') + '   iOS ' + yd('ios-compass'),
    'Hz  absEvt ' + (r.evAbs || 0) + ' relEvt ' + (r.evRel || 0) + ' absSens ' + (r.gsAbs || 0) + ' relSens ' + (r.gsRel || 0) + ' gyro ' + (r.gyro || 0) + ' mag ' + (r.magnetometer || 0) + ' ios ' + (r.ios || 0),
    'Magnetometer: ' + (fresh('magnetometer') ? f1(Mag.magMag) + ' µT' : (Mag.magError || 'no data')) + '   AbsSensor: ' + (fresh('gsAbs') ? 'ok' : (Mag.gsAErr || 'no data')),
  ];
  dbgEl.textContent = lines.join('\n');
}
function frame() {
  const t = now(); acc += Math.min(t - lastT, 100); lastT = t;
  // sensor smoothing (attack fast, release slower) + lose source if quiet
  if (state.started && !Mag.calibrating) {
    combineSensors();
    Mag.strength += (Mag.target - Mag.strength) * (Mag.target > Mag.strength ? 0.3 : 0.12);
    if (Mag.strength < 0.005) Mag.strength = 0;
  }
  let steps = 0, mags = [];
  while (acc >= DT && steps < 3) { if (state.mode === 'combine') stepCombo(); else mags = stepHome(); acc -= DT; steps++; }
  if (steps === 3) acc = 0;
  if (state.mode !== 'combine') { for (const it of items) render1(it); drawMagnetVis(mags); }
  if (humGain) humGain.gain.value = state.sound && state.mode !== 'combine' ? Math.min(0.08, visS * 0.08) : 0;
  if (state.meter && t - lastDbg > 100) { lastDbg = t; drawDebug(); }
  updateChip();
  requestAnimationFrame(frame);
}

let rz = 0;
window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (state.mode === 'combine') { buildCombo(); buildHomeLater = true; } else buildHome(); }, 250); });
let buildHomeLater = false;
const origSetMode = setMode;

function init() {
  tickClock(); setInterval(tickClock, 5000);
  buildHome(); renderShelf(); renderControls();
  requestAnimationFrame(frame);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  window.__mp = { state, items: () => items, els: () => els, setMode, Mag, Y, spawn, disc: () => disc };
}
(document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(() => setTimeout(init, 30));
})();
