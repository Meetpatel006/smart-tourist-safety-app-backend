const SOSAlert = require('../models/SOSAlertModel');
const DangerZone = require("../models/Geofence");
const { CustomError } = require('../middlewares/errorMiddleware');
const Tourist = require('../models/Tourist');
const { decrypt } = require('../utils/encrypt');
const Transition = require('../models/Transition');
const Incident = require('../models/Incident');
const RiskGrid = require('../models/RiskGrid');
const Authority = require('../models/Authority');
const jwt = require('jsonwebtoken');
const { JWT_SECRET, JWT_EXPIRES_IN} = require('../config/config')

// @desc    Get aggregated dashboard statistics
// @route   GET /api/authority/dashboard-stats
// @access  Private (authority)
exports.getDashboardStats = async (req, res, next) => {
  try {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfYesterday = new Date(startOfToday);
    startOfYesterday.setDate(startOfYesterday.getDate() - 1);

    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    
    // 1. Active Tourists & Change
    const activeTouristsCount = await Tourist.countDocuments({ expiresAt: { $gt: new Date() } });

    // Approximation for 'yesterday': Active count at start of today (end of yesterday)
    const activeYesterdayCount = await Tourist.countDocuments({
      createdAt: { $lt: startOfToday },
      expiresAt: { $gt: startOfToday }
    });

    const activeDiff = activeTouristsCount - activeYesterdayCount;
    const activePercentChange = activeYesterdayCount > 0
      ? ((activeDiff / activeYesterdayCount) * 100).toFixed(1)
      : activeDiff > 0 ? "100" : "0";

    // 2. SOS Alerts Today & Change
    const sosTodayCount = await SOSAlert.countDocuments({
      timestamp: { $gte: startOfToday }
    });

    const sosYesterdayCount = await SOSAlert.countDocuments({
      timestamp: { $gte: startOfYesterday, $lt: startOfToday }
    });

    const sosDiff = sosTodayCount - sosYesterdayCount;
    const sosChangeLabel = sosDiff >= 0 ? `+${sosDiff} from yesterday` : `${sosDiff} from yesterday`;

    // 3. High-Risk Zones
    const highRiskZonesCount = await DangerZone.countDocuments({
      riskLevel: { $in: ['High', 'Very High'] }
    });

    // 4. Resolved Cases (This Month) & Change
    const resolvedThisMonth = await SOSAlert.countDocuments({
      status: { $in: ['resolved', 'closed'] },
      timestamp: { $gte: startOfMonth }
    });

    const resolvedLastMonth = await SOSAlert.countDocuments({
      status: { $in: ['resolved', 'closed'] },
      timestamp: { $gte: startOfLastMonth, $lt: startOfMonth }
    });

    const resolvedDiff = resolvedThisMonth - resolvedLastMonth;
    const resolvedPercentChange = resolvedLastMonth > 0
      ? ((resolvedDiff / resolvedLastMonth) * 100).toFixed(1)
      : resolvedDiff > 0 ? "100" : "0";

    // 5. Recent SOS Alerts
    const recentAlertsRaw = await SOSAlert.find({ status: { $ne: 'resolved' } })
      .sort({ timestamp: -1 })
      .limit(3)
      .populate('touristId', 'nameEncrypted touristId')
      .lean();

    const recentAlerts = recentAlertsRaw.map(alert => {
      let touristName = "Unknown Name";
      let displayId = "Unknown ID";

      if (alert.touristId && typeof alert.touristId === 'object') {
        displayId = alert.touristId.touristId;
        try {
          if (alert.touristId.nameEncrypted) {
            touristName = decrypt(alert.touristId.nameEncrypted);
          }
        } catch (e) {
          console.error("Decrypt error", e);
        }
      } else {
        // Fallback if not populated (though it should be)
        displayId = alert.touristId;
      }

      return {
        id: alert._id,
        touristId: displayId,
        touristName: touristName,
        location: alert.location && alert.location.locationName ? alert.location.locationName :
          (alert.location && alert.location.coordinates ? `${alert.location.coordinates[1]}, ${alert.location.coordinates[0]}` : 'Unknown Location'),
        status: alert.status, // new, responded
        timestamp: alert.timestamp,
        reason: alert.sosReason ? alert.sosReason.reason : 'SOS Alert',
        priority: (alert.safetyScore && alert.safetyScore < 40) ? 'CRITICAL' : ((alert.safetyScore && alert.safetyScore < 70) ? 'MEDIUM' : 'LOW'),
        isNew: alert.status === 'new'
      };
    });

    // 6. Tourist Status Overview
    const touristsRaw = await Tourist.find({}).sort({ createdAt: -1 }).limit(5).lean();

    const touristOverview = touristsRaw.map((t) => {
      let name = "Unknown";
      try {
        if (t.nameEncrypted) name = decrypt(t.nameEncrypted);
      } catch (e) {
        console.error("Decrypt error", e);
      }

      const isActive = t.expiresAt && new Date(t.expiresAt) > new Date();

      return {
        id: t.touristId,
        name: name,
        safetyScore: t.safetyScore,
        status: isActive ? "ACTIVE" : "EXPIRED",
        regTxHash: t.audit ? t.audit.regTxHash : "N/A"
      };
    });


    // 7. NEW: Advanced Analytics Data (Response Time, Severity, Demographics)
    
    // a. Response Time Analysis
    const respondingAlerts = await SOSAlert.find({ 
      status: { $in: ['responding', 'resolved', 'closed'] },
      responseDate: { $exists: true } 
    }).select('timestamp responseDate').lean();

    let totalResponseTimeMs = 0;
    let responseCount = 0;
    
    respondingAlerts.forEach(a => {
      if (a.responseDate && a.timestamp) {
        const diff = new Date(a.responseDate) - new Date(a.timestamp);
        if (diff > 0) {
          totalResponseTimeMs += diff;
          responseCount++;
        }
      }
    });

    const avgResponseTimeMs = responseCount > 0 ? (totalResponseTimeMs / responseCount) : 0;
    const avgResponseTimeMinutes = Math.abs(avgResponseTimeMs / 60000).toFixed(1); // One decimal place
    const avgResponseTimeString = `${avgResponseTimeMinutes} min`;

    // b. Incident Severity Breakdown
    const incidents = await Incident.find({}).select('severity type timestamp title location').lean();
    const severityStats = { critical: 0, high: 0, medium: 0, low: 0 };
    
    incidents.forEach(inc => {
      const score = inc.severity || 0;
      if (score >= 0.8) severityStats.critical++;
      else if (score >= 0.6) severityStats.high++;
      else if (score >= 0.4) severityStats.medium++;
      else severityStats.low++;
    });

    // c. Live Incident Stream (Top 5 recent)
    const incidentStream = incidents
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, 5)
      .map(i => ({
        id: i._id,
        title: i.title,
        type: i.type,
        severity: i.severity >= 0.8 ? 'critical' : (i.severity >= 0.6 ? 'high' : 'medium'),
        time: i.timestamp,
        location: {
          lat: i.location.coordinates[1],
          lng: i.location.coordinates[0]
        }
      }));

    // d. Demographic Vulnerability (Based on all SOS alerts to find patterns)
    // We need to fetch alerts with populated tourist data
    const allAlertsForDemographics = await SOSAlert.find({})
      .populate('touristId', 'dob gender nationality role ownedGroupId groupId') // Populating unencrypted fields
      .lean();

    let ageGroups = { '18-30': 0, '30-50': 0, '50+': 0, 'Under 18': 0 };
    let soloCount = 0;
    let groupCount = 0;
    let nationalityMap = {};

    allAlertsForDemographics.forEach(a => {
      const t = a.touristId;
      if (t) {
        // Age Pattern
        if (t.dob) {
          const age = new Date().getFullYear() - new Date(t.dob).getFullYear();
          if (age < 18) ageGroups['Under 18']++;
          else if (age <= 30) ageGroups['18-30']++;
          else if (age <= 50) ageGroups['30-50']++;
          else ageGroups['50+']++;
        }

        // Solo vs Group (Check role or group links)
        if (t.role === 'solo' && !t.groupId) soloCount++;
        else groupCount++;

        // Nationality
        if (t.nationality) {
          nationalityMap[t.nationality] = (nationalityMap[t.nationality] || 0) + 1;
        }
      }
    });

    // Find top nationality
    let topNationality = 'N/A';
    let maxNatCount = 0;
    Object.keys(nationalityMap).forEach(nat => {
      if (nationalityMap[nat] > maxNatCount) {
        maxNatCount = nationalityMap[nat];
        topNationality = nat;
      }
    });
    
    // Find top age group
    let topAgeGroup = 'N/A';
    let maxAgeCount = 0;
    Object.keys(ageGroups).forEach(grp => {
      if (ageGroups[grp] > maxAgeCount) {
        maxAgeCount = ageGroups[grp];
        topAgeGroup = grp;
      }
    });

    const soloPercentage = (soloCount + groupCount) > 0 
      ? Math.round((soloCount / (soloCount + groupCount)) * 100) 
      : 0;

    // e. Unit Utilization
    // Total active units
    const totalUnits = await Authority.countDocuments({ 
      role: { $in: ['Emergency Responder', 'Police Officer'] }, 
      isActive: true 
    });

    // Engaged units (those assigned to currently open alerts)
    const openAlerts = await SOSAlert.find({ 
      status: { $in: ['new', 'responding'] } 
    }).select('assignedTo');
    
    const engagedUnitIds = new Set();
    openAlerts.forEach(alert => {
      if (alert.assignedTo && Array.isArray(alert.assignedTo)) {
        alert.assignedTo.forEach(assignment => {
          if (assignment.authorityId) engagedUnitIds.add(assignment.authorityId);
        });
      }
    });
    
    const engagedCount = engagedUnitIds.size;
    const utilizationPercent = totalUnits > 0 ? Math.round((engagedCount / totalUnits) * 100) : 0;

    // f. Generate Real-Time Predictions and Patterns based on data
    
    // Crowd Surge Prediction: Analyze tourist count trend
    const touristsLast24h = await Tourist.countDocuments({
      createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
    });
    const touristsLast48h = await Tourist.countDocuments({
      createdAt: { 
        $gte: new Date(Date.now() - 48 * 60 * 60 * 1000),
        $lt: new Date(Date.now() - 24 * 60 * 60 * 1000)
      }
    });
    
    let crowdSurgeMessage = "Stable tourist inflow expected";
    if (touristsLast24h > touristsLast48h * 1.3) {
      const increasePercent = Math.round(((touristsLast24h - touristsLast48h) / touristsLast48h) * 100);
      crowdSurgeMessage = `High (${increasePercent}% increase detected in last 24h)`;
    } else if (touristsLast24h > touristsLast48h * 1.1) {
      const increasePercent = Math.round(((touristsLast24h - touristsLast48h) / touristsLast48h) * 100);
      crowdSurgeMessage = `Moderate (${increasePercent}% increase detected)`;
    } else if (touristsLast24h < touristsLast48h * 0.8) {
      crowdSurgeMessage = "Low - Tourist activity declining";
    }

    // Risk Forecast: Based on recent incident severity and SOS trends
    const criticalIncidentsLast24h = await Incident.countDocuments({
      timestamp: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      severity: { $gte: 0.7 }
    });
    
    let riskForecastMessage = "Normal risk levels";
    if (criticalIncidentsLast24h >= 5) {
      riskForecastMessage = `Elevated - ${criticalIncidentsLast24h} critical incidents in last 24h`;
    } else if (criticalIncidentsLast24h >= 3) {
      riskForecastMessage = `Moderate - ${criticalIncidentsLast24h} critical incidents detected`;
    } else if (sosTodayCount > sosYesterdayCount * 1.5 && sosYesterdayCount > 0) {
      const increasePercent = Math.round(((sosTodayCount - sosYesterdayCount) / sosYesterdayCount) * 100);
      riskForecastMessage = `Rising - SOS alerts increased ${increasePercent}%`;
    } else if (sosTodayCount > sosYesterdayCount && sosYesterdayCount === 0) {
      riskForecastMessage = `Rising - ${sosTodayCount} new SOS alerts today`;
    }

    // Proactive Deployment: Identify high-activity zones from incidents
    const recentIncidentsByLocation = await Incident.aggregate([
      { 
        $match: { 
          timestamp: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } 
        } 
      },
      {
        $group: {
          _id: {
            lat: { $round: [{ $arrayElemAt: ["$location.coordinates", 1] }, 2] },
            lng: { $round: [{ $arrayElemAt: ["$location.coordinates", 0] }, 2] }
          },
          count: { $sum: 1 },
          avgSeverity: { $avg: "$severity" }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 1 }
    ]);

    let deploymentMessage = "No critical hotspots detected";
    if (recentIncidentsByLocation.length > 0) {
      const hotspot = recentIncidentsByLocation[0];
      if (hotspot.count >= 5) {
        deploymentMessage = `Deploy units to area (${hotspot._id.lat.toFixed(2)}°, ${hotspot._id.lng.toFixed(2)}°) - ${hotspot.count} incidents detected`;
      } else {
        deploymentMessage = `Monitor area (${hotspot._id.lat.toFixed(2)}°, ${hotspot._id.lng.toFixed(2)}°) - ${hotspot.count} incidents`;
      }
    }

    // Detect Patterns from historical data
    const patternInsights = [];

    // Pattern 1: Time-based incident analysis
    const incidentsByHour = await Incident.aggregate([
      {
        $match: {
          timestamp: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
        }
      },
      {
        $group: {
          _id: { $hour: "$timestamp" },
          count: { $sum: 1 },
          types: { $push: "$type" }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 3 }
    ]);

    if (incidentsByHour.length > 0) {
      const peakHour = incidentsByHour[0];
      const timeRange = peakHour._id >= 18 ? "evening (6 PM - midnight)" : 
                       peakHour._id >= 12 ? "afternoon (12 PM - 6 PM)" : "morning (6 AM - 12 PM)";
      patternInsights.push(`Peak incident time: ${timeRange} with ${peakHour.count} incidents`);
    }

    // Pattern 2: Type-based pattern
    const incidentsByType = await Incident.aggregate([
      {
        $match: {
          timestamp: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
        }
      },
      {
        $group: {
          _id: "$type",
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 2 }
    ]);

    if (incidentsByType.length > 0) {
      const topType = incidentsByType[0];
      patternInsights.push(`Most common incident: ${topType._id} (${topType.count} cases in 30 days)`);
    }

    // Pattern 3: High-risk zone pattern
    const highRiskZones = await DangerZone.find({ 
      riskLevel: { $in: ['High', 'Very High'] } 
    }).limit(2).lean();

    if (highRiskZones.length > 0) {
      const zoneNames = highRiskZones.map(z => z.name).join(', ');
      patternInsights.push(`Active high-risk zones: ${zoneNames}`);
    }

    // Pattern 4: Response efficiency
    if (avgResponseTimeMinutes > 15) {
      patternInsights.push(`Response time exceeds SLA target by ${(avgResponseTimeMinutes - 15).toFixed(1)} minutes`);
    } else if (responseCount > 0) {
      patternInsights.push(`Response time within SLA: avg ${avgResponseTimeMinutes} min`);
    }

    // Convert patterns array to object format expected by frontend
    const patternsObject = {};
    patternInsights.forEach((insight, idx) => {
      patternsObject[`insight${idx + 1}`] = insight;
    });

    res.status(200).json({
      success: true,
      data: {
        activeTourists: {
          count: activeTouristsCount,
          change: `${activePercentChange >= 0 ? '+' : ''}${activePercentChange}% from yesterday`
        },
        sosAlertsToday: {
          count: sosTodayCount,
          change: sosChangeLabel
        },
        highRiskZones: {
          count: highRiskZonesCount
        },
        resolvedCases: {
          count: resolvedThisMonth,
          change: `${resolvedPercentChange >= 0 ? '+' : ''}${resolvedPercentChange}% from last month`
        },
        recentAlerts,
        touristOverview,
        
        // Advanced Analytics Merged Data
        analytics: {
          responseAnalysis: {
            avgTime: avgResponseTimeString,
            avgTimeMinutes: parseFloat(avgResponseTimeMinutes),
            samples: respondingAlerts
              .slice(0, 50)
              .map(a => parseFloat(((new Date(a.responseDate) - new Date(a.timestamp)) / 1000).toFixed(2))) // seconds
          },
          unitUtilization: {
            percent: utilizationPercent,
            engaged: engagedCount,
            total: totalUnits,
            label: `${utilizationPercent}% units engaged`
          },
          incidentAnalysis: {
            severityBreakdown: severityStats,
            recentStream: incidentStream
          },
          demographics: {
            mostSosFromAge: topAgeGroup,
            soloTravelersPercent: `${soloPercentage}%`,
            topGroup: topNationality
          },
          predictions: {
            crowdSurge: crowdSurgeMessage,
            riskForecast: riskForecastMessage,
            proactiveDeployment: deploymentMessage
          },
          patterns: patternsObject
        }
      }
    });

  } catch (err) {
    console.error("❌ getDashboardStats error:", err);
    next(err);
  }
};


// @desc    Get tourist management dashboard data (Counts + Registry)
// @route   GET /api/authority/tourist-management
// @access  Private (authority)
exports.getTouristManagementData = async (req, res, next) => {
  try {
    const { status, search } = req.query; // Optional filters

    // 1. Calculate Summary Stats
    const totalTourists = await Tourist.countDocuments();
    const activeTourists = await Tourist.countDocuments({ expiresAt: { $gt: new Date() } });
    const expiredTourists = await Tourist.countDocuments({ expiresAt: { $lte: new Date() } });

    // Average Safety Score
    const avgScoreResult = await Tourist.aggregate([
      { $group: { _id: null, avg: { $avg: "$safetyScore" } } }
    ]);
    const averageSafetyScore = avgScoreResult.length > 0 ? Math.round(avgScoreResult[0].avg) : 0;

    // 2. Fetch Tourist Registry List
    // Note: Search by name is limited due to encryption. We can search by ID directly.
    let query = {};
    if (status === 'active') {
      query.expiresAt = { $gt: new Date() };
    } else if (status === 'expired') {
      query.expiresAt = { $lte: new Date() };
    }

    if (search) {
      // Simple search on touristId (which is plaintext)
      query.touristId = { $regex: search, $options: 'i' };
    }

    const touristsRaw = await Tourist.find(query).sort({ createdAt: -1 });

    const touristRegistry = touristsRaw.map(t => {
      let name = "Unknown";
      let phone = "Unknown";
      try {
        if (t.nameEncrypted) name = decrypt(t.nameEncrypted);
        if (t.phoneEncrypted) phone = decrypt(t.phoneEncrypted);
      } catch (e) {
        console.error(`Decrypt error for tourist ${t.touristId}:`, e.message);
      }

      const isActive = t.expiresAt && new Date(t.expiresAt) > new Date();

      return {
        id: t._id,
        touristId: t.touristId,
        name: name,
        phone: phone,
        country: "India",
        tripStart: t.createdAt,
        tripEnd: t.expiresAt,
        safetyScore: t.safetyScore,
        status: isActive ? "ACTIVE" : "EXPIRED",
        regTxHash: t.audit ? t.audit.regTxHash : "N/A"
      };
    });

    // If search parameter was provided and didn't match ID, let's try filtering by decrypted Name
    let filteredRegistry = touristRegistry;
    if (search && !query.touristId) {
      const searchLower = search.toLowerCase();
      filteredRegistry = touristRegistry.filter(t =>
        t.name.toLowerCase().includes(searchLower) ||
        t.touristId.toLowerCase().includes(searchLower)
      );
    }


    res.status(200).json({
      success: true,
      data: {
        totalTourists,
        activeIDs: activeTourists,
        expiredIDs: expiredTourists,
        averageSafetyScore,
        registry: filteredRegistry
      }
    });

  } catch (err) {
    console.error("❌ getTouristManagementData error:", err);
    next(err);
  }
};

// @desc    Revoke and delete a tourist ID
// @route   DELETE /api/authority/revoke/:id
// @access  Private (authority)
exports.revokeTourist = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({ success: false, message: "Reason for revocation is required" });
    }

    // "if reason is either convicted to misbehave / status expired then only delete"
    const normalizedReason = reason.toLowerCase();
    const validReason =
      normalizedReason.includes('misbehave') ||
      normalizedReason.includes('convicted') ||
      normalizedReason.includes('expired') ||
      normalizedReason.includes('complete');

    if (!validReason) {
      return res.status(400).json({
        success: false,
        message: "Action denied. Valid reasons: 'Convicted/Misbehavior' or 'Status Expired/Trip Completed'."
      });
    }

    const tourist = await Tourist.findById(id);

    if (!tourist) {
      return res.status(404).json({ success: false, message: "Tourist not found" });
    }

    await Tourist.findByIdAndDelete(id);

    res.status(200).json({
      success: true,
      message: `Tourist ${tourist.touristId} has been revoked and removed.`
    });

  } catch (err) {
    console.error("❌ revokeTourist error:", err);
    next(err);
  }
};


