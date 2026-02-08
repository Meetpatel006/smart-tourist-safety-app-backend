const Tourist = require("../models/Tourist.js");
const { CustomError } = require('../middlewares/errorMiddleware');
const { decrypt } = require("../utils/encrypt.js");


// @desc    Get the authenticated tourist's profile
// @route   GET /api/tourist/profile
// @access  Private (tourist)

exports.getTouristById = async (req, res, next) => {
  try {
    // console.log("Tourist ID from request:", req.user.touristId);
    const touristId = req.user.touristId;

    // Find tourist by touristId
    const tourist = await Tourist.findOne({ touristId });
    if (!tourist) {
      console.log("Tourist not found in DB");
      return res.status(404).json({ error: "Tourist not found" });
    }

    // console.log("Tourist found:", tourist);

    // let decryptedItinerary = null;

    // if (tourist.dayWiseItineraryEncrypted && tourist.dayWiseItineraryEncrypted.length > 0) {
    //   try {
    //     // console.log("Encrypted itinerary array:", tourist.dayWiseItineraryEncrypted);

    //     decryptedItinerary = tourist.dayWiseItineraryEncrypted.map(item => {
    //       const decryptedString = decrypt(item);
    //       console.log("Decrypted itinerary string:", decryptedString);
    //       return JSON.parse(decryptedString);
    //     });

    //     // console.log("Decrypted itinerary object:", decryptedItinerary);

    //   } catch (error) {
    //     console.error("Error decrypting itinerary:", error);
    //   }
    // } else {
    //   console.log("dayWiseItineraryEncrypted field is null or missing");
    // }

    const safeData = {
      touristId: tourist.touristId,
      name: tourist.nameEncrypted ? decrypt(tourist.nameEncrypted) : null,
      phone: tourist.phoneEncrypted ? decrypt(tourist.phoneEncrypted) : null,
      email: tourist.email,
      role: tourist.role, // IMPORTANT: Include role for frontend authorization
      groupId: tourist.groupId || null, // Include groupId for group members
      dayWiseItinerary: tourist.dayWiseItinerary, // updated field name
      emergencyContact: tourist.emergencyContactEncrypted
        ? JSON.parse(decrypt(tourist.emergencyContactEncrypted))
        : null,
      language: tourist.language,
      createdAt: tourist.createdAt,
      expiresAt: tourist.expiresAt,
      audit: tourist.audit
    };

    console.log("Final safeData object:", safeData);

    return res.status(200).json(safeData);

  } catch (err) {
    console.error("getTouristById error:", err);
    next(err);
  }
};

exports.getAllTourists = async (req, res, next) => {
  try {
    const tourists = await Tourist.find();

    const safe = tourists.map((tourist) => ({
      touristId: tourist.touristId,
      name: tourist.nameEncrypted ? decrypt(tourist.nameEncrypted) : null,
      phone: tourist.phoneEncrypted ? decrypt(tourist.phoneEncrypted) : null,
      email: tourist.email,
      itinerary: tourist.itineraryEncrypted
        ? JSON.parse(decrypt(tourist.itineraryEncrypted))
        : null,
      emergencyContact: tourist.emergencyContactEncrypted
        ? JSON.parse(decrypt(tourist.emergencyContactEncrypted))
        : null,
      language: tourist.language,
      safetyScore: tourist.safetyScore,
      createdAt: tourist.createdAt,
      expiresAt: tourist.expiresAt,
      audit: tourist.audit,
    }));

    res.json(safe);
  } catch (err) {
    console.error("❌ getAllTourists error:", err);
    next(err);
  }
};





