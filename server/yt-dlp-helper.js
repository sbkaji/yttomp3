const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawn, execFile, execFileSync } = require('child_process');
const sanitize = require('sanitize-filename');
const NodeID3 = require('node-id3');

// ─── OS & Platform Detection ───────────────────────────────────────────────
const OS_PLATFORM = process.platform;
const IS_WIN = OS_PLATFORM === 'win32';
const IS_MAC = OS_PLATFORM === 'darwin';
const OS_ARCH = process.arch;

const BIN_DIR = path.join(__dirname, 'bin');
const TEMP_DIR = process.env.TEMP_DIR || path.join(require('os').tmpdir(), 'ytmp3_temp');

/**
 * Ensure file has executable permissions on Linux / Unix environments
 */
function ensureExecutable(filePath) {
    if (!IS_WIN && filePath && fs.existsSync(filePath)) {
        try {
            const stat = fs.statSync(filePath);
            if (!(stat.mode & 0o111)) {
                fs.chmodSync(filePath, 0o755);
            }
        } catch (e) {
            // Best effort
        }
    }
}

/**
 * Find a binary on the system PATH or fall back to local ./bin/ directory or npm packages.
 * Automatically adapts between Windows Server / Desktop and Linux (Ubuntu, Docker, Coolify).
 */
function findBinary(name) {
    // 0) Explicit ENV override (e.g., YTDLP_PATH=/usr/bin/yt-dlp, FFMPEG_PATH=/usr/bin/ffmpeg)
    const envVar = name === 'yt-dlp' ? process.env.YTDLP_PATH : (name === 'ffmpeg' ? process.env.FFMPEG_PATH : null);
    if (envVar && fs.existsSync(envVar)) {
        ensureExecutable(envVar);
        console.log(`[Binary] Using ENV ${name}: ${envVar}`);
        return envVar;
    }

    const binaryFileName = IS_WIN ? `${name}.exe` : name;
    const localPath = path.join(BIN_DIR, binaryFileName);

    // 1) Direct check in standard Unix locations (Ubuntu / Debian / Docker / Coolify / Alpine)
    if (!IS_WIN) {
        const standardUnixPaths = [
            `/usr/local/bin/${name}`,
            `/usr/bin/${name}`,
            `/bin/${name}`,
            `/snap/bin/${name}`,
            path.join(process.env.HOME || '/root', '.local/bin', name)
        ];
        for (const p of standardUnixPaths) {
            if (fs.existsSync(p)) {
                ensureExecutable(p);
                console.log(`[Binary] Found system ${name} at: ${p}`);
                return p;
            }
        }
    } else {
        const standardWinPaths = [
            `C:\\ProgramData\\chocolatey\\bin\\${name}.exe`,
            `C:\\ffmpeg\\bin\\${name}.exe`,
            `C:\\yt-dlp\\${name}.exe`
        ];
        for (const p of standardWinPaths) {
            if (fs.existsSync(p)) {
                console.log(`[Binary] Found system ${name} at: ${p}`);
                return p;
            }
        }
    }

    // 2) Try system PATH via which (Linux) or where (Windows)
    // NOTE: stdio is piped/ignored to suppress Windows "INFO: Could not find files for the given pattern(s)."
    try {
        const which = IS_WIN ? 'where' : 'which';
        const result = execFileSync(which, [name], {
            encoding: 'utf8',
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true
        }).trim().split(/\r?\n/)[0].trim();

        if (result && fs.existsSync(result)) {
            ensureExecutable(result);
            console.log(`[Binary] Using PATH ${name}: ${result}`);
            return result;
        }
    } catch (e) {
        // Not found on PATH, continue to local fallback
    }

    // 3) Fall back to local ./bin/ directory
    if (fs.existsSync(localPath)) {
        ensureExecutable(localPath);
        console.log(`[Binary] Using local ${name}: ${localPath}`);
        return localPath;
    }

    // 4) For ffmpeg, check ffmpeg-static npm package fallback before returning
    if (name === 'ffmpeg') {
        try {
            const ffmpegStatic = require('ffmpeg-static');
            if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
                ensureExecutable(ffmpegStatic);
                console.log(`[Binary] Using bundled ffmpeg-static: ${ffmpegStatic}`);
                return ffmpegStatic;
            }
        } catch (e) {}
    }

    // Return anticipated local path (will be auto-downloaded if needed)
    return localPath;
}

