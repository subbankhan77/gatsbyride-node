-- ============================================================
-- MySQL Performance Indexes — GatsbyRide
-- Server pe run karo: mysql -u gatsby -p gatsbyride_prod < indexes.sql
-- ============================================================

-- Orders table — most queried
ALTER TABLE orders ADD INDEX IF NOT EXISTS idx_orders_customer    (customer_id);
ALTER TABLE orders ADD INDEX IF NOT EXISTS idx_orders_driver      (driver_id);
ALTER TABLE orders ADD INDEX IF NOT EXISTS idx_orders_status      (status);
ALTER TABLE orders ADD INDEX IF NOT EXISTS idx_orders_driver_status (driver_id, status);
ALTER TABLE orders ADD INDEX IF NOT EXISTS idx_orders_pending     (status, driver_id);

-- Drivers table — location + availability queries
ALTER TABLE drivers ADD INDEX IF NOT EXISTS idx_drivers_available  (order_status, is_available, status);
ALTER TABLE drivers ADD INDEX IF NOT EXISTS idx_drivers_category   (vehicle_category_id, order_status, is_available);

-- Customers table
ALTER TABLE customers ADD INDEX IF NOT EXISTS idx_customers_email  (email);

-- Payments table
ALTER TABLE payments ADD INDEX IF NOT EXISTS idx_payments_order    (order_id);
ALTER TABLE payments ADD INDEX IF NOT EXISTS idx_payments_driver   (driver_id);

-- Ratings
ALTER TABLE rating ADD INDEX IF NOT EXISTS idx_rating_receiver     (receiver_id);
ALTER TABLE rating ADD INDEX IF NOT EXISTS idx_rating_order        (order_id);

-- Notifications
ALTER TABLE notifications ADD INDEX IF NOT EXISTS idx_notif_user   (user_id);

-- Order reject
ALTER TABLE order_reject ADD INDEX IF NOT EXISTS idx_reject_order  (order_id);
ALTER TABLE order_reject ADD INDEX IF NOT EXISTS idx_reject_driver (driver_id);

SELECT 'Indexes created successfully' AS result;
