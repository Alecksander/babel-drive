// Blackstart 3D viewer. Loads on demand; buttons move the cap; drag turns the drive.
// Never touches page scroll: vertical swipes always scroll the page.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
const sm = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * t * (t * (6 * t - 15) + 10); };

export function start(root) {
  const canvas = root.querySelector('canvas');
  const coarse = matchMedia('(pointer: coarse)').matches;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' }); }
  catch (e) { return; }   // no WebGL: the poster image stays
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, coarse ? 1.75 : 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(22, 1, 1, 2000);

  // studio reflections: a dim room with one big overhead softbox, a side strip and a white table,
  // so flat tops read bright and the sides fall off darker, like the renders
  {
    const pm = new THREE.PMREMGenerator(renderer), env = new THREE.Scene();
    env.background = new THREE.Color(0.012, 0.012, 0.014);
    const box = (w, h, x, y, z, k) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(k, k, k), side: THREE.DoubleSide }));
      m.position.set(x, y, z); m.lookAt(0, 0, 0); env.add(m);
    };
    box(110, 24, 0, 34, -46, 1.5);   // high wall behind: the top plate mirrors it
    box(110, 18, 0, 12, -46, 0.45);  // low wall behind: the top fades darker toward the front
    box(26, 60, -40, 16, -34, 1.1);  // tall strip, back left
    box(70, 50, 0, 44, 0, 0.35);     // overhead
    box(14, 46, -42, 12, 14, 1.3);   // tall strip, front left
    box(30, 18, 40, 8, -10, 0.8);    // fill, right
    box(90, 90, 0, -30, 0, 0.05);    // black table below
    box(60, 12, 0, 2, 44, 1.8);      // low front strip: the long side's sheen
    scene.environment = pm.fromScene(env, 0.035).texture; pm.dispose();
  }

  // soft contact shadow under the drive
  const shTex = (() => {
    const c = document.createElement('canvas'); c.width = 512; c.height = 256; const g = c.getContext('2d');
    g.filter = 'blur(22px)'; g.fillStyle = 'rgba(0,0,0,0.55)';
    const r = 40; g.beginPath(); g.roundRect(70, 64, 372, 128, r); g.fill();
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();

  const pivot = new THREE.Group(); scene.add(pivot);
  const holder = new THREE.Group(); pivot.add(holder);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: shTex, transparent: true, depthWrite: false, opacity: 0.75 }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = -0.05; holder.add(shadow);

  const steel = new THREE.MeshPhysicalMaterial({ color: 0xc2c4c7, metalness: 1, roughness: 0.3, clearcoat: 0.1, clearcoatRoughness: 0.35 });
  const polished = new THREE.MeshPhysicalMaterial({ color: 0xd2d4d6, metalness: 1, roughness: 0.16 });
  const oxide = new THREE.MeshStandardMaterial({ color: 0x1b1c1e, metalness: 0.6, roughness: 0.42 });
  const laser = new THREE.MeshStandardMaterial({ color: 0x1d1e20, metalness: 0.2, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });

  const VQ = new URLSearchParams(location.search).get('vq');   // preview only: ?vq=0.3 opens at that cap position
  let capgrp = null, model = null, q = VQ ? +VQ : 0, qv = 0, target = q;

  let cx = 22, span = 46, ready = false;

  // the machined v2 drive (build/cad/options/_video/glb16.py): body, cover, screws, magnets, plug, engraving, and the
  // cap with its two magnets under the node "capgrp"
  new GLTFLoader().load(new URL('img/blackstart-v2.glb?v=1', document.baseURI).href, gltf => {
    model = gltf.scene;
    model.traverse(o => {
      if (!o.isMesh) return;
      const n = (o.material && o.material.name) || '';
      o.material = n === 'polished' ? polished : n === 'black_oxide' ? oxide : n === 'laser' ? laser : steel;
    });
    capgrp = model.getObjectByName('capgrp');
    holder.add(model);
    ready = true; resize(); kick();
  });

  // cap path (mm, in the model's frame), the same move as the film at the top of the page:
  // 0..0.3 straight off the plug ("Cap off" rests at 0.3); 0.3..1 lift, travel back over the top while turning one
  // smooth half turn about its own centre, come down behind the drive and slide onto the rear step ("Posted").
  const CAP_C = 20.825;               // the cap's centre, measured from the cap group's origin (the body's middle, x = 18)
  const CAP_HL = 5.825, CAP_HW = 10.2; // its half length and half width
  const OFF = 16, BACK = 6.7, UP = 11.5;
  let capX = 18 + CAP_C, capTh = 0;
  function capPose(v) {
    const a = sm(0, 0.3, v), w = clamp((v - 0.3) / 0.7, 0, 1);
    const up = sm(0, 0.22, w) - sm(0.66, 0.86, w), b = sm(0.16, 0.70, w), sl = sm(0.84, 1, w);
    const th = Math.PI * sm(0.24, 0.64, w);
    const x0 = 18 + CAP_C + OFF * a, xd = 18 - CAP_C - BACK, x1 = 18 - CAP_C;   // centre: in front, behind, posted
    const px = x0 + (xd - x0) * b + (x1 - xd) * sl;
    // the group turns about its own origin, so put that origin where it leaves the cap's centre at px
    capgrp.position.set(px - CAP_C * Math.cos(th), UP * up, CAP_C * Math.sin(th));
    capgrp.rotation.y = th;
    capX = px; capTh = th;
  }

  // speed and acceleration limited glide toward the chosen state
  function glide(x, v, to, dt, vmax = 0.42, acc = 1.1) {
    const d = to - x, want = Math.sign(d) * Math.min(vmax, Math.sqrt(2 * acc * Math.abs(d)));
    v += clamp(want - v, -acc * dt, acc * dt);
    let nx = x + v * dt;
    if ((to - x) * (to - nx) <= 0) { nx = to; v = 0; }
    return [nx, v];
  }

  // turning: mouse drags turn at once; touch turns only after a clearly sideways move
  const BASE = -0.62;
  let yaw = BASE, yv = 0, drag = false, axis = '', x0 = 0, y0 = 0, lastX = 0, lastT = 0, lastUser = -1e9;
  canvas.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    drag = true; axis = e.pointerType === 'touch' ? '' : 'x'; x0 = lastX = e.clientX; y0 = e.clientY; lastT = performance.now(); yv = 0;
    if (axis) { try { canvas.setPointerCapture(e.pointerId); } catch (_) {} canvas.classList.add('drag'); }
    kick();
  });
  canvas.addEventListener('pointermove', e => {
    if (!drag) return;
    if (!axis) {
      const ax = Math.abs(e.clientX - x0), ay = Math.abs(e.clientY - y0);
      if (ax < 8 && ay < 8) return;
      if (ay >= ax) { drag = false; return; }
      axis = 'x'; try { canvas.setPointerCapture(e.pointerId); } catch (_) {} canvas.classList.add('drag');
    }
    const now = performance.now(), d = (e.clientX - lastX) * 0.0085;
    yaw += d; lastX = e.clientX;
    const dt = Math.max((now - lastT) / 1000, 1 / 240); lastT = now; lastUser = now;
    yv = yv * 0.6 + (d / dt) * 0.4;
  });
  const end = () => { if (!drag) return; drag = false; canvas.classList.remove('drag'); lastUser = performance.now(); if (performance.now() - lastT > 90) yv = 0; yv = clamp(yv, -8, 8); kick(); };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); yv += e.key === 'ArrowLeft' ? -2 : 2; lastUser = performance.now(); kick(); }
  });

  // state buttons
  const buttons = root.querySelectorAll('.states button');
  buttons.forEach(b => b.addEventListener('click', () => {
    target = parseFloat(b.dataset.q);
    buttons.forEach(o => o.setAttribute('aria-pressed', o === b ? 'true' : 'false'));
    if (reduce) { q = target; qv = 0; }
    kick();
  }));

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!(w > 0 && h > 0)) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  new ResizeObserver(() => { resize(); kick(); }).observe(canvas);

  // render loop: runs while visible and something is moving
  let visible = false, running = false, last = 0, idleSince = 0;
  function kick() { if (!running && visible && ready) { running = true; last = performance.now(); idleSince = 0; requestAnimationFrame(frame); } }
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) kick(); }).observe(canvas);

  // preview only (?vq=...): __v3d(0.62) draws one frame at that cap position, even when the page is hidden and the
  // browser has paused animation frames. Returns false until the model has loaded.
  if (VQ) window.__v3d = v => { if (!ready) return false; visible = true; q = target = v; qv = 0; resize(); first = true; frame(performance.now()); return true; };

  let first = true;
  function frame(now) {
    if (!visible) { running = false; return; }
    const dt = Math.min((now - last) / 1000, 0.05); last = now;

    [q, qv] = glide(q, qv, target, dt);
    capPose(q);

    // framing follows the drive's current extent, measured in the model's own frame (mm):
    // body + plug run 0..42.65; the cap is a 11.65 x 20.4 block centred at capX, turned by capTh
    const capEx = CAP_HL * Math.abs(Math.cos(capTh)) + CAP_HW * Math.abs(Math.sin(capTh));
    const lo = Math.min(0, capX - capEx), hi = Math.max(42.65, capX + capEx);
    const ncx = (lo + hi) / 2, nspan = hi - lo;
    const k = first ? 1 : 1 - Math.exp(-dt * 5);
    cx += (ncx - cx) * k; span += (nspan - span) * k;
    holder.position.x = -cx;
    shadow.position.x = cx; shadow.scale.set(span * 1.32, 32, 1);

    if (!drag) {
      yaw += yv * dt; yv *= Math.exp(-dt * 3);
      if (Math.abs(yv) < 0.04 && now - lastUser > 2200) {   // drift home, with a slow sway
        const sway = reduce ? 0 : 0.1 * Math.sin(now / 2600);
        const home = BASE + sway;
        let d = ((yaw - home + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
        yaw -= d * (1 - Math.exp(-dt * 1.6));
      }
    }
    pivot.rotation.y = yaw;

    // camera distance fits the drive's width at this aspect
    const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const fitW = span * 0.98 + 18, fitH = 34;
    const dist = Math.max(fitW / (2 * tan * camera.aspect), fitH / (2 * tan)) * 1.08;
    camera.position.set(0, dist * 0.42, dist * 0.92);
    camera.lookAt(0, 3.5, 0);

    renderer.render(scene, camera);
    if (first) { first = false; requestAnimationFrame(() => root.classList.add('live')); }

    const moving = drag || Math.abs(yv) > 0.01 || q !== target || Math.abs(ncx - cx) > 0.01 || now - lastUser < 4000;
    if (!moving && !reduce) { /* keep the slow sway alive */ }
    if (!moving && reduce) { if (!idleSince) idleSince = now; if (now - idleSince > 500) { running = false; return; } }
    requestAnimationFrame(frame);
  }
}
