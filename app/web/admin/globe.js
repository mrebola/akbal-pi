// Globe 3D view (docs/gps.md): Three.js earth with the live GPS position pin
// and the satellites reported by the dongle orbiting it. The sun sits at its
// REAL current direction (NOAA solar ephemeris) and lights the globe with a
// custom shader: real day imagery on the sunlit side, NASA city-lights
// texture glowing on the night side, smooth terminator, ocean specular and a
// rim atmosphere. Click a satellite for its detail card (same modal design
// as wardriving). Module loaded only when the user toggles to globe view;
// gps.js keeps polling /api/gps/status and forwards snapshots.
"use strict";

const importMapReady = document.querySelector('script[type="importmap"]') !== null;
if (importMapReady) void main();
else console.warn("[globe] importmap missing — three.js unavailable");

async function main() {
  const THREE = await import("three");
  const { OrbitControls } = await import("./vendor/OrbitControls.js");

  // ─── Scene ────────────────────────────────────────────────────────────────
  const canvas = document.getElementById("gps-globe");
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 6000);
  camera.position.set(0, 6, 22);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x03060c, 1);

  // Slow ambient starfield backdrop.
  {
    const starGeo = new THREE.BufferGeometry();
    const starCount = 1800;
    const positions = new Float32Array(starCount * 3);
    const colors = new Float32Array(starCount * 3);
    const tints = [
      [0.72, 0.78, 1.0], // blue-white
      [1.0, 0.95, 0.85], // warm white
      [0.85, 0.88, 1.0], // pale blue
    ];
    for (let i = 0; i < starCount; i++) {
      const r = 700 + Math.random() * 500;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.cos(phi);
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
      const t = tints[Math.floor(Math.random() * tints.length)];
      const b = 0.5 + Math.random() * 0.5;
      colors[i * 3] = t[0] * b;
      colors[i * 3 + 1] = t[1] * b;
      colors[i * 3 + 2] = t[2] * b;
    }
    starGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    starGeo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const starMat = new THREE.PointsMaterial({
      color: 0xffffff, vertexColors: true, size: 1.6, sizeAttenuation: true, transparent: true, opacity: 0.9,
    });
    scene.add(new THREE.Points(starGeo, starMat));
  }

  // ─── Earth ────────────────────────────────────────────────────────────────
  const EARTH_R = 10;
  const loader = new THREE.TextureLoader();
  let earthDayTex = null;
  let earthLightsTex = null;
  try {
    [earthDayTex, earthLightsTex] = await Promise.all([
      loader.loadAsync("./vendor/textures/earth-day.jpg"),
      loader.loadAsync("./vendor/textures/earth-lights.jpg"),
    ]);
    earthDayTex.colorSpace = THREE.SRGBColorSpace;
    earthLightsTex.colorSpace = THREE.SRGBColorSpace;
  } catch {
    // Textures unavailable — the shader falls back to a procedural look.
  }

  // Custom day/night shader: blends the NASA day map and the city-lights
  // map across a smooth terminator computed from the real sun direction.
  // Ocean specular + warm terminator tint + subtle rim make it feel alive.
  const earthMat = new THREE.ShaderMaterial({
    uniforms: {
      dayMap: { value: earthDayTex },
      lightsMap: { value: earthLightsTex },
      sunDirection: { value: new THREE.Vector3(1, 0, 0) }, // unit, mesh frame
      hasTextures: { value: Boolean(earthDayTex && earthLightsTex) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vWorldPos;
      void main() {
        vUv = uv;
        vNormal = normalize(mat3(modelMatrix) * normal);
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorldPos = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D dayMap;
      uniform sampler2D lightsMap;
      uniform vec3 sunDirection;
      uniform bool hasTextures;
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vWorldPos;

      void main() {
        vec3 n = normalize(vNormal);
        vec3 s = normalize(sunDirection);
        float cosAngle = dot(n, s);
        // Smooth day/night terminator (soft twilight band ~ ±7°).
        float dayAmount = smoothstep(-0.12, 0.12, cosAngle);

        vec3 dayColor;
        vec3 nightColor;
        if (hasTextures) {
          // Slightly dimmed and warmed: a real photo from space reads darker
          // than a raw albedo map — the sun is far away, not a studio light.
          dayColor = texture2D(dayMap, vUv).rgb * 0.82;
          dayColor = mix(dayColor, dayColor * dayColor * 2.2, 0.35); // gentle contrast S-curve
          // City lights: gamma-compress the night texture so dense metros pop
          // and suburbs stay as faint clusters — a real night shot from orbit.
          vec3 lights = texture2D(lightsMap, vUv).rgb;
          float luminance = dot(lights, vec3(0.299, 0.587, 0.114));
          vec3 lamps = pow(lights, vec3(1.0 / 1.8)); // lift mid-tones: streets appear
          lamps *= 4.2;                              // ~80% brighter overall
          // Sodium-vapor warm tint, cooler core for dense cores (contrast).
          vec3 sodium = lamps * vec3(1.0, 0.80, 0.50);
          vec3 cores = pow(lamps, vec3(1.35)) * vec3(1.0, 0.92, 0.78);
          nightColor = sodium + cores * 0.5;
          // Faint moonlit base so landmass/ocean silhouettes read on the dark side.
          nightColor += vec3(0.008, 0.011, 0.020);
        } else {
          // Procedural fallback: cheap continents/oceans from noise-free bands.
          float lat = abs(vUv.y - 0.5) * 2.0;
          dayColor = mix(vec3(0.05, 0.10, 0.22), vec3(0.12, 0.30, 0.18), step(0.28, sin(vUv.x * 180.0) * 0.5 + 0.5));
          dayColor = mix(dayColor, vec3(0.8, 0.85, 0.9), smoothstep(0.86, 0.95, lat)); // polar caps
          dayColor *= 0.6 + 0.4 * smoothstep(0.0, 0.25, lat); // darker equator seam
          nightColor = vec3(0.010, 0.014, 0.028);
        }

        // Twilight tint: orange band hugging the terminator on the day side.
        float twilight = (1.0 - abs(cosAngle)) * smoothstep(-0.25, 0.25, cosAngle);
        vec3 color = mix(nightColor, dayColor, dayAmount);
        color += vec3(0.55, 0.28, 0.08) * twilight * 0.35 * dayAmount;

        // Specular sun-glint on oceans (Blinn-ish against a fixed view).
        vec3 viewDir = normalize(cameraPosition - vWorldPos);
        vec3 halfDir = normalize(s + viewDir);
        float spec = pow(max(dot(n, halfDir), 0.0), 42.0);
        color += vec3(0.35, 0.4, 0.45) * spec * dayAmount * 0.55;

        // Faint rim (no white/blue daytime glow on the limb): barely-there
        // sky-blue only, so the night side keeps its dark, living feel.
        float fres = pow(1.0 - max(dot(n, viewDir), 0.0), 3.2);
        vec3 rim = mix(vec3(0.004, 0.008, 0.02), vec3(0.06, 0.12, 0.24), dayAmount);
        color += rim * fres * 0.5;

        gl_FragColor = vec4(color, 1.0);
      }
    `,
  });
  const earthMesh = new THREE.Mesh(new THREE.SphereGeometry(EARTH_R, 96, 64), earthMat);
  scene.add(earthMesh);
  scene.add(
    new THREE.Mesh(
      new THREE.SphereGeometry(EARTH_R * 1.002, 24, 12),
      new THREE.MeshBasicMaterial({ color: 0x7ab7ff, wireframe: true, transparent: true, opacity: 0.05 }),
    ),
  );
  // Outer atmosphere shell (soft halo seen from any angle).
  const atmosphere = new THREE.Mesh(
    new THREE.SphereGeometry(EARTH_R * 1.045, 48, 48),
    new THREE.ShaderMaterial({
      transparent: true,
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { sunDirection: { value: new THREE.Vector3(1, 0, 0) } },
      vertexShader: /* glsl */ `
        varying vec3 vNormal;
        varying vec3 vWorldPos;
        void main() {
          vNormal = normalize(mat3(modelMatrix) * normal);
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorldPos = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 sunDirection;
        varying vec3 vNormal;
        varying vec3 vWorldPos;
        void main() {
          vec3 viewDir = normalize(cameraPosition - vWorldPos);
          float glow = pow(0.62 - dot(normalize(vNormal), viewDir) * 0.4, 3.5);
          vec3 s = normalize(sunDirection);
          float dayAmount = smoothstep(-0.3, 0.5, dot(normalize(vNormal), s));
          // Tight, dim halo: a whisper of blue on the day limb, almost nothing
          // at night — no white glow washing out the dark side.
          vec3 tint = mix(vec3(0.01, 0.02, 0.05), vec3(0.10, 0.22, 0.45), dayAmount);
          gl_FragColor = vec4(tint, clamp(glow, 0.0, 1.0) * 0.28);
        }
      `,
    }),
  );
  scene.add(atmosphere);

  // ─── Lighting (mostly handled by the shader; lights for the satellites) ───
  scene.add(new THREE.AmbientLight(0xffffff, 0.28));
  const sun = new THREE.DirectionalLight(0xffffff, 0.75);
  scene.add(sun);
  const sunTarget = new THREE.Object3D();
  scene.add(sunTarget);
  sun.target = sunTarget;

  // ─── The sun, at its REAL current direction ───────────────────────────────
  // NOAA low-precision solar ephemeris (±0.01°) → sub-solar point (lat/lon)
  // via GMST, then the mesh's latLonToVec3 mapping. The shader's sunDirection
  // and the DirectionalLight use the same vector, so the terminator and the
  // visible sun agree with reality.
  function solarDirectionEquatorial(date) {
    const rad = Math.PI / 180;
    const jd = date.getTime() / 86400000 + 2440587.5;
    const n = jd - 2451545.0; // days since J2000
    const L = (280.460 + 0.9856474 * n) % 360; // mean longitude
    const g = ((357.528 + 0.9856003 * n) % 360) * rad; // mean anomaly
    const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad; // ecliptic lon
    const eps = (23.439 - 0.0000004 * n) * rad; // obliquity
    return {
      x: Math.cos(lambda),
      y: Math.cos(eps) * Math.sin(lambda),
      z: Math.sin(eps) * Math.sin(lambda),
    };
  }

  // Distance: far enough that the sun reads as a distant star rather than a
  // lamp bolted to the globe's edge — that separation is what keeps the
  // earth from looking flooded with light. Direction stays the REAL solar
  // direction; only the distance is artistic (sun is NOT to scale).
  const SUN_DIST_UNITS = 95;
  function updateSunPosition() {
    const d = new Date();
    const dir = solarDirectionEquatorial(d);
    const n = d.getTime() / 86400000 + 2440587.5 - 2451545.0;
    const raDeg = (Math.atan2(dir.y, dir.x) * 180 / Math.PI + 360) % 360;
    const decDeg = Math.asin(dir.z) * 180 / Math.PI;
    const gmst = (280.46061837 + 360.98564736629 * n) % 360;
    const lonSub = ((raDeg - gmst + 540) % 360) - 180; // over-earth longitude
    const pos = latLonToVec3(decDeg, lonSub, SUN_DIST_UNITS);
    // Unit vector in the mesh frame — feeds the shader + the light:
    const unit = pos.clone().normalize();
    earthMat.uniforms.sunDirection.value.copy(unit);
    atmosphere.material.uniforms.sunDirection.value.copy(unit);
    sun.position.copy(pos);
    sunTarget.position.set(0, 0, 0);
    // The visible sun (shader sphere + corona) sits at the same point:
    sunGroup.position.copy(pos);
    return pos;
  }

  // Realistic sun — the full multi-layer effect from the "Realistic Sun"
  // three.js example (fwdapps.net/l/sun): perlin cubemap → shader sphere →
  // glow ribbon → flying rays → arcing magma flares. Scaled up ~12× to read
  // at earth-view distance; NOT to scale, but always in the real direction.
  const { RealisticSun } = await import("./sun.js");
  const sunFx = new RealisticSun(renderer);
  const sunGroup = sunFx.group;
  sunGroup.scale.setScalar(7); // 1.5-radius sphere → ~10.5 world units
  scene.add(sunGroup);

  // ─── Receiver ground point + user marker ─────────────────────────────────
  // lat/lon → ECEF-ish on the sphere. lat/lon in degrees, radius in world units.
  function latLonToVec3(lat, lon, radius) {
    const phi = (90 - lat) * (Math.PI / 180);
    const theta = (lon + 180) * (Math.PI / 180);
    return new THREE.Vector3(
      -radius * Math.sin(phi) * Math.cos(theta),
      radius * Math.cos(phi),
      radius * Math.sin(phi) * Math.sin(theta),
    );
  }

  let userMarker = null;
  let userLat = null;
  let userLon = null;

  function setUserPosition(lat, lon) {
    if (lat == null || lon == null) return;
    const moved = userLat === null || userLon === null
      || Math.abs(lat - userLat) > 0.0005 || Math.abs(lon - userLon) > 0.0005;
    userLat = lat;
    userLon = lon;
    if (moved) {
      const pos = latLonToVec3(lat, lon, EARTH_R + 0.02);
      if (!userMarker) {
        // Pin: bright dot + pulsing ring.
        const group = new THREE.Group();
        const dot = new THREE.Mesh(
          new THREE.SphereGeometry(0.09, 16, 16),
          new THREE.MeshBasicMaterial({ color: 0x34d351 }),
        );
        dot.position.copy(pos);
        group.add(dot);
        const ringGeo = new THREE.RingGeometry(0.16, 0.2, 32);
        const ringMat = new THREE.MeshBasicMaterial({ color: 0x34d351, transparent: true, opacity: 0.8, side: THREE.DoubleSide });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.position.copy(pos);
        ring.lookAt(0, 0, 0);
        group.add(ring);
        group.userData.ring = ring;
        userMarker = group;
        scene.add(group);
      } else {
        userMarker.children[0].position.copy(pos);
        const ring = userMarker.userData.ring;
        ring.position.copy(pos);
        ring.lookAt(0, 0, 0);
      }
    }
  }

  // ─── Satellites ───────────────────────────────────────────────────────────
  // From the receiver's viewpoint: elevation 0° = on the horizon, 90° =
  // straight up. Each satellite renders on the az/el ray from the user's
  // ground point at GNSS orbit altitude (~20,200 km MEO ≈ scaled here to sit
  // well above the surface but inside the camera range). The spike from the
  // ground point to the satellite makes the geometry readable.
  const SAT_ALT_SCALE = 1.45; // satellite ring radius ≈ EARTH_R * 1.45
  const satMeshes = new Map(); // prn → { group, mesh, data, ringMat }
  const SAT_COLORS = {
    used: 0x34d351,
    tracked: 0x7ab7ff,
    idle: 0x5a6b7d,
  };

  function satColor(s) {
    if (s.used) return SAT_COLORS.used;
    if (s.snr > 0) return SAT_COLORS.tracked;
    return SAT_COLORS.idle;
  }

  function satLabel(s) {
    // GP→GPS, GL→GLONASS, GA→Galileo, GB/BD→BeiDou
    const m = /^([A-Z]{2})?0*(\d+)$/.exec(s.prn || "");
    const system = { GP: "GPS", GL: "GLONASS", GA: "Galileo", GB: "BeiDou", BD: "BeiDou", "": "GNSS" }[m?.[1] || ""];
    return system ? `${system} ${m?.[2] || s.prn}` : s.prn;
  }

  function satWorldPos(s) {
    if (!userLat && userLat !== 0) return null;
    // az: 0°=N, 90°=E (clockwise from north). el: 0°=horizon, 90°=zenith.
    const az = s.azimuth >= 0 ? s.azimuth : 0;
    const el = s.elevation >= 0 ? s.elevation : 0;
    // Local ENU frame at the user's ground point:
    const ground = latLonToVec3(userLat, userLon, EARTH_R);
    const up = ground.clone().normalize();
    const north = new THREE.Vector3(0, 1, 0).projectOnPlane(up).normalize();
    const east = new THREE.Vector3().crossVectors(north, up).normalize();
    // Direction the satellite sits on, per az/el convention:
    const dir = new THREE.Vector3()
      .addScaledVector(east, Math.sin((az * Math.PI) / 180) * Math.cos((el * Math.PI) / 180))
      .addScaledVector(north, Math.cos((az * Math.PI) / 180) * Math.cos((el * Math.PI) / 180))
      .addScaledVector(up, Math.sin((el * Math.PI) / 180));
    dir.normalize();
    // Height above the surface: elevation 0° ≈ just above the ground,
    // elevation 90° (zenith) at SAT_ALT_SCALE. GNSS MEO ≈ 20,200 km, scaled.
    const height = (SAT_ALT_SCALE - 1) * EARTH_R * Math.sin((Math.max(el, 4) * Math.PI) / 180) + 0.35;
    return ground.add(dir.multiplyScalar(height));
  }

  function updateSatellites(sats) {
    if (!Array.isArray(sats)) return;
    const seen = new Set();
    for (const s of sats) {
      const prn = String(s.prn);
      seen.add(prn);
      const pos = satWorldPos(s);
      if (!pos) continue;
      let entry = satMeshes.get(prn);
      if (!entry) {
        const group = new THREE.Group();
        const mesh = new THREE.Mesh(
          new THREE.SphereGeometry(0.16, 16, 16),
          new THREE.MeshBasicMaterial({ color: satColor(s), transparent: true, opacity: 0.95 }),
        );
        mesh.userData.prn = prn;
        group.add(mesh);
        // Spike from the ground point to the satellite (visual tether).
        const ringGeo = new THREE.RingGeometry(0.26, 0.32, 32);
        const ringMat = new THREE.MeshBasicMaterial({ color: satColor(s), transparent: true, opacity: 0.6, side: THREE.DoubleSide });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        group.add(ring);
        entry = { group, mesh, ring, ringMat, data: s };
        satMeshes.set(prn, entry);
        scene.add(group);
      }
      entry.data = s;
      const color = new THREE.Color(satColor(s));
      entry.mesh.material.color = color;
      entry.ringMat.color = color;
      entry.group.position.copy(pos);
      entry.ring.lookAt(0, 0, 0);
      // Pulse tracked/used satellites gently.
      entry.group.userData.pulse = s.used ? 1.0 : s.snr > 0 ? 0.55 : 0.25;
    }
    // Remove satellites no longer reported.
    for (const [prn, entry] of satMeshes) {
      if (!seen.has(prn)) {
        scene.remove(entry.group);
        satMeshes.delete(prn);
        if (selectedPrn === prn) closeSatModal();
      }
    }
  }

  // ─── Orbit controls ───────────────────────────────────────────────────────
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.enablePan = false;
  controls.minDistance = EARTH_R + 1.5;
  controls.maxDistance = SUN_DIST_UNITS * 1.2; // close range: sun stays near
  controls.zoomSpeed = 1.2;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.6;
  controls.rotateSpeed = 0.55;
  // Stop auto-rotation as soon as the user interacts, resume after idle.
  let idleTimer = null;
  controls.addEventListener("start", () => {
    controls.autoRotate = false;
    if (idleTimer) clearTimeout(idleTimer);
  });
  controls.addEventListener("end", () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => (controls.autoRotate = true), 8000);
  });

  // ─── Picking (click = select satellite; drag = rotate) ────────────────────
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let pointerDown = null;
  let selectedPrn = null;

  renderer.domElement.addEventListener("pointerdown", (e) => {
    pointerDown = { x: e.clientX, y: e.clientY };
  });
  renderer.domElement.addEventListener("pointerup", (e) => {
    if (!pointerDown) return;
    const dx = e.clientX - pointerDown.x;
    const dy = e.clientY - pointerDown.y;
    pointerDown = null;
    if (Math.hypot(dx, dy) > 6) return; // was a drag
    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const meshes = [...satMeshes.values()].map((en) => en.mesh);
    const hits = raycaster.intersectObjects(meshes, false);
    if (hits.length > 0) {
      selectSatellite(hits[0].object.userData.prn);
    } else {
      closeSatModal();
    }
  });

  function selectSatellite(prn) {
    selectedPrn = prn;
    const entry = satMeshes.get(prn);
    if (!entry) return;
    openSatModal(entry.data);
  }

  // ─── Modal (same card structure as the radar/wardrive .apm modal) ─────────
  const modal = document.getElementById("gps-sat-modal");
  const modalBackdrop = document.getElementById("gps-sat-modal-backdrop");
  const modalClose = document.getElementById("gps-sat-modal-close");

  function badge(status, label) {
    return `<span class="gsm-status-badge ${status}">${label}</span>`;
  }

  function openSatModal(s) {
    if (!modal || !s) return;
    const label = satLabel(s);
    document.getElementById("gsm-title").textContent = label;
    document.getElementById("gsm-prn").textContent = `${label} (PRN ${s.prn})`;
    const statusEl = document.getElementById("gsm-status");
    statusEl.innerHTML = s.used
      ? badge("used", "● EN FIX — parte de la solución de posición")
      : s.snr > 0
        ? badge("tracked", "▲ SEGUIMIENTO — señal recibida, aún no en fix")
        : badge("idle", "○ EN VISTA — demasado débil para usarse");
    document.getElementById("gsm-snr").textContent = s.snr > 0 ? `${s.snr} dB-Hz` : "sin señal";
    document.getElementById("gsm-elev").textContent = s.elevation >= 0 ? `${s.elevation}° sobre el horizonte` : "desconocida";
    document.getElementById("gsm-azim").textContent = s.azimuth >= 0 ? `${s.azimuth}° (desde el norte, sentido horario)` : "desconocido";
    document.getElementById("gsm-ground").textContent =
      s.elevation >= 0 && s.azimuth >= 0 && userLat != null
        ? `${s.elevation}° el · ${s.azimuth}° az desde tu posición`
        : "—";
    document.getElementById("gsm-dist").textContent = "≈ 20,200 km (órbita MEO de GNSS)";
    modal.classList.remove("hidden");
  }

  function closeSatModal() {
    selectedPrn = null;
    modal?.classList.add("hidden");
  }

  modalClose?.addEventListener("click", closeSatModal);
  modalBackdrop?.addEventListener("click", closeSatModal);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSatModal();
  });

  // ─── Snapshot plumbing from gps.js ────────────────────────────────────────
  window.__akbalGlobe = {
    update(lat, lon, sats) {
      const firstPositioning = userLat === null && lat != null;
      setUserPosition(lat, lon);
      if (firstPositioning) {
        // Frame the camera over the receiver's position so the pin is in
        // view the moment the globe opens.
        const target = latLonToVec3(lat, lon, EARTH_R * 2.6);
        camera.position.copy(target);
        controls.target.set(0, 0, 0);
        controls.update();
      }
      updateSatellites(sats);
    },
  };

  // ─── Render loop ──────────────────────────────────────────────────────────
  const clock = new THREE.Clock();
  let loopRunning = false;
  let globeActive = false;
  let sunRepositionAt = 0;
  let lastFrameAt = 0;
  function animate() {
    if (!globeActive) {
      loopRunning = false;
      return; // paused when the map view is shown
    }
    requestAnimationFrame(animate);
    loopRunning = true;
    const now = Date.now();
    const delta = Math.min(0.1, (now - (lastFrameAt || now)) / 1000); // clamp tab-switch spikes
    lastFrameAt = now;
    const t = clock.getElapsedTime();
    // Pulse the user pin ring.
    if (userMarker) {
      const ring = userMarker.userData.ring;
      const pulse = 1 + 0.25 * Math.sin(t * 2.2);
      ring.scale.setScalar(pulse);
      ring.material.opacity = 0.75 - 0.25 * Math.sin(t * 2.2);
    }
    // Gentle pulse on satellite rings.
    for (const [, en] of satMeshes) {
      const amp = en.group.userData.pulse || 0.25;
      en.ring.scale.setScalar(1 + 0.3 * amp * Math.sin(t * 1.8 + en.group.position.x));
      en.mesh.material.opacity = 0.7 + 0.3 * amp * Math.sin(t * 2 + en.group.position.y);
    }
    // Sun: real position (refreshed every 60s — it barely moves) + effects.
    if (!sunRepositionAt || now - sunRepositionAt > 60_000) {
      sunRepositionAt = now;
      updateSunPosition();
    }
    sunFx.update(camera, delta);
    controls.update();
    renderer.render(scene, camera);
  }

  window.__akbalGlobe.setActive = (on) => {
    globeActive = on;
    if (on) {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
      if (!loopRunning) animate();
    }
  };
  window.__akbalGlobe.isActive = () => globeActive;

  window.addEventListener("resize", () => {
    if (!globeActive) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}