import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

const EYE_HEIGHT = 1.6; // metres -- an absolute real-world constant, doesn't scale with cellSize
let PLAYER_RADIUS = 0.25; // default; shrunk to fit doorways once cellSize is known (see below)
const MOVE_SPEED = 3.0; // m/s -- a brisk walk. 6.0 was a dead sprint once cellSize is real metres.
const DAMPING = 8.0;
const DEFAULT_POINTER_SPEED = 0.3; // PointerLockControls' own default (1) reads as way too fast for most mice

// ---------- door leaves: visual/animated only, never affect collision ----------
// Deliberately NOT wired into collides() -- that grid-based check is what took this
// whole project multiple rounds of hard-won fixes to get reliably walkable, and
// making a closed door block movement would mean re-deriving "is the player's box
// overlapping this door's swept volume" as an entirely separate collision system
// alongside it. These swing open/closed purely as a visual, automatic-door effect;
// the doorway itself stays exactly as walkable as it already was.
const DOOR_HEIGHT = 2.0; // metres -- matches LevelBuilder.java's DOOR_HEIGHT (lintels start here)
const DOOR_OPEN_ANGLE = Math.PI / 2; // 90 degrees -- must be fully flat against the wall, since doors
// have no collision: anything less leaves the leaf swung diagonally across the doorway's walking line,
// so the player walks straight into (and the camera clips through) the leaf mesh
const DOOR_SWING_RATE = 6.0; // 1/s, exponential smoothing -- same pattern as camera rotation smoothing

// ---------- scene ----------
const scene = new THREE.Scene();

// Vertical gradient sky baked into a 2x256 CanvasTexture rather than a ShaderMaterial
// sphere (an extra mesh plus a custom shader that then has to be taught about fog) or a
// CSS gradient behind a transparent clear (fog would fade geometry to transparent, which
// makes the CSS color the de-facto fog color anyway -- same result, less control).
// It is screen-space fixed rather than equirect, so it does not swing when you look up;
// irrelevant here, since the ceiling plane blocks the sky and far=18 fogs out any gap.
function makeSkyTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, 256);
  gradient.addColorStop(0, '#0a1929');
  gradient.addColorStop(0.55, '#16324a');
  gradient.addColorStop(1, '#1b3a52');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 2, 256);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
scene.background = makeSkyTexture();

// 0x16324a is the sky gradient's MIDDLE stop, not the top one: the sky you actually
// glimpse through a doorway or gap is at eye level, so matching the horizon band is what
// makes a distant corridor fade out instead of ending in a visible seam. Near/far stay at
// Phase 1's 3/18 -- these are indoor rooms, not an open maze.
scene.fog = new THREE.Fog(0x16324a, 3, 18);

// far=100 (was 200): these are single-floor indoor scenes, rarely more than ~20-30m across.
// A needlessly distant far plane starves the depth buffer's precision near the camera,
// which is exactly where two coincident surfaces (see the floor y-offset below) need it most.
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 100);

// NOT using logarithmicDepthBuffer: it's a well-documented perf trap specifically with
// InstancedMesh (our wall rendering) on integrated GPUs -- can tank frame rate badly enough
// that mouse-look updates (applied instantly, decoupled from the render loop) pile up between
// rendered frames and the camera appears to "jump" between poses instead of turning smoothly,
// rather than causing visible flicker. The floor's y-offset below already fixes the actual
// z-fighting (floor exactly coplanar with every wall's bottom face) without this cost.
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- lighting ----------
// Cool sky-fill plus a warm key, instead of neutral white. This is where the mood comes
// from -- deliberately NOT tone mapping. Three r185 already defaults to SRGBColorSpace
// output with ColorManagement on, so colors are managed; ACES on top would re-grade all
// 20 hand-picked hex values at once, and it compresses saturation hardest in exactly the
// 0x5a-0x9a midrange where the 14 ROOM_PALETTE entries live -- their mutual separation is
// the whole point of that feature. Tinting the lights shifts every surface uniformly, so
// every color relationship already tuned survives intact.
scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x0a1929, 1.1));
const sun = new THREE.DirectionalLight(0xfff2dd, 1.3);
sun.position.set(15, 25, 10);
scene.add(sun);

// ---------- controls (current API: domElement is mandatory, no getObject()) ----------
const controls = new PointerLockControls(camera, document.body);
scene.add(controls.object);

const storedSensitivity = parseFloat(localStorage.getItem('pointerSensitivity'));
controls.pointerSpeed = Number.isFinite(storedSensitivity) ? storedSensitivity : DEFAULT_POINTER_SPEED;

const overlay = document.getElementById('overlay');
// The whole dark backdrop is clickable to start, not just the "Click to start" text --
// visually the entire overlay reads as one clickable surface, so a listener scoped to
// just the text block was an easy-to-hit dead zone everywhere else on screen.
overlay.addEventListener('click', () => controls.lock());
// body.locked drives the CSS that only makes sense while playing (crosshair, HUD) --
// cheaper and less brittle than duplicating the lock state into each element.
controls.addEventListener('lock', () => {
  overlay.classList.add('hidden');
  document.body.classList.add('locked');
});
controls.addEventListener('unlock', () => {
  overlay.classList.remove('hidden');
  document.body.classList.remove('locked');
});

