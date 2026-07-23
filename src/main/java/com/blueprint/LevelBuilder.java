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
 */
public class LevelBuilder {

    public static LevelData build(char[][] grid, String levelName, double cellSize, double wallHeight)
            throws BlueprintFormatException {
        int rows = grid.length;
        int cols = grid[0].length;

        List<WallData> walls = new ArrayList<>();
        List<String> gridStrings = new ArrayList<>();
        Vec3 spawn = null;
        int spawnRow = -1;
        int spawnCol = -1;

        for (int row = 0; row < rows; row++) {
            gridStrings.add(new String(grid[row]));

            for (int col = 0; col < cols; col++) {
                char cell = grid[row][col];
                double x = col * cellSize;
                double z = (rows - 1 - row) * cellSize;

                switch (cell) {
                    case '1' -> walls.add(new WallData(new Vec3(x, wallHeight / 2.0, z), row, col));
                    case '0' -> { /* floor: no per-cell object, see plan Step 5 */ }
                    case '2' -> {
                        if (spawn != null) {
                            throw new BlueprintFormatException(String.format(
                                    "Multiple spawn points found: row %d col %d and row %d col %d. Exactly one '2' is required.",
                                    spawnRow, spawnCol, row, col));
                        }
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

        return new LevelData(levelName, cols, rows, cellSize, wallHeight, spawn, gridStrings, walls);
    }
}
