const express = require('express');
const router = express.Router();
const allocationController = require('../controllers/allocationController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

/**
 * @route   POST /api/v1/allocation/dispatch
 * @desc    Trigger automated rider allocation for pending orders
 * @access  Private (Admin / Dispatcher)
 */
router.post(
    '/dispatch',
    protect,
    restrictTo('admin', 'dispatcher'),
    allocationController.allocateRider
);

module.exports = router;