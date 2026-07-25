package com.blueprint.model;

public class WallData {
    public Vec3 position;
    public Vec3 size;
    public int row;
    public int col;

    public WallData(Vec3 position, Vec3 size, int row, int col) {
        this.position = position;
        this.size = size;
        this.row = row;
        this.col = col;
    }
}
