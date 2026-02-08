const Redis = require('ioredis');
const winston = require('winston');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { REDIS_HOST, REDIS_PORT } = require("../config/config");

// Ensure logs directory exists
const logDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logDir)) {
  try {
    fs.mkdirSync(logDir);
  } catch (err) {
    console.error('Could not create logs directory:', err);
  }
}

// Initialize Redis client with error handling
// Use environment variables if available, otherwise default to local
const redisOptions = {
  port: REDIS_PORT || 6379,
  host: REDIS_HOST || '127.0.0.1',
  retryStrategy: (times) => {
    // Retry connection with exponential backoff, max 2 seconds
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  // Don't crash if connection fails initially
  lazyConnect: true 
};

const redisClient = new Redis(redisOptions);

let redisConnectionErrorLogged = false;

redisClient.on('connect', () => {
  if (redisConnectionErrorLogged) {
    console.log("Redis Client Reconnected (Fallback Service).");
    redisConnectionErrorLogged = false;
  }
});

redisClient.on('error', (err) => {
  // Catch Redis errors to prevent app crash
  if (err.message.includes('ECONNREFUSED')) {
    if (!redisConnectionErrorLogged) {
      console.error("Redis Client Error (Fallback Service):", err.message);
      console.error("Redis unavailable. Suppressing further connection errors until reconnected.");
      redisConnectionErrorLogged = true;
    }
  } else {
    console.error("Redis Client Error (Fallback Service):", err.message);
  }
});

redisClient.on('connect',()=>{
    console.log("Redis connected on PORT : 6379");
})

// Configure Winston logger to log to console and a file
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: path.join(logDir, 'fallback.log') }),
  ],
});

/**
 * Handles the fallback logic for an SOS alert.
 * If the real-time channel (e.g., Socket.IO) is unavailable, it stores the alert in Redis.
 * @param {object} alertData The SOS alert data.
 */
exports.handleSOSFallback = async (alertData) => {
  try {
    const alertId = alertData.alertId;
    
    // Attempt to connect if not connected
    if (redisClient.status !== 'ready' && redisClient.status !== 'connecting') {
        try {
            await redisClient.connect();
        } catch(e) {
            // Redis unavailable, fallback to just logging
            logger.warn(`Real-time channel down AND Redis unavailable. Alert ${alertId} logged to file only.`);
            if(alertData) logger.info("SOS_PAYLOAD", { payload: alertData });
            return;
        }
    }

    const alertKey = `sos:fallback:${alertId}`;

    // Store the entire alert object as a JSON string in Redis
    if (redisClient.status === 'ready') {
        await redisClient.set(alertKey, JSON.stringify(alertData));
        await redisClient.expire(alertKey, 3600); // Expire the key after 1 hour
        logger.warn(`Real-time channel down. Storing alert ${alertId} in Redis for fallback.`);
    } else {
        logger.warn(`Redis not ready. Alert ${alertId} logged to file only.`);
        logger.info("SOS_PAYLOAD", { payload: alertData });
    }

  } catch (error) {
    logger.error(`Failed to handle SOS fallback for alert ${alertData?.alertId}:`, error);
  }
};

/**
 * Retrieves a pending alert from the Redis fallback queue OR the local log file.
 * @param {string} alertId The ID of the alert to retrieve.
 * @returns {Promise<object|null>} The alert data or null if not found.
 */
exports.getPendingAlert = async (alertId) => {
  // 1. Try Redis first if available
  if (redisClient.status === 'ready') {
    try {
      const alertKey = `sos:fallback:${alertId}`;
      const alertData = await redisClient.get(alertKey);

      if (alertData) {
        // Delete the key from Redis after retrieval to avoid reprocessing
        await redisClient.del(alertKey);
        return JSON.parse(alertData);
      }
    } catch (error) {
      logger.error(`Redis retrieval failed for ${alertId} checking logs...:`, error);
    }
  }

  // 2. Fallback: Search in the log file
  const logPath = path.join(logDir, 'fallback.log');
  if (!fs.existsSync(logPath)) return null;

  try {
    const fileStream = fs.createReadStream(logPath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    for await (const line of rl) {
      try {
        const logEntry = JSON.parse(line);
        // Check for matching alertId in payload
        if (logEntry.message === 'SOS_PAYLOAD' && 
            logEntry.payload && 
            logEntry.payload.alertId === alertId) {
            return logEntry.payload;
        }
      } catch (parseErr) {
        // Skip malformed lines
        continue;
      }
    }
  } catch (fileErr) {
    logger.error(`Failed to read log file for alert ${alertId}:`, fileErr);
  }

  return null;
};