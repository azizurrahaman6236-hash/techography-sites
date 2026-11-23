(() => {
'use strict';
const $ = (id) => document.getElementById(id);
let canvas = $('stage');
const stageBox = $('stageBox');

// ---------- errors never leave it stuck ----------
const VER = '8';
const overlay = $('loading');
function showError(msg) {
  overlay.hidden = false;
  overlay.innerHTML = '';
  const box = document.createElement('div'); box.className = 'err';
  box.textContent = msg;
  const btn = document.createElement('button'); btn.className = 'btn primary'; btn.textContent = 'Tap to retry';
  btn.onclick = () => location.replace(location.pathname + '?r=' + Date.now());
  box.appendChild(document.createElement('br')); box.appendChild(btn); overlay.appendChild(box);
}
let ready = false;
window.addEventListener('error', (e) => { if (!ready) showError('FURY hit an error while loading: ' + (e.message || 'unknown') + '.'); });
window.addEventListener('unhandledrejection', (e) => { if (!ready) showError('FURY hit an error while loading: ' + ((e.reason && e.reason.message) || e.reason || 'unknown') + '.'); });
setTimeout(() => { if (!ready) showError('FURY is taking too long to load. Check your internet and retry.'); }, 15000);

function loadImg(src) {
  return new Promise((res, rej) => {
    const i = new Image(); i.decoding = 'async';
    i.onload = () => res(i); i.onerror = () => rej(new Error('could not load ' + src));
    i.src = src + '?v=' + VER;
  });
}

// ---------- renderer: Ajju's original FURY (raymarched liquid glass) with a 2D fallback ----------
let gl = null, U = {}, ctx2d = null, IM = null, TEX = {}, rendererName = 'none';
const VS = `
        attribute vec2 a_pos;
        varying vec2 v_uv;
        void main() {
          v_uv = a_pos * 0.5 + 0.5;
          v_uv.y = 1.0 - v_uv.y;
          gl_Position = vec4(a_pos, 0.0, 1.0);
        }
      `;
const FS = `
        #ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
        varying vec2 v_uv;

        uniform sampler2D u_studioTex;
        uniform float u_aspectRatio;
        uniform float u_isVertical;
        uniform float u_time;
        uniform float u_phase;
        uniform float u_wavePhase;
        uniform float u_capillaryPhase;
        uniform float u_rms;
        uniform float u_subBass;
        uniform float u_low;
        uniform float u_mid;
        uniform float u_high;
        uniform float u_sibilance;
        uniform float u_emphasis;
        uniform float u_presence;
        uniform float u_peakHold;

        // Precomputed per-frame uniforms (eliminates ~2,000 redundant trig ops per pixel)
        uniform vec2 u_camDrift;
        uniform vec3 u_chairCenter;
        uniform vec3 u_invStretch;
        uniform float u_minStretch;
        uniform vec4 u_coreParams;     // x: baseRadius, y: rLobe, z: sminK, w: dropActivity
        uniform vec4 u_waveAmps;       // x: swellAmp, y: cymaticAmp, z: kelvinAmp, w: capAmp
        uniform float u_shockAmp;
        uniform vec3 u_gyroidOffset;
        uniform float u_boundRadiusSq;
        uniform vec3 u_lobeOffsets[5];
        uniform vec4 u_droplets[7];    // xyz: dPos, w: dropR

        // Smooth polynomial minimum for coalescing liquid volumes
        float smin(float a, float b, float k) {
          float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
          return mix(b, a, h) - k * h * (1.0 - h);
        }

        // 3D Gyroid / Acoustic harmonic wave field
        float acousticGyroid(vec3 p) {
          vec3 q = p * 13.5 + u_gyroidOffset;
          return dot(sin(q), cos(q.yzx)) * 0.3333333;
        }

        // Directional cross-wave interference (standing + travelling water waves)
        float multiWaveInterference(vec3 p) {
          // Wave Type 1: Deep gravity swell driven by vocal fundamental & sub-bass
          float swell = sin(p.y * 9.0 - u_phase * 2.2 + cos(p.x * 7.0 + u_phase)) * u_waveAmps.x;

          // Wave Type 2: Cymatic standing nodal waves driven by mid-range vowel formants
          float cymatic = acousticGyroid(p) * u_waveAmps.y;

          // Wave Type 3: Crisscrossing diagonal Kelvin-wake surface waves during energetic speech
          float diagA = sin((p.x * 0.8 + p.y * 0.6) * 24.0 - u_wavePhase * 3.8);
          float diagB = cos((p.x * 0.6 - p.y * 0.8) * 26.0 + u_wavePhase * 3.4);
          float kelvinWave = (diagA * diagB) * u_waveAmps.z;

          // Wave Type 4: High-frequency capillary micro-ripples driven by treble & sibilance
          float cap1 = sin(p.x * 46.0 + p.y * 38.0 - u_capillaryPhase * 4.2);
          float cap2 = cos(p.y * 52.0 - p.z * 44.0 + u_capillaryPhase * 4.8);
          float capillary = (cap1 + cap2) * u_waveAmps.w;

          // Wave Type 5: Concentric spherical shockwave ripples triggered by spoken word emphasis
          float r = length(p);
          float shockwave = sin(r * 44.0 - u_wavePhase * 6.2) * exp(-r * 3.2) * u_shockAmp;

          return swell + cymatic + kelvinWave + capillary + shockwave;
        }

        // Signed Distance Field for FURY — Floating directly above the empty studio chair
        float mapFury(vec3 p) {
          vec3 q = p - u_chairCenter;

          // Amorphous non-humanoid fluid volume that morphs continuously with speech
          float dCore = (length(q * u_invStretch) - u_coreParams.x) * u_minStretch;

          // 5 organic liquid-water streams/lobes (positions precomputed on CPU once per frame)
          float rLobe = u_coreParams.y;
          float sminK = u_coreParams.z;
          for (int i = 0; i < 5; i++) {
            float dLobe = length(q - u_lobeOffsets[i]) - rLobe;
            dCore = smin(dCore, dLobe, sminK);
          }

          // Suspended micro-droplets detaching & coalescing in the air above the chair during speech
          if (u_coreParams.w > 0.01 && dCore < 0.18) {
            for (int j = 0; j < 7; j++) {
              vec4 dr = u_droplets[j];
              float dDrop = length(q - dr.xyz) - dr.w;
              dCore = smin(dCore, dDrop, 0.032);
            }
          }

          // Far-field skip: when ray is >0.055 away from fluid volume, surface waves (<0.035 max amp) cannot intersect
          if (dCore > 0.055) {
            return dCore - 0.025;
          }

          return dCore + multiWaveInterference(q);
        }

        // 4-Tap Tetrahedron Normal (33% fewer SDF evaluations than 6-tap central difference, identical precision)
        vec3 calcNormal(vec3 p) {
          const vec2 k = vec2(1.0, -1.0);
          const float h = 0.0018;
          return normalize(
            k.xyy * mapFury(p + k.xyy * h) +
            k.yyx * mapFury(p + k.yyx * h) +
            k.yxy * mapFury(p + k.yxy * h) +
            k.xxx * mapFury(p + k.xxx * h)
          );
        }

        // Sample studio environment with ultra-clean optical clarity
        vec3 sampleStudio(vec2 uv) {
          return texture2D(u_studioTex, clamp(uv, vec2(0.002), vec2(0.998))).rgb;
        }

        // Subtle 35mm cinema sensor grain so the composite never looks synthetic
        float filmGrain(vec2 uv, float t) {
          return fract(sin(dot(uv + fract(t * 0.13), vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
        }

        void main() {
          vec2 studioUV = clamp(v_uv + u_camDrift, vec2(0.002), vec2(0.998));
          vec3 baseStudio = sampleStudio(studioUV);

          // ------------------------------------------------------------------
          // 1. REAL-TIME VOICE-REACTIVE AMPLIFIER LED METER ON THE STUDIO DESK
          // Dynamically aligned to the preamp unit in both 16:9 and 9:16 studio frames
          // ------------------------------------------------------------------
          vec2 ledMin = mix(vec2(0.725, 0.812), vec2(0.478, 0.806), u_isVertical);
          vec2 ledMax = mix(vec2(0.742, 0.872), vec2(0.518, 0.854), u_isVertical);

          if (studioUV.x >= ledMin.x && studioUV.x <= ledMax.x && studioUV.y >= ledMin.y && studioUV.y <= ledMax.y) {
            vec2 localLed = (studioUV - ledMin) / (ledMax - ledMin);
            float colMask = smoothstep(0.08, 0.15, localLed.x) * (1.0 - smoothstep(0.42, 0.48, localLed.x))
                          + smoothstep(0.54, 0.60, localLed.x) * (1.0 - smoothstep(0.86, 0.93, localLed.x));
            float levelY = 1.0 - localLed.y;
            float segIndex = floor(levelY * 14.0);
            float segFract = fract(levelY * 14.0);
            float segMask = smoothstep(0.12, 0.22, segFract) * (1.0 - smoothstep(0.76, 0.88, segFract));

            float chOffset = localLed.x < 0.5 ? u_low * 0.09 : u_mid * 0.09;
            float activeLevel = clamp(u_rms * 1.50 + u_emphasis * 0.38 + chOffset, 0.04, 1.0);
            float segNorm = (segIndex + 0.5) / 14.0;

            float isLit = step(segNorm, activeLevel);
            float isPeakSeg = step(abs(segNorm - clamp(u_peakHold * 1.50, 0.06, 0.98)), 0.042);

            vec3 ledColor = mix(vec3(0.16, 0.96, 0.44), vec3(1.0, 0.78, 0.14), smoothstep(0.52, 0.80, segNorm));
            ledColor = mix(ledColor, vec3(1.0, 0.22, 0.18), smoothstep(0.80, 0.94, segNorm));

            float intensity = (isLit * 0.95 + isPeakSeg * 0.88) * colMask * segMask;
            baseStudio = mix(baseStudio * 0.35, ledColor * 1.38, clamp(intensity, 0.0, 1.0));
          }

          // Subtle physical LED reflection on the walnut desk surface right in front of the preamp
          vec2 glowCenter = mix(vec2(0.733, 0.895), vec2(0.498, 0.872), u_isVertical);
          vec2 deskGlowDiff = (studioUV - glowCenter) * vec2(23.8095, 50.0);
          float deskGlowSq = dot(deskGlowDiff, deskGlowDiff);
          if (deskGlowSq < 9.0) {
            float deskGlow = exp(-deskGlowSq) * (u_rms * 0.24 + u_emphasis * 0.15);
            baseStudio += vec3(0.15, 0.80, 0.36) * deskGlow;
          }

          // ------------------------------------------------------------------
          // 2. ULTRA-TRANSPARENT MULTI-WAVE LIQUID-GLASS PRESENCE OVER THE CHAIR
          // ------------------------------------------------------------------
          vec2 p = (v_uv - 0.5) * 2.0;
          p.x *= u_aspectRatio;
          p.y = -p.y;

          const vec3 ro = vec3(0.0, 0.0, 1.45);
          vec3 rd = normalize(vec3(p, -1.65));

          vec3 oc = ro - u_chairCenter;
          float b = dot(oc, rd);
          float c = dot(oc, oc) - u_boundRadiusSq;
          float h = b * b - c;

          vec3 finalColor = baseStudio;

          if (h > 0.0) {
            float sqrtH = sqrt(h);
            float t = max(0.0, -b - sqrtH);
            float tMax = -b + sqrtH;
            bool hit = false;
            vec3 pos = ro;

            for (int i = 0; i < 32; i++) {
              if (t > tMax) break;
              pos = ro + rd * t;
              float d = mapFury(pos);
              if (d < 0.0018) {
                hit = true;
                break;
              }
              t += d * 0.76;
            }

            if (hit) {
              vec3 N = calcNormal(pos);
              vec3 V = -rd;
              float NdotV = max(0.0, dot(N, V));

              float activeVis = 0.045 + 0.955 * clamp(u_presence + u_emphasis * 0.38, 0.0, 1.0);

              // Multi-layered wave normal perturbation for intricate internal water ripples
              vec3 localP = pos - u_chairCenter;
              float radialR = length(localP.xy);
              float radialWave = sin(radialR * 48.0 - u_capillaryPhase * 5.5) * (0.008 * u_emphasis + 0.004 * u_sibilance) / (radialR + 0.001);
              vec2 multiWaveGrad = vec2(
                cos(localP.x * 36.0 - u_wavePhase * 4.2) * (0.004 * u_mid + 0.006 * u_high) + localP.x * radialWave,
                sin(localP.y * 34.0 + u_wavePhase * 3.9) * (0.004 * u_low + 0.006 * u_mid) + localP.y * radialWave
              );

              // Pure Snell's Law background distortion (100% transparent interior showing the chair behind Fury)
              float refractPower = (0.006 + 0.052 * activeVis + 0.028 * u_emphasis);
              vec2 refrOffset = (N.xy * refractPower) + multiWaveGrad * activeVis;
              refrOffset.y *= u_aspectRatio;

              // Subtle chromatic dispersion across wave crests (like real optical crown glass / pure water)
              float dispersion = 0.035 + 0.025 * (1.0 - NdotV);
              vec3 refractedStudio = vec3(
                sampleStudio(studioUV + refrOffset * (1.0 - dispersion)).r,
                sampleStudio(studioUV + refrOffset).g,
                sampleStudio(studioUV + refrOffset * (1.0 + dispersion)).b
              );

              // Ultra-delicate Fresnel reflection only at steep grazing edges & wave crests
              float oneMinusNdotV = 1.0 - NdotV;
              float oneMinusSq = oneMinusNdotV * oneMinusNdotV;
              float fresnel = oneMinusSq * oneMinusSq * oneMinusNdotV;

              const vec3 windowLightDir = vec3(0.7611, 0.4807, 0.4357);
              const vec3 warmPanelDir   = vec3(-0.6834, 0.2814, 0.6734);

              vec3 H1 = normalize(windowLightDir + V);
              vec3 H2 = normalize(warmPanelDir + V);

              // Razor-sharp specular glints on the moving water wave crests
              float specCrest = pow(max(0.0, dot(N, H1)), 140.0) * (0.18 + 0.75 * activeVis);
              float specRim   = pow(max(0.0, dot(N, H2)), 55.0)  * (0.05 + 0.20 * activeVis);

              // Internal caustic shimmer along wave ridges (pure light amplification, no opacity)
              float diagN = abs(N.x + N.y) * 0.70710678;
              float waveCaustic = (diagN * diagN * diagN) * (0.04 * u_high + 0.06 * u_emphasis) * activeVis;

              // Combine 100% transparent refracted background with ultra-restrained grazing speculars
              vec3 pureWaterGlass = refractedStudio * (1.0 + waveCaustic);
              pureWaterGlass += vec3(1.0, 0.99, 0.97) * specCrest * 0.68;
              pureWaterGlass += vec3(0.98, 0.84, 0.68) * specRim * 0.32;
              pureWaterGlass += vec3(0.92, 0.96, 1.0) * fresnel * (0.02 + 0.14 * activeVis);

              // Feather the outer boundary smoothly so Fury blends into the studio air with zero hard CG edge
              float boundaryFade = smoothstep(0.0, 0.22, 1.0 - NdotV * 0.15) * (0.12 + 0.88 * activeVis);
              finalColor = mix(baseStudio, pureWaterGlass, clamp(boundaryFade, 0.0, 0.98));
            }
          }

          // Add subtle physical camera grain so the frame looks like raw optical cinema footage
          finalColor += filmGrain(v_uv, u_time) * 0.006;

          gl_FragColor = vec4(clamp(finalColor, 0.0, 1.0), 1.0);
        }
      `;
function initGL() {
  const g = canvas.getContext('webgl', { alpha: false, antialias: true, preserveDrawingBuffer: true }) || canvas.getContext('experimental-webgl', { preserveDrawingBuffer: true });
  if (!g) throw new Error('WebGL not available');
  const sh = (type, src) => { const s = g.createShader(type); g.shaderSource(s, src); g.compileShader(s); if (!g.getShaderParameter(s, g.COMPILE_STATUS)) throw new Error('shader: ' + g.getShaderInfoLog(s)); return s; };
  const prog = g.createProgram();
  g.attachShader(prog, sh(g.VERTEX_SHADER, VS)); g.attachShader(prog, sh(g.FRAGMENT_SHADER, FS));
  g.linkProgram(prog); if (!g.getProgramParameter(prog, g.LINK_STATUS)) throw new Error('link: ' + g.getProgramInfoLog(prog));
  g.useProgram(prog);
  const buf = g.createBuffer(); g.bindBuffer(g.ARRAY_BUFFER, buf);
  g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), g.STATIC_DRAW);
  const aPos = g.getAttribLocation(prog, 'a_pos'); g.enableVertexAttribArray(aPos); g.vertexAttribPointer(aPos, 2, g.FLOAT, false, 0, 0);
  ['u_studioTex','u_aspectRatio','u_isVertical','u_time','u_phase','u_wavePhase','u_capillaryPhase','u_rms','u_subBass','u_low','u_mid','u_high','u_sibilance','u_emphasis','u_presence','u_peakHold','u_camDrift','u_chairCenter','u_invStretch','u_minStretch','u_coreParams','u_waveAmps','u_shockAmp','u_gyroidOffset','u_boundRadiusSq','u_lobeOffsets[0]','u_droplets[0]'].forEach(n => U[n] = g.getUniformLocation(prog, n));
  for (const k of ['h', 'v']) {
    const t = g.createTexture(); g.bindTexture(g.TEXTURE_2D, t);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE); g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR); g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, IM[k]); TEX[k] = t;
  }
  gl = g; rendererName = 'webgl';
  render(1.0);
  const e = g.getError(); if (e && e !== g.CONTEXT_LOST_WEBGL) { gl = null; throw new Error('WebGL error ' + e); }
}
function init2D() {
  const c2 = document.createElement('canvas'); c2.width = canvas.width; c2.height = canvas.height; c2.id = 'stage';
  c2.setAttribute('aria-label', 'FURY live preview');
  canvas.replaceWith(c2); canvas = c2;
  ctx2d = canvas.getContext('2d'); rendererName = '2d';
}
function render2DFallback(nowSec) {
        if (!ctx2d) return;
        const w = canvas.width;
        const h = canvas.height;
        const isVert = format === 'vertical';
        const activeImg = isVert ? IM.v : IM.h;

        ctx2d.clearRect(0, 0, w, h);
        if (activeImg) {
          ctx2d.drawImage(activeImg, 0, 0, w, h);
        } else {
          ctx2d.fillStyle = '#18181b';
          ctx2d.fillRect(0, 0, w, h);
        }

        // Draw Amplifier LED bar on the preamp
        const ledX = isVert ? w * 0.485 : w * 0.728;
        const ledY = isVert ? h * 0.850 : h * 0.868;
        const activeSegs = Math.min(14, Math.max(1, Math.round((furyState.smoothRms * 1.5 + furyState.emphasisPulse * 0.4) * 14)));
        for (let i = 0; i < 14; i++) {
          const sy = ledY - i * 2.5;
          ctx2d.fillStyle = i < activeSegs
            ? (i > 10 ? '#ef4444' : i > 7 ? '#f59e0b' : '#22c55e')
            : 'rgba(255,255,255,0.08)';
          ctx2d.fillRect(ledX, sy, 5, 1.6);
          ctx2d.fillRect(ledX + 8, sy, 5, 1.6);
        }

        // Draw Ultra-Transparent Refractive Presence over the Studio Chair
        const cx = isVert ? w * 0.50 : w * 0.35;
        const cy = (isVert ? h * 0.42 : h * 0.46) + Math.sin(nowSec * 1.2) * 4;
        const vis = 0.05 + 0.95 * Math.min(1, furyState.presence + furyState.emphasisPulse * 0.38);
        const baseR = (isVert ? 105 : 92) + furyState.smoothRms * 58 + furyState.emphasisPulse * 26;

        ctx2d.save();
        ctx2d.beginPath();
        const steps = 64;
        for (let i = 0; i <= steps; i++) {
          const a = (i / steps) * Math.PI * 2;
          const wave = Math.sin(a * 3 + furyState.phase * 2) * (5 + 24 * furyState.smoothRms)
                     + Math.cos(a * 7 - furyState.wavePhase * 3.5) * (15 * furyState.mid + 18 * furyState.emphasisPulse)
                     + Math.sin(a * 14 + furyState.capillaryPhase * 4) * (8 * furyState.high);
          const r = baseR + wave;
          const x = cx + Math.cos(a) * r;
          const y = cy + Math.sin(a) * r * 1.1;
          if (i === 0) ctx2d.moveTo(x, y);
          else ctx2d.lineTo(x, y);
        }
        ctx2d.closePath();
        ctx2d.clip();

        if (activeImg) {
          const shift = 3 + 16 * vis;
          ctx2d.drawImage(activeImg, -shift, -shift * 0.6, w + shift * 2, h + shift * 1.2);
        }
        ctx2d.strokeStyle = 'rgba(255,255,255,' + (0.12 * vis).toFixed(3) + ')';
        ctx2d.lineWidth = 1.2;
        ctx2d.stroke();
        ctx2d.restore();
      }

      const lobeOffsetsArr = new Float32Array(15), dropletsArr = new Float32Array(28), dropRadSeeds = new Float32Array(7);
