const RiskGrid = require('../models/RiskGrid');
const { DangerZone } = require('../models/Geofence');
const Incident = require('../models/Incident');
const SOSAlert = require('../models/SOSAlertModel');

/**
 * Dynamic Safety Score Calculation Service
 * 
 * Calculates a tourist's safety score (0-100) based on:
 * 1. Proximity to risk grids
 * 2. Proximity to danger zones  
 * 3. Whether inside any danger zone
 * 4. Risk severity of nearby threats
 * 
 * Score Ranges:
 * - 90-100: Excellent (Very Safe)
 * - 70-89:  Good (Safe)
 * - 50-69:  Fair (Moderate Risk)
 * - 30-49:  Poor (High Risk)
 * - 0-29:   Critical (Very High Risk)
 */

// Configuration constants
const CONFIG = {
  // Distance thresholds (in meters)
  DANGER_ZONE_CRITICAL_DISTANCE: 100,    // Inside or very close
  DANGER_ZONE_HIGH_DISTANCE: 500,        // High alert zone
  DANGER_ZONE_MEDIUM_DISTANCE: 2000,     // Medium alert zone
  DANGER_ZONE_LOW_DISTANCE: 5000,        // Low alert zone
  
  RISK_GRID_CRITICAL_DISTANCE: 100,      // Inside grid
  RISK_GRID_HIGH_DISTANCE: 500,          // Very close to grid
  RISK_GRID_MEDIUM_DISTANCE: 1500,       // Medium distance
  RISK_GRID_LOW_DISTANCE: 3000,          // Far but visible
  
  // Base scores
  BASE_SCORE: 100,                        // Perfect safety
  
  // Maximum zones to consider (performance optimization)
  MAX_NEARBY_ZONES: 10,
  MAX_NEARBY_GRIDS: 15,
  
  // Search radius for queries (in meters)
  SEARCH_RADIUS: 10000,                   // 10km search radius

  // Direct SOS / Incident influence
  SOS_RADIUS_M: 2500,
  INCIDENT_RADIUS_M: 4000,
  SOS_LOOKBACK_DAYS: 7,
  INCIDENT_LOOKBACK_DAYS: 7,
  MAX_SOS_PENALTY: 40,        // max points deducted from nearby SOS
  MAX_INCIDENT_PENALTY: 45    // max points deducted from nearby incidents
};

/**
 * Haversine formula to calculate distance between two coordinates
 * @param {number} lat1 - Latitude of point 1
 * @param {number} lng1 - Longitude of point 1
 * @param {number} lat2 - Latitude of point 2
 * @param {number} lng2 - Longitude of point 2
 * @returns {number} Distance in meters
 */
function calculateDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000; // Earth's radius in meters
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

/**
 * Calculate risk level label from riskLevel string
 * @param {string} riskLevel - "Low", "Medium", "High", "Very High"
 * @returns {number} Numeric severity (0-1)
 */
function getRiskSeverity(riskLevel) {
  const severityMap = {
    'Low': 0.2,
    'Medium': 0.5,
    'High': 0.75,
    'Very High': 1.0
  };
  return severityMap[riskLevel] || 0.3;
}

/**
 * Calculate impact on safety score based on distance to a threat
 * Uses exponential decay: closer = higher impact
 * 
 * @param {number} distance - Distance to threat in meters
 * @param {number} severity - Severity of threat (0-1)
 * @param {string} type - 'risk_grid' or 'danger_zone'
 * @param {number} [customRadius] - Dynamics radius for risk grids
 * @returns {number} Score penalty (0-100)
 */
