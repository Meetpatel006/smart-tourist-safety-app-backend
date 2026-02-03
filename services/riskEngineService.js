const RiskGrid = require('../models/RiskGrid');
const Incident = require('../models/Incident');
const SOSAlert = require('../models/SOSAlertModel');
const { getGridName } = require('../utils/mapboxClient');

// Constants
const GRID_SIZE_DEG = 0.0045; // Approx 500m (Reverted from 3km)
const LAMBDA = 0.01; // Time decay factor (Reduced for 7-day persistence)

// Weights (Tuned to increase Incident impact)
const W_INCIDENT = 0.40;
const W_SOS = 0.50;
const W_HISTORY = 0.10;

/**
 * Convert lat/lng to a fixed grid ID and center point
 */
function getGridIdAndCenter(lat, lng) {
    const snapedLat = Math.floor(lat / GRID_SIZE_DEG) * GRID_SIZE_DEG + (GRID_SIZE_DEG / 2);
    const snapedLng = Math.floor(lng / GRID_SIZE_DEG) * GRID_SIZE_DEG + (GRID_SIZE_DEG / 2);
    return {
        gridId: `${snapedLat.toFixed(5)}_${snapedLng.toFixed(5)}`,
        center: [snapedLng, snapedLat]
    };
}

/**
 * Core Logic: Update Risk Scores for all active grids
 */
async function updateRiskScores() {
    console.log("🔄 Running Global Risk Update Job...");

    // 1. Identify all grids that need updates (from recent activity or existing records)
    const activeGridIds = new Set();
    
    // A. Grids with recent SOS alerts (last 7 days)
    const recentSOS = await SOSAlert.find({ 
        timestamp: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } 
    });
    recentSOS.forEach(alert => {
        if(alert.location && alert.location.coordinates) {
            const { gridId } = getGridIdAndCenter(alert.location.coordinates[1], alert.location.coordinates[0]);
            activeGridIds.add(gridId);
        }
    });

    // B. Grids with recent Incidents (last 7 days)
    const recentIncidents = await Incident.find({
        timestamp: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
    });
    recentIncidents.forEach(inc => {
        if(inc.location && inc.location.coordinates) {
            const { gridId } = getGridIdAndCenter(inc.location.coordinates[1], inc.location.coordinates[0]);
            activeGridIds.add(gridId);
        }
    });
    
    // C. Existing grids (to update decay)
    const existingGrids = await RiskGrid.find({});
    existingGrids.forEach(g => activeGridIds.add(g.gridId));

    console.log(`Analyzing ${activeGridIds.size} active grids...`);

    // 2. Process each grid
    for (const gid of activeGridIds) {
        await processGrid(gid);
    }
    console.log("✅ Risk Update Complete.");
}

/**
 * Calculate risk for a single grid cell
 */