for (let j = 0; j < 7; j++) { const fv = (j * 0.41) - Math.floor(j * 0.41); dropRadSeeds[j] = 0.009 + 0.013 * fv; }
function smoothstepJS(e0, e1, x) { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }
function render(nowSec) {
  if (!gl) { if (ctx2d) render2DFallback(nowSec); return; }
  const isVert = format === 'vertical';
  nowSec = nowSec % 1000;
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, isVert ? TEX.v : TEX.h);
  const S = furyState, phase = S.phase, wavePhase = S.wavePhase, rms = S.smoothRms, low = S.low, mid = S.mid, high = S.high, emph = S.emphasisPulse, pres = S.presence;
  const camDriftX = Math.sin(nowSec * 0.50) * 0.0009 + Math.cos(nowSec * 0.21) * 0.0005, camDriftY = Math.cos(nowSec * 0.38) * 0.0008;
  const chairY = (isVert ? 0.14 : 0.05) + 0.012 * Math.sin(nowSec * 1.15), chairX = isVert ? 0.0 : -0.27;
  const stretchX = 1.0 + 0.20 * Math.sin(phase * 1.15) * (0.15 + mid), stretchY = 1.12 + 0.24 * Math.cos(phase * 0.92) * (0.15 + low), stretchZ = 1.0 + 0.18 * Math.sin(phase * 1.38);
  const minStretch = Math.min(stretchX, stretchY, stretchZ);
  const baseRadius = 0.21 + pres * 0.055 + low * 0.048 + emph * 0.036, rLobe = 0.075 + 0.062 * mid + 0.038 * emph, sminK = 0.10 + 0.055 * pres;
  const dropActivity = smoothstepJS(0.05, 0.40, rms + emph * 0.65);
  const extAmp = 0.03 + pres * 0.14 + rms * 0.19, radX = 0.11 + extAmp * 0.88, radY = 0.10 + extAmp * 0.78;
  for (let i = 0; i < 5; i++) { const ang = i * 1.256637 + phase * (0.58 + 0.11 * i), k = i * 3;
    lobeOffsetsArr[k] = Math.cos(ang) * radX; lobeOffsetsArr[k + 1] = Math.sin(ang * 1.35 + phase * 0.55) * radY; lobeOffsetsArr[k + 2] = Math.sin(ang) * 0.09; }
  if (dropActivity > 0.01) for (let j = 0; j < 7; j++) {
    const orbitA = j * 0.8976 + phase * (0.42 + 0.07 * j), radialOut = baseRadius + 0.07 + 0.12 * dropActivity * (0.5 + 0.5 * Math.sin(nowSec * 1.85 + j * 2.3)), k = j * 4;
    dropletsArr[k] = Math.cos(orbitA) * radialOut * 1.12; dropletsArr[k + 1] = Math.sin(orbitA * 1.45 + j) * radialOut * 0.92 + 0.03 * Math.cos(wavePhase + j);
    dropletsArr[k + 2] = Math.sin(orbitA) * 0.07; dropletsArr[k + 3] = dropRadSeeds[j] * dropActivity; }
  const maxExtent = Math.min(0.64, Math.max(baseRadius * 1.38, radX + rLobe + sminK * 0.65 + (dropActivity > 0.01 ? 0.14 * dropActivity : 0.0)) + 0.04);
  const w135 = wavePhase * 1.35;
  gl.uniform1i(U.u_studioTex, 0);
  gl.uniform1f(U.u_aspectRatio, isVert ? 0.5625 : 1.7777778); gl.uniform1f(U.u_isVertical, isVert ? 1 : 0); gl.uniform1f(U.u_time, nowSec);
  gl.uniform1f(U.u_phase, phase); gl.uniform1f(U.u_wavePhase, wavePhase); gl.uniform1f(U.u_capillaryPhase, S.capillaryPhase);
  gl.uniform1f(U.u_rms, rms); gl.uniform1f(U.u_subBass, S.subBass); gl.uniform1f(U.u_low, low); gl.uniform1f(U.u_mid, mid); gl.uniform1f(U.u_high, high);
  gl.uniform1f(U.u_sibilance, S.sibilance); gl.uniform1f(U.u_emphasis, emph); gl.uniform1f(U.u_presence, pres); gl.uniform1f(U.u_peakHold, S.peakHold);
  gl.uniform2f(U.u_camDrift, camDriftX, camDriftY); gl.uniform3f(U.u_chairCenter, chairX, chairY, 0.0);
  gl.uniform3f(U.u_invStretch, 1 / stretchX, 1 / stretchY, 1 / stretchZ); gl.uniform1f(U.u_minStretch, minStretch);
  gl.uniform4f(U.u_coreParams, baseRadius, rLobe, sminK, dropActivity);
  gl.uniform4f(U.u_waveAmps, 0.003 + 0.024 * low + 0.018 * S.subBass, 0.002 + 0.030 * mid + 0.014 * pres, 0.026 * rms + 0.020 * mid, 0.5 * (0.0008 + 0.014 * high + 0.018 * S.sibilance));
  gl.uniform1f(U.u_shockAmp, 0.028 * emph); gl.uniform3f(U.u_gyroidOffset, w135, -w135 * 0.73, w135 * 0.57);
  gl.uniform1f(U.u_boundRadiusSq, maxExtent * maxExtent);
  gl.uniform3fv(U['u_lobeOffsets[0]'], lobeOffsetsArr);
  if (dropActivity > 0.01) gl.uniform4fv(U['u_droplets[0]'], dropletsArr);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

