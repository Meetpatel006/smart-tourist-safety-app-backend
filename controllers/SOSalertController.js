const SOSAlert = require("../models/SOSAlertModel.js");
const { ethers } = require("ethers");
const { updateRiskScores, updateGridForLocation } = require('../services/riskEngineService'); // Import Risk Engine
const { hex64ToBytes32 } = require('../utils/ethFormat.js');
const { sha256Hex } = require("../utils/hash.js"); // your existing hash utility
const { POLYGON_RPC, PRIVATE_KEY, SMART_CONTRACT_ADDRESS_sos } = require("../config/config.js");
const Tourist = require('../models/Tourist.js');
const { decrypt } = require('../utils/encrypt.js');
const realtimeService = require('../services/realtimeService');
const SOSABI = [
	{
		"anonymous": false,
		"inputs": [
			{
				"indexed": true,
				"internalType": "bytes32",
				"name": "alertId",
				"type": "bytes32"
			},
			{
				"indexed": false,
				"internalType": "bytes32",
				"name": "payloadHash",
				"type": "bytes32"
			},
			{
				"indexed": true,
				"internalType": "address",
				"name": "tourist",
				"type": "address"
			},
			{
				"indexed": false,
				"internalType": "uint256",
				"name": "timestamp",
				"type": "uint256"
			}
		],
		"name": "AlertLogged",
		"type": "event"
	},
	{
		"inputs": [
			{
				"internalType": "bytes32",
				"name": "alertId",
				"type": "bytes32"
			},
			{
				"internalType": "bytes32",
				"name": "payloadHash",
				"type": "bytes32"
			}
		],
		"name": "logAlert",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "bytes32",
				"name": "alertId",
				"type": "bytes32"
			}
		],
		"name": "getAlert",
		"outputs": [
			{
				"internalType": "bytes32",
				"name": "payloadHash",
				"type": "bytes32"
			},
			{
				"internalType": "address",
				"name": "tourist",
				"type": "address"
			},
			{
				"internalType": "uint256",
				"name": "timestamp",
				"type": "uint256"
			}
		],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "bytes32",
				"name": "alertId",
				"type": "bytes32"
			},
			{
				"internalType": "bytes32",
				"name": "payloadHashHash",
				"type": "bytes32"
			}
		],
		"name": "verifyAlert",
		"outputs": [
			{
				"internalType": "bool",
				"name": "",
				"type": "bool"
			}
		],
		"stateMutability": "view",
		"type": "function"
	}
]