// ---------- mouse-look: smoothed, replacing PointerLockControls' raw instant rotation ----------
// Diagnostic data (see below) showed input itself arrives smoothly and often (~140/s, no real
// gaps) but with occasional huge single-event deltas -- a fast mouse flick, completely normal
// human mouse use. PointerLockControls applies every event's rotation instantly and unsmoothed
// (see its source: euler.y -= movementX * 0.002 * pointerSpeed, applied straight to the camera
// quaternion in its own 'mousemove' listener), so one big-delta event alone snaps the view in a
// single frame. Movement already smooths velocity via DAMPING; rotation had nothing equivalent.
// Fix: track a target yaw/pitch using PointerLockControls' own formula (0.002 * pointerSpeed,
// so overall sensitivity feel is unchanged), then smooth the camera's ACTUAL orientation toward
// that target every frame in the animate loop instead of snapping straight to it.
// PointerLockControls still runs its own listener and sets the camera quaternion instantly and
// directly, same as before -- animate() below just overwrites that with the smoothed value
// every frame, before the frame renders, so its raw/instant result never becomes visible.
const ROTATION_SMOOTHING_RATE = 30; // 1/s -- higher = snappier, lower = smoother but laggier
const PITCH_LIMIT = Math.PI / 2 - 0.001;
// Time-based smoothing alone spreads a spike over a few frames instead of one, softening a
// hard "snap" into a fast "accelerated" turn -- still visible, because the total rotation
// amount is unchanged, just spread out. Clamping the raw per-event delta caps that amount
// directly. 50px covers legitimate fast mouse movement (normal events run single/low-double
// digits, see the on-screen log); anything past that is far more likely OS-level mouse
// acceleration ("enhance pointer precision") or event-coalescing amplifying one instant of
// physical movement than a real 50+ pixel jump between two polls a few ms apart.
const MAX_MOUSE_DELTA = 50;
let targetYaw = 0, targetPitch = 0, currentYaw = 0, currentPitch = 0;
const lookEuler = new THREE.Euler(0, 0, 0, 'YXZ');

document.addEventListener('mousemove', (e) => {
  if (!controls.isLocked) return;

  const dx = Math.max(-MAX_MOUSE_DELTA, Math.min(MAX_MOUSE_DELTA, e.movementX));
  const dy = Math.max(-MAX_MOUSE_DELTA, Math.min(MAX_MOUSE_DELTA, e.movementY));
  targetYaw -= dx * 0.002 * controls.pointerSpeed;
  targetPitch -= dy * 0.002 * controls.pointerSpeed;
  targetPitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, targetPitch));
});

// ---------- saved level picker ----------
const savedLevelSelect = document.getElementById('savedLevelSelect');
const loadLevelButton = document.getElementById('loadLevelButton');
const loadLevelStatus = document.getElementById('loadLevelStatus');

fetch('/api/levels', { cache: 'no-store' })
  .then((res) => res.json())
  .then((data) => {
    savedLevelSelect.innerHTML = '';
    for (const name of data.levels) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      savedLevelSelect.appendChild(opt);
    }
    if (data.levels.length === 0) {
      savedLevelSelect.innerHTML = '<option>No saved levels</option>';
      loadLevelButton.disabled = true;
    }
  })
  .catch(() => {
    savedLevelSelect.innerHTML = '<option>Failed to load list</option>';
    loadLevelButton.disabled = true;
  });

loadLevelButton.addEventListener('click', async () => {
  const name = savedLevelSelect.value;
  loadLevelButton.disabled = true;
  loadLevelStatus.className = '';
  loadLevelStatus.textContent = 'Loading…';
  try {
    const res = await fetch('/api/load-level', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
    loadLevelStatus.className = 'ok';
    loadLevelStatus.textContent = `Loaded "${name}". Reloading…`;
    setTimeout(() => window.location.reload(), 600);
  } catch (err) {
    loadLevelStatus.className = 'error';
    loadLevelStatus.textContent = String(err.message || err);
    loadLevelButton.disabled = false;
  }
});

// ---------- sensitivity slider ----------
const sensitivitySlider = document.getElementById('sensitivitySlider');
const sensitivityValue = document.getElementById('sensitivityValue');
sensitivitySlider.value = controls.pointerSpeed;
sensitivityValue.textContent = controls.pointerSpeed.toFixed(2);
sensitivitySlider.addEventListener('input', () => {
  const speed = parseFloat(sensitivitySlider.value);
  controls.pointerSpeed = speed;
  sensitivityValue.textContent = speed.toFixed(2);
  localStorage.setItem('pointerSensitivity', String(speed));
});

// ---------- upload form ----------
const uploadPanel = document.getElementById('uploadPanel');
const uploadForm = document.getElementById('uploadForm');
const uploadButton = document.getElementById('uploadButton');
const uploadStatus = document.getElementById('uploadStatus');

// Now that the whole overlay is clickable to start, the whole panel (not just the form)
// needs to stop that click from bubbling up -- otherwise clicking its title, status text,
// or the sensitivity row's padding would accidentally engage pointer lock mid-interaction.
uploadPanel.addEventListener('click', (e) => e.stopPropagation());

uploadForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  uploadButton.disabled = true;
  uploadStatus.className = '';
  uploadStatus.textContent = 'Converting blueprint… this can take a few seconds.';

  try {
    const formData = new FormData(uploadForm);
    let res;
    try {
      res = await fetch('/api/convert', { method: 'POST', body: formData });
    } catch (networkErr) {
      // fetch() itself throws (not a 4xx/5xx response) only when the request never reached a
      // server at all -- e.g. server.py has died. Distinguish this from a real conversion
      // error so it's obvious the fix is "restart the server," not "try a different image."
      throw new Error('Could not reach the server -- it may have stopped running. Ask for it to be restarted, then try again.');
    }
    const data = await res.json();

    if (!res.ok || !data.success) {
      throw new Error(data.error || `Server returned HTTP ${res.status}`);
    }

    const pct = Math.round(data.reachableFraction * 100);
    if (data.warning) {
      uploadStatus.className = 'warn';
      uploadStatus.textContent = `${data.wallCount} walls, only ${pct}% of floor reachable. ${data.warning} Reloading…`;
      setTimeout(() => window.location.reload(), 4000);
    } else {
      uploadStatus.className = 'ok';
      uploadStatus.textContent = `Level built! ${data.wallCount} walls, ${pct}% of floor reachable. Reloading…`;
      setTimeout(() => window.location.reload(), 1200);
    }
  } catch (err) {
    uploadStatus.className = 'error';
    uploadStatus.textContent = String(err.message || err);
    uploadButton.disabled = false;
  }
});

