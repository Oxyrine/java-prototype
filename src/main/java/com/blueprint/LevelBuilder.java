package com.blueprint;

import com.blueprint.model.LevelData;
import com.blueprint.model.Vec3;
import com.blueprint.model.WallData;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Converts a validated char[][] grid into a LevelData ready for JSON export.
 *
 * Coordinate mapping (see plan for the full explanation):
 *   col -> x                (unchanged; both grow left-to-right)
 *   row -> z, but FLIPPED   (row grows downward in the file; z grows away
 *                            from the camera in 3D, so row 0 must map to
 *                            the FAR edge: z = (rows - 1 - row) * cellSize)
 *   every wall's y = wallHeight / 2   (box geometry is center-pivoted)
 *
 * Wall cells ('1') and doorway cells ('3') are merged into maximal axis-aligned
 * rectangles rather than emitted as one box per cell -- a real floor plan has
 * 1000+ wall cells, and one cube per cell means hundreds of coplanar adjacent
 * faces (z-fighting shimmer, lumpy-looking walls). '3' cells become a lintel
 * box spanning from door height up to the ceiling, so a doorway reads as an
 * actual doorframe instead of a hole with nothing above it.
 */
public class LevelBuilder {

    private static final double DOOR_HEIGHT = 2.0; // metres -- real-world doorway clearance

    // Ordinary residential window band. A '4' cell becomes solid wall below the sill and
    // above the head, with a glass pane between -- so a window reads as a hole punched in
    // a wall at eye level rather than as a full-height gap.
    private static final double WINDOW_SILL_HEIGHT = 0.9;
    private static final double WINDOW_HEAD_HEIGHT = 2.1;

    public static LevelData build(char[][] grid, String levelName, double cellSize, double wallHeight)
            throws BlueprintFormatException {
        int rows = grid.length;
        int cols = grid[0].length;

        Vec3 spawn = null;
        int spawnRow = -1;
        int spawnCol = -1;

        for (int row = 0; row < rows; row++) {
            for (int col = 0; col < cols; col++) {
                char cell = grid[row][col];
                switch (cell) {
                    // '5' is the void outside the building: solid to the player, but no
                    // rectangle is ever extracted for it, so nothing is drawn there and a
                    // window looks out at sky instead of at a wall a few centimetres away.
                    case '1', '0', '3', '4', '5' -> { /* handled by rectangle extraction below */ }
                    case '2' -> {
                        if (spawn != null) {
                            throw new BlueprintFormatException(String.format(
                                    "Multiple spawn points found: row %d col %d and row %d col %d. Exactly one '2' is required.",
                                    spawnRow, spawnCol, row, col));
                        }
                        double x = col * cellSize;
                        double z = (rows - 1 - row) * cellSize;
                        spawn = new Vec3(x, 0.0, z);
                        spawnRow = row;
                        spawnCol = col;
                    }
                    default -> throw new BlueprintFormatException(String.format(
                            "Unexpected character '%c' at row %d, col %d.", cell, row, col));
                }
            }
        }

        if (spawn == null) {
            throw new BlueprintFormatException(
                    "No spawn point found. Exactly one '2' is required somewhere in the blueprint.");
        }

        List<WallData> walls = new ArrayList<>();
        // Serialised only after this call: buildWalls opens the staircase cells its rotated
        // boxes don't stand on, and the grid the client collides against has to be the one
        // that matches the geometry it can see.
        walls.addAll(buildWalls(grid, rows, cols, cellSize, wallHeight));

        List<String> gridStrings = new ArrayList<>();
        for (int row = 0; row < rows; row++) {
            gridStrings.add(new String(grid[row]));
        }
        if (wallHeight > DOOR_HEIGHT) {
            walls.addAll(extractRectangles(grid, '3', rows, cols, cellSize,
                    (DOOR_HEIGHT + wallHeight) / 2.0, wallHeight - DOOR_HEIGHT));
        }

        // A window cell contributes three boxes: the spandrel under the sill and the
        // header over it are ordinary opaque wall, and only the band between them is
        // glass. The glass goes in its own list so the renderer can give it a
        // transparent material without having to guess which walls are windows.
        walls.addAll(extractRectangles(grid, '4', rows, cols, cellSize,
                WINDOW_SILL_HEIGHT / 2.0, WINDOW_SILL_HEIGHT));
        if (wallHeight > WINDOW_HEAD_HEIGHT) {
            walls.addAll(extractRectangles(grid, '4', rows, cols, cellSize,
                    (WINDOW_HEAD_HEIGHT + wallHeight) / 2.0, wallHeight - WINDOW_HEAD_HEIGHT));
        }
        List<WallData> windows = extractRectangles(grid, '4', rows, cols, cellSize,
                (WINDOW_SILL_HEIGHT + WINDOW_HEAD_HEIGHT) / 2.0,
                WINDOW_HEAD_HEIGHT - WINDOW_SILL_HEIGHT);

        return new LevelData(levelName, cols, rows, cellSize, wallHeight, spawn, gridStrings,
                walls, windows);
    }

