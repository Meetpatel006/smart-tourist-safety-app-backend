const TourGroup = require("../models/TourGroup");
const Tourist = require("../models/Tourist");
const crypto = require('crypto');
const { generateGeofencesForItinerary, removeOldGeofences } = require('../services/itineraryGeofenceService');
// const { generateAccessCode } = require("../utils/hash"); // Helper or just Math.random

exports.createGroup = async (req, res, next) => {
  try {
    const { groupName, startDate, endDate, itinerary } = req.body;
    const adminId = req.user.id; //From authMiddleware

    if (!groupName || !startDate || !endDate || !itinerary) {
      return res
        .status(400)
        .json({ success: false, message: "Missing required group details" });
    }

    // Generate a cryptographically secure 6-char Access Code (3 bytes -> 6 hex chars)
    const accessCode = crypto.randomBytes(3).toString('hex').toUpperCase();

    const newGroup = new TourGroup({
      groupName,
      accessCode,
      startDate,
      endDate,
      adminId,
      itinerary: itinerary, // Expects the Node-Based Format directly
      members: [],
    });

    await newGroup.save();

    // Generate geofences for the group's itinerary
    try {
      await generateGeofencesForItinerary(newGroup._id.toString(), 'TourGroup', itinerary);
    } catch (geofenceErr) {
      console.error('Failed to generate geofences for new group:', geofenceErr);
      // Don't fail the request if geofence generation fails - group is already created
    }

    // Update Admin User
    await Tourist.findByIdAndUpdate(adminId, {
      role: "tour-admin",
      ownedGroupId: newGroup._id,
    });

    res.status(201).json({
      success: true,
      message: "Group created successfully",
      data: {
        groupId: newGroup._id,
        accessCode: newGroup.accessCode,
        groupName: newGroup.groupName,
      },
    });
  } catch (err) {
    console.error("createGroup error:", err);
    next(err);
  }
};

exports.joinGroup = async (req, res, next) => {
  try {
    const { accessCode } = req.body;
    const userId = req.user.id;

    const group = await TourGroup.findOne({ accessCode, isActive: true });
    if (!group) {
      return res
        .status(404)
        .json({ success: false, message: "Invalid or inactive Access Code" });
    }

    // Check if already a member
    const alreadyMember = group.members.some(
      (m) => m.touristId.toString() === userId,
    );
    if (alreadyMember) {
      return res.status(400).json({
        success: false,
        message: "You are already a member of this group",
      });
    }

    // Add to Group. Do NOT insert placeholder coordinates; leave lastKnownLocation undefined until the client reports a real location.
    group.members.push({ touristId: userId, status: "active" });
    await group.save();

    // Update User Profile
    await Tourist.findByIdAndUpdate(userId, {
      role: "group-member",
      groupId: group._id,
    });

    res.status(200).json({
      success: true,
      message: `Joined group: ${group.groupName}`,
      data: {
        groupId: group._id,
        groupName: group.groupName,
      },
    });
  } catch (err) {
    console.error("joinGroup error:", err);
    next(err);
  }
};

exports.getGroupDashboard = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const tourist = await Tourist.findById(userId);

    // Determine which Group ID to look up
    const targetGroupId =
      tourist.role === "tour-admin" ? tourist.ownedGroupId : tourist.groupId;

    if (!targetGroupId) {
      return res.status(404).json({
        success: false,
        message: "No active group found for this user",
      });
    }

    const group = await TourGroup.findById(targetGroupId)
      .populate(
        "members.touristId",
        "touristId nameEncrypted phoneEncrypted safetyScore consent",
      ) // Populate minimal info
      .lean();

    if (!group) {
      return res
        .status(404)
        .json({ success: false, message: "Group not found" });
    }

    // Logic to decrypt member names for response if needed (omitted for brevity, keep names encrypted or decrypt here)

    res.status(200).json({
      success: true,
      data: group,
    });
  } catch (err) {
    console.error("getGroupDashboard error:", err);
    next(err);
  }
};

exports.updateGroupItinerary = async (req, res, next) => {
  try {
    const { itinerary } = req.body;
    const userId = req.user.id;

    if (!itinerary) {
      return res
        .status(400)
        .json({ success: false, message: "Missing itinerary data" });
    }

    // Find the user to determine their group
    const user = await Tourist.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Authorization Check: Only tour-admin can update group itinerary
    if (user.role !== 'tour-admin') {
      return res.status(403).json({
        success: false,
        message: 'Only tour administrators can update group itineraries.'
      });
    }

    // Determine groupId based on role
    let groupId = user.ownedGroupId || user.groupId;

    if (!groupId) {
      return res.status(404).json({
        success: false,
        message: "No group found for this user.",
      });
    }

    // Find the group
    const group = await TourGroup.findById(groupId);
    if (!group) {
      return res.status(404).json({
        success: false,
        message: "Group not found.",
      });
    }

    // Verify the user owns this group
    if (group.adminId.toString() !== userId) {
      return res.status(403).json({
        success: false,
        message: 'You are not authorized to modify this group.'
      });
    }

    // Update itinerary
    group.itinerary = itinerary;
    await group.save();

    // Regenerate geofences for the updated itinerary
    try {
      await removeOldGeofences(group._id.toString(), 'TourGroup');
      await generateGeofencesForItinerary(group._id.toString(), 'TourGroup', itinerary);
    } catch (geofenceErr) {
      console.error('Failed to regenerate geofences for updated itinerary:', geofenceErr);
      // Don't fail the request if geofence regeneration fails - itinerary is already updated
    }

    res.status(200).json({
      success: true,
      message: "Itinerary updated successfully",
      data: {
        groupId: group._id,
        itinerary: group.itinerary,
      },
    });
  } catch (err) {
    console.error("updateGroupItinerary error:", err);
    next(err);
  }
};
