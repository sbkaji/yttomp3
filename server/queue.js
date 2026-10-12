const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { convertToMp3, getVideoInfo, TEMP_DIR } = require('./yt-dlp-helper');
const history = require('./history');

const MAX_QUEUE_CAPACITY = parseInt(process.env.MAX_QUEUE_CAPACITY, 10) || 100;
const MAX_TEMP_STORAGE_MB = parseInt(process.env.MAX_TEMP_STORAGE_MB, 10) || 2048; // 2GB storage quota

class DownloadQueue {
    constructor() {
        this.queue = [];
        const cpuCount = os.cpus() ? os.cpus().length : 2;
        const autoConcurrency = Math.min(3, Math.max(1, Math.floor(cpuCount / 2)));
        this.maxConcurrency = parseInt(process.env.MAX_CONCURRENCY, 10) || autoConcurrency;
        this.activeCount = 0;
        this.subscribers = new Set();
    }

    /**
     * Subscribe to real-time status updates (SSE / Sockets)
     */
    subscribe(callback) {
        this.subscribers.add(callback);
        return () => this.subscribers.delete(callback);
    }

    /**
     * Notify all listeners of queue state changes
     */
    notify(event, data) {
        for (const callback of this.subscribers) {
            try {
                callback({ event, data, state: this.getSnapshot() });
            } catch (err) {
                console.error('Subscriber error:', err);
            }
        }
    }

    /**
     * Set max simultaneous downloads
     */
    setConcurrency(limit) {
        const val = parseInt(limit, 10);
        if (val >= 1 && val <= 5) {
            this.maxConcurrency = val;
            this.process();
        }
    }

    /**
     * Get single item by ID (internal helper)
     */
    getItem(id) {
        return this.queue.find(item => item.id === id);
    }

