// routes/auth.js - Authentication routes with email verification
import { Router } from 'express';
import passport from 'passport';
import crypto from 'crypto';
import User from '../db/models/User.js';
import email from '../services/email.js';
import config from '../config/index.js';

const router = Router();

/**
 * Helper to build redirect URL with proper query param handling
 */
function buildRedirectUrl(baseUrl, returnPath, additionalParams = {}) {
  const path = returnPath.startsWith('/') ? returnPath : `/${returnPath}`;
  const url = new URL(path, baseUrl);
  
  Object.entries(additionalParams).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });
  
  return url.toString();
}

/**
 * GET /api/auth/me
 * Get current authenticated user
 */
router.get('/me', (req, res) => {
  if (req.isAuthenticated()) {
    return res.json({
      authenticated: true,
      user: req.user,
    });
  }
  
  // Return guest session info if exists
  if (req.session.guestId) {
    return res.json({
      authenticated: false,
      guest: {
        id: req.session.guestId,
        email: req.session.guestEmail,
        address: req.session.guestAddress,
      },
    });
  }
  
  return res.json({ authenticated: false });
});

/**
 * POST /api/auth/register
 * Register new user with email/password
 * Returns pendingVerification: true if email verification is required
 */
router.post('/register', async (req, res) => {
  try {
    const { email: userEmail, password, firstName, lastName, name, address } = req.body;
    
    // Validation
    if (!userEmail || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    
    const normalizedEmail = userEmail.toLowerCase();
    
    // Check if user exists
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      // If user exists but is not verified, allow re-registration (resend code)
      if (!existingUser.emailVerified && existingUser.authProvider === 'local') {
        // Generate new verification code
        const code = existingUser.generateVerificationCode();
        await existingUser.save();
        
        // Get display name for email
        const displayName = existingUser.firstName || existingUser.name || '';
        
        // Send verification email
        email.sendVerificationEmail(normalizedEmail, code, displayName).catch(console.error);
        
        return res.status(200).json({
          success: true,
          pendingVerification: true,
          email: normalizedEmail,
          message: 'Verification code sent to your email',
        });
      }
      
      return res.status(409).json({ error: 'An account with this email already exists' });
    }
    
    // Build full name from parts if provided, or use name field as fallback
    const fullName = (firstName && lastName) 
      ? `${firstName} ${lastName}`.trim()
      : name || null;
    
    // Create user with separate name fields
    const user = new User({
      email: normalizedEmail,
      firstName: firstName || null,
      lastName: lastName || null,
      name: fullName,
      authProvider: 'local',
      emailVerified: false,
    });
    
    await user.setPassword(password);
    
    // Add address if provided
    if (address) {
      user.upsertAddress(address, true);
    }
    
    // Generate verification code
    const code = user.generateVerificationCode();
    
    await user.save();
    
    // Send verification email (don't await, fire and forget)
    const displayName = firstName || fullName || '';
    email.sendVerificationEmail(normalizedEmail, code, displayName).catch(console.error);
    
    console.log(`[Auth] User registered, verification pending: ${normalizedEmail}`);
    
    // Return pending verification status (don't log in yet)
    return res.status(201).json({
      success: true,
      pendingVerification: true,
      email: normalizedEmail,
      message: 'Please check your email for the verification code',
    });
    
  } catch (error) {
    console.error('[Auth] Registration error:', error);
    return res.status(500).json({ error: 'Registration failed' });
  }
});

/**
 * POST /api/auth/verify
 * Verify email with 6-digit code
 */
router.post('/verify', async (req, res) => {
  try {
    const { email: userEmail, code } = req.body;
    
    if (!userEmail || !code) {
      return res.status(400).json({ error: 'Email and verification code are required' });
    }
    
    const normalizedEmail = userEmail.toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    if (user.emailVerified) {
      return res.status(400).json({ error: 'Email is already verified' });
    }
    
    // Verify the code
    const result = user.verifyCode(code);
    await user.save();
    
    if (!result.valid) {
      return res.status(400).json({ error: result.error });
    }
    
    console.log(`[Auth] Email verified: ${normalizedEmail}`);
    
    // Send admin notification for new verified user (don't await)
    email.sendAdminNewUserNotification(user).catch(console.error);
    
    // Log the user in
    req.login(user, (err) => {
      if (err) {
        console.error('[Auth] Login after verification failed:', err);
        return res.status(500).json({ error: 'Verification successful but login failed' });
      }
      
      // Clear guest session data
      delete req.session.guestId;
      delete req.session.guestEmail;
      delete req.session.guestAddress;
      
      return res.json({
        success: true,
        verified: true,
        user,
      });
    });
    
  } catch (error) {
    console.error('[Auth] Verification error:', error);
    return res.status(500).json({ error: 'Verification failed' });
  }
});

/**
 * POST /api/auth/resend-verification
 * Resend verification code
 */
