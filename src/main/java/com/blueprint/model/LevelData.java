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

    public LevelData(String name, int width, int height, double cellSize, double wallHeight,
                      Vec3 spawn, List<String> grid, List<WallData> walls) {
        this.name = name;
        this.width = width;
        this.height = height;
        this.cellSize = cellSize;
        this.wallHeight = wallHeight;
        this.spawn = spawn;
        this.grid = grid;
        this.walls = walls;
    }
}
