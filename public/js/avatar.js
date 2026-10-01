// Cabeza 3D flotando en el espacio (Three.js).
// Por defecto es un robot con rostro en pantalla (ojos y labios dibujados en tiempo real);
// también puede cargar un .glb propio con blendshapes ARKit u Oculus visemes.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// Parámetros del rostro por emoción (se interpolan suavemente)
const EMOTIONS = {
  neutral: { eyeScale: 1, lidDrop: 0, lidTilt: 0, smile: 0.25, happy: 0, mouthOpen: 0, mouthRound: 0 },
  feliz: { eyeScale: 1, lidDrop: 0, lidTilt: 0, smile: 0.9, happy: 1, mouthOpen: 0, mouthRound: 0 },
  triste: { eyeScale: 0.95, lidDrop: 0.28, lidTilt: -0.45, smile: -0.7, happy: 0, mouthOpen: 0, mouthRound: 0 },
  sorprendido: { eyeScale: 1.25, lidDrop: 0, lidTilt: 0, smile: 0, happy: 0, mouthOpen: 0.3, mouthRound: 0.8 },
  pensativo: { eyeScale: 0.92, lidDrop: 0.3, lidTilt: 0.1, smile: -0.1, happy: 0, mouthOpen: 0, mouthRound: 0 },
  enojado: { eyeScale: 0.95, lidDrop: 0.32, lidTilt: 0.5, smile: -0.45, happy: 0, mouthOpen: 0, mouthRound: 0 },
};
export const EMOTION_NAMES = Object.keys(EMOTIONS);

const STATE_HUE = { listening: 145, thinking: 38 };
const FACE_W = 1024;
const FACE_H = 700;

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const damp = (cur, tgt, rate, dt) => cur + (tgt - cur) * (1 - Math.exp(-rate * dt));

