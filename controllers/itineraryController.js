const Tourist = require('../models/Tourist');
const mongoose = require('mongoose');
const { CustomError } = require('../middlewares/errorMiddleware');
const { generateGeofencesForItinerary, removeOldGeofences } = require('../services/itineraryGeofenceService');

// Get the logged-in user's itinerary
exports.getItinerary = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const tourist = await Tourist.findById(userId).lean();
        if (!tourist) return next(new CustomError(404, 'User not found'));

        return res.status(200).json({ success: true, data: tourist.dayWiseItinerary || [] });
    } catch (err) {
        next(err);
    }
};

// Replace the user's itinerary (full overwrite)
exports.replaceItinerary = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const itinerary = req.body.itinerary;

        if (!Array.isArray(itinerary)) return next(new CustomError(400, 'Itinerary must be an array'));

        // Basic validation: each day should have date, dayNumber, nodes array
        for (const day of itinerary) {
            if (!day.date || typeof day.dayNumber !== 'number' || !Array.isArray(day.nodes)) {
                return next(new CustomError(400, 'Each day must contain date, dayNumber (number) and nodes (array)'));
            }
            for (const node of day.nodes) {
                if (!node.type || !node.name || !node.location || !Array.isArray(node.location.coordinates)) {
                    return next(new CustomError(400, 'Each node must contain type, name and location.coordinates'));
                }
                // ensure coordinates are two numbers
                const coords = node.location.coordinates;
                if (coords.length !== 2 || typeof coords[0] !== 'number' || typeof coords[1] !== 'number') {
                    return next(new CustomError(400, 'Node coordinates must be [lng, lat] numeric pair'));
                }
            }
        }

        // Support lookup by Mongo _id or by business touristId (e.g. 'T1768914660451')
        let tourist;
        if (userId && mongoose.Types.ObjectId.isValid(userId)) {
            tourist = await Tourist.findById(userId);
        } else if (userId) {
            tourist = await Tourist.findOne({ touristId: userId });
        }
        if (!tourist) return next(new CustomError(404, 'User not found'));

        tourist.dayWiseItinerary = itinerary;
        await tourist.save();

        // Generate geofences for the updated itinerary
        try {
            await removeOldGeofences(tourist.touristId, 'Tourist');
            await generateGeofencesForItinerary(tourist.touristId, 'Tourist', itinerary);
        } catch (geofenceErr) {
            console.error('Failed to regenerate geofences for updated itinerary:', geofenceErr);
            // Don't fail the request if geofence generation fails - itinerary is already saved
        }

        res.status(200).json({ success: true, message: 'Itinerary saved', data: tourist.dayWiseItinerary });
    } catch (err) {
        next(err);
    }
};

// Create itinerary only if user has none yet
exports.addItinerary = async (req, res, next) => {
    try {
        // const userId = req.user.id;
        const userId = req.params.id;
        const itinerary = req.body.itinerary;

        if (!Array.isArray(itinerary)) return next(new CustomError(400, 'Itinerary must be an array'));

        // Basic validation same as replace
        for (const day of itinerary) {
            if (!day.date || typeof day.dayNumber !== 'number' || !Array.isArray(day.nodes)) {
                return next(new CustomError(400, 'Each day must contain date, dayNumber (number) and nodes (array)'));
            }
            for (const node of day.nodes) {
                if (!node.type || !node.name || !node.location || !Array.isArray(node.location.coordinates)) {
                    return next(new CustomError(400, 'Each node must contain type, name and location.coordinates'));
                }
                const coords = node.location.coordinates;
                if (coords.length !== 2 || typeof coords[0] !== 'number' || typeof coords[1] !== 'number') {
                    return next(new CustomError(400, 'Node coordinates must be [lng, lat] numeric pair'));
                }
            }
        }

        
        const tourist = await Tourist.findOne({ touristId: userId });

        if (!tourist) return next(new CustomError(404, 'User not found'));

        // Role check: middleware `isSolo` should prevent non-solo users reaching here.
        // Extra guard in case middleware is not applied: return 403 Forbidden.
        if (tourist.role !== 'solo') {
            return next(new CustomError(403, 'Itinerary can only be created by a solo traveller'));
        }

        if (tourist.dayWiseItinerary && tourist.dayWiseItinerary.length > 0) {
            return next(new CustomError(400, 'Itinerary already exists. Use PUT to replace or update.'));
        }

        tourist.dayWiseItinerary = itinerary;
        await tourist.save();

        // Generate geofences for the new itinerary
        try {
            await generateGeofencesForItinerary(tourist.touristId, 'Tourist', itinerary);
        } catch (geofenceErr) {
            console.error('Failed to generate geofences for new itinerary:', geofenceErr);
            // Don't fail the request if geofence generation fails - itinerary is already created
        }

        res.status(201).json({ success: true, message: 'Itinerary created', data: tourist.dayWiseItinerary });
    } catch (err) {
        next(err);
    }
};

// Update a single day (upsert)
exports.updateDay = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const dayNumber = parseInt(req.params.dayNumber, 10);
        const dayPayload = req.body.day;

        if (!dayPayload || typeof dayPayload !== 'object') return next(new CustomError(400, 'Day payload required'));
        if (Number.isNaN(dayNumber)) return next(new CustomError(400, 'Invalid day number'));

        const tourist = await Tourist.findById(userId);
        if (!tourist) return next(new CustomError(404, 'User not found'));

        // remove existing day with same dayNumber
        tourist.dayWiseItinerary = (tourist.dayWiseItinerary || []).filter(d => d.dayNumber !== dayNumber);

        // ensure dayNumber in payload
        dayPayload.dayNumber = dayNumber;
        tourist.dayWiseItinerary.push(dayPayload);
        // sort by dayNumber
        tourist.dayWiseItinerary.sort((a, b) => a.dayNumber - b.dayNumber);

        await tourist.save();

        // Regenerate geofences for the updated itinerary
        try {
            await removeOldGeofences(tourist.touristId, 'Tourist');
            await generateGeofencesForItinerary(tourist.touristId, 'Tourist', tourist.dayWiseItinerary);
        } catch (geofenceErr) {
            console.error('Failed to regenerate geofences after day update:', geofenceErr);
            // Don't fail the request if geofence generation fails - itinerary is already updated
        }

        res.status(200).json({ success: true, message: 'Day updated', data: tourist.dayWiseItinerary });
    } catch (err) {
        next(err);
    }
};

// Clear itinerary
exports.clearItinerary = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const tourist = await Tourist.findById(userId);
        if (!tourist) return next(new CustomError(404, 'User not found'));

        tourist.dayWiseItinerary = [];
        await tourist.save();

        // Remove all geofences when itinerary is cleared
        try {
            await removeOldGeofences(tourist.touristId, 'Tourist');
        } catch (geofenceErr) {
            console.error('Failed to remove geofences after clearing itinerary:', geofenceErr);
            // Don't fail the request if geofence removal fails - itinerary is already cleared
        }

        res.status(200).json({ success: true, message: 'Itinerary cleared' });
    } catch (err) {
        next(err);
    }
};
