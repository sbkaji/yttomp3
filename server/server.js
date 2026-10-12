/**
 * YouTube MP3 FFmpeg Engine Server — Production Build
 * ====================================================
 * Security: API Key auth, Helmet, CORS lockdown, Rate Limiting
 * Performance: Gzip compression, connection pooling
 * Reliability: Graceful shutdown, structured logging, input validation
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const path = require('path');
const os = require('os');
const queue = require('./queue');
const { getVideoInfo, downloadYtDlp } = require('./yt-dlp-helper');

// ─── Configuration ────────────────────────────────────────────────────────────
const NODE_ENV = process.env.NODE_ENV || 'development';
const PORT = parseInt(process.env.PORT, 10) || 3500;
const HOST = process.env.HOST || '0.0.0.0';
const API_KEY = process.env.API_KEY || '';
const PRODUCTION_URL = process.env.PRODUCTION_URL || '';
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(os.homedir(), 'Downloads', 'YouTube_MP3s');
const IS_PRODUCTION = NODE_ENV === 'production';

const app = express();
let server = null;

// ─── Trust Proxy (for reverse proxy / Nginx / Cloudflare) ────────────────────
if (IS_PRODUCTION) {
    app.set('trust proxy', 1);
}

// ─── Security Headers (Helmet) ───────────────────────────────────────────────
app.use(helmet({
    contentSecurityPolicy: false,     // API server, no HTML to protect
    crossOriginEmbedderPolicy: false, // Allow SSE cross-origin
    crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// ─── Gzip Compression ───────────────────────────────────────────────────────
app.use(compression());

// ─── Request Logging ─────────────────────────────────────────────────────────
if (IS_PRODUCTION) {
    app.use(morgan('[:date[iso]] :remote-addr :method :url :status :res[content-length] - :response-time ms'));
} else {
    app.use(morgan('dev'));
}

// ─── CORS Configuration ──────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
    'chrome-extension://*',  // All chrome extensions in dev
];

// Add production URL to allowed origins
if (PRODUCTION_URL) {
    ALLOWED_ORIGINS.push(PRODUCTION_URL);
}

// In development, also allow localhost
if (!IS_PRODUCTION) {
    ALLOWED_ORIGINS.push('http://localhost:3500');
    ALLOWED_ORIGINS.push('http://127.0.0.1:3500');
}

app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (SSE reconnects, server-to-server, curl)
        if (!origin) return callback(null, true);

        // Allow all chrome extension origins
        if (origin.startsWith('chrome-extension://')) {
            return callback(null, true);
        }

        // Check against allowed origins list
        if (ALLOWED_ORIGINS.includes(origin)) {
            return callback(null, true);
        }

        // In development, be more permissive
        if (!IS_PRODUCTION) {
            return callback(null, true);
        }

        callback(new Error(`CORS: Origin ${origin} not allowed`));
    },
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
    credentials: true
}));

// ─── Body Parser with Size Limits ────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// ─── Rate Limiting ───────────────────────────────────────────────────────────
const limiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000,  // 15 min
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 100,               // 100 requests per window
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please try again later.' },
    skip: (req) => req.path === '/health'  // Don't rate-limit health checks
});

app.use('/api/', limiter);

// ─── API Key Authentication Middleware ────────────────────────────────────────
function authenticateApiKey(req, res, next) {
    // Skip auth if no API key is configured (dev/local mode)
    if (!API_KEY || API_KEY === 'CHANGE_ME_TO_A_RANDOM_64_CHAR_HEX_STRING') {
        if (IS_PRODUCTION) {
            console.warn('[SECURITY WARNING] Server running in production without an API key!');
        }
        return next();
    }

    const providedKey = req.headers['x-api-key'] || req.query.apiKey;

    if (!providedKey) {
        return res.status(401).json({ error: 'Missing API key. Include X-API-Key header.' });
    }

    // Constant-time comparison to prevent timing attacks
    const crypto = require('crypto');
    const keyBuffer = Buffer.from(API_KEY);
    const providedBuffer = Buffer.from(String(providedKey));

    if (keyBuffer.length !== providedBuffer.length || !crypto.timingSafeEqual(keyBuffer, providedBuffer)) {
        return res.status(403).json({ error: 'Invalid API key.' });
    }

    next();
}

// Apply API key auth to all /api/* routes
app.use('/api/', authenticateApiKey);

// ─── Input Validation Helpers ────────────────────────────────────────────────
const YOUTUBE_URL_REGEX = /^https?:\/\/(www\.)?(youtube\.com\/(watch\?v=|shorts\/)|youtu\.be\/)/i;
const VALID_BITRATES = ['128k', '192k', '256k', '320k'];

function isValidYouTubeUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return YOUTUBE_URL_REGEX.test(url.trim());
}

function sanitizeBitrate(bitrate) {
    if (VALID_BITRATES.includes(bitrate)) return bitrate;
    return '320k';
}

// ─── Server-Sent Events (SSE) ────────────────────────────────────────────────
let sseClients = [];
const MAX_SSE_CLIENTS = 50;

function sendSSEEvent(res, event, data) {
    try {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (err) {
        // Client disconnected, will be cleaned up
    }
}

// Subscribe queue notifications to SSE clients
queue.subscribe(({ event, data, state }) => {
    sseClients.forEach(client => {
        sendSSEEvent(client.res, 'queue_update', { event, data, state });
    });
});

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * Health check endpoint (no auth required)
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'online',
        server: 'YouTube MP3 FFmpeg Engine',
        version: '1.0.0',
        environment: NODE_ENV,
        downloadFolder: DOWNLOAD_DIR,
        uptime: Math.floor(process.uptime()),
        sseClients: sseClients.length,
        memoryUsage: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
        timestamp: new Date().toISOString()
    });
});

/**
 * Server-Sent Events endpoint for real-time queue & progress broadcasts
 */