function radialTexture(inner = 'rgba(255,255,255,1)', size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, inner);
  grd.addColorStop(0.35, 'rgba(255,255,255,0.35)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Avatar {
  constructor(container) {
    this.container = container;
    this.mouth = { open: 0, wide: 0, round: 0, closed: 0 };
    this.mouthTarget = { ...this.mouth };
    this.emo = { ...EMOTIONS.neutral };
    this.emotion = 'neutral';
    this.emotionUntil = 0;
    this.state = 'idle';
    this.hue = 190;
    this.accentHue = 190;
    this.inputLevel = 0;
    this.blink = 0;
    this.blinkStart = -1;
    this.nextBlink = 1.5;
    this.look = new THREE.Vector2();
    this.lookTarget = new THREE.Vector2();
    this.nextSaccade = 0;
    this.pointer = new THREE.Vector2();
    this.pointerActive = 0;
    this.updaters = [];
    this.morphMeshes = [];
    this.custom = null;
    this.color = new THREE.Color();
    this.clock = new THREE.Clock();

    this._setupRenderer();
    this._setupScene();
    this._buildRobot();
    this._setupPost();
    this._resize();
    addEventListener('resize', () => this._resize());
    addEventListener('pointermove', (e) => {
      this.pointer.set((e.clientX / innerWidth) * 2 - 1, (e.clientY / innerHeight) * 2 - 1);
      this.pointerActive = 1;
    });
    this.renderer.setAnimationLoop(() => this._tick());
  }

  // ---------- API pública ----------
  addUpdater(fn) { this.updaters.push(fn); }
  setState(s) { this.state = s; }
  setInputLevel(l) { this.inputLevel = l; }
  setHue(h) { this.hue = Number(h) || 0; }

  setMouth(m) {
    const t = this.mouthTarget;
    t.open = m.open ?? 0;
    t.wide = m.wide ?? 0;
    t.round = m.round ?? 0;
    t.closed = m.closed ?? 0;
  }

  setEmotion(name, hold = 6) {
    let n = String(name || 'neutral').toLowerCase();
    if (!EMOTIONS[n]) n = n.replace(/a$/, 'o');
    if (!EMOTIONS[n]) n = 'neutral';
    this.emotion = n;
    this.emotionUntil = n === 'neutral' ? 0 : this.clock.elapsedTime + hold;
  }

  async loadModel(url) {
    const gltf = await new GLTFLoader().loadAsync(url);
    this.useRobot();
    const root = gltf.scene;
    root.updateMatrixWorld(true);

    let head = null;
    const meshes = [];
    root.traverse((o) => {
      if (!head && o.isBone && /head$/i.test(o.name)) head = o;
      if (o.isMesh) {
        o.frustumCulled = false;
        if (o.morphTargetDictionary) meshes.push(o);
      }
    });
    head ??= root.getObjectByName('Head');

    const wrap = new THREE.Group();
    wrap.add(root);
    let center;
    if (head) {
      // Personaje humanoide en metros: centramos en la cabeza y recortamos el cuerpo
      center = head.getWorldPosition(new THREE.Vector3());
      center.y += 0.09;
      wrap.scale.setScalar(7.5);
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 1.15);
      root.traverse((o) => {
        if (!o.isMesh) return;
        for (const mat of [o.material].flat()) mat.clippingPlanes = [plane];
      });
    } else {
      const box = new THREE.Box3().setFromObject(root);
      const size = box.getSize(new THREE.Vector3());
      center = box.getCenter(new THREE.Vector3());
      wrap.scale.setScalar(2.2 / Math.max(size.x, size.y, size.z));
    }
    root.position.sub(center);

    this.headPivot.add(wrap);
    this.custom = wrap;
    this.morphMeshes = meshes;
    this.robot.visible = false;
    return { morphs: meshes.length > 0, head: Boolean(head) };
  }

  useRobot() {
    if (this.custom) {
      this.headPivot.remove(this.custom);
      this.custom.traverse((o) => {
        o.geometry?.dispose();
        for (const m of [o.material].flat()) m?.dispose?.();
      });
    }
    this.custom = null;
    this.morphMeshes = [];
    this.robot.visible = true;
  }

  // ---------- Escena ----------
  _setupRenderer() {
    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' }));
    r.setPixelRatio(Math.min(devicePixelRatio, matchMedia('(pointer: coarse)').matches ? 1.5 : 2)); // menos carga en móviles
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 0.9;
    r.localClippingEnabled = true;
    this.container.appendChild(r.domElement);

    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 400);
    this.camera.position.set(0, -0.15, 6);
    this.controls = new OrbitControls(this.camera, r.domElement);
    Object.assign(this.controls, {
      enableDamping: true,
      enablePan: false,
      minDistance: 3.2,
      maxDistance: 12,
      minPolarAngle: 0.9,
      maxPolarAngle: 2.1,
      minAzimuthAngle: -1.1,
      maxAzimuthAngle: 1.1,
      rotateSpeed: 0.6,
    });
    this.controls.target.set(0, -0.35, 0);
  }

  _setupScene() {
    const s = (this.scene = new THREE.Scene());
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    s.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    s.environmentIntensity = 0.35;

    // Cielo con degradado y una nebulosa tenue del color de la personalidad
    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        top: { value: new THREE.Color(0x0b1030) },
        bottom: { value: new THREE.Color(0x020309) },
        accent: { value: new THREE.Color(0x113355) },
      },
      vertexShader: `varying vec3 vDir;
        void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform vec3 top; uniform vec3 bottom; uniform vec3 accent; varying vec3 vDir;
        void main() {
          vec3 c = mix(bottom, top, smoothstep(-0.6, 0.9, vDir.y));
          float neb = pow(max(0.0, 1.0 - length(vec2(vDir.x * 0.8, vDir.y + 0.15)) * 1.1), 2.5);
          float band = pow(max(0.0, 1.0 - abs(vDir.y - vDir.x * 0.35 + 0.1) * 3.0), 3.0);
          c += accent * (neb * 0.55 + band * 0.25);
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    s.add(new THREE.Mesh(new THREE.SphereGeometry(200, 48, 24), this.skyMat));

    const dot = radialTexture();

    // Estrellas
    const n = 2200;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const r = 50 + Math.random() * 100;
      const u = Math.random() * 2 - 1;
      const th = Math.random() * Math.PI * 2;
      const k = Math.sqrt(1 - u * u);
      pos.set([r * k * Math.cos(th), r * u, r * k * Math.sin(th)], i * 3);
      c.setHSL(0.55 + Math.random() * 0.2, 0.6, 0.55 + Math.random() * 0.45);
      col.set([c.r, c.g, c.b], i * 3);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    starGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
      size: 0.6, map: dot, vertexColors: true, transparent: true, depthWrite: false, fog: false,
    }));
    s.add(this.stars);

    // Polvo flotante cerca de la cabeza
    const m = 280;
    const dpos = new Float32Array(m * 3);
    for (let i = 0; i < m; i++) dpos.set([(Math.random() - 0.5) * 12, -3 + Math.random() * 7, -7 + Math.random() * 10], i * 3);
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute('position', new THREE.BufferAttribute(dpos, 3));
    this.dustMat = new THREE.PointsMaterial({
      size: 0.06, map: dot, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.dust = new THREE.Points(dustGeo, this.dustMat);
    s.add(this.dust);

    // Luces
    s.add(new THREE.HemisphereLight(0xcfe0ff, 0x1a1028, 0.45));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(2.5, 3, 4);
    s.add(key);
    this.rimA = new THREE.DirectionalLight(0x44ccff, 3);
    this.rimA.position.set(-3.5, 2, -3);
    this.rimB = new THREE.DirectionalLight(0xff44cc, 2.2);
    this.rimB.position.set(3.5, -0.5, -3);
    this.under = new THREE.PointLight(0x66ccff, 2.5, 6, 2);
    this.under.position.set(0, -1.3, 0.8);
    s.add(this.rimA, this.rimB, this.under);

    // Base holográfica
    const base = (this.base = new THREE.Group());
    base.position.y = -1.45;
    s.add(base);
    this.baseMat = new THREE.MeshBasicMaterial({ color: 0x66ccff, toneMapped: false, transparent: true });
    this.baseMatSoft = new THREE.MeshBasicMaterial({ color: 0x66ccff, toneMapped: false, transparent: true, opacity: 0.35 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.012, 12, 160), this.baseMat);
    ring.rotation.x = Math.PI / 2;
    const ring2 = new THREE.Mesh(new THREE.TorusGeometry(1.34, 0.005, 8, 160), this.baseMatSoft);
    ring2.rotation.x = Math.PI / 2;
    base.add(ring, ring2);

    const dashPts = new THREE.EllipseCurve(0, 0, 1.2, 1.2).getPoints(180).map((p) => new THREE.Vector3(p.x, 0, p.y));
    this.dashMat = new THREE.LineDashedMaterial({ color: 0x66ccff, dashSize: 0.09, gapSize: 0.07, transparent: true, opacity: 0.8, toneMapped: false });
    this.dashRing = new THREE.Line(new THREE.BufferGeometry().setFromPoints(dashPts), this.dashMat);
    this.dashRing.computeLineDistances();
    base.add(this.dashRing);

    this.glowMat = new THREE.MeshBasicMaterial({
      map: radialTexture(), transparent: true, opacity: 0.3, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    });
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 4.4), this.glowMat);
    glow.rotation.x = -Math.PI / 2;
    base.add(glow);

    this.beamMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      uniforms: { color: { value: new THREE.Color(0x66ccff) }, time: { value: 0 } },
      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform vec3 color; uniform float time; varying vec2 vUv;
        void main() {
          float a = pow(1.0 - vUv.y, 2.2) * 0.13;
          a *= 0.75 + 0.25 * sin(vUv.y * 40.0 - time * 3.0);
          gl_FragColor = vec4(color, a);
        }`,
    });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 1.05, 1.15, 64, 1, true), this.beamMat);
    beam.position.y = 0.575;
    base.add(beam);

    // Anillo orbital con un pequeño satélite
    this.orbit = new THREE.Group();
    this.orbit.rotation.set(1.25, 0, 0.25);
    s.add(this.orbit);
    this.orbit.add(new THREE.Mesh(new THREE.TorusGeometry(1.85, 0.0035, 8, 220), this.baseMatSoft));
    this.orbitSpin = new THREE.Group();
    this.orbit.add(this.orbitSpin);
    const sat = new THREE.Mesh(new THREE.SphereGeometry(0.035, 16, 8), this.baseMat);
    sat.position.x = 1.85;
    this.orbitSpin.add(sat);
  }

  _buildRobot() {
    this.headPivot = new THREE.Group();
    this.scene.add(this.headPivot);
    const robot = (this.robot = new THREE.Group());
    this.headPivot.add(robot);

    const shellMat = new THREE.MeshPhysicalMaterial({ color: 0xc9d0dc, roughness: 0.38, metalness: 0.05, clearcoat: 0.8, clearcoatRoughness: 0.2 });
    const darkMat = new THREE.MeshPhysicalMaterial({ color: 0x1a1f2b, roughness: 0.35, metalness: 0.8 });
    this.glowMats = [];
    const glow = () => {
      const m = new THREE.MeshBasicMaterial({ color: 0x66ccff, toneMapped: false });
      this.glowMats.push(m);
      return m;
    };

    const skull = new THREE.Group();
    skull.scale.set(0.96, 1.06, 1);
    robot.add(skull);
    skull.add(new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), shellMat));

    // Pantalla del rostro: un casquete esférico con el lienzo 2D como textura emisiva
    const W = 1.96;
    const TH0 = 0.92;
    const TH = 1.36;
    skull.add(new THREE.Mesh(new THREE.SphereGeometry(1.006, 96, 64, Math.PI / 2 - W / 2 - 0.05, W + 0.1, TH0 - 0.05, TH + 0.1), darkMat));

    this.faceCanvas = document.createElement('canvas');
    this.faceCanvas.width = FACE_W;
    this.faceCanvas.height = FACE_H;
    this.fctx = this.faceCanvas.getContext('2d');
    this.layer = document.createElement('canvas');
    this.layer.width = FACE_W;
    this.layer.height = FACE_H;
    this.lctx = this.layer.getContext('2d');
    this.faceTex = new THREE.CanvasTexture(this.faceCanvas);
    this.faceTex.colorSpace = THREE.SRGBColorSpace;
    this.faceTex.anisotropy = 8;
    const visorMat = new THREE.MeshPhysicalMaterial({
      color: 0x010205, roughness: 0.25, metalness: 0.1, clearcoat: 0.6, clearcoatRoughness: 0.08, envMapIntensity: 0.2,
      emissive: 0xffffff, emissiveMap: this.faceTex, emissiveIntensity: 2.4,
    });
    skull.add(new THREE.Mesh(new THREE.SphereGeometry(1.014, 96, 64, Math.PI / 2 - W / 2, W, TH0, TH), visorMat));

    // Orejas con anillos de estado
    for (const side of [-1, 1]) {
      const ear = new THREE.Group();
      ear.position.set(side * 0.94, 0.02, 0);
      robot.add(ear);
      const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.3, 0.22, 64), darkMat);
      pod.rotation.z = Math.PI / 2;
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.23, 0.06, 64), shellMat);
      cap.rotation.z = Math.PI / 2;
      cap.position.x = side * 0.12;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.245, 0.016, 16, 96), glow());
      ring.rotation.y = Math.PI / 2;
      ring.position.x = side * 0.115;
      ear.add(pod, cap, ring);
    }

    // Antena
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.05, 32), darkMat);
    collar.position.y = 1.055;
    const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.03, 0.34, 16), darkMat);
    stalk.position.y = 1.2;
    this.bulb = new THREE.Mesh(new THREE.SphereGeometry(0.065, 32, 16), glow());
    this.bulb.position.y = 1.4;
    robot.add(collar, stalk, this.bulb);

    // Aro bajo la barbilla: sugiere que la cabeza levita
    const hover = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.012, 12, 96), glow());
    hover.rotation.x = Math.PI / 2;
    hover.position.y = -1.08;
    robot.add(hover);
  }

  _setupPost() {
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.5, 0.45, 1.0);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  _resize() {
    const w = this.container.clientWidth || innerWidth;
    const h = this.container.clientHeight || innerHeight;
    this.renderer.setSize(w, h);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    // En pantallas verticales alejamos la cámara para que la cabeza quepa a lo ancho
    const vH = 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const dist = Math.max(6, 3.2 / (vH * this.camera.aspect));
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.camera.position.copy(this.controls.target).addScaledVector(dir, dist);
    this.controls.maxDistance = Math.max(12, dist * 1.6);
    this.camera.updateProjectionMatrix();
  }

  // ---------- Animación ----------
  _tick() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;
    for (const fn of this.updaters) fn(dt, t);

    for (const k in this.mouth) this.mouth[k] = damp(this.mouth[k], this.mouthTarget[k], 26, dt);

    if (this.emotionUntil && t > this.emotionUntil) { this.emotion = 'neutral'; this.emotionUntil = 0; }
    const target = EMOTIONS[this.emotion];
    for (const k in this.emo) this.emo[k] = damp(this.emo[k], target[k], 8, dt);

    // Parpadeo (a veces doble)
    if (this.blinkStart < 0 && t > this.nextBlink) this.blinkStart = t;
    if (this.blinkStart >= 0) {
      const p = (t - this.blinkStart) / 0.16;
      this.blink = p < 0.5 ? p * 2 : Math.max(0, 2 - p * 2);
      if (p >= 1) {
        this.blinkStart = -1;
        this.blink = 0;
        this.nextBlink = t + (Math.random() < 0.2 ? 0.22 : 2 + Math.random() * 3.5);
      }
    }

    // Mirada: puntero, movimientos sacádicos o mirar arriba al pensar
    this.pointerActive = Math.max(0, this.pointerActive - dt * 0.25);
    if (this.state === 'thinking') this.lookTarget.set(0.55, -0.7);
    else if (this.pointerActive > 0.3) this.lookTarget.copy(this.pointer);
    else if (t > this.nextSaccade) {
      this.lookTarget.set((Math.random() - 0.5) * 0.9, (Math.random() - 0.5) * 0.5);
      if (this.state !== 'idle') this.lookTarget.multiplyScalar(0.35);
      this.nextSaccade = t + 0.8 + Math.random() * 2.2;
    }
    this.look.x = damp(this.look.x, this.lookTarget.x, 14, dt);
    this.look.y = damp(this.look.y, this.lookTarget.y, 14, dt);

    // Movimiento de cabeza
    const hp = this.headPivot;
    const pa = this.pointerActive;
    const yaw = this.look.x * 0.18 + this.pointer.x * 0.25 * pa + Math.sin(t * 0.45) * 0.06;
    const pitch = this.look.y * 0.1 + this.pointer.y * 0.15 * pa + Math.sin(t * 0.6) * 0.025 + this.mouth.open * 0.06;
    const roll = (this.state === 'listening' ? 0.09 : this.state === 'thinking' ? -0.07 : 0) + Math.sin(t * 0.37) * 0.025;
    hp.rotation.x = damp(hp.rotation.x, pitch, 4, dt);
    hp.rotation.y = damp(hp.rotation.y, yaw, 4, dt);
    hp.rotation.z = damp(hp.rotation.z, roll, 3, dt);
    hp.position.y = Math.sin(t * 1.2) * 0.045;

    // Colores: el acento cambia con el estado (verde escuchando, ámbar pensando)
    this.accentHue = damp(this.accentHue, STATE_HUE[this.state] ?? this.hue, 5, dt);
    let energy = 0.4;
    if (this.state === 'thinking') energy = 0.55 + 0.45 * Math.sin(t * 7);
    else if (this.state === 'listening') energy = 0.55 + Math.min(1, this.inputLevel * 10);
    else if (this.state === 'speaking') energy = 0.6 + this.mouth.open * 0.9;
    this.color.setHSL(this.accentHue / 360, 0.9, 0.55);
    for (const m of this.glowMats) m.color.copy(this.color).multiplyScalar(0.6 + energy * 2.2);
    this.bulb.scale.setScalar(1 + energy * 0.25);
    this.under.color.copy(this.color);

    this.color.setHSL(this.hue / 360, 0.9, 0.6);
    this.baseMat.color.copy(this.color).multiplyScalar(2);
    this.baseMatSoft.color.copy(this.color).multiplyScalar(1.5);
    this.dashMat.color.copy(this.color).multiplyScalar(1.8);
    this.glowMat.color.copy(this.color).multiplyScalar(0.4);
    this.beamMat.uniforms.color.value.copy(this.color);
    this.beamMat.uniforms.time.value = t;
    this.dustMat.color.copy(this.color);
    this.rimA.color.copy(this.color);
    this.skyMat.uniforms.accent.value.setHSL(this.hue / 360, 0.7, 0.06);

    // Ambiente
    this.dashRing.rotation.y += dt * 0.15;
    this.orbitSpin.rotation.z += dt * 0.35;
    this.stars.rotation.y += dt * 0.004;
    const dp = this.dust.geometry.attributes.position;
    for (let i = 0; i < dp.count; i++) {
      let y = dp.getY(i) + dt * 0.06;
      if (y > 4) y = -3;
      dp.setY(i, y);
    }
    dp.needsUpdate = true;

    if (this.robot.visible) this._drawFace(t);
    if (this.morphMeshes.length) this._applyMorphs();

    this.controls.update(dt);
    this.composer.render(dt);
  }

  // ---------- Rostro dibujado ----------
  _drawFace(t) {
    const c = this.fctx;
    const col = `hsl(${this.hue}, 100%, 66%)`;
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
    c.shadowBlur = 0;
    c.fillStyle = '#000';
    c.fillRect(0, 0, FACE_W, FACE_H);

    const halo = c.createRadialGradient(FACE_W / 2, FACE_H * 0.55, 40, FACE_W / 2, FACE_H * 0.55, 520);
    halo.addColorStop(0, `hsla(${this.hue}, 100%, 50%, 0.12)`);
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = halo;
    c.fillRect(0, 0, FACE_W, FACE_H);

    const lx = this.look.x * 30;
    const ly = this.look.y * 22;
    const boost = this.state === 'listening' ? 1.07 : 1;
    const l = this.lctx;
    l.clearRect(0, 0, FACE_W, FACE_H);
    for (const side of [-1, 1]) this._eye(l, FACE_W / 2 + side * 175 + lx, 265 + ly, side, col, boost);
    c.drawImage(this.layer, 0, 0);

    this._mouth(c, FACE_W / 2 + lx * 0.4, 500 + ly * 0.3, col);

    // Líneas de escaneo tipo pantalla
    c.fillStyle = 'rgba(0,0,0,0.28)';
    const off = (t * 40) % 6;
    for (let y = off; y < FACE_H; y += 6) c.fillRect(0, y, FACE_W, 2);
    this.faceTex.needsUpdate = true;
  }

  _eye(c, cx, cy, side, col, boost) {
    const e = this.emo;
    const s = e.eyeScale * boost;
    const w = 112 * s;
    const hFull = 150 * s;
    const h = Math.max(8, hFull * (1 - this.blink * 0.94));

    if (e.happy < 0.98) {
      c.save();
      c.globalAlpha = 1 - e.happy;
      c.shadowColor = col;
      c.shadowBlur = 30;
      c.fillStyle = col;
      c.beginPath();
      c.roundRect(cx - w / 2, cy - h / 2, w, h, Math.min(w, h) / 2);
      c.fill();

      c.globalCompositeOperation = 'destination-out';
      c.shadowBlur = 0;
      if (h > 50) { // brillo del ojo
        c.beginPath();
        c.arc(cx + w * 0.18, cy - h * 0.22, 13 * s, 0, Math.PI * 2);
        c.fill();
      }
      if (e.lidDrop > 0.01 || Math.abs(e.lidTilt) > 0.01) { // párpado
        const top = cy - hFull / 2 - 4 + e.lidDrop * hFull;
        const tilt = e.lidTilt * hFull * 0.45;
        const xIn = cx - side * w;
        const xOut = cx + side * w;
        c.beginPath();
        c.moveTo(xIn, top + tilt);
        c.lineTo(xOut, top - tilt);
        c.lineTo(xOut, cy - hFull);
        c.lineTo(xIn, cy - hFull);
        c.closePath();
        c.fill();
      }
      c.restore();
    }

    if (e.happy > 0.02) { // ojos sonrientes ^ ^
      c.save();
      c.globalAlpha = e.happy;
      c.strokeStyle = col;
      c.shadowColor = col;
      c.shadowBlur = 30;
      c.lineWidth = 24;
      c.lineCap = 'round';
      c.beginPath();
      c.arc(cx, cy + 30, w * 0.5, Math.PI * 1.12, Math.PI * 1.88);
      c.stroke();
      c.restore();
    }
  }

  _mouth(c, cx, cy, col) {
    const m = this.mouth;
    const e = this.emo;
    const open = Math.max(m.open, e.mouthOpen) * (1 - m.closed * 0.9);
    const round = Math.max(m.round, e.mouthRound);
    const w = 175 * (1 + 0.38 * m.wide - 0.42 * round) * (1 - 0.1 * m.closed);
    const h = 120 * open;
    const smile = e.smile * (1 - open * 0.5);
    const L = cx - w / 2;
    const R = cx + w / 2;
    const cornerY = cy - smile * 24;

    c.save();
    c.strokeStyle = col;
    c.shadowColor = col;
    c.shadowBlur = 26;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    if (h < 10) {
      c.lineWidth = 13 + m.closed * 5;
      c.beginPath();
      c.moveTo(L, cornerY);
      c.bezierCurveTo(L + w * 0.3, cy + smile * 26, R - w * 0.3, cy + smile * 26, R, cornerY);
      c.stroke();
    } else {
      const k = (0.3 - 0.24 * round) * w;
      const top = cy - h * 0.45 + smile * 8;
      const bot = cy + h * 0.55 + smile * 14;
      c.beginPath();
      c.moveTo(L, cornerY);
      c.bezierCurveTo(L + k, top, R - k, top, R, cornerY);
      c.bezierCurveTo(R - k, bot, L + k, bot, L, cornerY);
      c.closePath();
      c.fillStyle = `hsla(${this.hue}, 100%, 45%, 0.3)`;
      c.fill();
      c.lineWidth = 12;
      c.stroke();
      if (h > 40) { // lengua
        c.clip();
        c.shadowBlur = 0;
        c.fillStyle = `hsla(${this.hue}, 100%, 72%, 0.28)`;
        c.beginPath();
        c.ellipse(cx, bot - 4, w * 0.25, h * 0.22, 0, 0, Math.PI * 2);
        c.fill();
      }
    }
    c.restore();
  }

  // Modelos .glb: traduce boca/ojos/emoción a blendshapes ARKit u Oculus
  _applyMorphs() {
    const m = this.mouth;
    const e = this.emo;
    const b = this.blink;
    const smile = Math.max(0, e.smile) * 0.6;
    const frown = Math.max(0, -e.smile) * 0.6;
    const vals = {
      jawOpen: m.open * 0.65,
      mouthOpen: m.open * 0.8,
      mouthFunnel: m.round * m.open * 0.9,
      mouthPucker: m.round * (1 - m.open * 0.5) * 0.7,
      mouthStretchLeft: m.wide * 0.35,
      mouthStretchRight: m.wide * 0.35,
      mouthSmileLeft: smile + m.wide * 0.15,
      mouthSmileRight: smile + m.wide * 0.15,
      mouthSmile: smile,
      mouthFrownLeft: frown,
      mouthFrownRight: frown,
      mouthPressLeft: m.closed * 0.6,
      mouthPressRight: m.closed * 0.6,
      mouthClose: m.closed * 0.3,
      eyeBlinkLeft: b,
      eyeBlinkRight: b,
      eyesClosed: b,
      browInnerUp: Math.max(0, -e.lidTilt) + (e.eyeScale > 1.1 ? 0.6 : 0),
      browDownLeft: Math.max(0, e.lidTilt),
      browDownRight: Math.max(0, e.lidTilt),
      viseme_aa: m.open * Math.max(0, 1 - m.wide - m.round),
      viseme_E: m.open * m.wide,
      viseme_I: m.wide * (1 - m.open) * 0.7,
      viseme_O: m.round * m.open,
      viseme_U: m.round * (1 - m.open),
      viseme_PP: m.closed,
    };
    for (const mesh of this.morphMeshes) {
      const dict = mesh.morphTargetDictionary;
      const inf = mesh.morphTargetInfluences;
      for (const k in vals) {
        const i = dict[k];
        if (i !== undefined) inf[i] = clamp(vals[k]);
      }
    }
  }
}
