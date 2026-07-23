package com.blueprint.model;

public class WallData {
    public Vec3 position;
    public int row;
    public int col;

    public WallData(Vec3 position, int row, int col) {
        this.position = position;
        this.row = row;
        this.col = col;
    }
}