// @desc    Get real-time map data (Tourists, Zones, Alerts, Incidents)
// @route   GET /api/authority/map-overview
// @access  Private (authority)
exports.getMapOverview = async (req, res, next) => {
  try {
    // 1. Fetch Aggregated stats for the panel
    const totalTourists = await Tourist.countDocuments();
    const activeAlertsCount = await SOSAlert.countDocuments({ status: { $in: ['new', 'responding'] } });
    const highRiskZonesCount = await DangerZone.countDocuments({ riskLevel: { $in: ['High', 'Very High'] } });
    const responseUnitsCount = await Authority.countDocuments({ role: { $in: ['Emergency Responder', 'Police Officer'] }, isActive: true });

    // 2. Fetch Tourists with their latest location
    // We get the latest transition for each tourist to pinpoint them on the map
    const latestTransitions = await Transition.aggregate([
      { $sort: { timestamp: -1 } },
      {
        $group: {
          _id: "$digitalId",
          location: { $first: "$location" },
          timestamp: { $first: "$timestamp" }
        }
      }
    ]);

    // Create a map for quick lookup of location by touristId
    const locMap = {};
    latestTransitions.forEach(t => {
      locMap[t._id] = t.location; // { latitude, longitude }
    });

    const touristsRaw = await Tourist.find({}).select('touristId nameEncrypted safetyScore expiresAt').lean();

    const tourists = touristsRaw.map(t => {
      const loc = locMap[t.touristId];
      let name = "Unknown";
      try {
        if (t.nameEncrypted) name = decrypt(t.nameEncrypted);
      } catch (e) { }

      const isActive = t.expiresAt && new Date(t.expiresAt) > new Date();

      // Let's exclude tourists with no location history for the map view.
      if (!loc) return null;

      return {
        id: t.touristId,
        name: name,
        status: isActive ? 'active' : 'expired',
        safetyScore: t.safetyScore,
        location: {
          lat: loc.latitude,
          lng: loc.longitude
        },
        type: 'tourist'
      };
    }).filter(t => t !== null);


    // 3. Fetch Danger Zones
    const zonesRaw = await DangerZone.find({}).lean();
    const zones = zonesRaw.map(z => ({
      id: z.id,
      name: z.name,
      riskLevel: z.riskLevel,
      type: 'zone',
      shape: z.type, // 'circle' or 'polygon'
      coordinates: z.coords, // [lat, lng]
      radius: z.radiusKm ? z.radiusKm * 1000 : 0 // Convert to meters for map
    }));

    // 4. Fetch Active SOS Alerts
    const alertsRaw = await SOSAlert.find({ status: { $in: ['new', 'responding'] } }).populate('touristId', 'touristId').lean();
    const activeAlerts = alertsRaw.map(a => {
      // SOSAlert uses GeoJSON [lng, lat]
      const lat = a.location.coordinates[1];
      const lng = a.location.coordinates[0];
      return {
        id: a._id,
        type: 'alert',
        status: a.status,
        priority: a.safetyScore < 50 ? 'high' : 'medium',
        location: { lat, lng },
        locationName: a.location.locationName || "Unknown Location"
      };
    });

    // 5. Fetch Risk Grids (Heatmap points)
    const riskGridRaw = await RiskGrid.find({ riskScore: { $gt: 0 } }).lean();
    const riskGrids = riskGridRaw.map(r => ({
      location: {
        lat: r.location.coordinates[1],
        lng: r.location.coordinates[0]
      },
      intensity: r.riskScore // 0 to 1
    }));

    // 6. Fetch Incidents
    const incidentsRaw = await Incident.find({}).sort({ timestamp: -1 }).limit(50).lean();
    const incidents = incidentsRaw.map(i => ({
      id: i._id,
      title: i.title,
      type: 'incident',
      category: i.type,
      location: {
        lat: i.location.coordinates[1],
        lng: i.location.coordinates[0]
      }
    }));


    res.status(200).json({
      success: true,
      stats: {
        totalTourists,
        activeAlerts: activeAlertsCount,
        highRiskZones: highRiskZonesCount,
        responseUnits: responseUnitsCount
      },
      mapData: {
        tourists,
        zones,
        activeAlerts,
        riskGrids,
        incidents
      }
    });

  } catch (err) {
    console.error("❌ getMapOverview error:", err);
    next(err);
  }
};

