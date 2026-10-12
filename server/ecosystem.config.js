/**
 * PM2 Ecosystem Configuration — Production
 * ==========================================
 * Start with:  pm2 start ecosystem.config.js
 * Monitor:     pm2 monit
 * Logs:        pm2 logs youtube-mp3-server
 */
module.exports = {
    apps: [{
        name: 'youtube-mp3-server',
        script: 'server.js',
        instances: 1,                  // Single instance (FFmpeg is CPU-heavy)
        exec_mode: 'fork',
        autorestart: true,
        watch: false,
        max_memory_restart: '512M',
        env: {
            NODE_ENV: 'development',
            PORT: 3500
        },
        env_production: {
            NODE_ENV: 'production',
            PORT: 3500
        },
        // Logging
        log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
        error_file: './logs/error.log',
        out_file: './logs/output.log',
        merge_logs: true,
        // Graceful shutdown
        kill_timeout: 10000,
        listen_timeout: 5000,
        // Restart policies
        max_restarts: 15,
        min_uptime: 5000,
        restart_delay: 4000
    }]
};
