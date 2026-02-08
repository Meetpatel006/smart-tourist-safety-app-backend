const RiskGrid = require('../models/RiskGrid');
const Incident = require('../models/Incident');
const SOSAlert = require('../models/SOSAlertModel');
const { getGridName } = require('../utils/mapboxClient');

// Constants
const GRID_SIZE_DEG = 0.0045; // Approx 500m
// Lambda will be calculated dynamically based on tier duration

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

    // 1. Identify all grids that need updates (activity within 30 days)
    const activeGridIds = new Set();
    const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
    const windowStart = new Date(Date.now() - LOOKBACK_MS);
    
    // A. Grids with recent SOS alerts (last 30 days)
    const recentSOS = await SOSAlert.find({ 
        timestamp: { $gte: windowStart } 
    });
    recentSOS.forEach(alert => {
        if(alert.location && alert.location.coordinates) {
            const { gridId } = getGridIdAndCenter(alert.location.coordinates[1], alert.location.coordinates[0]);
            activeGridIds.add(gridId);
        }
    });

    // B. Grids with recent Incidents (last 30 days)
    const recentIncidents = await Incident.find({
        timestamp: { $gte: windowStart }
    });
    recentIncidents.forEach(inc => {
        if(inc.location && inc.location.coordinates) {
            const { gridId } = getGridIdAndCenter(inc.location.coordinates[1], inc.location.coordinates[0]);
            activeGridIds.add(gridId);
        }
    });
    
    // C. Existing grids
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
    
    // Always scan 30 days back to catch high-severity history
    const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
    const windowStart = new Date(Date.now() - LOOKBACK_MS);

    // --- 1. Fetch Data (Maximum Scan Radius: 2.5km) ---
    // We scan the maximum possible influence area (Critical Tier = 2.5km)
    
    const sosAlerts = await SOSAlert.find({
        location: { $geoWithin: { $centerSphere: [ [lng, lat], 2500 / 6378100 ] } },
        timestamp: { $gte: windowStart }
    }).lean();

    const incidents = await Incident.find({
        location: { $geoWithin: { $centerSphere: [ [lng, lat], 2500 / 6378100 ] } },
        timestamp: { $gte: windowStart }
    }).lean();

    // --- 2. Analyze Intensity Metrics ---
    
    let maxIncidentSeverity = 0;
    let minSosSafetyScore = 100;
    let latestEventTime = 0;
    
    // Process SOS
    sosAlerts.forEach(a => {
        const time = new Date(a.timestamp).getTime();
        if (time > latestEventTime) latestEventTime = time;
        if (a.safetyScore !== undefined && a.safetyScore < minSosSafetyScore) {
            minSosSafetyScore = a.safetyScore;
        }
    });

    // Process Incidents
    incidents.forEach(i => {
        const time = new Date(i.timestamp).getTime();
        if (time > latestEventTime) latestEventTime = time;
        if (i.severity > maxIncidentSeverity) maxIncidentSeverity = i.severity;
    });

    const combinedCount = sosAlerts.length + incidents.length;

    // --- 3. Determine Tier & Expiry ---
    
    let tier = 'Standard';
    let durationDays = 7;
    let displayRadius = 500; // meters

    // Logic: Active SOS cluster (>5) or Major Riot/Terror (>0.8) or Very Low Safety (<=30)
    if (combinedCount > 5 || maxIncidentSeverity >= 0.8 || minSosSafetyScore <= 30) {
        tier = 'Critical';
        durationDays = 30;
        displayRadius = 1500;
    } 
    // Logic: Moderate Cluster (>2) or High Severity (>0.6) or Low Safety (<=50)
    else if (combinedCount > 2 || maxIncidentSeverity >= 0.6 || minSosSafetyScore <= 50) {
        tier = 'High';
        durationDays = 14;
        displayRadius = 1000;
    }

    // Default is Standard (7 days, 500m)

    // Calculate Expiry
    // If no events found, latestEventTime is 0, so expiresAt is past (correct)
    const expiresAt = new Date(latestEventTime + (durationDays * 24 * 60 * 60 * 1000));
    
    // Check if Expired
    if (Date.now() > expiresAt.getTime()) {
        // Expired -> Delete Grid from Database to cleanup
        console.log(`Grid ${gridId} expired (Tier: ${tier}). Deleting.`);
        
        await RiskGrid.deleteOne({ gridId });
        return;
    }

    // --- 4. Calculate Risk Score (with Dynamic Decay) ---
    
    // Dynamic Lambda based on Tier duration
    // Formula: We want ~10% remaining at 'durationDays'.
    // lambda = -ln(0.1) / (days * 24) = 2.3 / (days * 24)
    
    const lambda = 2.3 / (durationDays * 24);

    let sosScore = 0;
    if (sosAlerts.length > 0) {
        const SOS_BASE_WEIGHT = 0.34;
        const totalSosImpact = sosAlerts.reduce((acc, alert) => {
            const hoursAgo = (Date.now() - alert.timestamp) / (1000 * 60 * 60);
            return acc + (SOS_BASE_WEIGHT * Math.exp(-lambda * hoursAgo));
        }, 0);
        sosScore = Math.min(totalSosImpact, 1.0);
    }

    let incidentScore = 0;
    if (incidents.length > 0) {
        const totalImpact = incidents.reduce((acc, inc) => {
            const hoursAgo = (Date.now() - inc.timestamp) / (1000 * 60 * 60);
            const currentSeverity = (inc.severity || 0.5) * Math.exp(-lambda * hoursAgo);
            return acc + currentSeverity;
        }, 0);
        incidentScore = Math.min(totalImpact, 1.0);
    }

    // History (Self-Referential Decay)
    let historyScore = 0;
    let gridName = null;
    const prevGrid = await RiskGrid.findOne({ gridId });
    if (prevGrid) {
        const hoursSinceUpdate = (Date.now() - prevGrid.lastUpdated) / (1000 * 60 * 60);
        historyScore = prevGrid.riskScore * Math.exp(-lambda * hoursSinceUpdate);
        if (prevGrid.gridName && !prevGrid.gridName.startsWith('Zone [')) {
            gridName = prevGrid.gridName;
        }
    }
    
    if (!gridName) {
        gridName = await getGridName(lat, lng);
    }

    // Weighted Sum
    let finalScore = (W_INCIDENT * incidentScore) + (W_SOS * sosScore) + (W_HISTORY * historyScore);

    // Force High Risk if Active Critical Tier
    if (tier === 'Critical') {
        finalScore = Math.max(finalScore, 0.6); // Floor at High Risk until expiry nears
    } else if (tier === 'High') {
        finalScore = Math.max(finalScore, 0.4); // Floor at Medium Risk
    }

    finalScore = Math.min(Math.max(finalScore, 0), 1);

    let level = 'Low';
    if (finalScore >= 0.8) level = 'Very High';
    else if (finalScore >= 0.6) level = 'High';
    else if (finalScore >= 0.3) level = 'Medium';


    // --- 5. Build Reasons ---
    const reasons = [];
    sosAlerts.forEach(sos => reasons.push({
        type: 'sos_alert',
        title: sos.sosReason?.reason || 'SOS Alert',
        timestamp: sos.timestamp,
        severity: sos.safetyScore || 1.0, 
        eventType: 'sos'
    }));
    incidents.forEach(inc => reasons.push({
        type: 'incident',
        title: inc.title || 'Incident',
        timestamp: inc.timestamp,
        severity: inc.severity,
        eventType: inc.type
    }));
    
    reasons.sort((a, b) => b.timestamp - a.timestamp);
    const topReasons = reasons.slice(0, 10);

    // Save
    await RiskGrid.findOneAndUpdate(
        { gridId },
        {
            location: { type: "Point", coordinates: [lng, lat] },
            riskScore: finalScore,
            riskLevel: level,
            tierLevel: tier,
            radius: displayRadius,
            expiresAt: expiresAt,
            lastUpdated: new Date(),
            gridName: gridName,
            reasons: topReasons
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