exports.signUp = async (req, res, next) => {
  try {
    const { username, fullName, email, password, role, authorityId } = req.body;

    if (!username || !fullName || !email || !password || !role) {
      return res.status(400).json({ message: "All fields are required" });
    }

    // Validate role
    const allowedRoles = ["Police Officer", "Tourism Officer", "Emergency Responder", "System Administrator"];
    if (!allowedRoles.includes(role)) {
      return res.status(400).json({ message: "Invalid role" });
    }

    // If Police Officer, policeId is required
    // if (role === "Police Officer" && !authorityId) {
    //   return res.status(400).json({ message: "Police ID is required for Police Officer" });
    // }

    const existingUser = await Authority.findOne({ $or: [{ username }, { email }] });
    if (existingUser) {
      return res.status(400).json({ message: "Username or email already exists" });
    }

    const newUser = new Authority({ username, fullName, email, password, role, authorityId });
    await newUser.save();

    res.status(201).json({
      message: "Signup successful. Please login to continue.",
      user: { username, fullName, email, role, authorityId }
    });

  } catch (error) {
    console.error(error);
    next(error);
  }
};

exports.signIn = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    // Find user by email
    const user = await Authority.findOne({ email });

    if (!user) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    // Check password
    const isMatch = await user.comparePassword(password);

    if (!isMatch) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    // Generate JWT
    const token = jwt.sign(
      { id: user._id, role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    res.json({
      message: "Login successful",
      token,
      user: {
        username: user.username,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
        authorityId: user.authorityId || null
      }
    });

  } catch (error) {
    console.error(error);
    next(error);
  }
}

