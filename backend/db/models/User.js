// db/models/User.js - User schema and model
import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import crypto from 'crypto';

const addressSchema = new mongoose.Schema({
  label: {
    type: String,
    default: 'Home',
    trim: true,
  },
  name: {
    type: String,
    required: true,
    trim: true,
  },
  street: {
    type: String,
    required: true,
    trim: true,
  },
  street2: {
    type: String,
    trim: true,
  },
  city: {
    type: String,
    required: true,
    trim: true,
  },
  state: {
    type: String,
    required: true,
    uppercase: true,
    trim: true,
  },
  zip: {
    type: String,
    required: true,
    trim: true,
  },
  country: {
    type: String,
    default: 'US',
    uppercase: true,
    trim: true,
  },
  phone: {
    type: String,
    trim: true,
  },
  isDefault: {
    type: Boolean,
    default: false,
  },
}, { _id: true });

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    index: true,
  },
  passwordHash: {
    type: String,
    default: null, // null for OAuth users
  },
  authProvider: {
    type: String,
    enum: ['local', 'google', 'apple'],
    default: 'local',
  },
  providerId: {
    type: String,
    default: null, // OAuth provider's user ID
  },
  // Name fields - support both single name and first/last
  name: {
    type: String,
    trim: true,
  },
  firstName: {
    type: String,
    trim: true,
  },
  lastName: {
    type: String,
    trim: true,
  },
  phone: {
    type: String,
    trim: true,
  },
  dob: {
    type: Date,
  },
  addresses: [addressSchema],
  
  // Account status
  emailVerified: {
    type: Boolean,
    default: false,
  },
  
  // Email verification
  verificationCode: {
    type: String,
    default: null,
  },
  verificationCodeExpires: {
    type: Date,
    default: null,
  },
  verificationAttempts: {
    type: Number,
    default: 0,
  },
  lastVerificationAttempt: {
    type: Date,
    default: null,
  },
  
  // Preferences
  preferences: {
    defaultProcess: {
      type: String,
      enum: ['FDM', 'SLA', 'SLS', 'MJF'],
      default: 'FDM',
    },
    defaultMaterial: {
      type: String,
      default: 'PLA',
    },
    marketingOptIn: {
      type: Boolean,
      default: false,
    },
  },
}, {
  timestamps: true,
});

// Indexes
userSchema.index({ authProvider: 1, providerId: 1 });
userSchema.index({ verificationCode: 1, verificationCodeExpires: 1 });

// Virtual for full name (combines firstName/lastName or falls back to name)
userSchema.virtual('fullName').get(function() {
  if (this.firstName && this.lastName) {
    return `${this.firstName} ${this.lastName}`;
  }
  if (this.firstName || this.lastName) {
    return this.firstName || this.lastName;
  }
  return this.name || null;
});

// Virtual for default address
userSchema.virtual('defaultAddress').get(function() {
  return this.addresses.find(addr => addr.isDefault) || this.addresses[0];
});

// Instance method: Set password
userSchema.methods.setPassword = async function(password) {
  const saltRounds = 12;
  this.passwordHash = await bcrypt.hash(password, saltRounds);
};

// Instance method: Verify password
userSchema.methods.verifyPassword = async function(password) {
  if (!this.passwordHash) return false;
  return bcrypt.compare(password, this.passwordHash);
};

// Instance method: Generate verification code
userSchema.methods.generateVerificationCode = function() {
  // Generate 6-digit code
  const code = crypto.randomInt(100000, 999999).toString();
  
  // Hash the code for storage (optional but more secure)
  this.verificationCode = code; // Store plain for simplicity, or hash it
  
  // Code expires in 15 minutes
  this.verificationCodeExpires = new Date(Date.now() + 15 * 60 * 1000);
  
  // Reset attempts
  this.verificationAttempts = 0;
  
  return code;
};

