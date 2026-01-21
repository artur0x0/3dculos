// services/ups.js - UPS API integration for shipping quotes
import config from '../config/index.js';

// UPS Service codes and names
export const UPS_SERVICES = {
  '03': { code: 'ground', name: 'UPS Ground', days: '5-7 business days' },
  '02': { code: '2day', name: 'UPS 2nd Day Air', days: '2 business days' },
  '01': { code: 'overnight', name: 'UPS Next Day Air', days: '1 business day' },
  '13': { code: 'ground_saver', name: 'UPS Ground Saver', days: '5-7 business days' },
  '12': { code: '3day', name: 'UPS 3 Day Select', days: '3 business days' },
};

let cachedToken = null;
let tokenExpiry = null;

/**
 * Get OAuth token for UPS API
 */
async function getAccessToken() {
  if (cachedToken && tokenExpiry && Date.now() < tokenExpiry - 300000) {
    return cachedToken;
  }

  console.log('[UPS Auth] Requesting new token...');
  console.log('[UPS Auth] Using Client ID:', config.ups.clientId ? 'present' : 'MISSING');
  console.log('[UPS Auth] Client Secret:', config.ups.clientSecret ? 'present' : 'MISSING');
  console.log('[UPS Auth] API URL:', config.ups.apiUrl);

  if (!config.ups.clientId || !config.ups.clientSecret) {
    throw new Error('UPS Client ID or Client Secret is missing in configuration');
  }

  if (!config.ups.apiUrl) {
    throw new Error('UPS API base URL is not configured');
  }

  const credentials = Buffer.from(
    `${config.ups.clientId}:${config.ups.clientSecret}`
  ).toString('base64');

  let response;
  try {
    response = await fetch(`${config.ups.apiUrl}/security/v1/oauth/token`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
  } catch (networkError) {
    console.error('[UPS Auth] Network/fetch error:', networkError);
    throw new Error(`Network error contacting UPS: ${networkError.message}`);
  }

  if (!response.ok) {
    let errorText = 'No response body';
    let errorJson = null;

    try {
      errorText = await response.text();
      try {
        errorJson = JSON.parse(errorText);
      } catch {}
    } catch (e) {
      errorText = '(could not read response body)';
    }

    console.error('[UPS Auth] Token request failed');
    console.error('[UPS Auth] Status:', response.status, response.statusText);
    console.error('[UPS Auth] Response body:', errorText);
    if (errorJson) {
      console.error('[UPS Auth] Parsed error:', JSON.stringify(errorJson, null, 2));
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `UPS authentication failed (401/403) - most likely invalid Client ID or Secret`
      );
    }

    if (response.status === 429) {
      throw new Error('UPS rate limit exceeded (429)');
    }

    throw new Error(
      `UPS token request failed with status ${response.status}: ${errorText}`
    );
  }

  let data;
  try {
    data = await response.json();
  } catch (e) {
    throw new Error('Invalid JSON received from UPS token endpoint');
  }

  if (!data.access_token || !data.expires_in) {
    console.error('[UPS Auth] Invalid token response:', data);
    throw new Error('UPS returned invalid token response format');
  }

  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in * 1000);

  console.log('[UPS Auth] Token acquired successfully, expires in:', data.expires_in, 'seconds');

  return cachedToken;
}

/**
 * Calculate package dimensions from model bounding box
 * Adds padding for packaging materials
 */
export function calculatePackageDimensions(boundingBox, paddingInches = 1) {
  const mmToInches = 0.0393701;
  
  // Convert mm to inches and add padding
  const length = Math.ceil((boundingBox.width * mmToInches) + (paddingInches * 2));
  const width = Math.ceil((boundingBox.height * mmToInches) + (paddingInches * 2));
  const height = Math.ceil((boundingBox.depth * mmToInches) + (paddingInches * 2));
  
  // Minimum package size (UPS requirement)
  return {
    length: Math.max(length, 6),
    width: Math.max(width, 4),
    height: Math.max(height, 1),
  };
}

/**
 * Calculate package weight from material usage
 * Adds weight for packaging
 */
