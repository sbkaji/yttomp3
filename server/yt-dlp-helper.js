const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawn, execFile, execFileSync } = require('child_process');
const sanitize = require('sanitize-filename');
const NodeID3 = require('node-id3');

// ─── Binary Resolution ──────────────────────────────────────────────────────
// Priority: 1) System-installed binaries  2) Local ./bin/ bundled binaries
const BIN_DIR = path.join(__dirname, 'bin');

/**
 * Find a binary on the system PATH or fall back to local ./bin/ directory.
 * On Ubuntu/Docker, yt-dlp and ffmpeg are installed via apt/pip.
 * On Windows dev, they live in ./bin/.
 */
const TEMP_DIR = process.env.TEMP_DIR || path.join(require('os').tmpdir(), 'ytmp3_temp');

/**
 * Find a binary on the system PATH or fall back to local ./bin/ directory.
 * On Ubuntu/Docker, yt-dlp and ffmpeg are installed in /usr/local/bin or /usr/bin.
 * On Windows dev, they live in ./bin/.
 */
function findBinary(name) {
    const localName = process.platform === 'win32' ? `${name}.exe` : name;
    const localPath = path.join(BIN_DIR, localName);

    // 1) Direct check in standard Linux locations (Ubuntu / Docker / Coolify)
    if (process.platform !== 'win32') {
        const standardLinuxPaths = [
            `/usr/local/bin/${name}`,
            `/usr/bin/${name}`,
            `/bin/${name}`
        ];
        for (const p of standardLinuxPaths) {
            if (fs.existsSync(p)) {
                console.log(`[Binary] Found system ${name} at: ${p}`);
                return p;
            }
        }
    }

    // 2) Try system PATH via which/where
    try {
        const which = process.platform === 'win32' ? 'where' : 'which';
        const result = execFileSync(which, [name], { encoding: 'utf8', timeout: 5000 }).trim().split('\n')[0].trim();
        if (result && fs.existsSync(result)) {
            console.log(`[Binary] Using PATH ${name}: ${result}`);
            return result;
        }
    } catch (e) {
        // Not found on PATH, continue
    }

    // 3) Fall back to local ./bin/ directory
    if (fs.existsSync(localPath)) {
        console.log(`[Binary] Using local ${name}: ${localPath}`);
        return localPath;
    }

    // 4) Return local path (will be downloaded or error at runtime)
    return localPath;
}

let YTDLP_PATH = findBinary('yt-dlp');
let FFMPEG_PATH = findBinary('ffmpeg');

function ensureBinDir() {
    if (!fs.existsSync(BIN_DIR)) {
        fs.mkdirSync(BIN_DIR, { recursive: true });
    }
}

/**
 * Download latest yt-dlp binary from GitHub Releases (fallback for dev/local)
 */
