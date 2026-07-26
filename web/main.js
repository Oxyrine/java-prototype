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
// Total reveal between leaf and jambs, 5mm a side. Enough to keep the leaf's end faces
// off the jamb faces (coplanar surfaces z-fight), small enough to read as a shut door.
const DOOR_LEAF_CLEARANCE = 0.01;
// How far you can reach to click a door open. Doors were originally automatic, opening on
// player proximity, which falls apart on a real floor plan: doorways cluster within a couple
// of metres of each other, so crossing one corridor flapped three doors at once and there was
// no way to deliberately leave one shut. Aiming is unambiguous where a radius isn't.
const DOOR_INTERACT_RANGE = 3.0; // metres -- comfortable reach across a small room

// ---------- scene ----------
const scene = new THREE.Scene();

// Vertical gradient sky baked into a 2x256 CanvasTexture rather than a ShaderMaterial
// sphere (an extra mesh plus a custom shader that then has to be taught about fog) or a
// CSS gradient behind a transparent clear (fog would fade geometry to transparent, which
// makes the CSS color the de-facto fog color anyway -- same result, less control).
// It is screen-space fixed rather than equirect, so it does not swing when you look up;
// irrelevant here, since the ceiling plane blocks the sky.
//
// Daylight, not the old midnight navy. This is now genuinely visible: windows are real
// openings, so this gradient is what a buyer sees through them, and it has to look like
// an afternoon outside rather than the inside of a cave.
function makeSkyTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, 256);
  gradient.addColorStop(0, '#7fb3e0');
  gradient.addColorStop(0.55, '#bcd8ee');
  gradient.addColorStop(1, '#e8eef2');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 2, 256);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
scene.background = makeSkyTexture();

// Matches the sky gradient's MIDDLE stop, not the top one: the sky you actually glimpse
// through a window is at eye level, so matching the horizon band is what makes a distant
// view fade out instead of ending in a visible seam.
//
// Pushed from 3/18 out to 22/70. At 3m a fog this near tinted every surface in every room
// -- an apartment is only ~10m across, so the far wall of the living room was already
// half-faded, which is what made rooms read as murky rather than as rooms. Out here it
// only ever softens the view through a window.
scene.fog = new THREE.Fog(0xbcd8ee, 22, 70);

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
// Bright, neutral daylight. Deliberately NOT tone mapping: Three r185 already defaults to
// SRGBColorSpace output with ColorManagement on, so colors are managed, and ACES on top
// would re-grade every hand-picked hex at once while crushing the near-white wall and
// ceiling values that carry the whole "finished interior" read.
//
// AmbientLight is doing real work here and is not redundant with the hemisphere. A
// downward-facing surface gets hemisphere weight 0, so the ceiling used to receive
// groundColor ALONE (the sun sits at y=+25 and gives a down-facing plane nothing), which
// is why the old ceiling hex had to be set absurdly bright just to render dark navy --
// see the ceiling in buildLevel(). Ambient is normal-independent, so it lights the
// ceiling directly and that whole workaround disappears: the ceiling can now simply be
// white and look white.
// Kept deliberately low. Ambient is normal-independent, which is exactly what the ceiling
// needs and exactly what flattens everything else: at 1.4 every surface in the flat
// received the same value, walls and ceiling merged into one beige field, and rooms had
// no edges. It is here to stop the ceiling going black, not to light the flat.
scene.add(new THREE.AmbientLight(0xffffff, 0.45));
// The main fill. Warm from above, cooler bounce from below, so a wall and a ceiling never
// land on the same value even where the sun reaches neither.
scene.add(new THREE.HemisphereLight(0xfff4e2, 0xbcae99, 1.15));
// Key light, doing the actual shaping: with ambient down at 0.45 this is what makes
// north- and east-facing walls read as different surfaces instead of one flat plane.
const sun = new THREE.DirectionalLight(0xfff2dd, 1.5);
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
const widthInput = document.getElementById('widthMetres');
const rebuildButton = document.getElementById('rebuildButton');

