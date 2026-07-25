import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

const EYE_HEIGHT = 1.6; // metres -- an absolute real-world constant, doesn't scale with cellSize
let PLAYER_RADIUS = 0.25; // default; shrunk to fit doorways once cellSize is known (see below)
const MOVE_SPEED = 3.0; // m/s -- a brisk walk. 6.0 was a dead sprint once cellSize is real metres.
const DAMPING = 8.0;
const DEFAULT_POINTER_SPEED = 0.3; // PointerLockControls' own default (1) reads as way too fast for most mice

// ---------- scene ----------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fb8de);
scene.fog = new THREE.Fog(0x8fb8de, 3, 18); // pulled in from Phase 1's 8/40 -- these are indoor rooms, not an open maze

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
scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
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
controls.addEventListener('lock', () => overlay.classList.add('hidden'));
controls.addEventListener('unlock', () => overlay.classList.remove('hidden'));

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
    bakeMinimap(data);
    checkDoorwayClearance(data);

    camera.position.set(data.spawn.x, EYE_HEIGHT, data.spawn.z);
    console.log(`Loaded "${data.name}": ${data.width}x${data.height}, ${data.walls.length} walls`);
  })
  .catch((err) => {
    console.error(err);
    overlay.querySelector('h1').textContent = 'Failed to load level';
    overlay.querySelector('p').textContent = String(err.message || err);
  });

function buildLevel(data) {
  // Unit box, scaled per-instance to each wall's own size -- LevelBuilder.java now
  // merges adjacent wall cells into rectangles (and doorway cells into lintels), so
  // walls arrive with real, varied dimensions instead of one cellSize cube each.
  const wallGeometry = new THREE.BoxGeometry(1, 1, 1);
  const wallMaterial = new THREE.MeshStandardMaterial({ color: 0x8899aa });
  // A doorway lintel is any wall box shorter than the full wall height (LevelBuilder.java
  // emits these for '3' cells, spanning door-height up to the ceiling). Giving it the
  // same flat gray as every other wall made it visually disappear into the wall face --
  // the header was structurally a doorframe but read as just more wall. A distinct warm
  // trim color is the cheapest way to make an opening actually look like a built doorway
  // instead of a hole with matching-colored geometry above it.
  const lintelMaterial = new THREE.MeshStandardMaterial({ color: 0x8b6f47 });

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

  function addInstancedGroup(walls, material) {
    if (walls.length === 0) return;
    const mesh = new THREE.InstancedMesh(wallGeometry, material, walls.length);
    walls.forEach((wall, i) => {
      position.set(wall.position.x, wall.position.y, wall.position.z);
      scale.set(wall.size.x, wall.size.y, wall.size.z);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(i, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    scene.add(mesh);
  }

  addInstancedGroup(fullWalls, wallMaterial);
  addInstancedGroup(lintels, lintelMaterial);

  // One stretched floor plane instead of one tile per '0' cell.
  const floorWidth = data.width * data.cellSize;
  const floorDepth = data.height * data.cellSize;
  const floorGeometry = new THREE.PlaneGeometry(floorWidth, floorDepth);
  const floorMaterial = new THREE.MeshStandardMaterial({ color: 0x445544 });
  const floor = new THREE.Mesh(floorGeometry, floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  // Grid spans x:[0, width-1]*cellSize and z:[0, height-1]*cellSize (cell centers),
  // so the plane's center sits half a cell beyond each edge.
  floor.position.set(
    (floorWidth - data.cellSize) / 2,
    -0.01, // nudged just below y=0 -- every wall's bottom face sits exactly at y=0 (see
           // LevelBuilder.java's y = wallHeight/2), so the floor was perfectly coplanar
           // with every wall base: textbook z-fighting, worse the more you rotate the camera.
    (floorDepth - data.cellSize) / 2
  );
  scene.add(floor);

  // Ceiling -- mirrors the floor at wallHeight. Without this, looking through any doorway
  // or gap (nothing bounds the space from above) shows the sky background straight through,
  // which reads as broken/see-through rather than "this leads to another room."
  const ceiling = new THREE.Mesh(floorGeometry, new THREE.MeshStandardMaterial({ color: 0xdddddd }));
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
      if (cell === '1') { rr = 40; gg = 40; bb = 46; }
      else if (cell === '3') { rr = 110; gg = 170; bb = 255; }
      else { rr = 205; gg = 205; bb = 195; }
      const idx = (r * cols + c) * 4;
      image.data[idx] = rr; image.data[idx + 1] = gg; image.data[idx + 2] = bb; image.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  minimapBaked = off;
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

  minimapCtx.fillStyle = '#ff5050';
  minimapCtx.beginPath();
  minimapCtx.arc(px, py, 4, 0, Math.PI * 2);
  minimapCtx.fill();

  // Facing wedge from the same forwardDir used for movement this frame (world +x ->
  // canvas +x; world +z decreases row, i.e. moves toward the canvas top, hence -z).
  const dx = forwardDir.x, dy = -forwardDir.z;
  minimapCtx.strokeStyle = '#ff5050';
  minimapCtx.lineWidth = 2;
  minimapCtx.beginPath();
  minimapCtx.moveTo(px, py);
  minimapCtx.lineTo(px + dx * 10, py + dy * 10);
  minimapCtx.stroke();
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
  const c0 = Math.round(col), r0 = Math.round(rowF);
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

  drawMinimap();
  renderer.render(scene, camera);
}

animate();
