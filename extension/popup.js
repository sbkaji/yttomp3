/**
 * Popup Controller — Production Ready
 * =====================================
 * Supports Coolify Ubuntu remote server & local Windows server, API key authentication,
 * dynamic progress bar with multi-stage audio conversion feedback,
 * auto-download to user's PC device, and temporary manual download links.
 */

let SERVER_URL = '';
let API_KEY = '';
let AUTO_DOWNLOAD = true;
let eventSource = null;
let currentBitrate = '320k';
let reconnectTimer = null;
let reconnectAttempts = 0;
let popupPollInterval = null;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_BASE_DELAY = 2000;

// Track items saved to device in current session to prevent repetitive auto-downloads
const savedToDeviceItems = new Set();

document.addEventListener('DOMContentLoaded', () => {
    loadSettingsAndConnect();
    initBitrateSelector();
    initSettingsDrawer();
    initUIEventListeners();

    // Listen for runtime updates from background service worker
    chrome.runtime.onMessage.addListener((message) => {
        if (message.action === 'QUEUE_UPDATED' && message.queueState) {
            renderQueue(message.queueState);
            checkIfPollingNeeded(message.queueState);
        }
    });
});

/**
 * Load server config from storage / background worker and connect
 */
function loadSettingsAndConnect() {
    chrome.runtime.sendMessage({ action: 'GET_CONFIG' }, (config) => {
        if (config) {
            SERVER_URL = config.serverUrl || CONFIG.SERVER_URL;
            if (!SERVER_URL || SERVER_URL === 'https://api.yourdomain.com' || SERVER_URL === 'https://ytmp3.yourdomain.com') {
                SERVER_URL = 'http://localhost:3500';
            }
            API_KEY = config.apiKey || CONFIG.API_KEY;
            AUTO_DOWNLOAD = config.autoDownload !== undefined ? config.autoDownload : true;

            // Populate settings drawer inputs
            const urlInput = document.getElementById('setting-server-url');
            const keyInput = document.getElementById('setting-api-key');
            const autoDlInput = document.getElementById('setting-auto-download');

            if (urlInput) urlInput.value = SERVER_URL;
            if (keyInput) keyInput.value = API_KEY;
            if (autoDlInput) autoDlInput.checked = AUTO_DOWNLOAD;
        }

        initServerConnection();
    });
}

/**
 * Build headers with API key
 */
function getAuthHeaders(contentType = false) {
    const headers = {};
    if (API_KEY) headers['X-API-Key'] = API_KEY;
    if (contentType) headers['Content-Type'] = 'application/json';
    return headers;
}

/**
 * Authenticated fetch wrapper
 */
async function apiFetch(url, options = {}) {
    const fullUrl = url.startsWith('http') ? url : `${SERVER_URL}${url}`;
    const response = await fetch(fullUrl, {
        ...options,
        headers: {
            ...getAuthHeaders(options.method === 'POST' || options.method === 'DELETE'),
            ...(options.headers || {})
        }
    });

    if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.error || `HTTP ${response.status}`);
    }

    return response.json();
}

/**
 * Fetch latest queue snapshot immediately and check polling
 */
function refreshQueueNow() {
    apiFetch('/api/queue')
        .then(state => {
            renderQueue(state);
            checkIfPollingNeeded(state);
        })
        .catch(err => {
            console.warn('[Popup] refreshQueueNow error:', err.message);
        });
}

function checkIfPollingNeeded(state) {
    const hasActive = state && Array.isArray(state.items) && state.items.some(i =>
        ['pending', 'downloading', 'decoding_ffmpeg', 'tagging'].includes(i.status) ||
        ['queued', 'fetching_meta', 'downloading', 'decoding_ffmpeg', 'tagging'].includes(i.stage)
    );

    if (hasActive && !popupPollInterval) {
        popupPollInterval = setInterval(() => {
            apiFetch('/api/queue')
                .then(s => {
                    renderQueue(s);
                    checkIfPollingNeeded(s);
                })
                .catch(() => {});
        }, 1000);
    } else if (!hasActive && popupPollInterval) {
        clearInterval(popupPollInterval);
        popupPollInterval = null;
    }
}

/**
 * Initialize Server Connection & Health Check
 */
