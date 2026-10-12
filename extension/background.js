/**
 * Background Service Worker — Production Ready
 * ==============================================
 * Handles messaging between content script, popup, and the remote server.
 * Manages active queue monitoring and automatic downloads directly to end user's device.
 * Tracks download states, broadcasts real-time progress to YouTube tabs, and provides manual temp links.
 */

// Import shared default config
importScripts('config.js');

// Track items already initiated for download on user's device to avoid duplicates
const initiatedDownloads = new Set();
let latestQueueState = null;
let pollTimer = null;
let isPollingActive = false;

// Load previously initiated downloads from storage on startup
chrome.storage.local.get(['initiatedDownloadsList'], (res) => {
    if (Array.isArray(res.initiatedDownloadsList)) {
        res.initiatedDownloadsList.forEach(id => initiatedDownloads.add(id));
    }
});

function markItemInitiated(id) {
    initiatedDownloads.add(id);
    chrome.storage.local.set({ initiatedDownloadsList: Array.from(initiatedDownloads) });
}

/**
 * Retrieve active server configuration from storage or fallback to config.js defaults
 */
async function getConfig() {
    return new Promise((resolve) => {
        chrome.storage.local.get(['serverUrl', 'apiKey', 'autoDownload', 'bitrate'], (res) => {
            let serverUrl = (res.serverUrl && res.serverUrl.trim()) ? res.serverUrl.trim().replace(/\/+$/, '') : '';

            // Auto-heal placeholder or unconfigured dummy domains
            if (!serverUrl || serverUrl === 'https://api.yourdomain.com' || serverUrl === 'https://ytmp3.yourdomain.com') {
                serverUrl = CONFIG.SERVER_URL;
                chrome.storage.local.set({ serverUrl });
            }

            const apiKey = (res.apiKey && res.apiKey.trim()) ? res.apiKey.trim() : CONFIG.API_KEY;
            const autoDownload = res.autoDownload !== undefined ? res.autoDownload : true;
            const bitrate = res.bitrate || '320k';
            resolve({ serverUrl, apiKey, autoDownload, bitrate });
        });
    });
}

/**
 * Build headers object with API key authentication
 */
function getAuthHeaders(apiKey, contentType = false) {
    const headers = {};
    if (apiKey) {
        headers['X-API-Key'] = apiKey;
    }
    if (contentType) {
        headers['Content-Type'] = 'application/json';
    }
    return headers;
}

/**
 * Make authenticated fetch request with timeout and diagnostic error messages
 */