function downloadYtDlp() {
    return new Promise((resolve, reject) => {
        // If system binary exists, use it
        try {
            execFileSync(YTDLP_PATH, ['--version'], { timeout: 10000 });
            return resolve(YTDLP_PATH);
        } catch (e) {
            // System binary not working, try downloading
        }

        ensureBinDir();
        const localPath = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

        if (fs.existsSync(localPath)) {
            YTDLP_PATH = localPath;
            return resolve(localPath);
        }

        console.log('[yt-dlp Engine] Downloading latest yt-dlp binary...');
        const downloadUrl = process.platform === 'win32'
            ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
            : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

        const file = fs.createWriteStream(localPath);

        function getRedirect(url) {
            https.get(url, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    getRedirect(res.headers.location);
                } else if (res.statusCode === 200) {
                    res.pipe(file);
                    file.on('finish', () => {
                        file.close(() => {
                            if (process.platform !== 'win32') {
                                fs.chmodSync(localPath, 0o755);
                            }
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
 * Ensure valid FFmpeg binary exists
 */
async function ensureFFmpeg() {
    try {
        execFileSync(FFMPEG_PATH, ['-version'], { timeout: 10000 });
        return FFMPEG_PATH;
    } catch (e) {
        // Try local bin
        ensureBinDir();
        const localPath = path.join(BIN_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
        if (fs.existsSync(localPath)) {
            FFMPEG_PATH = localPath;
            return localPath;
        }

        // Try ffmpeg-static npm package as last resort
        try {
            const ffmpegStatic = require('ffmpeg-static');
            if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
                FFMPEG_PATH = ffmpegStatic;
                console.log(`[FFmpeg] Using ffmpeg-static: ${ffmpegStatic}`);
                return ffmpegStatic;
            }
        } catch (e2) {
            // ffmpeg-static not installed
        }

        console.error('[FFmpeg] No FFmpeg binary found! Install ffmpeg on system or place in ./bin/');
        return FFMPEG_PATH;
    }
}

/**
 * Fetch video metadata using yt-dlp JSON output
 */
async function getVideoInfo(videoUrl) {
    await downloadYtDlp();

    // Clean playlist URL parameters to target exact video
    const cleanUrl = videoUrl.split('&list=')[0].split('&start_radio=')[0];

    return new Promise((resolve, reject) => {
        const args = [
            cleanUrl,
            '--dump-json',
            '--no-warnings',
            '--no-playlist',
            '--extractor-args', 'youtube:player_client=mweb,android,ios'
        ];

        execFile(YTDLP_PATH, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                console.error('[yt-dlp Info Error]:', stderr || err.message);
                return reject(new Error(`Failed to fetch video info: ${stderr || err.message}`));
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
                reject(new Error('Failed to parse yt-dlp metadata JSON output'));
            }
        });
    });
}

/**
 * Download & Convert YouTube Video to Pure MP3 using yt-dlp + FFmpeg
 * Files are saved to a TEMP directory on the server.
 */
async function convertToMp3({ url, bitrate = '320k', outputDir, onProgress }) {
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

    const meta = await getVideoInfo(cleanUrl);
    const sanitizedTitle = sanitize(meta.title) || `yt_audio_${meta.id}`;
    const outputFilename = `${sanitizedTitle}.mp3`;
    const outputPath = path.join(outputDir, outputFilename);

    if (onProgress) onProgress({ stage: 'downloading', percent: 10 });

    const kbps = bitrate.replace('k', '').replace('K', '') + 'K';

    // Determine ffmpeg location directory for yt-dlp
    const ffmpegDir = path.dirname(FFMPEG_PATH);

    // Arguments for pure MP3 audio extraction via FFmpeg
    const args = [
        cleanUrl,
        '-f', 'bestaudio/best',
        '--extract-audio',
        '--audio-format', 'mp3',
        '--audio-quality', kbps,
        '--ffmpeg-location', ffmpegDir,
        '--extractor-args', 'youtube:player_client=mweb,android,ios',
        '--output', path.join(outputDir, `${sanitizedTitle}.%(ext)s`),
        '--no-playlist',
        '--no-warnings'
    ];

    // Build env with ffmpeg on PATH (Linux uses : separator, Windows uses ;)
    const pathSep = process.platform === 'win32' ? ';' : ':';
    const env = {
        ...process.env,
        PATH: ffmpegDir + pathSep + (process.env.PATH || ''),
    };

    await new Promise((resolve, reject) => {
        const proc = spawn(YTDLP_PATH, args, { env });

        proc.stdout.on('data', (data) => {
            const str = data.toString();
            console.log('[yt-dlp stdout]:', str.trim());

            const match = str.match(/\[download\]\s+([\d\.]+)%/);
            if (match && onProgress) {
                const dlPercent = parseFloat(match[1]);
                const mappedPercent = Math.min(80, 10 + Math.round((dlPercent / 100) * 70));
                onProgress({ stage: 'downloading', percent: mappedPercent });
            }
            if (str.includes('[ExtractAudio]')) {
                if (onProgress) onProgress({ stage: 'decoding_ffmpeg', percent: 82 });
            }
        });

        proc.stderr.on('data', (data) => {
            console.warn('[yt-dlp stderr]:', data.toString().trim());
        });

        proc.on('error', (err) => reject(err));

        proc.on('close', (code) => {
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
    TEMP_DIR
};
