// config/index.js - Configuration loader
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load environment-specific .env file
const envFile = process.env.NODE_ENV === 'production' 
  ? '.env.production' 
  : '.env.development';

dotenv.config({ path: path.join(__dirname, '..', envFile) });

// Also load default .env as fallback
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const config = {
  env: process.env.NODE_ENV,
  port: parseInt(process.env.PORT, 10),
  frontendUrl: process.env.FRONTEND_URL,
  backendUrl: process.env.BACKEND_URL,
  
  // MongoDB
  mongodb: {
    uri: process.env.MONGODB_URI,
  },
  
  // Session
  session: {
    secret: process.env.SESSION_SECRET,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
  
  // OAuth - Google
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackUrl: `${process.env.BACKEND_URL}${process.env.GOOGLE_CALLBACK_URL}`,
  },
  
  // OAuth - Apple
  apple: {
    clientId: process.env.APPLE_CLIENT_ID,
    teamId: process.env.APPLE_TEAM_ID,
    keyId: process.env.APPLE_KEY_ID,
    privateKeyPath: process.env.APPLE_PRIVATE_KEY_PATH,
    callbackUrl: `${process.env.BACKEND_URL}${process.env.APPLE_CALLBACK_URL}`,
  },
  
  // Stripe
  stripe: {
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    secretKey: process.env.STRIPE_SECRET_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  },
  
  // UPS
  ups: {
    clientId: process.env.UPS_CLIENT_ID,
    clientSecret: process.env.UPS_CLIENT_SECRET,
    accountNumber: process.env.UPS_ACCOUNT_NUMBER,
    apiUrl: process.env.UPS_API_URL,
  },
  
  // Shipping origin
  shipFrom: {
    name: process.env.SHIP_FROM_NAME,
    street: process.env.SHIP_FROM_STREET,
    city: process.env.SHIP_FROM_CITY,
    state: process.env.SHIP_FROM_STATE,
    zip: process.env.SHIP_FROM_ZIP,
    country: process.env.SHIP_FROM_COUNTRY,
    phone: process.env.SHIP_FROM_PHONE,
  },
  
  // Azure Email
  azure: {
    commConnectionString: process.env.AZURE_COMM_CONNECTION_STRING,
    emailSender: process.env.AZURE_EMAIL_SENDER,
  },
  
  // Admin
  adminEmail: process.env.ADMIN_EMAIL,

  // Storage
  workingFolder: process.env.WORKING_FOLDER,
  uploadFolder: process.env.UPLOAD_FOLDER
};

// Validation
const requiredInProd = [
  'mongodb.uri',
  'session.secret',
  'stripe.secretKey',
  'stripe.webhookSecret',
];

if (config.env === 'production') {
  for (const key of requiredInProd) {
    const value = key.split('.').reduce((obj, k) => obj?.[k], config);
    if (!value) {
      console.error(`Missing required config: ${key}`);
      process.exit(1);
    }
  }
}

export default config;