// The page reloads itself after a successful build, which resets this field to the value
// hard-coded in index.html. A corrected width therefore LOOKED ignored -- the build had
// actually used it -- and, worse, the next upload silently fell back to 12m and rescaled
// every room, doorway and ceiling in the flat. Persisted the same way pointerSensitivity
// is, so the field always shows the width the current level was actually built at.
const storedWidth = parseFloat(localStorage.getItem('buildingWidthMetres'));
if (Number.isFinite(storedWidth) && storedWidth > 0) widthInput.value = storedWidth;

// Now that the whole overlay is clickable to start, the whole panel (not just the form)
// needs to stop that click from bubbling up -- otherwise clicking its title, status text,
// or the sensitivity row's padding would accidentally engage pointer lock mid-interaction.
uploadPanel.addEventListener('click', (e) => e.stopPropagation());

// ---------- conversion progress ----------
// /api/convert is a single blocking POST with no streaming, so real progress is
// impossible and a bar that parks at 80% is worse than showing nothing. Only one number
// appears here and it is measured, not estimated: the elapsed clock. The scan line and
// the stage highlight both loop forever, which reads as "still working, duration unknown"
// and cannot be mistaken for progress toward a finish.
//
// The four stages are the real pipeline, in order -- blueprint_to_grid.convert() then
// build_level.run_java() in server.py -- so the loop teaches what is actually happening.
const convertProgress = document.getElementById('convertProgress');
const convertStage = document.getElementById('convertStage');
const convertElapsed = document.getElementById('convertElapsed');
const stageLegend = [...document.querySelectorAll('#stageLegend li')];
let convertTimer = null;

function startConvertProgress() {
  const startedAt = Date.now();
  convertProgress.hidden = false;
  let step = -1;
  const tick = () => {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    convertElapsed.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    const next = Math.floor(seconds / 2) % stageLegend.length;
    if (next !== step) {
      step = next;
      stageLegend.forEach((li, i) => li.classList.toggle('active', i === step));
      convertStage.textContent = stageLegend[step].textContent.toUpperCase();
    }
  };
  tick();
  convertTimer = setInterval(tick, 250);
}

function stopConvertProgress() {
  clearInterval(convertTimer);
  convertTimer = null;
  convertProgress.hidden = true;
  stageLegend.forEach((li) => li.classList.remove('active'));
}

