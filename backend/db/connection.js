// db/connection.js - MongoDB connection manager
import mongoose from 'mongoose';
import config from '../config/index.js';

let isConnected = false;

export const connectDB = async () => {
  if (isConnected) {
    console.log('[DB] Using existing connection');
    return;
  }

  if (!config.mongodb.uri) {
    console.error('[DB] MONGODB_URI not configured');
    throw new Error('MongoDB URI not configured');
  }

  try {
    const options = {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    };

    await mongoose.connect(config.mongodb.uri, options);
    isConnected = true;
    
    console.log('[DB] Connected to MongoDB Atlas');

    mongoose.connection.on('error', (err) => {
      console.error('[DB] Connection error:', err);
      isConnected = false;
    });

    mongoose.connection.on('disconnected', () => {
      console.warn('[DB] Disconnected from MongoDB');
      isConnected = false;
    });

  } catch (error) {
    console.error('[DB] Connection failed:', error);
    throw error;
  }
};

export const disconnectDB = async () => {
  if (!isConnected) return;
  
  await mongoose.disconnect();
  isConnected = false;
  console.log('[DB] Disconnected from MongoDB');
};

export default mongoose;
