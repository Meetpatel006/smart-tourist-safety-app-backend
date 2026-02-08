const socketio = require('socket.io');
const fallbackService = require('./fallbackService');
const blockchainService = require('./blockchainService');
const { calculateSafetyScore, shouldNotifyScoreChange } = require('./safetyScoreService');

let io; // This will hold the Socket.IO server instance
let authoritySockets = new Map(); // Map to store connected authorities
let touristSockets = new Map(); // Map to store connected tourists
let touristLastScores = new Map(); // Store last safety score for each tourist
const SAFETY_POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
let safetyPollTimer = null;

/**
 * Initializes the Socket.IO server and attaches it to the HTTP server.
 * @param {object} httpServer The Node.js HTTP server instance.
 */
exports.init = (httpServer) => {
  io = socketio(httpServer, {
    cors: {
      origin: true, // Allow all origins dynamically for production
      methods: ["GET", "POST"],
      credentials: true
    }
  });

  // Start periodic safety score polling (every 30 minutes) using last known locations
  if (!safetyPollTimer) {
    safetyPollTimer = setInterval(runPeriodicSafetyScoreUpdate, SAFETY_POLL_INTERVAL_MS);
  }

  io.on('connection', (socket) => {
    console.log(`New client connected: ${socket.id}`);

    // Store the socket if it's an authority, based on a handshake payload
    socket.on('registerAuthority', (data) => {
      if (data && data.role === 'authority' && data.userId) {
        const userId = data.userId;

        // Attach userId to the socket for easy cleanup on disconnect
        socket.data = socket.data || {};
        socket.data.userId = userId;
        socket.data.userType = 'authority';

        // Add socket to the set for this userId (allow multiple sockets per authority)
        let set = authoritySockets.get(userId);
        if (!set) {
          set = new Set();
          authoritySockets.set(userId, set);
        }
        set.add(socket);

        // Join a global 'authorities' room and a per-user room
        socket.join('authorities');
        socket.join(`authority:${userId}`);

        console.log(`Authority ${userId} registered with socket ${socket.id} (sockets for user: ${set.size})`);
      }
    });

    // Store the socket if it's a tourist, based on a handshake payload
    socket.on('registerTourist', async (data) => {
      if (data && data.role === 'tourist' && data.touristId) {
        const touristId = data.touristId;
        const location = data.location; // { lat, lng }

        // Attach touristId to the socket for easy cleanup on disconnect
        socket.data = socket.data || {};
        socket.data.touristId = touristId;
        socket.data.userType = 'tourist';
        socket.data.location = location; // Store current location

        // Add socket to the set for this touristId (allow multiple devices per tourist)
        let set = touristSockets.get(touristId);
        if (!set) {
          set = new Set();
          touristSockets.set(touristId, set);
        }
        set.add(socket);

        // Join a global 'tourists' room and a per-user room
        socket.join('tourists');
        socket.join(`tourist:${touristId}`);

        console.log(`Tourist ${touristId} registered with socket ${socket.id} (sockets for user: ${set.size})`);

        // Calculate initial safety score
        if (location && location.lat && location.lng) {
          try {
            const safetyScoreData = await calculateSafetyScore(location.lat, location.lng);

            // Store initial score
            touristLastScores.set(touristId, safetyScoreData.safetyScore);

            // Send safety score to tourist
            socket.emit('safetyScoreUpdate', safetyScoreData);
            console.log(`📡 safetyScoreUpdate emitted (register) to ${touristId}: ${safetyScoreData.safetyScore}/100`);
          } catch (error) {
            console.error(`Failed to calculate initial safety score for ${touristId}:`, error);
          }
        }

        // Send confirmation
        socket.emit('registrationConfirmed', {
          success: true,
          touristId: touristId,
          message: 'You are now connected to receive real-time safety alerts'
        });
      }
    });

    // Update tourist location in real-time
    socket.on('updateTouristLocation', async (data) => {
      if (socket.data && socket.data.userType === 'tourist' && data.location) {
        const touristId = socket.data.touristId;
        const newLocation = data.location;

        socket.data.location = newLocation;
        console.log(`Tourist ${touristId} location updated: ${newLocation.lat}, ${newLocation.lng}`);

        // Calculate new safety score
        try {
          const safetyScoreData = await calculateSafetyScore(newLocation.lat, newLocation.lng);

          // Get previous score
          const previousScore = touristLastScores.get(touristId) || 80;
          const newScore = safetyScoreData.safetyScore;

          // Update stored score
          touristLastScores.set(touristId, newScore);

          // Send updated safety score to tourist
          socket.emit('safetyScoreUpdate', safetyScoreData);
          console.log(`📡 safetyScoreUpdate emitted (location update) to ${touristId}: ${newScore}/100`);

          // Check if we should send a notification about score change
          const notification = shouldNotifyScoreChange(previousScore, newScore);
          if (notification) {
            socket.emit('safetyScoreAlert', {
              ...notification,
              previousScore,
              newScore,
              safetyScoreData
            });
            console.log(`⚠️ Safety score alert sent to ${touristId}: ${previousScore} → ${newScore}`);
          }

          console.log(`Safety score updated for ${touristId}: ${newScore}/100 (${safetyScoreData.safetyLevel})`);
        } catch (error) {
          console.error(`Failed to calculate safety score for ${touristId}:`, error);
        }
      }
    });

    // Authority broadcasts alert to tourists
    socket.on('authorityBroadcast', async (data) => {
      if (socket.data && socket.data.userType === 'authority') {
        try {
          await exports.emitAuthorityAlertToTourists(data);
        } catch (err) {
          console.error('Failed to broadcast authority alert:', err);
          socket.emit('broadcastError', { success: false, message: err.message });
        }
      } else {
        socket.emit('broadcastError', { success: false, message: 'Unauthorized: Only authorities can broadcast alerts' });
      }
    });

    socket.on('disconnect', () => {
      const uid = socket.data && socket.data.userId;
      const tid = socket.data && socket.data.touristId;
      const userType = socket.data && socket.data.userType;

      if (userType === 'authority' && uid) {
        const set = authoritySockets.get(uid);
        if (set) {
          for (let s of set) {
            if (s.id === socket.id) {
              set.delete(s);
              break;
            }
          }
          if (set.size === 0) authoritySockets.delete(uid);
          else console.log(`Remaining authority sockets for ${uid}: ${set.size}`);
        }
      } else if (userType === 'tourist' && tid) {
        const set = touristSockets.get(tid);
        if (set) {
          for (let s of set) {
            if (s.id === socket.id) {
              set.delete(s);
              break;
            }
          }
          if (set.size === 0) {
            touristSockets.delete(tid);
            touristLastScores.delete(tid);
          } else {
            console.log(`Remaining tourist sockets for ${tid}: ${set.size}`);
          }
        }
      }
      
      console.log(`Client disconnected: ${socket.id}`);
    });
  });
};

