const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const UnitSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Unit name is required']
  },
  code: {
    type: String,
    required: [true, 'Unit access code is required'],
    unique: true
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    select: false
  },
  unitType: {
    type: String,
    enum: ['POLICE', 'MEDICAL', 'FIRE', 'PATROL'],
    default: 'POLICE'
  },
  contactNumber: {
    type: String,
    required: true
  },
  
  // Real-time Status
  status: {
    type: String,
    enum: ['AVAILABLE', 'BUSY', 'OFFLINE'],
    default: 'OFFLINE'
  },
  
  // Geospatial Data
  location: {
    type: {
      type: String,
      default: 'Point',
      enum: ['Point']
    },
    coordinates: {
      type: [Number], // [longitude, latitude]
      default: [0, 0],
      index: '2dsphere' // Critical for $near queries
    }
  },
  lastLocationUpdate: {
    type: Date,
    default: Date.now
  },

  // Firebase Cloud Messaging Token for Push Notifications
  fcmToken: {
    type: String,
    select: false // Keep private unless needed
  },

  // Current Assignment
  currentAlert: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SOSAlert',
    default: null
  }
}, {
  timestamps: true
});

// Hash password before saving
UnitSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// Method to check password
UnitSchema.methods.correctPassword = async function(candidatePassword, userPassword) {
  return await bcrypt.compare(candidatePassword, userPassword);
};

const Unit = mongoose.model('Unit', UnitSchema);

module.exports = Unit;
