/**
 * Background Service Worker — Production Ready
 * ==============================================
 * Handles messaging between content script, popup, and the remote server.
 * Sends API key with every request for authentication.
 */

// Import shared config
importScripts('config.js');

const SERVER_URL = CONFIG.SERVER_URL;
const API_KEY = CONFIG.API_KEY;

/**
 * Build headers object with API key authentication
 */
function getAuthHeaders(contentType = false) {
    const headers = {
        'X-API-Key': API_KEY
    };
    if (contentType) {
        headers['Content-Type'] = 'application/json';
    }
    return headers;
}

/**
 * Make authenticated fetch request with error handling and timeout
 */
async function apiFetch(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000); // 15s timeout

    try {
        const response = await fetch(url, {
            ...options,
            headers: {
                ...getAuthHeaders(options.method === 'POST'),
                ...(options.headers || {})
            },
            signal: controller.signal
        });

        if (!response.ok) {
            const errorBody = await response.json().catch(() => ({}));
            throw new Error(errorBody.error || `HTTP ${response.status}`);
        }

        return await response.json();
    } finally {
        clearTimeout(timeout);
    }
}

// Initialize default settings on install
chrome.runtime.onInstalled.addListener(() => {
    console.log('[BG Worker] Extension Installed. Server:', SERVER_URL);
    chrome.storage.local.set({
        bitrate: '320k',
        serverUrl: SERVER_URL,
        autoDownload: true
    });
});

// Update badge count
function updateBadge(pendingCount, activeCount) {
    const total = (pendingCount || 0) + (activeCount || 0);
    if (total > 0) {
        chrome.action.setBadgeText({ text: String(total) });
        chrome.action.setBadgeBackgroundColor({ color: '#6366f1' });
    } else {
        chrome.action.setBadgeText({ text: '' });
    }
}

// Handle messaging from Content Script & Popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'GET_SERVER_URL') {
        sendResponse({ serverUrl: SERVER_URL, apiKey: API_KEY });
        return false;
    }

    if (request.action === 'GET_SERVER_STATUS') {
        apiFetch(`${SERVER_URL}/health`)
            .then(data => sendResponse({ status: 'online', data }))
            .catch(err => sendResponse({ status: 'offline', error: err.message }));
        return true; // Keep channel open for async response
    }

    if (request.action === 'DOWNLOAD_VIDEO') {
        const { url, bitrate = '320k' } = request;
        apiFetch(`${SERVER_URL}/api/download`, {
            method: 'POST',
            body: JSON.stringify({ url, bitrate })
        })
            .then(data => {
                sendResponse({ success: true, data });
            })
            .catch(err => {
                sendResponse({ success: false, error: err.message });
            });
        return true;
    }

    if (request.action === 'UPDATE_BADGE') {
        updateBadge(request.pendingCount, request.activeCount);
    }
});