exports.verify = async (req, res, next) => {
  try {
    const user = await Authority.findById(req.user.id).select('-password');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    return res.json({
      success: true,
      user: {
        id: user._id,
        username: user.username,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
        authorityId: user.authorityId || null,
        isActive: user.isActive
      }
    });
  } catch (error) {
    console.error('Get /me error:', error);
    next(error);
  }
}

exports.logOut = async (req, res, next) => {
  res.clearCookie('auth_token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict'
  });

  return res.json({
    success: true,
    message: 'Logged out successfully'
  });
}

// @desc    Get all open SOS alerts
// @route   GET /api/authority/alerts
// @access  Private (authority)
exports.getNewSosAlerts = async (req, res, next) => {
  try {
    // Fetch all SOS alerts with status 'new', sorted by latest timestamp first
    const alertsRaw = await SOSAlert.find({ status: 'new' })
      .sort({ timestamp: -1 })
      .populate('touristId') // Populate the full tourist document
      .lean();

    // Transform each alert to include complete tourist profile details
    const alerts = await Promise.all(alertsRaw.map(async (sosAlert) => {
      let touristData = {
        touristId: null,
        touristName: 'Unknown',
        phone: null,
        age: null,
        nationality: null,
        gender: null,
        bloodGroup: null,
        medicalConditions: null,
        allergies: null,
        emergencyContact: null,
      };

      // If tourist data is populated, decrypt and extract details
      if (sosAlert.touristId && typeof sosAlert.touristId === 'object') {
        const tourist = sosAlert.touristId;
        
        try {
          // Decrypt personal information
          touristData.touristId = tourist.touristId;
          touristData.touristName = tourist.nameEncrypted ? decrypt(tourist.nameEncrypted) : 'Unknown';
          touristData.phone = tourist.phoneEncrypted ? decrypt(tourist.phoneEncrypted) : null;

          // Calculate age from DOB if available
          if (tourist.dob) {
            const today = new Date();
            const birthDate = new Date(tourist.dob);
            let age = today.getFullYear() - birthDate.getFullYear();
            const monthDiff = today.getMonth() - birthDate.getMonth();
            if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
              age--;
            }
            touristData.age = age;
          }

          // Extract other profile fields
          touristData.nationality = tourist.nationality || null;
          touristData.gender = tourist.gender || null;
          touristData.bloodGroup = tourist.bloodGroup || null;
          touristData.medicalConditions = tourist.medicalConditions || null;
          touristData.allergies = tourist.allergies || null;

          // Decrypt emergency contact if available
          if (tourist.emergencyContactEncrypted) {
            touristData.emergencyContact = JSON.parse(decrypt(tourist.emergencyContactEncrypted));
          }
        } catch (decryptErr) {
          console.error('Error decrypting tourist data:', decryptErr);
        }
      }

      // Return alert in the same structure as real-time emit
      return {
        alertId: sosAlert._id,
        touristId: touristData.touristId,
        touristName: touristData.touristName,
        phone: touristData.phone,
        age: touristData.age,
        nationality: touristData.nationality,
        gender: touristData.gender,
        bloodGroup: touristData.bloodGroup,
        medicalConditions: touristData.medicalConditions,
        allergies: touristData.allergies,
        emergencyContact: touristData.emergencyContact,
        location: sosAlert.location,
        locationName: sosAlert.locationName,
        timestamp: sosAlert.timestamp,
        safetyScore: sosAlert.safetyScore,
        sosReason: sosAlert.sosReason,
        status: sosAlert.status
      };
    }));

    res.status(200).json({
      success: true,
      count: alerts.length,
      alerts
    });
  } catch (err) {
    console.error("❌ getNewSosAlerts error:", err);
    next(err);
  }
};

