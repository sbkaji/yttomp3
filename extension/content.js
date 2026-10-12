/**
 * YouTube MP3 Downloader — Content Script
 * ========================================
 * High-reliability SPA-aware injection engine for YouTube desktop, mobile, and Shorts.
 * Real-time conversion progress indicator, auto-download feedback, and temporary manual link dock.
 */

(function () {
    let currentVideoId = null;
    let isInjecting = false;

    // Active download tracking: videoId -> { status, progress, stage, title, downloadUrl, isSaved }
    const activeDownloads = new Map();

    const MUSIC_ICON = `<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`;
    const CHECK_ICON = `<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`;
    const SPINNER_ICON = `<svg class="yt-mp3-spinner" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>`;
    const DOWNLOAD_ICON = `<svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>`;

    /**
     * Extract clean video ID from current URL
     */
    function getCurrentVideoId() {
        try {
            const urlObj = new URL(window.location.href);
            if (urlObj.pathname.startsWith('/watch')) {
                return urlObj.searchParams.get('v');
            }
            if (urlObj.pathname.startsWith('/shorts/')) {
                return urlObj.pathname.replace(/^\/shorts\//, '').split('/')[0];
            }
        } catch (e) {}
        return null;
    }

    /**
     * Construct clean canonical YouTube video URL
     */
    function getCleanVideoUrl(fallbackUrl = window.location.href) {
        const id = getCurrentVideoId();
        if (id) {
            return `https://www.youtube.com/watch?v=${id}`;
        }
        return fallbackUrl.split('&list=')[0].split('&start_radio=')[0];
    }

    /**
     * Convert stage code to human readable text and icon
     */
    function getStageDisplay(stage, percent = 0) {
        switch (stage) {
            case 'fetching_meta':
                return { icon: '📡', text: 'Fetching video details...', percent: Math.max(percent, 5) };
            case 'downloading':
                return { icon: '📥', text: `Downloading audio stream (${percent}%)`, percent };
            case 'decoding_ffmpeg':
                return { icon: '⚙️', text: `FFmpeg audio conversion (${percent}%)`, percent: Math.max(percent, 82) };
            case 'tagging':
                return { icon: '🎨', text: 'Embedding ID3 tags & cover art...', percent: Math.max(percent, 90) };
            case 'ready':
            case 'completed':
                return { icon: '🟢', text: 'Conversion complete! 100%', percent: 100 };
            case 'failed':
            case 'error':
                return { icon: '⚠️', text: 'Conversion failed', percent: 0, isError: true };
            default:
                return { icon: '⏳', text: `In conversion queue (${percent}%)`, percent };
        }
    }

    function getStageShortText(stage, percent = 0) {
        switch (stage) {
            case 'fetching_meta': return 'Fetching...';
            case 'downloading': return `Downloading ${percent}%`;
            case 'decoding_ffmpeg': return `Converting ${percent}%`;
            case 'tagging': return 'Tags & Art...';
            case 'ready':
            case 'completed': return 'Saved 100%';
            case 'failed':
            case 'error': return 'Failed';
            default: return `Queue ${percent}%`;
        }
    }

    /**
     * Display non-intrusive floating toast notification
     */
    function showToast(message, isError = false) {
        const oldToast = document.querySelector('.yt-mp3-toast');
        if (oldToast) oldToast.remove();

        const toast = document.createElement('div');
        toast.className = 'yt-mp3-toast';
        if (isError) {
            toast.style.borderColor = 'rgba(239, 68, 68, 0.6)';
            toast.style.background = 'rgba(28, 10, 10, 0.96)';
        }

        toast.innerHTML = `
            <span>${isError ? '⚠️' : '🎧'}</span>
            <span>${message}</span>
        `;

        document.body.appendChild(toast);
        setTimeout(() => {
            toast.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(10px)';
            setTimeout(() => toast.remove(), 400);
        }, 4500);
    }

    /**
     * Render or update the Floating Progress Dock
     */
    function renderProgressDock(item) {
        if (!item) return;

        let dock = document.getElementById('yt-mp3-progress-dock');
        if (!dock) {
            dock = document.createElement('div');
            dock.id = 'yt-mp3-progress-dock';
            document.body.appendChild(dock);
        }

        const stageInfo = getStageDisplay(item.stage || item.status, item.progress || 0);
        const isComplete = item.status === 'completed' || item.downloadReady || item.stage === 'ready';
        const isSaved = item.isSaved || false;
        const rawTitle = item.title || 'YouTube Audio';
        const displayTitle = rawTitle.length > 36 ? rawTitle.substring(0, 34) + '...' : rawTitle;

        // Ensure temporary download URL is populated
        const downloadUrl = item.downloadUrl || (item.downloadPath ? item.downloadPath : null);

        dock.innerHTML = `
            <div class="dock-header">
                <div class="dock-brand">
                    <span class="dock-brand-icon">🎧</span>
                    <span>YT to MP3 Engine</span>
                </div>
                <button class="dock-close-btn" title="Dismiss">✕</button>
            </div>

            <div class="dock-title" title="${escapeHtml(rawTitle)}">${escapeHtml(displayTitle)}</div>

            <div class="dock-status-row">
                <span class="dock-stage-text">
                    <span>${stageInfo.icon}</span>
                    <span>${escapeHtml(stageInfo.text)}</span>
                </span>
                <span class="dock-percent ${isComplete ? 'complete' : ''}">${stageInfo.percent}%</span>
            </div>

            <div class="dock-bar-bg">
                <div class="dock-bar-fill ${!isComplete && !stageInfo.isError ? 'animating' : ''} ${isComplete ? 'ready' : ''}" 
                     style="width: ${stageInfo.percent}%"></div>
            </div>

            ${isComplete ? `
                <div class="dock-actions">
                    <div class="dock-saved-badge">
                        <span>💾</span>
                        <span>${isSaved ? 'Auto-saved to PC (Downloads) ✓' : 'File Ready for Download!'}</span>
                    </div>
                    <div class="dock-buttons-row">
                        ${downloadUrl ? `
                            <a class="btn-dock-download" href="${escapeHtml(downloadUrl)}" download title="Click to download file to device">
                                ${DOWNLOAD_ICON} <span>Download File</span>
                            </a>
                            <button class="btn-dock-copy" title="Copy temporary download link to clipboard">
                                📋 <span>Copy Link</span>
                            </button>
                        ` : `
                            <button class="btn-dock-download btn-trigger-save" title="Save file to PC">
                                ${DOWNLOAD_ICON} <span>Save to PC</span>
                            </button>
                        `}
                    </div>
                    <span class="dock-expiry-note">⏱️ Temp link valid for 30 minutes</span>
                </div>
            ` : ''}
        `;

        // Close button handler
        const closeBtn = dock.querySelector('.dock-close-btn');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                dock.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
                dock.style.opacity = '0';
                dock.style.transform = 'translateY(15px)';
                setTimeout(() => dock.remove(), 250);
            });
        }

        // Copy Link button handler
        const copyBtn = dock.querySelector('.btn-dock-copy');
        if (copyBtn && downloadUrl) {
            copyBtn.addEventListener('click', (e) => {
                e.preventDefault();
                navigator.clipboard.writeText(downloadUrl).then(() => {
                    const span = copyBtn.querySelector('span');
                    if (span) span.textContent = 'Copied! ✓';
                    setTimeout(() => {
                        if (span) span.textContent = 'Copy Link';
                    }, 2000);
                }).catch(() => {
                    showToast('Link: ' + downloadUrl);
                });
            });
        }

        // Trigger manual device download handler
        const manualSaveBtn = dock.querySelector('.btn-trigger-save');
        if (manualSaveBtn) {
            manualSaveBtn.addEventListener('click', () => {
                chrome.runtime.sendMessage({
                    action: 'TRIGGER_DEVICE_DOWNLOAD',
                    item: item,
                    explicitClick: true
                }, (res) => {
                    if (res && res.success) {
                        showToast('Saving to your PC Downloads folder!');
                        item.isSaved = true;
                        renderProgressDock(item);
                    }
                });
            });
        }
    }

    /**
     * Update the injected Watch Page Button based on active download progress
     */
    function updateWatchButtonState(videoId, item) {
        const container = document.getElementById('yt-mp3-btn-container');
        if (!container || container.getAttribute('data-video-id') !== videoId) return;

        const button = container.querySelector('.yt-mp3-download-btn');
        if (!button) return;

        if (!item) {
            button.className = 'yt-mp3-download-btn';
            button.innerHTML = `${MUSIC_ICON} <span>Download MP3</span>`;
            return;
        }

        const isComplete = item.status === 'completed' || item.downloadReady || item.stage === 'ready';
        const isError = item.status === 'error' || item.stage === 'failed';

        if (isComplete) {
            button.className = 'yt-mp3-download-btn ready';
            button.innerHTML = `${CHECK_ICON} <span>Saved (100%)</span>`;
            button.title = 'Conversion complete! Click to download or view temp link.';
        } else if (isError) {
            button.className = 'yt-mp3-download-btn';
            button.innerHTML = `${MUSIC_ICON} <span>Retry MP3</span>`;
            button.title = item.error ? `Failed: ${item.error}` : 'Conversion failed. Click to retry.';
        } else {
            button.className = 'yt-mp3-download-btn downloading';
            const shortText = getStageShortText(item.stage, item.progress);
            button.innerHTML = `${SPINNER_ICON} <span>${shortText}</span>`;
            button.title = `Conversion in progress: ${item.progress || 0}%`;
        }
    }

    /**
     * Trigger MP3 download via background service worker
     */
    function triggerDownload(videoUrl, buttonEl, isHoverBtn = false) {
        if (!buttonEl) return;
        const videoId = getCurrentVideoId();

        // If already completed and user clicks button, open/download temp link
        if (videoId && activeDownloads.has(videoId)) {
            const activeItem = activeDownloads.get(videoId);
            if (activeItem && (activeItem.status === 'completed' || activeItem.downloadReady)) {
                if (activeItem.downloadUrl) {
                    window.open(activeItem.downloadUrl, '_blank');
                    return;
                }
                chrome.runtime.sendMessage({
                    action: 'TRIGGER_DEVICE_DOWNLOAD',
                    item: activeItem,
                    explicitClick: true
                });
                renderProgressDock(activeItem);
                return;
            }
        }

        buttonEl.classList.add('loading');
        buttonEl.innerHTML = `${SPINNER_ICON} <span>${isHoverBtn ? 'Queuing...' : 'Starting...'}</span>`;

        chrome.storage.local.get(['bitrate'], (res) => {
            const bitrate = res.bitrate || '320k';

            chrome.runtime.sendMessage(
                { action: 'DOWNLOAD_VIDEO', url: videoUrl, bitrate, videoId },
                (response) => {
                    buttonEl.classList.remove('loading');
                    if (response && response.success) {
                        const item = response.data ? (response.data.item || {}) : {};
                        item.videoId = videoId;
                        item.progress = item.progress || 10;
                        item.stage = item.stage || 'fetching_meta';
                        item.status = item.status || 'downloading';

                        if (videoId) {
                            activeDownloads.set(videoId, item);
                            updateWatchButtonState(videoId, item);
                        }

                        renderProgressDock(item);
                        showToast(`Converting MP3 (${bitrate}). Progress shown below!`);
                    } else {
                        const err = (response && response.error) ? response.error : 'Cannot connect to server. Is node server.js running?';
                        buttonEl.innerHTML = `${MUSIC_ICON} <span>Retry</span>`;
                        showToast(`Download failed: ${err}`, true);
                    }
                }
            );
        });
    }

    /**
     * Locate the active action bar container on YouTube
     */
    function findActiveActionContainer() {
        const isWatch = window.location.pathname.startsWith('/watch');
        const isShorts = window.location.pathname.startsWith('/shorts/');

        if (isWatch) {
            const activeWatch = document.querySelector('ytd-watch-flexy:not([hidden]) ytd-watch-metadata:not([hidden])') ||
                                document.querySelector('ytd-watch-metadata:not([hidden])') ||
                                document.querySelector('ytd-watch-metadata');

            if (!activeWatch) return null;

            // Target 1: Action buttons container (#top-level-buttons-computed)
            const topButtons = activeWatch.querySelector('#top-level-buttons-computed') ||
                               activeWatch.querySelector('#actions-inner #top-level-buttons-computed') ||
                               activeWatch.querySelector('#actions-inner');

            if (topButtons && topButtons.isConnected) {
                return { container: topButtons, position: 'prepend' };
            }

            // Target 2: Beside Channel Owner row (Subscribe button area)
            const ownerRow = activeWatch.querySelector('#owner') ||
                             document.querySelector('#owner');
            if (ownerRow && ownerRow.isConnected) {
                return { container: ownerRow, position: 'append' };
            }
        } else if (isShorts) {
            const activeReel = document.querySelector('ytd-reel-video-renderer[is-active]') ||
                               document.querySelector('ytd-reel-video-renderer');
            if (activeReel) {
                const shortActions = activeReel.querySelector('#actions');
                if (shortActions && shortActions.isConnected) {
                    return { container: shortActions, position: 'prepend' };
                }
            }
        }

        return null;
    }

    /**
     * Inject or verify the Download MP3 button on the active video page
     */
    function injectWatchPageButton() {
        const isWatch = window.location.pathname.startsWith('/watch');
        const isShorts = window.location.pathname.startsWith('/shorts/');

        if (!isWatch && !isShorts) {
            const staleBtn = document.getElementById('yt-mp3-btn-container');
            if (staleBtn) staleBtn.remove();
            return;
        }

        const videoId = getCurrentVideoId();
        if (!videoId) return;

        const target = findActiveActionContainer();
        if (!target || !target.container) return;

        const existingBtn = target.container.querySelector('#yt-mp3-btn-container');
        if (existingBtn && existingBtn.isConnected) {
            if (existingBtn.getAttribute('data-video-id') === videoId) {
                return; // Properly mounted
            }
            existingBtn.remove();
        }

        // Clean up any stale buttons elsewhere in the DOM
        document.querySelectorAll('#yt-mp3-btn-container').forEach(el => el.remove());

        if (isInjecting) return;
        isInjecting = true;

        try {
            const buttonWrapper = document.createElement('div');
            buttonWrapper.id = 'yt-mp3-btn-container';
            buttonWrapper.setAttribute('data-video-id', videoId);
            buttonWrapper.style.display = 'inline-flex';
            buttonWrapper.style.alignItems = 'center';
            buttonWrapper.style.marginRight = '8px';
            buttonWrapper.style.marginLeft = '4px';
            buttonWrapper.style.verticalAlign = 'middle';

            const button = document.createElement('button');
            button.className = 'yt-mp3-download-btn';
            button.title = 'Download audio as high quality MP3 (FFmpeg Decoded)';
            button.innerHTML = `${MUSIC_ICON} <span>Download MP3</span>`;

            button.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                const url = getCleanVideoUrl();
                triggerDownload(url, button, false);
            });

            buttonWrapper.appendChild(button);

            if (target.position === 'prepend' && target.container.firstChild) {
                target.container.insertBefore(buttonWrapper, target.container.firstChild);
            } else {
                target.container.appendChild(buttonWrapper);
            }

            // If an active item already exists for this video, update button state immediately
            if (activeDownloads.has(videoId)) {
                updateWatchButtonState(videoId, activeDownloads.get(videoId));
            } else {
                // Check background for existing item
                chrome.runtime.sendMessage({ action: 'GET_VIDEO_DOWNLOAD_STATUS', videoId }, (res) => {
                    if (res && res.item) {
                        res.item.isSaved = res.isSaved;
                        activeDownloads.set(videoId, res.item);
                        updateWatchButtonState(videoId, res.item);
                        if (['pending', 'downloading', 'decoding_ffmpeg', 'tagging', 'completed'].includes(res.item.status)) {
                            renderProgressDock(res.item);
                        }
                    }
                });
            }
        } finally {
            isInjecting = false;
        }
    }

    /**
     * Inject Hover Download Button on Video Cards / Thumbnails across YouTube
     */
    function injectHoverButtons() {
        const selector = `
            ytd-thumbnail,
            a#thumbnail,
            ytd-compact-video-renderer a#thumbnail,
            ytd-grid-video-renderer a#thumbnail,
            ytd-reel-item-renderer,
            ytd-rich-grid-slim-media
        `;

        const thumbnails = document.querySelectorAll(selector);

        thumbnails.forEach((thumb) => {
            if (thumb.querySelector('.yt-mp3-hover-btn')) return;

            let anchor = thumb.tagName === 'A' ? thumb : thumb.querySelector('a[href*="/watch"], a[href*="/shorts"]');
            if (!anchor) {
                anchor = thumb.closest('a[href*="/watch"], a[href*="/shorts"]') || thumb.querySelector('a');
            }

            if (!anchor) return;

            const href = anchor.getAttribute('href');
            if (!href || (!href.includes('/watch') && !href.includes('/shorts'))) return;

            if (getComputedStyle(thumb).position === 'static') {
                thumb.style.position = 'relative';
            }

            const hoverBtn = document.createElement('button');
            hoverBtn.className = 'yt-mp3-hover-btn';
            hoverBtn.title = 'Download MP3 Audio';
            hoverBtn.innerHTML = `${MUSIC_ICON} <span>MP3</span>`;

            hoverBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();

                let activeAnchor = thumb.tagName === 'A' ? thumb : thumb.querySelector('a[href*="/watch"], a[href*="/shorts"]');
                let targetHref = activeAnchor ? activeAnchor.getAttribute('href') : href;
                let fullUrl = targetHref;
                if (!fullUrl.startsWith('http')) {
                    fullUrl = window.location.origin + fullUrl;
                }

                triggerDownload(fullUrl, hoverBtn, true);
            });

            thumb.appendChild(hoverBtn);
        });
    }

    /**
     * Listen for real-time progress broadcasts from background service worker
     */
    chrome.runtime.onMessage.addListener((message) => {
        if (message.action === 'QUEUE_UPDATED' && message.queueState) {
            const items = message.queueState.items || [];
            for (const item of items) {
                const vid = item.videoId || extractVideoIdFromUrl(item.url);
                if (vid) {
                    activeDownloads.set(vid, item);
                    if (vid === currentVideoId) {
                        updateWatchButtonState(vid, item);
                        renderProgressDock(item);
                    }
                }
            }
        }

        if (message.action === 'ITEM_DOWNLOADED_TO_DEVICE' && message.item) {
            const vid = message.item.videoId || extractVideoIdFromUrl(message.item.url);
            if (vid) {
                message.item.isSaved = true;
                message.item.downloadUrl = message.downloadUrl || message.item.downloadUrl;
                activeDownloads.set(vid, message.item);
                if (vid === currentVideoId) {
                    updateWatchButtonState(vid, message.item);
                    renderProgressDock(message.item);
                }
            }
        }

        if (message.action === 'DOWNLOAD_FAILED_USE_MANUAL' && message.item) {
            const vid = message.item.videoId || extractVideoIdFromUrl(message.item.url);
            if (vid) {
                message.item.downloadUrl = message.downloadUrl;
                activeDownloads.set(vid, message.item);
                if (vid === currentVideoId) {
                    renderProgressDock(message.item);
                }
            }
            showToast(`Auto-download failed (${message.error}). Use manual link in dock!`, true);
        }
    });

    function extractVideoIdFromUrl(url) {
        if (!url) return null;
        const m = url.match(/(?:v=|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
        return m ? m[1] : null;
    }

    function escapeHtml(text) {
        if (!text) return '';
        return String(text).replace(/[&<>"']/g, function (m) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m];
        });
    }

    function runInjections() {
        injectWatchPageButton();
        injectHoverButtons();
    }

    function scheduleSpaInjections() {
        const delays = [50, 150, 300, 600, 1200, 2000];
        delays.forEach(delay => {
            setTimeout(() => {
                runInjections();
            }, delay);
        });
    }

    function onUrlOrPageChange() {
        const newVideoId = getCurrentVideoId();
        if (newVideoId !== currentVideoId) {
            currentVideoId = newVideoId;
            const stale = document.getElementById('yt-mp3-btn-container');
            if (stale) stale.remove();

            // Check if active item exists for new video
            if (newVideoId && activeDownloads.has(newVideoId)) {
                renderProgressDock(activeDownloads.get(newVideoId));
            } else if (newVideoId) {
                // Inquire background
                chrome.runtime.sendMessage({ action: 'GET_VIDEO_DOWNLOAD_STATUS', videoId: newVideoId }, (res) => {
                    if (res && res.item) {
                        res.item.isSaved = res.isSaved;
                        activeDownloads.set(newVideoId, res.item);
                        updateWatchButtonState(newVideoId, res.item);
                        renderProgressDock(res.item);
                    } else {
                        // Dismiss stale dock if new video has no download
                        const dock = document.getElementById('yt-mp3-progress-dock');
                        if (dock) dock.remove();
                    }
                });
            }
        }
        scheduleSpaInjections();
    }

    // YouTube SPA navigation lifecycle listeners
    window.addEventListener('yt-navigate-finish', onUrlOrPageChange);
    window.addEventListener('yt-page-data-updated', onUrlOrPageChange);
    window.addEventListener('yt-player-updated', scheduleSpaInjections);
    window.addEventListener('spfdone', onUrlOrPageChange);
    window.addEventListener('popstate', onUrlOrPageChange);
    window.addEventListener('load', onUrlOrPageChange);
    document.addEventListener('DOMContentLoaded', onUrlOrPageChange);

    const originalPushState = history.pushState;
    history.pushState = function () {
        originalPushState.apply(this, arguments);
        onUrlOrPageChange();
    };

    const originalReplaceState = history.replaceState;
    history.replaceState = function () {
        originalReplaceState.apply(this, arguments);
        onUrlOrPageChange();
    };

    // DOM Observer
    let mutationDebounce = null;
    const observer = new MutationObserver((mutations) => {
        let shouldCheck = false;
        for (const m of mutations) {
            if (m.addedNodes.length > 0) {
                shouldCheck = true;
                break;
            }
        }
        if (shouldCheck) {
            if (mutationDebounce) return;
            mutationDebounce = setTimeout(() => {
                mutationDebounce = null;
                runInjections();
            }, 250);
        }
    });

    observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true
    });

    setInterval(() => {
        const id = getCurrentVideoId();
        if (id && id !== currentVideoId) {
            onUrlOrPageChange();
        } else {
            runInjections();
        }
    }, 1500);

    // Initial trigger
    runInjections();
})();