// Uploading a new image and rebuilding the current one at a different width run the
// identical two-stage pipeline and report identically; only where the request comes from
// differs. sendRequest is a thunk so the caller decides that and nothing else.
async function runBuild(sendRequest) {
  uploadButton.disabled = true;
  rebuildButton.disabled = true;
  uploadStatus.className = '';
  uploadStatus.textContent = '';
  localStorage.setItem('buildingWidthMetres', widthInput.value);
  startConvertProgress();

  try {
    let res;
    try {
      res = await sendRequest();
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
    // Read back from the SERVER's response, not from the input box. The point of showing
    // it is to be evidence of what was actually built; echoing the field back would just
    // repeat what was typed and prove nothing.
    const scale = `${data.widthMetres} m wide (${data.cellSize} m per cell)`;
    if (data.warning) {
      uploadStatus.className = 'warn';
      uploadStatus.textContent = `Built at ${scale}. ${data.wallCount} walls, only ${pct}% of `
        + `floor reachable. ${data.warning} Reloading…`;
      setTimeout(() => window.location.reload(), 4000);
    } else {
      uploadStatus.className = 'ok';
      uploadStatus.textContent = `Level built at ${scale}. ${data.wallCount} walls, `
        + `${pct}% of floor reachable. Reloading…`;
      setTimeout(() => window.location.reload(), 1200);
    }
  } catch (err) {
    uploadStatus.className = 'error';
    uploadStatus.textContent = String(err.message || err);
    uploadButton.disabled = false;
    rebuildButton.disabled = false;
  } finally {
    // All three exit paths above write the final status text, and two of them then start
    // a reload timer. Without this the 250ms tick would keep running and overwrite that
    // text a moment after it appeared.
    stopConvertProgress();
  }
}

uploadForm.addEventListener('submit', (e) => {
  e.preventDefault();
  runBuild(() => fetch('/api/convert', { method: 'POST', body: new FormData(uploadForm) }));
});

rebuildButton.addEventListener('click', () => {
  runBuild(() => fetch('/api/rebuild', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ widthMetres: parseFloat(widthInput.value) }),
  }));
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
let doorLeaves = []; // just the meshes, kept flat so the per-frame raycast has no array to build

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
    doorLeaves = doors.map((door) => door.leaf);
    bakeMinimap(data);
    checkDoorwayClearance(data);

    camera.position.set(data.spawn.x, EYE_HEIGHT, data.spawn.z);
    buildDust(data); // after the spawn move -- motes seed in a box around the camera
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
// One oak-toned floor throughout, replacing the 14-hue per-room palette. That palette
// made rooms legible by giving each its own colour, but a lime bedroom beside a purple
// one reads as a game level, which is exactly the wrong impression for someone deciding
// whether they want to live here. Rooms are still identified -- the HUD label and the
// minimap highlight both read the same roomIdOf() below -- just not by painting the
// floor of each one a different colour.
const FLOOR_COLOR = 0xb08d63;

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
// hinge point) and open/swing state; animate() eases the leaf toward whichever state
// the player last clicked it into -- see DOOR_* constants above for why this never
// touches collision.
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
    // A leaf fills its opening. Earlier this was min(0.9, span * 0.85), which left every
    // door visibly short: the cap bound on all seven doorways of a real plan (openings run
    // 1.13-1.28m, so each leaf sat 7-13 inches narrow, covering only 71-80% of its hole).
    // Only a hairline reveal remains, and it is split evenly between the two jambs so the
    // leaf is centred rather than shoved against one side.
    const openingWidth = axisIsX ? worldWidthX : worldWidthZ;
    const leafWidth = openingWidth - DOOR_LEAF_CLEARANCE;
    const leafThickness = Math.max(0.04, cellSize * 0.6);

    const centerCol = (c0 + c1) / 2;
    const centerRow = (r0 + r1) / 2;
    // Hinge on the opening's actual JAMB FACE, not the centre of the edge cell. Cell c
    // spans [(c-0.5)*cellSize, (c+0.5)*cellSize] (see the floor tiles in buildLevel), so
    // c0*cellSize is half a cell inside the hole -- the old value, and another inch and a
    // half of gap on top of the short leaf. Row->z is inverted (z = (rows-1-row)*cellSize),
    // so the r0 edge is the LARGER z and its outer face is at +0.5 cells, not -0.5.
    const hingeX = axisIsX ? (c0 - 0.5) * cellSize : centerCol * cellSize;
    const hingeZ = axisIsX
      ? (data.height - 1 - centerRow) * cellSize
      : (data.height - 1 - r0 + 0.5) * cellSize;
    const baseRotationY = axisIsX ? 0 : Math.PI / 2;

    const pivot = new THREE.Object3D();
    pivot.position.set(hingeX, 0, hingeZ);
    scene.add(pivot);

    const leaf = new THREE.Mesh(leafGeometry, leafMaterial);
    leaf.scale.set(leafWidth, DOOR_HEIGHT, leafThickness);
    // Extends outward from the hinge, offset by half the reveal so the gap is symmetric.
    leaf.position.set(DOOR_LEAF_CLEARANCE / 2 + leafWidth / 2, DOOR_HEIGHT / 2, 0);
    pivot.add(leaf);

    const door = { pivot, leaf, baseRotationY, isOpen: false, currentSwing: 0 };
    leaf.userData.door = door; // reverse lookup from a raycast hit, see updateDoorFocus()
    doors.push(door);
  });

  return doors;
}

