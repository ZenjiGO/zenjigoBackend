-- SMS platform (Briq Karibu): flexible OTP purposes, delivery log, per-user SMS preference.

-- OTP purposes were a closed ENUM, which made new purposes (phone_change, rider_email_change, ...)
-- fail in strict mode. A short VARCHAR keeps the same index and accepts every purpose.
ALTER TABLE otp_verifications MODIFY COLUMN purpose VARCHAR(40) NOT NULL;

CREATE TABLE IF NOT EXISTS sms_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NULL,
  recipient VARCHAR(24) NOT NULL,
  category ENUM('otp','ride','account','finance','marketing','admin','system') NOT NULL DEFAULT 'system',
  template VARCHAR(60) NULL,
  segments TINYINT UNSIGNED NOT NULL DEFAULT 1,
  status ENUM('sent','failed','skipped') NOT NULL DEFAULT 'sent',
  provider_job_id VARCHAR(100) NULL,
  error VARCHAR(255) NULL,
  body_preview VARCHAR(160) NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sms_created (created_at),
  KEY idx_sms_user (user_id, created_at),
  KEY idx_sms_status (status, created_at),
  KEY idx_sms_category (category, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Transactional SMS (codes, ride and security alerts) are always sent.
-- sms_opt_in only controls promotional / broadcast messages.
ALTER TABLE users ADD COLUMN sms_opt_in TINYINT(1) NOT NULL DEFAULT 1;

INSERT INTO app_settings (setting_key, setting_value)
VALUES ('sms_events', JSON_OBJECT(
  'ride_accepted', true, 'ride_arrived', true, 'ride_cancelled', true, 'ride_no_driver', true,
  'ride_completed', true, 'driver_status', true, 'payout_status', true, 'wallet_topup', true,
  'welcome', true, 'security', true, 'parcel_tour', true
))
ON DUPLICATE KEY UPDATE setting_key = setting_key;