// ---------- FURY physics (Ajju's original), stepped at a fixed 60 Hz so preview and export match ----------
function freshState() { return { rms: 0, smoothRms: 0, subBass: 0, low: 0, mid: 0, high: 0, sibilance: 0, emphasisPulse: 0, prevRms: 0, peakHold: 0, peakHoldDecay: 0, presence: 0, phase: 0, wavePhase: 0, capillaryPhase: 0, lastSpeechTime: 0 }; }
let furyState = freshState();
// AnalyserNode emulation (fftSize 1024, smoothing 0.70, -100..-30 dB) over the decoded voice, so it's exact and repeatable
const FFT_N = 1024, BINS = 512;
const fftRe = new Float32Array(FFT_N), fftIm = new Float32Array(FFT_N), smoothMag = new Float32Array(BINS), freqBytes = new Uint8Array(BINS);
const blackman = new Float32Array(FFT_N); for (let i = 0; i < FFT_N; i++) blackman[i] = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / FFT_N) + 0.08 * Math.cos(4 * Math.PI * i / FFT_N);
const bitrev = new Uint16Array(FFT_N); for (let i = 0; i < FFT_N; i++) { let r = 0; for (let b = 0; b < 10; b++) r |= ((i >> b) & 1) << (9 - b); bitrev[i] = r; }
function fft() {
  for (let i = 0; i < FFT_N; i++) { const j = bitrev[i]; if (j > i) { let t = fftRe[i]; fftRe[i] = fftRe[j]; fftRe[j] = t; t = fftIm[i]; fftIm[i] = fftIm[j]; fftIm[j] = t; } }
  for (let size = 2; size <= FFT_N; size <<= 1) {
    const half = size >> 1, step = -2 * Math.PI / size;
    for (let s = 0; s < FFT_N; s += size) for (let k = 0; k < half; k++) {
      const wr = Math.cos(step * k), wi = Math.sin(step * k), a = s + k, b = a + half;
      const tr = fftRe[b] * wr - fftIm[b] * wi, ti = fftRe[b] * wi + fftIm[b] * wr;
      fftRe[b] = fftRe[a] - tr; fftIm[b] = fftIm[a] - ti; fftRe[a] += tr; fftIm[a] += ti;
    }
  }
}
function analyserAt(t) { // returns rawRms and fills freqBytes
  const pcm = feat.pcm, end = Math.floor(t * 48000);
  let sumSq = 0;
  for (let i = 0; i < FFT_N; i++) {
    const idx = end - FFT_N + i; const x = (idx >= 0 && idx < pcm.length) ? pcm[idx] : 0;
    if ((i & 1) === 0) { const q = Math.round(Math.max(-1, Math.min(1, x)) * 128) / 128; sumSq += q * q; }
    fftRe[i] = x * blackman[i]; fftIm[i] = 0;
  }
  fft();
  for (let k = 0; k < BINS; k++) {
    const mag = Math.hypot(fftRe[k], fftIm[k]) / FFT_N;
    smoothMag[k] = 0.70 * smoothMag[k] + 0.30 * mag;
    const db = 20 * Math.log10(smoothMag[k] + 1e-12);
    freqBytes[k] = Math.max(0, Math.min(255, Math.floor(255 * (db + 100) / 70)));
  }
  return Math.min(1.0, Math.sqrt(sumSq / (FFT_N * 0.5)) * 3.6);
}
function stepFury(t, nowSec) {
  const S = furyState;
  if (feat && t >= 0 && t <= feat.dur) {
    const rawRms = analyserAt(t);
    let subSum = 0, lowSum = 0, midSum = 0, highSum = 0, sibSum = 0;
    for (let i = 1; i <= 5; i++) subSum += freqBytes[i];
    for (let i = 6; i <= 18; i++) lowSum += freqBytes[i];
    for (let i = 19; i <= 75; i++) midSum += freqBytes[i];
    for (let i = 76; i <= 170; i++) highSum += freqBytes[i];
    for (let i = 171; i <= 320; i++) sibSum += freqBytes[i];
    const rawSub = (subSum / 5) / 255, rawLow = (lowSum / 13) / 255, rawMid = (midSum / 57) / 255, rawHigh = (highSum / 95) / 255, rawSib = (sibSum / 150) / 255;
    const delta = rawRms - S.prevRms; S.prevRms = rawRms;
    if (delta > 0.05 && rawRms > 0.14) S.emphasisPulse = Math.min(1.0, S.emphasisPulse + delta * 4.2);
    S.rms = rawRms;
    S.smoothRms = S.smoothRms * 0.76 + rawRms * 0.24;
    S.subBass = S.subBass * 0.80 + rawSub * 0.20;
    S.low = S.low * 0.78 + rawLow * 0.22;
    S.mid = S.mid * 0.74 + rawMid * 0.26;
    S.high = S.high * 0.70 + rawHigh * 0.30;
    S.sibilance = S.sibilance * 0.65 + rawSib * 0.35;
    if (rawRms > 0.022) S.lastSpeechTime = nowSec;
    if (S.smoothRms > S.peakHold) { S.peakHold = S.smoothRms; S.peakHoldDecay = 0; }
    else { S.peakHoldDecay += 0.016; if (S.peakHoldDecay > 0.35) S.peakHold = Math.max(0.0, S.peakHold - 0.018); }
  } else {
    S.rms *= 0.88; S.smoothRms *= 0.90; S.subBass *= 0.90; S.low *= 0.90; S.mid *= 0.89; S.high *= 0.87; S.sibilance *= 0.85;
    S.prevRms = 0; S.peakHold = Math.max(0.0, S.peakHold - 0.02);
    smoothMag.fill(0);
  }
  S.emphasisPulse *= 0.88;
  const targetPresence = S.smoothRms > 0.018 ? Math.min(1.0, 0.18 + S.smoothRms * 1.50 + S.emphasisPulse * 0.38) : 0.0;
  const rate = targetPresence > S.presence ? 0.18 : 0.042;
  S.presence += (targetPresence - S.presence) * rate;
  S.phase += 0.010 + S.smoothRms * 0.068 + S.low * 0.045;
  S.wavePhase += 0.022 + S.smoothRms * 0.15 + S.mid * 0.09 + S.emphasisPulse * 0.14;
  S.capillaryPhase += 0.045 + S.high * 0.24 + S.sibilance * 0.28 + S.emphasisPulse * 0.20;
}
async function boot() {
  try {
    const [h, v] = await Promise.all(['assets/studio-h.jpg', 'assets/studio-v.jpg'].map(loadImg));
    IM = { h, v };
  } catch (e) { showError('Could not download FURY (' + e.message + '). Check your internet and retry.'); return; }
  sizeCanvas(false);
  try { if (/[?&]gl=0/.test(location.search)) throw new Error('2D mode requested'); initGL(); }
  catch (e) { console.warn('WebGL failed, using 2D fallback:', e); try { init2D(); } catch (e2) { showError('FURY could not start on this browser. Please open the link in Chrome.'); return; } }
  ready = true; overlay.hidden = true; setFormat(format);
  window.__furyRenderer = rendererName;
}
// ---------- format ----------
let format = 'vertical';
function setFormat(f) {
  if (recording) return;
  format = f;
  sizeCanvas(false);
  stageBox.className = 'stage ' + f;
  document.querySelectorAll('.seg-btn').forEach(b => { const on = b.dataset.fmt === f; b.classList.toggle('active', on); b.setAttribute('aria-checked', on); });
  resetDownload();
}
// preview: Ajju's adaptive resolution (1280x720 base, 0.75 on phones, auto 0.58-0.85 by frame time); export: full 1080p
const isMobileBrowser = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && window.innerWidth < 1024);
let renderScale = isMobileBrowser ? 0.75 : 1.0, avgFrameMs = 16.6, lastFrameTs = 0, frameCounter = 0;
function sizeCanvas(full) {
  let w, h;
  if (full) { const xs = parseFloat((location.search.match(/[?&]xs=([\d.]+)/) || [])[1] || '1') || 1; w = Math.round((format === 'vertical' ? 1080 : 1920) * xs / 2) * 2; h = Math.round((format === 'vertical' ? 1920 : 1080) * xs / 2) * 2; }
  else { const bw = format === 'vertical' ? 720 : 1280, bh = format === 'vertical' ? 1280 : 720; w = Math.round(bw * renderScale * 0.5) * 2; h = Math.round(bh * renderScale * 0.5) * 2; }
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
}
document.querySelectorAll('.seg-btn').forEach(b => b.addEventListener('click', () => setFormat(b.dataset.fmt)));