// ---------- door interaction: aim at a leaf, click to swing it ----------
const doorRaycaster = new THREE.Raycaster();
doorRaycaster.far = DOOR_INTERACT_RANGE;
// Under pointer lock the cursor is pinned to the middle of the screen, so NDC (0,0) is
// literally where #crosshair is drawn -- what you see is what you're aiming at.
const SCREEN_CENTRE = new THREE.Vector2(0, 0);
let focusedDoor = null;

// Only the door leaves are tested, never the walls: aiming through a wall at a door
// within 3m barely exists as a shot (the leaf sits inside the opening you're looking
// through), and the walls are InstancedMeshes -- raycasting them means a per-instance
// loop over every box in the building, sixty times a second, to reject a case that
// costs nothing when it slips through.
function updateDoorFocus() {
  doorRaycaster.setFromCamera(SCREEN_CENTRE, camera);
  const hit = doorRaycaster.intersectObjects(doorLeaves, false)[0];
  const door = hit ? hit.object.userData.door : null;
  if (door === focusedDoor) return;
  focusedDoor = door;
  // The crosshair's own highlight is the entire interaction prompt -- no floating
  // "[E] Open" label to lay out, translate, or keep from overlapping the HUD.
  document.body.classList.toggle('canInteract', door !== null);
}

// mousedown, not click: the click that acquires pointer lock bubbles up from #overlay
// to document, and lock() only requests the lock -- isLocked flips later, on
// pointerlockchange. mousedown fires earlier still, so that first press can never be
// read as a door toggle no matter how the browser orders the rest.
document.addEventListener('mousedown', () => {
  if (!controls.isLocked || !focusedDoor) return;
  focusedDoor.isOpen = !focusedDoor.isOpen;
});

