module.exports = {
  apps: [
    {
      name: 'taxi-api',
      script: 'src/index.js',
      instances: 'max',       // CPU count ke barabar processes
      exec_mode: 'cluster',   // PM2 cluster mode
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'development',
        PORT: 8000,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 8000,
      },
      error_file: 'logs/err.log',
      out_file: 'logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