// ---------- audio ----------
let actx = null, audioBuf = null, feat = null, src = null, startAt = 0, playing = false, recDest = null;
function ctx() { if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)(); return actx; }

async function analyse(buffer) {
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(buffer.duration * 48000)), 48000);
  const s = off.createBufferSource(); s.buffer = buffer; s.connect(off.destination); s.start();
  const r = await off.startRendering();
  return { pcm: r.getChannelData(0), dur: buffer.duration };
}
async function loadAudio(arrayBuf, label) {
  const c = ctx();
  try {
    audioBuf = await c.decodeAudioData(arrayBuf.slice(0));
  } catch (e) {
    showInfo($('voiceInfo'), 'Could not read this audio file. Try MP3 or WAV.', true); return;
  }
  stopPlayback();
  feat = await analyse(audioBuf);
  $('tDur').textContent = fmt(audioBuf.duration); $('tCur').textContent = '0:00';
  showInfo($('voiceInfo'), '✓ ' + label + ' · ' + fmt(audioBuf.duration) + '');
  $('dropText').innerHTML = escapeHtml(label) + '<br><small>Tap to change</small>';
  ['playBtn', 'playBtn2', 'exportBtn'].forEach(id => $(id).disabled = false);
  resetDownload();
}
function escapeHtml(s) { return s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }
function fmt(s) { s = Math.max(0, s); return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'); }
function showInfo(el, msg, warn) { el.hidden = false; el.textContent = msg; el.classList.toggle('warn', !!warn); }

$('file').addEventListener('change', async (ev) => {
  const f = ev.target.files && ev.target.files[0]; if (!f) return;
  ctx().resume && ctx().resume();
  await loadAudio(await f.arrayBuffer(), f.name);
  ev.target.value = '';
});
const drop = $('drop');
['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', async e => { const f = e.dataTransfer.files[0]; if (f) await loadAudio(await f.arrayBuffer(), f.name); });

// mic recording
let micRec = null, micStream = null;
$('micBtn').addEventListener('click', async () => {
  const btn = $('micBtn');
  if (micRec && micRec.state === 'recording') { micRec.stop(); return; }
  try {
    ctx().resume && ctx().resume();
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true } });
  } catch (e) { showInfo($('voiceInfo'), 'Mic permission was blocked. Allow the mic in your browser settings, or upload a file.', true); return; }
  const chunks = []; micRec = new MediaRecorder(micStream);
  micRec.ondataavailable = e => e.data.size && chunks.push(e.data);
  micRec.onstop = async () => {
    micStream.getTracks().forEach(t => t.stop()); btn.classList.remove('recording'); btn.textContent = '🎙 Record with mic';
    const blob = new Blob(chunks, { type: micRec.mimeType });
    await loadAudio(await blob.arrayBuffer(), 'Mic recording');
  };
  micRec.start(); btn.classList.add('recording'); btn.textContent = '■ Stop recording';
  showInfo($('voiceInfo'), 'Recording… speak now, tap Stop when done.');
});