router.post('/resend-verification', async (req, res) => {
  try {
    const { email: userEmail } = req.body;
    
    if (!userEmail) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    const normalizedEmail = userEmail.toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });
    
    if (!user) {
      // Don't reveal if user exists or not
      return res.json({ 
        success: true, 
        message: 'If an account exists, a verification code has been sent' 
      });
    }
    
    if (user.emailVerified) {
      return res.status(400).json({ error: 'Email is already verified' });
    }
    
    // Check rate limiting
    const canResend = user.canResendCode();
    if (!canResend.allowed) {
      return res.status(429).json({ 
        error: `Please wait ${canResend.secondsRemaining} seconds before requesting a new code`,
        retryAfter: canResend.secondsRemaining,
      });
    }
    
    // Generate new code
    const code = user.generateVerificationCode();
    await user.save();
    
    // Get display name for email
    const displayName = user.firstName || user.name || '';
    
    // Send email
    email.sendVerificationEmail(normalizedEmail, code, displayName).catch(console.error);
    
    console.log(`[Auth] Verification code resent to: ${normalizedEmail}`);
    
    return res.json({
      success: true,
      message: 'Verification code sent',
    });
    
  } catch (error) {
    console.error('[Auth] Resend verification error:', error);
    return res.status(500).json({ error: 'Failed to resend verification code' });
  }
});

/**
 * POST /api/auth/login
 * Login with email/password
 * Returns pendingVerification: true if email is not verified
 */
