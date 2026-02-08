const jwt = require("jsonwebtoken");
const Tourist = require("../models/Tourist.js");
const bcrypt = require("bcryptjs");
const { encrypt } = require("../utils/encrypt.js");
const { decrypt } = require("../utils/encrypt.js");
const { sha256Hex } = require("../utils/hash.js");
const { hex64ToBytes32 } = require("../utils/ethFormat.js");
const blockchain = require("../services/blockchainService.js");

const { JWT_SECRET, JWT_EXPIRES_IN , GOVID_SALT } = require("../config/config");

exports.registerTourist = async (req, res, next) => {
  try {
    const {
      name,
      govId,
      phone,
      email,
      dayWiseItinerary,
      emergencyContact,
      password,
      language,
      tripEndDate,
      role,
      // New fields
      dob,
      nationality,
      gender,
      bloodGroup,
      medicalConditions,
      allergies,
    } = req.body;
    const { consent } = req.body;

    // Basic validation
    if (!name || !govId || !phone || !emergencyContact || !password || !email) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const existingTourist = await Tourist.findOne({ email });

    if (existingTourist) {
      const error = new Error("tourist already exists");
      error.statusCode = 409;
      throw error;
    }

    // Generate internal touristId
    const touristId =
      "T" + Math.floor(Date.now() / 1000) + Math.floor(Math.random() * 999);

    // Encrypt sensitive fields
    const nameEnc = encrypt(name);
    const phoneEnc = encrypt(phone);

    // Only process itinerary if provided (Solo travelers or one-step flow)
    // const dayWiseItineraryEnc =
    //   dayWiseItinerary && dayWiseItinerary.length > 0
    //     ? encrypt(JSON.stringify(dayWiseItinerary))
    //     : []; // Default to empty array for Admins/Members initially

    const emergencyEnc = encrypt(JSON.stringify(emergencyContact));

    // Password hashing
    const salt = await bcrypt.genSalt(12);
    const passwordHash = await bcrypt.hash(password, salt);

    // Government ID hash
    const govSalt = GOVID_SALT 
    const govIdHash = sha256Hex(govId + govSalt);

    // Deterministic fields for blockchain/audit
    const registeredAtIso = new Date().toISOString();
    // Use empty string hash if no itinerary yet
    const dayWiseItineraryHash = sha256Hex(
      JSON.stringify(dayWiseItinerary || ""),
    );
    const payload = `${touristId}|${govIdHash}|${dayWiseItineraryHash}|${registeredAtIso}`;
    const payloadHash = sha256Hex(payload);

    // Create Tourist record
    const tourist = new Tourist({
      touristId,
      role: role || "solo", // Default to solo
      nameEncrypted: nameEnc,
      govIdHash,
      phoneEncrypted: phoneEnc,
      email,
      dayWiseItinerary: dayWiseItinerary,
      emergencyContactEncrypted: emergencyEnc,
      passwordHash,
      language: language || "en",

      // Personal & Medical Info
      dob,
      nationality,
      gender,
      bloodGroup,
      medicalConditions,
      allergies,

      // Preferences for Commuters (Safe Pulse / Routes)
      // preferences: preferences || {},

      consent: {
        tracking: consent?.tracking || false,
        dataRetention: consent?.dataRetention || false,
        emergencySharing: consent?.emergencySharing || false,
      },
      createdAt: new Date(),
      expiresAt: tripEndDate ? new Date(tripEndDate) : null,
    });

    await tourist.save();

    // Blockchain push - Proceed regardless of itinerary presence (Log Identity Creation)
    const { v4: uuidv4 } = await import("uuid");
    const eventIdRaw = uuidv4() + "|" + touristId;
    const eventIdHash = sha256Hex(eventIdRaw);
    const eventIdBytes32 = hex64ToBytes32(eventIdHash);
    const payloadHashBytes32 = hex64ToBytes32(payloadHash);

    let txHash;
    try {
      txHash = await blockchain.storeEvent(eventIdBytes32, payloadHashBytes32);
      if (txHash) {
        console.log("transaction hash returned correctly");
      }
    } catch (err) {
      console.error("Blockchain tx failed:", err);
      txHash = null;
    }

    tourist.audit = {
      regHash: payloadHash,
      regTxHash: txHash || "not-recorded",
      eventId: eventIdHash,
      dayWiseItineraryHash: dayWiseItineraryHash, // might be empty hash for admins
      registeredAtIso: registeredAtIso,
    };

    await tourist.save();

    // Generate Token for immediate login
    const tokenPayload = {
      touristId: tourist.touristId,
      id: tourist._id,
      role: tourist.role,
    };
    const token = jwt.sign(tokenPayload, JWT_SECRET, {
      expiresIn: JWT_EXPIRES_IN,
    });

    return res.status(201).json({
      message: "Registered successfully.",
      touristId,
      token,
      role: tourist.role,
      audit: {
        regHash: payloadHash,
        regTxHash: txHash,
        eventId: eventIdHash,
      },
    });
  } catch (err) {
    console.error("registerTourist error", err);
    next(err);
  }
};