function buildLevel(data) {
  // Unit box, scaled per-instance to each wall's own size -- LevelBuilder.java now
  // merges adjacent wall cells into rectangles (and doorway cells into lintels), so
  // walls arrive with real, varied dimensions instead of one cellSize cube each.
  const wallGeometry = new THREE.BoxGeometry(1, 1, 1);
  // Warm off-white painted plaster, replacing the old desaturated navy. Navy existed to
  // make the emissive cyan lintels read as "glowing", which was a look, not a room. High
  // roughness keeps it matte -- anything shinier immediately reads as plastic.
  const wallMaterial = new THREE.MeshStandardMaterial({ color: 0xf4eee2, roughness: 0.95 });
  // A doorway lintel is any wall box shorter than the full wall height (LevelBuilder.java
  // emits these for '3' cells, spanning door-height up to the ceiling). It needs to stay
  // distinguishable from the wall or an opening reads as a hole with matching geometry
  // above it -- but as painted trim, a shade brighter than the wall, rather than the old
  // cyan-emissive slab that read as a light fixture bolted over every door.
  const lintelMaterial = new THREE.MeshStandardMaterial({ color: 0xfbf7f0, roughness: 0.9 });

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
  const WORLD_UP = new THREE.Vector3(0, 1, 0);

  function addInstancedGroup(walls, material) {
    if (walls.length === 0) return;
    const mesh = new THREE.InstancedMesh(wallGeometry, material, walls.length);
    walls.forEach((wall, i) => {
      position.set(wall.position.x, wall.position.y, wall.position.z);
      scale.set(wall.size.x, wall.size.y, wall.size.z);
      // Zero for every grid-aligned box, which is nearly all of them; non-zero only for
      // the single box LevelBuilder emits in place of a staircase along an angled wall.
      quaternion.setFromAxisAngle(WORLD_UP, wall.rotationY || 0);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(i, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    scene.add(mesh);
  }

  addInstancedGroup(fullWalls, wallMaterial);
  addInstancedGroup(lintels, lintelMaterial);
  // No additive halo shell here. A 6%-scaled copy of a box only a few centimetres thick
  // does not read as a soft glow -- it reads as a second, misaligned box, showing up as a
  // hard offset lip along one edge of every header. It also carried fog:false, so distant
  // doorways glowed at full strength while the wall around them faded out.

  // Glass. Rendered from its own `windows` list rather than sniffed out of `walls` by
  // height, because LevelBuilder.java already knows exactly which boxes are panes and
  // emits the opaque sill and header into `walls` alongside them. transparent+opacity
  // alone would read as a grey film, so the emissive is what sells it as daylight
  // coming through: a pane is much brighter than the wall around it, which is precisely
  // how a window looks from inside a room.
  if (data.windows && data.windows.length) {
    addInstancedGroup(data.windows, new THREE.MeshStandardMaterial({
      color: 0xdff0ff, emissive: 0xcfe8ff, emissiveIntensity: 0.75,
      transparent: true, opacity: 0.34, roughness: 0.05, depthWrite: false,
    }));
  }

  // Floor: a single oak-toned InstancedMesh for every walkable cell. This used to be one
  // mesh per room colour; see FLOOR_COLOR above for why that went. Note the material must
  // stay a plain per-mesh colour -- an earlier attempt at per-instance vertexColors
  // rendered solid black, because InstancedMesh.instanceColor needs the base geometry to
  // carry its own colour attribute to multiply against and PlaneGeometry has none.
  roomIdOf = computeRoomIds(data);
  const floorTileGeometry = new THREE.PlaneGeometry(data.cellSize, data.cellSize);
  floorTileGeometry.rotateX(-Math.PI / 2);
  const floorCells = [];
  for (let r = 0; r < data.height; r++) {
    for (let c = 0; c < data.width; c++) {
      if (roomIdOf(r, c) === null) continue; // wall cell, no floor tile here
      floorCells.push({
        x: c * data.cellSize,
        // nudged just below y=0 -- every wall's bottom face sits exactly at y=0
        // (see LevelBuilder.java's y = wallHeight/2), so a coplanar floor is
        // textbook z-fighting, worse the more you rotate the camera.
        y: -0.01,
        z: (data.height - 1 - r) * data.cellSize,
      });
    }
  }
  const floorMesh = new THREE.InstancedMesh(
    floorTileGeometry,
    new THREE.MeshStandardMaterial({ color: FLOOR_COLOR, roughness: 0.75 }),
    floorCells.length);
  floorCells.forEach((cell, i) => {
    matrix.identity();
    matrix.setPosition(cell.x, cell.y, cell.z);
    floorMesh.setMatrixAt(i, matrix);
  });
  floorMesh.instanceMatrix.needsUpdate = true;
  scene.add(floorMesh);

  // Ceiling: the same tiles as the floor, flipped, at wall height. Without a ceiling,
  // looking through any doorway shows sky straight through, which reads as broken rather
  // than "this leads to another room."
  //
  // Tiled over the interior rather than one stretched plane covering the whole grid.
  // Now that the void outside the building isn't drawn, a full-extent plane would hang
  // out past the exterior walls like a canopy and be plainly visible through every
  // window. Reusing the floor's cell list means the ceiling stops exactly where the
  // building does.
  //
  // Plain white, and it renders white. It used to need an absurdly bright hex just to
  // land as dark navy, because a down-facing plane receives the hemisphere ground term
  // and nothing else; the AmbientLight added above is normal-independent, so it lights
  // the ceiling directly and this value is now simply the colour it looks.
  const ceilingTileGeometry = new THREE.PlaneGeometry(data.cellSize, data.cellSize);
  ceilingTileGeometry.rotateX(Math.PI / 2);
  // The emissive is the fix for a ceiling that kept reading as a heavy grey lid. A
  // down-facing surface catches no sun and no sky term, so the only lever that reaches it
  // is normal-independent light -- and raising the global AmbientLight to compensate
  // flattens every wall in the flat at the same time. Emissive lifts this one surface and
  // nothing else, which is what a ceiling actually looks like: the brightest thing in the
  // room, bouncing light back down.
  const ceilingMesh = new THREE.InstancedMesh(
    ceilingTileGeometry,
    new THREE.MeshStandardMaterial({
      color: 0xfdfbf7, roughness: 1.0, emissive: 0xfff8ec, emissiveIntensity: 0.34,
    }),
    floorCells.length);
  floorCells.forEach((cell, i) => {
    matrix.identity();
    matrix.setPosition(cell.x, data.wallHeight - 0.01, cell.z);
    ceilingMesh.setMatrixAt(i, matrix);
  });
  ceilingMesh.instanceMatrix.needsUpdate = true;
  scene.add(ceilingMesh);
}

// ---------- dust motes ----------
// One Points object, 600 motes, drifting slowly. 600x3 float ops per frame is free, and
// doing it on the CPU avoids an onBeforeCompile vertex-shader patch for an effect this
// small. Motes are NOT culled against walls: one inside a wall is depth-occluded and
// invisible anyway, and skipping that check is the single largest complexity saving here.
const DUST_COUNT = 600;
let dust = null;
let dustBox = 12; // metres, cube side centered on the camera

function makeDustTexture() {
  // Radial gradient sprite -- without it, a PointsMaterial mote is a hard-edged square.
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(canvas);
}

function buildDust(data) {
  dustBox = Math.min(12, data.width * data.cellSize);
  const positions = new Float32Array(DUST_COUNT * 3);
  const velocities = new Float32Array(DUST_COUNT * 3);
  const ceilingY = data.wallHeight - 0.1;
  for (let i = 0; i < DUST_COUNT; i++) {
    positions[i * 3] = camera.position.x + (Math.random() - 0.5) * dustBox;
    positions[i * 3 + 1] = 0.1 + Math.random() * (ceilingY - 0.1);
    positions[i * 3 + 2] = camera.position.z + (Math.random() - 0.5) * dustBox;
    velocities[i * 3] = (Math.random() - 0.5) * 0.05;
    velocities[i * 3 + 1] = (Math.random() - 0.5) * 0.03;
    velocities[i * 3 + 2] = (Math.random() - 0.5) * 0.05;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const points = new THREE.Points(geometry, new THREE.PointsMaterial({
    // Dialled well back from the old cool-blue 0.45. Against dark navy walls the motes
    // read as atmosphere; against a bright finished interior the same settings read as
    // dust on the lens, which is not what anyone wants in a viewing.
    map: makeDustTexture(), color: 0xfff0d8, size: 0.022, sizeAttenuation: true,
    // depthWrite: false is mandatory -- otherwise every mote punches a hole in the ones
    // behind it and in the fog.
    transparent: true, opacity: 0.16, depthWrite: false,
    blending: THREE.AdditiveBlending, fog: true,
  }));
  points.frustumCulled = false; // the cloud follows the camera; its bounding sphere is stale by design
  scene.add(points);
  dust = { points, positions, velocities, ceilingY };
}

function updateDust(delta) {
  if (!dust) return;
  const { positions, velocities, ceilingY } = dust;
  // Wrap each axis modulo a box centered on the camera instead of tracking lifetimes.
  // The player is always inside the building, so motes kept around the player stay
  // inside it for free -- no spawning, despawning, or age bookkeeping at all.
  const minX = camera.position.x - dustBox / 2;
  const minZ = camera.position.z - dustBox / 2;
  const ySpan = ceilingY - 0.1;
  for (let i = 0; i < DUST_COUNT; i++) {
    const x = i * 3, y = x + 1, z = x + 2;
    positions[x] += velocities[x] * delta;
    positions[y] += velocities[y] * delta;
    positions[z] += velocities[z] * delta;
    // Double modulo: JS '%' keeps the sign of the dividend, so a single one goes negative.
    positions[x] = ((positions[x] - minX) % dustBox + dustBox) % dustBox + minX;
    positions[z] = ((positions[z] - minZ) % dustBox + dustBox) % dustBox + minZ;
    positions[y] = ((positions[y] - 0.1) % ySpan + ySpan) % ySpan + 0.1;
  }
  dust.points.geometry.attributes.position.needsUpdate = true;
}

// ---------- doorway clearance check ----------
// Scans the grid text directly for '3' runs (doorway cells) rather than trusting the
// wall list, since a bug here should be loud in the console the moment a level loads,
// not discovered later by walking into a doorway that turns out too narrow.
function checkDoorwayClearance(data) {
  // Measures each doorway by its LONGER side, via the same components buildDoors() uses.
  // The previous version scanned '3' runs along rows and columns and took the global
  // minimum, which measured the wall THICKNESS -- a doorway through a one-cell wall has a
  // one-cell run across it -- and so warned "narrowest doorway is 0.10m" on every level,
  // including ones whose doorways were all comfortably over half a metre. A warning that
  // fires every time is a warning nobody reads.
  const doorways = computeDoorways(data);
  let narrowest = Infinity;
  for (const { r0, r1, c0, c1 } of doorways) {
    const opening = Math.max((c1 - c0 + 1), (r1 - r0 + 1)) * data.cellSize;
    narrowest = Math.min(narrowest, opening);
  }

  if (Number.isFinite(narrowest) && narrowest < PLAYER_RADIUS * 2) {
    console.warn(`Doorway clearance: narrowest doorway is ${narrowest.toFixed(2)}m but ` +
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
      // The minimap stays a drafting-style plan view -- it is a map, and a map should
      // look like one even though the world it describes now looks like a home.
      if (cell === '1') { rr = 16; gg = 38; bb = 60; }
      else if (cell === '3') { rr = 79; gg = 195; bb = 247; }
      else if (cell === '4') { rr = 240; gg = 210; bb = 90; } // window, matching the overlay PNG
      else if (cell === '5') { rr = 8; gg = 18; bb = 30; }    // void outside the building
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
      // '4' (window) and '5' (void beyond the building) block as surely as '1' does.
      // Glass is see-through, not walk-through; the void is invisible, not absent.
      const cell = cellAt(rr, c);
      if (cell === '1' || cell === '4' || cell === '5') return true;
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

  // Doors ease toward whichever state they were last clicked into. Runs whenever a level
  // is loaded (not gated on pointer lock) so a door left open stays visibly open while
  // the menu is up, instead of snapping shut the moment you press Esc.
  if (level) {
    updateDust(delta);

    const swingSmoothing = 1 - Math.exp(-DOOR_SWING_RATE * delta);
    for (const door of doors) {
      const targetSwing = door.isOpen ? DOOR_OPEN_ANGLE : 0;
      door.currentSwing += (targetSwing - door.currentSwing) * swingSmoothing;
      door.pivot.rotation.y = door.baseRotationY + door.currentSwing;
    }
    updateDoorFocus();
  }

  drawMinimap();
  updateHud();
  renderer.render(scene, camera);
}

// Dev hook for server.py's /api/screenshot endpoint. The render loop is driven by
// requestAnimationFrame, which browsers suspend entirely whenever the page is not
// visible, so an automated check has no frames to capture and no way to look at the one
// output this project exists to produce. Exposing the renderer allows a render to be
// driven on demand:
//
//   const { renderer, scene, camera } = window.__preview;
//   renderer.render(scene, camera);
//   const url = renderer.domElement.toDataURL('image/png');  // must be the NEXT statement
//
// toDataURL has to run synchronously after render(): the drawing buffer is not preserved
// (preserveDrawingBuffer costs every real frame to help only this path), so it is valid
// only until the next composite.
window.__preview = { renderer, scene, camera, controls, THREE };

animate();