app.get('/api/events', (req, res) => {
    // Enforce max SSE client limit
    if (sseClients.length >= MAX_SSE_CLIENTS) {
        return res.status(503).json({ error: 'Maximum SSE connections reached. Try again later.' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx buffering for SSE
    res.flushHeaders();

    const clientId = Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    const newClient = { id: clientId, res };
    sseClients.push(newClient);

    // Send initial snapshot
    sendSSEEvent(res, 'init', { state: queue.getSnapshot() });

    // Heartbeat to keep connection alive (every 30s)
    const heartbeat = setInterval(() => {
        try {
            res.write(`: heartbeat\n\n`);
        } catch (err) {
            clearInterval(heartbeat);
        }
    }, 30000);

    req.on('close', () => {
        clearInterval(heartbeat);
        sseClients = sseClients.filter(c => c.id !== clientId);
    });
});

/**
 * Fetch Video Metadata
 */
app.get('/api/info', async (req, res) => {
    const { url } = req.query;

    if (!url) {
        return res.status(400).json({ error: 'Missing YouTube video URL parameter.' });
    }

    if (!isValidYouTubeUrl(url)) {
        return res.status(400).json({ error: 'Invalid YouTube URL format.' });
    }

    try {
        const info = await getVideoInfo(url);
        res.json(info);
    } catch (err) {
        console.error('[API /info Error]:', err.message);
        res.status(500).json({ error: 'Failed to fetch video info. Please try again.' });
    }
});

/**
 * Queue single video for download
 */
app.post('/api/download', async (req, res) => {
    const { url, bitrate } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'Missing YouTube video URL.' });
    }

    if (!isValidYouTubeUrl(url)) {
        return res.status(400).json({ error: 'Invalid YouTube URL format.' });
    }

    try {
        const item = await queue.add({ url: url.trim(), bitrate: sanitizeBitrate(bitrate) });
        res.json({ success: true, item, queueState: queue.getSnapshot() });
    } catch (err) {
        console.error('[API /download Error]:', err.message);
        res.status(500).json({ error: 'Failed to queue download. Please try again.' });
    }
});

/**
 * Queue batch videos for download
 */
app.post('/api/download-batch', async (req, res) => {
    const { urls, bitrate } = req.body;

    if (!urls || !Array.isArray(urls)) {
        return res.status(400).json({ error: 'urls must be an array of YouTube URLs.' });
    }

    if (urls.length > 20) {
        return res.status(400).json({ error: 'Maximum 20 URLs per batch request.' });
    }

    // Validate all URLs
    const validUrls = urls.filter(u => u && typeof u === 'string' && isValidYouTubeUrl(u.trim()));
    const invalidCount = urls.length - validUrls.length;

    if (validUrls.length === 0) {
        return res.status(400).json({ error: 'No valid YouTube URLs provided.' });
    }

    try {
        const items = await queue.addBatch(validUrls.map(u => u.trim()), sanitizeBitrate(bitrate));
        res.json({
            success: true,
            count: items.length,
            skippedInvalid: invalidCount,
            queueState: queue.getSnapshot()
        });
    } catch (err) {
        console.error('[API /download-batch Error]:', err.message);
        res.status(500).json({ error: 'Failed to queue batch download.' });
    }
});