function calculateThreatImpact(distance, severity, type, customRadius = null) {
  let config;
  
  if (type === 'risk_grid' && customRadius) {
    // Dynamic thresholds based on the grid's actual size
    // If you are INSIDE the radius, it is Critical.
    config = {
      critical: customRadius,             // 0 to Radius (Inside)
      high: customRadius + 500,           // Immediate edge buffer
      medium: customRadius + 1500,        // Nearby
      low: customRadius + 3000            // Awareness zone
    };
  } else if (type === 'danger_zone') {
    config = {
        critical: CONFIG.DANGER_ZONE_CRITICAL_DISTANCE,
        high: CONFIG.DANGER_ZONE_HIGH_DISTANCE,
        medium: CONFIG.DANGER_ZONE_MEDIUM_DISTANCE,
        low: CONFIG.DANGER_ZONE_LOW_DISTANCE
    };
  } else {
    // Fallback for static grids (legacy)
    config = {
        critical: CONFIG.RISK_GRID_CRITICAL_DISTANCE,
        high: CONFIG.RISK_GRID_HIGH_DISTANCE,
        medium: CONFIG.RISK_GRID_MEDIUM_DISTANCE,
        low: CONFIG.RISK_GRID_LOW_DISTANCE
    };
  }

  let impactMultiplier = 0;

  // Calculate impact based on distance zones
  if (distance <= config.critical) {
    // Inside or extremely close - maximum impact
    impactMultiplier = 1.0;
  } else if (distance <= config.high) {
    // High risk zone - exponential decay
    const ratio = (distance - config.critical) / (config.high - config.critical);
    impactMultiplier = 0.7 + (0.3 * (1 - ratio));
  } else if (distance <= config.medium) {
    // Medium risk zone
    const ratio = (distance - config.high) / (config.medium - config.high);
    impactMultiplier = 0.4 + (0.3 * (1 - ratio));
  } else if (distance <= config.low) {
    // Low risk zone - minimal impact
    const ratio = (distance - config.medium) / (config.low - config.medium);
    impactMultiplier = 0.1 + (0.3 * (1 - ratio));
  } else {
    // Beyond monitoring range - no impact
    return 0;
  }

  // Calculate penalty: severity * impact * max penalty
  // Max penalty is 60 points for a Very High severity threat at critical distance
  const maxPenalty = type === 'danger_zone' ? 70 : 50; // Danger zones have higher impact
  return severity * impactMultiplier * maxPenalty;
}

// Linear decay for nearby SOS/incident signals
function proximityPenalty(distance, maxRadius, severity, maxPenalty) {
  if (distance > maxRadius) return 0;
  const weight = 1 - (distance / maxRadius); // 1 at center, 0 at edge
  return severity * weight * maxPenalty;
}

/**
 * Main function: Calculate safety score for a tourist's current location
 * 
 * @param {number} lat - Tourist's current latitude
 * @param {number} lng - Tourist's current longitude
 * @returns {Promise<Object>} Safety score details
 */
