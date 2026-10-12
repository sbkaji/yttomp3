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
const fs = require('fs');
const path = require('path');
const os = require('os');
const queue = require('./queue');
const history = require('./history');
const {
    getVideoInfo,
    downloadYtDlp,
    ensureFFmpeg,
    TEMP_DIR,
    getYtDlpPath,
    getFFmpegPath,
    OS_PLATFORM,
    OS_ARCH,
    IS_WIN
} = require('./yt-dlp-helper');

// ─── Configuration & Cross-Platform OS Adaptation ───────────────────────────
const cliArgs = process.argv.slice(2);
const isProdCli = cliArgs.includes('--production') || cliArgs.includes('-p');
const NODE_ENV = isProdCli ? 'production' : (process.env.NODE_ENV || 'development');
const PORT = parseInt(process.env.PORT, 10) || 3500;
const HOST = process.env.HOST || '0.0.0.0';
const API_KEY = process.env.API_KEY || '';
const PRODUCTION_URL = process.env.PRODUCTION_URL || '';

function resolveDefaultDownloadDir() {
    try {
        const home = os.homedir();
        if (home) {
            return path.join(home, 'Downloads', 'YouTube_MP3s');
        }
    } catch (e) {}
    return path.join(__dirname, 'downloads');
}

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || resolveDefaultDownloadDir();
const IS_PRODUCTION = NODE_ENV === 'production';

// Ensure required working directories exist with proper OS permissions
try {
    if (!fs.existsSync(DOWNLOAD_DIR)) {
        fs.mkdirSync(DOWNLOAD_DIR, { recursive: true, mode: 0o777 });
    }
    if (!fs.existsSync(TEMP_DIR)) {
        fs.mkdirSync(TEMP_DIR, { recursive: true, mode: 0o777 });
    }
} catch (e) {
    console.warn('[Directory Init Warning]:', e.message);
}

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
const configuredOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);

const ALLOWED_ORIGINS = [
    'https://www.youtube.com',
    'https://m.youtube.com',
    ...configuredOrigins
];

// Add production URL to allowed origins
if (PRODUCTION_URL) {
    ALLOWED_ORIGINS.push(PRODUCTION_URL.replace(/\/+$/, ''));
}

// In development or if ALLOW_ALL_ORIGINS is enabled, allow local dev hosts
if (!IS_PRODUCTION || process.env.ALLOW_ALL_ORIGINS === 'true') {
    ALLOWED_ORIGINS.push('http://localhost:3500');
    ALLOWED_ORIGINS.push('http://127.0.0.1:3500');
    ALLOWED_ORIGINS.push(`http://localhost:${PORT}`);
    ALLOWED_ORIGINS.push(`http://127.0.0.1:${PORT}`);
}

app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (SSE reconnects, server-to-server, curl)
        if (!origin) return callback(null, true);

        // Allow all chrome extension origins
        if (origin.startsWith('chrome-extension://')) {
            return callback(null, true);
        }

        // Allow YouTube web origins for content script communication
        if (origin.includes('youtube.com')) {
            return callback(null, true);
        }

        // Check against allowed origins list
        if (ALLOWED_ORIGINS.includes(origin)) {
            return callback(null, true);
        }

        // In development, be permissive
        if (!IS_PRODUCTION || process.env.ALLOW_ALL_ORIGINS === 'true') {
            return callback(null, true);
        }

        callback(new Error(`CORS: Origin ${origin} not allowed`));
    },
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Admin-Key'],
    credentials: true
}));

// Clean up any stale orphaned temp files on server startup
try {
    if (fs.existsSync(TEMP_DIR)) {
        const staleFiles = fs.readdirSync(TEMP_DIR);
        let cleanedCount = 0;
        for (const f of staleFiles) {
            try {
                fs.unlinkSync(path.join(TEMP_DIR, f));
                cleanedCount++;
            } catch (e) {}
        }
        if (cleanedCount > 0) {
            console.log(`[Storage Init] Reclaimed storage: cleaned ${cleanedCount} orphaned temporary file(s).`);
        }
    }
} catch (e) {
    console.warn('[Storage Init Warning]:', e.message);
}

