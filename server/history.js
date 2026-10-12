const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'download-history.json');
const MAX_HISTORY_ENTRIES = 1000;

class DownloadHistory {
    constructor() {
        this.records = [];
        this.init();
    }

    init() {
        this.load();
    }

    load() {
        try {
            if (!fs.existsSync(DATA_DIR)) {
                fs.mkdirSync(DATA_DIR, { recursive: true });
            }
            if (fs.existsSync(HISTORY_FILE)) {
                const data = fs.readFileSync(HISTORY_FILE, 'utf8');
                this.records = JSON.parse(data || '[]');
                if (!Array.isArray(this.records)) {
                    this.records = [];
                }
            } else {
                this.save();
            }
        } catch (err) {
            console.error('[History] Failed to read history store:', err.message);
            this.records = [];
        }
    }

    save() {
        try {
            if (!fs.existsSync(DATA_DIR)) {
                fs.mkdirSync(DATA_DIR, { recursive: true });
            }
            // Keep latest MAX_HISTORY_ENTRIES
            if (this.records.length > MAX_HISTORY_ENTRIES) {
                this.records = this.records.slice(-MAX_HISTORY_ENTRIES);
            }
            fs.writeFileSync(HISTORY_FILE, JSON.stringify(this.records, null, 2), 'utf8');
        } catch (err) {
            console.error('[History] Failed to write history file:', err.message);
        }
    }

