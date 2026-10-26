package com.blueprint.service;

import java.awt.geom.Point2D;

/**
 * Service to handle outdoor GPS mapping and coordinate transformation 
 * for live user location tracking relative to the blueprint.
 */
public class GeoLocationService {

    // Anchor points mapping GPS (Lat/Lng) to Blueprint Pixel/World Coordinates
    private final double originLat;
    private final double originLng;
    private final double scaleX; // Pixels per degree longitude
    private final double scaleY; // Pixels per degree latitude

    public GeoLocationService(double originLat, double originLng, double scaleX, double scaleY) {
        this.originLat = originLat;
        this.originLng = originLng;
        this.scaleX = scaleX;
        this.scaleY = scaleY;
    }

    /**
     * Converts live GPS coordinates (latitude, longitude) into 
     * blueprint canvas / 3D world coordinates for outdoor tracking.
     * 
     * @param currentLat Current live latitude from device GPS
     * @param currentLng Current live longitude from device GPS
     * @return Point2D containing X and Y coordinates in blueprint space
     */
    public Point2D.Double transformGpsToBlueprint(double currentLat, double currentLng) {
        // Calculate offsets relative to the origin anchor point
        double deltaLat = currentLat - this.originLat;
        double deltaLng = currentLng - this.originLng;

        // Convert offsets to blueprint spatial units
        double blueprintX = deltaLng * this.scaleX;
        // Inverted Y because screen/canvas coordinates typically start from top-left
        double blueprintY = -deltaLat * this.scaleY; 

        return new Point2D.Double(blueprintX, blueprintY);
    }

    /**
     * Validates whether the user's live outdoor location is 
     * within the defined bounds of the outdoor blueprint area.
     */
    public booleanisWithinOutdoorBoundary(double x, double y, double minX, double maxX, double minY, double maxY) {
        return (x >= minX && x <= maxX && y >= minY && y <= maxY);
    }
}