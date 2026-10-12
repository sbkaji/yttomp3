/**
 * Popup Controller — Production Ready
 * =====================================
 * Connects to the remote production server with API key authentication.
 * SSE event streaming, queue management, retry logic.
 */

let SERVER_URL = '';
let API_KEY = '';
let eventSource = null;
let currentBitrate = '320k';
let reconnectTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_BASE_DELAY = 2000; // 2s, doubles on each retry

document.addEventListener('DOMContentLoaded', () => {
    // Load server config from background worker
    chrome.runtime.sendMessage({ action: 'GET_SERVER_URL' }, (response) => {
        if (response) {
            SERVER_URL = response.serverUrl;
            API_KEY = response.apiKey;
        }
        initBitrateSelector();
        initServerConnection();
        initUIEventListeners();
    });
});

/**
 * Build headers with API key
 */
function getAuthHeaders(contentType = false) {
    const headers = { 'X-API-Key': API_KEY };
    if (contentType) headers['Content-Type'] = 'application/json';
    return headers;
}

/**
 * Authenticated fetch wrapper
 */
async function apiFetch(url, options = {}) {
    const response = await fetch(url, {
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

// Initialize Bitrate Selector
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

// Connect to Server & SSE EventStream
function initServerConnection() {
    const statusBadge = document.getElementById('server-status');
    const statusText = document.getElementById('status-text');

    statusBadge.className = 'status-badge connecting';
    statusText.textContent = 'Connecting...';

    fetch(`${SERVER_URL}/health`, { headers: getAuthHeaders() })
        .then(res => res.json())
        .then((data) => {
            statusBadge.className = 'status-badge online';
            statusText.textContent = 'Engine Online';
            reconnectAttempts = 0;
            connectSSE();
        })
        .catch((err) => {
            statusBadge.className = 'status-badge offline';
            statusText.textContent = 'Engine Offline';
            renderEmptyState('Server unreachable. Check your server is running.');
            scheduleReconnect();
        });
}

// Schedule reconnection with exponential backoff
function scheduleReconnect() {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        document.getElementById('status-text').textContent = 'Connection Failed';
        return;
    }

    const delay = RECONNECT_BASE_DELAY * Math.pow(2, Math.min(reconnectAttempts, 5));
    reconnectAttempts++;

    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
        initServerConnection();
    }, delay);
}

// Subscribe to SSE Live Updates from Server
function connectSSE() {
    if (eventSource) eventSource.close();

    // EventSource doesn't support custom headers natively, so we pass apiKey as query param
    const sseUrl = `${SERVER_URL}/api/events?apiKey=${encodeURIComponent(API_KEY)}`;
    eventSource = new EventSource(sseUrl);

    eventSource.addEventListener('queue_update', (e) => {
        const payload = JSON.parse(e.data);
        renderQueue(payload.state);
    });

    eventSource.addEventListener('init', (e) => {
        const payload = JSON.parse(e.data);
        renderQueue(payload.state);
    });

    eventSource.addEventListener('server_shutdown', () => {
        document.getElementById('server-status').className = 'status-badge offline';
        document.getElementById('status-text').textContent = 'Server Shutting Down';
    });

    eventSource.onerror = () => {
        document.getElementById('server-status').className = 'status-badge offline';
        document.getElementById('status-text').textContent = 'Reconnecting...';
        scheduleReconnect();
    };
}

// UI Event Listeners
function initUIEventListeners() {
    // Add to Queue button
    document.getElementById('btn-add-queue').addEventListener('click', async () => {
        const text = document.getElementById('url-input').value.trim();
        if (!text) return;

        const urls = text.split('\n').map(u => u.trim()).filter(u => u.length > 0);
        if (urls.length === 0) return;

        document.getElementById('url-input').value = '';

        try {
            if (urls.length === 1) {
                await apiFetch(`${SERVER_URL}/api/download`, {
                    method: 'POST',
                    body: JSON.stringify({ url: urls[0], bitrate: currentBitrate })
                });
            } else {
                await apiFetch(`${SERVER_URL}/api/download-batch`, {
                    method: 'POST',
                    body: JSON.stringify({ urls, bitrate: currentBitrate })
                });
            }
        } catch (err) {
            console.error('Queue add failed:', err.message);
        }
    });

    // Clear completed button
    document.getElementById('btn-clear-completed').addEventListener('click', async () => {
        try {
            await apiFetch(`${SERVER_URL}/api/queue/clear-completed`, { method: 'POST' });
        } catch (err) {
            console.error('Clear failed:', err.message);
        }
    });

    // Concurrency selector
    document.getElementById('concurrency-select').addEventListener('change', async (e) => {
        try {
            await apiFetch(`${SERVER_URL}/api/settings/concurrency`, {
                method: 'POST',
                body: JSON.stringify({ limit: e.target.value })
            });
        } catch (err) {
            console.error('Concurrency change failed:', err.message);
        }
    });
}

// Render Queue List & Items
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
        const card = document.createElement('div');
        card.className = 'queue-item';

        const thumbSrc = item.thumbnail || 'icons/icon48.png';
        const progress = item.progress || 0;
        const stageLabel = getStageLabel(item.status, item.stage);

        card.innerHTML = `
            <img class="item-thumb" src="${thumbSrc}" alt="thumb" onerror="this.src='icons/icon48.png'">
            <div class="item-details">
                <div class="item-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
                <div class="item-meta">
                    <span>${escapeHtml(item.channel || 'YouTube')}</span>
                    <span class="status-tag ${item.status}">${stageLabel}</span>
                </div>
                ${item.status !== 'completed' && item.status !== 'error' ? `
                    <div class="progress-bar-bg">
                        <div class="progress-bar-fill" style="width: ${progress}%"></div>
                    </div>
                ` : ''}
                ${item.error ? `<div style="font-size: 10px; color: var(--danger); margin-top:2px;">${escapeHtml(item.error)}</div>` : ''}
            </div>
            <div class="item-actions">
                ${item.status === 'error' ? `
                    <button class="btn-icon btn-retry" data-id="${item.id}" title="Retry">🔄</button>
                ` : ''}
                <button class="btn-icon btn-remove" data-id="${item.id}" title="Remove">✕</button>
            </div>
        `;

        // Event listeners for item actions
        const btnRemove = card.querySelector('.btn-remove');
        if (btnRemove) {
            btnRemove.addEventListener('click', () => removeItem(item.id));
        }

        const btnRetry = card.querySelector('.btn-retry');
        if (btnRetry) {
            btnRetry.addEventListener('click', () => retryItem(item.id));
        }

        queueList.appendChild(card);
    });
}

function getStageLabel(status, stage) {
    if (status === 'decoding_ffmpeg') return 'FFmpeg MP3...';
    if (status === 'tagging') return 'ID3 Tagging...';
    if (status === 'downloading') return 'Downloading Audio...';
    if (status === 'completed') return 'Done (MP3)';
    if (status === 'error') return 'Failed';
    return 'Queued';
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
        await apiFetch(`${SERVER_URL}/api/queue/${id}`, { method: 'DELETE' });
    } catch (err) {
        console.error('Remove failed:', err.message);
    }
}

async function retryItem(id) {
    try {
        await apiFetch(`${SERVER_URL}/api/queue/retry/${id}`, { method: 'POST' });
    } catch (err) {
        console.error('Retry failed:', err.message);
    }
}

function escapeHtml(text) {
    if (!text) return '';
    return text.replace(/[&<>"']/g, function (m) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m];
    });
}
