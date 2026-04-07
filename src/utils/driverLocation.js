/**
 * Driver Location — Redis Geo
 *
 * Driver location ab MySQL ki jagah Redis mein store hogi.
 * Redis Geo = in-memory geospatial index, microsecond queries.
 *
 * Keys used:
 *   drivers:geo              → Redis GeoSet (all online drivers)
 *   drivers:geo:cat:{id}     → Redis GeoSet (per vehicle category)
 *   driver:meta:{id}         → Redis Hash   (bearing, fcm_token, category etc.)
 */

const { redis } = require('../config/redis');

const GEO_ALL = 'drivers:geo';
const geoCat = (catId) => `drivers:geo:cat:${catId}`;
const metaKey = (driverId) => `driver:meta:${driverId}`;

// Driver online hua — location + meta Redis mein daalo
async function driverOnline(driverId, { latitude, longitude, bearing = 0, vehicle_category_id, fcm_token }) {
  const lng = parseFloat(longitude);
  const lat = parseFloat(latitude);
  const id = String(driverId);

  await Promise.all([
    redis.geoadd(GEO_ALL, lng, lat, id),
    vehicle_category_id ? redis.geoadd(geoCat(vehicle_category_id), lng, lat, id) : Promise.resolve(),
    redis.hset(metaKey(id),
      'latitude', lat,
      'longitude', lng,
      'bearing', bearing,
      'vehicle_category_id', vehicle_category_id || '',
      'fcm_token', fcm_token || '',
      'driver_id', id,
    ),
    redis.expire(metaKey(id), 3600), // 1 hour TTL — auto-cleanup if driver ghost-disconnects
  ]);
}

// Location update (every GPS ping — very fast, no MySQL write)
async function updateDriverLocation(driverId, { latitude, longitude, bearing = 0, vehicle_category_id }) {
  const lng = parseFloat(longitude);
  const lat = parseFloat(latitude);
  const id = String(driverId);

  const ops = [
    redis.geoadd(GEO_ALL, lng, lat, id),
    redis.hset(metaKey(id), 'latitude', lat, 'longitude', lng, 'bearing', bearing),
    redis.expire(metaKey(id), 3600),
  ];
  if (vehicle_category_id) {
    ops.push(redis.geoadd(geoCat(vehicle_category_id), lng, lat, id));
  }
  await Promise.all(ops);
}

// Driver offline — Redis se hata do
async function driverOffline(driverId) {
  const id = String(driverId);
  const meta = await redis.hgetall(metaKey(id));
  const catId = meta?.vehicle_category_id;

  await Promise.all([
    redis.zrem(GEO_ALL, id),
    catId ? redis.zrem(geoCat(catId), id) : Promise.resolve(),
    redis.del(metaKey(id)),
  ]);
}

/**
 * Nearby drivers dhundo
 * @param {number} latitude
 * @param {number} longitude
 * @param {number} radiusKm
 * @param {number|null} vehicleCategoryId  - filter by category (optional)
 * @returns {Array} [{ driver_id, distance_km, latitude, longitude, bearing, fcm_token }]
 */
async function getNearbyDrivers(latitude, longitude, radiusKm, vehicleCategoryId = null) {
  const key = vehicleCategoryId ? geoCat(vehicleCategoryId) : GEO_ALL;

  // GEORADIUS: longitude pehle aata hai Redis mein
  const results = await redis.georadius(
    key,
    parseFloat(longitude),
    parseFloat(latitude),
    radiusKm, 'km',
    'WITHCOORD', 'WITHDIST', 'COUNT', 50, 'ASC'
  );

  if (!results || results.length === 0) return [];

  // Meta (fcm_token, bearing) fetch karo parallel mein
  const pipeline = redis.pipeline();
  results.forEach(([id]) => pipeline.hgetall(metaKey(id)));
  const metas = await pipeline.exec();

  return results.map(([id, dist, [lng, lat]], i) => {
    const meta = metas[i][1] || {};
    return {
      driver_id: parseInt(id),
      distance_km: parseFloat(dist),
      latitude: parseFloat(lat),
      longitude: parseFloat(lng),
      bearing: parseFloat(meta.bearing || 0),
      fcm_token: meta.fcm_token || null,
      vehicle_category_id: meta.vehicle_category_id ? parseInt(meta.vehicle_category_id) : null,
    };
  });
}

// Single driver ki location
async function getDriverLocationFromRedis(driverId) {
  const pos = await redis.geopos(GEO_ALL, String(driverId));
  if (!pos || !pos[0]) return null;
  const meta = await redis.hgetall(metaKey(String(driverId)));
  return {
    longitude: parseFloat(pos[0][0]),
    latitude: parseFloat(pos[0][1]),
    bearing: parseFloat(meta?.bearing || 0),
  };
}

// Sabhi online drivers (map ke liye)
async function getAllOnlineDrivers() {
  // All members with positions
  const allIds = await redis.zrange(GEO_ALL, 0, -1);
  if (!allIds.length) return [];

  const pipeline = redis.pipeline();
  allIds.forEach((id) => {
    pipeline.geopos(GEO_ALL, id);
    pipeline.hgetall(metaKey(id));
  });
  const results = await pipeline.exec();

  const drivers = [];
  for (let i = 0; i < allIds.length; i++) {
    const pos = results[i * 2][1];
    const meta = results[i * 2 + 1][1] || {};
    if (pos && pos[0]) {
      drivers.push({
        driver_id: parseInt(allIds[i]),
        longitude: parseFloat(pos[0][0]),
        latitude: parseFloat(pos[0][1]),
        bearing: parseFloat(meta.bearing || 0),
        vehicle_category_id: meta.vehicle_category_id ? parseInt(meta.vehicle_category_id) : null,
        fcm_token: meta.fcm_token || null,
      });
    }
  }
  return drivers;
}

// Driver trip pe gaya — busy mark karo (dispatch skip karega)
async function setDriverBusy(driverId) {
  await redis.hset(metaKey(String(driverId)), 'is_available', '0'); // 0 = not available (busy)
}

// Trip khatam — free mark karo (dispatch mein aayega)
async function setDriverFree(driverId) {
  await redis.hset(metaKey(String(driverId)), 'is_available', '1'); // 1 = available (free)
}

module.exports = {
  driverOnline,
  updateDriverLocation,
  driverOffline,
  getNearbyDrivers,
  getDriverLocationFromRedis,
  getAllOnlineDrivers,
  setDriverBusy,
  setDriverFree,
};
