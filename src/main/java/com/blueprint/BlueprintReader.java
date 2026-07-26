package com.blueprint;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * Reads a blueprint text file into a char[][] grid and validates its shape.
 * Recognised characters: '1' wall, '0' floor, '2' spawn, '3' doorway, '4' window,
 * '5' void (solid, but outside the building and never drawn).
 * Blank lines and lines starting with '#' are treated as comments and skipped.
 */
public class BlueprintReader {

    public static char[][] read(Path path) throws BlueprintFormatException {
        List<String> rawLines;
        try {
            rawLines = Files.readAllLines(path);
        } catch (IOException e) {
            throw new BlueprintFormatException(
                    "Could not read blueprint file at: " + path.toAbsolutePath());
        }

        List<String> rows = new ArrayList<>();
        for (String line : rawLines) {
            String trimmed = line.stripTrailing();
            if (trimmed.isEmpty() || trimmed.startsWith("#")) {
                continue;
            }
            rows.add(trimmed);
        }

        if (rows.isEmpty()) {
            throw new BlueprintFormatException(
                    "Blueprint file has no usable rows (only blank lines/comments): " + path);
        }

        int expectedWidth = rows.get(0).length();
        char[][] grid = new char[rows.size()][];

        for (int row = 0; row < rows.size(); row++) {
            String line = rows.get(row);
            if (line.length() != expectedWidth) {
                throw new BlueprintFormatException(String.format(
                        "Ragged blueprint: row %d has %d characters, expected %d (row 0's width). Line: \"%s\"",
                        row, line.length(), expectedWidth, line));
            }

            char[] chars = line.toCharArray();
            for (int col = 0; col < chars.length; col++) {
                char c = chars[col];
                if (c != '1' && c != '0' && c != '2' && c != '3' && c != '4' && c != '5') {
                    throw new BlueprintFormatException(String.format(
                            "Unrecognised character '%c' at row %d, col %d. Only '1' (wall), '0' (floor), "
                                    + "'2' (spawn), '3' (doorway), '4' (window), '5' (void) are allowed.",
                            c, row, col));
                }
            }
            grid[row] = chars;
        }

        return grid;
    }
}