// @desc    Get all responding SOS alerts
// @route   GET /api/authority/alerts/responding
// @access  Private (authority)
exports.getRespondingSosAlerts = async (req, res, next) => {
  try {
    // Fetch all SOS alerts with status 'responding', sorted by latest timestamp first
    const alertsRaw = await SOSAlert.find({ status: 'responding' })
      .sort({ timestamp: -1 })
      .populate('touristId') // still populate tourist
      .lean();

    // Transform each alert to include complete tourist profile details
    const alerts = await Promise.all(alertsRaw.map(async (sosAlert) => {
      let touristData = {
        touristId: null,
        touristName: 'Unknown',
        phone: null,
        age: null,
        nationality: null,
        gender: null,
        bloodGroup: null,
        medicalConditions: null,
        allergies: null,
        emergencyContact: null,
        govId: null
      };

      // If tourist data is populated, decrypt and extract details
      if (sosAlert.touristId && typeof sosAlert.touristId === 'object') {
        const tourist = sosAlert.touristId;
        
        try {
          // Decrypt personal information
          touristData.touristId = tourist.touristId;
          touristData.touristName = tourist.nameEncrypted ? decrypt(tourist.nameEncrypted) : 'Unknown';
          touristData.phone = tourist.phoneEncrypted ? decrypt(tourist.phoneEncrypted) : null;

          // Calculate age from DOB if available
          if (tourist.dob) {
            const today = new Date();
            const birthDate = new Date(tourist.dob);
            let age = today.getFullYear() - birthDate.getFullYear();
            const monthDiff = today.getMonth() - birthDate.getMonth();
            if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
              age--;
            }
            touristData.age = age;
          }

          // Extract other profile fields
          touristData.nationality = tourist.nationality || null;
          touristData.gender = tourist.gender || null;
          touristData.bloodGroup = tourist.bloodGroup || null;
          touristData.medicalConditions = tourist.medicalConditions || null;
          touristData.allergies = tourist.allergies || null;

          // If raw govId is stored encrypted, decrypt and include it (use with caution)
          if (tourist.govIdEncrypted) {
            try {
              touristData.govId = decrypt(tourist.govIdEncrypted);
            } catch (e) {
              console.error('Error decrypting govIdEncrypted:', e);
              touristData.govId = null;
            }
          }

          // Decrypt emergency contact if available
          if (tourist.emergencyContactEncrypted) {
            touristData.emergencyContact = JSON.parse(decrypt(tourist.emergencyContactEncrypted));
          }
        } catch (decryptErr) {
          console.error('Error decrypting tourist data:', decryptErr);
        }
      }

      // Return alert in the same structure as real-time emit
      // Normalize assignedTo to ensure consistent output: array of { authorityId, fullName, role }
      const assigned = (sosAlert.assignedTo || []).map(a => {
        if (!a) return null;
        if (typeof a === 'string') return { authorityId: a, fullName: null };
        // already an object with authorityId/fullName
        return { authorityId: a.authorityId || null, fullName: a.fullName || null, role: a.role || null };
      }).filter(x => x !== null);

      return {
        alertId: sosAlert._id,
        touristId: touristData.touristId,
        touristName: touristData.touristName,
        govId: touristData.govId || null,
        phone: touristData.phone,
        age: touristData.age,
        nationality: touristData.nationality,
        gender: touristData.gender,
        bloodGroup: touristData.bloodGroup,
        medicalConditions: touristData.medicalConditions,
        allergies: touristData.allergies,
        emergencyContact: touristData.emergencyContact,
        location: sosAlert.location,
        locationName: sosAlert.locationName,
        timestamp: sosAlert.timestamp,
        safetyScore: sosAlert.safetyScore,
        sosReason: sosAlert.sosReason,
        status: sosAlert.status,
        responseDate: sosAlert.responseDate,
        responseTime: sosAlert.responseTime,
        assignedTo: assigned
      };
    }));

    res.status(200).json({
      success: true,
      count: alerts.length,
      alerts
    });
  } catch (err) {
    console.error("❌ getRespondingSosAlerts error:", err);
    next(err);
  }
};