function startPlayback(toRecorder) {
  const c = ctx(); if (c.resume) c.resume();
  stopPlayback();
  src = c.createBufferSource(); src.buffer = audioBuf;
  src.connect(c.destination);
  if (toRecorder && recDest) src.connect(recDest);
  startAt = c.currentTime + 0.05;
  src.start(startAt);
  playing = true;
  src.onended = () => { if (src && src._me === mySrc) {} };
  const mySrc = src;
  src.onended = () => { if (src === mySrc) { playing = false; src = null; updatePlayBtns(); if (onEnd) { const f = onEnd; onEnd = null; f(); } } };
  updatePlayBtns();
}
let onEnd = null;
function stopPlayback() { if (src) { const s = src; src = null; try { s.stop(); } catch (e) {} } playing = false; updatePlayBtns(); }
function updatePlayBtns() { const t = playing ? '■ Stop' : '▶ Play preview'; $('playBtn').textContent = t; $('playBtn2').textContent = t; }
function togglePlay() { if (!audioBuf || recording) return; if (playing) stopPlayback(); else startPlayback(false); }
$('playBtn').addEventListener('click', togglePlay);
$('playBtn2').addEventListener('click', () => { togglePlay(); if (playing) stageBox.scrollIntoView({ behavior: 'smooth', block: 'start' }); });