    /**
     * Record a newly queued download request (What, Where, When)
     */
    recordQueued(item, meta = {}) {
        const clientIp = meta.clientIp || '127.0.0.1';
        const userAgent = meta.userAgent || 'Unknown';
        const clientOrigin = meta.clientOrigin || meta.referrer || 'Chrome Extension';

        // Extract YouTube video ID
        let videoId = '';
        const match = (item.url || '').match(/(?:v=|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
        if (match) videoId = match[1];

        const record = {
            id: item.id,
            url: item.url,
            videoId: videoId,
            title: item.title || 'Fetching details...',
            channel: item.channel || 'YouTube',
            thumbnail: item.thumbnail || null,
            bitrate: item.bitrate || '320k',
            filename: null,
            fileSize: 0,
            status: 'queued', // queued | converting | ready | downloaded | failed
            clientIp: this.formatIp(clientIp),
            userAgent: userAgent,
            clientOrigin: clientOrigin,
            requestedAt: new Date().toISOString(),
            conversionStartedAt: null,
            convertedAt: null,
            downloadedAt: null,
            conversionDurationMs: null,
            tempCleaned: false,
            error: null
        };

        // Prepend to top
        this.records.unshift(record);
        this.save();
        return record;
    }

    /**
     * Update record when conversion starts
     */
    recordConversionStart(id) {
        const record = this.records.find(r => r.id === id);
        if (record) {
            record.status = 'converting';
            record.conversionStartedAt = new Date().toISOString();
            this.save();
        }
    }

    /**
     * Update record when conversion completes or fails
     */
    recordConversionComplete(id, { success, title, channel, thumbnail, filename, fileSize, error, durationMs }) {
        const record = this.records.find(r => r.id === id);
        if (!record) return;

        if (title) record.title = title;
        if (channel) record.channel = channel;
        if (thumbnail) record.thumbnail = thumbnail;

        if (success) {
            record.status = 'ready';
            record.filename = filename;
            record.fileSize = fileSize || 0;
            record.convertedAt = new Date().toISOString();
            record.conversionDurationMs = durationMs || (record.conversionStartedAt ? Date.now() - new Date(record.conversionStartedAt).getTime() : null);
        } else {
            record.status = 'failed';
            record.error = error || 'Conversion failed';
            record.convertedAt = new Date().toISOString();
        }
        this.save();
    }

    /**
     * Update record when client downloads file to device
     */
    recordFileDownloaded(id, meta = {}) {
        const record = this.records.find(r => r.id === id);
        if (record) {
            record.status = 'downloaded';
            record.downloadedAt = new Date().toISOString();
            if (meta.clientIp) record.downloadClientIp = this.formatIp(meta.clientIp);
            this.save();
        }
    }

    /**
     * Mark that server temp file was removed from disk
     */
    recordTempCleaned(id) {
        const record = this.records.find(r => r.id === id);
        if (record) {
            record.tempCleaned = true;
            this.save();
        }
    }

    /**
     * Clean IPs for uniform display (strip ::ffff:)
     */
    formatIp(ip) {
        if (!ip) return '127.0.0.1';
        let clean = String(ip).trim();
        if (clean.startsWith('::ffff:')) {
            clean = clean.replace('::ffff:', '');
        }
        if (clean === '::1') return '127.0.0.1';
        return clean;
    }

    /**
     * Search, filter, and paginate history
     */
    getHistory({ search = '', status = '', limit = 50, page = 1 } = {}) {
        this.load();
        let list = [...this.records];

        if (status && status !== 'all') {
            list = list.filter(r => r.status === status);
        }

        if (search) {
            const term = search.toLowerCase().trim();
            list = list.filter(r =>
                (r.title && r.title.toLowerCase().includes(term)) ||
                (r.channel && r.channel.toLowerCase().includes(term)) ||
                (r.clientIp && r.clientIp.toLowerCase().includes(term)) ||
                (r.videoId && r.videoId.toLowerCase().includes(term)) ||
                (r.bitrate && r.bitrate.toLowerCase().includes(term))
            );
        }

        const total = list.length;
        const pageNum = Math.max(1, parseInt(page, 10) || 1);
        const limitNum = Math.max(1, parseInt(limit, 10) || 50);
        const offset = (pageNum - 1) * limitNum;
        const paginated = list.slice(offset, offset + limitNum);

        return {
            total,
            page: pageNum,
            limit: limitNum,
            totalPages: Math.ceil(total / limitNum) || 1,
            records: paginated
        };
    }

    /**
     * Aggregated metrics for Admin Panel
     */
    getStats() {
        this.load();
        const total = this.records.length;
        const downloaded = this.records.filter(r => r.status === 'downloaded').length;
        const failed = this.records.filter(r => r.status === 'failed').length;
        const ready = this.records.filter(r => r.status === 'ready').length;
        const converting = this.records.filter(r => r.status === 'converting').length;

        const totalBytes = this.records.reduce((acc, r) => acc + (r.status === 'downloaded' ? (r.fileSize || 0) : 0), 0);

        // Average conversion time
        const completedTimes = this.records
            .filter(r => r.conversionDurationMs && r.conversionDurationMs > 0)
            .map(r => r.conversionDurationMs);
        const avgConversionMs = completedTimes.length > 0
            ? Math.round(completedTimes.reduce((a, b) => a + b, 0) / completedTimes.length)
            : 0;

        // Top channels
        const channelCounts = {};
        for (const r of this.records) {
            if (r.channel && r.channel !== 'YouTube' && r.channel !== 'Unknown Artist') {
                channelCounts[r.channel] = (channelCounts[r.channel] || 0) + 1;
            }
        }
        const topChannels = Object.entries(channelCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([name, count]) => ({ name, count }));

        // Recent unique client IPs
        const uniqueIps = new Set(this.records.map(r => r.clientIp)).size;

        return {
            totalRequests: total,
            totalDownloaded: downloaded,
            totalReady: ready,
            totalConverting: converting,
            totalFailed: failed,
            successRate: total > 0 ? Math.round(((downloaded + ready) / total) * 100) : 100,
            totalBytesDownloaded: totalBytes,
            totalMbDownloaded: (totalBytes / (1024 * 1024)).toFixed(1),
            avgConversionSec: (avgConversionMs / 1000).toFixed(1),
            uniqueClientsCount: uniqueIps,
            topChannels
        };
    }

    /**
     * Clear all records
     */
    clear() {
        this.records = [];
        this.save();
    }
}

module.exports = new DownloadHistory();
