const router = require('express').Router();
const { body } = require('express-validator');
const { validate } = require('../utils/validation');
const c = require('../controllers/auth.controller');
const { otpLimiter, authLimiter } = require('../middleware/rateLimit');

router.post('/rider/send-otp', otpLimiter, [
  body('phone').optional({ checkFalsy: true }).isString().isLength({ min: 7, max: 20 }),
  body('email').optional({ checkFalsy: true }).isEmail()
], validate, (req, res, next) => {
  req.body.role = 'rider';
  req.body.purpose = req.body.purpose || 'login';
  return c.sendOtp(req, res, next);
});

router.post('/rider/verify-otp', authLimiter, [
  body('phone').optional({ checkFalsy: true }).isString(),
  body('email').optional({ checkFalsy: true }).isEmail(),
  body('code').isLength({ min: 4, max: 8 }), body('fullName').optional().isLength({ max: 120 })
], validate, c.verifyRider);

router.post('/driver/send-otp', otpLimiter, [
  body('phone').optional({ checkFalsy: true }).isString().isLength({ min: 7, max: 20 }),
  body('email').optional({ checkFalsy: true }).isEmail().withMessage('Enter a valid email address'),
  body('email').custom((value, { req }) => {
    if (!value && !req.body.phone) throw new Error('Enter your phone number or email address');
    return true;
  }),
  body('purpose').optional().isIn(['login', 'driver_registration'])
], validate, (req, res, next) => {
  req.body.role = 'driver';
  req.body.purpose = req.body.purpose || 'login';
  return c.sendOtp(req, res, next);
});

router.post('/driver/send-email-otp', otpLimiter, [
  body('email').isEmail(), body('purpose').optional().isIn(['driver_registration'])
], validate, (req, res, next) => { req.body.purpose = req.body.purpose || 'driver_registration'; c.sendEmailOtp(req, res, next); });

router.post('/driver/send-phone-otp', otpLimiter, [
  body('phone').isString().isLength({ min: 7, max: 20 }).withMessage('Enter a valid phone number')
], validate, c.sendDriverPhoneOtp);

router.post('/driver/verify-otp', authLimiter, [
  body('target').isString().isLength({ min: 5, max: 190 }), body('code').isLength({ min: 4, max: 8 }),
  body('purpose').optional().isIn(['login', 'driver_registration'])
], validate, (req, res, next) => { req.body.purpose = req.body.purpose || 'driver_registration'; c.verifyDriverOtp(req, res, next); });

router.post('/driver/login', authLimiter, [
  body('email').optional({ checkFalsy: true }).isEmail().withMessage('Enter a valid email address'),
  body('phone').optional({ checkFalsy: true }).isString().isLength({ min: 7, max: 20 }),
  body('code').isLength({ min: 4, max: 8 }).withMessage('A valid OTP code is required')
], validate, c.loginDriver);

router.post('/admin/login', authLimiter, [body('email').isEmail(), body('password').isString().isLength({ min: 8 })], validate, c.adminLogin);
router.post('/admin/send-sms-otp', otpLimiter, [body('email').isEmail(), body('password').isString().isLength({ min: 8 })], validate, c.adminSendSmsOtp);
router.post('/admin/verify-otp', authLimiter, [body('email').isEmail(), body('code').isLength({ min: 4, max: 8 })], validate, c.adminVerifyOtp);
router.post('/refresh', [body('refreshToken').notEmpty()], validate, c.refresh);
router.post('/logout', c.logout);

// Authenticated rider email change is under /rider/me (user routes) or public otp below
module.exports = router;
