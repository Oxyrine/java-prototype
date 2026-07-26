package com.blueprint.model;

public class WallData {
    public Vec3 position;
    public Vec3 size;
    public int row;
    public int col;
    /**
     * Rotation about Y, in radians. Zero for the overwhelming majority of boxes, which are
     * grid-aligned; non-zero only for the single box that replaces a staircase of steps
     * along a wall the drawing ran at an angle. Serialised on every wall regardless, since
     * the renderer applies it unconditionally and a missing field would read as undefined.
     */
    public double rotationY;

    public WallData(Vec3 position, Vec3 size, int row, int col) {
        this(position, size, row, col, 0.0);
    }

    public WallData(Vec3 position, Vec3 size, int row, int col, double rotationY) {
        this.position = position;
        this.size = size;
        this.row = row;
        this.col = col;
        this.rotationY = rotationY;
    }
}