let YTDLP_PATH = findBinary('yt-dlp');
let FFMPEG_PATH = findBinary('ffmpeg');

function ensureBinDir() {
    if (!fs.existsSync(BIN_DIR)) {
        fs.mkdirSync(BIN_DIR, { recursive: true, mode: 0o777 });
    }
}

/**
 * Download latest yt-dlp binary from GitHub Releases (auto-adapts to Windows, Linux x64/arm64, macOS)
 */
function downloadYtDlp() {
    return new Promise((resolve, reject) => {
        // If current binary works, use it
        try {
            execFileSync(YTDLP_PATH, ['--version'], {
                timeout: 10000,
                stdio: ['ignore', 'pipe', 'ignore'],
                windowsHide: true
            });
            return resolve(YTDLP_PATH);
        } catch (e) {
            // Binary not working or not present, proceed to setup
        }

        ensureBinDir();
        const localFileName = IS_WIN ? 'yt-dlp.exe' : 'yt-dlp';
        const localPath = path.join(BIN_DIR, localFileName);

        if (fs.existsSync(localPath)) {
            ensureExecutable(localPath);
            try {
                execFileSync(localPath, ['--version'], {
                    timeout: 10000,
                    stdio: ['ignore', 'pipe', 'ignore'],
                    windowsHide: true
                });
                YTDLP_PATH = localPath;
                return resolve(localPath);
            } catch (e) {
                // Existing file might be corrupt, re-download
            }
        }

        console.log(`[yt-dlp Engine] Downloading yt-dlp binary for ${OS_PLATFORM} (${OS_ARCH})...`);
        
        let downloadUrl;
        if (IS_WIN) {
            downloadUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
        } else if (IS_MAC) {
            downloadUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos';
        } else if (OS_ARCH === 'arm64' || OS_ARCH === 'aarch64') {
            downloadUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64';
        } else if (OS_ARCH === 'arm') {
            downloadUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_armv7l';
        } else {
            // Linux x86_64
            downloadUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
        }

        const file = fs.createWriteStream(localPath);

        function getRedirect(url) {
            https.get(url, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    getRedirect(res.headers.location);
                } else if (res.statusCode === 200) {
                    res.pipe(file);
                    file.on('finish', () => {
                        file.close(() => {
                            ensureExecutable(localPath);
                            console.log('[yt-dlp Engine] Binary download complete!');
                            YTDLP_PATH = localPath;
                            resolve(localPath);
                        });
                    });
                } else {
                    reject(new Error(`Failed to download yt-dlp: HTTP ${res.statusCode}`));
                }
            }).on('error', (err) => {
                fs.unlink(localPath, () => {});
                reject(err);
            });
        }

        getRedirect(downloadUrl);
    });
}

/**
 * Ensure valid FFmpeg binary exists (System, ./bin/, or npm ffmpeg-static)
 */
async function ensureFFmpeg() {
    try {
        execFileSync(FFMPEG_PATH, ['-version'], {
            timeout: 10000,
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true
        });
        return FFMPEG_PATH;
    } catch (e) {
        // Try local bin
        ensureBinDir();
        const localFileName = IS_WIN ? 'ffmpeg.exe' : 'ffmpeg';
        const localPath = path.join(BIN_DIR, localFileName);
        if (fs.existsSync(localPath)) {
            ensureExecutable(localPath);
            FFMPEG_PATH = localPath;
            return localPath;
        }

        // Try ffmpeg-static npm package as universal cross-platform fallback
        try {
            const ffmpegStatic = require('ffmpeg-static');
            if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
                ensureExecutable(ffmpegStatic);
                FFMPEG_PATH = ffmpegStatic;
                console.log(`[FFmpeg] Using bundled ffmpeg-static: ${ffmpegStatic}`);
                return ffmpegStatic;
            }
        } catch (e2) {}

        const installTip = IS_WIN
            ? 'Place ffmpeg.exe in server/bin/ or install via winget: winget install Gyan.FFmpeg'
            : 'Install ffmpeg on your Linux server via: apt-get update && apt-get install -y ffmpeg';

        console.error(`[FFmpeg] No working FFmpeg binary found! Tip: ${installTip}`);
        return FFMPEG_PATH;
    }
}

