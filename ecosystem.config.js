module.exports = {
    apps: [{
      name: 'vividus-docker',
      script: 'docker-compose',
      args: 'up',
      cwd: '/path/to/vividus',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production'
      }
    }]
  };