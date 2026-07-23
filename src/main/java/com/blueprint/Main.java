package com.blueprint;

import com.blueprint.model.LevelData;

import java.io.IOException;
import java.nio.file.Path;

public class Main {

    // Defaults used when no CLI args are given -- running `Main` bare behaves
    // exactly as before (Phase 1). The web frontend always fetches
    // "web/level01.json" by name, so that output path stays fixed regardless
    // of which blueprint was converted; only the JSON's "name" field reflects
    // the actual blueprint filename.
    private static final Path DEFAULT_BLUEPRINT_PATH = Path.of("blueprints", "level01.txt");
    private static final Path DEFAULT_OUTPUT_PATH = Path.of("web", "level01.json");
    private static final double DEFAULT_CELL_SIZE = 1.0;
    private static final double DEFAULT_WALL_HEIGHT = 3.0;

    public static void main(String[] args) {
        try {
            Path blueprintPath = DEFAULT_BLUEPRINT_PATH;
            Path outputPath = DEFAULT_OUTPUT_PATH;
            double cellSize = DEFAULT_CELL_SIZE;
            double wallHeight = DEFAULT_WALL_HEIGHT;

            for (String arg : args) {
                String[] parts = arg.split("=", 2);
                if (parts.length != 2) {
                    throw new IllegalArgumentException("Arguments must be --key=value, got: " + arg);
                }
                switch (parts[0]) {
                    case "--blueprint" -> blueprintPath = Path.of(parts[1]);
                    case "--output" -> outputPath = Path.of(parts[1]);
                    case "--cellSize" -> cellSize = Double.parseDouble(parts[1]);
                    case "--wallHeight" -> wallHeight = Double.parseDouble(parts[1]);
                    default -> throw new IllegalArgumentException("Unknown argument: " + parts[0]);
                }
            }

            String levelName = stripExtension(blueprintPath.getFileName().toString());

            char[][] grid = BlueprintReader.read(blueprintPath);
            LevelData level = LevelBuilder.build(grid, levelName, cellSize, wallHeight);
            LevelExporter.export(level, outputPath);

            System.out.printf(
                    "grid %dx%d, %d walls, spawn (%.1f, %.1f, %.1f) -> %s%n",
                    level.width, level.height, level.walls.size(),
                    level.spawn.x, level.spawn.y, level.spawn.z,
                    outputPath);
        } catch (BlueprintFormatException e) {
            System.err.println("Blueprint error: " + e.getMessage());
            System.exit(1);
        } catch (IOException e) {
            System.err.println("Failed to write JSON output: " + e.getMessage());
            System.exit(1);
        } catch (IllegalArgumentException e) {
            System.err.println("Argument error: " + e.getMessage());
            System.exit(1);
        }
    }

    private static String stripExtension(String filename) {
        int dot = filename.lastIndexOf('.');
        return dot > 0 ? filename.substring(0, dot) : filename;
    }
}