async function calculateSafetyScore(lat, lng) {
  try {
    console.log(`🔍 Calculating safety score for location: ${lat}, ${lng}`);
    
    let totalPenalty = 0;
    const threats = [];
    const penalizedGridZones = []; // Track penalized grids to avoid double counting
    
    // --- 1. Check nearby Risk Grids ---
    const nearbyRiskGrids = await RiskGrid.find({
      location: {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: [lng, lat]
          },
          $maxDistance: CONFIG.SEARCH_RADIUS
        }
      },
      riskScore: { $gt: 0.1 } // Only consider grids with meaningful risk
    }).limit(CONFIG.MAX_NEARBY_GRIDS);

    console.log(`Found ${nearbyRiskGrids.length} nearby risk grids`);

    for (const grid of nearbyRiskGrids) {
      const gridLat = grid.location.coordinates[1];
      const gridLng = grid.location.coordinates[0];
      const distance = calculateDistance(lat, lng, gridLat, gridLng);
      
      const gridRadius = grid.radius || 500; // Default to 500m if not set
      const monitoringRange = gridRadius + 3000; // Match 'low' threshold

      // Only process if within range
      if (distance <= monitoringRange) {
        const severity = grid.riskScore; // 0-1
        const impact = calculateThreatImpact(distance, severity, 'risk_grid', gridRadius);
        
        if (impact > 0) {
          totalPenalty += impact;
          
          // Store this grid's coverage to mask individual underlying events (SOS/Incidents)
          // We use the grid radius itself for masking, as events inside are considered part of the grid
          penalizedGridZones.push({ lat: gridLat, lng: gridLng, radius: gridRadius });

          threats.push({
            type: 'risk_grid',
            name: grid.gridName || 'Risk Zone',
            distance: Math.round(distance),
            severity: grid.riskLevel,
            impact: Math.round(impact),
            coordinates: { lat: gridLat, lng: gridLng },
            reasons: grid.reasons || [] // Capture reasons from grid for description
          });
        }
      }
    }

    // --- 2. Check nearby Danger Zones ---
    const nearbyDangerZones = await DangerZone.find({}).limit(100); // Get all, filter by distance

    let dangerZonesInRange = [];
    for (const zone of nearbyDangerZones) {
      const zoneLat = zone.coords[0];
      const zoneLng = zone.coords[1];
      const distance = calculateDistance(lat, lng, zoneLat, zoneLng);

      // For circle zones, check if inside or nearby
      if (zone.type === 'circle' && zone.radiusKm) {
        const radiusMeters = zone.radiusKm * 1000;
        
        // Check if inside the danger zone
        if (distance <= radiusMeters) {
          dangerZonesInRange.push({ zone, distance: 0, isInside: true });
        } else {
          // Calculate distance from edge
          const distanceFromEdge = distance - radiusMeters;
          if (distanceFromEdge <= CONFIG.DANGER_ZONE_LOW_DISTANCE) {
            dangerZonesInRange.push({ zone, distance: distanceFromEdge, isInside: false });
          }
        }
      } else {
        // For point-based zones, use direct distance
        if (distance <= CONFIG.DANGER_ZONE_LOW_DISTANCE) {
          dangerZonesInRange.push({ zone, distance, isInside: false });
        }
      }
    }

    console.log(`Found ${dangerZonesInRange.length} nearby danger zones`);

    // Sort by distance and take closest
    dangerZonesInRange.sort((a, b) => a.distance - b.distance);
    dangerZonesInRange = dangerZonesInRange.slice(0, CONFIG.MAX_NEARBY_ZONES);

    for (const { zone, distance, isInside } of dangerZonesInRange) {
      const severity = getRiskSeverity(zone.riskLevel);
      
      // If inside danger zone, apply maximum penalty
      const effectiveDistance = isInside ? 0 : distance;
      const impact = calculateThreatImpact(effectiveDistance, severity, 'danger_zone');
      
      if (impact > 0) {
        totalPenalty += impact;
        threats.push({
          type: 'danger_zone',
          name: zone.name,
          distance: Math.round(distance),
          severity: zone.riskLevel,
          impact: Math.round(impact),
          isInside: isInside,
          coordinates: { lat: zone.coords[0], lng: zone.coords[1] }
        });
      }
    }

    // --- 3. Direct nearby SOS alerts influence ---
    const sosSince = new Date(Date.now() - CONFIG.SOS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const nearbySOS = await SOSAlert.find({
      timestamp: { $gte: sosSince },
      status: 'new', // Only penalize for active, unattended threats
      location: {
        $geoWithin: {
          $centerSphere: [[lng, lat], CONFIG.SOS_RADIUS_M / 6378100]
        }
      }
    }).select('safetyScore timestamp sosReason location').limit(50).lean();

    if (nearbySOS.length > 0) {
      console.log(`⚠️ Found ${nearbySOS.length} nearby active SOS alerts`);
    }

    for (const sos of nearbySOS) {
      const sLat = sos.location?.coordinates?.[1];
      const sLng = sos.location?.coordinates?.[0];
      if (sLat == null || sLng == null) continue;

      // Check if this SOS is covered by an already penalized Risk Grid to avoid double-counting
      const isCoveredByGrid = penalizedGridZones.some(grid => {
        const distToGrid = calculateDistance(sLat, sLng, grid.lat, grid.lng);
        return distToGrid <= grid.radius; 
      });

      if (isCoveredByGrid) continue;

      const distance = calculateDistance(lat, lng, sLat, sLng);
      const severity = Math.max(0, Math.min(1, (100 - (sos.safetyScore || 70)) / 100)); // lower safetyScore -> higher severity
      const impact = proximityPenalty(distance, CONFIG.SOS_RADIUS_M, severity, CONFIG.MAX_SOS_PENALTY);

      if (impact > 0) {
        totalPenalty += impact;
        // Use standard format reason
        const formattedReason = formatReasonText(sos.sosReason?.reason || 'Nearby SOS');
        threats.push({
          type: 'sos_alert',
          name: formattedReason,
          category: 'SOS Alert', // Standard Category
          distance: Math.round(distance),
          severity: `safety:${sos.safetyScore || 'n/a'}`,
          impact: Math.round(impact),
          timestamp: sos.timestamp
        });
      }
    }

    // --- 4. Direct nearby Incidents influence ---
    const incidentsSince = new Date(Date.now() - CONFIG.INCIDENT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const nearbyIncidents = await Incident.find({
      timestamp: { $gte: incidentsSince },
      location: {
        $geoWithin: {
          $centerSphere: [[lng, lat], CONFIG.INCIDENT_RADIUS_M / 6378100]
        }
      }
    }).select('severity title type timestamp location').limit(50).lean();

    if (nearbyIncidents.length > 0) {
      console.log(`⚠️ Found ${nearbyIncidents.length} nearby Incidents`);
    }

    for (const inc of nearbyIncidents) {
      const iLat = inc.location?.coordinates?.[1];
      const iLng = inc.location?.coordinates?.[0];
      if (iLat == null || iLng == null) continue;

      // Check if this Incident is covered by an already penalized Risk Grid to avoid double-counting
      const isCoveredByGrid = penalizedGridZones.some(grid => {
        const distToGrid = calculateDistance(iLat, iLng, grid.lat, grid.lng);
        return distToGrid <= grid.radius; 
      });

      if (isCoveredByGrid) continue;

      const distance = calculateDistance(lat, lng, iLat, iLng);
      const severity = Math.max(0, Math.min(1, inc.severity || 0.6));
      const impact = proximityPenalty(distance, CONFIG.INCIDENT_RADIUS_M, severity, CONFIG.MAX_INCIDENT_PENALTY);

      if (impact > 0) {
        totalPenalty += impact;
        // Prefer Type for category, Title for name
        const category = formatReasonText(inc.type || 'Incident');
        const name = formatReasonText(inc.title || 'Incident');
        
        threats.push({
          type: 'incident',
          name: name,
          category: category,
          distance: Math.round(distance),
          severity: inc.type || 'incident', 
          impact: Math.round(impact),
          timestamp: inc.timestamp
        });
      }
    }

    // --- 5. Calculate Final Score ---
    // Start with base score and subtract penalties
    let finalScore = CONFIG.BASE_SCORE - totalPenalty;
    
    // Ensure score is within bounds
    finalScore = Math.max(0, Math.min(100, finalScore));
    finalScore = Math.round(finalScore);

    // --- 6. Determine Safety Level & Description ---
    
    // Sort threats by impact (highest first) so we can prioritize reasons in description
    threats.sort((a, b) => b.impact - a.impact);

    let safetyLevel = '';
    let safetyColor = '';
    let description = '';
    const uniqueReasons = new Set(); // Use Set to avoid redundant reasons (e.g. "Riot" in Grid vs "Riot" Incident)

    if (finalScore >= 90) {
      safetyLevel = 'EXCELLENT';
      safetyColor = '#10b981'; // Green
      description = 'Very Safe Area';
    } else if (finalScore >= 70) {
      safetyLevel = 'GOOD';
      safetyColor = '#3b82f6'; // Blue
      description = 'Safe Area';
    } else if (finalScore >= 50) {
      safetyLevel = 'FAIR';
      safetyColor = '#f59e0b'; // Yellow
      description = 'Moderate Risk';
    } else if (finalScore >= 30) {
      safetyLevel = 'POOR';
      safetyColor = '#ea580c'; // Orange
      description = 'High Risk Area';
    } else {
      safetyLevel = 'CRITICAL';
      safetyColor = '#dc2626'; // Red
      description = 'Danger Zone';
    }

    // --- Generate Dynamic Description from Threats ---
    if (finalScore < 90 && threats.length > 0) {
      for (const t of threats) {
        if (uniqueReasons.size >= 3) break; // Limit to top 3 distinct reasons

        // 1. RISK GRID: Prefer aggregated 'eventType' if available, else formatted title
        if (t.type === 'risk_grid' && t.reasons && t.reasons.length > 0) {
          t.reasons.forEach(r => {
             // Use eventType (e.g. "Theft") over title (e.g. "Phone stolen") for summaries
             const txt = r.eventType || r.title;
             if (txt) uniqueReasons.add(formatReasonText(txt));
          });
        } 
        // 2. INCIDENTS: Use category (Type) for summary
        else if (t.category) {
          uniqueReasons.add(t.category);
        }
        // 3. Fallback: formatted name
        else if (t.name) {
          uniqueReasons.add(formatReasonText(t.name));
        }
      }

      if (uniqueReasons.size > 0) {
        const reasonStr = Array.from(uniqueReasons).join(', ');
        description += ` • Reported issues: ${reasonStr}.`;
      } else {
        description += ' • Threats detected nearby.';
      }
    } else if (finalScore >= 90) {
      description += ' • Low crime rate reported recently.';
    }

    const result = {
      safetyScore: finalScore,
      safetyLevel: safetyLevel,
      safetyColor: safetyColor,
      description: description,
      totalThreats: threats.length,
      nearestThreat: threats.length > 0 ? threats[0] : null,
      threats: threats.slice(0, 5), // Return top 5 threats
      location: { lat, lng },
      timestamp: new Date().toISOString()
    };

    console.log(`✅ Safety score calculated: ${finalScore}/100 (${safetyLevel})`);
    
    return result;

  } catch (error) {
    console.error('Error calculating safety score:', error);
    
    // Return a default safe score on error
    return {
      safetyScore: 80,
      safetyLevel: 'GOOD',
      safetyColor: '#3b82f6',
      description: 'Unable to calculate precise safety score. Assuming safe area.',
      totalThreats: 0,
      nearestThreat: null,
      threats: [],
      location: { lat, lng },
      timestamp: new Date().toISOString(),
      error: true
    };
  }
}