    /**
     * Add item to queue with client metadata (Who, Where, When, What) and client cookies
     */
    async add({ url, bitrate = '320k', clientMeta = {}, cookies = null }) {
        // Prevent duplicate pending or downloading items
        const existing = this.queue.find(item => item.url === url && (item.status === 'pending' || item.status === 'downloading' || item.status === 'decoding_ffmpeg'));
        if (existing) {
            if (cookies && !existing.cookies) existing.cookies = cookies;
            return existing;
        }

        // High load protection: Check maximum queue capacity
        const activeOrPending = this.queue.filter(i => ['pending', 'downloading', 'decoding_ffmpeg', 'tagging'].includes(i.status)).length;
        if (activeOrPending >= MAX_QUEUE_CAPACITY) {
            throw new Error(`Server conversion queue is at maximum capacity (${MAX_QUEUE_CAPACITY} active items). Please wait for ongoing conversions to finish.`);
        }

        // Proactive storage and memory protections
        this.enforceStorageQuota();
        this.pruneOldCompletedItems();

        const id = `item_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        const downloadToken = crypto.randomBytes(16).toString('hex');
        let videoId = clientMeta.videoId || null;
        if (!videoId && url) {
            const m = url.match(/(?:v=|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
            if (m) videoId = m[1];
        }

        const newItem = {
            id,
            videoId,
            url,
            bitrate,
            cookies: cookies || null,
            title: 'Fetching details...',
            channel: 'YouTube',
            thumbnail: null,
            duration: 0,
            status: 'pending',
            progress: 0,
            stage: 'queued',
            error: null,
            filename: null,
            filePath: null,
            fileSize: 0,
            downloadReady: false,
            downloadToken,
            expiresAt: null,
            clientMeta,
            addedAt: new Date().toISOString()
        };

        this.queue.push(newItem);

        // Record in history log
        history.recordQueued(newItem, clientMeta);

        this.notify('item_added', newItem);

        // Fetch meta in background to populate title/thumbnail early
        this.fetchMeta(newItem);

        this.process();
        return newItem;
    }

    /**
     * Add multiple URLs to queue
     */
    async addBatch(urls, bitrate = '320k', clientMeta = {}, cookies = null) {
        const added = [];
        for (const url of urls) {
            if (url && url.trim()) {
                const item = await this.add({ url: url.trim(), bitrate, clientMeta, cookies });
                added.push(item);
            }
        }
        return added;
    }

    async fetchMeta(item) {
        try {
            const meta = await getVideoInfo(item.url, item.cookies);
            item.title = meta.title;
            item.channel = meta.channel;
            item.thumbnail = meta.thumbnail;
            item.duration = meta.duration;
            this.notify('item_updated', item);
        } catch (e) {
            // Soft fail, will try again during conversion
        }
    }

    /**
     * Process next tasks in queue based on concurrency limit
     */
    async process() {
        if (this.activeCount >= this.maxConcurrency) return;

        const nextItem = this.queue.find(item => item.status === 'pending');
        if (!nextItem) return;

        this.activeCount++;
        nextItem.status = 'downloading';
        nextItem.stage = 'downloading';
        nextItem.progress = 10;
        nextItem.conversionStartedAt = Date.now();

        // Update history
        history.recordConversionStart(nextItem.id);

        this.notify('item_updated', nextItem);

        try {
            const result = await convertToMp3({
                url: nextItem.url,
                bitrate: nextItem.bitrate,
                cookies: nextItem.cookies,
                onProgress: ({ stage, percent }) => {
                    nextItem.stage = stage;
                    nextItem.progress = percent;
                    if (stage === 'decoding_ffmpeg') {
                        nextItem.status = 'decoding_ffmpeg';
                    } else if (stage === 'tagging') {
                        nextItem.status = 'tagging';
                    } else {
                        nextItem.status = 'downloading';
                    }
                    this.notify('item_progress', nextItem);
                }
            });

            nextItem.status = 'completed';
            nextItem.stage = 'ready';
            nextItem.progress = 100;
            nextItem.filename = result.filename;
            nextItem.filePath = result.filePath;
            nextItem.fileSize = result.fileSize;
            nextItem.downloadReady = true;
            nextItem.completedAt = new Date().toISOString();
            nextItem.expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

            const durationMs = nextItem.conversionStartedAt ? Date.now() - nextItem.conversionStartedAt : 0;

            // Update history
            history.recordConversionComplete(nextItem.id, {
                success: true,
                title: nextItem.title,
                channel: nextItem.channel,
                thumbnail: nextItem.thumbnail,
                filename: result.filename,
                fileSize: result.fileSize,
                durationMs
            });

            this.notify('item_completed', nextItem);

        } catch (err) {
            console.error(`[Queue Item Error ${nextItem.id}]:`, err.message);
            nextItem.status = 'error';
            nextItem.stage = 'failed';
            nextItem.error = err.message || 'Download failed';

            history.recordConversionComplete(nextItem.id, {
                success: false,
                error: err.message || 'Conversion failed'
            });

            this.notify('item_failed', nextItem);
        } finally {
            this.activeCount--;
            // Recursively process next item
            setImmediate(() => this.process());
        }
    }

    /**
     * Remove item by ID and delete its temporary file
     */
    remove(id) {
        const index = this.queue.findIndex(item => item.id === id);
        if (index !== -1) {
            const [removed] = this.queue.splice(index, 1);
            if (removed.filePath && fs.existsSync(removed.filePath)) {
                try {
                    fs.unlinkSync(removed.filePath);
                    history.recordTempCleaned(removed.id);
                    console.log(`[Temp Clean] Deleted temp file on remove: ${removed.filePath}`);
                } catch (e) {
                    console.warn(`[Temp Clean] Could not delete ${removed.filePath}:`, e.message);
                }
            }
            this.notify('item_removed', { id });
            return removed;
        }
        return null;
    }

    /**
     * Clear all completed and failed items and delete their temporary files
     */
    clearCompleted() {
        const toDelete = this.queue.filter(item => item.status === 'completed' || item.status === 'error');
        for (const item of toDelete) {
            if (item.filePath && fs.existsSync(item.filePath)) {
                try {
                    fs.unlinkSync(item.filePath);
                    history.recordTempCleaned(item.id);
                    console.log(`[Temp Clean] Deleted temp file on clear: ${item.filePath}`);
                } catch (e) {}
            }
        }
        const beforeCount = this.queue.length;
        this.queue = this.queue.filter(item => item.status !== 'completed' && item.status !== 'error');
        if (this.queue.length !== beforeCount) {
            this.notify('queue_cleared', {});
        }
    }

    /**
     * Scan and delete stale temp files older than maxAgeMs (default 30 mins)
     */
    cleanupStaleTempFiles(maxAgeMs = 30 * 60 * 1000) {
        const now = Date.now();
        // 1. Check queue items
        for (const item of this.queue) {
            if (item.status === 'completed' && item.completedAt) {
                const age = now - new Date(item.completedAt).getTime();
                if (age > maxAgeMs) {
                    if (item.filePath && fs.existsSync(item.filePath)) {
                        try {
                            fs.unlinkSync(item.filePath);
                            history.recordTempCleaned(item.id);
                            console.log(`[Temp Clean] Stale file unlinked: ${item.filePath}`);
                        } catch (e) {}
                    }
                    item.filePath = null;
                    item.downloadReady = false;
                    item.stage = 'expired';
                }
            }
        }

        // 2. Scan temp directory for orphaned files
        if (fs.existsSync(TEMP_DIR)) {
            try {
                const files = fs.readdirSync(TEMP_DIR);
                for (const file of files) {
                    const fullPath = path.join(TEMP_DIR, file);
                    try {
                        const stat = fs.statSync(fullPath);
                        if (now - stat.mtimeMs > maxAgeMs) {
                            fs.unlinkSync(fullPath);
                            console.log(`[Temp Clean] Orphaned temp file removed: ${file}`);
                        }
                    } catch (e) {}
                }
            } catch (e) {}
        }
    }

    /**
     * Get temporary directory disk storage metrics
     */
    getStorageUsage() {
        let totalBytes = 0;
        let filesCount = 0;
        if (fs.existsSync(TEMP_DIR)) {
            try {
                const files = fs.readdirSync(TEMP_DIR);
                filesCount = files.length;
                for (const file of files) {
                    try {
                        const st = fs.statSync(path.join(TEMP_DIR, file));
                        totalBytes += st.size;
                    } catch (e) {}
                }
            } catch (e) {}
        }
        return {
            usedBytes: totalBytes,
            usedMb: +(totalBytes / (1024 * 1024)).toFixed(1),
            quotaMb: MAX_TEMP_STORAGE_MB,
            filesCount
        };
    }

    /**
     * Proactively enforce storage quota to prevent server disk exhaustion.
     * Automatically purges oldest completed temporary files if quota is exceeded.
     */
    enforceStorageQuota() {
        const usage = this.getStorageUsage();
        if (usage.usedMb < MAX_TEMP_STORAGE_MB) return;

        console.warn(`[Storage Quota Warning] Temp storage (${usage.usedMb}MB) exceeded quota (${MAX_TEMP_STORAGE_MB}MB). Running proactive purge...`);

        // Sort completed items with files by completedAt ascending (oldest first)
        const completedWithFiles = this.queue
            .filter(i => i.status === 'completed' && i.filePath && fs.existsSync(i.filePath))
            .sort((a, b) => new Date(a.completedAt || 0) - new Date(b.completedAt || 0));

        for (const item of completedWithFiles) {
            if (this.getStorageUsage().usedMb <= MAX_TEMP_STORAGE_MB * 0.7) {
                break; // Under 70% of quota, safe to resume
            }
            try {
                fs.unlinkSync(item.filePath);
                item.filePath = null;
                item.downloadReady = false;
                item.stage = 'expired';
                history.recordTempCleaned(item.id);
                console.log(`[Storage Quota Purge] Removed oldest file: ${item.filename}`);
            } catch (e) {}
        }
    }

    /**
     * Prune old completed/errored items from in-memory queue to prevent memory leak
     */
    pruneOldCompletedItems(maxRetained = 50) {
        const completedOrError = this.queue.filter(i => i.status === 'completed' || i.status === 'error');
        if (completedOrError.length > maxRetained) {
            const toRemoveCount = completedOrError.length - maxRetained;
            const sortedByAge = [...completedOrError].sort((a, b) => new Date(a.addedAt || 0) - new Date(b.addedAt || 0));
            const toRemoveIds = new Set(sortedByAge.slice(0, toRemoveCount).map(i => i.id));
            this.queue = this.queue.filter(i => !toRemoveIds.has(i.id));
        }
    }

    /**
     * Retry failed item
     */
    retry(id) {
        const item = this.queue.find(i => i.id === id);
        if (item && item.status === 'error') {
            item.status = 'pending';
            item.stage = 'queued';
            item.progress = 0;
            item.error = null;
            this.notify('item_updated', item);
            this.process();
            return item;
        }
        return null;
    }

    /**
     * Return sanitized snapshot of queue state (without leaking internal server paths)
     */
    getSnapshot(baseUrl = '') {
        const cleanBaseUrl = baseUrl ? baseUrl.replace(/\/+$/, '') : '';
        return {
            items: this.queue.map(item => {
                const downloadPath = item.downloadReady ? `/api/download-file/${item.id}?token=${item.downloadToken || ''}` : null;
                const downloadUrl = (item.downloadReady && downloadPath) ? (cleanBaseUrl ? `${cleanBaseUrl}${downloadPath}` : downloadPath) : null;
                return {
                    id: item.id,
                    videoId: item.videoId || null,
                    url: item.url,
                    bitrate: item.bitrate,
                    title: item.title,
                    channel: item.channel,
                    thumbnail: item.thumbnail,
                    duration: item.duration,
                    status: item.status,
                    progress: item.progress,
                    stage: item.stage,
                    error: item.error,
                    filename: item.filename,
                    fileSize: item.fileSize,
                    downloadReady: item.downloadReady,
                    downloadToken: item.downloadToken,
                    downloadPath: downloadPath,
                    downloadUrl: downloadUrl,
                    expiresAt: item.expiresAt,
                    clientMeta: item.clientMeta,
                    addedAt: item.addedAt,
                    completedAt: item.completedAt
                };
            }),
            maxConcurrency: this.maxConcurrency,
            activeCount: this.activeCount,
            totalItems: this.queue.length,
            pendingCount: this.queue.filter(i => i.status === 'pending').length,
            downloadingCount: this.queue.filter(i => ['downloading', 'decoding_ffmpeg', 'tagging'].includes(i.status)).length,
            completedCount: this.queue.filter(i => i.status === 'completed').length,
            errorCount: this.queue.filter(i => i.status === 'error').length,
            storageUsage: this.getStorageUsage()
        };
    }
}

module.exports = new DownloadQueue();
