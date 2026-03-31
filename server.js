const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

// Configure Socket.io with dynamic CORS
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:5173',
  'http://127.0.0.1:5173'
].filter(Boolean);

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps or curl) or allowed origins
      if (!origin || allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV !== 'production') {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ['GET', 'POST'],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV !== 'production') {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));
app.use(express.json());

// ─── Room Registry ──────────────────────────────────────────────────────────
// rooms: Map<roomId, { broadcasterId: string|null, viewers: Set<string>, createdAt: Date }>
const rooms = new Map();

// ─── Health Check ────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    rooms: rooms.size,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// ─── Room Info Endpoint ───────────────────────────────────────────────────────
app.get('/room/:roomId', (req, res) => {
  const { roomId } = req.params;
  const room = rooms.get(roomId);
  if (!room) {
    return res.json({ exists: false });
  }
  res.json({
    exists: true,
    hasBroadcaster: !!room.broadcasterId,
    viewerCount: room.viewers.size,
    createdAt: room.createdAt
  });
});

// ─── Generate Room Endpoint ───────────────────────────────────────────────────
app.get('/create-room', (req, res) => {
  const roomId = uuidv4().split('-')[0].toUpperCase(); // Short 8-char room ID
  res.json({ roomId });
});

// ─── Socket.io Signaling Logic ────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[${new Date().toISOString()}] Client connected: ${socket.id}`);

  /**
   * BROADCASTER: Starts sharing screen and creates/joins a room
   * Emits: 'room-created' back to broadcaster with room details
   */
  socket.on('broadcaster-join', ({ roomId }) => {
    if (!roomId) {
      socket.emit('error', { message: 'Room ID is required' });
      return;
    }

    // Create room if it doesn't exist
    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        broadcasterId: socket.id,
        viewers: new Set(),
        createdAt: new Date().toISOString()
      });
    } else {
      // Update broadcaster if room already exists (reconnect scenario)
      const room = rooms.get(roomId);
      room.broadcasterId = socket.id;
    }

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = 'broadcaster';

    const room = rooms.get(roomId);

    console.log(`[BROADCAST] ${socket.id} broadcasting in room ${roomId}`);

    socket.emit('room-created', {
      roomId,
      viewerCount: room.viewers.size
    });

    // Notify any existing viewers that broadcaster is back online
    if (room.viewers.size > 0) {
      socket.to(roomId).emit('broadcaster-reconnected', { broadcasterId: socket.id });
    }
  });

  /**
   * VIEWER: Joins a room to watch a stream
   * Emits: 'viewer-joined' to broadcaster so they initiate WebRTC offer
   */
  socket.on('viewer-join', ({ roomId }) => {
    if (!roomId) {
      socket.emit('error', { message: 'Room ID is required' });
      return;
    }

    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('error', { message: 'Room not found. Check the Room ID.' });
      return;
    }
    if (!room.broadcasterId) {
      socket.emit('error', { message: 'No broadcaster in this room yet.' });
      return;
    }

    room.viewers.add(socket.id);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = 'viewer';

    console.log(`[VIEW] ${socket.id} joined room ${roomId} | Viewers: ${room.viewers.size}`);

    // Update viewer count for broadcaster
    io.to(room.broadcasterId).emit('viewer-count-update', {
      count: room.viewers.size
    });

    // Ask broadcaster to initiate WebRTC offer to this specific viewer
    io.to(room.broadcasterId).emit('viewer-joined', {
      viewerId: socket.id,
      viewerCount: room.viewers.size
    });
  });

  /**
   * WebRTC OFFER: Broadcaster sends SDP offer to a specific viewer
   */
  socket.on('offer', ({ targetId, offer }) => {
    console.log(`[OFFER] ${socket.id} → ${targetId}`);
    io.to(targetId).emit('offer', {
      offer,
      broadcasterId: socket.id
    });
  });

  /**
   * WebRTC ANSWER: Viewer sends SDP answer back to broadcaster
   */
  socket.on('answer', ({ targetId, answer }) => {
    console.log(`[ANSWER] ${socket.id} → ${targetId}`);
    io.to(targetId).emit('answer', {
      answer,
      viewerId: socket.id
    });
  });

  /**
   * ICE CANDIDATE: Relay ICE candidates between peers
   */
  socket.on('ice-candidate', ({ targetId, candidate }) => {
    if (targetId && candidate) {
      io.to(targetId).emit('ice-candidate', {
        candidate,
        fromId: socket.id
      });
    }
  });

  /**
   * STATS: Broadcaster can broadcast performance stats to viewers
   */
  socket.on('stats-update', (stats) => {
    const roomId = socket.data.roomId;
    if (roomId) {
      socket.to(roomId).emit('stats-update', stats);
    }
  });

  /**
   * RECONNECT REQUEST: Viewer asks broadcaster for a fresh offer
   */
  socket.on('request-reconnect', ({ broadcasterId }) => {
    io.to(broadcasterId).emit('viewer-joined', {
      viewerId: socket.id,
      viewerCount: 0
    });
  });

  /**
   * DISCONNECT: Clean up room state when any peer leaves
   */
  socket.on('disconnect', () => {
    const { roomId, role } = socket.data || {};
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    if (role === 'broadcaster') {
      // Broadcaster left: notify all viewers
      room.broadcasterId = null;
      socket.to(roomId).emit('broadcaster-disconnected');
      console.log(`[BROADCAST END] Broadcaster left room ${roomId}`);

      // Clean up empty rooms after a delay (allow reconnect)
      setTimeout(() => {
        const r = rooms.get(roomId);
        if (r && !r.broadcasterId && r.viewers.size === 0) {
          rooms.delete(roomId);
          console.log(`[ROOM DELETED] ${roomId}`);
        }
      }, 30000); // 30s grace period for reconnection

    } else if (role === 'viewer') {
      // Viewer left: update broadcaster
      room.viewers.delete(socket.id);
      console.log(`[VIEW END] Viewer left room ${roomId} | Viewers: ${room.viewers.size}`);

      if (room.broadcasterId) {
        io.to(room.broadcasterId).emit('viewer-disconnected', {
          viewerId: socket.id,
          viewerCount: room.viewers.size
        });
        io.to(room.broadcasterId).emit('viewer-count-update', {
          count: room.viewers.size
        });
      }
    }

    console.log(`[DISCONNECT] ${socket.id} (${role}) from room ${roomId}`);
  });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n🚀 ScreenCast Signaling Server running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Env: ${process.env.NODE_ENV || 'development'}\n`);
});
