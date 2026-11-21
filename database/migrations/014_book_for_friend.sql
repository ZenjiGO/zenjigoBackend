-- Book a ride for someone else ("Book for a friend").
-- The booker (rider_id) still owns, pays for and can cancel the ride. The passenger is the person who actually
-- rides: the driver sees and calls them, and they get the trip details + PIN by SMS.

ALTER TABLE rides
  ADD COLUMN booked_for_other TINYINT(1) NOT NULL DEFAULT 0 AFTER promo_code;

ALTER TABLE rides
  ADD COLUMN passenger_name VARCHAR(120) NULL AFTER booked_for_other;

ALTER TABLE rides
  ADD COLUMN passenger_phone VARCHAR(20) NULL AFTER passenger_name;

ALTER TABLE rides
  ADD COLUMN passenger_note VARCHAR(160) NULL AFTER passenger_phone;

CREATE INDEX idx_ride_passenger_phone
ON rides(passenger_phone, created_at);

CREATE TABLE IF NOT EXISTS rider_saved_passengers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  rider_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  phone VARCHAR(20) NOT NULL,
  times_used INT UNSIGNED NOT NULL DEFAULT 1,
  last_used_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(id),
  UNIQUE KEY uq_rider_passenger(rider_id, phone),
  KEY idx_rider_passenger_recent(rider_id, last_used_at),
  CONSTRAINT fk_saved_passenger_rider FOREIGN KEY(rider_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
