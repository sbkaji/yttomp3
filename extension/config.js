/**
 * Extension Configuration — Production Ready
 * ============================================
 * Central config for server URL and API key.
 * Change these values before building/publishing the extension.
 */
const CONFIG = {
    // ─── Server URL ──────────────────────────────────────────
    // Default: 'http://localhost:3500' for local server.
    // If hosting on Coolify or a remote Linux/Windows server, change here
    // or configure anytime in the extension popup settings (⚙️ icon).
    // Examples:
    //   'http://localhost:3500'
    //   'https://ytmp3.yourdomain.com'
    //   'http://your-vps-ip:3500'
    SERVER_URL: 'http://localhost:3500',

    // ─── API Key ─────────────────────────────────────────────
    // Must match the API_KEY value set in the server's .env file
    // Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
    API_KEY: 'dev_key_change_in_production',

    // ─── Extension Version ───────────────────────────────────
    VERSION: '1.0.0'
};

// Freeze to prevent accidental modification
Object.freeze(CONFIG);