// ---------- render loop ----------
const t0 = performance.now();
const rip = new Float32Array(12);
let lastT = 0;
function audioTime() {
  if (!playing || !actx) return -1;
  let t = actx.currentTime - startAt;
  if (!recording) t -= (actx.outputLatency || actx.baseLatency || 0);
  return t;
}
let lastStepAt = performance.now(), stepAcc = 0;
function frame() {
  requestAnimationFrame(frame);
  if (!ready || offlineExport) return;
  const now = performance.now();
  if (lastFrameTs > 0) { const dt = now - lastFrameTs; if (dt > 4 && dt < 120) { avgFrameMs = avgFrameMs * 0.92 + dt * 0.08; frameCounter++;
    if (isMobileBrowser && !recording && frameCounter % 30 === 0) { if (avgFrameMs > 20 && renderScale > 0.58) renderScale = Math.max(0.58, renderScale - 0.08); else if (avgFrameMs < 14.2 && renderScale < 0.85) renderScale = Math.min(0.85, renderScale + 0.05); } } }
  lastFrameTs = now;
  if (!recording) sizeCanvas(false);
  stepAcc += Math.min(0.25, (now - lastStepAt) / 1000); lastStepAt = now;
  const t = audioTime();
  let n = 0;
  while (stepAcc >= 1 / 60 && n < 8) { stepAcc -= 1 / 60; n++; stepFury(t < 0 ? -1 : t - stepAcc, now / 1000); }
  render((now - t0) / 1000);
  if (feat && t >= 0) {
    $('tCur').textContent = fmt(Math.min(t, feat.dur));
    if (recording) { const p = Math.min(1, t / feat.dur); $('prog').style.width = (p * 100) + '%'; $('progText').textContent = 'Recording ' + Math.round(p * 100) + '%'; }
  }
  const env = Math.min(1, furyState.smoothRms * 1.5);
  $('meterFill').style.width = (env * 100).toFixed(1) + '%';
  window.__furyState = { t, env, presence: furyState.presence, playing, recording, format };
}
requestAnimationFrame(frame);