/**
 * Resolves cookies, proxies, and extractor args to bypass YouTube bot detection
 */
function getExtraYtDlpArgs(overrideClient = null, customCookies = null) {
    const extraArgs = [];

    // Client extractor args: default to android,ios,web (android avoids web bot checks on VPS IPs)
    const client = overrideClient || process.env.YTDLP_CLIENT || 'android,ios,web';
    extraArgs.push('--extractor-args', `youtube:player_client=${client}`);

    // Optional po_token if configured via env
    if (process.env.YTDLP_PO_TOKEN) {
        extraArgs.push('--extractor-args', `youtube:po_token=${process.env.YTDLP_PO_TOKEN.trim()}`);
    }

    // 1. Cookies support:
    // A. Top Priority: Direct cookies passed from browser extension request
    if (customCookies && typeof customCookies === 'string' && customCookies.trim().length > 0) {
        try {
            const clientCookiesPath = path.join(os.tmpdir(), `ytmp3_client_cookies_${Date.now()}_${Math.random().toString(36).substr(2, 5)}.txt`);
            fs.writeFileSync(clientCookiesPath, customCookies.trim(), { mode: 0o600 });
            extraArgs.push('--cookies', clientCookiesPath);

            // Also cache on server for subsequent background metadata queries
            const cachePath = path.join(__dirname, 'data', 'cookies.txt');
            try {
                if (!fs.existsSync(path.dirname(cachePath))) fs.mkdirSync(path.dirname(cachePath), { recursive: true });
                fs.writeFileSync(cachePath, customCookies.trim(), { mode: 0o600 });
            } catch (e) {}

            return extraArgs;
        } catch (e) {
            console.warn('[yt-dlp Cookies] Could not write client cookies:', e.message);
        }
    }

    // B. Secondary: YTDLP_COOKIES env var (paste raw cookies in Coolify)
    const rawCookies = process.env.YTDLP_COOKIES || process.env.COOKIES_CONTENT;
    if (rawCookies && rawCookies.trim().length > 0) {
        try {
            const cookiesFilePath = path.join(os.tmpdir(), 'ytmp3_cookies.txt');
            fs.writeFileSync(cookiesFilePath, rawCookies.trim(), { mode: 0o600 });
            extraArgs.push('--cookies', cookiesFilePath);
            return extraArgs;
        } catch (e) {
            console.warn('[yt-dlp Cookies] Could not write cookies env string:', e.message);
        }
    } else if (process.env.COOKIES_PATH && fs.existsSync(process.env.COOKIES_PATH)) {
        extraArgs.push('--cookies', process.env.COOKIES_PATH);
        return extraArgs;
    } else {
        const candidateFiles = [
            path.join(__dirname, 'data', 'cookies.txt'),
            path.join(__dirname, 'cookies.txt'),
            path.join(process.cwd(), 'cookies.txt'),
            path.join(TEMP_DIR, 'cookies.txt'),
            '/tmp/cookies.txt'
        ];
        for (const candidate of candidateFiles) {
            try {
                if (fs.existsSync(candidate) && fs.statSync(candidate).size > 0) {
                    console.log(`[yt-dlp Cookies] Using detected cookies file: ${candidate}`);
                    extraArgs.push('--cookies', candidate);
                    break;
                }
            } catch (e) {}
        }
    }

    // 2. Proxy support: YTDLP_PROXY or HTTP_PROXY or HTTPS_PROXY
    const proxyUrl = process.env.YTDLP_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    if (proxyUrl && proxyUrl.trim().length > 0) {
        extraArgs.push('--proxy', proxyUrl.trim());
    }

    return extraArgs;
}

/**
 * Fetch video metadata using yt-dlp JSON output (with multi-client anti-bot fallback)
 */
