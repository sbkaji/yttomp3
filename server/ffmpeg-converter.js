const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const ytdl = require('@distube/ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const NodeID3 = require('node-id3');
const sanitize = require('sanitize-filename');

// Set ffmpeg binary path
ffmpeg.setFfmpegPath(ffmpegPath);

// Ensure default downloads directory exists
const DEFAULT_DOWNLOAD_DIR = path.join(require('os').homedir(), 'Downloads', 'YouTube_MP3s');

function ensureDirExists(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

ensureDirExists(DEFAULT_DOWNLOAD_DIR);

/**
 * Fetch buffer from URL (for thumbnail downloading)
 */
function fetchBuffer(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        client.get(url, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchBuffer(res.headers.location).then(resolve).catch(reject);
            }
            const data = [];
            res.on('data', chunk => data.push(chunk));
            res.on('end', () => resolve(Buffer.concat(data)));
            res.on('error', err => reject(err));
        }).on('error', err => reject(err));
    });
}

/**
 * Fetch Video Metadata without starting download
 */
async function getVideoInfo(videoUrl) {
    try {
        const info = await ytdl.getInfo(videoUrl);
        const videoDetails = info.videoDetails;
        
        // Pick best thumbnail
        const thumbnails = videoDetails.thumbnails || [];
        const bestThumbnail = thumbnails.length > 0 ? thumbnails[thumbnails.length - 1].url : null;
        
        return {
            id: videoDetails.videoId,
            title: videoDetails.title,
            channel: videoDetails.author ? videoDetails.author.name : 'Unknown Artist',
            duration: parseInt(videoDetails.lengthSeconds || 0),
            thumbnail: bestThumbnail,
            url: videoDetails.video_url || videoUrl
        };
    } catch (err) {
        console.error('Error fetching video info:', err.message);
        throw new Error(`Failed to extract YouTube video metadata: ${err.message}`);
    }
}

/**
 * Convert YouTube video to MP3 using FFmpeg Audio Decoder
 * @param {Object} options 
 * @param {string} options.url YouTube Video URL
 * @param {string} options.bitrate Audio Bitrate (e.g. '320k', '256k', '192k', '128k')
 * @param {string} [options.outputDir] Destination folder
 * @param {Function} [options.onProgress] Callback for progress updates
 */
async function convertToMp3({ url, bitrate = '320k', outputDir = DEFAULT_DOWNLOAD_DIR, onProgress }) {
    ensureDirExists(outputDir);

    console.log(`[FFmpeg Engine] Fetching stream info for: ${url}`);
    const info = await ytdl.getInfo(url);
    const details = info.videoDetails;

    const rawTitle = details.title || 'YouTube Audio';
    const channelName = details.author ? details.author.name : 'YouTube';
    const sanitizedTitle = sanitize(rawTitle) || `yt_audio_${details.videoId}`;
    const outputFilename = `${sanitizedTitle}.mp3`;
    const outputPath = path.join(outputDir, outputFilename);
    const tempAudioPath = path.join(outputDir, `temp_${details.videoId}_${Date.now()}.raw`);

    // Get best audio-only stream
    const audioFormats = ytdl.filterFormats(info.formats, 'audioonly');
    if (!audioFormats || audioFormats.length === 0) {
        throw new Error('No audio streams found for this video.');
    }

    // Sort by highest audio bitrate
    audioFormats.sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0));
    const selectedFormat = audioFormats[0];

    console.log(`[FFmpeg Engine] Selected Format: ${selectedFormat.mimeType || 'audio/webm'} @ ${selectedFormat.audioBitrate}kbps`);

    // Download raw stream with progress
    const audioStream = ytdl.downloadFromInfo(info, { format: selectedFormat });
    const writeStream = fs.createWriteStream(tempAudioPath);

    let downloadedBytes = 0;
    const totalBytes = parseInt(selectedFormat.contentLength || details.lengthSeconds * 16000 || 0);

    await new Promise((resolve, reject) => {
        audioStream.on('data', (chunk) => {
            downloadedBytes += chunk.length;
            if (totalBytes > 0 && onProgress) {
                const percent = Math.min(99, Math.round((downloadedBytes / totalBytes) * 50));
                onProgress({ stage: 'downloading', percent, bytes: downloadedBytes });
            }
        });

        audioStream.pipe(writeStream);

        writeStream.on('finish', () => resolve());
        writeStream.on('error', (err) => reject(err));
        audioStream.on('error', (err) => reject(err));
    });

    console.log(`[FFmpeg Engine] Raw audio stream cached. Decoding audio using FFmpeg...`);
    if (onProgress) onProgress({ stage: 'decoding_ffmpeg', percent: 50 });

    // Decode audio using FFmpeg to MP3
    await new Promise((resolve, reject) => {
        ffmpeg(tempAudioPath)
            .audioCodec('libmp3lame')
            .audioBitrate(bitrate.replace('k', ''))
            .audioFrequency(44100)
            .audioChannels(2)
            .toFormat('mp3')
            .on('start', (cmd) => {
                console.log('[FFmpeg Command]:', cmd);
            })
            .on('progress', (progress) => {
                if (onProgress && progress.percent) {
                    // Map FFmpeg progress to 50% - 90% range
                    const transcodePercent = Math.min(90, 50 + Math.round((progress.percent / 100) * 40));
                    onProgress({ stage: 'decoding_ffmpeg', percent: transcodePercent });
                }
            })
            .on('error', (err) => {
                console.error('[FFmpeg Error]:', err);
                reject(err);
            })
            .on('end', () => {
                console.log('[FFmpeg Engine] Audio decoding complete!');
                resolve();
            })
            .save(outputPath);
    });

    // Cleanup temporary raw audio stream
    if (fs.existsSync(tempAudioPath)) {
        try { fs.unlinkSync(tempAudioPath); } catch (e) { }
    }

    // Embed ID3 Metadata Tags
    if (onProgress) onProgress({ stage: 'tagging', percent: 92 });
    try {
        const thumbnails = details.thumbnails || [];
        const bestThumbUrl = thumbnails.length > 0 ? thumbnails[thumbnails.length - 1].url : null;
        let imageBuffer = null;

        if (bestThumbUrl) {
            try {
                imageBuffer = await fetchBuffer(bestThumbUrl);
            } catch (imgErr) {
                console.warn('Could not fetch thumbnail for ID3 tag:', imgErr.message);
            }
        }

        const tags = {
            title: rawTitle,
            artist: channelName,
            album: 'YouTube MP3 Downloads',
            comment: {
                language: 'eng',
                text: `Downloaded via YouTube MP3 Extension (${url})`
            }
        };

        if (imageBuffer) {
            tags.image = {
                mime: 'image/jpeg',
                type: { id: 3, name: 'front cover' },
                description: 'Thumbnail',
                imageBuffer: imageBuffer
            };
        }

        NodeID3.write(tags, outputPath);
        console.log(`[ID3 Tagging] Metadata written to ${outputFilename}`);
    } catch (tagErr) {
        console.warn('[ID3 Tagging Warning]:', tagErr.message);
    }

    if (onProgress) onProgress({ stage: 'completed', percent: 100 });

    return {
        success: true,
        title: rawTitle,
        filename: outputFilename,
        filePath: outputPath,
        outputDir: outputDir
    };
}

module.exports = {
    getVideoInfo,
    convertToMp3,
    DEFAULT_DOWNLOAD_DIR
};