    // ---------------------------------------------------------------------------
    // Angled walls.
    //
    // A wall the architect drew at an angle cannot be represented by a grid, so it
    // rasterises into a staircase. Emitting one box per step is technically faithful and
    // looks wrong: walking past it, each step's side face is exposed, and in perspective
    // the bases and tops of boxes at different depths land at different screen heights.
    // The result reads as a row of fins with battlement silhouettes rather than as a wall.
    //
    // Fixed by recognising a staircase and replacing the whole run with ONE box rotated to
    // match. Detection runs on the merged rectangles rather than on raw cells -- ~140 items
    // instead of ~16,000, and the steps are already grouped. A run qualifies when each
    // rectangle sits directly after the previous one along one axis and is offset from it
    // by a small, consistent amount along the other.
    //
    // Collision still reads the grid rather than testing the rotated box, so openUncovered()
    // rewrites the grid to the box's own footprint instead. That keeps one source of truth:
    // collision, the minimap and room segmentation all read the grid, and all three would
    // otherwise report a wall standing where nothing is drawn.
    // ---------------------------------------------------------------------------

    /** A merged rectangle in GRID space, before it is turned into world geometry. */
    private record CellRect(int row, int col, int width, int rows) {}

    private static final int STEP_MAX_SHORT_SIDE = 3; // a step is a stub, not a whole wall
    private static final int STEP_MAX_LONG_SIDE = 8;
    private static final int STEP_MAX_OFFSET = 3;     // how far one step may shift from the last
    private static final int MIN_STEPS_FOR_RUN = 4;   // fewer than this is a corner, not a slope

    private static List<WallData> buildWalls(char[][] grid, int rows, int cols,
                                              double cellSize, double wallHeight) {
        List<CellRect> rects = extractCellRects(grid, '1', rows, cols);
        List<WallData> out = new ArrayList<>();
        Set<CellRect> consumed = new HashSet<>();

        // Once column-stacked, once row-stacked, so a staircase is found whichever way it
        // leans. Anything claimed by the first pass is off-limits to the second.
        for (boolean rowStacked : new boolean[] { false, true }) {
            List<CellRect> remaining = new ArrayList<>();
            for (CellRect r : rects) {
                if (!consumed.contains(r)) {
                    remaining.add(r);
                }
            }
            for (List<CellRect> run : findStaircases(remaining, rowStacked)) {
                WallData box = angledBox(run, rows, cellSize, wallHeight);
                out.add(box);
                openUncovered(grid, box, run, rows, cellSize);
                consumed.addAll(run);
            }
        }

        for (CellRect r : rects) {
            if (!consumed.contains(r)) {
                out.add(toWall(r, rows, cellSize, wallHeight / 2.0, wallHeight));
            }
        }
        return out;
    }

