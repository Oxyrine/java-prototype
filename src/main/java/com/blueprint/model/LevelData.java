package com.blueprint.model;

import java.util.List;

public class LevelData {
    public String name;
    public int width;
    public int height;
    public double cellSize;
    public double wallHeight;
    public Vec3 spawn;
    public List<String> grid;
    public List<WallData> walls;
    /** Glass panes for '4' cells. Their opaque sill/header boxes live in `walls`. */
    public List<WallData> windows;

    public LevelData(String name, int width, int height, double cellSize, double wallHeight,
                      Vec3 spawn, List<String> grid, List<WallData> walls, List<WallData> windows) {
        this.name = name;
        this.width = width;
        this.height = height;
        this.cellSize = cellSize;
        this.wallHeight = wallHeight;
        this.spawn = spawn;
        this.grid = grid;
        this.walls = walls;
        this.windows = windows;
    }
}
