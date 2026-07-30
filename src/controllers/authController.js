const asyncHandler = require('express-async-handler');
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { generateUserToken } = require('../utils/token');
const logger = require('../utils/logger');
const { AppError } = require('../middleware/errorHandler');

const ALLOWED_ROLES = ['buyer', 'rider'];

/**
 * @desc    Register a new user
 * @route   POST /api/auth/register
 * @access  Public
 */
exports.register = asyncHandler(async (req, res) => {
    let { username, email, password, role } = req.body;

    if (!username || !email || !password) {
        throw new AppError('Username, email, and password are required fields.', 400);
    }

    if (password.length < 6) {
        throw new AppError('Password must be at least 6 characters long.', 400);
    }

    const sanitizedEmail = email.trim().toLowerCase();
    const sanitizedUsername = username.trim();
    const userRole = ALLOWED_ROLES.includes(role) ? role : 'buyer';

    // 1. Check if username or email already exists
    const userExists = await db.query(
        'SELECT id FROM public.users WHERE LOWER(email) = $1 OR LOWER(username) = LOWER($2)',
        [sanitizedEmail, sanitizedUsername]
    );

    if (userExists.rows.length > 0) {
        throw new AppError('Username or Email is already registered', 400);
    }

    // 2. Hash password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // 3. Save new user to DB
    const newUser = await db.query(
        `INSERT INTO public.users (username, email, password_hash, role) 
         VALUES ($1, $2, $3, $4) 
         RETURNING id, username, email, role, created_at`,
        [sanitizedUsername, sanitizedEmail, passwordHash, userRole]
    );

    const createdUser = newUser.rows[0];

    logger.info(`[User Registered] User ID #${createdUser.id} (${createdUser.username}) registered as ${createdUser.role}`);

    res.status(201).json({
        message: 'User registered successfully',
        user: {
            id: createdUser.id,
            username: createdUser.username,
            email: createdUser.email,
            role: createdUser.role,
        },
    });
});

/**
 * @desc    Authenticate user & get token
 * @route   POST /api/auth/login
 * @access  Public
 */
exports.login = asyncHandler(async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        throw new AppError('Email and password are required', 400);
    }

    const sanitizedEmail = email.trim().toLowerCase();

    // 1. Find user by email
    const result = await db.query(
        'SELECT id, username, email, password_hash, role FROM public.users WHERE LOWER(email) = $1',
        [sanitizedEmail]
    );

    if (result.rows.length === 0) {
        throw new AppError('Invalid email or password credentials', 400);
    }

    const user = result.rows[0];

    // 2. Compare password hash
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
        throw new AppError('Invalid email or password credentials', 400);
    }

    // 3. Generate token using token utility helper
    const token = generateUserToken(user);

    logger.info(`[User Login] User ID #${user.id} (${user.username}) logged in successfully`);

    res.status(200).json({
        message: 'Login successful',
        token,
        user: {
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.role,
        },
    });
});