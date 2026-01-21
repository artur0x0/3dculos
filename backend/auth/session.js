// auth/session.js - Session configuration with MongoDB store
import session from 'express-session';
import MongoStore from 'connect-mongo';
import config from '../config/index.js';

/**
 * Create session middleware with MongoDB store
 * @returns {Function} Express session middleware
 */
export function createSessionMiddleware() {
  const sessionConfig = {
    secret: config.session.secret,
    resave: false,
    saveUninitialized: false,
    name: 'surfcad.sid',
    cookie: {
      secure: config.env === 'production', // HTTPS only in production
      httpOnly: true,
      maxAge: config.session.maxAge,
      sameSite: config.env === 'production' ? 'strict' : 'lax',
    },
  };

  // Use MongoDB store if URI is configured
  if (config.mongodb.uri) {
    sessionConfig.store = MongoStore.create({
      mongoUrl: config.mongodb.uri,
      collectionName: 'sessions',
      ttl: config.session.maxAge / 1000, // TTL in seconds
      autoRemove: 'native', // Use MongoDB TTL index
      touchAfter: 24 * 60 * 60, // Only update session once per day unless changed
    });
    console.log('[Session] Using MongoDB session store');
  } else {
    console.warn('[Session] Using in-memory session store (not for production!)');
  }

  return session(sessionConfig);
}

/**
 * Middleware to ensure user is authenticated
 */
export function requireAuth(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
  return res.status(401).json({ error: 'Authentication required' });
}

/**
 * Middleware to optionally attach user (doesn't require auth)
 */
export function optionalAuth(req, res, next) {
  // User is already attached by passport if authenticated
  next();
}

/**
 * Middleware to allow guests with session
 */
export function requireGuestOrAuth(req, res, next) {
  if (req.isAuthenticated() || req.session.guestId) {
    return next();
  }
  return res.status(401).json({ error: 'Session required' });
}

export default createSessionMiddleware;
