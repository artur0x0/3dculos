// routes/cart.js - signed-in cart sync. One merge PUT, never 409.
import { Router } from 'express';
import User from '../db/models/User.js';
import { requireAuth } from '../auth/session.js';
import {
  mergeCart,
  pruneTombstones,
  validateCartPayload,
} from '../services/cartMerge.js';

const router = Router();

function plainLine(line) {
  const o = line?.toObject ? line.toObject() : line;
  if (!o) return null;
  return {
    lineId: o.lineId,
    source: o.source,
    assemblyName: o.assemblyName,
    partId: o.partId,
    surfId: o.surfId || null,
    partName: o.partName,
    scriptHash: o.scriptHash,
    thumbDataUrl: o.thumbDataUrl || null,
    qty: o.qty,
    options: o.options || null,
    addedAt: o.addedAt,
    updatedAt: o.updatedAt,
  };
}

function plainTombstone(tomb) {
  const o = tomb?.toObject ? tomb.toObject() : tomb;
  if (!o) return null;
  return { lineId: o.lineId, deletedAt: o.deletedAt };
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(401).json({ error: 'Authentication required' });

    const tombstones = (user.cartTombstones || []).map(plainTombstone).filter(Boolean);
    const pruned = pruneTombstones(tombstones, new Date());
    if (pruned.length !== tombstones.length) {
      user.cartTombstones = pruned;
      await user.save();
    }

    return res.json({
      version: user.cartVersion || 0,
      lines: (user.cart || []).map(plainLine).filter(Boolean),
      tombstones: pruned,
    });
  } catch (error) {
    console.error('[Cart] Get error:', error);
    return res.status(500).json({ error: 'Failed to load cart' });
  }
});

router.put('/', requireAuth, async (req, res) => {
  try {
    const prepared = validateCartPayload(req.body, req.get('If-Match'));
    if (!prepared.ok) {
      return res.status(prepared.status).json({ error: prepared.error });
    }

    const user = await User.findById(req.user._id);
    if (!user) return res.status(401).json({ error: 'Authentication required' });

    const merged = mergeCart({
      serverLines: (user.cart || []).map(plainLine).filter(Boolean),
      serverTombstones: (user.cartTombstones || []).map(plainTombstone).filter(Boolean),
      serverVersion: user.cartVersion || 0,
      clientLines: prepared.lines,
      clientTombstones: prepared.tombstones,
      baseVersion: prepared.baseVersion,
      now: new Date(),
    });

    user.cart = merged.lines;
    user.cartTombstones = merged.tombstones;
    user.cartVersion = merged.version;
    await user.save();

    return res.json({
      version: merged.version,
      lines: merged.lines,
      tombstones: merged.tombstones,
      merged: merged.merged,
    });
  } catch (error) {
    console.error('[Cart] Put error:', error);
    return res.status(500).json({ error: 'Failed to save cart' });
  }
});

export default router;