exports.loginTourist = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    // Find tourist by email
    const tourist = await Tourist.findOne({ email: email });
    if (!tourist) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // ⚠️ Block group members from email/password login - they must use 3-code login
    if (tourist.role === "group-member") {
      return res.status(403).json({ 
        error: "Group members must login using the 3-code system. Please use 'Group Member? Login with Codes' option.",
        code: "GROUP_MEMBER_USE_CODES"
      });
    }

    // Verify password
    const passwordMatch = await bcrypt.compare(password, tourist.passwordHash);
    if (!passwordMatch) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // ✅ Generate JWT
    const payload = {
      id: tourist._id, // Standardize to id
      touristId: tourist.touristId,
      role: tourist.role || "solo",
      language: tourist.language,
    };

    const token = jwt.sign(payload, JWT_SECRET, {
      expiresIn: JWT_EXPIRES_IN,
    });

    return res.status(200).json({
      message: "Login successful",
      touristId: tourist.touristId,
      role: tourist.role || "solo",
      groupId: tourist.groupId,
      ownedGroupId: tourist.ownedGroupId,
      token,
    });
  } catch (err) {
    console.error("loginTourist error:", err);
    next(err);
  }
};

// POST /api/auth/login-with-codes - Login for group members using 3 codes
exports.loginWithCodes = async (req, res, next) => {
  try {
    const { guideId, touristId, groupAccessCode } = req.body;

    // 1. Validate all three codes are provided
    if (!guideId || !touristId || !groupAccessCode) {
      return res.status(400).json({
        success: false,
        error: "All three codes are required: Guide ID, Tourist ID, and Group Access Code",
      });
    }

    // 2. Find the tourist (group member) by touristId
    const tourist = await Tourist.findOne({ touristId: touristId }).populate('groupId');
    if (!tourist) {
      return res.status(401).json({
        success: false,
        error: "Invalid credentials. Please check your codes and try again.",
      });
    }

    // 3. Verify tourist is a group member
    if (tourist.role !== "group-member") {
      return res.status(403).json({
        success: false,
        error: "This login method is only for group members. Please use email/password login.",
      });
    }

    // 4. Verify tourist belongs to a group
    if (!tourist.groupId) {
      return res.status(401).json({
        success: false,
        error: "You are not assigned to any group. Please contact your tour guide.",
      });
    }

    // 5. Get the group to verify access code
    const TourGroup = require("../models/TourGroup");
    const group = await TourGroup.findById(tourist.groupId).populate('adminId');
    
    if (!group) {
      return res.status(401).json({
        success: false,
        error: "Group not found. Please contact your tour guide.",
      });
    }

    // 6. Verify group access code matches
    if (group.accessCode !== groupAccessCode) {
      return res.status(401).json({
        success: false,
        error: "Invalid credentials. Please check your codes and try again.",
      });
    }

    // 7. Verify guide ID matches the group admin
    const admin = group.adminId;
    if (!admin || admin.touristId !== guideId) {
      return res.status(401).json({
        success: false,
        error: "Invalid credentials. Please check your codes and try again.",
      });
    }

    // 8. All validations passed - Generate JWT
    const payload = {
      id: tourist._id,
      touristId: tourist.touristId,
      role: tourist.role,
      language: tourist.language,
    };

    const token = jwt.sign(payload, JWT_SECRET, {
      expiresIn: JWT_EXPIRES_IN,
    });

    // 9. Return success response
    return res.status(200).json({
      success: true,
      message: "Login successful",
      data: {
        touristId: tourist.touristId,
        name: decrypt(tourist.nameEncrypted),
        role: tourist.role,
        groupId: tourist.groupId ? tourist.groupId.toString() : null,
        groupName: group.groupName,
        token,
      },
    });
  } catch (err) {
    console.error("loginWithCodes error:", err);
    next(err);
  }
};

