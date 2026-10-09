// routes/shipping.js - Shipping quote and validation routes
import { Router } from 'express';
import ups from '../services/ups.js';
import { previewPackages } from '../services/packOrder.js';
import { validateOrderLineCount } from '../services/orderLines.js';

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
    if (Array.isArray(req.body?.lines)) {
      const count = validateOrderLineCount(req.body.lines);
      if (!count.ok) return res.status(400).json({ error: count.error });
      for (const line of req.body.lines) {
        if (!line?.boundingBox || line.materialGrams == null) {
          return res.status(400).json({ error: 'Bounding box and material grams are required' });
        }
      }
      // Preview only. Create recomputes the boxes and does not trust this body.
      // `materialGrams` is already extended (unit × qty).
      return res.json({
        success: true,
        packageInfo: previewPackages(req.body.lines.map((line) => ({
          boundingBox: line.boundingBox,
          materialGrams: line.materialGrams,
          quantity: line.quantity,
          grams: line.materialGrams,
        }))),
      });
    }

    const { boundingBox, materialGrams, quantity } = req.body;
    
    if (!boundingBox || !materialGrams) {
      return res.status(400).json({ 
        error: 'Bounding box and material grams are required' 
      });
    }

    // `quantity` omitted → one part (old clients). Grams are already extended;
    // do not multiply them again. Copies stack on the shortest side.
    if (quantity != null && quantity !== '' && !Number.isInteger(Number(quantity))) {
      return res.status(400).json({ error: 'Quantity must be an integer from 1 to 999' });
    }
    if (quantity != null && quantity !== '' && (Number(quantity) < 1 || Number(quantity) > 999)) {
      return res.status(400).json({ error: 'Quantity must be an integer from 1 to 999' });
    }
    
    const dimensions = ups.calculatePackageDimensions(boundingBox, 1, quantity);
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
