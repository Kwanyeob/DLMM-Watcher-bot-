module.exports = {
  apps: [
    {
      name: 'dlmm-bot',
      script: 'dist/index.js',
      restart_delay: 3000,
      max_restarts: 10,
      watch: false,
      env: { NODE_ENV: 'production' },
    },
  ],
};
