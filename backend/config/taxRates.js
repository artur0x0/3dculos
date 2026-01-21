// config/taxRates.js - US State Sales Tax Rates

export const STATE_TAX_RATES = {
  // States with no sales tax
  'AK': 0,      // Alaska
  'DE': 0,      // Delaware
  'MT': 0,      // Montana
  'NH': 0,      // New Hampshire
  'OR': 0,      // Oregon
  
  // States with sales tax
  'AL': 0.04,   // Alabama
  'AZ': 0.056,  // Arizona
  'AR': 0.065,  // Arkansas
  'CA': 0.0725, // California
  'CO': 0.029,  // Colorado
  'CT': 0.0635, // Connecticut
  'DC': 0.06,   // District of Columbia
  'FL': 0.06,   // Florida
  'GA': 0.04,   // Georgia
  'HI': 0.04,   // Hawaii
  'ID': 0.06,   // Idaho
  'IL': 0.0625, // Illinois
  'IN': 0.07,   // Indiana
  'IA': 0.06,   // Iowa
  'KS': 0.065,  // Kansas
  'KY': 0.06,   // Kentucky
  'LA': 0.0445, // Louisiana
  'ME': 0.055,  // Maine
  'MD': 0.06,   // Maryland
  'MA': 0.0625, // Massachusetts
  'MI': 0.06,   // Michigan
  'MN': 0.06875,// Minnesota
  'MS': 0.07,   // Mississippi
  'MO': 0.04225,// Missouri
  'NE': 0.055,  // Nebraska
  'NV': 0.0685, // Nevada
  'NJ': 0.06625,// New Jersey
  'NM': 0.05125,// New Mexico
  'NY': 0.04,   // New York
  'NC': 0.0475, // North Carolina
  'ND': 0.05,   // North Dakota
  'OH': 0.0575, // Ohio
  'OK': 0.045,  // Oklahoma
  'PA': 0.06,   // Pennsylvania
  'RI': 0.07,   // Rhode Island
  'SC': 0.06,   // South Carolina
  'SD': 0.045,  // South Dakota
  'TN': 0.07,   // Tennessee
  'TX': 0.0625, // Texas
  'UT': 0.061,  // Utah
  'VT': 0.06,   // Vermont
  'VA': 0.053,  // Virginia
  'WA': 0.065,  // Washington
  'WV': 0.06,   // West Virginia
  'WI': 0.05,   // Wisconsin
  'WY': 0.04,   // Wyoming
};

/**
 * Calculate tax for an order
 * @param {number} subtotal - Taxable amount (product + shipping if applicable)
 * @param {string} state - Two-letter state code
 * @param {string} country - Country code (only US supported)
 * @returns {{ tax: number, rate: number }}
 */
export function calculateTax(subtotal, state, country = 'US') {
  // Only calculate US taxes
  if (country !== 'US') {
    return { tax: 0, rate: 0 };
  }
  
  const stateCode = state?.toUpperCase();
  const rate = STATE_TAX_RATES[stateCode] || 0;
  const tax = Math.round(subtotal * rate * 100) / 100; // Round to cents
  
  return { tax, rate };
}

/**
 * Get tax rate for a state
 * @param {string} state - Two-letter state code
 * @returns {number} Tax rate as decimal
 */
export function getTaxRate(state) {
  return STATE_TAX_RATES[state?.toUpperCase()] || 0;
}

/**
 * Check if state has sales tax
 * @param {string} state - Two-letter state code
 * @returns {boolean}
 */
export function hasSalesTax(state) {
  return getTaxRate(state) > 0;
}

export default STATE_TAX_RATES;
