// Globe 3D view (docs/gps.md): Three.js earth with the live GPS position pin
// and the satellites reported by the dongle orbiting it. Click a satellite
// for its detail card (same modal design as wardriving). The satellite
// positions are derived from az/el/SNR — elevation 90° = right above the
// receiver, so each satellite sits on a spike from the receiver's ground
// point; that's how a single-station GNSS receiver sees the sky (no real
// orbital ephemeris available). Module loaded only when the user toggles to
// globe view; gps.js keeps polling /api/gps/status and forwards snapshots.
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
  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 2000);
  camera.position.set(0, 6, 22);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x03060c, 1);

  // Slow ambient starfield backdrop.
  {
    const starGeo = new THREE.BufferGeometry();
    const starCount = 1500;
    const positions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const r = 400 + Math.random() * 300;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.cos(phi);
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    starGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const starMat = new THREE.PointsMaterial({ color: 0x9fb6d9, size: 1.2, sizeAttenuation: true, transparent: true, opacity: 0.8 });
    const stars = new THREE.Points(starGeo, starMat);
    scene.add(stars);
  }

  // ─── Earth ────────────────────────────────────────────────────────────────
  const EARTH_R = 10;
  const loader = new THREE.TextureLoader();
  let earthMesh = null;
  try {
    const dayTex = await loader.loadAsync("./vendor/textures/earth-day.jpg");
    dayTex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshPhongMaterial({
      map: dayTex,
      specular: new THREE.Color(0x223344),
      shininess: 8,
    });
    earthMesh = new THREE.Mesh(new THREE.SphereGeometry(EARTH_R, 64, 64), mat);
    scene.add(earthMesh);
    // Subtle atmosphere glow.
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(EARTH_R * 1.025, 48, 48),
      new THREE.MeshBasicMaterial({ color: 0x2b5ea8, transparent: true, opacity: 0.14, side: THREE.BackSide }),
    );
    scene.add(glow);
  } catch {
    // Texture fetch failed (offline Pi): procedural wireframe globe.
    earthMesh = new THREE.Mesh(
      new THREE.SphereGeometry(EARTH_R, 48, 32),
      new THREE.MeshBasicMaterial({ color: 0x123452, wireframe: true, transparent: true, opacity: 0.7 }),
    );
    scene.add(earthMesh);
  }
  // Lat/long grid hint (subtle) — helps reading az/el positions.
  {
    const grid = new THREE.Mesh(
      new THREE.SphereGeometry(EARTH_R * 1.002, 24, 12),
      new THREE.MeshBasicMaterial({ color: 0x7ab7ff, wireframe: true, transparent: true, opacity: 0.07 }),
    );
    scene.add(grid);
  }

  // ─── Lighting ─────────────────────────────────────────────────────────────
  scene.add(new THREE.AmbientLight(0xffffff, 0.75));
  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.position.set(30, 12, 18);
  scene.add(sun);

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
    const system = { GP: "GPS", GL: "GLONASS", GA: "Galileo", GB: "BeiDou", BD: "BeiDou", "" : "GNSS" }[m?.[1] || ""];
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
  controls.maxDistance = EARTH_R * 6;
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
  function animate() {
    if (!globeActive) {
      loopRunning = false;
      return; // paused when the map view is shown
    }
    requestAnimationFrame(animate);
    loopRunning = true;
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