async function getVideoInfo(videoUrl, customCookies = null) {
    await downloadYtDlp();

    // Clean playlist URL parameters to target exact video
    const cleanUrl = videoUrl.split('&list=')[0].split('&start_radio=')[0];

    const runInfoDump = (clientOverride = null) => {
        return new Promise((resolve, reject) => {
            const args = [
                cleanUrl,
                '--dump-json',
                '--no-warnings',
                '--no-playlist',
                ...getExtraYtDlpArgs(clientOverride, customCookies)
            ];

            execFile(YTDLP_PATH, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
                if (err) {
                    return reject({ err, stderr: stderr || err.message });
                }

                try {
                    const info = JSON.parse(stdout);
                    resolve({
                        id: info.id,
                        title: info.title || 'YouTube Audio',
                        channel: info.uploader || info.channel || 'Unknown Artist',
                        duration: parseInt(info.duration || 0),
                        thumbnail: info.thumbnail || (info.thumbnails && info.thumbnails.length > 0 ? info.thumbnails[info.thumbnails.length - 1].url : null),
                        url: info.webpage_url || cleanUrl
                    });
                } catch (pErr) {
                    reject({ err: pErr, stderr: 'Failed to parse yt-dlp metadata JSON output' });
                }
            });
        });
    };

    try {
        return await runInfoDump();
    } catch (firstErr) {
        console.warn(`[yt-dlp Info] Primary client failed (${(firstErr.stderr || '').slice(0, 150)}). Retrying with android client...`);
        try {
            return await runInfoDump('android');
        } catch (secondErr) {
            console.warn(`[yt-dlp Info] Android client failed. Retrying with ios client...`);
            try {
                return await runInfoDump('ios');
            } catch (thirdErr) {
                console.error('[yt-dlp Info Error]:', thirdErr.stderr || thirdErr.err);
                throw new Error(`Failed to fetch video info: ${thirdErr.stderr || thirdErr.err.message}`);
            }
        }
    }
}

/**
 * Download & Convert YouTube Video to Pure MP3 using yt-dlp + FFmpeg
 * Files are saved to a TEMP directory on the server.
 */