/**
 * Emits a new SOS alert to all connected authorities.
 * This is the primary function for real-time alert broadcasting.
 * @param {object} alertData The alert data to be broadcasted.
 */
exports.emitSOSAlert = async (alertData) => {
  if (!io) {
    console.error("Socket.IO not initialized. Falling back to persistence.");
    if (fallbackService && typeof fallbackService.handleSOSFallback === 'function') {
      return await fallbackService.handleSOSFallback(alertData);
    }
    return;
  }

  // Count total sockets across all authority users
  let totalSockets = 0;
  for (let s of authoritySockets.values()) totalSockets += s.size || 0;

  if (totalSockets === 0) {
    console.warn("No authorities are currently connected. Handling with fallback service.");
    if (fallbackService && typeof fallbackService.handleSOSFallback === 'function') {
      try {
        await fallbackService.handleSOSFallback(alertData);
      } catch (fbErr) {
        console.error('Fallback service failed:', fbErr);
      }
    } else {
      console.warn('No fallbackService.handleSOSFallback() available — alert not persisted for fallback.');
    }
  } else {
    try {
      // Broadcast to the 'authorities' room so all connected authority sockets receive the event
      io.to('authorities').emit('newSOSAlert', alertData);
      console.log(`SOS alert broadcasted to ${totalSockets} authority socket(s).`);
    } catch (error) {
      console.error("Failed to broadcast alert in real-time. Falling back:", error);
      if (fallbackService && typeof fallbackService.handleSOSFallback === 'function') {
        try {
          await fallbackService.handleSOSFallback(alertData);
        } catch (fbErr) {
          console.error('Fallback service failed:', fbErr);
        }
      } else {
        console.warn('No fallbackService.handleSOSFallback() available — alert not persisted for fallback.');
      }
    }
  }
};

