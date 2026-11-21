const router=require('express').Router(); const {body}=require('express-validator'); const {validate}=require('../utils/validation'); const c=require('../controllers/ride.controller');
const coords=[body('pickupLat').isFloat({min:-90,max:90}),body('pickupLng').isFloat({min:-180,max:180}),body('destinationLat').isFloat({min:-90,max:90}),body('destinationLng').isFloat({min:-180,max:180})];
// "Book for a friend": optional. The service re-validates and normalises the number; this only bounds the input size.
const friend=[body('bookedForOther').optional({nullable:true}).isBoolean().toBoolean(),body('passengerName').optional({nullable:true}).isString().isLength({max:120}),body('passengerPhone').optional({nullable:true}).isString().isLength({max:30}),body('passengerNote').optional({nullable:true}).isString().isLength({max:300})];
router.post('/quote',[body('rideType').isIn(['boda','bajaji','taxi']),...coords],validate,c.quote);
router.post('/',[body('rideType').isIn(['boda','bajaji','taxi']),body('pickupAddress').notEmpty(),body('destinationAddress').notEmpty(),body('paymentMethod').optional().isIn(['cash','wallet','momo','bank','card']),...coords,...friend],validate,c.create);
router.get('/',c.list);
router.get('/passengers',c.passengers);
router.delete('/passengers/:id',c.removePassenger);
router.get('/active',c.active);
router.get('/unrated',c.unrated);
router.get('/:id/cancel-preview',c.cancelPreview);
router.get('/:id/track',c.track);
router.get('/:id',c.get);
router.post('/:id/cancel',c.cancel);
router.post('/:id/pay',[body('method').optional().isIn(['cash','wallet','momo','bank','card']),body('phone').optional({nullable:true}).isString()],validate,c.pay);
router.post('/:id/rating',[body('stars').isInt({min:1,max:5})],validate,c.rate);
module.exports=router;
