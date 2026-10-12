/**
 * YouTube MP3 Engine — Server Panel Controller
 * =============================================
 * Real-time forensic audit dashboard tracking
 * WHAT, WHERE, WHEN, and HOW videos are downloaded.
 */

let API_KEY = localStorage.getItem('ytmp3_admin_key') || '';
let currentPage = 1;
const PAGE_LIMIT = 20;
let currentSearch = '';
let currentStatus = 'all';
let refreshTimer = null;
let sseConnection = null;
let cachedRecords = [];

// DOM Elements
const kpiDownloads = document.getElementById('kpi-downloads');
const kpiSuccessRate = document.getElementById('kpi-success-rate');
const kpiRequestsMeta = document.getElementById('kpi-requests-meta');
const kpiBandwidth = document.getElementById('kpi-bandwidth');
const kpiTempFiles = document.getElementById('kpi-temp-files');
const kpiTempSize = document.getElementById('kpi-temp-size');
const kpiTempPath = document.getElementById('kpi-temp-path');
const kpiAvgSpeed = document.getElementById('kpi-avg-speed');
const kpiRam = document.getElementById('kpi-ram');
const kpiUptime = document.getElementById('kpi-uptime');
const serverHealthChip = document.getElementById('server-health-chip');
const chipStatus = document.getElementById('chip-status');

const activeQueueList = document.getElementById('active-queue-list');
const activeQueueCount = document.getElementById('active-queue-count');
const auditTableBody = document.getElementById('audit-table-body');
const searchInput = document.getElementById('search-input');
const btnClearSearch = document.getElementById('btn-clear-search');
const filterStatus = document.getElementById('filter-status');
const btnRefresh = document.getElementById('btn-refresh');
const btnClearHistory = document.getElementById('btn-clear-history');
const btnPurgeTemp = document.getElementById('btn-purge-temp');

const btnPrevPage = document.getElementById('btn-prev-page');
const btnNextPage = document.getElementById('btn-next-page');
const pageIndicator = document.getElementById('page-indicator');
const showingRange = document.getElementById('showing-range');
const totalRecordsCount = document.getElementById('total-records-count');

// Modals
const detailsModal = document.getElementById('details-modal');
const btnCloseModal = document.getElementById('btn-close-modal');
const modalContent = document.getElementById('modal-content');

const authModal = document.getElementById('auth-modal');
const btnCloseAuthModal = document.getElementById('btn-close-auth-modal');
const btnAuthLock = document.getElementById('btn-auth-lock');
const btnSaveAuth = document.getElementById('btn-save-auth');
const adminApiKeyInput = document.getElementById('admin-api-key-input');
const authFeedback = document.getElementById('auth-feedback');

// Initialize on Load
document.addEventListener('DOMContentLoaded', () => {
    initAuth();
    initEventListeners();
    loadDashboard();
    startLiveSync();
});

/**
 * Fetch wrapper attaching API Key authentication
 */