/**
 * Get current Queue snapshot
 */
app.get('/api/queue', (req, res) => {
    res.json(queue.getSnapshot());
});

/**
 * Remove item from queue
 */
app.delete('/api/queue/:id', (req, res) => {
    const { id } = req.params;

    if (!id || typeof id !== 'string') {
        return res.status(400).json({ error: 'Invalid item ID.' });
    }

    const removed = queue.remove(id);
    if (removed) {
        res.json({ success: true, removed });
    } else {
        res.status(404).json({ error: 'Item not found.' });
    }
});

/**
 * Clear completed / errored items
 */
app.post('/api/queue/clear-completed', (req, res) => {
    queue.clearCompleted();
    res.json({ success: true, queueState: queue.getSnapshot() });
});

/**
 * Retry failed item
 */
app.post('/api/queue/retry/:id', (req, res) => {
    const { id } = req.params;

    if (!id || typeof id !== 'string') {
        return res.status(400).json({ error: 'Invalid item ID.' });
    }

    const retried = queue.retry(id);
    if (retried) {
        res.json({ success: true, item: retried });
    } else {
        res.status(400).json({ error: 'Item cannot be retried or not found.' });
    }
});

/**
 * Set max concurrency limit
 */
app.post('/api/settings/concurrency', (req, res) => {
    const { limit } = req.body;
    const val = parseInt(limit, 10);

    if (isNaN(val) || val < 1 || val > 5) {
        return res.status(400).json({ error: 'Concurrency limit must be between 1 and 5.' });
    }

    queue.setConcurrency(val);
    res.json({ success: true, maxConcurrency: queue.maxConcurrency });
});

// ─── 404 Handler ─────────────────────────────────────────────────────────────
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found.' });
});

// ─── Global Error Handler ────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
    // CORS errors
    if (err.message && err.message.startsWith('CORS:')) {
        return res.status(403).json({ error: err.message });
    }

    console.error('[Server Error]:', err.stack || err.message);
    res.status(500).json({ error: IS_PRODUCTION ? 'Internal server error.' : err.message });
});

// ─── Graceful Shutdown ───────────────────────────────────────────────────────
function gracefulShutdown(signal) {
    console.log(`\n[Shutdown] Received ${signal}. Closing gracefully...`);

    // Close all SSE connections
    sseClients.forEach(client => {
        try {
            sendSSEEvent(client.res, 'server_shutdown', { message: 'Server is shutting down.' });
            client.res.end();
        } catch (e) { /* ignore */ }
    });
    sseClients = [];

    if (server) {
        server.close(() => {
            console.log('[Shutdown] HTTP server closed.');
            process.exit(0);
        });

        // Force exit after 10s if graceful shutdown fails
        setTimeout(() => {
            console.error('[Shutdown] Forced exit after timeout.');
            process.exit(1);
        }, 10000);
    } else {
        process.exit(0);
    }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ─── Unhandled Rejection / Exception Handlers ────────────────────────────────
process.on('unhandledRejection', (reason, promise) => {
    console.error('[Unhandled Rejection]:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('[Uncaught Exception]:', err);
    gracefulShutdown('uncaughtException');
});

// ─── Start Server ────────────────────────────────────────────────────────────
server = app.listen(PORT, HOST, () => {
    console.log(`====================================================`);
    console.log(` 🎧 YouTube to MP3 FFmpeg Engine Server`);
    console.log(` 🚀 Environment:  ${NODE_ENV}`);
    console.log(` 🌐 Listening:    http://${HOST}:${PORT}`);
    console.log(` 📁 Download Dir: ${DOWNLOAD_DIR}`);
    console.log(` 🔑 API Key:      ${API_KEY && API_KEY !== 'CHANGE_ME_TO_A_RANDOM_64_CHAR_HEX_STRING' ? 'Configured ✓' : 'NOT SET ⚠️'}`);
    console.log(` 🛡️  Rate Limit:   ${process.env.RATE_LIMIT_MAX_REQUESTS || 100} req / ${Math.round((parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 900000) / 60000)}min`);
    console.log(`====================================================`);
});