// Initialize provider & contract
const provider = new ethers.JsonRpcProvider(POLYGON_RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const contract = new ethers.Contract(SMART_CONTRACT_ADDRESS_sos, SOSABI, wallet);

/**
 * Trigger SOS alert
 * @param req.body: {
 *   touristId, 
 *   location: { coordinates: [lng, lat], locationName }, 
 *   safetyScore,
 *   emergencyContacts: [{name, phone, email}],
 *   sosReason: { reason, weatherInfo, extra }
 * }
 */
exports.triggerSOS = async (req, res, next) => {
	try {
		const { location, safetyScore, locationName, sosReason } = req.body;
		const touristId = req.user && req.user.touristId;

		// Basic validation (ensure touristId and location coordinates present)
		if (!touristId || !location || !Array.isArray(location.coordinates) || location.coordinates.length < 2) {
			return res.status(400).json({ error: 'Missing required SOS fields: touristId and location.coordinates [lng, lat]' });
		}

		// 1️⃣ Get tourist details
		const tourist = await Tourist.findOne({ touristId });
		if (!tourist) return res.status(404).json({ error: "Tourist not found" });

		// 2️⃣ Decrypt tourist personal information
		const name = decrypt(tourist.nameEncrypted);
		const phone = tourist.phoneEncrypted ? decrypt(tourist.phoneEncrypted) : null;

		// Calculate age from DOB if available
		let age = null;
		if (tourist.dob) {
			const today = new Date();
			const birthDate = new Date(tourist.dob);
			age = today.getFullYear() - birthDate.getFullYear();
			const monthDiff = today.getMonth() - birthDate.getMonth();
			if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
				age--;
			}
		}

		// 3️⃣ Decrypt emergency contact
		let emergencyContact = null;
		if (tourist.emergencyContactEncrypted) {
			emergencyContact = JSON.parse(decrypt(tourist.emergencyContactEncrypted));
		}

		// 4️⃣ Save SOS in MongoDB immediately
		const sosAlert = new SOSAlert({
			touristId: tourist._id,
			location,
			safetyScore,
			locationName,
			sosReason,
			emergencyContact,
			status: "new",
		});
		await sosAlert.save();

		// 5️⃣ Update Risk Grid IMMEDIATELY for this location (synchronous)
		let updatedGrid = null;
		try {
			const [lng, lat] = location.coordinates;
			updatedGrid = await updateGridForLocation(lat, lng);
			console.log('✅ Grid updated immediately for SOS location');
			
			// Emit real-time grid update to all connected clients
			if (updatedGrid) {
				realtimeService.emitRiskGridUpdated({
					gridId: updatedGrid.gridId,
					riskLevel: updatedGrid.riskLevel,
					riskScore: updatedGrid.riskScore,
					location: updatedGrid.location,
					gridName: updatedGrid.gridName,
					lastUpdated: updatedGrid.lastUpdated
				}).catch(err => console.error('Grid emit error:', err));
			}
		} catch (gridErr) {
			console.error('⚠️ Failed to update grid immediately:', gridErr);
			// Don't fail the SOS - continue with response
		}

		// 6️⃣ Respond to client immediately WITH grid update info
		res.json({
			success: true,
			message: "SOS alert received. Authorities have been notified.",
			sosAlert: {
				id: sosAlert._id,
				status: sosAlert.status,
				location: sosAlert.location,
				timestamp: sosAlert.timestamp,
			},
			gridUpdated: updatedGrid ? {
				gridId: updatedGrid.gridId,
				riskLevel: updatedGrid.riskLevel,
				riskScore: updatedGrid.riskScore,
				location: updatedGrid.location
			} : null
		});

		// 7️⃣ AFTER response: emit real-time SOS to connected authorities (fire-and-forget)
		(async () => {
			try {
				const alertData = {
					alertId: sosAlert._id,
					touristId: touristId,
					touristName: name,
					phone: phone,
					age: age,
					nationality: tourist.nationality || null,
					gender: tourist.gender || null,
					bloodGroup: tourist.bloodGroup || null,
					medicalConditions: tourist.medicalConditions || null,
					allergies: tourist.allergies || null,
					emergencyContact: emergencyContact,
					location: sosAlert.location,
					locationName: sosAlert.locationName,
					timestamp: sosAlert.timestamp || new Date().toISOString(),
					safetyScore: sosAlert.safetyScore,
					sosReason: sosAlert.sosReason,
					status: sosAlert.status
				};

				realtimeService.emitSOSAlert(alertData).catch(err => {
					console.error('emitSOSAlert failed (non-blocking):', err);
				});
			} catch (err) {
				console.error('Realtime emit wrapper error:', err);
			}
		})();

		// 8️⃣ AFTER response: Sequentially log alerts on blockchain
		(async () => {
			try {
				const { v4: uuidv4 } = await import("uuid");
				const signer = contract.runner;

				// Create payload for this alert
				const eventIdRaw = uuidv4() + "|" + sosAlert._id.toString();
				const eventIdHash = sha256Hex(eventIdRaw);
				const alertId = hex64ToBytes32(eventIdHash);

				const payloadString = `${sosAlert._id}|${touristId}|${location.coordinates.join(",")}|${sosReason.reason}|${sosAlert.timestamp.toISOString()}`;
				const payloadHash = ethers.id(payloadString);

				console.log("📌 Logging SOS alert on-chain...");

				// Wait for the previous transaction to finish before sending this one
				if (!global.sosQueue) global.sosQueue = Promise.resolve();

				global.sosQueue = global.sosQueue.then(async () => {
					try {
						const tx = await contract.logAlert(alertId, payloadHash);
						const receipt = await tx.wait();

						// ⚡ Create a fresh reference to SOSAlert from DB to ensure correct scope
						const alertToUpdate = await SOSAlert.findById(sosAlert._id);
						if (!alertToUpdate) {
							console.error("❌ SOSAlert not found in DB for updating blockchain info");
							return;
						}

						alertToUpdate.blockchainTxHash = receipt.hash;
						alertToUpdate.isLoggedOnChain = true;
						alertToUpdate.alertIdOnChain = alertId;
						alertToUpdate.payloadHashOnChain = payloadHash;
						await alertToUpdate.save();

						console.log("✅ SOS logged on-chain:", receipt.hash);
					} catch (err) {
						console.error("❌ Blockchain logging error:", err);
					}
				});

				await global.sosQueue; // ensure sequence
			} catch (err) {
				console.error("❌ triggerSOS blockchain async error:", err);
			}
		})();

	} catch (err) {
		console.error("❌ triggerSOS error:", err);
		next(err);
	}
};