// ---------- export ----------
let offlineExport = false;
let recording = false, canvasTrack = null, dlUrl = null, wakeLock = null;
function pickMime() {
  const list = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4',
    'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  if (!window.MediaRecorder) return null;
  for (const m of list) { try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) {} }
  return '';
}
function resetDownload() { if (dlUrl) { URL.revokeObjectURL(dlUrl); dlUrl = null; } $('dlLink').hidden = true; $('progWrap').hidden = true; $('exportInfo').hidden = true; }

async function realtimeExport() {
  if (!audioBuf || recording) return;
  const mime = pickMime();
  if (mime === null || !canvas.captureStream) { showInfo($('exportInfo'), 'This browser cannot record video. Please open this page in Chrome.', true); return; }
  resetDownload();
  const c = ctx(); if (c.resume) await c.resume();
  sizeCanvas(false); // real-time path records at 720p so it stays smooth
  recDest = c.createMediaStreamDestination();
  const vStream = canvas.captureStream(30);
  canvasTrack = null;
  const stream = new MediaStream([...vStream.getVideoTracks(), ...recDest.stream.getAudioTracks()]);
  const opts = { videoBitsPerSecond: format === 'vertical' ? 10000000 : 10000000, audioBitsPerSecond: 192000 };
  if (mime) opts.mimeType = mime;
  let rec;
  try { rec = new MediaRecorder(stream, opts); } catch (e) { try { rec = new MediaRecorder(stream); } catch (e2) { showInfo($('exportInfo'), 'Recording failed to start: ' + e2.message, true); return; } }
  const chunks = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  recording = true;
  document.querySelectorAll('.seg-btn,#micBtn,#file,#playBtn,#playBtn2,#exportBtn').forEach(el => el.disabled = true);
  $('progWrap').hidden = false; $('prog').style.width = '0%'; $('progText').textContent = 'Starting…'; $('recBadge').hidden = false;
  try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
  rec.onstop = () => {
    recording = false; $('recBadge').hidden = true;
    document.querySelectorAll('.seg-btn,#micBtn,#file,#playBtn,#playBtn2,#exportBtn').forEach(el => el.disabled = false);
    vStream.getTracks().forEach(t => t.stop()); recDest = null; sizeCanvas(false);
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    const type = (rec.mimeType || mime || 'video/webm').split(';')[0];
    const blob = new Blob(chunks, { type });
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    dlUrl = URL.createObjectURL(blob);
    const a = $('dlLink'); a.href = dlUrl; a.download = 'fury-' + format + '-' + Date.now() + '.' + ext; a.hidden = false;
    a.textContent = '⬇ Download video (' + ext.toUpperCase() + ', ' + (blob.size / 1048576).toFixed(1) + ' MB)';
    $('prog').style.width = '100%'; $('progText').textContent = 'Done ✓';
    showInfo($('exportInfo'), ext === 'mp4' ? 'Ready: MP4, ' + (format === 'vertical' ? '1080×1920' : '1920×1080') + ', with your voice. Post it anywhere.'
      : 'Ready: WebM (720p), with your voice. Your browser could not make MP4. Instagram and YouTube accept WebM on desktop; for MP4 on Android use the latest Chrome.', ext !== 'mp4');
    window.__furyExport = { size: blob.size, type, ext, url: dlUrl };
  };
  rec.start(250);
  await new Promise(r => setTimeout(r, 250));
  onEnd = () => setTimeout(() => { if (rec.state !== 'inactive') rec.stop(); }, 350);
  startPlayback(true);
}

