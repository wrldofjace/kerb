const { body, validationResult } = require('express-validator');

// Validation Handler Middleware
const validate = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ 
            error: 'Validation failed', 
            details: errors.array().map(err => ({ field: err.path, message: err.msg })) 
        });
    }
    next();
};

// 1. Checkout Validation
const validateCheckout = [
    body('shopId').isInt().withMessage('shopId must be an integer'),
    body('itemTotal').isFloat({ min: 1 }).withMessage('itemTotal must be a positive number'),
    body('lat').isFloat({ min: -90, max: 90 }).withMessage('lat must be between -90 and 90'),
    body('lng').isFloat({ min: -180, max: 180 }).withMessage('lng must be between -180 and 180'),
    validate
];

// 2. Delivery Accept Validation
const validateAcceptDelivery = [
    body('orderId').isInt().withMessage('orderId must be an integer'),
    body('riderId').isInt().withMessage('riderId must be an integer'),
    validate
];

// 3. OTP Verification Validation
const validateOtpVerification = [
    body('orderId').isInt().withMessage('orderId must be an integer'),
    body('riderId').isInt().withMessage('riderId must be an integer'),
    body('inputOtp')
        .isString()
        .trim()
        .isLength({ min: 4, max: 4 })
        .isNumeric()
        .withMessage('inputOtp must be a 4-digit numeric code'),
    validate
];

// 4. GPS Location Update Validation
const validateLocationUpdate = [
    body('riderId').isInt().withMessage('riderId must be an integer'),
    body('latitude').isFloat({ min: -90, max: 90 }).withMessage('latitude must be between -90 and 90'),
    body('longitude').isFloat({ min: -180, max: 180 }).withMessage('longitude must be between -180 and 180'),
    validate
];

module.exports = {
    validateCheckout,
    validateAcceptDelivery,
    validateOtpVerification,
    validateLocationUpdate
};