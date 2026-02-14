const Transition = require('../models/Transition');
const { CustomError } = require('../middlewares/errorMiddleware');
const { DangerZone, Geofence } = require('../models/Geofence');
const RiskGrid = require('../models/RiskGrid');
const { updateRiskScores } = require('../services/riskEngineService');

// @desc    Receive and store user geofence transitions
// @route   POST /api/transitions
// @access  Private (tourist)
exports.receiveGeofenceTransitions = async (req, res, next) => {
  try {
    const { transitions } = req.body;

    if (!Array.isArray(transitions)) {
      return next(new CustomError(400, 'Transitions must be an array.'));
    }

    if (transitions.length === 0) {
      return res.status(200).json({ insertedCount: 0 });
    }

    // Add server-side timestamp and user ID
    const docs = transitions.map((t) => ({
      ...t,
      digitalId: req.user.digitalId,
      receivedAt: new Date(),
    }));

    const result = await Transition.insertMany(docs);

    // Check for Danger Zone Entry Alerts
    const alerts = [];
    for (const t of docs) {
      if (t.location && t.location.latitude && t.location.longitude) {
        const lat = t.location.latitude;
        const lng = t.location.longitude;

        // Find if this location is inside a High Risk Grid
        // Using a slightly smaller distance to be more precise about "entry" if needed, 
        // but 500m matches grid radius roughly.
        const riskGrid = await RiskGrid.findOne({
          location: {
            $near: {
              $geometry: { type: "Point", coordinates: [lng, lat] },
              $maxDistance: 500
            }
          }
        });

        if (riskGrid && (riskGrid.riskLevel === 'High' || riskGrid.riskLevel === 'Very High')) {
          alerts.push({
            type: 'DANGER_ZONE_ENTRY',
            message: `Warning: You have entered a ${riskGrid.riskLevel} Risk Zone.`,
            riskLevel: riskGrid.riskLevel,
            location: { lat, lng }
          });
        }
      }
    }

    res.status(201).json({
      message: 'Geofence transitions received successfully.',
      insertedCount: result.insertedCount,
      alerts: alerts
    });
  } catch (err) {
    next(err);
  }
};

exports.createGeoFenceToDangerLocation = async (req, res, next) => {
  try {
    const dangerZone = new DangerZone(req.body);
    await dangerZone.save();
    
    // Emit real-time zone update
    const realtimeService = require('../services/realtimeService');
    realtimeService.emitDangerZoneAdded({
      id: dangerZone.id || dangerZone._id,
      name: dangerZone.name,
      riskLevel: dangerZone.riskLevel,
      type: 'zone',
      shape: dangerZone.type,
      coordinates: dangerZone.coords,
      radius: dangerZone.radiusKm ? dangerZone.radiusKm * 1000 : 0
    }).catch(err => console.error("Socket emit error:", err));

    res.status(201).json({ message: "Danger zone saved successfully", data: dangerZone });
  } catch (error) {
    console.error("Error saving danger zone:", error);
    next(error);
  }
};

exports.getallZones = async (req, res, next) => {
  try {
    const zones = await DangerZone.find();
    res.json(zones);
  } catch (err) {
    console.error("Error fetching danger zones:", err);
    next(err);
  }
}

exports.getZonebyId = async (req, res, next) => {
  try {
    const zone = await DangerZone.findOne({ id: req.params.id });
    if (!zone) {
      return res.status(404).json({ error: "Danger zone not found" });
    }
    res.json(zone);
  } catch (err) {
    console.error("Error fetching danger zone:", err);
    next(err);
  }
}

exports.getHighRiskZoneCount = async (req, res, next) => {
  try {
    const highRiskCount = await DangerZone.countDocuments({ riskLevel: "High" });

    res.status(200).json({
      success: true,
      highRiskZones: highRiskCount,
    });
  } catch (error) {
    console.error("Error counting high-risk zones:", error);
    next(error);
  }
};

exports.getDynamicRiskZones = async (req, res, next) => {
  try {
    const { lat, lng, radius = 5000 } = req.query;

    // Config: Grid size (must match service) - NOW 500m
    const GRID_SIZE_DEG = 0.0045; 


    let grids;
    if (!lat || !lng) {
      // Return ALL grids regardless of score so the frontend sees everything in the database
      grids = await RiskGrid.find({}).limit(100);
    } else {
      grids = await RiskGrid.find({
        location: {
          $geoWithin: {
            $centerSphere: [[parseFloat(lng), parseFloat(lat)], parseInt(radius) / 6378100]
          }
        }
      });
    }

    // Transform to GeoJSON FEATURE COLLECTION with visual styling
    const geoJSON = {
      type: "FeatureCollection",
      features: grids.map(g => ({
        type: "Feature",
        properties: {
          gridId: g.gridId,
          riskScore: g.riskScore,
          riskLevel: g.riskLevel,
          gridName: g.gridName,
          lastUpdated: g.lastUpdated,
          // Include visual styling for map rendering
          visualStyle: g.visualStyle || {
            zoneType: "risk_grid",
            borderStyle: "dashed",
            borderWidth: 2,
            fillOpacity: 0.4,
            fillPattern: "dots",
            iconType: "incident-marker",
            renderPriority: 2,
            gridSize: 500
          }
        },
        geometry: g.location // Send the Center Point directly
      }))
    };

    res.json(geoJSON);
  } catch (error) {
    next(error);
  }
};