/**
 * Helper function to calculate distance between two coordinates (Haversine formula)
 * @param {number} lat1 
 * @param {number} lon1 
 * @param {number} lat2 
 * @param {number} lon2 
 * @returns {number} Distance in meters
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Earth's radius in meters
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // Distance in meters
}

/**
 * Emits an alert from authority to tourists (location-based or broadcast to all)
 * 
 * Expected data shape from Frontend (Authority Dashboard):
 * {
 *   type: 'emergency' | 'warning' | 'info' | 'weather' | 'civil_unrest',
 *   title: string,
 *   message: string,
 *   priority: 'critical' | 'high' | 'medium' | 'low',
 *   targetArea: {
 *     lat: number,
 *     lng: number,
 *     radius: number  // in meters
 *   } | null,  // null = broadcast to all tourists
 *   expiresAt: timestamp (optional),
 *   requiresAcknowledgment: boolean,
 *   actionRequired: string | null,  // e.g., "Evacuate immediately", "Stay indoors"
 *   authorityName: string,
 *   authorityId: string
 * }
 * 
 * @param {object} alertData The alert data from authority
 */
exports.emitAuthorityAlertToTourists = async (alertData) => {
  if (!io) {
    console.error("Socket.IO not initialized. Cannot broadcast authority alert.");
    return;
  }

  // Validate required fields
  if (!alertData.type || !alertData.title || !alertData.message) {
    throw new Error('Missing required fields: type, title, message');
  }

  // Generate unique alert ID
  const alertId = `auth-alert-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  // Construct the alert payload to send to tourists
  const touristAlertPayload = {
    alertId: alertId,
    type: alertData.type,
    title: alertData.title,
    message: alertData.message,
    priority: alertData.priority || 'medium',
    timestamp: new Date().toISOString(),
    authorityName: alertData.authorityName || 'Safety Authority',
    authorityId: alertData.authorityId || 'unknown',
    requiresAcknowledgment: alertData.requiresAcknowledgment || false,
    actionRequired: alertData.actionRequired || null,
    expiresAt: alertData.expiresAt || null,
    targetArea: alertData.targetArea || null
  };

  let targetedCount = 0;
  let totalTourists = 0;

  // Count total connected tourists
  for (let socketSet of touristSockets.values()) {
    totalTourists += socketSet.size;
  }

  if (totalTourists === 0) {
    console.warn('No tourists connected. Alert not delivered in real-time.');
    return;
  }

  // If targetArea is null, broadcast to ALL tourists
  if (!alertData.targetArea) {
    io.to('tourists').emit('authorityAlert', touristAlertPayload);
    console.log(`Authority alert broadcasted to ALL ${totalTourists} connected tourists`);
    return;
  }

  // Location-based targeting
  const targetLat = alertData.targetArea.lat;
  const targetLng = alertData.targetArea.lng;
  const targetRadius = alertData.targetArea.radius; // in meters

  // Iterate through all connected tourists and filter by location
  for (let [touristId, socketSet] of touristSockets.entries()) {
    for (let socket of socketSet) {
      const touristLocation = socket.data.location;
      
      if (touristLocation && touristLocation.lat && touristLocation.lng) {
        const distance = calculateDistance(
          targetLat,
          targetLng,
          touristLocation.lat,
          touristLocation.lng
        );

        // If tourist is within the target radius, send the alert
        if (distance <= targetRadius) {
          socket.emit('authorityAlert', {
            ...touristAlertPayload,
            distanceFromEvent: Math.round(distance) // meters
          });
          targetedCount++;
        }
      }
    }
  }

  console.log(`Authority alert sent to ${targetedCount} tourists within ${targetRadius}m of (${targetLat}, ${targetLng})`);
};

/**
 * Emits an SOS status update to all connected authorities.
 * @param {object} alertData The updated alert data.
 */
exports.emitSOSStatusUpdate = async (alertData) => {
  if (io) {
    io.to('authorities').emit('sosAlertUpdated', alertData);
    console.log(`SOS status update broadcasted for alert ${alertData.alertId}`);
  }
};

/**
 * Emits a new danger zone event to all connected authorities.
 * @param {object} zoneData The new danger zone data.
 */
exports.emitDangerZoneAdded = async (zoneData) => {
  if (io) {
    io.to('authorities').emit('dangerZoneAdded', zoneData);
    console.log(`New danger zone broadcasted: ${zoneData.id || zoneData._id}`);
  }
};

/**
 * Emits a new incident event to all connected authorities.
 * @param {object} incidentData The new incident data.
 */
exports.emitIncidentReported = async (incidentData) => {
  if (io) {
    io.to('authorities').emit('incidentReported', incidentData);
    console.log(`New incident broadcasted: ${incidentData.id || incidentData._id}`);
  }
};

/**
 * Emits a risk grid update event to all connected clients.
 * @param {object} gridData The updated grid data.
 */
exports.emitRiskGridUpdated = async (gridData) => {
  if (io) {
    // Broadcast to all clients (not just authorities)
    io.emit('riskGridUpdated', gridData);
    console.log(`Risk grid update broadcasted: ${gridData.gridId}`);
  }
};

/**
 * Periodically recompute safety scores for all connected tourists
 * using their last known locations. Emits safetyScoreUpdate and
 * safetyScoreAlert (if significant change) events.
 */
async function runPeriodicSafetyScoreUpdate() {
  if (!io) return;

  for (const [touristId, socketSet] of touristSockets.entries()) {
    // Use first socket's stored location as canonical for this tourist
    const firstSocket = socketSet.values().next().value;
    const loc = firstSocket && firstSocket.data && firstSocket.data.location;
    if (!loc || !loc.lat || !loc.lng) continue;

    try {
      const safetyScoreData = await calculateSafetyScore(loc.lat, loc.lng);
      const previousScore = touristLastScores.get(touristId) || 80;
      const newScore = safetyScoreData.safetyScore;

      // Update stored score
      touristLastScores.set(touristId, newScore);

      // Emit to all sockets of this tourist
      for (const socket of socketSet) {
        socket.emit('safetyScoreUpdate', safetyScoreData);
      }
      console.log(`📡 safetyScoreUpdate emitted (periodic) to ${touristId}: ${newScore}/100`);

      // Notify only if significant change
      const notification = shouldNotifyScoreChange(previousScore, newScore);
      if (notification) {
        for (const socket of socketSet) {
          socket.emit('safetyScoreAlert', {
            ...notification,
            previousScore,
            newScore,
            safetyScoreData
          });
        }
        console.log(`⚠️ Periodic safety score alert for ${touristId}: ${previousScore} → ${newScore}`);
      }
    } catch (error) {
      console.error(`Failed periodic safety score calc for ${touristId}:`, error);
    }
  }
}