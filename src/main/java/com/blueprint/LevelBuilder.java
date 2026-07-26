package com.blueprint;

import com.blueprint.model.LevelData;
import com.blueprint.model.Vec3;
import com.blueprint.model.WallData;

import java.util.ArrayList;
import java.util.List;

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

        List<String> gridStrings = new ArrayList<>();
        Vec3 spawn = null;
        int spawnRow = -1;
        int spawnCol = -1;

        for (int row = 0; row < rows; row++) {
            gridStrings.add(new String(grid[row]));

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
        walls.addAll(extractRectangles(grid, '1', rows, cols, cellSize, wallHeight / 2.0, wallHeight));
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

    /**
     * Greedy maximal-rectangle merge over cells equal to {@code target}: for each
     * unvisited match, extend right while the row keeps matching, then extend down
     * while every cell in that full width still matches, then mark the rectangle
     * visited and emit one box for it.
     */
    private static List<WallData> extractRectangles(char[][] grid, char target, int rows, int cols,
                                                      double cellSize, double centerY, double boxHeightY) {
        boolean[][] visited = new boolean[rows][cols];
        List<WallData> result = new ArrayList<>();

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

                double x = (col + (width - 1) / 2.0) * cellSize;
                double z = (rows - 1 - (row + (runRows - 1) / 2.0)) * cellSize;
                Vec3 position = new Vec3(x, centerY, z);
                Vec3 size = new Vec3(width * cellSize, boxHeightY, runRows * cellSize);
                result.add(new WallData(position, size, row, col));
            }
        }

        return result;
    }
}
