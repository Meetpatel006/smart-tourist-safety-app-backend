const http = require("http");
const express = require("express");
const morgan = require("morgan");
const cors = require("cors");
const cron = require("node-cron");
const { PORT, NODE_ENV } = require("./config/config");
const connectDB = require("./config/dbConnection");
const authRoutes = require("./routes/authRoutes");
const touristRoutes = require("./routes/touristRoutes");
const tourGroupRoutes = require("./routes/tourGroupRoutes");
const groupMemberRoutes = require("./routes/groupMemberRoutes");
const authorityRoutes = require("./routes/authorityRoutes");
const sosRoutes = require("./routes/sosRoutes");
const incidentRoutes = require("./routes/incidentRoutes");
const geofenceRoutes = require("./routes/geofenceRoutes");
const itineraryRoutes = require("./routes/itineraryRoutes");
const { errorHandler } = require("./middlewares/errorMiddleware");
const { updateRiskScores } = require("./services/riskEngineService");
const { cleanupExpiredGeofences } = require("./services/itineraryGeofenceService");
// const { fetchNewsIncidents } = require('./services/newsService'); // News service disabled
const { init } = require('./services/realtimeService');

const app = express();
const server = http.createServer(app);

// Initialize Socket.IO with the HTTP server
// realTimeService.init(httpServer);

app.use(
  cors({
    origin: true, // Allow all origins dynamically
    credentials: true,
  }),
);
app.use(morgan("dev"));

app.use(
  express.json({
    strict: true, // ensures invalid JSON is rejected
    limit: "1mb",
  }),
);

// CORS configured above

app.get("/", (req, res) => {
  routes = {
    authenticatioin: "/api/auth",
    tourist: "/api/tourist",
    authority: "/api/authority",
    geofence: "/api/geofence",
    sos: "/api/sos",
    incidents: "/api/incidents",
    tourgroup: "/api/group"
  };
  res
    .status(200)
    .json({
      message: "tourist safety main aapka swagat hai !",
      routes: routes,
    });
});

app.use("/api/auth", authRoutes);
app.use("/api/tourist", touristRoutes);
app.use("/api/group", tourGroupRoutes);
app.use("/api/group/members", groupMemberRoutes);
app.use("/api/authority", authorityRoutes);
app.use("/api/geofence", geofenceRoutes);
app.use("/api/sos", sosRoutes);
app.use("/api/incidents", incidentRoutes);
app.use("/api/itinerary", itineraryRoutes);

// Register global error handler (must come after all route registrations)
app.use(errorHandler);

// === Server Start ===
const startServer = async () => {
  try {
    // 1. Connect to Database FIRST
    await connectDB();

    // 2. Start Request Listening
    server.listen(PORT, () => {
      console.log(`Server running in ${NODE_ENV} mode on port ${PORT}`);

      // Initialize WebSocket service (attach to HTTP server)
      init(server);

      // Start Background Services
      console.log("Starting Risk Engine...");

      const runJobs = async () => {
        try {
          // Future Enhancement: Get list of active tourist cities from DB
          // const activeCities = await Tourist.distinct('currentCity');
          // for(const city of activeCities) await fetchNewsIncidents(city);

          // News Service Disabled as per latest requirement
          /*
          await fetchNewsIncidents({ 
            name: 'Kashmir', 
            lat: 34.0837, 
            lng: 74.7973 
          }); 
          */

          await updateRiskScores(); // Recalculate risks globaly
        } catch (err) {
          console.error("Job Error:", err);
        }
      };

      // Run on startup
      runJobs();

      // Cleanup expired geofences on startup
      cleanupExpiredGeofences().catch(err => 
        console.error("Startup geofence cleanup error:", err)
      );

      // Schedule every 30 mins
      setInterval(runJobs, 30 * 60 * 1000);

      // Schedule midnight cleanup for expired itinerary geofences
      // Runs every day at 00:00 (midnight)
      cron.schedule('0 0 * * *', async () => {
        console.log('Running midnight geofence cleanup...');
        try {
          await cleanupExpiredGeofences();
          console.log('Midnight geofence cleanup completed');
        } catch (err) {
          console.error('Midnight geofence cleanup error:', err);
        }
      }, {
        timezone: "Asia/Kolkata" // Indian timezone for midnight calculation
      });
    });
  } catch (err) {
    console.error("Failed to connect to Database. Server shutting down.", err);
    process.exit(1);
  }
};

startServer();
