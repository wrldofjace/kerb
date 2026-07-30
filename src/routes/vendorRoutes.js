const express = require('express');
const { body, param, validationResult } = require('express-validator');
const router = express.Router();

const {
    getVendorBalance,
    requestPayout,
    handlePayoutCallback
} = require('../controllers/vendorController');

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
 * Validation rules for shopId route parameter
 */
const validateShopId = [
    param('shopId')
        .notEmpty().withMessage('Shop ID parameter is required')
        .isInt({ min: 1 }).withMessage('Shop ID must be a valid integer'),
    validateRequest
];

/**
 * Validation rules for vendor payout/withdrawal request
 */
const validatePayoutRequest = [
    body('shopId')
        .notEmpty().withMessage('Shop ID is required')
        .isInt({ min: 1 }).withMessage('Shop ID must be a valid integer'),

    body('amount')
        .notEmpty().withMessage('Payout amount is required')
        .isFloat({ min: 10 }).withMessage('Minimum payout amount is KES 10'),

    body('phoneNumber')
        .trim()
        .notEmpty().withMessage('M-Pesa phone number is required')
        .matches(/^(?:254|\+254|0)?(7|1)\d{8}$/).withMessage('Please provide a valid Safaricom phone number'),

    validateRequest
];

// ==========================================
// Vendor Routes Configuration
// ==========================================

/**
 * @route   POST /api/v1/vendors/payout-callback
 * @desc    M-Pesa B2C webhook result callback from Safaricom
 * @access  Public (Safaricom Gateway)
 */
router.post('/payout-callback', handlePayoutCallback);

// Apply authentication guard to protected vendor routes
router.use(protect);

/**
 * @route   GET /api/v1/vendors/:shopId/balance
 * @route   GET /api/v1/vendors/balance/:shopId
 * @desc    Fetch clearable balance & financial metrics for a specific shop
 * @access  Private (Vendor / Admin)
 */
router.get('/:shopId/balance', restrictTo('vendor', 'admin'), validateShopId, getVendorBalance);
router.get('/balance/:shopId', restrictTo('vendor', 'admin'), validateShopId, getVendorBalance);

/**
 * @route   POST /api/v1/vendors/payout
 * @route   POST /api/v1/vendors/withdraw
 * @desc    Initiate M-Pesa B2C payout to vendor account
 * @access  Private (Vendor / Admin)
 */
router.post('/payout', restrictTo('vendor', 'admin'), validatePayoutRequest, requestPayout);
router.post('/withdraw', restrictTo('vendor', 'admin'), validatePayoutRequest, requestPayout);

module.exports = router;