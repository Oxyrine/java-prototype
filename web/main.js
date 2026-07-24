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

// ---------- mouse-move diagnostic (separate listener, doesn't touch PointerLockControls'
// own handling) -- logs the raw input PointerLockControls itself is reacting to, so we can
// tell "input itself arrives in big rare jumps" (OS/browser/hardware) apart from
// "input is fine but something downstream eats it" (a real bug in our code) ----------
const mouseMoveLog = document.getElementById('mouseMoveLog');
let mmCount = 0, mmWindowStart = performance.now(), mmLastT = null, mmMaxGap = 0, mmLastDx = 0, mmLastDy = 0, mmMaxAbsDelta = 0;
document.addEventListener('mousemove', (e) => {
  if (!controls.isLocked) return;
  const t = performance.now();
  if (mmLastT !== null) {
    const gap = t - mmLastT;
    if (gap > mmMaxGap) mmMaxGap = gap;
    if (gap > 100) {
      // A gap this large between consecutive mousemove events, while locked, is the
      // exact signature of "input itself stalled" -- log it plainly so it's easy to spot.
      console.log(`MOUSEMOVE GAP: ${gap.toFixed(0)}ms since last event (dx=${e.movementX}, dy=${e.movementY})`);
    }
  }
  mmLastT = t;
  mmLastDx = e.movementX;
  mmLastDy = e.movementY;
  const absDelta = Math.max(Math.abs(e.movementX), Math.abs(e.movementY));
  if (absDelta > mmMaxAbsDelta) mmMaxAbsDelta = absDelta;
  mmCount++;
});

setInterval(() => {
  const now = performance.now();
  const elapsed = (now - mmWindowStart) / 1000;
  const rate = elapsed > 0 ? Math.round(mmCount / elapsed) : 0;
  if (mouseMoveLog) {
    mouseMoveLog.textContent =
      `${rate} moves/s  maxGap ${mmMaxGap.toFixed(0)}ms  last dx,dy ${mmLastDx},${mmLastDy}  maxDelta ${mmMaxAbsDelta}`;
  }
  mmCount = 0;
  mmWindowStart = now;
  mmMaxGap = 0;
  mmMaxAbsDelta = 0;
}, 1000);

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

    camera.position.set(data.spawn.x, EYE_HEIGHT, data.spawn.z);
    console.log(`Loaded "${data.name}": ${data.width}x${data.height}, ${data.walls.length} walls`);
  })
  .catch((err) => {
    console.error(err);
    overlay.querySelector('h1').textContent = 'Failed to load level';
    overlay.querySelector('p').textContent = String(err.message || err);
  });

function buildLevel(data) {
  const wallGeometry = new THREE.BoxGeometry(data.cellSize, data.wallHeight, data.cellSize);
  const wallMaterial = new THREE.MeshStandardMaterial({ color: 0x8899aa });

  // One InstancedMesh for every wall, not one Mesh each. Phase 1's maze had
  // 56 walls; a real floor plan can have 1000+ -- individual Mesh objects
  // would mean hundreds of draw calls. Collision is unaffected: it reads the
  // JSON grid directly, not these meshes.
  const wallMesh = new THREE.InstancedMesh(wallGeometry, wallMaterial, data.walls.length);
  const matrix = new THREE.Matrix4();
  data.walls.forEach((wall, i) => {
    matrix.setPosition(wall.position.x, wall.position.y, wall.position.z);
    wallMesh.setMatrixAt(i, matrix);
  });
  wallMesh.instanceMatrix.needsUpdate = true;
  scene.add(wallMesh);

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
function collides(x, z) {
  if (!solidGrid) return false;
  const cellSize = level.cellSize;
  const rows = level.height;

  const colMin = Math.round((x - PLAYER_RADIUS) / cellSize);
  const colMax = Math.round((x + PLAYER_RADIUS) / cellSize);
  // z -> row is inverted (row = rows-1-round(z/cellSize)), so the row for the
  // larger z is the SMALLER row index -- compute both and take min/max.
  const rowA = rows - 1 - Math.round((z - PLAYER_RADIUS) / cellSize);
  const rowB = rows - 1 - Math.round((z + PLAYER_RADIUS) / cellSize);
  const rowMin = Math.min(rowA, rowB);
  const rowMax = Math.max(rowA, rowB);

  for (let r = rowMin; r <= rowMax; r++) {
    for (let c = colMin; c <= colMax; c++) {
      if (cellAt(r, c) === '1') return true;
    }
  }
  return false;
}

// ---------- FPS counter (diagnostic -- reads actual on-screen numbers off the
// user's own machine, since remote/automated tooling can't reliably measure this) ----------
const fpsCounter = document.getElementById('fpsCounter');
let fpsFrames = 0;
let fpsLastSample = performance.now();

// ---------- animation loop ----------
const timer = new THREE.Timer();
const velocity = new THREE.Vector3();
const forwardDir = new THREE.Vector3();
const rightDir = new THREE.Vector3();

function animate() {
  requestAnimationFrame(animate);
  timer.update();
  const delta = Math.min(timer.getDelta(), 0.1);

  fpsFrames++;
  const now = performance.now();
  if (now - fpsLastSample >= 500) {
    const fps = Math.round((fpsFrames * 1000) / (now - fpsLastSample));
    fpsCounter.textContent = fps + ' fps';
    fpsFrames = 0;
    fpsLastSample = now;
  }

  if (controls.isLocked && level) {
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
    if (!collides(nextX, pos.z)) {
      pos.x = nextX;
    } else {
      velocity.x = 0;
    }
    if (!collides(pos.x, nextZ)) {
      pos.z = nextZ;
    } else {
      velocity.z = 0;
    }
  }

  renderer.render(scene, camera);
}

animate();
