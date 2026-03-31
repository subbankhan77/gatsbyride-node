// Order Status
const ORDER_STATUS = {
  PENDING: 0,               // Order created, waiting for driver
  DRIVER_ACCEPT: 1,         // Driver accepted the order
  DEPARTURE_TO_CUSTOMER: 2, // Driver on the way to pickup
  ARRIVAL_AT_CUSTOMER: 3,   // Driver arrived at pickup
  DEPARTURE_TO_DESTINATION: 5, // Trip started
  ARRIVAL_AT_DESTINATION: 6,   // Reached destination
  COMPLETE: 7,              // Trip completed
  CANCEL: 8,                // Order cancelled
};

// User Status
const USER_STATUS = {
  INACTIVE: 0,
  ACTIVE: 1,
};

// Driver Order Status (online/offline)
const DRIVER_ORDER_STATUS = {
  OFFLINE: 'offline',
  ONLINE: 'online',
};

// Rating Type
const RATING_TYPE = {
  CUSTOMER_TO_DRIVER: 1,
  DRIVER_TO_CUSTOMER: 2,
};

// Payment Method
const PAYMENT_METHOD = {
  CASH: 'cash',
  CARD: 'card',
  WALLET: 'wallet',
};

// Payment Status
const PAYMENT_STATUS = {
  PENDING: 0,
  SUCCESS: 1,
  CANCEL: 2,
};

// Login Type
const LOGIN_TYPE = {
  APP: 'app',
  SOCIAL: 'social',
};

module.exports = {
  ORDER_STATUS,
  USER_STATUS,
  DRIVER_ORDER_STATUS,
  RATING_TYPE,
  PAYMENT_METHOD,
  PAYMENT_STATUS,
  LOGIN_TYPE,
};
