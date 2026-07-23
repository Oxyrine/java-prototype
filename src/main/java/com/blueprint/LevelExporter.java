package com.blueprint;

import com.blueprint.model.LevelData;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/** Writes a LevelData out as pretty-printed JSON. Field name -> JSON key, automatically, via Gson. */
public class LevelExporter {

    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

    public static void export(LevelData level, Path outPath) throws IOException {
        Path parentDir = outPath.toAbsolutePath().getParent();
        if (parentDir != null) {
            Files.createDirectories(parentDir);
        }
        String json = GSON.toJson(level);
        Files.writeString(outPath, json, StandardCharsets.UTF_8);
    }
}
