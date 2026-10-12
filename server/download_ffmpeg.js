const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const binDir = path.join(__dirname, 'bin');
if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
}

const ffmpegUrl = 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';
const zipPath = path.join(__dirname, 'ffmpeg_download.zip');

console.log('Downloading official win64 FFmpeg release from GitHub...');

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
            }
            if (response.statusCode !== 200) {
                return reject(new Error(`HTTP ${response.statusCode}`));
            }
            response.pipe(file);
            file.on('finish', () => {
                file.close(() => resolve());
            });
        }).on('error', reject);
    });
}

async function main() {
    try {
        await downloadFile(ffmpegUrl, zipPath);
        console.log('Download finished. Extracting binaries...');

        execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${__dirname}/temp_ext' -Force"`);

        const extractedBinDir = path.join(__dirname, 'temp_ext', 'ffmpeg-master-latest-win64-gpl', 'bin');
        fs.copyFileSync(path.join(extractedBinDir, 'ffmpeg.exe'), path.join(binDir, 'ffmpeg.exe'));
        fs.copyFileSync(path.join(extractedBinDir, 'ffprobe.exe'), path.join(binDir, 'ffprobe.exe'));

        try { fs.unlinkSync(zipPath); } catch(e){}
        try { fs.rmSync(path.join(__dirname, 'temp_ext'), { recursive: true, force: true }); } catch(e){}

        console.log('SUCCESS! Clean win64 ffmpeg.exe and ffprobe.exe installed to bin/ folder.');
    } catch (e) {
        console.error('Error setting up FFmpeg:', e.message);
    }
}

main();