    private static List<List<CellRect>> findStaircases(List<CellRect> rects, boolean rowStacked) {
        List<CellRect> steps = new ArrayList<>();
        for (CellRect r : rects) {
            if (Math.min(r.width(), r.rows()) <= STEP_MAX_SHORT_SIDE
                    && Math.max(r.width(), r.rows()) <= STEP_MAX_LONG_SIDE) {
                steps.add(r);
            }
        }
        // Indexed by the line each rectangle STARTS on, so the next step in a run is a
        // direct lookup rather than a scan over every candidate.
        Map<Integer, List<CellRect>> byStart = new HashMap<>();
        for (CellRect r : steps) {
            byStart.computeIfAbsent(rowStacked ? r.row() : r.col(), k -> new ArrayList<>()).add(r);
        }

        Set<CellRect> used = new HashSet<>();
        List<List<CellRect>> runs = new ArrayList<>();
        for (CellRect seed : steps) {
            if (used.contains(seed)) {
                continue;
            }
            List<CellRect> run = new ArrayList<>();
            run.add(seed);
            CellRect current = seed;
            int stepSign = 0;
            while (true) {
                int nextLine = rowStacked ? current.row() + current.rows()
                                          : current.col() + current.width();
                CellRect best = null;
                int bestOffset = 0;
                for (CellRect candidate : byStart.getOrDefault(nextLine, List.of())) {
                    if (used.contains(candidate) || run.contains(candidate)) {
                        continue;
                    }
                    int offset = rowStacked ? candidate.col() - current.col()
                                            : candidate.row() - current.row();
                    // offset == 0 is a straight wall the greedy merge happened to split,
                    // not a slope; a consistent sign is what makes a run a slope at all.
                    if (offset == 0 || Math.abs(offset) > STEP_MAX_OFFSET) {
                        continue;
                    }
                    if (stepSign != 0 && Integer.signum(offset) != stepSign) {
                        continue;
                    }
                    if (best == null || Math.abs(offset) < Math.abs(bestOffset)) {
                        best = candidate;
                        bestOffset = offset;
                    }
                }
                if (best == null) {
                    break;
                }
                run.add(best);
                stepSign = Integer.signum(bestOffset);
                current = best;
            }
            if (run.size() >= MIN_STEPS_FOR_RUN) {
                used.addAll(run);
                runs.add(run);
            }
        }
        return runs;
    }

    /** One box spanning a whole staircase, rotated to lie along it. */
    private static WallData angledBox(List<CellRect> run, int gridRows, double cellSize,
                                       double wallHeight) {
        CellRect first = run.get(0);
        CellRect last = run.get(run.size() - 1);
        double x0 = centerX(first, cellSize), z0 = centerZ(first, gridRows, cellSize);
        double x1 = centerX(last, cellSize), z1 = centerZ(last, gridRows, cellSize);
        double dx = x1 - x0, dz = z1 - z0;
        double span = Math.hypot(dx, dz);

        double thickness = 0;
        for (CellRect r : run) {
            thickness += Math.min(r.width(), r.rows()) * cellSize;
        }
        // One extra cell of thickness: the ideal line runs through the middle of the steps,
        // so without it the box sits inside the staircase and the outer corner of every
        // step poked through it.
        thickness = thickness / run.size() + cellSize;

        // span only reaches from the CENTRE of the first step to the centre of the last, so
        // the box has to be extended by half of each end step to reach where the staircase
        // physically ended. Leaving it at span left a vertical slit at both ends where the
        // run met the wall it joins, and daylight showed straight through the building.
        // Measured along the run direction rather than as a flat margin, so a shallow run
        // is not over-extended into the room beyond.
        double ux = dx / span, uz = dz / span;
        double endFirst = Math.abs(first.width() * cellSize * ux) + Math.abs(first.rows() * cellSize * uz);
        double endLast = Math.abs(last.width() * cellSize * ux) + Math.abs(last.rows() * cellSize * uz);
        double length = span + (endFirst + endLast) / 2.0 + cellSize;

        // A Y rotation maps local +X to (cos t, 0, -sin t), so this aims the box's length
        // along the run. The hypot above already made span the true diagonal distance.
        double rotationY = Math.atan2(-dz, dx);
        return new WallData(
                new Vec3((x0 + x1) / 2.0, wallHeight / 2.0, (z0 + z1) / 2.0),
                new Vec3(length, wallHeight, thickness),
                first.row(), first.col(), rotationY);
    }

