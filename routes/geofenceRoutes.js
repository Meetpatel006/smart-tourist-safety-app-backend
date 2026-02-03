const express = require('express');
const { 
  receiveGeofenceTransitions, 
  createGeoFenceToDangerLocation, 
  getallZones, 
  getZonebyId,
  getHighRiskZoneCount, 
  getDynamicRiskZones, 
  triggerRiskUpdate,
  createDestinationGeofence,
  getAllDestinationGeofences,
  getAllZonesWithStyling
} = require('../controllers/geofenceController');
// const { verifyToken } = require('../middlewares/authMiddleware');
const { DangerZone, Geofence } = require('../models/Geofence');

const router = express.Router();

// Route to receive geofence transitions from the tourist app
// router.post('/transitions', verifyToken, receiveGeofenceTransitions);

// Danger zone routes
// router.post('/zone', verifyToken, createGeoFenceToDangerLocation);
router.get('/', getallZones);
router.get('/count', getHighRiskZoneCount);
// router.get('/:id', verifyToken, getZonebyId);

// Risk grid routes
router.get('/dynamic', getDynamicRiskZones); 
router.post('/risk/update', triggerRiskUpdate);

// Destination geofence routes
router.post('/destination', createDestinationGeofence);
router.get('/destinations', getAllDestinationGeofences);

// Combined endpoint with visual styling
router.get('/all-zones-styled', getAllZonesWithStyling);

module.exports = router;