export function calculatePackageWeight(materialGrams, packagingGrams = 100) {
  const gramsToLbs = 0.00220462;
  const totalGrams = materialGrams + packagingGrams;
  const lbs = totalGrams * gramsToLbs;
  
  // UPS minimum weight is 0.1 lbs, round up to nearest 0.1
  return Math.max(0.1, Math.ceil(lbs * 10) / 10);
}

/**
 * Get shipping rates from UPS
 * @param {Object} shipTo - Destination address
 * @param {Object} packageInfo - Package dimensions and weight
 * @returns {Promise<Array>} Array of shipping options with rates
 */
export async function getShippingRates(shipTo, packageInfo) {
  // For development without UPS credentials, return mock rates
  if (!config.ups.clientId || !config.ups.clientSecret) {
    console.warn('[UPS] No credentials configured, returning mock rates');
    return getMockRates(packageInfo);
  }
  
  try {
    const token = await getAccessToken();

    console.log("[SHIPPING] Got access token");
    
    const requestBody = {
      RateRequest: {
        Request: {
          SubVersion: '2205',
          TransactionReference: {
            CustomerContext: `quote-${Date.now()}`,
          },
        },
        Shipment: {
          Shipper: {
            Name: config.shipFrom.name,
            ShipperNumber: config.ups.accountNumber,
            Address: {
              AddressLine: [config.shipFrom.street],
              City: config.shipFrom.city,
              StateProvinceCode: config.shipFrom.state,
              PostalCode: config.shipFrom.zip,
              CountryCode: config.shipFrom.country,
            },
          },
          ShipTo: {
            Name: shipTo.name || 'Customer',
            Address: {
              AddressLine: [shipTo.street, shipTo.street2].filter(Boolean),
              City: shipTo.city,
              StateProvinceCode: shipTo.state,
              PostalCode: shipTo.zip,
              CountryCode: shipTo.country || 'US',
            },
          },
          ShipFrom: {
            Name: config.shipFrom.name,
            Address: {
              AddressLine: [config.shipFrom.street],
              City: config.shipFrom.city,
              StateProvinceCode: config.shipFrom.state,
              PostalCode: config.shipFrom.zip,
              CountryCode: config.shipFrom.country,
            },
          },
          Package: {
            PackagingType: {
              Code: '02', // Customer supplied package
            },
            Dimensions: {
              UnitOfMeasurement: { Code: 'IN' },
              Length: String(packageInfo.dimensions.length),
              Width: String(packageInfo.dimensions.width),
              Height: String(packageInfo.dimensions.height),
            },
            PackageWeight: {
              UnitOfMeasurement: { Code: 'LBS' },
              Weight: String(packageInfo.weight),
            },
          },
        },
      },
    };
    
    const response = await fetch(`${config.ups.apiUrl}/api/rating/v2409/Shop`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'transId': `rate-${Date.now()}`,
        'transactionSrc': 'SurfCAD',
      },
      body: JSON.stringify(requestBody),
    });


    console.log("[SHIPPING] Got quote response from server")
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      console.error('[UPS] Rate request failed:', error);
      throw new Error(error.response?.errors?.[0]?.message || 'Failed to get shipping rates');
    }
    
    const data = await response.json();
    return parseRateResponse(data);
    
  } catch (error) {
    console.error('[UPS] Error getting rates:', error);
    // Fall back to mock rates if API fails
    console.warn('[UPS] Falling back to estimated rates');
    return getMockRates(packageInfo);
  }
}

/**
 * Parse UPS rate response into normalized format
 */