// ─── Body Parser with Size Limits ────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// ─── Rate Limiting & DoS Protection ──────────────────────────────────────────
// 1) Dedicated submission limiter for resource-heavy conversions
const submissionLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: parseInt(process.env.RATE_LIMIT_SUBMISSIONS_PER_MIN, 10) || 30, // 30 submissions per min per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many conversion requests. Please wait a minute before submitting more.' }
});

app.use('/api/download', submissionLimiter);
app.use('/api/download-batch', submissionLimiter);

// 2) General API limiter for polling and status checks
const limiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000,  // 15 min
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 300,               // 300 requests per window
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please try again later.' },
    skip: (req) => req.path === '/health'  // Don't rate-limit health checks
});

app.use('/api/', limiter);

// ─── API Key Authentication Middleware ────────────────────────────────────────
function authenticateApiKey(req, res, next) {
    // Allow download-file endpoint with valid temporary download token
    if (req.path.startsWith('/download-file/')) {
        const id = req.path.replace('/download-file/', '').split('/')[0].split('?')[0];
        const item = queue.getItem(id);
        const token = (req.query.token || '').trim();
        if (item && token && item.downloadToken && token === item.downloadToken) {
            return next();
        }
    }

    // Skip auth if no API key is configured (dev/local mode)
    if (!API_KEY || API_KEY === 'CHANGE_ME_TO_A_RANDOM_64_CHAR_HEX_STRING') {
        if (IS_PRODUCTION) {
            console.warn('[SECURITY WARNING] Server running in production without an API key!');
        }
        return next();
    }

    const rawKey = req.headers['x-api-key'] || req.headers['x-admin-key'] || req.query.apiKey;
    const providedKey = rawKey ? String(rawKey).trim() : '';

    if (!providedKey) {
        return res.status(401).json({ error: 'Missing API key. Include X-API-Key header or valid ?token parameter.' });
    }

    // Constant-time comparison to prevent timing attacks
    const crypto = require('crypto');
    const keyBuffer = Buffer.from(API_KEY);
    const providedBuffer = Buffer.from(providedKey);

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

function extractClientMeta(req) {
    const rawIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
    const clientIp = String(rawIp).split(',')[0].trim().replace(/^::ffff:/, '');
    const userAgent = req.headers['user-agent'] || 'Unknown';
    let clientOrigin = req.headers['origin'] || req.headers['referer'] || '';
    if (!clientOrigin) {
        if (userAgent.includes('Chrome') && !userAgent.includes('Edg')) {
            clientOrigin = 'Chrome Extension';
        } else {
            clientOrigin = 'Web / API Client';
        }
    }
    return { clientIp, userAgent, clientOrigin };
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
    const storage = queue.getStorageUsage();
    const mem = process.memoryUsage();

    res.json({
        status: 'online',
        server: 'YouTube MP3 FFmpeg Engine',
        version: '1.0.0',
        environment: NODE_ENV,
        platform: OS_PLATFORM,
        arch: OS_ARCH,
        cpuCores: os.cpus() ? os.cpus().length : 1,
        binaries: {
            ytDlp: getYtDlpPath(),
            ffmpeg: getFFmpegPath()
        },
        storage: {
            tempDir: TEMP_DIR,
            usedMb: storage.usedMb,
            quotaMb: storage.quotaMb,
            filesHeld: storage.filesCount,
            downloadDir: DOWNLOAD_DIR
        },
        queue: {
            activeDownloads: queue.activeCount,
            maxConcurrency: queue.maxConcurrency,
            totalItems: queue.queue.length
        },
        uptime: Math.floor(process.uptime()),
        sseClients: sseClients.length,
        memory: {
            heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
            rssMb: Math.round(mem.rss / 1024 / 1024)
        },
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
        const clientMeta = extractClientMeta(req);
        const item = await queue.add({ url: url.trim(), bitrate: sanitizeBitrate(bitrate), clientMeta });
        const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
        const host = req.headers['x-forwarded-host'] || req.get('host') || 'localhost:3500';
        const baseUrl = `${protocol}://${host}`;
        res.json({ success: true, item, queueState: queue.getSnapshot(baseUrl) });
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
        const clientMeta = extractClientMeta(req);
        const items = await queue.addBatch(validUrls.map(u => u.trim()), sanitizeBitrate(bitrate), clientMeta);
        const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
        const host = req.headers['x-forwarded-host'] || req.get('host') || 'localhost:3500';
        const baseUrl = `${protocol}://${host}`;
        res.json({
            success: true,
            count: items.length,
            skippedInvalid: invalidCount,
            queueState: queue.getSnapshot(baseUrl)
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
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.get('host') || 'localhost:3500';
    const baseUrl = `${protocol}://${host}`;
    res.json(queue.getSnapshot(baseUrl));
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
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.get('host') || 'localhost:3500';
    const baseUrl = `${protocol}://${host}`;
    res.json({ success: true, queueState: queue.getSnapshot(baseUrl) });
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

/**
 * Stream converted MP3 file to client for download to user's device.
 * Server holds files temporarily in TEMP_DIR (preserved for 30 minutes for manual & re-downloads).
 * Supports token auth via ?token= or API key via header/query param.
 */
app.get('/api/download-file/:id', (req, res) => {
    const { id } = req.params;

    if (!id || typeof id !== 'string') {
        return res.status(400).json({ error: 'Invalid item ID.' });
    }

    const item = queue.getItem(id);
    if (!item) {
        return res.status(404).json({ error: 'Download item not found or expired.' });
    }

    if (!item.filePath || !fs.existsSync(item.filePath)) {
        return res.status(404).json({ error: 'Temporary file is no longer available on server.' });
    }

    // Preserve filename safely for Windows & Linux
    const safeFilename = (item.filename || `${item.title || 'audio'}.mp3`).replace(/[<>:"/\\|?*]/g, '_');

    console.log(`[Stream Download] Sending file to client: ${safeFilename}`);

    // Stream download with Content-Disposition
    res.download(item.filePath, safeFilename, (err) => {
        if (err) {
            if (!res.headersSent) {
                console.error(`[Download Error ${id}]:`, err.message);
                res.status(500).json({ error: 'Failed to stream download.' });
            }
        } else {
            console.log(`[Download Complete] Successfully sent ${safeFilename}`);
            // Record download in audit log
            history.recordFileDownloaded(id, extractClientMeta(req));
            // Keep the file active on server for up to 30 mins so user can use the manual temp link anytime
        }
    });
});

// ─── Admin & Server Panel API Endpoints ─────────────────────────────────────

/**
 * Validate admin authentication
 */
app.get('/api/admin/auth-check', (req, res) => {
    res.json({
        authenticated: true,
        isProduction: IS_PRODUCTION,
        configured: Boolean(API_KEY && API_KEY !== 'CHANGE_ME_TO_A_RANDOM_64_CHAR_HEX_STRING')
    });
});

/**
 * Get comprehensive server health, stats, and download metrics
 */
app.get('/api/admin/stats', (req, res) => {
    let tempFilesHeld = 0;
    let tempDirSizeBytes = 0;

    try {
        if (fs.existsSync(TEMP_DIR)) {
            const files = fs.readdirSync(TEMP_DIR);
            tempFilesHeld = files.length;
            for (const f of files) {
                try {
                    const st = fs.statSync(path.join(TEMP_DIR, f));
                    tempDirSizeBytes += st.size;
                } catch (e) {}
            }
        }
    } catch (e) {}

    const mem = process.memoryUsage();

    res.json({
        server: {
            status: 'online',
            name: 'YouTube MP3 FFmpeg Engine',
            version: '1.0.0',
            environment: NODE_ENV,
            uptimeSec: Math.floor(process.uptime()),
            timestamp: new Date().toISOString(),
            nodeVersion: process.version,
            platform: process.platform,
            arch: process.arch,
            cpuCores: os.cpus().length,
            memory: {
                heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
                rssMb: Math.round(mem.rss / 1024 / 1024),
                systemFreeMb: Math.round(os.freemem() / 1024 / 1024),
                systemTotalMb: Math.round(os.totalmem() / 1024 / 1024)
            },
            tempStorage: {
                path: TEMP_DIR,
                filesHeld: tempFilesHeld,
                sizeMb: (tempDirSizeBytes / (1024 * 1024)).toFixed(2)
            },
            sseClients: sseClients.length
        },
        downloadStats: history.getStats(),
        queueSnapshot: queue.getSnapshot()
    });
});

/**
 * Get download history audit log (What, Where, When, How)
 */
app.get('/api/admin/history', (req, res) => {
    const { search = '', status = '', limit = 50, page = 1 } = req.query;
    const result = history.getHistory({ search, status, limit, page });
    res.json(result);
});

/**
 * Clear audit log history
 */
app.post('/api/admin/clear-history', (req, res) => {
    history.clear();
    res.json({ success: true, message: 'Download audit history cleared' });
});

/**
 * Force purge temporary storage
 */
app.post('/api/admin/purge-temp', (req, res) => {
    let purged = 0;
    try {
        if (fs.existsSync(TEMP_DIR)) {
            const files = fs.readdirSync(TEMP_DIR);
            for (const f of files) {
                try {
                    fs.unlinkSync(path.join(TEMP_DIR, f));
                    purged++;
                } catch (e) {}
            }
        }
    } catch (e) {}
    res.json({ success: true, purgedCount: purged });
});

// ─── Web Dashboard & Static Files ──────────────────────────────────────────
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

app.get(['/', '/dashboard', '/admin'], (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
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

// Periodic background cleanup of temporary files (runs every 5 minutes, deletes >20min old)
const cleanupTimer = setInterval(() => {
    try {
        queue.cleanupStaleTempFiles(20 * 60 * 1000);
    } catch (e) {
        console.error('[Periodic Temp Cleanup Error]:', e.message);
    }
}, 5 * 60 * 1000);

// ─── Graceful Shutdown ───────────────────────────────────────────────────────
function gracefulShutdown(signal) {
    console.log(`\n[Shutdown] Received ${signal}. Closing gracefully...`);
    clearInterval(cleanupTimer);

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
    const osPretty = IS_WIN ? 'Windows' : (OS_PLATFORM === 'linux' ? 'Linux' : OS_PLATFORM);
    console.log(`====================================================`);
    console.log(` 🎧 YouTube to MP3 FFmpeg Engine Server`);
    console.log(` 💻 Platform:     ${osPretty} (${OS_ARCH})`);
    console.log(` 🚀 Environment:  ${NODE_ENV}`);
    console.log(` 🌐 Listening:    http://${HOST}:${PORT}`);
    console.log(` 📁 Download Dir: ${DOWNLOAD_DIR}`);
    console.log(` 📦 yt-dlp:       ${getYtDlpPath()}`);
    console.log(` 🎞️  FFmpeg:       ${getFFmpegPath()}`);
    console.log(` 🔑 API Key:      ${API_KEY && API_KEY !== 'CHANGE_ME_TO_A_RANDOM_64_CHAR_HEX_STRING' ? 'Configured ✓' : 'NOT SET ⚠️'}`);
    console.log(` 🛡️  Rate Limit:   ${process.env.RATE_LIMIT_MAX_REQUESTS || 100} req / ${Math.round((parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 900000) / 60000)}min`);
    console.log(`====================================================`);
});
