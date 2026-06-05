const { Server } = require("socket.io");
const pool = require('./db');

let io;
const activeUsers = new Map();
// Track active voice sessions: groupId -> Map<socketId, { userName, userId }>
const activeVoiceSessions = new Map();
// Track active video sessions: groupId -> Map<socketId, { userName, userId }>
const activeVideoSessions = new Map();
// Track active Pomodoro sessions: groupId -> { duration, timeLeft, isRunning, phase, intervalId }
const activePomodoroSessions = new Map();

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

    // Global synchronization events
    socket.join('global_notifications');
    
    socket.on("group_update", () => {
      socket.broadcast.emit("refresh_groups");
    });

    socket.on("group_member_update", (data) => {
      socket.broadcast.emit("refresh_group_members", data);
      socket.broadcast.emit("refresh_groups");
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

    // --- Video Call Tracking for Groups ---
    const broadcastVideoCallStatus = (groupId, groupName) => {
        const key = String(groupId);
        const session = activeVideoSessions.get(key);
        if (session && session.size > 0) {
            const participants = Array.from(session.values());
            io.to(groupName).emit("group_video_active", {
                groupId: key,
                groupName,
                participants
            });
        } else {
            io.to(groupName).emit("group_video_ended", { groupId: key, groupName });
            activeVideoSessions.delete(key);
        }
    };

    socket.on("join_group_video", (data) => {
        // data: { groupId, userId, userName, groupName }
        socket._videoGroupId = String(data.groupId);
        socket._videoGroupName = data.groupName;
        
        const key = String(data.groupId);
        if (!activeVideoSessions.has(key)) {
            activeVideoSessions.set(key, new Map());
        }
        activeVideoSessions.get(key).set(socket.id, {
            userName: data.userName,
            userId: data.userId
        });
        broadcastVideoCallStatus(key, data.groupName);
    });

    socket.on("leave_group_video", (data) => {
        // data: { groupId, groupName }
        const key = String(data.groupId);
        const session = activeVideoSessions.get(key);
        if (session) {
            session.delete(socket.id);
            if (session.size === 0) activeVideoSessions.delete(key);
        }
        delete socket._videoGroupId;
        delete socket._videoGroupName;
        broadcastVideoCallStatus(key, data.groupName);
    });

    socket.on("check_active_video_call", (data) => {
        // data: { groupId, groupName }
        const key = String(data.groupId);
        const session = activeVideoSessions.get(key);
        if (session && session.size > 0) {
            const participants = Array.from(session.values());
            socket.emit("group_video_active", {
                groupId: key,
                groupName: data.groupName,
                participants
            });
        }
    });

    // --- Group Pomodoro Timer ---
    socket.on("start_group_pomodoro", (data) => {
        // data: { groupId, groupName, duration (in minutes, e.g. 25/45/60) }
        const key = String(data.groupId);
        // Clear any existing session
        const existing = activePomodoroSessions.get(key);
        if (existing && existing.intervalId) clearInterval(existing.intervalId);

        const durationSecs = (data.duration || 25) * 60;
        const session = {
            duration: durationSecs,
            timeLeft: durationSecs,
            isRunning: true,
            phase: 'study', // 'study' or 'break'
            groupName: data.groupName,
            startedBy: data.userName || 'Someone',
            isStrict: data.isStrict || false,
            intervalId: null
        };

        session.intervalId = setInterval(() => {
            session.timeLeft -= 1;
            if (session.timeLeft <= 0) {
                clearInterval(session.intervalId);
                session.isRunning = false;
                // Switch phase
                if (session.phase === 'study') {
                    session.phase = 'break';
                    session.timeLeft = 5 * 60; // 5 minute break
                    session.isRunning = true;
                    session.intervalId = setInterval(() => {
                        session.timeLeft -= 1;
                        if (session.timeLeft <= 0) {
                            clearInterval(session.intervalId);
                            session.isRunning = false;
                            activePomodoroSessions.delete(key);
                            io.to(data.groupName).emit("group_pomodoro_ended", { groupId: key });
                        } else {
                            io.to(data.groupName).emit("group_pomodoro_tick", {
                                groupId: key,
                                timeLeft: session.timeLeft,
                                phase: session.phase,
                                isRunning: session.isRunning,
                                isStrict: session.isStrict
                            });
                        }
                    }, 1000);
                } else {
                    activePomodoroSessions.delete(key);
                    io.to(data.groupName).emit("group_pomodoro_ended", { groupId: key });
                }
            }
            io.to(data.groupName).emit("group_pomodoro_tick", {
                groupId: key,
                timeLeft: session.timeLeft,
                duration: session.duration,
                phase: session.phase,
                isRunning: session.isRunning,
                isStrict: session.isStrict
            });
        }, 1000);

        activePomodoroSessions.set(key, session);
        io.to(data.groupName).emit("group_pomodoro_started", {
            groupId: key,
            duration: session.duration,
            timeLeft: session.timeLeft,
            phase: session.phase,
            startedBy: session.startedBy,
            isStrict: session.isStrict
        });
    });

    socket.on("stop_group_pomodoro", (data) => {
        const key = String(data.groupId);
        const session = activePomodoroSessions.get(key);
        if (session) {
            if (session.intervalId) clearInterval(session.intervalId);
            activePomodoroSessions.delete(key);
        }
        io.to(data.groupName).emit("group_pomodoro_ended", { groupId: key });
    });

    socket.on("check_group_pomodoro", (data) => {
        const key = String(data.groupId);
        const session = activePomodoroSessions.get(key);
        if (session && session.isRunning) {
            socket.emit("group_pomodoro_tick", {
                groupId: key,
                timeLeft: session.timeLeft,
                duration: session.duration,
                phase: session.phase,
                isRunning: session.isRunning,
                isStrict: session.isStrict
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

      // Clean up video session tracking on disconnect
      const videoGroupId = socket._videoGroupId;
      const videoGroupName = socket._videoGroupName;
      if (videoGroupId) {
          const key = String(videoGroupId);
          const session = activeVideoSessions.get(key);
          if (session) {
              session.delete(socket.id);
              if (session.size === 0) activeVideoSessions.delete(key);
          }
          if (videoGroupName) {
              broadcastVideoCallStatus(key, videoGroupName);
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
