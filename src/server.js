const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const dotenv = require('dotenv');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// 1. Load Environment Variables
dotenv.config();

// 2. Database Connection Pool
const pool = require('./config/db');

// 3. Initialize Express App & HTTP Server
const app = express();
const server = http.createServer(app);

// Allowed origins setup for production security
const allowedOrigins = (process.env.CLIENT_URL || 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim());

const corsOptions = {
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin) || process.env.NODE_ENV !== 'production') {
            callback(null, true);
        } else {
            callback(new Error(`CORS policy blocked access for origin: ${origin}`));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
};

// 4. Initialize Socket.io WebSockets
const io = new Server(server, {
    cors: corsOptions,
    pingTimeout: 60000,
    pingInterval: 25000
});

// Make `io` accessible in controllers via `req.app.get('io')`
app.set('io', io);

// Socket.io Middleware (Optional token check hook for protected socket rooms)
io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    // Standard connection check (can attach auth user data to socket instance)
    if (token) {
        socket.userId = socket.handshake.auth?.userId || null;
    }
    next();
});

// 5. Socket.io Connection & Room Management
io.on('connection', (socket) => {
    console.log(`⚡ [Socket.io] Client connected: ${socket.id}`);

    // Buyer/Rider joins a specific order tracking channel (e.g., "order:34")
    socket.on('join_order_room', (orderId) => {
        if (!orderId) return;
        const roomName = `order:${orderId}`;
        socket.join(roomName);
        console.log(`📌 [Socket.io] Client ${socket.id} joined channel: ${roomName}`);
    });

    // Rider live location broadcast for real-time tracking
    socket.on('update_rider_location', ({ orderId, lat, lon, heading }) => {
        if (!orderId || !lat || !lon) return;
        io.to(`order:${orderId}`).emit('rider_location_updated', {
            orderId,
            lat,
            lon,
            heading: heading || 0,
            timestamp: new Date().toISOString()
        });
    });

    // Leave order tracking channel
    socket.on('leave_order_room', (orderId) => {
        if (!orderId) return;
        const roomName = `order:${orderId}`;
        socket.leave(roomName);
        console.log(`🚪 [Socket.io] Client ${socket.id} left channel: ${roomName}`);
    });

    socket.on('disconnect', (reason) => {
        console.log(`❌ [Socket.io] Client disconnected: ${socket.id} (${reason})`);
    });
});

// 6. Security & Rate Limiting Middleware
app.use(helmet());
app.use(cors(corsOptions));

const generalRateLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 120, // 120 requests per minute
    standardHeaders: true,
    legacyHeaders: false,
    message: { status: 'fail', message: 'Too many requests, please try again later.' }
});

// Apply rate limiter to non-webhook routes
app.use((req, res, next) => {
    // Exclude M-Pesa webhooks from IP rate-limiting to prevent dropping Safaricom callbacks
    if (req.path.includes('/mpesa-callback') || req.path.includes('/payout-callback')) {
        return next();
    }
    return generalRateLimiter(req, res, next);
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' })); // Encoded callback parsing

// 7. Import Route Modules
const authRoutes = require('./routes/authRoutes');
const orderRoutes = require('./routes/orderRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const allocationRoutes = require('./routes/allocationRoutes');
const deliveryRoutes = require('./routes/deliveryRoutes');
const vendorRoutes = require('./routes/vendorRoutes');

// 8. Mount Route Handlers
app.use('/api/auth', authRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/allocations', allocationRoutes);
app.use('/api/deliveries', deliveryRoutes);
app.use('/api/vendors', vendorRoutes);

// 9. Detailed Health Check Endpoint
app.get('/health', async (req, res) => {
    try {
        const dbStart = Date.now();
        await pool.query('SELECT 1');
        const dbLatency = Date.now() - dbStart;

        res.status(200).json({
            status: 'OK',
            service: 'E-Commerce Delivery Engine',
            environment: process.env.NODE_ENV || 'development',
            dbStatus: 'connected',
            dbLatency: `${dbLatency}ms`,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        res.status(500).json({
            status: 'ERROR',
            service: 'E-Commerce Delivery Engine',
            dbStatus: 'disconnected',
            error: err.message,
            timestamp: new Date().toISOString()
        });
    }
});

// 10. 404 Catch-All Middleware
app.use((req, res) => {
    res.status(404).json({
        status: 'fail',
        message: `Route not found: ${req.method} ${req.originalUrl}`
    });
});

// 11. Centralized Global Error Handler
app.use((err, req, res, next) => {
    console.error('🔥 [Unhandled Application Error]:', err.stack || err.message);

    const statusCode = err.statusCode || err.status || 500;
    res.status(statusCode).json({
        status: 'error',
        message: process.env.NODE_ENV === 'production' && statusCode === 500
            ? 'Internal server error'
            : err.message || 'Internal server error',
        ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
    });
});

// 12. Start Express & WebSocket Server
const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
    console.log(`\n==================================================`);
    console.log(`🚀 Engine active in [${process.env.NODE_ENV || 'development'}] mode on port ${PORT}`);
    console.log(`📡 Socket.io WebSockets operational`);
    console.log(`==================================================\n`);
});

// 13. Graceful Shutdown & Unhandled Process Rejection Handlers
const gracefulShutdown = (signal) => {
    console.log(`\n⚠️  [${signal}] signal received. Terminating processes gracefully...`);

    server.close(async () => {
        try {
            await pool.end();
            console.log('✅ PostgreSQL connection pool drained.');
            console.log('👋 HTTP & WebSocket servers terminated successfully.');
            process.exit(0);
        } catch (dbErr) {
            console.error('❌ Error shutting down PostgreSQL pool:', dbErr);
            process.exit(1);
        }
    });

    // Force shutdown after 10s if connections hanging
    setTimeout(() => {
        console.error('❌ Forced shutdown due to lingering connections.');
        process.exit(1);
    }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason, promise) => {
    console.error('🔥 Unhandled Promise Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('🔥 Uncaught Exception thrown:', err);
    gracefulShutdown('UNCAUGHT_EXCEPTION');
});