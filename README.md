# 🎧 YouTube to MP3 Browser Extension & FFmpeg Audio Engine

An integrated Chromium browser extension (Manifest V3) and local processing server (Node.js + FFmpeg) to download YouTube videos as high-quality MP3 audio files with original video titles, ID3 metadata tags (cover art, artist, title), inline YouTube button injection, and a multi-download queue manager.

---

## 🌟 Key Features

1. **Inline YouTube Download Button**:
   - Automatically injected into the YouTube watch page action bar (`youtube.com/watch?v=...`).
   - 1-Click download with live status updates ("Queued", "Downloading", "FFmpeg Decoding", "Completed").

2. **FFmpeg Local Audio Decoder**:
   - Uses native/static FFmpeg binary to extract raw DASH/WebM/MP4 audio streams and re-encode to high-bitrate MP3 (`320kbps`, `256kbps`, `192kbps`, `128kbps`).
   - Automatically downloads video thumbnail and embeds ID3v2 tags (Title, Channel Name, Album Art) into the resulting `.mp3`.
   - Saves files directly with clean, sanitized original titles into your system's `Downloads/YouTube_MP3s/` folder.

3. **Multi-Download Queue Manager**:
   - Modern Glassmorphism dark-mode popup UI.
   - Concurrency pool controller (1 to 5 parallel downloads).
   - Batch URL import (paste multiple YouTube links at once).
   - Live Server-Sent Events (SSE) progress indicators for download & FFmpeg transcoding stages.
   - Retry failed items, remove items, clear completed downloads.

---

## 📁 Project Structure

```
yttomp3/
├── extension/             # Chrome Extension (Manifest V3)
│   ├── manifest.json      # Extension Manifest V3 configuration
│   ├── content.js         # Injects "Download MP3" button into YouTube DOM
│   ├── content.css        # Styles for injected YouTube button & toast popups
│   ├── background.js     # Background worker for badge counts & messaging
│   ├── popup.html         # Extension Popup UI
│   ├── popup.css          # Glassmorphic dark styling
│   ├── popup.js           # Popup controller & SSE progress subscriber
│   └── icons/             # Extension icons (16, 48, 128)
│
└── server/                # Local Processing Engine
    ├── package.json       # Node.js dependencies
    ├── server.js          # Express API & SSE progress server (port 3500)
    ├── queue.js           # Multi-threaded download queue & concurrency pool
    └── ffmpeg-converter.js # FFmpeg stream decoder & ID3 tagger
```

---

## 🚀 Quickstart Guide

### Step 1: Start the Local FFmpeg Server

1. Open your terminal and navigate to the `server` directory:
   ```bash
   cd server
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the local server:
   ```bash
   npm start
   ```
   *The server will run on `http://localhost:3500` and create your output folder at `Downloads/YouTube_MP3s`.*

---

### Step 2: Install Chrome Extension

1. Open Google Chrome (or Brave / Edge / Opera).
2. Go to `chrome://extensions` in your address bar.
3. Enable **Developer mode** using the toggle in the top-right corner.
4. Click **Load unpacked** (top-left).
5. Select the `extension` folder inside this project (`f:/yttomp3/extension`).

---

## 🎮 How to Use

### Method A: Single-Click Download on YouTube
1. Go to any YouTube video (e.g., `https://www.youtube.com/watch?v=...`).
2. Look for the purple gradient **🎧 Download MP3** button next to Like / Share.
3. Click it! The video will be added to your local FFmpeg processing queue.

### Method B: Multi-Download Queue via Extension Popup
1. Click the **🎧 YT to MP3** extension icon in your Chrome toolbar.
2. Select your desired audio quality (320k HQ / 256k / 192k / 128k).
3. Paste one or multiple YouTube URLs into the text box (one per line).
4. Click **Add to Queue**.
5. Adjust parallel download limit (1 - 5 downloads at once) using the dropdown.

---

## 🛠️ Verification & Testing

To verify the local engine manually:
- Health Check: [http://localhost:3500/health](http://localhost:3500/health)
- Queue Status: [http://localhost:3500/api/queue](http://localhost:3500/api/queue)
