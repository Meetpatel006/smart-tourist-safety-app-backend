const mongoose = require("mongoose");

const RawInfoSchema = new mongoose.Schema({
  Name: String,
  Category: String,
  Sub_Category: String,
  State: String,
  Latitude: String,
  Longitude: String,
  Area_km2: String,
  Year_Established: String,
  Source: String,
  Additional_Info: String,
}, { _id: false });

const DangerZoneSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true}, // "disaster-0"
  name: { type: String, required: true },                 // "Andhra Pradesh Coast"
  type: { type: String, enum: ["circle", "polygon"], required: true }, 
  coords: {                                               // [lat, lng]
    type: [Number],
    required: true,
    validate: {
      validator: arr => arr.length === 2,
      message: "Coords must be [latitude, longitude]"
    }
  },
  radiusKm: { type: Number },                             // optional (only for circle)
  category: { type: String },
  state: { type: String },
  riskLevel: { type: String, enum: ["Low", "Medium", "High", "Very High"] },
  source: { type: String },
  raw: { type: RawInfoSchema },                           // keep original raw metadata
  
  // Visual styling properties to differentiate from risk grids and geofences
  visualStyle: {
    zoneType: { type: String, default: "danger_zone" },   // Identifies this as a danger zone
    borderStyle: { type: String, default: "solid" },      // solid, dashed, dotted
    borderWidth: { type: Number, default: 3 },            // pixels
    fillOpacity: { type: Number, default: 0.25 },         // 0-1 (25% transparency)
    fillPattern: { type: String, default: "diagonal-stripes" }, // diagonal-stripes, dots, solid
    iconType: { type: String, default: "warning-triangle" },     // Icon to show on map
    renderPriority: { type: Number, default: 1 }          // 1=bottom, 3=top layer
  }
}, { timestamps: true });

// Tourist Destination Geofence Schema (for alerting tourists when leaving safe areas)
// Also supports itinerary-based geofences for tour groups and solo users
const GeofenceSchema = new mongoose.Schema({
  name: { type: String, required: true },                 // "Taj Mahal Area", "Goa Beach Zone"
  destination: { type: String },                          // Tourist destination name (optional for itinerary geofences)
  type: { type: String, enum: ["circle", "polygon"], required: true },
  coords: {                                               // [lat, lng] - center point
    type: [Number],
    required: true,
    validate: {
      validator: arr => arr.length === 2,
      message: "Coords must be [latitude, longitude]"
    }
  },
  radiusKm: { type: Number },                            // For circle geofences
  polygonCoords: [[Number]],                             // For polygon geofences [[lng,lat],...]
  isActive: { type: Boolean, default: true },
  alertMessage: { type: String, default: "You are leaving the safe tourist area" },
  
  // NEW FIELDS FOR ITINERARY GEOFENCES
  sourceType: { 
    type: String, 
    enum: ["static", "itinerary"], 
    default: "static",
    required: true 
  },
  ownerId: { 
    type: String, // Changed from ObjectId to String to support touristId/groupId
    required: function() { return this.sourceType === 'itinerary'; }
  },
  ownerType: { 
    type: String, 
    enum: ["Tourist", "TourGroup"],
    required: function() { return this.sourceType === 'itinerary'; }
  },
  dayNumber: { 
    type: Number,
    required: function() { return this.sourceType === 'itinerary'; }
  },
  scheduledDate: { 
    type: Date,
    required: function() { return this.sourceType === 'itinerary'; }
  },
  activityNodeName: { type: String },
  activityNodeType: { 
    type: String, 
    enum: ["start", "visit", "stay", "transit", "end"]
  },
  expiresAt: { 
    type: Date,
    required: function() { return this.sourceType === 'itinerary'; }
  },
  
  // Visual styling properties to differentiate from danger zones and risk grids
  visualStyle: {
    zoneType: { type: String, default: "geofence" },      // Identifies this as a geofence
    borderStyle: { type: String, default: "dotted" },     // solid, dashed, dotted
    borderWidth: { type: Number, default: 2 },            // pixels
    fillOpacity: { type: Number, default: 0.15 },         // 0-1 (15% transparency - most transparent)
    fillPattern: { type: String, default: "solid" },      // diagonal-stripes, dots, solid
    iconType: { type: String, default: "shield" },        // Icon to show on map
    renderPriority: { type: Number, default: 3 },         // 1=bottom, 3=top layer
    color: { type: String, default: "blue" }              // Base color (for non-severity zones)
  }
}, { timestamps: true });

// INDEXES FOR PERFORMANCE
GeofenceSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86400 }); // TTL index (24 hours after expiry)
GeofenceSchema.index({ ownerId: 1, ownerType: 1, scheduledDate: 1, isActive: 1 }); // Compound index for queries
GeofenceSchema.index({ sourceType: 1 }); // Filter by type

module.exports = {
  DangerZone: mongoose.model("DangerZone", DangerZoneSchema),
  Geofence: mongoose.model("Geofence", GeofenceSchema)
};