function initServerConnection() {
    const statusBadge = document.getElementById('server-status');
    const statusText = document.getElementById('status-text');

    if (!SERVER_URL) {
        statusBadge.className = 'status-badge offline';
        statusText.textContent = 'Set Server URL';
        return;
    }

    statusBadge.className = 'status-badge connecting';
    statusText.textContent = 'Connecting...';

    fetch(`${SERVER_URL}/health`, { headers: getAuthHeaders() })
        .then(res => res.json())
        .then((data) => {
            statusBadge.className = 'status-badge online';
            statusText.textContent = 'Server Online';
            reconnectAttempts = 0;
            refreshQueueNow();
            connectSSE();
        })
        .catch((err) => {
            statusBadge.className = 'status-badge offline';
            statusText.textContent = 'Server Offline';
            renderEmptyState('Server unreachable. Click ⚙️ to configure your server address.');
            scheduleReconnect();
        });
}

function scheduleReconnect() {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        document.getElementById('status-text').textContent = 'Offline';
        return;
    }

    const delay = RECONNECT_BASE_DELAY * Math.pow(2, Math.min(reconnectAttempts, 4));
    reconnectAttempts++;

    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
        initServerConnection();
    }, delay);
}

/**
 * Subscribe to SSE Live Updates from Server
 */
function connectSSE() {
    if (eventSource) {
        eventSource.close();
        eventSource = null;
    }

    const sseUrl = `${SERVER_URL}/api/events?apiKey=${encodeURIComponent(API_KEY)}`;
    eventSource = new EventSource(sseUrl);

    eventSource.addEventListener('queue_update', (e) => {
        try {
            const payload = JSON.parse(e.data);
            renderQueue(payload.state);
            checkIfPollingNeeded(payload.state);
        } catch (err) {}
    });

    eventSource.addEventListener('init', (e) => {
        try {
            const payload = JSON.parse(e.data);
            renderQueue(payload.state);
            checkIfPollingNeeded(payload.state);
        } catch (err) {}
    });

    eventSource.addEventListener('server_shutdown', () => {
        document.getElementById('server-status').className = 'status-badge offline';
        document.getElementById('status-text').textContent = 'Server Stopped';
    });

    eventSource.onerror = () => {
        document.getElementById('server-status').className = 'status-badge offline';
        document.getElementById('status-text').textContent = 'Reconnecting...';
        scheduleReconnect();
    };
}

/**
 * Bitrate Selector Initialization
 */
function initBitrateSelector() {
    chrome.storage.local.get(['bitrate'], (res) => {
        if (res.bitrate) {
            currentBitrate = res.bitrate;
        }
        updateBitrateUI();
    });

    document.querySelectorAll('.btn-bitrate').forEach(btn => {
        btn.addEventListener('click', (e) => {
            currentBitrate = e.target.dataset.bitrate;
            chrome.storage.local.set({ bitrate: currentBitrate });
            updateBitrateUI();
        });
    });
}

function updateBitrateUI() {
    document.querySelectorAll('.btn-bitrate').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.bitrate === currentBitrate);
    });
}

/**
 * Settings Drawer Logic
 */
