const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const { v4: uuidv4 } = require('uuid');

const config = require('./src/config');
const logger = require('./src/utils/logger');
const { initializeSockets } = require('./src/sockets');
const { errorHandler, notFoundHandler } = require('./src/middleware/errorHandler');

const app = express();
const server = http.createServer(app);

// 1. Core Middlewares
app.use(helmet());                     // Security Headers
app.use(compression());                 // Response Compression
app.use(express.json());               // Body Parsing
app.use(morgan('combined', { stream: { write: (message) => logger.info(message.trim()) } })); // Morgan → Winston

// 2. CORS Handling
const allowedOrigins = [
  config.frontendUrl,
  'http://localhost:5173',
  'http://127.0.0.1:5173'
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin) || !config.isProduction) {
      callback(null, true);
    } else {
      callback(new Error('CORS Policy Breach - Domain Not Allowed'));
    }
  },
  credentials: true
}));

// 3. Socket.io Initialization
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

const { rooms } = initializeSockets(io);

// 4. API Routes
// Root route for health check pings (stops 404 logs)
app.get('/', (req, res) => {
  res.status(200).send('ScreenCast Signaling Server is Live 🚀');
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    environment: config.env,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.get('/create-room', (req, res) => {
  const roomId = uuidv4().split('-')[0].toUpperCase();
  res.json({ roomId });
});

app.get('/room/:roomId', (req, res) => {
  const { roomId } = req.params;
  const room = rooms.get(roomId);
  if (!room) return res.status(404).json({ exists: false, message: 'Room not found' });
  
  res.json({
    exists: true,
    hasBroadcaster: !!room.broadcasterId,
    viewerCount: room.viewers.size,
    createdAt: room.createdAt
  });
});

// 5. Global Error Handling
app.use(notFoundHandler);
app.use(errorHandler);

// 6. Start Server
const PORT = config.port;
server.listen(PORT, () => {
  logger.info(`ScreenCast Signaling Server [${config.env}] running on port ${PORT}`);
  logger.info(`Allowed Origin: ${config.frontendUrl}`);
});
