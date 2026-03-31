const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

const initializeSockets = (io) => {
  // Room Registry: Map<roomId, { broadcasterId: string|null, viewers: Set<string>, createdAt: Date }>
  const rooms = new Map();

  io.on('connection', (socket) => {
    logger.info(`Client connected: ${socket.id} (IP: ${socket.handshake.address})`);

    // Existing broadcaster/viewer logic moved here with enhanced logging
    socket.on('broadcaster-join', ({ roomId }) => {
      logger.debug(`[Socket] broadcaster-join: user ${socket.id} to room ${roomId}`);
      if (!roomId) return socket.emit('error', { message: 'Room ID required' });

      if (!rooms.has(roomId)) {
        rooms.set(roomId, {
          broadcasterId: socket.id,
          viewers: new Set(),
          createdAt: new Date().toISOString()
        });
      } else {
        const room = rooms.get(roomId);
        room.broadcasterId = socket.id;
      }

      socket.join(roomId);
      socket.data = { ...socket.data, roomId, role: 'broadcaster' };
      
      const room = rooms.get(roomId);
      socket.emit('room-created', { roomId, viewerCount: room.viewers.size });

      if (room.viewers.size > 0) {
        socket.to(roomId).emit('broadcaster-reconnected', { broadcasterId: socket.id });
      }
      logger.info(`Room ${roomId} created/updated by ${socket.id}`);
    });

    socket.on('viewer-join', ({ roomId }) => {
      logger.debug(`[Socket] viewer-join: user ${socket.id} to room ${roomId}`);
      if (!roomId) return socket.emit('error', { message: 'Room ID required' });
      
      const room = rooms.get(roomId);
      if (!room || !room.broadcasterId) {
        return socket.emit('error', { message: 'Room or broadcaster not found' });
      }

      room.viewers.add(socket.id);
      socket.join(roomId);
      socket.data = { ...socket.data, roomId, role: 'viewer' };

      // Update counts and trigger peer handshake
      io.to(room.broadcasterId).emit('viewer-count-update', { count: room.viewers.size });
      io.to(room.broadcasterId).emit('viewer-joined', { 
        viewerId: socket.id, 
        viewerCount: room.viewers.size 
      });
      logger.info(`Viewer ${socket.id} joined ${roomId}`);
    });

    // Signaling Relays (SDP Offer/Answer/ICE)
    socket.on('offer', ({ targetId, offer }) => {
      io.to(targetId).emit('offer', { offer, broadcasterId: socket.id });
    });

    socket.on('answer', ({ targetId, answer }) => {
      io.to(targetId).emit('answer', { answer, viewerId: socket.id });
    });

    socket.on('ice-candidate', ({ targetId, candidate }) => {
      if (targetId && candidate) {
        io.to(targetId).emit('ice-candidate', { candidate, fromId: socket.id });
      }
    });

    socket.on('disconnect', () => {
      const { roomId, role } = socket.data || {};
      if (roomId && rooms.has(roomId)) {
        const room = rooms.get(roomId);
        if (role === 'broadcaster') {
          room.broadcasterId = null;
          socket.to(roomId).emit('broadcaster-disconnected');
          // Room TTL: Delete empty/inactive rooms after 5 minutes
          setTimeout(() => {
             if (rooms.has(roomId) && !rooms.get(roomId).broadcasterId && rooms.get(roomId).viewers.size === 0) {
                 rooms.delete(roomId);
                 logger.info(`Room ${roomId} deleted (timeout)`);
             }
          }, 300000);
        } else if (role === 'viewer') {
          room.viewers.delete(socket.id);
          if (room.broadcasterId) {
            io.to(room.broadcasterId).emit('viewer-disconnected', { viewerId: socket.id, viewerCount: room.viewers.size });
            io.to(room.broadcasterId).emit('viewer-count-update', { count: room.viewers.size });
          }
        }
      }
      logger.info(`Client disconnected: ${socket.id}`);
    });
  });

  return { rooms };
};

module.exports = { initializeSockets };