function initSettingsDrawer() {
    const settingsPanel = document.getElementById('settings-panel');
    const btnToggleSettings = document.getElementById('btn-toggle-settings');
    const btnCloseSettings = document.getElementById('btn-close-settings');
    const serverStatusBadge = document.getElementById('server-status');
    const btnSaveSettings = document.getElementById('btn-save-settings');
    const statusMsg = document.getElementById('settings-status-msg');
    const btnToggleKey = document.getElementById('btn-toggle-key-visibility');
    const apiKeyInput = document.getElementById('setting-api-key');

    function toggleDrawer(open) {
        if (open === undefined) {
            settingsPanel.classList.toggle('hidden');
        } else if (open) {
            settingsPanel.classList.remove('hidden');
        } else {
            settingsPanel.classList.add('hidden');
        }
    }

    if (btnToggleSettings) btnToggleSettings.addEventListener('click', () => toggleDrawer());
    if (btnCloseSettings) btnCloseSettings.addEventListener('click', () => toggleDrawer(false));
    if (serverStatusBadge) {
        serverStatusBadge.addEventListener('click', () => toggleDrawer(true));
    }

    if (btnToggleKey && apiKeyInput) {
        btnToggleKey.addEventListener('click', () => {
            const isPassword = apiKeyInput.type === 'password';
            apiKeyInput.type = isPassword ? 'text' : 'password';
            btnToggleKey.textContent = isPassword ? '🔒' : '👁️';
        });
    }

    if (btnSaveSettings) {
        btnSaveSettings.addEventListener('click', async () => {
            const urlInput = document.getElementById('setting-server-url').value.trim();
            const keyInput = document.getElementById('setting-api-key').value.trim();
            const autoDlInput = document.getElementById('setting-auto-download').checked;

            if (!urlInput) {
                statusMsg.textContent = '⚠️ Enter a valid server URL';
                statusMsg.style.color = 'var(--warning)';
                return;
            }

            statusMsg.textContent = 'Testing connection...';
            statusMsg.style.color = 'var(--text-muted)';
            btnSaveSettings.disabled = true;

            try {
                const testRes = await fetch(`${urlInput.replace(/\/+$/, '')}/health`, {
                    headers: keyInput ? { 'X-API-Key': keyInput } : {}
                });

                if (!testRes.ok) {
                    throw new Error(`Server returned HTTP ${testRes.status}`);
                }

                chrome.runtime.sendMessage({
                    action: 'SAVE_CONFIG',
                    serverUrl: urlInput,
                    apiKey: keyInput,
                    autoDownload: autoDlInput
                }, () => {
                    SERVER_URL = urlInput.replace(/\/+$/, '');
                    API_KEY = keyInput;
                    AUTO_DOWNLOAD = autoDlInput;

                    statusMsg.textContent = 'Connected & Saved ✓';
                    statusMsg.style.color = 'var(--success)';
                    btnSaveSettings.disabled = false;

                    reconnectAttempts = 0;
                    initServerConnection();

                    setTimeout(() => {
                        toggleDrawer(false);
                        statusMsg.textContent = '';
                    }, 1200);
                });

            } catch (err) {
                statusMsg.textContent = `❌ ${err.message}`;
                statusMsg.style.color = 'var(--danger)';
                btnSaveSettings.disabled = false;
            }
        });
    }
}

/**
 * General UI Event Listeners
 */