exports.triggerRiskUpdate = async (req, res, next) => {
  try {
    await updateRiskScores();
    res.json({ message: "Risk scores updated successfully." });
  } catch (error) {
    next(error);
  }
};

// @desc    Create a geofence for tourist destination
// @route   POST /api/geofences/destination
// @access  Private (authority/admin)
exports.createDestinationGeofence = async (req, res, next) => {
  try {
    const geofence = new Geofence(req.body);
    await geofence.save();
    
    // Emit real-time geofence update
    // const realtimeService = require('../services/realtimeService');
    // realtimeService.emitGeofenceAdded({
    //   id: geofence.id || geofence._id,
    //   name: geofence.name,
    //   destination: geofence.destination,
    //   type: 'geofence',
    //   shape: geofence.type,
    //   coordinates: geofence.coords,
    //   radius: geofence.radiusKm ? geofence.radiusKm * 1000 : 0,
    //   visualStyle: geofence.visualStyle
    // }).catch(err => console.error("Socket emit error:", err));

    res.status(201).json({ 
      message: "Destination geofence created successfully", 
      data: geofence 
    });
  } catch (error) {
    console.error("Error creating destination geofence:", error);
    next(error);
  }
};

// @desc    Get all destination geofences
// @route   GET /api/geofences/destinations
// @access  Public
exports.getAllDestinationGeofences = async (req, res, next) => {
  try {
    const geofences = await Geofence.find({ isActive: true });
    res.json(geofences);
  } catch (err) {
    console.error("Error fetching geofences:", err);
    next(err);
  }
};

// @desc    Get all zones with visual styling (combined endpoint)
// @route   GET /api/geofences/all-zones-styled?userId=xxx
// @access  Public
exports.getAllZonesWithStyling = async (req, res, next) => {
  try {
    const { userId } = req.query;

    // Fetch all three types of zones
    const dangerZones = await DangerZone.find();
    const riskGrids = await RiskGrid.find().limit(100);
    
    // Fetch geofences based on userId parameter
    let geofenceQuery = { isActive: true };
    
    // If userId is provided, include both static geofences and user's itinerary geofences
    // If no userId, only return static geofences (sourceType: 'static' or undefined)
    if (userId) {
      geofenceQuery = {
        isActive: true,
        $or: [
          { sourceType: { $exists: false } }, // Static geofences (no sourceType field)
          { sourceType: 'static' }, // Explicitly static geofences
          { ownerId: userId } // User's personal itinerary geofences
        ]
      };
    } else {
      // No userId provided - only return static geofences
      geofenceQuery = {
        isActive: true,
        $or: [
          { sourceType: { $exists: false } },
          { sourceType: 'static' }
        ]
      };
    }

    const geofences = await Geofence.find(geofenceQuery);

    // Transform to a unified response with visual styling
    const response = {
      dangerZones: dangerZones.map(zone => ({
        ...zone.toObject(),
        visualStyle: zone.visualStyle || {
          zoneType: "danger_zone",
          borderStyle: "solid",
          borderWidth: 3,
          fillOpacity: 0.25,
          fillPattern: "diagonal-stripes",
          iconType: "warning-triangle",
          renderPriority: 1
        }
      })),
      riskGrids: riskGrids.map(grid => ({
        ...grid.toObject(),
        visualStyle: grid.visualStyle || {
          zoneType: "risk_grid",
          borderStyle: "dashed",
          borderWidth: 2,
          fillOpacity: 0.4,
          fillPattern: "dots",
          iconType: "incident-marker",
          renderPriority: 2,
          gridSize: 500
        }
      })),
      geofences: geofences.map(fence => ({
        ...fence.toObject(),
        visualStyle: fence.visualStyle || {
          zoneType: fence.sourceType === 'itinerary' ? "itinerary_geofence" : "geofence",
          borderStyle: fence.sourceType === 'itinerary' ? "solid" : "dotted",
          borderWidth: 2,
          fillOpacity: 0.15,
          fillPattern: "solid",
          iconType: fence.sourceType === 'itinerary' ? "location-pin" : "shield",
          renderPriority: 3,
          color: fence.sourceType === 'itinerary' ? "green" : "blue"
        }
      }))
    };

    res.json(response);
  } catch (err) {
    console.error("Error fetching all zones:", err);
    next(err);
  }
};
