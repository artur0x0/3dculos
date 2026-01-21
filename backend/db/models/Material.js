// db/models/Material.js - Material catalog schema
import mongoose from 'mongoose';

const materialSchema = new mongoose.Schema({
  process: {
    type: String,
    required: true,
    enum: ['FDM', 'SLA', 'SLS', 'MJF'],
  },
  name: {
    type: String,
    required: true,
    trim: true,
  },
  'display-name': {
    type: String,
    trim: true,
  },
  color: {
    type: String,
    trim: true,
  },
  'density-g-cm3': {
    type: Number,
    required: true,
  },
  'cost-per-gram': {
    type: Number,
    required: true,
  },
  'is-active': {
    type: Boolean,
    default: true,
  },
  properties: {
    strength: String,
    flexibility: String,
    'heat-resistance': String,
    'surface-finish': String,
  },
}, {
  timestamps: {
    createdAt: 'created-at',
    updatedAt: 'updated-at',
  },
  collection: 'materials',
});

// Compound unique index
materialSchema.index({ process: 1, name: 1 }, { unique: true });
materialSchema.index({ 'is-active': 1 });

// Static: Get active materials by process
materialSchema.statics.getByProcess = function(process) {
  return this.find({ process, 'is-active': true }).sort({ name: 1 });
};

// Static: Get all active materials grouped by process
materialSchema.statics.getAllActive = async function() {
  const materials = await this.find({ 'is-active': true }).sort({ process: 1, name: 1 });
  
  return materials.reduce((acc, mat) => {
    if (!acc[mat.process]) acc[mat.process] = [];
    acc[mat.process].push(mat);
    return acc;
  }, {});
};

// Seed data helper
materialSchema.statics.seedDefaults = async function() {
  const defaults = [
    // FDM Materials
    { process: 'FDM', name: 'PLA', 'display-name': 'PLA', color: 'Various', 'density-g-cm3': 1.24, 'cost-per-gram': 0.025, properties: { strength: 'Medium', flexibility: 'Low', 'heat-resistance': 'Low', 'surface-finish': 'Good' } },
    { process: 'FDM', name: 'ABS', 'display-name': 'ABS', color: 'Various', 'density-g-cm3': 1.04, 'cost-per-gram': 0.030, properties: { strength: 'High', flexibility: 'Medium', 'heat-resistance': 'Medium', 'surface-finish': 'Good' } },
    { process: 'FDM', name: 'PETG', 'display-name': 'PETG', color: 'Various', 'density-g-cm3': 1.27, 'cost-per-gram': 0.035, properties: { strength: 'High', flexibility: 'Medium', 'heat-resistance': 'Medium', 'surface-finish': 'Excellent' } },
    { process: 'FDM', name: 'TPU', 'display-name': 'TPU (Flexible)', color: 'Various', 'density-g-cm3': 1.21, 'cost-per-gram': 0.055, properties: { strength: 'Medium', flexibility: 'Very High', 'heat-resistance': 'Low', 'surface-finish': 'Good' } },
    { process: 'FDM', name: 'Nylon', 'display-name': 'Nylon', color: 'Natural/Black', 'density-g-cm3': 1.14, 'cost-per-gram': 0.065, properties: { strength: 'Very High', flexibility: 'Medium', 'heat-resistance': 'High', 'surface-finish': 'Good' } },
    
    // SLA Materials
    { process: 'SLA', name: 'Standard', 'display-name': 'Standard Resin', color: 'Grey/White/Black', 'density-g-cm3': 1.10, 'cost-per-gram': 0.080, properties: { strength: 'Medium', flexibility: 'Low', 'heat-resistance': 'Low', 'surface-finish': 'Excellent' } },
    { process: 'SLA', name: 'Tough', 'display-name': 'Tough Resin', color: 'Grey', 'density-g-cm3': 1.15, 'cost-per-gram': 0.120, properties: { strength: 'High', flexibility: 'Medium', 'heat-resistance': 'Medium', 'surface-finish': 'Excellent' } },
    { process: 'SLA', name: 'Flexible', 'display-name': 'Flexible Resin', color: 'Black', 'density-g-cm3': 1.05, 'cost-per-gram': 0.150, properties: { strength: 'Low', flexibility: 'Very High', 'heat-resistance': 'Low', 'surface-finish': 'Good' } },
    { process: 'SLA', name: 'Dental', 'display-name': 'Dental Resin', color: 'Clear', 'density-g-cm3': 1.20, 'cost-per-gram': 0.200, properties: { strength: 'High', flexibility: 'Low', 'heat-resistance': 'High', 'surface-finish': 'Excellent' } },
    
    // SLS Materials
    { process: 'SLS', name: 'Nylon12', 'display-name': 'Nylon 12 (PA12)', color: 'White/Grey', 'density-g-cm3': 1.01, 'cost-per-gram': 0.100, properties: { strength: 'Very High', flexibility: 'Medium', 'heat-resistance': 'High', 'surface-finish': 'Good' } },
    { process: 'SLS', name: 'Nylon11', 'display-name': 'Nylon 11 (PA11)', color: 'Natural', 'density-g-cm3': 1.03, 'cost-per-gram': 0.120, properties: { strength: 'High', flexibility: 'High', 'heat-resistance': 'High', 'surface-finish': 'Good' } },
    { process: 'SLS', name: 'GlassFilled', 'display-name': 'Glass-Filled Nylon', color: 'Grey', 'density-g-cm3': 1.35, 'cost-per-gram': 0.150, properties: { strength: 'Very High', flexibility: 'Low', 'heat-resistance': 'Very High', 'surface-finish': 'Rough' } },
    
    // MJF Materials  
    { process: 'MJF', name: 'PA12', 'display-name': 'HP PA12', color: 'Grey', 'density-g-cm3': 1.01, 'cost-per-gram': 0.090, properties: { strength: 'Very High', flexibility: 'Medium', 'heat-resistance': 'High', 'surface-finish': 'Good' } },
    { process: 'MJF', name: 'PA12GB', 'display-name': 'HP PA12 Glass Beads', color: 'Grey', 'density-g-cm3': 1.30, 'cost-per-gram': 0.130, properties: { strength: 'Very High', flexibility: 'Low', 'heat-resistance': 'Very High', 'surface-finish': 'Good' } },
  ];
  
  for (const mat of defaults) {
    await this.findOneAndUpdate(
      { process: mat.process, name: mat.name },
      mat,
      { upsert: true, new: true }
    );
  }
  
  console.log(`[Materials] Seeded ${defaults.length} default materials`);
};

const Material = mongoose.model('Material', materialSchema);

export default Material;
