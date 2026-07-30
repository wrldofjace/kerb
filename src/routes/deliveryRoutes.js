const express = require('express');
const { body, validationResult } = require('express-validator');
const router = express.Router();

const {
    getAvailableOrders,
    acceptOrder,
    updateRiderLocation,
    estimateDeliveryCost,
    verifyDeliveryAndReleaseEscrow
} = require('../controllers/deliveryController');

const { protect, restrictTo } = require('../middleware/authMiddleware');

/**
 * Helper middleware to handle request validation errors
 */
const validateRequest = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            status: 'fail',
            message: 'Validation failed',
            errors: errors.array().map(err => ({
                field: err.path,
                message: err.msg
            }))
        });
    }
    next();
};

/**
 * Validation rules for rider location updates
 */
const validateLocationUpdate = [
    body('latitude')
        .notEmpty().withMessage('Latitude is required')
        .isFloat({ min: -90, max: 90 }).withMessage('Latitude must be between -90 and 90'),
    body('longitude')
        .notEmpty().withMessage('Longitude is required')
        .isFloat({ min: -180, max: 180 }).withMessage('Longitude must be between -180 and 180'),
    validateRequest
];

/**
 * Validation rules for delivery fee estimation
 */
const validateFeeCalculation = [
    body('originLat')
        .notEmpty().withMessage('Origin latitude is required')
        .isFloat({ min: -90, max: 90 }).withMessage('Invalid origin latitude'),
    body('originLon')
        .notEmpty().withMessage('Origin longitude is required')
        .isFloat({ min: -180, max: 180 }).withMessage('Invalid origin longitude'),
    body('destLat')
        .notEmpty().withMessage('Destination latitude is required')
        .isFloat({ min: -90, max: 90 }).withMessage('Invalid destination latitude'),
    body('destLon')
        .notEmpty().withMessage('Destination longitude is required')
        .isFloat({ min: -180, max: 180 }).withMessage('Invalid destination longitude'),
    validateRequest
];

/**
 * Validation rules for OTP verification & escrow release
 */
const validateOtpVerification = [
    body('orderId')
        .notEmpty().withMessage('Order ID is required'),
    body('otp')
        .notEmpty().withMessage('OTP code is required')
        .isLength({ min: 6, max: 6 }).withMessage('OTP must be a 6-digit code')
        .isNumeric().withMessage('OTP must contain digits only'),
    validateRequest
];

/**
 * Validation rules for accepting an order
 */
const validateAcceptOrder = [
    body('orderId')
        .notEmpty().withMessage('Order ID is required'),
    validateRequest
];

// ==========================================
// Delivery Routes Configuration
// ==========================================

/**
 * @route   POST /api/v1/delivery/calculate-fee
 * @desc    Calculate distance-based delivery fee
 * @access  Public / Authenticated Users
 */
router.post('/calculate-fee', validateFeeCalculation, estimateDeliveryCost);

// Apply protection to all rider/delivery management endpoints below
router.use(protect);

/**
 * @route   GET /api/v1/delivery/available
 * @desc    Fetch available unassigned delivery orders for active riders
 * @access  Private (Riders / Admin)
 */
router.get('/available', restrictTo('rider', 'admin'), getAvailableOrders);

/**
 * @route   POST /api/v1/delivery/accept
 * @desc    Rider accepts an available order
 * @access  Private (Riders)
 */
router.post('/accept', restrictTo('rider'), validateAcceptOrder, acceptOrder);

/**
 * @route   POST /api/v1/delivery/update-location
 * @desc    Stream live GPS coordinates from rider's device
 * @access  Private (Riders)
 */
router.post('/update-location', restrictTo('rider'), validateLocationUpdate, updateRiderLocation);

/**
 * @route   POST /api/v1/delivery/verify-otp
 * @desc    Verify customer delivery OTP code & release escrow funds
 * @access  Private (Riders / Admin)
 */
router.post('/verify-otp', restrictTo('rider', 'admin'), validateOtpVerification, verifyDeliveryAndReleaseEscrow);

/**
 * @route   POST /api/v1/delivery/confirm-delivery
 * @desc    Alias route for verify-otp (Escrow release trigger)
 * @access  Private (Riders / Admin)
 */
router.post('/confirm-delivery', restrictTo('rider', 'admin'), validateOtpVerification, verifyDeliveryAndReleaseEscrow);

module.exports = router;