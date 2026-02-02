const socketio = require('socket.io');
const fallbackService = require('./fallbackService');
const blockchainService = require('./blockchainService');

let io; // This will hold the Socket.IO server instance
let authoritySockets = new Map(); // Map to store connected authorities

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

  io.on('connection', (socket) => {
    console.log(`New client connected: ${socket.id}`);

    // Store the socket if it's an authority, based on a handshake payload
    socket.on('registerAuthority', (data) => {
      if (data && data.role === 'authority' && data.userId) {
        const userId = data.userId;

        // Attach userId to the socket for easy cleanup on disconnect
        socket.data = socket.data || {};
        socket.data.userId = userId;

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

    socket.on('disconnect', () => {
      const uid = socket.data && socket.data.userId;
      if (uid) {
        const set = authoritySockets.get(uid);
        if (set) {
          for (let s of set) {
            if (s.id === socket.id) {
              set.delete(s);
              break;
            }
          }
          if (set.size === 0) authoritySockets.delete(uid);
          else console.log(`Remaining sockets for ${uid}: ${set.size}`);
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