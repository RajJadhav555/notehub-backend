const { Server } = require("socket.io");
const pool = require('./db');

let io;
const activeUsers = new Map();
// Track active voice sessions: groupId -> Map<socketId, { userName, userId }>
const activeVoiceSessions = new Map();

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
          io.emit("online_status_changed", { userId, status: 'online' });
        })
        .catch(err => console.error('Failed to update last_seen on connect:', err.message));
    }

    // Join a specific room
    socket.on("join_room", (room) => {
      socket.join(room);
      console.log(`User ${socket.id} joined room: ${room}`);
      socket.to(room).emit("user_joined", socket.id);
    });

    // Handle chat messages
    socket.on("send_message", (data) => {
      io.to(data.room).emit("receive_message", data);
    });

    // Handle WebRTC Signaling
    socket.on("call_user", ({ userToCall, signalData, from, name }) => {
      io.to(String(userToCall)).emit("call_user", { signal: signalData, from, name });
    });

    socket.on("answer_call", (data) => {
      io.to(data.to).emit("call_accepted", data.signal);
    });
    
    socket.on("signal", (data) => {
        io.to(data.to).emit("signal", { signal: data.signal, from: socket.id });
    });

    socket.on("request_video", (data) => {
        io.to(data.userToCall).emit("request_video", { from: data.from, name: data.name });
    });

    socket.on("video_response", (data) => {
        io.to(data.to).emit("video_response", { from: socket.id, accepted: data.accepted });
    });

    // --- Link-Unlink Focus Mode ---
    socket.on("start_focus_link", (data) => {
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
        console.log(`❌ Focus Link broken in ${data.room} by ${data.user}: ${data.reason}`);
        io.to(data.room).emit("focus_link_broken", data);
    });

    // --- Group Voice Calling (WebRTC Mesh) with Active Session Tracking ---
    
    // Helper: broadcast current call participants to the group chat room
    const broadcastCallStatus = (groupId, groupName) => {
        const key = String(groupId);
        const session = activeVoiceSessions.get(key);
        if (session && session.size > 0) {
            const participants = Array.from(session.values());
            io.to(groupName).emit("group_call_active", {
                groupId: key,
                groupName,
                participants // [{ userName, userId }, ...]
            });
        } else {
            io.to(groupName).emit("group_call_ended", { groupId: key, groupName });
            activeVoiceSessions.delete(key);
        }
    };

    socket.on("join_group_voice", (data) => {
        // data: { groupId, userId, userName, groupName }
        const room = `voice_${data.groupId}`;
        socket.join(room);
        
        // Store groupId and groupName on the socket for disconnect cleanup
        socket._voiceGroupId = String(data.groupId);
        socket._voiceGroupName = data.groupName;
        
        const key = String(data.groupId);
        // Track in activeVoiceSessions
        if (!activeVoiceSessions.has(key)) {
            activeVoiceSessions.set(key, new Map());
        }
        activeVoiceSessions.get(key).set(socket.id, {
            userName: data.userName,
            userId: data.userId
        });
        
        // Notify other peers in the voice room for WebRTC mesh
        socket.to(room).emit("group_voice_user_joined", { 
            socketId: socket.id, 
            userId: data.userId, 
            userName: data.userName 
        });
        
        // Broadcast updated call status banner to the group chat room
        broadcastCallStatus(key, data.groupName);
    });

    socket.on("group_voice_signal", (data) => {
        io.to(data.targetSocketId).emit("group_voice_signal_receive", {
            callerSocketId: data.callerSocketId,
            signal: data.signal,
            callerName: data.callerName,
            userId: data.userId
        });
    });

    socket.on("leave_group_voice", (data) => {
        // data: { groupId, groupName }
        const room = `voice_${data.groupId}`;
        socket.leave(room);
        socket.to(room).emit("group_voice_user_left", { socketId: socket.id });
        
        // Remove from tracking
        const key = String(data.groupId);
        const session = activeVoiceSessions.get(key);
        if (session) {
            session.delete(socket.id);
            if (session.size === 0) activeVoiceSessions.delete(key);
        }
        
        // Clear socket voice metadata
        delete socket._voiceGroupId;
        delete socket._voiceGroupName;
        
        // Broadcast updated status
        broadcastCallStatus(key, data.groupName);
    });
    
    // --- 1-on-1 Call Management ---
    socket.on("reject_1on1_call", (data) => {
        io.to(data.to).emit("call_rejected");
    });

    socket.on("cancel_1on1_call", (data) => {
        socket.broadcast.emit("call_cancelled", { from: socket.id });
    });

    socket.on("end_1on1_call", (data) => {
        if (data.to) {
            io.to(data.to).emit("call_ended");
        }
    });

    // --- Check active call for a group ---
    socket.on("check_active_call", (data) => {
        // data: { groupId, groupName }
        const key = String(data.groupId);
        const session = activeVoiceSessions.get(key);
        if (session && session.size > 0) {
            const participants = Array.from(session.values());
            socket.emit("group_call_active", {
                groupId: key,
                groupName: data.groupName,
                participants
            });
        }
    });
    
    // Disconnect — mark user offline in DB
    socket.on("disconnect", () => {
      console.log("User disconnected", socket.id, "(userId:", userId, ")");
      if (userId && userId !== 'undefined') {
        const currentCount = activeUsers.get(userId) || 0;
        const newCount = Math.max(0, currentCount - 1);
        activeUsers.set(userId, newCount);

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
      
      // Clean up voice session tracking on disconnect
      const voiceGroupId = socket._voiceGroupId;
      const voiceGroupName = socket._voiceGroupName;
      if (voiceGroupId) {
          const key = String(voiceGroupId);
          const session = activeVoiceSessions.get(key);
          if (session) {
              session.delete(socket.id);
              if (session.size === 0) activeVoiceSessions.delete(key);
          }
          if (voiceGroupName) {
              broadcastCallStatus(key, voiceGroupName);
          }
      }
      
      // Broadcast disconnect for WebRTC Mesh teardown
      socket.broadcast.emit("group_voice_user_left", { socketId: socket.id });
    });
  });

  // Heartbeat: Update last_seen = NOW() for all online users every 1 minute
  setInterval(() => {
    const onlineIds = [];
    for (const [uid, count] of activeUsers.entries()) {
      if (count > 0 && uid && uid !== 'undefined') {
        onlineIds.push(Number(uid));
      }
    }
    if (onlineIds.length > 0) {
      pool.query("UPDATE users SET last_seen = NOW() WHERE id = ANY($1)", [onlineIds])
        .catch(err => console.error("Failed to update last_seen heartbeat:", err.message));
    }
  }, 60000);
  
  return io;
};

const getIO = () => {
  if (!io) {
    throw new Error("Socket.io not initialized!");
  }
  return io;
};

module.exports = { initSocket, getIO };
