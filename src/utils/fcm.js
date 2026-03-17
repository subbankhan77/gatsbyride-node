const admin = require('firebase-admin');
const path = require('path');
require('dotenv').config();

let firebaseApp;

function initFirebase() {
  if (firebaseApp) return firebaseApp;
  const serviceAccountPath = path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './firebase-service-account.json');
  try {
    const serviceAccount = require(serviceAccountPath);
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  } catch (e) {
    console.warn('Firebase service account not found. FCM disabled.', e.message);
  }
  return firebaseApp;
}

initFirebase();

/**
 * Send FCM push notification to a single device
 * @param {string} fcmToken - Device FCM token
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {object} data - Extra data payload
 */
async function sendNotification(fcmToken, title, body, data = {}) {
  if (!firebaseApp || !fcmToken) return;

  const message = {
    token: fcmToken,
    notification: { title, body },
    data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
    android: { priority: 'high' },
    apns: { payload: { aps: { sound: 'default', badge: 1 } } },
  };

  try {
    const response = await admin.messaging().send(message);
    return response;
  } catch (err) {
    console.error('FCM send error:', err.message);
    return null;
  }
}

/**
 * Send FCM to multiple tokens
 */
async function sendMulticastNotification(tokens, title, body, data = {}) {
  if (!firebaseApp || !tokens || tokens.length === 0) return;

  const message = {
    tokens,
    notification: { title, body },
    data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
    android: { priority: 'high' },
    apns: { payload: { aps: { sound: 'default', badge: 1 } } },
  };

  try {
    const response = await admin.messaging().sendEachForMulticast(message);
    return response;
  } catch (err) {
    console.error('FCM multicast error:', err.message);
    return null;
  }
}

module.exports = { sendNotification, sendMulticastNotification };