// ---------- input ----------
const keyState = { forward: false, back: false, left: false, right: false };

window.addEventListener('keydown', (e) => setKey(e.code, true));
window.addEventListener('keyup', (e) => setKey(e.code, false));

function setKey(code, value) {
  switch (code) {
    case 'KeyW': case 'ArrowUp': keyState.forward = value; break;
    case 'KeyS': case 'ArrowDown': keyState.back = value; break;
    case 'KeyA': case 'ArrowLeft': keyState.left = value; break;
    case 'KeyD': case 'ArrowRight': keyState.right = value; break;
  }
}

// ---------- level loading ----------
let level = null;
let solidGrid = null; // array of strings, same shape as the Java grid
let doors = []; // populated by buildDoors() -- see the door-swing block in animate()

fetch('level01.json', { cache: 'no-store' }) // dynamically regenerated by uploads -- never serve a stale cached copy
  .then((res) => {
    if (!res.ok) throw new Error(`Failed to load level01.json: HTTP ${res.status}`);
    return res.json();
  })
  .then((data) => {
    level = data;
    solidGrid = data.grid;
    // On a fine grid (small cellSize, e.g. a real floor plan), a fixed 0.25m
    // radius could exceed a narrow doorway's width. Shrink it proportionally
    // to cellSize so doorways stay passable regardless of grid resolution.
    PLAYER_RADIUS = Math.min(0.25, data.cellSize * 1.5);
    buildLevel(data);
    doors = buildDoors(data);
    bakeMinimap(data);
    checkDoorwayClearance(data);

    camera.position.set(data.spawn.x, EYE_HEIGHT, data.spawn.z);
    console.log(`Loaded "${data.name}": ${data.width}x${data.height}, ${data.walls.length} walls`);
  })
  .catch((err) => {
    console.error(err);
    document.getElementById('promptTitle').textContent = 'Failed to load level';
    document.getElementById('promptSubtitle').textContent = String(err.message || err);
  });

// ---------- per-room floor coloring ----------
// Flood-fills open floor cells (4-connected) to find rooms -- '3' (doorway) cells are
// deliberately excluded from the flood-fill so a doorway acts as a boundary between
// rooms instead of merging them into one giant region (which is what carve_doorways
// is FOR: doors connect every room into one walkable network, so including '3' cells
// here would flood-fill the whole building as a single "room" and defeat the point).
// A '3' cell still needs a floor tile, though, so it just inherits whichever
// neighbouring room's color it touches first.
//
// '2' is the single spawn cell and is ordinary walkable floor -- the marker says where
// the player starts, not that the cell is special. Treating only '0' as room floor left
// exactly one tile with no floor mesh under it (a hole you spawn standing on), and once
// the HUD started reading room ids it also reported no room until you stepped off.
const isRoomFloor = (cell) => cell === '0' || cell === '2';
// Every entry is the original hue lifted by a uniform +0x10 per channel, now that the
// walls and ceiling are dark navy. A uniform offset raises value without touching the
// mutual separation between hues, which is the entire reason this palette exists --
// shifting them toward monochrome to "match" the drafting theme would delete the feature.
const ROOM_PALETTE = [
  0x6a8d7b, 0x7b7a9f, 0x9a7f6a, 0x6a8a9f, 0x9a6a7f,
  0x7f9a6a, 0x6a6a9a, 0x9a8a6a, 0x6a9a8a, 0x8a6a9a,
  0x9a6a6a, 0x6a9a6a, 0x8a8a6a, 0x6a8a8a,
];
// Doorway cell with no room neighbour to inherit from. Not the rare fallback it reads
// like -- a real floor plan produces a few hundred of these, so it needs to sit in the
// palette rather than stand out.
const ORPHAN_DOORWAY_COLOR = 0x5f7d94;

// Set once by buildLevel(); the HUD and the minimap's current-room highlight both read
// this same closure, so the room number on screen and the floor color underfoot are the
// same index by construction and can never disagree.
let roomIdOf = null;

function computeRoomIds(data) {
  const rows = data.height, cols = data.width;
  const grid = data.grid;
  const idx = (r, c) => r * cols + c;
  const roomId = new Int32Array(rows * cols).fill(-1);
  let nextRoom = 0;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!isRoomFloor(grid[r][c]) || roomId[idx(r, c)] !== -1) continue;
      const stack = [[r, c]];
      roomId[idx(r, c)] = nextRoom;
      while (stack.length) {
        const [cr, cc] = stack.pop();
        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nr = cr + dr, nc = cc + dc;
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
          if (!isRoomFloor(grid[nr][nc]) || roomId[idx(nr, nc)] !== -1) continue;
          roomId[idx(nr, nc)] = nextRoom;
          stack.push([nr, nc]);
        }
      }
      nextRoom++;
    }
  }

  // Returns the room index rather than a color, so callers that want something other
  // than a floor tile (the HUD's room label, the minimap's highlight) don't have to
  // reverse a palette lookup. null = wall cell (no floor tile), -1 = orphan doorway.
  return function lookupRoomId(r, c) {
    const cell = grid[r][c];
    if (isRoomFloor(cell)) return roomId[idx(r, c)];
    if (cell === '3') {
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        if (isRoomFloor(grid[nr][nc])) return roomId[idx(nr, nc)];
      }
      return -1; // isolated doorway cell with no '0' neighbour -- shouldn't happen, safe fallback
    }
    return null; // wall cell, not floor
  };
}

