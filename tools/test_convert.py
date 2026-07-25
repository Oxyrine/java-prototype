"""Self-check for blueprint_to_grid.py: runs the converter on the real test image and
asserts the output actually satisfies BlueprintReader's contract plus the walkability
guarantees carve_doorways/place_spawn are supposed to provide.

Run directly: py tools/test_convert.py
"""
import sys
from collections import deque
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import blueprint_to_grid as B  # noqa: E402

TEST_IMAGE = Path(__file__).parent.parent / "blueprints" / "uploaded.jpg"
_NEIGHBORS_4 = ((-1, 0), (1, 0), (0, -1), (0, 1))


def load_grid(path: Path):
    return [line for line in path.read_text(encoding="utf-8").splitlines()
            if line and not line.startswith("#")]


def border_reaches(grid, target_rc) -> bool:
    """BFS from every non-wall border cell; True if it can reach target_rc without
    crossing a '1'. Used to confirm the exterior wall has no gap the spawn leaks through."""
    rows, cols = len(grid), len(grid[0])
    seen = [[False] * cols for _ in range(rows)]
    queue = deque()

    def seed(r, c):
        if grid[r][c] != '1' and not seen[r][c]:
            seen[r][c] = True
            queue.append((r, c))

    for r in range(rows):
        seed(r, 0)
        seed(r, cols - 1)
    for c in range(cols):
        seed(0, c)
        seed(rows - 1, c)

    while queue:
        r, c = queue.popleft()
        if (r, c) == target_rc:
            return True
        for dr, dc in _NEIGHBORS_4:
            nr, nc = r + dr, c + dc
            if 0 <= nr < rows and 0 <= nc < cols and grid[nr][nc] != '1' and not seen[nr][nc]:
                seen[nr][nc] = True
                queue.append((nr, nc))
    return False


def demo():
    assert TEST_IMAGE.is_file(), f"Test image missing: {TEST_IMAGE}"

    out_txt, cell_size, wall_height, reachable_fraction, wall_count = B.convert(
        image_path=TEST_IMAGE, out_name="uploaded", cols=None, fill=0.12,
        width_metres=12.0, wall_height=2.5, dpi=200, invert=False,
        min_region=6, do_seal=True, keep_largest_only=True)

    grid = load_grid(out_txt)
    rows, cols = len(grid), len(grid[0])

    assert all(len(row) == cols for row in grid), "Grid is ragged"
    assert set("".join(grid)) <= set("0123"), "Grid contains characters outside 0/1/2/3"

    spawn_positions = [(r, c) for r in range(rows) for c in range(cols) if grid[r][c] == '2']
    assert len(spawn_positions) == 1, f"Expected exactly one '2', found {len(spawn_positions)}"
    spawn_rc = spawn_positions[0]

    assert not border_reaches(grid, spawn_rc), \
        "Spawn is reachable from the border -- exterior wall has a gap"

    assert reachable_fraction >= 0.999, \
        f"Interior reachability only {reachable_fraction * 100:.1f}% -- a room is still isolated"

    # Every carved doorway must be wide enough in its opening direction. A doorway's
    # footprint is thin along the wall-thickness axis and door_cells-wide along the
    # opening axis, so check connected '3' components by their longer bbox side.
    min_door_cells = max(3, round(0.9 / cell_size))
    door_mask = np.array([[ch == '3' for ch in row] for row in grid])
    labels, sizes = B.connected_components(door_mask, connectivity=8)
    for label_id in range(len(sizes)):
        rs, cs = np.where(labels == label_id)
        span = max(int(rs.max() - rs.min() + 1), int(cs.max() - cs.min() + 1))
        assert span >= min_door_cells, \
            f"Doorway component {label_id} spans only {span} cells (need {min_door_cells})"

    print(f"OK: {cols}x{rows} grid, {wall_count} walls, {len(sizes)} doorways, "
          f"spawn at {spawn_rc}, {reachable_fraction * 100:.1f}% interior reachable, "
          f"cellSize={cell_size:.4f}")


if __name__ == "__main__":
    demo()