function parseRateResponse(data) {
  const ratedShipments = data.RateResponse?.RatedShipment || [];
  
  const rates = ratedShipments
    .map(shipment => {
      const serviceCode = shipment.Service?.Code;
      const serviceInfo = UPS_SERVICES[serviceCode];
      
      if (!serviceInfo) return null;
      
      const totalCharge = shipment.TotalCharges?.MonetaryValue;
      const currency = shipment.TotalCharges?.CurrencyCode || 'USD';
      
      // Calculate estimated delivery
      const businessDays = shipment.GuaranteedDelivery?.BusinessDaysInTransit;
      const deliveryDate = businessDays 
        ? calculateDeliveryDate(parseInt(businessDays))
        : null;
      
      return {
        code: serviceInfo.code,
        name: serviceInfo.name,
        price: parseFloat(totalCharge),
        currency,
        estimatedDays: serviceInfo.days,
        estimatedDelivery: deliveryDate,
        carrier: 'UPS',
        serviceCode,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.price - b.price);
  
  // Ensure we have the three main options
  const mainServices = ['ground', '2day', 'overnight'];
  return rates.filter(r => mainServices.includes(r.code));
}

/**
 * Calculate estimated delivery date
 */
function calculateDeliveryDate(businessDays) {
  const date = new Date();
  let daysAdded = 0;
  
  while (daysAdded < businessDays) {
    date.setDate(date.getDate() + 1);
    const dayOfWeek = date.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      daysAdded++;
    }
  }
  
  return date.toISOString().split('T')[0];
}

/**
 * Get mock rates for development/testing
 */
function getMockRates(packageInfo) {
  const baseRate = 8.99;
  const weightMultiplier = packageInfo.weight * 0.5;
  const sizeMultiplier = (
    packageInfo.dimensions.length * 
    packageInfo.dimensions.width * 
    packageInfo.dimensions.height
  ) / 1000;
  
  const groundRate = baseRate + weightMultiplier + sizeMultiplier;
  
  return [
    {
      code: 'ground',
      name: 'UPS Ground',
      price: Math.round(groundRate * 100) / 100,
      currency: 'USD',
      estimatedDays: '5-7 business days',
      estimatedDelivery: calculateDeliveryDate(7),
      carrier: 'UPS',
    },
    {
      code: '2day',
      name: 'UPS 2nd Day Air',
      price: Math.round((groundRate * 2.5) * 100) / 100,
      currency: 'USD',
      estimatedDays: '2 business days',
      estimatedDelivery: calculateDeliveryDate(2),
      carrier: 'UPS',
    },
    {
      code: 'overnight',
      name: 'UPS Next Day Air',
      price: Math.round((groundRate * 4) * 100) / 100,
      currency: 'USD',
      estimatedDays: '1 business day',
      estimatedDelivery: calculateDeliveryDate(1),
      carrier: 'UPS',
    },
  ];
}

/**
 * Validate address with UPS (optional)
 */
export async function validateAddress(address) {
  if (!config.ups.clientId) {
    // Skip validation if not configured
    return { valid: true, suggestions: [] };
  }
  
  try {
    const token = await getAccessToken();
    
    const response = await fetch(`${config.ups.apiUrl}/api/addressvalidation/v1/1`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'transId': `validate-${Date.now()}`,
        'transactionSrc': 'SurfCAD',
      },
      body: JSON.stringify({
        XAVRequest: {
          AddressKeyFormat: {
            AddressLine: [address.street, address.street2].filter(Boolean),
            PoliticalDivision2: address.city,
            PoliticalDivision1: address.state,
            PostcodePrimaryLow: address.zip,
            CountryCode: address.country || 'US',
          },
        },
      }),
    });
    
    if (!response.ok) {
      console.warn('[UPS] Address validation failed, proceeding anyway');
      return { valid: true, suggestions: [] };
    }
    
    const data = await response.json();
    const result = data.XAVResponse;
    
    return {
      valid: result.ValidAddressIndicator === 'true',
      ambiguous: result.AmbiguousAddressIndicator === 'true',
      suggestions: (result.Candidate || []).map(c => ({
        street: c.AddressKeyFormat?.AddressLine?.join(' '),
        city: c.AddressKeyFormat?.PoliticalDivision2,
        state: c.AddressKeyFormat?.PoliticalDivision1,
        zip: c.AddressKeyFormat?.PostcodePrimaryLow,
      })),
    };
  } catch (error) {
    console.error('[UPS] Address validation error:', error);
    return { valid: true, suggestions: [] };
  }
}

export default {
  getShippingRates,
  validateAddress,
  calculatePackageDimensions,
  calculatePackageWeight,
  UPS_SERVICES,
};
