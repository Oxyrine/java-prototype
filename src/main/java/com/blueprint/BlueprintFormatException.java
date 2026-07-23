package com.blueprint;

/** Thrown when the blueprint text file is missing, empty, ragged, or contains a bad character. */
public class BlueprintFormatException extends Exception {
    public BlueprintFormatException(String message) {
        super(message);
    }
}