/**
 * Calculate safety score change notification
 * Determines if a notification should be sent based on score change
 * 
 * @param {number} oldScore - Previous safety score
 * @param {number} newScore - New safety score
 * @returns {Object|null} Notification object or null if no notification needed
 */
function shouldNotifyScoreChange(oldScore, newScore) {
  const scoreDifference = oldScore - newScore;
  
  // Define thresholds for notifications
  if (scoreDifference >= 30) {
    return {
      type: 'critical',
      title: '⚠️ Safety Score Alert',
      message: 'You are entering a high-risk area. Exercise extreme caution.',
      priority: 'high'
    };
  } else if (scoreDifference >= 15) {
    return {
      type: 'warning',
      title: 'Safety Score Decreased',
      message: 'You are approaching an area with increased risk.',
      priority: 'medium'
    };
  } else if (scoreDifference <= -30) {
    return {
      type: 'improvement',
      title: '✅ Entering Safer Area',
      message: 'Safety score improved. You are in a safer location.',
      priority: 'low'
    };
  }
  
  return null; // No notification needed
}

/**
 * Helper to clean up reason text
 * 1. Specific mappings (IMMEDIATE PANIC -> Emergency Alert)
 * 2. Title Casing
 */
function formatReasonText(text) {
  if (!text) return 'Safety Concern';
  
  const clean = text.trim();
  const upper = clean.toUpperCase();

  // Map known raw codes to user-friendly labels
  if (upper.includes('PANIC') || upper.includes('IMMEDIATE')) return 'Emergency Alert';
  if (upper === 'SOS') return 'Distress Signal';
  if (upper === 'MEDICAL') return 'Medical Emergency';

  // Title Case conversion (e.g. "robbery at hostel" -> "Robbery At Hostel")
  return clean.replace(/\w\S*/g, (txt) => {
    return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase();
  });
}

module.exports = {
  calculateSafetyScore,
  shouldNotifyScoreChange,
  calculateDistance
};