// Instance method: Verify the code
userSchema.methods.verifyCode = function(code) {
  // Check if code exists and hasn't expired
  if (!this.verificationCode || !this.verificationCodeExpires) {
    return { valid: false, error: 'No verification code found. Please request a new one.' };
  }
  
  // Check expiration
  if (new Date() > this.verificationCodeExpires) {
    return { valid: false, error: 'Verification code has expired. Please request a new one.' };
  }
  
  // Check attempts (max 5)
  if (this.verificationAttempts >= 5) {
    return { valid: false, error: 'Too many attempts. Please request a new code.' };
  }
  
  // Increment attempts
  this.verificationAttempts += 1;
  this.lastVerificationAttempt = new Date();
  
  // Compare codes
  if (this.verificationCode !== code) {
    const remaining = 5 - this.verificationAttempts;
    return { 
      valid: false, 
      error: `Invalid code. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.` 
    };
  }
  
  // Success - clear verification fields
  this.emailVerified = true;
  this.verificationCode = null;
  this.verificationCodeExpires = null;
  this.verificationAttempts = 0;
  
  return { valid: true };
};

// Instance method: Check if can resend code (rate limiting)
userSchema.methods.canResendCode = function() {
  if (!this.lastVerificationAttempt) return true;
  
  // Allow resend after 60 seconds
  const cooldown = 60 * 1000; // 1 minute
  const timeSinceLastAttempt = Date.now() - this.lastVerificationAttempt.getTime();
  
  if (timeSinceLastAttempt < cooldown) {
    const secondsRemaining = Math.ceil((cooldown - timeSinceLastAttempt) / 1000);
    return { allowed: false, secondsRemaining };
  }
  
  return { allowed: true };
};

// Instance method: Add or update address
userSchema.methods.upsertAddress = function(addressData, makeDefault = false) {
  if (makeDefault) {
    // Unset any existing default
    this.addresses.forEach(addr => addr.isDefault = false);
  }
  
  if (addressData._id) {
    // Update existing
    const existing = this.addresses.id(addressData._id);
    if (existing) {
      Object.assign(existing, addressData);
      if (makeDefault) existing.isDefault = true;
      return existing;
    }
  }
  
  // Add new
  const newAddress = {
    ...addressData,
    isDefault: makeDefault || this.addresses.length === 0,
  };
  this.addresses.push(newAddress);
  return this.addresses[this.addresses.length - 1];
};

// Static method: Find or create OAuth user
userSchema.statics.findOrCreateOAuth = async function(profile, provider) {
  const { id, emails, displayName, name } = profile;
  const email = emails?.[0]?.value;
  
  if (!email) {
    throw new Error('Email is required for OAuth signup');
  }
  
  // Try to find by provider ID first
  let user = await this.findOne({ authProvider: provider, providerId: id });
  
  if (user) {
    return { user, isNew: false };
  }
  
  // Check if email already exists with different provider
  user = await this.findOne({ email });
  
  if (user) {
    // Link accounts - update existing user with OAuth
    user.authProvider = provider;
    user.providerId = id;
    user.emailVerified = true; // OAuth emails are verified
    if (!user.firstName && name?.givenName) {
      user.firstName = name.givenName;
    }
    if (!user.lastName && name?.familyName) {
      user.lastName = name.familyName;
    }
    if (!user.name && displayName) {
      user.name = displayName;
    }
    await user.save();
    return { user, isNew: false };
  }
  
  // Create new user
  user = new this({
    email,
    authProvider: provider,
    providerId: id,
    firstName: name?.givenName || displayName?.split(' ')[0],
    lastName: name?.familyName || displayName?.split(' ').slice(1).join(' '),
    name: displayName || (name ? `${name.givenName || ''} ${name.familyName || ''}`.trim() : null),
    emailVerified: true, // OAuth emails are verified
  });
  
  await user.save();
  return { user, isNew: true };
};

// Transform for JSON (hide sensitive fields)
userSchema.set('toJSON', {
  virtuals: true,
  transform: (doc, ret) => {
    delete ret.passwordHash;
    delete ret.verificationCode;
    delete ret.verificationCodeExpires;
    delete ret.verificationAttempts;
    delete ret.lastVerificationAttempt;
    delete ret.__v;
    return ret;
  },
});

const User = mongoose.model('User', userSchema);

export default User;