// ---- frame-perfect export: WebCodecs H.264 + AAC into MP4 (Chrome / Edge / Android) ----
async function pickVideoCodec(w, h) {
  if (!window.VideoEncoder) return null;
  for (const codec of ['avc1.640028', 'avc1.4d0028', 'avc1.42e028', 'avc1.640032', 'avc1.42001f']) {
    for (const hw of ['prefer-hardware', 'no-preference']) {
      const cfg = { codec, width: w, height: h, bitrate: 8000000, framerate: 30, hardwareAcceleration: hw, avc: { format: 'avc' } };
      try { const s = await VideoEncoder.isConfigSupported(cfg); if (s.supported) return Object.assign(cfg, { mux: 'avc' }); } catch (e) {}
    }
  }
  for (const codec of ['vp09.00.40.08', 'vp09.00.41.08']) {
    const cfg = { codec, width: w, height: h, bitrate: 8000000, framerate: 30 };
    try { const s = await VideoEncoder.isConfigSupported(cfg); if (s.supported) return Object.assign(cfg, { mux: 'vp9' }); } catch (e) {}
  }
  return null;
}
async function pickAudioCodec() {
  if (!window.AudioEncoder) return null;
  for (const [codec, mux] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
    const cfg = { codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 };
    try { const s = await AudioEncoder.isConfigSupported(cfg); if (s.supported) return { cfg, mux }; } catch (e) {}
  }
  return null;
}
function setBusy(on) {
  document.querySelectorAll('.seg-btn,#micBtn,#file,#playBtn,#playBtn2,#exportBtn').forEach(el => el.disabled = on);
}
async function offlineExportRun(vcfg, acfg) {
  sizeCanvas(true);
  furyState = freshState(); smoothMag.fill(0);
  const FPS = 30, W = canvas.width, H = canvas.height;
  const dur = audioBuf.duration + 0.7, N = Math.ceil(dur * FPS);
  // resample voice to 48 kHz stereo
  const off = new OfflineAudioContext(2, Math.ceil(audioBuf.duration * 48000), 48000);
  const s = off.createBufferSource(); s.buffer = audioBuf; s.connect(off.destination); s.start();
  const pcm = await off.startRendering();
  const muxer = new Mp4Muxer.Muxer({ target: new Mp4Muxer.ArrayBufferTarget(), fastStart: 'in-memory', firstTimestampBehavior: 'offset',
    video: { codec: vcfg.mux, width: W, height: H, frameRate: FPS }, audio: { codec: acfg.mux, numberOfChannels: 2, sampleRate: 48000 } });
  let err = null;
  const venc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: e => err = e });
  const { mux: _m, ...vc } = vcfg; venc.configure(vc);
  const aenc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: e => err = e });
  aenc.configure(acfg.cfg);
  // audio
  const L = pcm.getChannelData(0), R = pcm.getChannelData(1), CH = 4800;
  for (let i = 0; i < pcm.length; i += CH) {
    const n = Math.min(CH, pcm.length - i), d = new Float32Array(n * 2);
    d.set(L.subarray(i, i + n), 0); d.set(R.subarray(i, i + n), n);
    const ad = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(i / 48000 * 1e6), data: d });
    aenc.encode(ad); ad.close();
  }
  // video, frame by frame
  for (let i = 0; i < N; i++) {
    if (err) throw err;
    const t = i / FPS;
    stepFury(t - 1 / 60, t + 3.0); stepFury(t, t + 3.0);
    render(t + 3.0);
    const vf = new VideoFrame(canvas, { timestamp: Math.round(t * 1e6), duration: Math.round(1e6 / FPS) });
    venc.encode(vf, { keyFrame: i % 60 === 0 }); vf.close();
    while (venc.encodeQueueSize > 6) await new Promise(r => setTimeout(r, 4));
    if (i % 3 === 0) {
      const p = (i + 1) / N; $('prog').style.width = (p * 95) + '%'; $('progText').textContent = 'Creating video ' + Math.round(p * 100) + '%';
      $('tCur').textContent = fmt(Math.min(t, audioBuf.duration));
      await new Promise(r => setTimeout(r, 0));
    }
  }
  await venc.flush(); await aenc.flush();
  if (err) throw err;
  muxer.finalize();
  venc.close(); aenc.close();
  return new Blob([muxer.target.buffer], { type: 'video/mp4' });
}
$('exportBtn').addEventListener('click', async () => {
  if (!audioBuf || recording || offlineExport) return;
  stopPlayback();
  resetDownload();
  let vcfg = null, acfg = null;
  const xs0 = parseFloat((location.search.match(/[?&]xs=([\d.]+)/) || [])[1] || '1') || 1;
  const fw = Math.round((format === 'vertical' ? 1080 : 1920) * xs0 / 2) * 2, fh = Math.round((format === 'vertical' ? 1920 : 1080) * xs0 / 2) * 2;
  try { vcfg = await pickVideoCodec(fw, fh); acfg = await pickAudioCodec(); } catch (e) {}
  if (!vcfg || !acfg || !window.Mp4Muxer) return realtimeExport();
  offlineExport = true; setBusy(true);
  stageBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('progWrap').hidden = false; $('prog').style.width = '0%'; $('progText').textContent = 'Creating video…';
  let blob = null, failed = null;
  const t1 = performance.now();
  try { blob = await offlineExportRun(vcfg, acfg); } catch (e) { failed = e; }
  offlineExport = false; setBusy(false); sizeCanvas(false);
  if (!blob) { console.warn('offline export failed, falling back', failed); return realtimeExport(); }
  dlUrl = URL.createObjectURL(blob);
  const a = $('dlLink'); a.href = dlUrl; a.download = 'fury-' + format + '-' + Date.now() + '.mp4'; a.hidden = false;
  a.textContent = '⬇ Download video (MP4, ' + (blob.size / 1048576).toFixed(1) + ' MB)';
  $('prog').style.width = '100%'; $('progText').textContent = 'Done ✓';
  showInfo($('exportInfo'), 'Ready: MP4 (' + (vcfg.mux === 'avc' ? 'H.264' : 'VP9') + (acfg.mux === 'aac' ? ' + AAC' : ' + Opus') + '), ' + fw + '×' + fh + ', 30 fps, with your voice. Post it anywhere.');
  window.__furyExport = { size: blob.size, type: 'video/mp4', ext: 'mp4', url: dlUrl, path: 'webcodecs', codec: vcfg.codec, audio: acfg.mux, ms: Math.round(performance.now() - t1) };
});
boot();
})();