async function convertToMp3({ url, bitrate = '320k', outputDir, cookies = null, onProgress }) {
    await downloadYtDlp();
    await ensureFFmpeg();

    if (!outputDir) {
        // Use dedicated temp directory for server-side temp storage
        outputDir = TEMP_DIR;
    }

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // Clean playlist URL parameters
    const cleanUrl = url.split('&list=')[0].split('&start_radio=')[0];

    console.log(`[yt-dlp Audio Engine] Fetching metadata for: ${cleanUrl}`);
    if (onProgress) onProgress({ stage: 'fetching_meta', percent: 5 });

    const meta = await getVideoInfo(cleanUrl, cookies);
    const sanitizedTitle = sanitize(meta.title) || `yt_audio_${meta.id}`;
    const outputFilename = `${sanitizedTitle}.mp3`;
    const outputPath = path.join(outputDir, outputFilename);

    if (onProgress) onProgress({ stage: 'downloading', percent: 10 });

    const kbps = bitrate.replace('k', '').replace('K', '') + 'K';

    // Determine ffmpeg location for yt-dlp (yt-dlp supports exact binary path or directory)
    const ffmpegLocation = FFMPEG_PATH;
    const ffmpegDir = path.dirname(FFMPEG_PATH);

    // Arguments for pure MP3 audio extraction via FFmpeg with anti-freeze safeguards
    const maxFilesize = process.env.MAX_FILESIZE || '350M';
    const args = [
        cleanUrl,
        '-f', 'bestaudio/best',
        '--extract-audio',
        '--audio-format', 'mp3',
        '--audio-quality', kbps,
        '--newline',
        '--progress',
        '--socket-timeout', '25',
        '--retries', '3',
        '--fragment-retries', '3',
        '--no-live-from-start',
        '--max-filesize', maxFilesize,
        '--ffmpeg-location', ffmpegLocation,
        '--output', path.join(outputDir, `${sanitizedTitle}.%(ext)s`),
        '--no-playlist',
        '--no-warnings',
        ...getExtraYtDlpArgs(null, cookies)
    ];



    // Build env with ffmpeg on PATH (Linux uses : separator, Windows uses ;)
    const pathSep = process.platform === 'win32' ? ';' : ':';
    const env = {
        ...process.env,
        PATH: ffmpegDir + pathSep + (process.env.PATH || ''),
    };

    const timeoutMs = parseInt(process.env.DOWNLOAD_TIMEOUT_MS, 10) || 8 * 60 * 1000; // 8 minutes max

    await new Promise((resolve, reject) => {
        const proc = spawn(YTDLP_PATH, args, { env });
        let timedOut = false;

        const killTimer = setTimeout(() => {
            timedOut = true;
            console.warn(`[yt-dlp Engine] Process timeout (${timeoutMs / 1000}s) reached for: ${cleanUrl}. Terminating...`);
            try {
                if (IS_WIN && proc.pid) {
                    execFile('taskkill', ['/pid', String(proc.pid), '/f', '/t'], () => {});
                } else if (proc.pid) {
                    proc.kill('SIGKILL');
                }
            } catch (e) {}
        }, timeoutMs);

        function processLogChunk(data, isErr = false) {
            const text = data.toString();
            const lines = text.split(/[\r\n]+/);
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                if (isErr) {
                    console.warn('[yt-dlp stderr]:', trimmed);
                } else {
                    console.log('[yt-dlp stdout]:', trimmed);
                }

                const match = trimmed.match(/\[download\]\s+([\d\.]+)%/);
                if (match && onProgress) {
                    const dlPercent = parseFloat(match[1]);
                    // Map download percent across 10% - 80% range
                    const mappedPercent = Math.min(80, 10 + Math.round((dlPercent / 100) * 70));
                    onProgress({ stage: 'downloading', percent: mappedPercent });
                }

                if (trimmed.includes('[ExtractAudio]')) {
                    if (onProgress) onProgress({ stage: 'decoding_ffmpeg', percent: 82 });
                }
            }
        }

        proc.stdout.on('data', (data) => processLogChunk(data, false));
        proc.stderr.on('data', (data) => processLogChunk(data, true));

        proc.on('error', (err) => {
            clearTimeout(killTimer);
            reject(err);
        });

        proc.on('close', (code) => {
            clearTimeout(killTimer);
            if (timedOut) {
                return reject(new Error(`Download exceeded maximum time limit (${Math.round(timeoutMs / 60000)}m) and was terminated.`));
            }
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`yt-dlp download exited with code ${code}`));
            }
        });
    });

    // Embed ID3 Metadata Tags (Title, Artist/Channel, Cover Artwork)
    if (onProgress) onProgress({ stage: 'tagging', percent: 90 });

    try {
        let imageBuffer = null;
        if (meta.thumbnail) {
            try {
                imageBuffer = await new Promise((res, rej) => {
                    const client = meta.thumbnail.startsWith('https') ? https : http;
                    client.get(meta.thumbnail, response => {
                        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                            return client.get(response.headers.location, r2 => {
                                const data = [];
                                r2.on('data', chunk => data.push(chunk));
                                r2.on('end', () => res(Buffer.concat(data)));
                            });
                        }
                        const data = [];
                        response.on('data', chunk => data.push(chunk));
                        response.on('end', () => res(Buffer.concat(data)));
                    }).on('error', rej);
                });
            } catch (e) {
                console.warn('Could not fetch thumbnail for ID3 tag:', e.message);
            }
        }

        const tags = {
            title: meta.title,
            artist: meta.channel,
            album: 'YouTube MP3 Downloads',
            comment: { language: 'eng', text: `Downloaded via YouTube MP3 Extension (${cleanUrl})` }
        };

        if (imageBuffer) {
            tags.image = {
                mime: 'image/jpeg',
                type: { id: 3, name: 'front cover' },
                description: 'Thumbnail',
                imageBuffer: imageBuffer
            };
        }

        if (fs.existsSync(outputPath)) {
            NodeID3.write(tags, outputPath);
            console.log(`[ID3 Tagging] Metadata written to ${outputFilename}`);
        }
    } catch (tagErr) {
        console.warn('[ID3 Tagging Warning]:', tagErr.message);
    }

    // Get file size for download progress
    let fileSize = 0;
    if (fs.existsSync(outputPath)) {
        fileSize = fs.statSync(outputPath).size;
    }

    if (onProgress) onProgress({ stage: 'ready', percent: 95 });

    return {
        success: true,
        title: meta.title,
        filename: outputFilename,
        filePath: outputPath,
        fileSize: fileSize,
        outputDir: outputDir
    };
}

module.exports = {
    downloadYtDlp,
    getVideoInfo,
    convertToMp3,
    ensureFFmpeg,
    TEMP_DIR,
    getYtDlpPath: () => YTDLP_PATH,
    getFFmpegPath: () => FFMPEG_PATH,
    OS_PLATFORM,
    OS_ARCH,
    IS_WIN
};
