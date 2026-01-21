// utils/checkoutStorage.js - Save and restore checkout state across OAuth redirects

const STORAGE_KEY = 'surfcad_checkout';

/**
 * Save checkout state before OAuth redirect
 * @param {Object} state - Checkout state to save
 */
export function saveCheckoutState(state) {
  try {
    const {
      quoteData,
      modelData,
      currentStep,
      address,
      guestEmail,
      checkout
    } = state;

    const serialized = {
      quoteData,
      modelData,
      currentStep: currentStep || 'auth',
      address,
      guestEmail,
      checkout,
      savedAt: Date.now(),
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify(serialized));
    console.log('[CheckoutStorage] State saved');
    
    return true;
  } catch (err) {
    console.error('[CheckoutStorage] Failed to save state:', err);
    return false;
  }
}

/**
 * Restore checkout state after OAuth redirect
 * @returns {Object|null} Restored state or null
 */
export function restoreCheckoutState() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    
    if (!stored) {
      return null;
    }

    const parsed = JSON.parse(stored);
    
    // Check if state is too old (e.g., > 1 hour)
    const maxAge = 60 * 60 * 1000; // 1 hour
    if (Date.now() - parsed.savedAt > maxAge) {
      console.log('[CheckoutStorage] Stored state expired');
      clearCheckoutState();
      return null;
    }

    console.log('[CheckoutStorage] State restored');

    return {
      quoteData: parsed.quoteData,
      modelData: parsed.modelData,
      currentStep: parsed.currentStep,
      address: parsed.address,
      guestEmail: parsed.guestEmail,
    };
  } catch (err) {
    console.error('[CheckoutStorage] Failed to restore state:', err);
    clearCheckoutState();
    return null;
  }
}

/**
 * Clear stored checkout state
 */
export function clearCheckoutState() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    console.log('[CheckoutStorage] State cleared');
  } catch (err) {
    console.error('[CheckoutStorage] Failed to clear state:', err);
  }
}

/**
 * Check if there's a pending checkout to restore
 * @returns {boolean}
 */
export function hasPendingCheckout() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return false;
    
    const parsed = JSON.parse(stored);
    const maxAge = 60 * 60 * 1000;
    
    return Date.now() - parsed.savedAt < maxAge;
  } catch {
    return false;
  }
}

/**
 * Check URL for checkout return flag
 * @returns {boolean}
 */
export function hasCheckoutReturnFlag() {
  const params = new URLSearchParams(window.location.search);
  return params.get('checkout') === 'true';
}

/**
 * Clear the checkout URL flag without page reload
 */
export function clearCheckoutReturnFlag() {
  const url = new URL(window.location.href);
  url.searchParams.delete('checkout');
  url.searchParams.delete('auth'); // Also clear auth param
  window.history.replaceState({}, '', url.pathname + url.search);
}

/**
 * Get the OAuth return URL path with checkout flag
 * Returns just the path (not full URL) for server to append to frontendUrl
 * @returns {string}
 */
export function getOAuthReturnUrl() {
  // The server will prepend frontendUrl
  return '/?checkout=true';
}

export default {
  saveCheckoutState,
  restoreCheckoutState,
  clearCheckoutState,
  hasPendingCheckout,
  hasCheckoutReturnFlag,
  clearCheckoutReturnFlag,
  getOAuthReturnUrl
};