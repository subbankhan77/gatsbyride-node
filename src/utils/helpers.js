const jwt = require('jsonwebtoken');
const axios = require('axios');
require('dotenv').config();

/**
 * Generate JWT token for user
 */
function generateToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '30d',
  });
}

/**
 * Calculate distance between two coordinates (Haversine formula) in KM
 */
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(val) {
  return (val * Math.PI) / 180;
}

/**
 * Get driving distance from Google Maps API
 */
async function getDrivingDistance(origin, destination) {
  try {
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origin}&destinations=${destination}&key=${process.env.GOOGLE_KEY}`;
    const { data } = await axios.get(url);
    if (data.rows[0].elements[0].status === 'OK') {
      return {
        distance_text: data.rows[0].elements[0].distance.text,
        distance_value: data.rows[0].elements[0].distance.value, // meters
        duration_text: data.rows[0].elements[0].duration.text,
        duration_value: data.rows[0].elements[0].duration.value, // seconds
      };
    }
    return null;
  } catch (err) {
    console.error('Google Maps API error:', err.message);
    return null;
  }
}

/**
 * Calculate fare for an order
 * @param {object} category - VehicleCategory
 * @param {number} distanceKm - Actual distance in KM
 * @param {number} durationMin - Duration in minutes
 */
function calculateFare(category, distanceKm, durationMin = 0) {
  let total = parseFloat(category.base_fare) || 0;
  const km = parseFloat(distanceKm) || 0;
  const minKm = parseFloat(category.min_km) || 0;
  const minPrice = parseFloat(category.min_price) || 0;
  const pricePerKm = parseFloat(category.price_km) || 0;
  const pricePerMin = parseFloat(category.price_min) || 0;
  const extraKm = parseFloat(category.extra_km) || 0;
  const techFee = parseFloat(category.tech_fee) || 0;

  if (km <= minKm) {
    total += minPrice;
  } else {
    total += minPrice + (km - minKm) * pricePerKm;
  }

  total += durationMin * pricePerMin;
  total += extraKm;
  total += techFee;

  return parseFloat(total.toFixed(2));
}

/**
 * Get full route polyline + step-by-step directions from Google Maps Directions API
 * Returns encoded polyline so Flutter/React Native can draw road-following route on map
 */
async function getRoutePolyline(origin, destination) {
  try {
    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin}&destination=${destination}&key=${process.env.GOOGLE_KEY}`;
    const { data } = await axios.get(url);
    if (data.routes && data.routes.length > 0) {
      const route = data.routes[0];
      const leg = route.legs[0];
      return {
        polyline: route.overview_polyline.points, // encoded polyline string
        distance_text: leg.distance.text,
        distance_value: leg.distance.value,       // meters
        duration_text: leg.duration.text,
        duration_value: leg.duration.value,       // seconds
        steps: leg.steps.map((step) => ({
          instruction: step.html_instructions,
          distance: step.distance,
          duration: step.duration,
          start_location: step.start_location,
          end_location: step.end_location,
          polyline: step.polyline.points,         // per-step polyline
        })),
      };
    }
    return null;
  } catch (err) {
    console.error('Google Directions API error:', err.message);
    return null;
  }
}

/**
 * Get live ETA from driver's current location to a destination
 */
async function getLiveETA(driverLat, driverLng, destLat, destLng) {
  try {
    const origin = `${driverLat},${driverLng}`;
    const destination = `${destLat},${destLng}`;
    return await getDrivingDistance(origin, destination);
  } catch (err) {
    console.error('Live ETA error:', err.message);
    return null;
  }
}

/**
 * Calculate surge multiplier based on demand/supply ratio
 * @param {number} activeOrders - pending/active orders in area
 * @param {number} availableDrivers - free drivers in area
 * @param {object} [options]
 * @param {boolean} [options.isPeakHour] - whether current time is peak hour
 * @returns {number} surge multiplier (1.0 = normal, 1.5 = 1.5x, etc.)
 */
function getSurgeMultiplier(activeOrders, availableDrivers, { isPeakHour = false } = {}) {
  const ratio = activeOrders / Math.max(availableDrivers, 1);

  let multiplier = 1.0;
  if (ratio > 3)      multiplier = 2.0;
  else if (ratio > 2) multiplier = 1.5;
  else if (ratio > 1) multiplier = 1.2;

  // Extra 20% during peak hours (8-10am, 5-8pm, 11pm-2am)
  if (isPeakHour) multiplier = parseFloat((multiplier * 1.2).toFixed(2));

  return parseFloat(multiplier.toFixed(2));
}

/**
 * Check if current time is a peak hour
 */
function checkPeakHour() {
  const hour = new Date().getHours();
  return (hour >= 8 && hour < 10) || (hour >= 17 && hour < 20) || (hour >= 23 || hour < 2);
}

/**
 * Standard API response format
 */
function apiResponse(res, statusCode, success, message, data = null) {
  const response = { status: success, message };
  if (data !== null) response.data = data;
  return res.status(statusCode).json(response);
}

module.exports = {
  generateToken,
  haversineDistance,
  getDrivingDistance,
  getRoutePolyline,
  getLiveETA,
  getSurgeMultiplier,
  checkPeakHour,
  calculateFare,
  apiResponse,
};