// ---------- doorway detection (for door leaves) ----------
// Groups '3' cells into connected components (8-connectivity, matching the
// regularization/jog-absorption passes in blueprint_to_grid.py that produced them)
// and returns each one's bounding box -- one door leaf gets built per component.
function computeDoorways(data) {
  const rows = data.height, cols = data.width;
  const grid = data.grid;
  const visited = new Uint8Array(rows * cols);
  const idx = (r, c) => r * cols + c;
  const doorways = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (grid[r][c] !== '3' || visited[idx(r, c)]) continue;
      const stack = [[r, c]];
      visited[idx(r, c)] = 1;
      let r0 = r, r1 = r, c0 = c, c1 = c;
      while (stack.length) {
        const [cr, cc] = stack.pop();
        r0 = Math.min(r0, cr); r1 = Math.max(r1, cr);
        c0 = Math.min(c0, cc); c1 = Math.max(c1, cc);
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const nr = cr + dr, nc = cc + dc;
            if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
            if (grid[nr][nc] !== '3' || visited[idx(nr, nc)]) continue;
            visited[idx(nr, nc)] = 1;
            stack.push([nr, nc]);
          }
        }
      }
      doorways.push({ r0, r1, c0, c1 });
    }
  }
  return doorways;
}

// Builds one hinged door leaf per doorway. Each entry tracks its own pivot (the
// hinge point) and swing state; animate() drives the actual open/close motion by
// checking distance from the player each frame -- see DOOR_* constants above for
// why this never touches collision.
function buildDoors(data) {
  const doorways = computeDoorways(data);
  const cellSize = data.cellSize;
  const leafMaterial = new THREE.MeshStandardMaterial({ color: 0x6b4a30 });
  const leafGeometry = new THREE.BoxGeometry(1, 1, 1);
  const doors = [];

  doorways.forEach(({ r0, r1, c0, c1 }) => {
    const worldWidthX = (c1 - c0 + 1) * cellSize;
    const worldWidthZ = (r1 - r0 + 1) * cellSize;
    const axisIsX = worldWidthX >= worldWidthZ; // the doorway's long axis, i.e. the
    // direction a real door's width would run along (crossing/walking-through
    // direction is the other, shorter axis)
    const leafWidth = Math.min(0.9, (axisIsX ? worldWidthX : worldWidthZ) * 0.85);
    const leafThickness = Math.max(0.04, cellSize * 0.6);

    const centerCol = (c0 + c1) / 2;
    const centerRow = (r0 + r1) / 2;
    // Hinge at one edge of the opening along its long axis; row->z is inverted
    // (z = (rows-1-row)*cellSize), so the "r0" edge is the LARGER z, not smaller.
    const hingeX = axisIsX ? c0 * cellSize : centerCol * cellSize;
    const hingeZ = axisIsX ? (data.height - 1 - centerRow) * cellSize : (data.height - 1 - r0) * cellSize;
    const baseRotationY = axisIsX ? 0 : Math.PI / 2;

    const pivot = new THREE.Object3D();
    pivot.position.set(hingeX, 0, hingeZ);
    scene.add(pivot);

    const leaf = new THREE.Mesh(leafGeometry, leafMaterial);
    leaf.scale.set(leafWidth, DOOR_HEIGHT, leafThickness);
    leaf.position.set(leafWidth / 2, DOOR_HEIGHT / 2, 0); // extends outward from the hinge
    pivot.add(leaf);

    doors.push({
      pivot,
      baseRotationY,
      currentSwing: 0,
      // world-space center of the opening, for the player-proximity check
      centerX: centerCol * cellSize,
      centerZ: (data.height - 1 - centerRow) * cellSize,
      triggerRadius: Math.max(leafWidth, 1.0) * 1.3,
    });
  });

  return doors;
}

