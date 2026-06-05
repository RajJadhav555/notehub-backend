const { Server } = require("socket.io");
const pool = require('./db');

let io;
const activeUsers = new Map();

const initSocket = (server) => {
  const allowedOrigins = process.env.CORS_ORIGIN?.split(',') || ['http://localhost:5173', 'http://localhost:3000'];
  
  io = new Server(server, {
    cors: {
      origin: allowedOrigins,
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  io.on("connection", (socket) => {
    const userId = socket.handshake.query.userId;
    const userName = socket.handshake.query.userName;
    console.log(`User connected: ${socket.id} (userId: ${userId}, name: ${userName})`);

    // Mark user online in DB when they connect via socket
    if (userId && userId !== 'undefined') {
      const currentCount = activeUsers.get(userId) || 0;
      activeUsers.set(userId, currentCount + 1);

      pool.query('UPDATE users SET last_seen = NOW() WHERE id = $1', [userId])
        .then(() => {
          // Broadcast to all clients that someone's status changed
          io.emit("online_status_changed", { userId, status: 'online' });
        })
        .catch(err => console.error('Failed to update last_seen on connect:', err.message));
    }

    // Join a specific room (e.g., "general", "video-123")
    socket.on("join_room", (room) => {
      socket.join(room);
      console.log(`User ${socket.id} joined room: ${room}`);
      
      // Notify others in the room (useful for video signaling)
      socket.to(room).emit("user_joined", socket.id);
    });

    // Handle chat messages
    socket.on("send_message", (data) => {
      // data: { room, user, message, time, avatar, type, fileName }
      // Broadcast to everyone in the room INCLUDING sender (for simplicity, or handle optimistic UI on client)
      // Usually better to broadcast to others only if client handles own optimistic update, but here we'll broadcast to all for consistency
      io.to(data.room).emit("receive_message", data);
    });

    // Handle WebRTC Signaling
    // Offer: Initiator sends offer to a specific user (or broadcast to room if simple mesh)
    socket.on("call_user", ({ userToCall, signalData, from, name }) => {
      io.to(userToCall).emit("call_user", { signal: signalData, from, name });
    });

    // Answer: Receiver sends answer back to initiator
    socket.on("answer_call", (data) => {
      io.to(data.to).emit("call_accepted", data.signal);
    });
    
    // Simple ICE Candidate exchange if needed (socket.io handles this usually via signaling)
    socket.on("signal", (data) => {
        io.to(data.to).emit("signal", { signal: data.signal, from: socket.id });
    });

    // Handle Video Call Requests
    socket.on("request_video", (data) => {
        // data: { userToCall, from, name }
        io.to(data.userToCall).emit("request_video", { from: data.from, name: data.name });
    });

    socket.on("video_response", (data) => {
        // data: { to, accepted }
        io.to(data.to).emit("video_response", { from: socket.id, accepted: data.accepted });
    });

    // --- Link-Unlink Focus Mode ---
    socket.on("start_focus_link", (data) => {
        // data: { room, user, startTime }
        const rooms = Array.from(socket.rooms);
        console.log(`🎯 Focus Link Request: Room=${data.room}, User=${data.user}, SocketId=${socket.id}, SocketRooms=`, rooms);
        if (rooms.includes(data.room)) {
            console.log(`✅ Socket is in room ${data.room}. Broadcasting focus_link_started.`);
            io.to(data.room).emit("focus_link_started", data);
        } else {
            console.log(`⚠️ Socket ${socket.id} is NOT in room ${data.room}! Re-joining and broadcasting.`);
            socket.join(data.room);
            io.to(data.room).emit("focus_link_started", data);
        }
    });

    socket.on("break_focus_link", (data) => {
        // data: { room, user, reason }
        console.log(`❌ Focus Link broken in ${data.room} by ${data.user}: ${data.reason}`);
        io.to(data.room).emit("focus_link_broken", data);
    });

    // --- Group Voice Calling (WebRTC Mesh) ---
    socket.on("join_group_voice", (data) => {
        // data: { groupId, userId, userName, groupName }
        const room = `voice_${data.groupId}`;
        socket.join(room);
        socket.to(room).emit("group_voice_user_joined", { 
            socketId: socket.id, 
            userId: data.userId, 
            userName: data.userName 
        });
        
        // Also notify the general group chat room that a voice call started
        if (data.groupName) {
            io.to(data.groupName).emit("group_voice_started", {
                userName: data.userName,
                groupId: data.groupId,
                groupName: data.groupName
            });
        }
    });

    socket.on("group_voice_signal", (data) => {
        // data: { targetSocketId, callerSocketId, signal, callerName, userId }
        io.to(data.targetSocketId).emit("group_voice_signal_receive", {
            callerSocketId: data.callerSocketId,
            signal: data.signal,
            callerName: data.callerName,
            userId: data.userId
        });
    });

    socket.on("leave_group_voice", (data) => {
        const room = `voice_${data.groupId}`;
        socket.leave(room);
        socket.to(room).emit("group_voice_user_left", { socketId: socket.id });
    });
    
    // --- 1-on-1 Call Management ---
    socket.on("reject_1on1_call", (data) => {
        // data: { to } (socket id of caller)
        io.to(data.to).emit("call_rejected");
    });

    socket.on("cancel_1on1_call", (data) => {
        // data: { to } (user id of callee)
        // We broadcast to all sockets of that user, or use the general socket.on("call_cancelled")
        socket.broadcast.emit("call_cancelled", { from: socket.id });
    });

    socket.on("end_1on1_call", (data) => {
        // data: { to } (socket id of partner)
        if (data.to) {
            io.to(data.to).emit("call_ended");
        }
    });
    
    // Disconnect — mark user offline in DB
    socket.on("disconnect", () => {
      console.log("User disconnected", socket.id, "(userId:", userId, ")");
      if (userId && userId !== 'undefined') {
        const currentCount = activeUsers.get(userId) || 0;
        const newCount = Math.max(0, currentCount - 1);
        activeUsers.set(userId, newCount);

        // Wait 5 seconds before marking offline, allowing for page reloads or other tabs
        setTimeout(() => {
          if (activeUsers.get(userId) === 0) {
            pool.query("UPDATE users SET last_seen = NOW() - INTERVAL '5 minutes' WHERE id = $1", [userId])
              .then(() => {
                io.emit("online_status_changed", { userId, status: 'offline' });
              })
              .catch(err => console.error('Failed to update last_seen on disconnect:', err.message));
          }
        }, 5000);
      }
      // Broadcast disconnect for WebRTC Mesh teardown
      socket.broadcast.emit("group_voice_user_left", { socketId: socket.id });
    });
  });
  
  return io;
};

const getIO = () => {
  if (!io) {
    throw new Error("Socket.io not initialized!");
  }
  return io;
};

module.exports = { initSocket, getIO };