exports.getSosCounts = async (req, res, next) => {
  try {
    const newCount = await SOSAlert.countDocuments({ status: "new" });

    res.status(200).json({
      success: true,
      new: newCount,
    });
  } catch (err) {
    next(err);
  }
};
// @desc    Assign an authority unit to an SOS alert
// @route   PUT /api/authority/alerts/:id/assign
// @access  Private (authority)
exports.assignUnitToAlert = async (req, res, next) => {
  try {
    const { id } = req.params;
    // user.id or user._id depending on how it's stored in token. Usually user.id from decoded token.
    const authorityObjectId = req.user.id || req.user._id;

    const alert = await SOSAlert.findById(id);

    if (!alert) {
      return res.status(404).json({ success: false, message: "SOS Alert not found" });
    }

    // Resolve current authority record
    const authority = await Authority.findById(authorityObjectId).select('authorityId fullName role');
    if (!authority) {
      return res.status(404).json({ success: false, message: 'Assigning authority not found' });
    }

    // Note: allow same authority to be assigned to multiple alerts; do not block duplicates here.

    // Update alert: Add authority info object to assignedTo, change status to 'responding' if it was 'new'
    if (!alert.assignedTo) alert.assignedTo = [];
    alert.assignedTo.push({ authorityId: authority.authorityId, fullName: authority.fullName, role: authority.role });

    // Save response time if provided
    if (req.body.responseTime) {
      console.log(req.body.responseTime)
      alert.responseTime = req.body.responseTime;
    }

    if (alert.status === 'new' || alert.status === 'acknowledged') {
      alert.status = 'responding';
      // Set response timestamp if not already set
      if (!alert.responseDate) {
        alert.responseDate = new Date();
      }
    }

    await alert.save();
    
    // Construct real-time payload
    const alertData = {
      alertId: alert._id,
      status: alert.status,
      assignedTo: alert.assignedTo,
      responseDate: alert.responseDate,
      responseTime: alert.responseTime // if set
    };
    
    // Emit real-time update
    const realtimeService = require('../services/realtimeService');
    realtimeService.emitSOSStatusUpdate(alertData).catch(err => console.error("Socket emit error:", err));

    res.status(200).json({
      success: true,
      message: "Unit assigned successfully",
      data: alert
    });

  } catch (err) {
    console.error("❌ assignUnitToAlert error:", err);
    next(err);
  }
};

// @desc    Mark SOS alert as resolved
// @route   PUT /api/authority/alerts/:id/resolve
// @access  Private (authority)
exports.resolveAlert = async (req, res, next) => {
  try {
    const { id } = req.params;
    const alert = await SOSAlert.findById(id);

    if (!alert) {
      return res.status(404).json({ success: false, message: "SOS Alert not found" });
    }

    alert.status = "resolved";
    alert.resolvedDate = new Date();
    
    // Optionally calculate total resolution time here if useful
    // const durationMs = alert.resolvedDate - alert.timestamp;

    await alert.save();

    // Emit real-time update for resolution
    const realtimeService = require('../services/realtimeService');
    realtimeService.emitSOSStatusUpdate({
      alertId: alert._id,
      status: "resolved",
      resolvedDate: alert.resolvedDate
    }).catch(err => console.error("Socket emit error:", err));

    res.status(200).json({
      success: true,
      message: "Alert resolved successfully",
      data: alert
    });
  } catch (err) {
    console.error("❌ resolveAlert error:", err);
    next(err);
  }
};