async function processGrid(gridId) {
    const [latStr, lngStr] = gridId.split('_');
    const lat = parseFloat(latStr);
    const lng = parseFloat(lngStr);

    // --- 1. Query SOS Alerts and Incidents for Reasons ---
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    
    // Get SOS alerts within 2km radius
    const sosAlerts = await SOSAlert.find({
        location: {
            $geoWithin: {
                $centerSphere: [ [lng, lat], 2000 / 6378100 ]
            }
        },
        timestamp: { $gte: sevenDaysAgo }
    }).select('sosReason.reason timestamp safetyScore').lean();

    // Get incidents within 3.5km radius
    const incidents = await Incident.find({
        location: {
            $geoWithin: {
                $centerSphere: [ [lng, lat], 3500 / 6378100 ]
            }
        },
        timestamp: { $gte: sevenDaysAgo }
    }).select('title type severity timestamp').lean();

    // --- 2. Build Reasons Array (Top 10 Most Recent) ---
    const reasons = [];
    
    // Add SOS alerts
    sosAlerts.forEach(sos => {
        reasons.push({
            type: 'sos_alert',
            title: sos.sosReason?.reason || 'SOS Alert',
            timestamp: sos.timestamp,
            severity: sos.safetyScore, // Store safetyScore (0-100)
            eventType: 'sos' // Will be replaced with category when SOS categorization is implemented
        });
    });
    
    // Add incidents
    incidents.forEach(inc => {
        reasons.push({
            type: 'incident',
            title: inc.title || 'Incident',
            timestamp: inc.timestamp,
            severity: inc.severity, // 0-1
            eventType: inc.type // theft, assault, etc.
        });
    });
    
    // Sort by timestamp (most recent first) and limit to 10
    reasons.sort((a, b) => b.timestamp - a.timestamp);
    const top10Reasons = reasons.slice(0, 10);

    // --- 3. SOS Cluster Component ---
    // Count SOS alerts within 2000m radius in last 7 days (Extended from 30 mins)
    const sosHighPriority = await SOSAlert.countDocuments({
        location: {
            $geoWithin: {
                $centerSphere: [ [lng, lat], 2000 / 6378100 ] // 2000 meters in radians
            }
        },
        timestamp: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } 
    });
    
    // 3 SOS alerts = Max Risk (1.0)
    let sosScore = Math.min(sosHighPriority / 3, 1.0);


    // --- 2. Incident Component (Crowdsourced Reports) ---
    // Search larger radius (3.5km) for incidents, decays over 7 days
    // const incidents = await Incident.find({
    //     location: {
    //         $geoWithin: {
    //             $centerSphere: [ [lng, lat], 3500 / 6378100 ] // 3500 meters in radians
    //         }
    //     },
    //     timestamp: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
    // });
    
    let incidentScore = 0;
    let maxIncidentSeverity = 0; // Track the single highest severity event

    

    if (incidents.length > 0) {
        const totalImpact = incidents.reduce((acc, inc) => {
            const hoursAgo = (Date.now() - inc.timestamp) / (1000 * 60 * 60);
            
            // Track max severity for override logic later
            // We also apply time decay to this max check so old severe events fade away
            const currentSeverity = inc.severity * Math.exp(-LAMBDA * hoursAgo);
            if(currentSeverity > maxIncidentSeverity) maxIncidentSeverity = currentSeverity;

            return acc + currentSeverity;
        }, 0);
        incidentScore = Math.min(totalImpact, 1.0);
    }


    // --- 3. Historical Component ---
    let historyScore = 0;
    let gridName = null;
    
    const prevGrid = await RiskGrid.findOne({ gridId });
    if (prevGrid) {
        // Get previous score but apply time decay
        // If no new events, this will slowly drag the score down to 0
        const hoursSinceUpdate = (Date.now() - prevGrid.lastUpdated) / (1000 * 60 * 60);
        historyScore = prevGrid.riskScore * Math.exp(-0.1 * hoursSinceUpdate); 
        
        // Preserve existing name to avoid API calls
        if (prevGrid.gridName && !prevGrid.gridName.startsWith('Zone [')) {
            gridName = prevGrid.gridName;
        }
    }

    // Fetch Name from Mapbox if missing
    if (!gridName) {
        gridName = await getGridName(lat, lng);
    }

    // --- Final Calculation ---
    // Combine and clamp
    // E.g. (0.25 * incident) + (0.65 * sos) + (0.1 * history) 
    // Max sum ~1.0.
    
    let finalScore = (W_INCIDENT * incidentScore) + (W_SOS * sosScore) + (W_HISTORY * historyScore);
    
    // Extra Logic: If there is an active SOS cluster, force HIGH risk regardless of history
    if (sosHighPriority >= 3) {
        finalScore = Math.max(finalScore, 0.85); // Force Very High
    }

    // Critical Incident Override: 
    // If a single incident is very severe (e.g. Riot > 0.8), force High/Very High immediately 
    // regardless of the weighted average.
    if (maxIncidentSeverity > 0.8) {
        finalScore = Math.max(finalScore, 0.85); // Force Very High
    } else if (maxIncidentSeverity > 0.6) {
        finalScore = Math.max(finalScore, 0.65); // Force High
    }

    finalScore = Math.min(Math.max(finalScore, 0), 1);

    let level = 'Low';
    if (finalScore >= 0.8) level = 'Very High';
    else if (finalScore >= 0.6) level = 'High';
    else if (finalScore >= 0.3) level = 'Medium';

    // Save to DB with reasons
    await RiskGrid.findOneAndUpdate(
        { gridId },
        {
            location: { type: "Point", coordinates: [lng, lat] },
            riskScore: finalScore,
            riskLevel: level,
            lastUpdated: new Date(),
            reasons: top10Reasons, // Store top 10 most recent events
            gridName: gridName // Preserve or update grid name
        },
        { upsert: true, new: true }
    );
}

/**
 * Update risk score for a specific location immediately (for instant SOS feedback)
 * @param {number} lat - Latitude
 * @param {number} lng - Longitude
 * @returns {Object} Updated grid data
 */
async function updateGridForLocation(lat, lng) {
    console.log(`🎯 Updating risk grid for location: ${lat}, ${lng}`);
    
    const { gridId } = getGridIdAndCenter(lat, lng);
    await processGrid(gridId);
    
    // Return the updated grid
    const updatedGrid = await RiskGrid.findOne({ gridId });
    console.log(`✅ Grid ${gridId} updated - Risk: ${updatedGrid?.riskLevel || 'Unknown'}`);
    
    return updatedGrid;
}

module.exports = { updateRiskScores, getGridIdAndCenter, updateGridForLocation };
