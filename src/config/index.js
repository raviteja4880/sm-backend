const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 3001,
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  isProduction: process.env.NODE_ENV === 'production',
  // Optional: Add WebRTC configs (STUN/TURN)
  webrtc: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      // Add TURN servers here for production
    ]
  }
};

module.exports = config;
