/**
 * ONE-TIME SCRIPT: Generate geofences for existing itineraries
 * This script finds tourists/groups with existing itineraries and generates geofences for them
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Tourist = require('./models/Tourist');
const { Geofence } = require('./models/Geofence');
const { generateGeofencesForItinerary } = require('./services/itineraryGeofenceService');

const TOURIST_ID = 'T1769502833111'; // Your tourist ID

async function connectDB() {
  try {
    const mongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/smart-tourist-safety';
    await mongoose.connect(mongoURI);
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ MongoDB connection failed:', error.message);
    throw error;
  }
}

async function generateGeofencesForExistingItinerary() {
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('🔧 GENERATING GEOFENCES FOR EXISTING ITINERARY');
  console.log('════════════════════════════════════════════════════════════════\n');

  try {
    // 1. Find the tourist
    console.log(`📍 Looking for tourist: ${TOURIST_ID}`);
    const tourist = await Tourist.findOne({ touristId: TOURIST_ID });
    
    if (!tourist) {
      console.log('❌ Tourist not found');
      return;
    }

    console.log(`✅ Found tourist: ${tourist.name}`);

    // 2. Check if itinerary exists
    if (!tourist.dayWiseItinerary || tourist.dayWiseItinerary.length === 0) {
      console.log('❌ No itinerary found for this tourist');
      return;
    }

    console.log(`✅ Itinerary exists with ${tourist.dayWiseItinerary.length} day(s)`);

    // 3. Display itinerary summary
    console.log('\n📅 ITINERARY SUMMARY:');
    console.log('\n🔍 RAW ITINERARY STRUCTURE:');
    console.log(JSON.stringify(tourist.dayWiseItinerary[0], null, 2));
    
    tourist.dayWiseItinerary.forEach(day => {
      console.log(`\n  Day ${day.dayNumber} (${day.date}):`);
      if (day.nodes && day.nodes.length > 0) {
        day.nodes.forEach(node => {
          console.log(`    - [${node.type}] ${node.name}`);
          console.log(`      Location: [${node.location.coordinates[0]}, ${node.location.coordinates[1]}]`);
        });
      }
    });

    // 4. Check existing geofences
    const existingGeofences = await Geofence.find({
      sourceType: 'itinerary',
      ownerId: TOURIST_ID
    });

    console.log(`\n🗺️  Existing geofences: ${existingGeofences.length}`);

    if (existingGeofences.length > 0) {
      console.log('\n⚠️  Geofences already exist. Removing old ones first...');
      const deleteResult = await Geofence.deleteMany({
        sourceType: 'itinerary',
        ownerId: TOURIST_ID
      });
      console.log(`✅ Removed ${deleteResult.deletedCount} old geofences`);
    }

    // 5. Generate new geofences
    console.log('\n🔧 Generating geofences...');
    
    // Convert Mongoose document to plain JavaScript object
    const itineraryPlain = tourist.dayWiseItinerary.map(day => day.toObject ? day.toObject() : day);
    
    // IMPORTANT: Function signature is (ownerId, ownerType, itinerary)
    await generateGeofencesForItinerary(
      TOURIST_ID,
      'Tourist',
      itineraryPlain
    );

    // 6. Verify geofences were created
    const newGeofences = await Geofence.find({
      sourceType: 'itinerary',
      ownerId: TOURIST_ID
    }).lean();

    console.log(`\n✅ Generated ${newGeofences.length} geofences!`);

    // 7. Display geofence details
    if (newGeofences.length > 0) {
      console.log('\n📍 GEOFENCE DETAILS:');
      newGeofences.forEach((geofence, index) => {
        console.log(`\n  [${index + 1}] ${geofence.activityNodeName}`);
        console.log(`      Type: ${geofence.activityNodeType}`);
        console.log(`      Day: ${geofence.dayNumber}, Date: ${geofence.scheduledDate}`);
        console.log(`      Coords: [${geofence.coords[0]}, ${geofence.coords[1]}]`);
        console.log(`      Radius: ${geofence.radius}m`);
        console.log(`      Color: ${geofence.visualStyle?.fillColor || 'N/A'}`);
        console.log(`      Expires: ${geofence.expiresAt}`);
        console.log(`      Active: ${geofence.isActive}`);
      });
    }

    // 8. Test API endpoint
    console.log('\n\n🧪 TESTING API ENDPOINT:');
    console.log(`   Run this command to test:`);
    console.log(`   curl "http://localhost:5000/api/geofence/all-zones-styled?userId=${TOURIST_ID}"`);

    console.log('\n\n════════════════════════════════════════════════════════════════');
    console.log('✅ GEOFENCE GENERATION COMPLETE!');
    console.log('════════════════════════════════════════════════════════════════\n');

  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    console.error(error);
  }
}

async function main() {
  try {
    await connectDB();
    await generateGeofencesForExistingItinerary();
  } catch (error) {
    console.error('❌ Script failed:', error.message);
  } finally {
    await mongoose.connection.close();
    console.log('✅ Database connection closed');
    process.exit(0);
  }
}

main();