function initUIEventListeners() {
    // Add to Queue button
    document.getElementById('btn-add-queue').addEventListener('click', async () => {
        const text = document.getElementById('url-input').value.trim();
        if (!text) return;

        const urls = text.split('\n').map(u => u.trim()).filter(u => u.length > 0);
        if (urls.length === 0) return;

        document.getElementById('url-input').value = '';

        try {
            // Retrieve fresh client YouTube cookies from background worker
            const cookieRes = await new Promise(res => {
                chrome.runtime.sendMessage({ action: 'GET_YOUTUBE_COOKIES' }, r => res(r || {}));
            });
            const cookies = cookieRes.cookies || '';

            if (urls.length === 1) {
                await apiFetch('/api/download', {
                    method: 'POST',
                    body: JSON.stringify({ url: urls[0], bitrate: currentBitrate, cookies })
                });
            } else {
                await apiFetch('/api/download-batch', {
                    method: 'POST',
                    body: JSON.stringify({ urls, bitrate: currentBitrate, cookies })
                });
            }
            chrome.runtime.sendMessage({ action: 'START_POLLING' });
            refreshQueueNow();
        } catch (err) {
            console.error('Queue add failed:', err.message);
        }

    });

    // Clear completed button
    document.getElementById('btn-clear-completed').addEventListener('click', async () => {
        try {
            await apiFetch('/api/queue/clear-completed', { method: 'POST' });
            refreshQueueNow();
        } catch (err) {
            console.error('Clear failed:', err.message);
        }
    });

    // Concurrency selector
    document.getElementById('concurrency-select').addEventListener('change', async (e) => {
        try {
            await apiFetch('/api/settings/concurrency', {
                method: 'POST',
                body: JSON.stringify({ limit: e.target.value })
            });
        } catch (err) {
            console.error('Concurrency change failed:', err.message);
        }
    });
}

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return 'MP3';
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(1)} MB`;
}

/**
 * Stage descriptions, icons, and progress numbers for clear UX
 */
function getStageInfo(item) {
    const status = item.status;
    const stage = item.stage;
    const progress = item.progress || 0;

    if (status === 'error' || stage === 'failed') {
        return {
            icon: '⚠️',
            text: item.error ? `Error: ${item.error}` : 'Conversion Failed',
            percent: 0,
            isError: true
        };
    }

    if (status === 'completed' || item.downloadReady || stage === 'ready') {
        return {
            icon: '🟢',
            text: 'Download Ready! (100%)',
            percent: 100,
            isReady: true
        };
    }

    if (status === 'decoding_ffmpeg' || stage === 'decoding_ffmpeg') {
        return {
            icon: '⚙️',
            text: `FFmpeg Converting (${item.bitrate || '320k'})...`,
            percent: Math.max(progress, 82),
            animating: true
        };
    }

    if (status === 'tagging' || stage === 'tagging') {
        return {
            icon: '🎨',
            text: 'Embedding ID3 Cover Art & Tags...',
            percent: Math.max(progress, 90),
            animating: true
        };
    }

    if (status === 'downloading' || stage === 'downloading') {
        return {
            icon: '📥',
            text: `Downloading Audio Stream (${progress}%)`,
            percent: progress,
            animating: true
        };
    }

    if (stage === 'fetching_meta') {
        return {
            icon: '📡',
            text: 'Fetching Video Details...',
            percent: 5,
            animating: true
        };
    }

    return {
        icon: '⏳',
        text: 'Waiting in Queue...',
        percent: 0,
        animating: false
    };
}

/**
 * Render Queue List & Dynamic Progress Bars
 */
function renderQueue(state) {
    if (!state) return;

    const queueList = document.getElementById('queue-list');
    const queueCountTag = document.getElementById('queue-count-tag');
    const concurrencySelect = document.getElementById('concurrency-select');

    if (concurrencySelect && state.maxConcurrency) {
        concurrencySelect.value = state.maxConcurrency;
    }

    queueCountTag.textContent = `${state.totalItems || 0} items`;

    // Notify background worker to update badge
    chrome.runtime.sendMessage({
        action: 'UPDATE_BADGE',
        pendingCount: state.pendingCount,
        activeCount: state.downloadingCount
    });

    if (!state.items || state.items.length === 0) {
        renderEmptyState();
        return;
    }

    queueList.innerHTML = '';

    state.items.forEach(item => {
        const stageInfo = getStageInfo(item);
        const thumbSrc = item.thumbnail || 'icons/icon48.png';
        const isReady = item.downloadReady || item.status === 'completed';
        const isSaved = savedToDeviceItems.has(item.id);

        // Auto-download to PC if enabled and ready
        if (isReady && AUTO_DOWNLOAD && !isSaved) {
            triggerSaveToDevice(item);
        }

        // Resolve absolute downloadable link for manual download
        let downloadUrl = item.downloadUrl;
        if (!downloadUrl || !downloadUrl.startsWith('http')) {
            const tokenParam = item.downloadToken ? `&token=${encodeURIComponent(item.downloadToken)}` : '';
            downloadUrl = `${SERVER_URL}/api/download-file/${item.id}?apiKey=${encodeURIComponent(API_KEY)}${tokenParam}`;
        } else if (!downloadUrl.includes('apiKey=') && API_KEY) {
            downloadUrl += (downloadUrl.includes('?') ? '&' : '?') + `apiKey=${encodeURIComponent(API_KEY)}`;
        }

        const card = document.createElement('div');
        card.className = `queue-item ${item.status}`;

        card.innerHTML = `
            <div class="item-thumb-wrapper">
                <img class="item-thumb" src="${escapeHtml(thumbSrc)}" alt="thumb" onerror="this.src='icons/icon48.png'">
                <span class="item-badge-bitrate">${escapeHtml(item.bitrate || '320k')}</span>
            </div>
            
            <div class="item-details">
                <div class="item-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
                <div class="item-channel">${escapeHtml(item.channel || 'YouTube')}</div>

                <!-- Multi-stage Dynamic Progress Bar -->
                <div class="progress-section">
                    <div class="progress-header-row">
                        <span class="stage-desc">
                            <span>${stageInfo.icon}</span>
                            <span>${escapeHtml(stageInfo.text)}</span>
                        </span>
                        <span class="percent-tag ${isReady ? 'completed' : ''}">${stageInfo.percent}%</span>
                    </div>

                    <div class="progress-bar-bg">
                        <div class="progress-bar-fill ${stageInfo.animating ? 'animating' : ''} ${isReady ? 'ready' : ''}" 
                             style="width: ${stageInfo.percent}%"></div>
                    </div>
                </div>

                <!-- Action Button for End User Device Download & Temp Manual Link -->
                ${isReady ? `
                    <div class="download-ready-box">
                        ${isSaved ? `
                            <span class="badge-saved">💾 Saved to PC (${formatBytes(item.fileSize)}) ✓</span>
                        ` : `
                            <button class="btn-save-device" data-id="${item.id}" title="Save file directly to PC Downloads folder">
                                ⬇️ Save to PC (${formatBytes(item.fileSize)})
                            </button>
                        `}
                        <a class="btn-temp-link" href="${escapeHtml(downloadUrl)}" target="_blank" download="${escapeHtml(item.filename || 'audio.mp3')}" title="Open temporary direct download link in browser">
                            🔗 Temp Link
                        </a>
                        <button class="btn-copy-temp" data-url="${escapeHtml(downloadUrl)}" title="Copy direct temporary download link to clipboard">
                            📋 Copy
                        </button>
                        <span class="temp-link-note">⏱️ Temp link valid for 30 minutes</span>
                    </div>
                ` : ''}
            </div>

            <div class="item-actions">
                ${item.status === 'error' ? `
                    <button class="btn-icon btn-retry" data-id="${item.id}" title="Retry">🔄</button>
                ` : ''}
                <button class="btn-icon btn-remove" data-id="${item.id}" title="Remove">✕</button>
            </div>
        `;

        // Save to PC button handler
        const btnSave = card.querySelector('.btn-save-device');
        if (btnSave) {
            btnSave.addEventListener('click', () => {
                triggerSaveToDevice(item, true);
            });
        }

        // Copy Temp Link handler
        const btnCopy = card.querySelector('.btn-copy-temp');
        if (btnCopy) {
            btnCopy.addEventListener('click', (e) => {
                e.preventDefault();
                const url = btnCopy.getAttribute('data-url');
                navigator.clipboard.writeText(url).then(() => {
                    btnCopy.textContent = 'Copied! ✓';
                    setTimeout(() => { btnCopy.textContent = '📋 Copy'; }, 2000);
                });
            });
        }

        // Remove item handler
        const btnRemove = card.querySelector('.btn-remove');
        if (btnRemove) {
            btnRemove.addEventListener('click', () => removeItem(item.id));
        }

        // Retry item handler
        const btnRetry = card.querySelector('.btn-retry');
        if (btnRetry) {
            btnRetry.addEventListener('click', () => retryItem(item.id));
        }

        queueList.appendChild(card);
    });
}

/**
 * Trigger saving converted MP3 to end user's PC device
 */
function triggerSaveToDevice(item, explicitClick = false) {
    savedToDeviceItems.add(item.id);
    chrome.runtime.sendMessage({
        action: 'TRIGGER_DEVICE_DOWNLOAD',
        item: item,
        explicitClick: explicitClick
    }, (res) => {
        if (res && res.success) {
            refreshQueueNow();
        } else if (res && res.error) {
            savedToDeviceItems.delete(item.id);
            console.error('Device download error:', res.error);
        }
    });
}

function renderEmptyState(customMsg) {
    const queueList = document.getElementById('queue-list');
    queueList.innerHTML = `
        <div class="empty-state">
            <div class="empty-icon">🎵</div>
            <p>${customMsg || 'No downloads in queue'}</p>
            <span class="empty-sub">Click "Download MP3" on any YouTube video or paste URLs above!</span>
        </div>
    `;
}

async function removeItem(id) {
    try {
        await apiFetch(`/api/queue/${id}`, { method: 'DELETE' });
        refreshQueueNow();
    } catch (err) {
        console.error('Remove failed:', err.message);
    }
}

async function retryItem(id) {
    try {
        await apiFetch(`/api/queue/retry/${id}`, { method: 'POST' });
        chrome.runtime.sendMessage({ action: 'START_POLLING' });
        refreshQueueNow();
    } catch (err) {
        console.error('Retry failed:', err.message);
    }
}

function escapeHtml(text) {
    if (!text) return '';
    return String(text).replace(/[&<>"']/g, function (m) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m];
    });
}
