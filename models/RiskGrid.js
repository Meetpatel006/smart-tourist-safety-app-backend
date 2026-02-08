const mongoose = require('mongoose');

const riskGridSchema = new mongoose.Schema({
  gridId: { type: String, required: true, unique: true }, // Format: "lat_lng" of center
  location: {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], required: true, index: '2dsphere' } // [lng, lat]
  },
  riskScore: { type: Number, default: 0, min: 0, max: 1 },
  lastUpdated: { type: Date, default: Date.now },
  riskLevel: { type: String, enum: ["Low", "Medium", "High", "Very High"], default: "Low" },
  tierLevel: { type: String, enum: ["Standard", "High", "Critical"], default: "Standard" }, // Dynamic persistence tier
  radius: { type: Number, default: 500 }, // Display radius in meters
  expiresAt: { type: Date }, // When this grid should naturally expire
  gridName: { type: String, default: "Unknown Zone" }, // Human readable name
  
  // Reasons for risk grid creation (SOS alerts + incidents)
  reasons: [{
    type: { type: String, enum: ['sos_alert', 'incident'], required: true },
    title: { type: String, required: true },        // SOS reason or incident title
    timestamp: { type: Date, required: true },      // When the event occurred
    severity: { type: Number },                     // For incidents (0-1), or safetyScore for SOS (0-100)
    eventType: { type: String }                     // Incident type (theft, assault, etc.) or SOS category
  }],
  
  // Visual styling properties to differentiate from danger zones and geofences
  visualStyle: {
    zoneType: { type: String, default: "risk_grid" },     // Identifies this as a risk grid
    borderStyle: { type: String, default: "dashed" },     // solid, dashed, dotted
    borderWidth: { type: Number, default: 2 },            // pixels
    fillOpacity: { type: Number, default: 0.4 },          // 0-1 (40% transparency)
    fillPattern: { type: String, default: "dots" },       // diagonal-stripes, dots, solid
    iconType: { type: String, default: "incident-marker" }, // Icon to show on map
    renderPriority: { type: Number, default: 2 },         // 1=bottom, 3=top layer
    gridSize: { type: Number, default: 500 }              // meters (for square grid rendering)
  }
});

// Index for geospatial queries
riskGridSchema.index({ location: '2dsphere' });

module.exports = mongoose.model('RiskGrid', riskGridSchema);
