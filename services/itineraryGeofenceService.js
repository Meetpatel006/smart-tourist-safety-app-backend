const { Geofence } = require('../models/Geofence');

/**
 * Generate geofences for an itinerary (tour group or solo user)
 * @param {ObjectId} ownerId - Tourist ID or TourGroup ID
 * @param {String} ownerType - "Tourist" or "TourGroup"
 * @param {Array} itinerary - Array of DayAppointSchema objects
 * @returns {Promise<Array>} Array of created geofences
 */
async function generateGeofencesForItinerary(ownerId, ownerType, itinerary) {
  if (!itinerary || itinerary.length === 0) {
    console.log('No itinerary provided, skipping geofence generation');
    return [];
  }

  const geofencesToCreate = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const day of itinerary) {
    if (!day.nodes || day.nodes.length === 0) {
      console.log(`Day ${day.dayNumber} has no activity nodes, skipping`);
      continue;
    }

    // Check if this day is in the past
    const dayDate = new Date(day.date);
    dayDate.setHours(0, 0, 0, 0);
    if (dayDate < today) {
      console.log(`Day ${day.dayNumber} is in the past, skipping geofence creation`);
      continue;
    }

    // Calculate expiry time (end of day)
    const expiresAt = new Date(dayDate);
    expiresAt.setHours(23, 59, 59, 999);

    for (const node of day.nodes) {
      // Validate coordinates
      if (!node.location || !node.location.coordinates || node.location.coordinates.length !== 2) {
        console.log(`Invalid coordinates for node ${node.name}, skipping`);
        continue;
      }

      const [lng, lat] = node.location.coordinates;

      // Validate coordinate ranges
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        console.log(`Coordinates out of range for node ${node.name}, skipping`);
        continue;
      }

      // Create geofence object
      const geofence = {
        name: node.name,
        destination: node.address || node.name,
        type: 'circle',
        coords: [lat, lng], // [lat, lng] format
        radiusKm: 0.5, // 500 meters
        isActive: true,
        alertMessage: `You are leaving the safe zone for ${node.name}`,
        
        // Itinerary-specific fields
        sourceType: 'itinerary',
        ownerId: ownerId,
        ownerType: ownerType,
        dayNumber: day.dayNumber,
        scheduledDate: dayDate,
        activityNodeName: node.name,
        activityNodeType: node.type,
        expiresAt: expiresAt,
        
        // Visual styling for itinerary geofences
        visualStyle: {
          zoneType: 'itinerary_geofence',
          borderStyle: 'dotted',
          borderWidth: 2,
          fillOpacity: 0.15,
          fillPattern: 'solid',
          iconType: 'location-pin',
          renderPriority: 3,
          color: 'green'
        }
      };

      geofencesToCreate.push(geofence);
    }
  }

  if (geofencesToCreate.length === 0) {
    console.log('No geofences to create');
    return [];
  }

  try {
    // Bulk insert all geofences
    const createdGeofences = await Geofence.insertMany(geofencesToCreate);
    console.log(`Created ${createdGeofences.length} itinerary geofences for ${ownerType} ${ownerId}`);
    return createdGeofences;
  } catch (error) {
    console.error('Error creating itinerary geofences:', error);
    throw error;
  }
}

/**
 * Remove all itinerary geofences for an owner
 * @param {ObjectId} ownerId - Tourist ID or TourGroup ID
 * @param {String} ownerType - "Tourist" or "TourGroup"
 * @returns {Promise<Object>} Delete result
 */
async function removeOldGeofences(ownerId, ownerType) {
  try {
    const result = await Geofence.deleteMany({
      sourceType: 'itinerary',
      ownerId: ownerId,
      ownerType: ownerType
    });
    
    console.log(`Deleted ${result.deletedCount} old itinerary geofences for ${ownerType} ${ownerId}`);
    return result;
  } catch (error) {
    console.error('Error deleting old itinerary geofences:', error);
    throw error;
  }
}

/**
 * Get active geofences for today for an owner
 * @param {ObjectId} ownerId - Tourist ID or TourGroup ID
 * @param {String} ownerType - "Tourist" or "TourGroup"
 * @param {Date} currentDate - The date to fetch geofences for (defaults to today)
 * @returns {Promise<Array>} Array of active geofences
 */
async function getActiveGeofencesForOwner(ownerId, ownerType, currentDate = null) {
  const queryDate = currentDate || new Date();
  queryDate.setHours(0, 0, 0, 0);

  try {
    const geofences = await Geofence.find({
      sourceType: 'itinerary',
      ownerId: ownerId,
      ownerType: ownerType,
      scheduledDate: queryDate,
      isActive: true
    });
    
    return geofences;
  } catch (error) {
    console.error('Error fetching active itinerary geofences:', error);
    throw error;
  }
}

/**
 * Cleanup expired geofences (mark as inactive)
 * Called by cron job at midnight
 * @returns {Promise<Object>} Update result
 */
async function cleanupExpiredGeofences() {
  try {
    const result = await Geofence.updateMany(
      {
        sourceType: 'itinerary',
        expiresAt: { $lt: new Date() },
        isActive: true
      },
      {
        isActive: false
      }
    );
    
    console.log(`Marked ${result.modifiedCount} expired geofences as inactive`);
    return result;
  } catch (error) {
    console.error('Error cleaning up expired geofences:', error);
    throw error;
  }
}

module.exports = {
  generateGeofencesForItinerary,
  removeOldGeofences,
  getActiveGeofencesForOwner,
  cleanupExpiredGeofences
};
