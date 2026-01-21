// routes/shipping.js - Shipping quote and validation routes
import { Router } from 'express';
import ups from '../services/ups.js';

const router = Router();

/**
 * POST /api/shipping/quote
 * Get shipping rates for an address
 */
router.post('/quote', async (req, res) => {
  try {
    const { address, packageInfo } = req.body;
    
    // Validate required fields
    if (!address || !address.zip || !address.state) {
      return res.status(400).json({ 
        error: 'Address with zip and state is required' 
      });
    }
    
    if (!packageInfo || !packageInfo.weight || !packageInfo.dimensions) {
      return res.status(400).json({ 
        error: 'Package info with weight and dimensions is required' 
      });
    }
    
    console.log('[Shipping] Getting rates for', {
      zip: address.zip,
      weight: packageInfo.weight,
      dimensions: packageInfo.dimensions,
    });
    
    const rates = await ups.getShippingRates(address, packageInfo);
    
    return res.json({
      success: true,
      rates,
    });
  } catch (error) {
    console.error('[Shipping] Quote error:', error);
    return res.status(500).json({ 
      error: 'Failed to get shipping rates',
      details: error.message,
    });
  }
});

/**
 * POST /api/shipping/validate
 * Validate shipping address
 */
router.post('/validate', async (req, res) => {
  try {
    const { address } = req.body;
    
    if (!address) {
      return res.status(400).json({ error: 'Address is required' });
    }
    
    const result = await ups.validateAddress(address);
    
    return res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error('[Shipping] Validation error:', error);
    return res.status(500).json({ 
      error: 'Failed to validate address',
      details: error.message,
    });
  }
});

/**
 * POST /api/shipping/calculate-package
 * Calculate package dimensions and weight from model data
 */
router.post('/calculate-package', (req, res) => {
  try {
    const { boundingBox, materialGrams } = req.body;
    
    if (!boundingBox || !materialGrams) {
      return res.status(400).json({ 
        error: 'Bounding box and material grams are required' 
      });
    }
    
    const dimensions = ups.calculatePackageDimensions(boundingBox);
    const weight = ups.calculatePackageWeight(materialGrams);
    
    return res.json({
      success: true,
      packageInfo: {
        dimensions,
        weight,
      },
    });
  } catch (error) {
    console.error('[Shipping] Package calculation error:', error);
    return res.status(500).json({ 
      error: 'Failed to calculate package info',
      details: error.message,
    });
  }
});

export default router;