function buildLevel(data) {
  // Unit box, scaled per-instance to each wall's own size -- LevelBuilder.java now
  // merges adjacent wall cells into rectangles (and doorway cells into lintels), so
  // walls arrive with real, varied dimensions instead of one cellSize cube each.
  const wallGeometry = new THREE.BoxGeometry(1, 1, 1);
  // Desaturated navy rather than the old light gray. A glow is a contrast illusion --
  // the emissive lintels below only read as lit if the surfaces around them are dark.
  // It also leaves the room floors as the only saturated surfaces in frame, which is
  // simultaneously the blueprint look and better room legibility than before.
  const wallMaterial = new THREE.MeshStandardMaterial({ color: 0x3b5270 });
  // A doorway lintel is any wall box shorter than the full wall height (LevelBuilder.java
  // emits these for '3' cells, spanning door-height up to the ceiling). Giving it the
  // same flat gray as every other wall made it visually disappear into the wall face --
  // the header was structurally a doorframe but read as just more wall. A distinct warm
  // trim color is the cheapest way to make an opening actually look like a built doorway
  // instead of a hole with matching-colored geometry above it. Now emissive drafting
  // cyan (matches --bp-line in style.css), so every doorway reads as a lit opening and
  // doubles as wayfinding down a dark corridor.
  const lintelMaterial = new THREE.MeshStandardMaterial({
    color: 0x0d2137, emissive: 0x4fc3f7, emissiveIntensity: 0.85,
  });

  const fullWalls = data.walls.filter((w) => w.size.y >= data.wallHeight - 0.001);
  const lintels = data.walls.filter((w) => w.size.y < data.wallHeight - 0.001);

  // One InstancedMesh per material, not one Mesh each. Phase 1's maze had 56
  // walls; a real floor plan can have hundreds -- individual Mesh objects would
  // mean hundreds of draw calls. Collision is unaffected: it reads the JSON
  // grid directly, not these meshes.
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();

  function addInstancedGroup(walls, material, scaleMul) {
    if (walls.length === 0) return;
    const mesh = new THREE.InstancedMesh(wallGeometry, material, walls.length);
    walls.forEach((wall, i) => {
      position.set(wall.position.x, wall.position.y, wall.position.z);
      scale.set(wall.size.x, wall.size.y, wall.size.z);
      if (scaleMul) scale.multiply(scaleMul);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(i, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    scene.add(mesh);
  }

  addInstancedGroup(fullWalls, wallMaterial);
  addInstancedGroup(lintels, lintelMaterial);

  // Halo: a second, slightly larger additive shell over the same lintel boxes. Gets a
  // bloom-like falloff for one extra draw call, with no EffectComposer in the project and
  // no post-processing pass over the whole frame.
  // X and Z only, Y stays exactly 1.0 -- a lintel is only (wallHeight - DOOR_HEIGHT) tall
  // and sits flush under the ceiling, so even a 6% vertical scale pokes the halo through
  // it. Emphatically not a PointLight per doorway: each added light forces a shader
  // permutation recompile and multiplies the per-fragment lighting loop across every
  // InstancedMesh in the scene.
  addInstancedGroup(lintels, new THREE.MeshBasicMaterial({
    color: 0x4fc3f7, transparent: true, opacity: 0.16,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  }), new THREE.Vector3(1.06, 1.0, 1.06));

  // Floor: one InstancedMesh per room color instead of one flat color for the whole
  // building. With everything the same color (walls, floor, ceiling all uniform),
  // there was no way to tell which room you were in while walking. First attempt
  // used a single InstancedMesh with per-instance (vertexColors) color, which
  // rendered solid black -- InstancedMesh.instanceColor needs the base geometry to
  // carry its own vertex-color attribute to multiply against, which a plain
  // PlaneGeometry doesn't have, and skipping that produced black instead of white.
  // Grouping by color and reusing the exact addInstancedGroup pattern already
  // proven for walls/lintels above sidesteps the whole issue.
  roomIdOf = computeRoomIds(data);
  const floorTileGeometry = new THREE.PlaneGeometry(data.cellSize, data.cellSize);
  floorTileGeometry.rotateX(-Math.PI / 2);
  const floorCellsByColor = new Map();
  for (let r = 0; r < data.height; r++) {
    for (let c = 0; c < data.width; c++) {
      const id = roomIdOf(r, c);
      if (id === null) continue; // wall cell, no floor tile here
      const color = id < 0 ? ORPHAN_DOORWAY_COLOR : ROOM_PALETTE[id % ROOM_PALETTE.length];
      if (!floorCellsByColor.has(color)) floorCellsByColor.set(color, []);
      floorCellsByColor.get(color).push({
        x: c * data.cellSize,
        // nudged just below y=0 -- every wall's bottom face sits exactly at y=0
        // (see LevelBuilder.java's y = wallHeight/2), so a coplanar floor is
        // textbook z-fighting, worse the more you rotate the camera.
        y: -0.01,
        z: (data.height - 1 - r) * data.cellSize,
      });
    }
  }
  for (const [color, cells] of floorCellsByColor) {
    const mesh = new THREE.InstancedMesh(
      floorTileGeometry, new THREE.MeshStandardMaterial({ color }), cells.length);
    cells.forEach((cell, i) => {
      matrix.identity();
      matrix.setPosition(cell.x, cell.y, cell.z);
      mesh.setMatrixAt(i, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    scene.add(mesh);
  }

  // One stretched ceiling plane -- kept flat/uniform rather than per-room like the
  // floor. Without it, looking through any doorway or gap (nothing bounds the space
  // from above) shows the sky background straight through, which reads as
  // broken/see-through rather than "this leads to another room."
  const floorWidth = data.width * data.cellSize;
  const floorDepth = data.height * data.cellSize;
  const floorGeometry = new THREE.PlaneGeometry(floorWidth, floorDepth);
  // Dark navy, matching the walls -- a bright ceiling would wash out the lintel glow and
  // is the single largest bright surface in frame.
  const ceiling = new THREE.Mesh(floorGeometry, new THREE.MeshStandardMaterial({ color: 0x1d3348 }));
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(
    (floorWidth - data.cellSize) / 2,
    data.wallHeight + 0.01,
    (floorDepth - data.cellSize) / 2
  );
  scene.add(ceiling);
}

// ---------- doorway clearance check ----------
// Scans the grid text directly for '3' runs (doorway cells) rather than trusting the
// wall list, since a bug here should be loud in the console the moment a level loads,
// not discovered later by walking into a doorway that turns out too narrow.
function checkDoorwayClearance(data) {
  const cellSize = data.cellSize;
  const grid = data.grid;
  let minDoorWidth = Infinity;

  for (const row of grid) {
    let run = 0;
    for (let c = 0; c <= row.length; c++) {
      if (row[c] === '3') {
        run++;
      } else {
        if (run > 0) minDoorWidth = Math.min(minDoorWidth, run * cellSize);
        run = 0;
      }
    }
  }
  for (let c = 0; c < grid[0].length; c++) {
    let run = 0;
    for (let r = 0; r <= grid.length; r++) {
      if (r < grid.length && grid[r][c] === '3') {
        run++;
      } else {
        if (run > 0) minDoorWidth = Math.min(minDoorWidth, run * cellSize);
        run = 0;
      }
    }
  }

  if (Number.isFinite(minDoorWidth) && minDoorWidth < PLAYER_RADIUS * 2) {
    console.warn(`Doorway clearance: narrowest carved doorway is ${minDoorWidth.toFixed(2)}m but ` +
      `the player is ${(PLAYER_RADIUS * 2).toFixed(2)}m wide -- it may be too tight to walk through.`);
  }
}

// ---------- minimap ----------
// Baked once from the grid text at 1px/cell (cheap, and the grid never changes after
// load), then blitted scaled-up every frame with the player's position and facing
// drawn on top. North-up: row 0 is the far edge in world space, and the canvas'
// top edge, so no per-frame rotation is needed to keep the map itself readable.
const minimapCanvas = document.getElementById('minimap');
const minimapCtx = minimapCanvas.getContext('2d');
let minimapBaked = null;

function bakeMinimap(data) {
  const rows = data.height, cols = data.width;
  const off = document.createElement('canvas');
  off.width = cols;
  off.height = rows;
  const ctx = off.getContext('2d');
  const image = ctx.createImageData(cols, rows);

  for (let r = 0; r < rows; r++) {
    const rowStr = data.grid[r];
    for (let c = 0; c < cols; c++) {
      const cell = rowStr[c];
      let rr, gg, bb;
      // Drafting palette: navy walls, bright cyan doorways, pale floor.
      if (cell === '1') { rr = 16; gg = 38; bb = 60; }
      else if (cell === '3') { rr = 79; gg = 195; bb = 247; }
      else { rr = 150; gg = 180; bb = 205; }
      const idx = (r * cols + c) * 4;
      image.data[idx] = rr; image.data[idx + 1] = gg; image.data[idx + 2] = bb; image.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  minimapBaked = off;
  roomOverlays.clear(); // stale after a level change
}

// One pre-baked translucent overlay per room, built the first time the player walks into
// that room. Highlighting the current room is then one extra drawImage per frame --
// identical cost to the base blit. The alternatives all cost more for no gain: a Path2D
// of ~16k 1x1 rects refilled every frame, or a bounding-box highlight (real floor plans
// are L-shaped, so the box bleeds into neighbouring rooms), or baking every room up front
// when the player will only ever see a handful.
const roomOverlays = new Map();

function roomOverlayFor(id) {
  if (roomOverlays.has(id)) return roomOverlays.get(id);
  const rows = level.height, cols = level.width;
  const off = document.createElement('canvas');
  off.width = cols;
  off.height = rows;
  const ctx = off.getContext('2d');
  const image = ctx.createImageData(cols, rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (roomIdOf(r, c) !== id) continue; // alpha stays 0 -- createImageData zero-fills
      const idx = (r * cols + c) * 4;
      image.data[idx] = 79; image.data[idx + 1] = 195; image.data[idx + 2] = 247;
      image.data[idx + 3] = 90;
    }
  }
  ctx.putImageData(image, 0, 0);
  roomOverlays.set(id, off);
  return off;
}

function drawMinimap() {
  if (!minimapBaked || !level) return;
  const w = minimapCanvas.width, h = minimapCanvas.height;
  const cellSize = level.cellSize;
  const rows = level.height, cols = level.width;

  minimapCtx.imageSmoothingEnabled = false;
  minimapCtx.clearRect(0, 0, w, h);
  minimapCtx.drawImage(minimapBaked, 0, 0, w, h);

  // Invert the same col/row <-> x/z mapping collides() uses.
  const px = (camera.position.x / cellSize / cols) * w;
  const py = ((rows - 1 - camera.position.z / cellSize) / rows) * h;

  // Tint the room the player is standing in. The overlay's alpha lives in its pixels,
  // so there's no globalAlpha state to save and restore.
  const { row, col } = playerCell();
  if (roomIdOf && row >= 0 && row < rows && col >= 0 && col < cols) {
    const id = roomIdOf(row, col);
    if (id !== null && id >= 0) minimapCtx.drawImage(roomOverlayFor(id), 0, 0, w, h);
  }

  // Facing cone from the same forwardDir used for movement this frame (world +x ->
  // canvas +x; world +z decreases row, i.e. moves toward the canvas top, hence -z).
  const facing = Math.atan2(-forwardDir.z, forwardDir.x);
  const CONE_HALF_ANGLE = 0.42; // rad, ~48 degrees total -- roughly the 70-degree FOV foreshortened
  const CONE_LENGTH = 26;
  const cone = minimapCtx.createRadialGradient(px, py, 0, px, py, CONE_LENGTH);
  cone.addColorStop(0, 'rgba(125,211,252,0.55)');
  cone.addColorStop(1, 'rgba(125,211,252,0)');
  minimapCtx.fillStyle = cone;
  minimapCtx.beginPath();
  minimapCtx.moveTo(px, py);
  minimapCtx.arc(px, py, CONE_LENGTH, facing - CONE_HALF_ANGLE, facing + CONE_HALF_ANGLE);
  minimapCtx.closePath();
  minimapCtx.fill();

  // Player dot, breathing so it stays findable against a busy floor plan.
  const pulse = 3.6 + Math.sin(timer.getElapsed() * 3) * 0.9;
  minimapCtx.fillStyle = 'rgba(79,195,247,0.25)';
  minimapCtx.beginPath();
  minimapCtx.arc(px, py, pulse + 3, 0, Math.PI * 2);
  minimapCtx.fill();
  minimapCtx.fillStyle = '#e0f2fe';
  minimapCtx.beginPath();
  minimapCtx.arc(px, py, pulse, 0, Math.PI * 2);
  minimapCtx.fill();
}

// ---------- live HUD ----------
// Compass geometry: the strip is three full revolutions long so it never runs out of
// content at either edge of the window, and we always read off the middle copy.
const COMPASS_WINDOW = 260;  // must match #compass width in style.css
const COMPASS_REVOLUTION = 720; // px per 360 degrees -- 2px per degree
const COMPASS_LABELS = ['N', '30', '60', 'E', '120', '150', 'S', '210', '240', 'W', '300', '330'];

const hudRoom = document.getElementById('hudRoom');
const hudCoords = document.getElementById('hudCoords');
const compassStrip = document.getElementById('compassStrip');

compassStrip.style.width = `${COMPASS_REVOLUTION * 3}px`;
for (let copy = 0; copy < 3; copy++) {
  COMPASS_LABELS.forEach((text, i) => {
    const span = document.createElement('span');
    span.textContent = text;
    if (text.length === 1) span.className = 'cardinal';
    span.style.left = `${copy * COMPASS_REVOLUTION + (i / COMPASS_LABELS.length) * COMPASS_REVOLUTION}px`;
    compassStrip.appendChild(span);
  });
}

// Three text nodes rewritten 60x/second would invalidate layout every frame for nothing,
// since the rounded values only change a handful of times a second. Cache and compare.
let lastRoomText = '', lastCoordsText = '';

function updateHud() {
  if (!level || !controls.isLocked) return;

  // Heading straight from the look direction rather than from currentYaw: north is -z
  // and east is +x by the LevelBuilder mapping, so atan2(x, -z) is unambiguous and
  // there is no sign convention to get backwards.
  const heading = (Math.atan2(forwardDir.x, -forwardDir.z) * 180 / Math.PI + 360) % 360;
  compassStrip.style.transform =
    `translateX(${COMPASS_WINDOW / 2 - COMPASS_REVOLUTION - heading * (COMPASS_REVOLUTION / 360)}px)`;

  const { row, col } = playerCell();
  const inGrid = row >= 0 && row < level.height && col >= 0 && col < level.width;
  const id = (roomIdOf && inGrid) ? roomIdOf(row, col) : null;
  // null (standing in a wall cell) only happens transiently at a doorway edge; keeping
  // the previous label is less distracting than blinking to a placeholder.
  const roomText = id === null ? lastRoomText
    : id < 0 ? 'DOORWAY'
    : `ROOM ${String(id + 1).padStart(2, '0')}`;
  if (roomText !== lastRoomText) {
    hudRoom.textContent = roomText;
    lastRoomText = roomText;
  }

  const coordsText = `X ${camera.position.x.toFixed(2)}  Z ${camera.position.z.toFixed(2)}`;
  if (coordsText !== lastCoordsText) {
    hudCoords.textContent = coordsText;
    lastCoordsText = coordsText;
  }
}

// ---------- collision: grid lookup, not raycasting ----------
// Inverts the Java LevelBuilder mapping (x = col*cellSize, z = (rows-1-row)*cellSize)
// to turn a grid cell into a wall/floor check.
function cellAt(row, col) {
  const gridRow = solidGrid[row];
  if (gridRow === undefined) return '1'; // outside the grid counts as solid
  const cell = gridRow[col];
  return cell === undefined ? '1' : cell;
}

// The grid cell the camera is standing in. Same inversion as collides(), just rounded to
// a single cell -- used by the HUD's room label, the minimap's room highlight, and the
// stuck diagnostic.
function playerCell() {
  const cellSize = level.cellSize;
  return {
    row: Math.round(level.height - 1 - camera.position.z / cellSize),
    col: Math.round(camera.position.x / cellSize),
  };
}

// Tests EVERY grid cell overlapping the player's [x-r,x+r] x [z-r,z+r] box, not
// just the 4 corners. On a coarse grid (Phase 1's cellSize=1) 4 corners was
// enough, but on a fine grid (a real floor plan's cellSize ~0.1m) the player's
// box can span several cells per side -- a corner-only test can straddle a
// wall cell in the middle entirely and let the player walk straight through it.
//
// Cell c (in cellSize units) physically spans [c-0.5, c+0.5]; it overlaps a
// window [lo,hi] iff c-0.5 < hi AND c+0.5 > lo, i.e. lo-0.5 < c < hi+0.5. The
// smallest/largest integers satisfying that strict range are floor(lo-0.5)+1
// and ceil(hi+0.5)-1. Confirmed via a live stuck-position log (see git history)
// that plain Math.round() on each edge independently does NOT compute this:
// PLAYER_RADIUS is exactly 1.5*cellSize, so whenever a position lines up so an
// edge lands exactly on a .5 boundary (common on grid-aligned geometry -- e.g.
// standing still near a wall), Math.round rounds BOTH edges up (JS always
// rounds .5 up), asymmetrically padding the tested range by one extra cell on
// one side. Confirmed case: player dead-center on clear floor with no wall
// within its true radius still collided, because the old formula's window
// reached a wall a full cell outside where the player's box actually was.
function overlapRange(lo, hi) {
  return [Math.floor(lo - 0.5) + 1, Math.ceil(hi + 0.5) - 1];
}

// Shrinks the tested radius by a hair below the player's real one. All level
// geometry is exactly grid-aligned, so ordinary movement constantly produces
// positions where (position +/- radius)/cellSize lands EXACTLY on an integer
// or half-integer boundary -- confirmed via two separate live stuck-position
// logs, at two different exact alignments, that overlapRange's strict overlap
// test (correct as it is) can still flip a cell in or out of range from a
// sub-millimetre difference at exactly these knife-edge positions, which
// ordinary per-frame floating point noise crosses constantly. 1cm is far
// below anything visible or gameplay-relevant, but reliably pushes the tested
// edges off those exact rational boundaries.
const COLLISION_EPSILON = 0.01;

function collides(x, z) {
  if (!solidGrid) return false;
  const cellSize = level.cellSize;
  const rows = level.height;
  const r = PLAYER_RADIUS - COLLISION_EPSILON;

  const [colMin, colMax] = overlapRange((x - r) / cellSize, (x + r) / cellSize);
  // z -> row is inverted (row = rows-1-z/cellSize), so compute the raw (pre-flip)
  // range first, then flip both ends -- flipping swaps which end is min/max.
  const [rawRowMin, rawRowMax] = overlapRange((z - r) / cellSize, (z + r) / cellSize);
  const rowMin = rows - 1 - rawRowMax;
  const rowMax = rows - 1 - rawRowMin;

  for (let rr = rowMin; rr <= rowMax; rr++) {
    for (let c = colMin; c <= colMax; c++) {
      if (cellAt(rr, c) === '1') return true;
    }
  }
  return false;
}

// ---------- stuck detector (diagnostic) ----------
// Screenshots alone haven't pinned down why some doorways feel impassable despite
// every offline simulation saying they're clear -- log hard numbers the instant it
// actually happens instead of guessing from another picture. Fires once per stuck
// episode (not every frame) so the console stays readable.
let stuckFrames = 0;
let wasStuck = false;
function logStuckDiagnostic(x, z) {
  const cellSize = level.cellSize;
  const rows = level.height;
  const col = x / cellSize;
  const rowF = rows - 1 - z / cellSize;
  const { row: r0, col: c0 } = playerCell();
  let nearby = '';
  for (let r = r0 - 2; r <= r0 + 2; r++) {
    let line = '';
    for (let c = c0 - 4; c <= c0 + 4; c++) {
      line += (r === r0 && c === c0) ? '@' : cellAt(r, c);
    }
    nearby += line + '\n';
  }
  console.warn(
    `STUCK at x=${x.toFixed(3)} z=${z.toFixed(3)} (col=${col.toFixed(2)} row=${rowF.toFixed(2)}) ` +
    `PLAYER_RADIUS=${PLAYER_RADIUS.toFixed(3)} cellSize=${cellSize.toFixed(3)}\n` +
    `Grid around player ('@' = player center, row ${r0 - 2}-${r0 + 2}, col ${c0 - 4}-${c0 + 4}):\n${nearby}`
  );
}

// ---------- animation loop ----------
const timer = new THREE.Timer();
const velocity = new THREE.Vector3();
const forwardDir = new THREE.Vector3();
const rightDir = new THREE.Vector3();

function animate() {
  requestAnimationFrame(animate);
  timer.update();
  const delta = Math.min(timer.getDelta(), 0.1);

  if (controls.isLocked && level) {
    // Smooth the camera's actual orientation toward the raw mouse target instead of
    // snapping straight to it -- see the mousemove listener above for why. Overwrites
    // whatever PointerLockControls' own listener already set on camera.quaternion this
    // frame; must run before getDirection() so movement uses the up-to-date orientation.
    const rotationSmoothing = 1 - Math.exp(-ROTATION_SMOOTHING_RATE * delta);
    currentYaw += (targetYaw - currentYaw) * rotationSmoothing;
    currentPitch += (targetPitch - currentPitch) * rotationSmoothing;
    lookEuler.set(currentPitch, currentYaw, 0);
    camera.quaternion.setFromEuler(lookEuler);

    // Exponential damping so the player coasts to a stop instead of snapping.
    velocity.x -= velocity.x * DAMPING * delta;
    velocity.z -= velocity.z * DAMPING * delta;

    const inputForward = Number(keyState.forward) - Number(keyState.back);
    const inputRight = Number(keyState.right) - Number(keyState.left);

    controls.getDirection(forwardDir);
    forwardDir.y = 0;
    forwardDir.normalize();
    rightDir.set(-forwardDir.z, 0, forwardDir.x); // right = cross(forward, up)

    if (inputForward !== 0 || inputRight !== 0) {
      velocity.x += (forwardDir.x * inputForward + rightDir.x * inputRight) * MOVE_SPEED * delta * DAMPING;
      velocity.z += (forwardDir.z * inputForward + rightDir.z * inputRight) * MOVE_SPEED * delta * DAMPING;
    }

    const pos = camera.position;
    const nextX = pos.x + velocity.x * delta;
    const nextZ = pos.z + velocity.z * delta;

    // Resolve X and Z independently so hitting a wall at an angle slides you
    // along it instead of stopping you dead.
    let movedX = false, movedZ = false;
    if (!collides(nextX, pos.z)) {
      pos.x = nextX; movedX = true;
    } else {
      velocity.x = 0;
    }
    if (!collides(pos.x, nextZ)) {
      pos.z = nextZ; movedZ = true;
    } else {
      velocity.z = 0;
    }

    const tryingToMove = inputForward !== 0 || inputRight !== 0;
    if (tryingToMove && !movedX && !movedZ) {
      stuckFrames++;
    } else {
      stuckFrames = 0;
      wasStuck = false;
    }
    if (stuckFrames > 20 && !wasStuck) {
      wasStuck = true;
      logStuckDiagnostic(pos.x, pos.z);
    }
  }

  // Automatic doors: swing open when the player is near, closed otherwise. Runs
  // whenever a level is loaded (not gated on pointer lock) so doors near the spawn
  // point are already in the right state the moment the player looks around.
  if (level) {
    const swingSmoothing = 1 - Math.exp(-DOOR_SWING_RATE * delta);
    for (const door of doors) {
      const dx = camera.position.x - door.centerX;
      const dz = camera.position.z - door.centerZ;
      const nearby = Math.sqrt(dx * dx + dz * dz) < door.triggerRadius;
      const targetSwing = nearby ? DOOR_OPEN_ANGLE : 0;
      door.currentSwing += (targetSwing - door.currentSwing) * swingSmoothing;
      door.pivot.rotation.y = door.baseRotationY + door.currentSwing;
    }
  }

  drawMinimap();
  updateHud();
  renderer.render(scene, camera);
}

animate();