async function apiFetch(endpoint, options = {}) {
    const config = await getConfig();
    const url = endpoint.startsWith('http') ? endpoint : `${config.serverUrl}${endpoint}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000); // 20s timeout

    try {
        const response = await fetch(url, {
            ...options,
            headers: {
                ...getAuthHeaders(config.apiKey, options.method === 'POST'),
                ...(options.headers || {})
            },
            signal: controller.signal
        });

        if (!response.ok) {
            const errorBody = await response.json().catch(() => ({}));
            throw new Error(errorBody.error || `Server HTTP ${response.status}`);
        }

        return await response.json();
    } catch (err) {
        if (err.name === 'AbortError') {
            throw new Error(`Connection timeout: Server at ${config.serverUrl} took too long to respond.`);
        }
        if (err.message === 'Failed to fetch' || err.message.includes('NetworkError') || err.message.includes('fetch')) {
            throw new Error(`Cannot reach server at ${config.serverUrl}. Is your local server running (node server.js)? Check settings (⚙️).`);
        }
        throw err;
    } finally {
        clearTimeout(timeout);
    }
}

// Initialize default settings on install or update
chrome.runtime.onInstalled.addListener(async () => {
    chrome.storage.local.get(['serverUrl', 'apiKey', 'autoDownload', 'bitrate'], (res) => {
        const updates = {};
        if (!res.serverUrl || res.serverUrl === 'https://api.yourdomain.com' || res.serverUrl === 'https://ytmp3.yourdomain.com') {
            updates.serverUrl = CONFIG.SERVER_URL;
        }
        if (!res.apiKey) updates.apiKey = CONFIG.API_KEY;
        if (res.autoDownload === undefined) updates.autoDownload = true;
        if (!res.bitrate) updates.bitrate = '320k';
        if (Object.keys(updates).length > 0) {
            chrome.storage.local.set(updates);
        }
    });
    console.log('[BG Worker] Extension Installed & Config Initialized.');
    startFastPolling();
});

// Update extension badge count
function updateBadge(pendingCount, activeCount) {
    const total = (pendingCount || 0) + (activeCount || 0);
    if (total > 0) {
        chrome.action.setBadgeText({ text: String(total) });
        chrome.action.setBadgeBackgroundColor({ color: '#6366f1' });
    } else {
        chrome.action.setBadgeText({ text: '' });
    }
}

/**
 * Broadcast active queue state to all open YouTube tabs and popup
 */
function broadcastQueueState(queueState) {
    if (!queueState) return;

    // Send to YouTube tabs
    chrome.tabs.query({ url: "*://*.youtube.com/*" }, (tabs) => {
        if (tabs && tabs.length > 0) {
            for (const tab of tabs) {
                chrome.tabs.sendMessage(tab.id, {
                    action: 'QUEUE_UPDATED',
                    queueState: queueState
                }).catch(() => {
                    // Tab might not have content script injected yet, ignore
                });
            }
        }
    });
}

/**
 * Active polling loop to track conversion progress and auto-download
 */
async function syncQueueWithServer() {
    try {
        const config = await getConfig();
        if (!config.serverUrl) return;

        const state = await apiFetch('/api/queue');
        if (!state) return;

        latestQueueState = state;
        updateBadge(state.pendingCount, state.downloadingCount);
        broadcastQueueState(state);

        // Process completed items for auto-download to device
        if (Array.isArray(state.items)) {
            for (const item of state.items) {
                const isReady = item.downloadReady || item.status === 'completed';
                if (isReady && !initiatedDownloads.has(item.id)) {
                    if (config.autoDownload) {
                        console.log(`[BG Worker] Auto-saving completed MP3 to device: ${item.title}`);
                        triggerDeviceDownload(item, false);
                    }
                }
            }
        }

        // Check if there are active tasks in progress
        const hasActiveTasks = Array.isArray(state.items) && state.items.some(i =>
            ['pending', 'downloading', 'decoding_ffmpeg', 'tagging'].includes(i.status) ||
            ['queued', 'fetching_meta', 'downloading', 'decoding_ffmpeg', 'tagging'].includes(i.stage)
        );

        if (hasActiveTasks) {
            scheduleNextPoll(1000); // 1-second active poll interval
        } else {
            isPollingActive = false;
            // When idle, schedule relaxed heartbeat poll if items exist
            if (state.items && state.items.length > 0) {
                scheduleNextPoll(15000);
            }
        }

    } catch (err) {
        console.warn('[BG Worker] syncQueueWithServer warning:', err.message);
        if (isPollingActive) {
            scheduleNextPoll(3000);
        }
    }
}

function scheduleNextPoll(delayMs) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => syncQueueWithServer(), delayMs);
}

function startFastPolling() {
    isPollingActive = true;
    clearTimeout(pollTimer);
    syncQueueWithServer();
}

/**
 * Trigger download of completed MP3 to end user's device
 */
async function triggerDeviceDownload(item, explicitClick = false) {
    if (!item || !item.id) return { success: false, error: 'Invalid item' };

    // Prevent duplicate auto-downloads unless user explicitly clicked download
    if (!explicitClick && initiatedDownloads.has(item.id)) {
        return { success: true, message: 'Already downloaded' };
    }

    const config = await getConfig();
    markItemInitiated(item.id);

    // Build downloadable streaming URL with auth query param & token
    let downloadUrl = item.downloadUrl;
    if (!downloadUrl || !downloadUrl.startsWith('http')) {
        const tokenParam = item.downloadToken ? `&token=${encodeURIComponent(item.downloadToken)}` : '';
        downloadUrl = `${config.serverUrl}/api/download-file/${item.id}?apiKey=${encodeURIComponent(config.apiKey)}${tokenParam}`;
    } else {
        // Ensure apiKey query param is present
        if (!downloadUrl.includes('apiKey=') && config.apiKey) {
            downloadUrl += (downloadUrl.includes('?') ? '&' : '?') + `apiKey=${encodeURIComponent(config.apiKey)}`;
        }
    }

    const rawTitle = item.title || 'YouTube_Audio';
    const safeTitle = rawTitle.replace(/[<>:"/\\|?*]/g, '_').trim();
    const safeFilename = (item.filename || `${safeTitle}.mp3`).replace(/[<>:"/\\|?*]/g, '_');

    return new Promise((resolve) => {
        chrome.downloads.download({
            url: downloadUrl,
            filename: `YouTube_MP3s/${safeFilename}`,
            conflictAction: 'uniquify',
            saveAs: false
        }, (downloadId) => {
            if (chrome.runtime.lastError) {
                const errMsg = chrome.runtime.lastError.message;
                console.error('[Device Download Error]:', errMsg);
                initiatedDownloads.delete(item.id);

                // Notify tabs about failure with manual link fallback
                chrome.tabs.query({ url: "*://*.youtube.com/*" }, (tabs) => {
                    if (tabs) {
                        tabs.forEach(t => chrome.tabs.sendMessage(t.id, {
                            action: 'DOWNLOAD_FAILED_USE_MANUAL',
                            item,
                            downloadUrl,
                            error: errMsg
                        }).catch(() => {}));
                    }
                });

                resolve({ success: false, error: errMsg, downloadUrl });
            } else {
                console.log(`[Device Download Started] ID: ${downloadId} for ${safeFilename}`);

                // Show desktop notification
                try {
                    chrome.notifications.create(`dl_${item.id}`, {
                        type: 'basic',
                        iconUrl: 'icons/icon48.png',
                        title: 'MP3 Saved to Device! 🎵',
                        message: `"${item.title || safeFilename}" saved to Downloads/YouTube_MP3s.`,
                        priority: 1
                    });
                } catch (e) {}

                // Broadcast success to tabs
                chrome.tabs.query({ url: "*://*.youtube.com/*" }, (tabs) => {
                    if (tabs) {
                        tabs.forEach(t => chrome.tabs.sendMessage(t.id, {
                            action: 'ITEM_DOWNLOADED_TO_DEVICE',
                            item,
                            downloadUrl,
                            downloadId
                        }).catch(() => {}));
                    }
                });

                resolve({ success: true, downloadId, downloadUrl });
            }
        });
    });
}

// Handle messaging from Content Script & Popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'GET_CONFIG') {
        getConfig().then(cfg => sendResponse(cfg));
        return true;
    }

    if (request.action === 'GET_SERVER_STATUS') {
        getConfig().then(config => {
            fetch(`${config.serverUrl}/health`, {
                headers: getAuthHeaders(config.apiKey)
            })
                .then(r => r.json())
                .then(data => sendResponse({ status: 'online', data, config }))
                .catch(err => sendResponse({ status: 'offline', error: err.message, config }));
        });
        return true;
    }

    if (request.action === 'SAVE_CONFIG') {
        const { serverUrl, apiKey, autoDownload, bitrate } = request;
        const updates = {};
        if (serverUrl !== undefined) updates.serverUrl = serverUrl.trim().replace(/\/+$/, '');
        if (apiKey !== undefined) updates.apiKey = apiKey.trim();
        if (autoDownload !== undefined) updates.autoDownload = Boolean(autoDownload);
        if (bitrate !== undefined) updates.bitrate = bitrate;

        chrome.storage.local.set(updates, () => {
            sendResponse({ success: true });
            startFastPolling();
        });
        return true;
    }

    if (request.action === 'DOWNLOAD_VIDEO') {
        const { url, bitrate = '320k', videoId } = request;
        apiFetch('/api/download', {
            method: 'POST',
            body: JSON.stringify({ url, bitrate, videoId })
        })
            .then(data => {
                startFastPolling();
                sendResponse({ success: true, data });
            })
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (request.action === 'GET_QUEUE') {
        if (latestQueueState) {
            sendResponse(latestQueueState);
        } else {
            apiFetch('/api/queue')
                .then(state => {
                    latestQueueState = state;
                    sendResponse(state);
                })
                .catch(err => sendResponse({ error: err.message, items: [] }));
        }
        return true;
    }

    if (request.action === 'GET_VIDEO_DOWNLOAD_STATUS') {
        const { videoId } = request;
        if (!videoId) {
            sendResponse({ item: null });
            return false;
        }

        const findItem = (state) => {
            if (!state || !Array.isArray(state.items)) return null;
            return state.items.find(i =>
                i.videoId === videoId ||
                (i.url && i.url.includes(videoId))
            );
        };

        const existing = findItem(latestQueueState);
        if (existing) {
            if (['pending', 'downloading', 'decoding_ffmpeg', 'tagging'].includes(existing.status)) {
                startFastPolling();
            }
            sendResponse({ item: existing, isSaved: initiatedDownloads.has(existing.id) });
        } else {
            apiFetch('/api/queue')
                .then(state => {
                    latestQueueState = state;
                    const item = findItem(state);
                    if (item && ['pending', 'downloading', 'decoding_ffmpeg', 'tagging'].includes(item.status)) {
                        startFastPolling();
                    }
                    sendResponse({ item, isSaved: item ? initiatedDownloads.has(item.id) : false });
                })
                .catch(() => sendResponse({ item: null }));
        }
        return true;
    }

    if (request.action === 'TRIGGER_DEVICE_DOWNLOAD') {
        triggerDeviceDownload(request.item, request.explicitClick || false)
            .then(res => sendResponse(res));
        return true;
    }

    if (request.action === 'START_POLLING') {
        startFastPolling();
        sendResponse({ success: true });
        return false;
    }

    if (request.action === 'UPDATE_BADGE') {
        updateBadge(request.pendingCount, request.activeCount);
        return false;
    }
});

// Initial boot check
syncQueueWithServer();