router.post('/login', async (req, res, next) => {
  try {
    const { email: userEmail, password } = req.body;
    
    if (!userEmail || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    
    const normalizedEmail = userEmail.toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });
    
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    // Check password
    const isValid = await user.verifyPassword(password);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    // Check if email is verified (only for local auth)
    if (user.authProvider === 'local' && !user.emailVerified) {
      // Generate and send new verification code
      const code = user.generateVerificationCode();
      await user.save();
      
      const displayName = user.firstName || user.name || '';
      email.sendVerificationEmail(normalizedEmail, code, displayName).catch(console.error);
      
      return res.status(200).json({
        success: true,
        pendingVerification: true,
        email: normalizedEmail,
        message: 'Please verify your email. A new code has been sent.',
      });
    }
    
    // Log in
    req.login(user, (err) => {
      if (err) {
        console.error('[Auth] Login failed:', err);
        return res.status(500).json({ error: 'Login failed' });
      }
      
      // Clear guest session data
      delete req.session.guestId;
      delete req.session.guestEmail;
      delete req.session.guestAddress;
      
      console.log(`[Auth] User logged in: ${normalizedEmail}`);
      
      return res.json({
        success: true,
        user,
      });
    });
    
  } catch (error) {
    console.error('[Auth] Login error:', error);
    return res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * POST /api/auth/logout
 * Logout current user
 */
router.post('/logout', (req, res) => {
  req.logout((err) => {
    if (err) {
      console.error('[Auth] Logout error:', err);
      return res.status(500).json({ error: 'Logout failed' });
    }
    
    req.session.destroy((destroyErr) => {
      if (destroyErr) {
        console.error('[Auth] Session destroy error:', destroyErr);
      }
      res.clearCookie('surfcad.sid');
      return res.json({ success: true });
    });
  });
});

/**
 * POST /api/auth/guest
 * Create or update guest session
 */
router.post('/guest', (req, res) => {
  const { email: guestEmail, address } = req.body;
  
  if (!guestEmail) {
    return res.status(400).json({ error: 'Email is required for guest checkout' });
  }
  
  // Create guest session
  if (!req.session.guestId) {
    req.session.guestId = crypto.randomUUID();
  }
  
  req.session.guestEmail = guestEmail.toLowerCase();
  
  if (address) {
    req.session.guestAddress = address;
  }
  
  return res.json({
    success: true,
    guest: {
      id: req.session.guestId,
      email: req.session.guestEmail,
      address: req.session.guestAddress,
    },
  });
});

/**
 * POST /api/auth/guest/convert
 * Convert guest to registered user (after order)
 */
router.post('/guest/convert', async (req, res) => {
  try {
    const { password } = req.body;
    
    if (!req.session.guestEmail) {
      return res.status(400).json({ error: 'No guest session found' });
    }
    
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    
    // Check if user already exists
    let user = await User.findOne({ email: req.session.guestEmail });
    
    if (user) {
      // User exists - could be from a previous order
      if (user.passwordHash) {
        return res.status(409).json({ error: 'Account already exists. Please log in.' });
      }
      // User exists without password (e.g., from guest order), set password
      await user.setPassword(password);
      user.emailVerified = true; // Guest conversion after order - email is implicitly verified
    } else {
      // Create new user
      user = new User({
        email: req.session.guestEmail,
        authProvider: 'local',
        emailVerified: true, // Guest conversion - email verified through order process
      });
      await user.setPassword(password);
    }
    
    // Add guest address if available
    if (req.session.guestAddress) {
      user.upsertAddress(req.session.guestAddress, true);
    }
    
    await user.save();
    
    // Send admin notification for new user
    email.sendAdminNewUserNotification(user).catch(console.error);
    
    // Log in
    req.login(user, (err) => {
      if (err) {
        return res.status(500).json({ error: 'Account created but login failed' });
      }
      
      // Clear guest data
      delete req.session.guestId;
      delete req.session.guestEmail;
      delete req.session.guestAddress;
      
      return res.json({
        success: true,
        user,
      });
    });
  } catch (error) {
    console.error('[Auth] Guest conversion error:', error);
    return res.status(500).json({ error: 'Failed to create account' });
  }
});

// ============ OAuth Routes ============

/**
 * GET /api/auth/google
 * Initiate Google OAuth
 */
router.get('/google', (req, res, next) => {
  req.session.returnTo = req.query.returnTo || '/';
  passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});

/**
 * GET /api/auth/google/callback
 * Google OAuth callback
 */
router.get('/google/callback',
  passport.authenticate('google', { failureRedirect: '/login?error=google_failed' }),
  async (req, res) => {
    const returnTo = req.session.returnTo || '/';
    delete req.session.returnTo;
    
    // Clear guest session
    delete req.session.guestId;
    delete req.session.guestEmail;
    delete req.session.guestAddress;
    
    const redirectUrl = buildRedirectUrl(config.frontendUrl, returnTo, { auth: 'success' });
    res.redirect(redirectUrl);
  }
);

/**
 * GET /api/auth/apple
 * Initiate Apple OAuth
 */
router.get('/apple', (req, res, next) => {
  // Store returnTo in session
  const returnTo = req.query.returnTo || '/';
  req.session.returnTo = returnTo;

  passport.authenticate('apple', {
  })(req, res, next);
});

/**
 * POST /api/auth/apple/callback
 * Apple OAuth callback (Apple uses POST)
 */
router.post('/apple/callback',
  (req, res, next) => {
    passport.authenticate('apple', { 
      failureRedirect: '/login?error=apple_failed',
      failureMessage: true 
    }, (err, user, info) => {
      if (err) {
        console.error('[Auth] Passport Apple error during authentication:', err);
        return res.redirect(`/login?error=apple_failed&reason=${encodeURIComponent(err.message || 'internal_error')}`);
      }

      if (!user) {
        console.error('[Auth] Apple authentication failed - no user:', info);
        const reason = info?.message || 'authentication_failed';
        return res.redirect(`/login?error=apple_failed&reason=${encodeURIComponent(reason)}`);
      }

      // Successful authentication
      req.login(user, (loginErr) => {
        if (loginErr) {
          console.error('[Auth] req.login failed after Apple auth:', loginErr);
          return res.redirect('/login?error=apple_failed');
        }

        // Get returnTo from session
        let returnTo = req.session.returnTo || '/';
        delete req.session.returnTo;

        // Clean guest session if exists
        delete req.session.guestId;
        delete req.session.guestEmail;
        delete req.session.guestAddress;

        const redirectUrl = buildRedirectUrl(config.frontendUrl, returnTo, { auth: 'success' });

        return res.redirect(redirectUrl);
      });
    })(req, res, next);
  }
);

/**
 * PUT /api/auth/address
 * Add or update user address
 */
router.put('/address', async (req, res) => {
  try {
    const { address, makeDefault } = req.body;
    
    if (!address) {
      return res.status(400).json({ error: 'Address is required' });
    }
    
    // For authenticated users
    if (req.isAuthenticated()) {
      const user = await User.findById(req.user._id);
      user.upsertAddress(address, makeDefault);
      await user.save();
      
      return res.json({
        success: true,
        addresses: user.addresses,
      });
    }
    
    // For guests
    req.session.guestAddress = address;
    return res.json({
      success: true,
      address: req.session.guestAddress,
    });
  } catch (error) {
    console.error('[Auth] Address update error:', error);
    return res.status(500).json({ error: 'Failed to update address' });
  }
});

/**
 * POST /api/auth/change-password
 * Change password for authenticated user
 */
router.post('/change-password', async (req, res) => {
  try {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    
    const { currentPassword, newPassword } = req.body;
    
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password are required' });
    }
    
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }
    
    const user = await User.findById(req.user._id);
    
    if (!user.passwordHash) {
      return res.status(400).json({ error: 'This account uses social login' });
    }
    
    const isValid = await user.verifyPassword(currentPassword);
    if (!isValid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    
    await user.setPassword(newPassword);
    await user.save();
    
    console.log(`[Auth] Password changed for: ${user.email}`);
    
    return res.json({ success: true });
  } catch (error) {
    console.error('[Auth] Change password error:', error);
    return res.status(500).json({ error: 'Failed to change password' });
  }
});

export default router;
