(function () {
    let currentUrl = '';
    let isInjectingWatchBtn = false;

    const MUSIC_ICON = `<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`;
    const CHECK_ICON = `<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`;
    const SPINNER_ICON = `<svg class="yt-mp3-spinner" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>`;

    function showToast(message, isError = false) {
        const oldToast = document.querySelector('.yt-mp3-toast');
        if (oldToast) oldToast.remove();

        const toast = document.createElement('div');
        toast.className = 'yt-mp3-toast';
        if (isError) {
            toast.style.borderColor = 'rgba(239, 68, 68, 0.5)';
            toast.style.background = 'rgba(30, 10, 10, 0.95)';
        }

        toast.innerHTML = `
            <span>${isError ? '⚠️' : '🎧'}</span>
            <span>${message}</span>
        `;

        document.body.appendChild(toast);
        setTimeout(() => {
            toast.style.transition = 'opacity 0.4s ease';
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 400);
        }, 4000);
    }

    /**
     * Trigger MP3 download for a video URL
     */
    function triggerDownload(videoUrl, buttonEl, isHoverBtn = false) {
        buttonEl.classList.add('loading');
        buttonEl.innerHTML = `${SPINNER_ICON} <span>${isHoverBtn ? 'Queuing...' : 'Adding to Queue...'}</span>`;

        chrome.storage.local.get(['bitrate'], (res) => {
            const bitrate = res.bitrate || '320k';

            chrome.runtime.sendMessage(
                { action: 'DOWNLOAD_VIDEO', url: videoUrl, bitrate },
                (response) => {
                    buttonEl.classList.remove('loading');
                    if (response && response.success) {
                        buttonEl.classList.add('queued');
                        buttonEl.innerHTML = `${CHECK_ICON} <span>${isHoverBtn ? 'MP3 Queued' : 'Queued (' + bitrate + ')'}</span>`;
                        showToast(`Queued for MP3 conversion (${bitrate})!`);
                        setTimeout(() => {
                            buttonEl.classList.remove('queued');
                            buttonEl.innerHTML = `${MUSIC_ICON} <span>${isHoverBtn ? 'MP3' : 'Download MP3'}</span>`;
                        }, 4000);
                    } else {
                        const err = (response && response.error) ? response.error : 'Is local server running?';
                        buttonEl.innerHTML = `${MUSIC_ICON} <span>Retry</span>`;
                        showToast(`Download failed: ${err}`, true);
                    }
                }
            );
        });
    }

    /**
     * Inject main Download MP3 button into Watch Page Action Bar
     */
    function injectWatchPageButton() {
        if (!window.location.pathname.startsWith('/watch')) return;
        if (document.getElementById('yt-mp3-btn-container')) return;
        if (isInjectingWatchBtn) return;

        isInjectingWatchBtn = true;

        const targetContainer =
            document.querySelector('#top-level-buttons-computed') ||
            document.querySelector('ytd-watch-metadata #actions #actions-inner') ||
            document.querySelector('ytd-watch-metadata #actions #menu #items') ||
            document.querySelector('#menu-container #buttons') ||
            document.querySelector('ytd-watch-metadata #owner');

        if (!targetContainer) {
            isInjectingWatchBtn = false;
            return;
        }

        const buttonWrapper = document.createElement('div');
        buttonWrapper.id = 'yt-mp3-btn-container';
        buttonWrapper.style.display = 'inline-flex';
        buttonWrapper.style.alignItems = 'center';
        buttonWrapper.style.marginLeft = '8px';
        buttonWrapper.style.verticalAlign = 'middle';

        const button = document.createElement('button');
        button.className = 'yt-mp3-download-btn';
        button.title = 'Download video audio as high quality MP3 with FFmpeg';
        button.innerHTML = `${MUSIC_ICON} <span>Download MP3</span>`;

        button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            triggerDownload(window.location.href, button, false);
        });

        buttonWrapper.appendChild(button);
        targetContainer.insertBefore(buttonWrapper, targetContainer.firstChild || null);
        isInjectingWatchBtn = false;
    }

    /**
     * Inject Hover Download Button on Video Cards / Thumbnails across YouTube
     */
    function injectHoverButtons() {
        const selector = `
            ytd-thumbnail:not([data-yt-mp3-injected]),
            a#thumbnail:not([data-yt-mp3-injected]),
            ytd-compact-video-renderer a#thumbnail:not([data-yt-mp3-injected]),
            ytd-grid-video-renderer a#thumbnail:not([data-yt-mp3-injected]),
            ytd-reel-item-renderer:not([data-yt-mp3-injected]),
            ytd-rich-grid-slim-media:not([data-yt-mp3-injected])
        `;

        const thumbnails = document.querySelectorAll(selector);

        thumbnails.forEach((thumb) => {
            thumb.setAttribute('data-yt-mp3-injected', 'true');

            // Find anchor link inside thumbnail
            let anchor = thumb.tagName === 'A' ? thumb : thumb.querySelector('a[href*="/watch"], a[href*="/shorts"]');
            if (!anchor) {
                anchor = thumb.closest('a[href*="/watch"], a[href*="/shorts"]') || thumb.querySelector('a');
            }

            if (!anchor) return;

            const href = anchor.getAttribute('href');
            if (!href || (!href.includes('/watch') && !href.includes('/shorts'))) return;

            // Ensure relative positioning
            if (getComputedStyle(thumb).position === 'static') {
                thumb.style.position = 'relative';
            }

            // Create hover download button
            const hoverBtn = document.createElement('button');
            hoverBtn.className = 'yt-mp3-hover-btn';
            hoverBtn.title = 'Download MP3 Audio';
            hoverBtn.innerHTML = `${MUSIC_ICON} <span>MP3</span>`;

            hoverBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();

                let fullUrl = href;
                if (!fullUrl.startsWith('http')) {
                    fullUrl = window.location.origin + fullUrl;
                }

                triggerDownload(fullUrl, hoverBtn, true);
            });

            thumb.appendChild(hoverBtn);
        });
    }

    // Combined injection runner
    function runInjections() {
        if (window.location.pathname.startsWith('/watch') && !document.getElementById('yt-mp3-btn-container')) {
            injectWatchPageButton();
        }
        injectHoverButtons();
    }

    // Periodic & SPA Watchers
    setInterval(() => {
        if (window.location.href !== currentUrl) {
            currentUrl = window.location.href;
            const oldBtn = document.getElementById('yt-mp3-btn-container');
            if (oldBtn) oldBtn.remove();
        }
        runInjections();
    }, 1000);

    // Observer for fast dynamic DOM updates (infinite scrolling)
    const observer = new MutationObserver((mutations) => {
        let shouldCheck = false;
        for (const m of mutations) {
            if (m.addedNodes.length > 0) {
                shouldCheck = true;
                break;
            }
        }
        if (shouldCheck) {
            runInjections();
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // YouTube SPA Event Listeners
    window.addEventListener('yt-navigate-finish', runInjections);
    window.addEventListener('yt-page-data-updated', runInjections);
    window.addEventListener('spfdone', runInjections);
    window.addEventListener('load', runInjections);
})();

