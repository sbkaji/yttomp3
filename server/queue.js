const { convertToMp3, getVideoInfo } = require('./yt-dlp-helper');

class DownloadQueue {
    constructor() {
        this.queue = [];
        this.maxConcurrency = 2;
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
        const val = parseInt(limit);
        if (val >= 1 && val <= 5) {
            this.maxConcurrency = val;
            this.process();
        }
    }

    /**
     * Add item to queue
     */
    async add({ url, bitrate = '320k' }) {
        // Prevent duplicate pending or downloading items
        const existing = this.queue.find(item => item.url === url && (item.status === 'pending' || item.status === 'downloading' || item.status === 'decoding_ffmpeg'));
        if (existing) {
            return existing;
        }

        const id = `item_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        const newItem = {
            id,
            url,
            bitrate,
            title: 'Fetching details...',
            channel: 'YouTube',
            thumbnail: null,
            duration: 0,
            status: 'pending',
            progress: 0,
            stage: 'queued',
            error: null,
            addedAt: new Date().toISOString()
        };

        this.queue.push(newItem);
        this.notify('item_added', newItem);

        // Fetch meta in background to populate title/thumbnail early
        this.fetchMeta(newItem);

        this.process();
        return newItem;
    }

    /**
     * Add multiple URLs to queue
     */
    async addBatch(urls, bitrate = '320k') {
        const added = [];
        for (const url of urls) {
            if (url && url.trim()) {
                const item = await this.add({ url: url.trim(), bitrate });
                added.push(item);
            }
        }
        return added;
    }

    async fetchMeta(item) {
        try {
            const meta = await getVideoInfo(item.url);
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
        this.notify('item_updated', nextItem);

        try {
            await convertToMp3({
                url: nextItem.url,
                bitrate: nextItem.bitrate,
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
            nextItem.stage = 'completed';
            nextItem.progress = 100;
            this.notify('item_completed', nextItem);

        } catch (err) {
            console.error(`[Queue Item Error ${nextItem.id}]:`, err.message);
            nextItem.status = 'error';
            nextItem.stage = 'failed';
            nextItem.error = err.message || 'Download failed';
            this.notify('item_failed', nextItem);
        } finally {
            this.activeCount--;
            // Recursively process next item
            setImmediate(() => this.process());
        }
    }

    /**
     * Remove item by ID
     */
    remove(id) {
        const index = this.queue.findIndex(item => item.id === id);
        if (index !== -1) {
            const [removed] = this.queue.splice(index, 1);
            this.notify('item_removed', { id });
            return removed;
        }
        return null;
    }

    /**
     * Clear all completed and failed items
     */
    clearCompleted() {
        const beforeCount = this.queue.length;
        this.queue = this.queue.filter(item => item.status !== 'completed' && item.status !== 'error');
        if (this.queue.length !== beforeCount) {
            this.notify('queue_cleared', {});
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
     * Return current snapshot of queue state
     */
    getSnapshot() {
        return {
            items: this.queue,
            maxConcurrency: this.maxConcurrency,
            activeCount: this.activeCount,
            totalItems: this.queue.length,
            pendingCount: this.queue.filter(i => i.status === 'pending').length,
            downloadingCount: this.queue.filter(i => ['downloading', 'decoding_ffmpeg', 'tagging'].includes(i.status)).length,
            completedCount: this.queue.filter(i => i.status === 'completed').length,
            errorCount: this.queue.filter(i => i.status === 'error').length
        };
    }
}

module.exports = new DownloadQueue();