    /**
     * Frees the staircase cells the rotated box does not actually stand on.
     *
     * The box is thinner than the staircase it replaces, so without this the grid keeps
     * blocking cells that nothing is drawn in and the player walks into an invisible wall.
     * Opening them makes the collision grid and the geometry the same shape by construction
     * -- which is the whole point, since collision, the minimap and room segmentation all
     * read this grid and would otherwise each be wrong in the same place.
     *
     * Cells on the outside face become an unreachable pocket rather than a way out: the box
     * spans the run unbroken, so opening cells beside it never opens a path through it.
     */
    private static void openUncovered(char[][] grid, WallData box, List<CellRect> run,
                                       int gridRows, double cellSize) {
        // Inverse of the Y rotation the renderer applies, so u is along the box's length
        // and v across its thickness.
        double ct = Math.cos(box.rotationY), st = Math.sin(box.rotationY);
        double halfLength = box.size.x / 2.0, halfThickness = box.size.z / 2.0;
        for (CellRect r : run) {
            for (int row = r.row(); row < r.row() + r.rows(); row++) {
                for (int col = r.col(); col < r.col() + r.width(); col++) {
                    double dx = col * cellSize - box.position.x;
                    double dz = (gridRows - 1 - row) * cellSize - box.position.z;
                    double u = dx * ct - dz * st;
                    double v = dx * st + dz * ct;
                    if (Math.abs(u) > halfLength || Math.abs(v) > halfThickness) {
                        grid[row][col] = '0';
                    }
                }
            }
        }
    }

    private static double centerX(CellRect r, double cellSize) {
        return (r.col() + (r.width() - 1) / 2.0) * cellSize;
    }

    private static double centerZ(CellRect r, int gridRows, double cellSize) {
        return (gridRows - 1 - (r.row() + (r.rows() - 1) / 2.0)) * cellSize;
    }

    private static WallData toWall(CellRect r, int gridRows, double cellSize,
                                    double centerY, double boxHeightY) {
        return new WallData(
                new Vec3(centerX(r, cellSize), centerY, centerZ(r, gridRows, cellSize)),
                new Vec3(r.width() * cellSize, boxHeightY, r.rows() * cellSize),
                r.row(), r.col());
    }

    private static List<WallData> extractRectangles(char[][] grid, char target, int rows, int cols,
                                                      double cellSize, double centerY, double boxHeightY) {
        List<WallData> result = new ArrayList<>();
        for (CellRect r : extractCellRects(grid, target, rows, cols)) {
            result.add(toWall(r, rows, cellSize, centerY, boxHeightY));
        }
        return result;
    }

    /**
     * Greedy maximal-rectangle merge over cells equal to {@code target}: for each
     * unvisited match, extend right while the row keeps matching, then extend down
     * while every cell in that full width still matches, then mark the rectangle
     * visited and emit one rectangle for it.
     */
    private static List<CellRect> extractCellRects(char[][] grid, char target, int rows, int cols) {
        boolean[][] visited = new boolean[rows][cols];
        List<CellRect> result = new ArrayList<>();

        for (int row = 0; row < rows; row++) {
            for (int col = 0; col < cols; col++) {
                if (grid[row][col] != target || visited[row][col]) {
                    continue;
                }

                int width = 0;
                while (col + width < cols && grid[row][col + width] == target && !visited[row][col + width]) {
                    width++;
                }

                int runRows = 1;
                outer:
                while (row + runRows < rows) {
                    for (int c = col; c < col + width; c++) {
                        if (grid[row + runRows][c] != target || visited[row + runRows][c]) {
                            break outer;
                        }
                    }
                    runRows++;
                }

                for (int r = row; r < row + runRows; r++) {
                    for (int c = col; c < col + width; c++) {
                        visited[r][c] = true;
                    }
                }

                result.add(new CellRect(row, col, width, runRows));
            }
        }

        return result;
    }
}