async function apiFetch(endpoint, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (API_KEY) {
        headers['X-API-Key'] = API_KEY;
    }
    if (options.method === 'POST') {
        headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(endpoint, { ...options, headers });

    if (res.status === 401 || res.status === 403) {
        showAuthModal('Authentication required or invalid API key.');
        throw new Error('Unauthorized');
    }

    if (!res.ok) {
        const errorBody = await res.json().catch(() => ({}));
        throw new Error(errorBody.error || `HTTP ${res.status}`);
    }

    return res.json();
}

/**
 * Initialize Authentication State
 */
async function initAuth() {
    if (adminApiKeyInput && API_KEY) {
        adminApiKeyInput.value = API_KEY;
    }

    try {
        const check = await apiFetch('/api/admin/auth-check');
        if (check.authenticated) {
            updateChipStatus('online', 'Server Online');
        }
    } catch (e) {
        // Handled in apiFetch
    }
}

function showAuthModal(msg = '') {
    authModal.classList.remove('hidden');
    if (msg) {
        authFeedback.textContent = msg;
        authFeedback.className = 'auth-feedback error';
    }
}

function hideAuthModal() {
    authModal.classList.add('hidden');
    authFeedback.textContent = '';
}

/**
 * Main Dashboard Data Loader
 */
async function loadDashboard() {
    try {
        await Promise.all([
            fetchStats(),
            fetchHistory()
        ]);
    } catch (err) {
        console.error('Failed to load dashboard:', err.message);
    }
}

/**
 * Fetch Stats & KPIs
 */
async function fetchStats() {
    try {
        const data = await apiFetch('/api/admin/stats');
        renderStats(data);
        renderActiveQueue(data.queueSnapshot);
    } catch (err) {
        console.error('Stats fetch error:', err.message);
    }
}

/**
 * Render KPIs
 */
function renderStats(data) {
    if (!data) return;

    const s = data.server || {};
    const d = data.downloadStats || {};

    // Downloads KPI
    kpiDownloads.textContent = d.totalDownloaded || 0;
    kpiSuccessRate.textContent = `${d.successRate || 100}% OK`;
    kpiRequestsMeta.textContent = `${d.totalRequests || 0} total requests`;

    // Bandwidth Delivered
    const mb = parseFloat(d.totalMbDownloaded || 0);
    if (mb > 1024) {
        kpiBandwidth.textContent = `${(mb / 1024).toFixed(2)} GB`;
    } else {
        kpiBandwidth.textContent = `${mb.toFixed(1)} MB`;
    }

    // Server Temp Storage
    const temp = s.tempStorage || {};
    kpiTempFiles.textContent = `${temp.filesHeld || 0} Files`;
    kpiTempSize.textContent = `${temp.sizeMb || '0.0'} MB`;
    kpiTempPath.textContent = temp.path ? `In: ${temp.path}` : 'Auto-cleaned on download';

    // Avg Speed & Uptime
    kpiAvgSpeed.textContent = `${d.avgConversionSec || '0.0'}s`;
    kpiRam.textContent = `${s.memory ? s.memory.heapUsedMb : 0} MB RAM`;

    const uptimeSec = s.uptimeSec || 0;
    const hours = Math.floor(uptimeSec / 3600);
    const minutes = Math.floor((uptimeSec % 3600) / 60);
    kpiUptime.textContent = `Uptime: ${hours > 0 ? `${hours}h ` : ''}${minutes}m`;

    updateChipStatus('online', `${s.environment || 'prod'} • Node ${s.nodeVersion || ''}`);
}

function updateChipStatus(status, text) {
    serverHealthChip.className = `server-health-chip ${status}`;
    chipStatus.textContent = text;
}

/**
 * Render Active Processing Queue
 */
function renderActiveQueue(queueSnapshot) {
    if (!queueSnapshot || !queueSnapshot.items) {
        activeQueueCount.textContent = '0 processing';
        activeQueueList.innerHTML = `<div class="empty-queue-note"><span>✨ Engine idle — Ready for incoming conversion requests</span></div>`;
        return;
    }

    const activeItems = queueSnapshot.items.filter(i => ['pending', 'downloading', 'decoding_ffmpeg', 'tagging'].includes(i.status));
    activeQueueCount.textContent = `${activeItems.length} processing`;

    if (activeItems.length === 0) {
        activeQueueList.innerHTML = `<div class="empty-queue-note"><span>✨ Engine idle — Ready for incoming conversion requests</span></div>`;
        return;
    }

    activeQueueList.innerHTML = '';
    activeItems.forEach(item => {
        const el = document.createElement('div');
        el.className = 'active-queue-item';

        const thumb = item.thumbnail || 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="60" height="42"><rect fill="%231e293b" width="60" height="42"/></svg>';
        const progress = item.progress || 10;
        const stageLabel = getStageLabel(item.status, item.stage);

        el.innerHTML = `
            <img class="queue-thumb" src="${escapeHtml(thumb)}" alt="thumb">
            <div class="queue-details">
                <div class="queue-title-row">
                    <span class="queue-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</span>
                    <span style="font-size: 11px; font-weight: 700; color: var(--primary);">${progress}%</span>
                </div>
                <div style="font-size: 10px; color: var(--text-muted); display:flex; justify-content:space-between;">
                    <span>${escapeHtml(item.channel || 'YouTube')} • ${escapeHtml(item.bitrate || '320k')}</span>
                    <span>${stageLabel}</span>
                </div>
                <div class="queue-progress-bar-bg">
                    <div class="queue-progress-bar-fill" style="width: ${progress}%"></div>
                </div>
            </div>
        `;
        activeQueueList.appendChild(el);
    });
}

function getStageLabel(status, stage) {
    if (status === 'decoding_ffmpeg' || stage === 'decoding_ffmpeg') return '⚙️ FFmpeg Encoding...';
    if (status === 'tagging' || stage === 'tagging') return '🎨 Embedding ID3 Tags...';
    if (status === 'downloading' || stage === 'downloading') return '📥 Downloading Audio...';
    return '⏳ Queued';
}

/**
 * Fetch History Audit Log (What, Where, When, How)
 */
async function fetchHistory() {
    try {
        const query = new URLSearchParams({
            search: currentSearch,
            status: currentStatus,
            page: currentPage,
            limit: PAGE_LIMIT
        });

        const data = await apiFetch(`/api/admin/history?${query.toString()}`);
        cachedRecords = data.records || [];
        renderHistoryTable(data);
    } catch (err) {
        console.error('History fetch error:', err.message);
        auditTableBody.innerHTML = `<tr><td colspan="5" class="table-empty-cell">❌ Error loading history: ${escapeHtml(err.message)}</td></tr>`;
    }
}

/**
 * Render Audit Table Rows
 */
function renderHistoryTable(data) {
    const records = data.records || [];
    const total = data.total || 0;

    totalRecordsCount.textContent = total;

    if (records.length === 0) {
        showingRange.textContent = '0-0';
        auditTableBody.innerHTML = `
            <tr>
                <td colspan="5" class="table-empty-cell">
                    <div style="font-size: 24px; margin-bottom: 6px;">🎵</div>
                    <span>No download audit records found matching your filters.</span>
                </td>
            </tr>
        `;
        btnPrevPage.disabled = true;
        btnNextPage.disabled = true;
        pageIndicator.textContent = `Page 1 of 1`;
        return;
    }

    const startIdx = (currentPage - 1) * PAGE_LIMIT + 1;
    const endIdx = Math.min(startIdx + records.length - 1, total);
    showingRange.textContent = `${startIdx}-${endIdx}`;

    pageIndicator.textContent = `Page ${data.page} of ${data.totalPages || 1}`;
    btnPrevPage.disabled = data.page <= 1;
    btnNextPage.disabled = data.page >= data.totalPages;

    auditTableBody.innerHTML = '';

    records.forEach(item => {
        const tr = document.createElement('tr');
        tr.addEventListener('click', () => openDetailsModal(item));

        const thumb = item.thumbnail || 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="44"><rect fill="%231e293b" width="64" height="44"/></svg>';
        const fileSizeStr = formatBytes(item.fileSize);
        const ytLink = item.videoId ? `https://youtu.be/${item.videoId}` : (item.url || '#');

        // Status badge
        let statusBadgeClass = item.status;
        let statusLabel = item.status;
        if (item.status === 'downloaded') {
            statusLabel = '💾 Downloaded to PC ✓';
        } else if (item.status === 'ready') {
            statusLabel = '🟢 Ready in Temp';
        } else if (item.status === 'converting') {
            statusLabel = '⚙️ Converting...';
        } else if (item.status === 'failed') {
            statusLabel = '⚠️ Failed';
        } else {
            statusLabel = '⏳ Queued';
        }

        // Temp cleaner tag
        const tempCleanedTag = item.tempCleaned
            ? `<span class="temp-status-tag cleaned">🗑️ Temp Purged</span>`
            : (item.status === 'ready' ? `<span class="temp-status-tag">💾 Buffered in Temp</span>` : '');

        // Formatted Times
        const requestedDate = item.requestedAt ? new Date(item.requestedAt) : new Date();
        const timeFormatted = requestedDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const dateFormatted = requestedDate.toLocaleDateString([], { month: 'short', day: 'numeric' });
        const relativeTime = getRelativeTime(requestedDate);

        const durationStr = item.conversionDurationMs ? `${(item.conversionDurationMs / 1000).toFixed(1)}s` : '';

        tr.innerHTML = `
            <!-- WHAT -->
            <td>
                <div class="what-cell">
                    <img class="table-thumb" src="${escapeHtml(thumb)}" alt="thumb" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'64\\' height=\\'44\\'><rect fill=\\'%231e293b\\' width=\\'64\\' height=\\'44\\'/></svg>'">
                    <div class="what-meta">
                        <div class="what-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
                        <div class="what-sub-row">
                            <span>${escapeHtml(item.channel || 'YouTube')}</span>
                            <span class="badge-bitrate">${escapeHtml(item.bitrate || '320k')}</span>
                            ${item.fileSize ? `<span>• ${fileSizeStr}</span>` : ''}
                        </div>
                    </div>
                </div>
            </td>

            <!-- WHERE -->
            <td>
                <div class="where-cell">
                    <span class="ip-tag" title="Client IP address">${escapeHtml(item.clientIp || '127.0.0.1')}</span>
                    <div class="where-agent" title="${escapeHtml(item.userAgent || '')}">
                        ${escapeHtml(item.clientOrigin || 'Chrome Extension')}
                    </div>
                </div>
            </td>

            <!-- WHEN -->
            <td>
                <div class="when-cell">
                    <div class="when-time">${timeFormatted} <span style="font-weight:400; color:var(--text-muted);">(${dateFormatted})</span></div>
                    <div class="when-relative">${relativeTime}</div>
                    ${durationStr ? `<div class="when-duration">⏱️ Conversion: ${durationStr}</div>` : ''}
                </div>
            </td>

            <!-- HOW -->
            <td>
                <div class="how-cell">
                    <span class="status-badge-lg ${statusBadgeClass}">${statusLabel}</span>
                    ${tempCleanedTag}
                </div>
            </td>

            <!-- ACTIONS -->
            <td>
                <div style="display:flex; gap:6px;">
                    <a href="${escapeHtml(ytLink)}" target="_blank" rel="noopener noreferrer" class="btn-table-action" title="Open YouTube Video" onclick="event.stopPropagation();">
                        ▶ Watch
                    </a>
                    <button class="btn-table-action" title="View Full Forensic Details">
                        Inspect
                    </button>
                </div>
            </td>
        `;

        auditTableBody.appendChild(tr);
    });
}

/**
 * Open Detailed Forensic Breakdown Modal
 */
function openDetailsModal(item) {
    if (!item) return;

    const ytLink = item.videoId ? `https://youtu.be/${item.videoId}` : (item.url || '#');

    modalContent.innerHTML = `
        <div class="detail-grid">
            <!-- WHAT -->
            <div class="detail-block">
                <h4><span>🎵</span> WHAT (Audio & Video)</h4>
                <div class="detail-row">
                    <span class="detail-label">Title:</span>
                    <span class="detail-val">${escapeHtml(item.title)}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Channel/Artist:</span>
                    <span class="detail-val">${escapeHtml(item.channel || 'Unknown')}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Target Bitrate:</span>
                    <span class="detail-val mono">${escapeHtml(item.bitrate || '320k')} pure MP3</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Output Filename:</span>
                    <span class="detail-val mono">${escapeHtml(item.filename || 'Pending...')}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">File Size:</span>
                    <span class="detail-val mono">${formatBytes(item.fileSize)}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">YouTube Link:</span>
                    <span class="detail-val"><a href="${escapeHtml(ytLink)}" target="_blank" style="color:var(--primary); text-decoration:none;">Open in YouTube ↗</a></span>
                </div>
            </div>

            <!-- WHERE -->
            <div class="detail-block">
                <h4><span>🌐</span> WHERE (Client & Network)</h4>
                <div class="detail-row">
                    <span class="detail-label">Client IP:</span>
                    <span class="detail-val mono">${escapeHtml(item.clientIp || '127.0.0.1')}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Client Origin:</span>
                    <span class="detail-val">${escapeHtml(item.clientOrigin || 'Chrome Extension')}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">User Agent:</span>
                    <span class="detail-val" style="font-size:10px;">${escapeHtml(item.userAgent || 'Unknown')}</span>
                </div>
                ${item.downloadClientIp ? `
                    <div class="detail-row">
                        <span class="detail-label">Download Stream IP:</span>
                        <span class="detail-val mono">${escapeHtml(item.downloadClientIp)}</span>
                    </div>
                ` : ''}
            </div>

            <!-- WHEN -->
            <div class="detail-block">
                <h4><span>⏱️</span> WHEN (Timeline Milestones)</h4>
                <div class="detail-row">
                    <span class="detail-label">Requested At:</span>
                    <span class="detail-val mono">${formatDateFull(item.requestedAt)}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Conversion Started:</span>
                    <span class="detail-val mono">${formatDateFull(item.conversionStartedAt)}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Conversion Completed:</span>
                    <span class="detail-val mono">${formatDateFull(item.convertedAt)}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Streamed to Device:</span>
                    <span class="detail-val mono">${formatDateFull(item.downloadedAt)}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">FFmpeg Duration:</span>
                    <span class="detail-val mono">${item.conversionDurationMs ? `${(item.conversionDurationMs / 1000).toFixed(2)}s` : 'N/A'}</span>
                </div>
            </div>

            <!-- HOW -->
            <div class="detail-block">
                <h4><span>⚙️</span> HOW (Pipeline & Server State)</h4>
                <div class="detail-row">
                    <span class="detail-label">Audio Pipeline:</span>
                    <span class="detail-val">yt-dlp extract-audio + Linux FFmpeg</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">ID3 Metadata Tags:</span>
                    <span class="detail-val">Cover Artwork + Title + Artist</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Status:</span>
                    <span class="detail-val">${escapeHtml(item.status)}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Server Temp File:</span>
                    <span class="detail-val">${item.tempCleaned ? 'Purged from server disk 🗑️' : (item.status === 'ready' ? 'Buffered in temp disk 💾' : 'N/A')}</span>
                </div>
                ${item.error ? `
                    <div class="detail-row" style="color:var(--rose);">
                        <span class="detail-label">Error Details:</span>
                        <span class="detail-val">${escapeHtml(item.error)}</span>
                    </div>
                ` : ''}
            </div>
        </div>
    `;

    detailsModal.classList.remove('hidden');
}

/**
 * Event Listeners
 */
function initEventListeners() {
    // Search with debounce
    let searchTimeout = null;
    searchInput.addEventListener('input', (e) => {
        const val = e.target.value.trim();
        btnClearSearch.classList.toggle('hidden', val.length === 0);

        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
            currentSearch = val;
            currentPage = 1;
            fetchHistory();
        }, 300);
    });

    btnClearSearch.addEventListener('click', () => {
        searchInput.value = '';
        currentSearch = '';
        btnClearSearch.classList.add('hidden');
        currentPage = 1;
        fetchHistory();
    });

    // Status Filter
    filterStatus.addEventListener('change', (e) => {
        currentStatus = e.target.value;
        currentPage = 1;
        fetchHistory();
    });

    // Refresh Button
    btnRefresh.addEventListener('click', () => {
        btnRefresh.classList.add('rotating');
        loadDashboard().finally(() => {
            setTimeout(() => btnRefresh.classList.remove('rotating'), 500);
        });
    });

    // Pagination
    btnPrevPage.addEventListener('click', () => {
        if (currentPage > 1) {
            currentPage--;
            fetchHistory();
        }
    });

    btnNextPage.addEventListener('click', () => {
        currentPage++;
        fetchHistory();
    });

    // Clear History Action
    btnClearHistory.addEventListener('click', async () => {
        if (!confirm('Are you sure you want to clear all download audit history records?')) {
            return;
        }

        try {
            await apiFetch('/api/admin/clear-history', { method: 'POST' });
            loadDashboard();
        } catch (err) {
            alert(`Error clearing history: ${err.message}`);
        }
    });

    // Purge Server Temp Storage
    btnPurgeTemp.addEventListener('click', async () => {
        if (!confirm('Purge all temporary conversion files from server disk now?')) {
            return;
        }

        try {
            const res = await apiFetch('/api/admin/purge-temp', { method: 'POST' });
            alert(`Purged ${res.purgedCount || 0} temporary files.`);
            fetchStats();
        } catch (err) {
            alert(`Error purging temp: ${err.message}`);
        }
    });

    // Modals
    btnCloseModal.addEventListener('click', () => detailsModal.classList.add('hidden'));
    detailsModal.addEventListener('click', (e) => {
        if (e.target === detailsModal) detailsModal.classList.add('hidden');
    });

    btnAuthLock.addEventListener('click', () => showAuthModal());
    btnCloseAuthModal.addEventListener('click', () => hideAuthModal());
    authModal.addEventListener('click', (e) => {
        if (e.target === authModal) hideAuthModal();
    });

    // Save Auth Key
    btnSaveAuth.addEventListener('click', async () => {
        const key = adminApiKeyInput.value.trim();
        API_KEY = key;
        localStorage.setItem('ytmp3_admin_key', key);

        authFeedback.textContent = 'Verifying key...';
        authFeedback.className = 'auth-feedback';

        try {
            const check = await apiFetch('/api/admin/auth-check');
            if (check.authenticated) {
                authFeedback.textContent = 'Authenticated ✓';
                authFeedback.className = 'auth-feedback success';
                setTimeout(() => {
                    hideAuthModal();
                    loadDashboard();
                }, 800);
            }
        } catch (err) {
            authFeedback.textContent = 'Invalid API key';
            authFeedback.className = 'auth-feedback error';
        }
    });
}

/**
 * Start Live Sync Polling
 */
function startLiveSync() {
    // Refresh stats & queue every 3 seconds
    refreshTimer = setInterval(() => {
        fetchStats();
        // Also refresh history if on page 1 and no search query active
        if (currentPage === 1 && !currentSearch) {
            fetchHistory();
        }
    }, 3000);
}

/**
 * Format Helpers
 */
function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const mb = bytes / (1024 * 1024);
    if (mb >= 1) return `${mb.toFixed(1)} MB`;
    const kb = bytes / 1024;
    return `${kb.toFixed(0)} KB`;
}

function formatDateFull(isoStr) {
    if (!isoStr) return 'Not recorded';
    try {
        const d = new Date(isoStr);
        return d.toLocaleString([], {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    } catch (e) {
        return isoStr;
    }
}

function getRelativeTime(date) {
    const now = Date.now();
    const diff = Math.floor((now - date.getTime()) / 1000);

    if (diff < 5) return 'just now';
    if (diff < 60) return `${diff}s ago`;
    const mins = Math.floor(diff / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

function escapeHtml(text) {
    if (!text) return '';
    return String(text).replace(/[&<>"']/g, function (m) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m];
    });
}
