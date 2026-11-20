# SMS platform (Briq Karibu)

All SMS leaves the system through `src/services/sms.service.js` (one retry on 5xx, delivery log in `sms_logs`,
OTP codes redacted before logging). Event messages live in `src/services/sms.events.js`.

## Where SMS is used
| Area | Trigger | Channel |
|---|---|---|
| Rider sign-up | phone + email submitted | SMS code (purpose `signup`); the phone must be new |
| Rider sign-in | phone only / email only | SMS or email code |
| Rider phone change | `/rider/phone-change/*` | SMS code to the NEW number, alert SMS to the old number |
| Driver registration | `/auth/driver/send-phone-otp` | SMS code (`driver_registration_phone`) plus email code; both required |
| Driver sign-in | phone or email | SMS or email code |
| Driver phone change | `/driver/phone-change/*` | SMS code to the new number, then an admin-approved change request |
| Admin sign-in | email + password, then code | email code, or SMS to the admin phone on request |
| Ride | accepted (driver, plate, trip PIN), arrived, cancelled, no driver, completed | SMS to rider |
| Driver account | approved / rejected / suspended, payout status, commission due | SMS to driver |
| Wallet | top-up received | SMS to rider |
| Parcels / tours | booking confirmed | SMS to rider |
| Admin | SMS Center: test, one person, numbers, riders, drivers, online drivers | SMS |

Transactional SMS ignore `users.sms_opt_in`; admin broadcasts respect it.
Each automatic message can be switched off in Admin > SMS Center.

## Deploy
1. Set `BRIQ_API_KEY` (and `BRIQ_APP_ID`, `BRIQ_SENDER_ID`) in the backend `.env`. The sender must be approved on your Briq account.
2. Run `npm run migrate`. Migration `013_sms_platform.sql` changes `otp_verifications.purpose` from ENUM to VARCHAR
   (this also fixes the rider email-change OTP, which used a purpose missing from the ENUM), creates `sms_logs`
   and adds `users.sms_opt_in`.
3. Give every admin a real phone number to enable SMS sign-in. The seed placeholder `+255700000001` is ignored.
4. Open Admin > SMS Center and send a test message.
5. Optional browser auto-fill: set `OTP_WEBOTP_DOMAIN` to your web domain.
