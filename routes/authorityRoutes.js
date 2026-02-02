const express = require('express');
const {
  getNewSosAlerts,
  getRespondingSosAlerts,
  getSosCounts,
  getDashboardStats,
  getTouristManagementData,
  getExpiredTouristData,
  revokeTourist,
  getMapOverview,
  signUp, signIn, verify, logOut,
  assignUnitToAlert,
  resolveAlert
} = require('../controllers/authorityController');
const { verifyToken, isAuthority } = require('../middlewares/authMiddleware');

const router = express.Router();

// The 'authorize' middleware checks if the authenticated user has the 'authority' role
router.get('/dashboard-stats', verifyToken, isAuthority, getDashboardStats);
router.get('/tourist-management', verifyToken, isAuthority, getTouristManagementData);
router.get('/expired-tourists', verifyToken, isAuthority, getExpiredTouristData);
router.get('/map-overview', verifyToken, isAuthority, getMapOverview);
router.delete('/revoke/:id', verifyToken, isAuthority, revokeTourist);
router.get('/alerts', verifyToken, isAuthority, getNewSosAlerts);
router.get('/alerts/responding', verifyToken, isAuthority, getRespondingSosAlerts);
router.put('/alerts/:id/assign', verifyToken, isAuthority, assignUnitToAlert);
router.put('/alerts/:id/resolve', verifyToken, isAuthority, resolveAlert);

router.post("/signup", signUp);
router.post("/login", signIn);
router.get('/me', verifyToken, verify);
router.post('/logout', logOut);


router.get('/count', getSosCounts);


module.exports = router;

