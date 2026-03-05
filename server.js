const express = require('express');
const { Server } = require('socket.io');
const http = require('http');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3334;
const RELAY_URL = process.env.RELAY_URL || `http://localhost:${PORT}`;

// rooms[roomCode] = { hostSocketId, sessionId, hostName, gridState, players: { socketId: { username, avatarId, profilePictureUrl } } }
const rooms = {};

// ── HTTP ──────────────────────────────────────────────────────────────────────

// Serve the game page - replaces %%RELAY_URL%% and %%ROOM_CODE%% in game.html
app.get('/game/:code', (req, res) => {
    const code = req.params.code.toUpperCase();
    const templatePath = path.join(__dirname, 'game.html');
    if (!fs.existsSync(templatePath)) {
        return res.status(500).send('game.html not found');
    }
    const html = fs.readFileSync(templatePath, 'utf8')
        .replace(/%%RELAY_URL%%/g, RELAY_URL)
        .replace(/%%ROOM_CODE%%/g, code);
    res.send(html);
});

// Health check
app.get('/ping', (req, res) => res.json({ ok: true, rooms: Object.keys(rooms).length }));

// ── SOCKET.IO ─────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
    const { room, role } = socket.handshake.query;
    if (!room) { socket.disconnect(); return; }

    const roomCode = room.toUpperCase();
    socket.data.roomCode = roomCode;
    socket.data.role = role;

    // ── HOST ──────────────────────────────────────────────────────────────────
    if (role === 'host') {
        if (!rooms[roomCode]) {
            rooms[roomCode] = {
                hostSocketId: socket.id,
                sessionId: Date.now().toString(),
                hostName: 'Host',
                gridState: null,
                players: {}
            };
        } else {
            // Reconnecting host takes over
            rooms[roomCode].hostSocketId = socket.id;
        }

        socket.join(roomCode);
        console.log(`[Relay] Host joined room ${roomCode} (${socket.id})`);
        socket.emit('room-ready', { roomCode, sessionId: rooms[roomCode].sessionId });

        // Host sends metadata
        socket.on('host-set-info', ({ hostName, sessionId }) => {
            if (!rooms[roomCode]) return;
            if (hostName) rooms[roomCode].hostName = hostName;
            if (sessionId) rooms[roomCode].sessionId = sessionId;
            // Push updated host-info to all current players
            socket.to(roomCode).emit('host-info', { hostName: rooms[roomCode].hostName });
        });

        // Host broadcasts to all players in room
        socket.on('host-broadcast', ({ event, data }) => {
            if (!rooms[roomCode]) return;
            // Cache grid state so late-joining players get it immediately
            if (event === 'grid-update') rooms[roomCode].gridState = data;
            socket.to(roomCode).emit(event, data);
        });

        socket.on('disconnect', () => {
            console.log(`[Relay] Host left room ${roomCode}`);
            if (rooms[roomCode] && rooms[roomCode].hostSocketId === socket.id) {
                // Tell all players the session ended
                io.to(roomCode).emit('clear-session');
                delete rooms[roomCode];
            }
        });

    // ── PLAYER ────────────────────────────────────────────────────────────────
    } else {
        const roomData = rooms[roomCode];
        if (!roomData) {
            socket.emit('room-not-found');
            socket.disconnect();
            return;
        }

        socket.join(roomCode);
        console.log(`[Relay] Player joined room ${roomCode} (${socket.id})`);

        // Send initial state
        socket.emit('session-id', { sessionId: roomData.sessionId });
        socket.emit('host-info', { hostName: roomData.hostName });
        if (roomData.gridState) socket.emit('grid-update', roomData.gridState);

        // Player announces themselves
        socket.on('join', (data) => {
            if (!rooms[roomCode]) return;
            rooms[roomCode].players[socket.id] = {
                username: data.username,
                avatarId: data.avatarId,
                profilePictureUrl: data.profilePictureUrl || ''
            };
            const playerList = Object.values(rooms[roomCode].players);

            // Tell all players (incl. this one) the updated roster
            io.to(roomCode).emit('active-players', playerList);
            // Tell host with full list for their sidebar
            io.to(rooms[roomCode].hostSocketId).emit('active-players-update', playerList);
            // Tell host about the new player specifically (so Electron fires join sound etc.)
            io.to(rooms[roomCode].hostSocketId).emit('player-joined', data);
        });

        // Player submits a word coordinate guess
        socket.on('guess', (data) => {
            if (!rooms[roomCode]) return;
            io.to(rooms[roomCode].hostSocketId).emit('player-guess', data);
        });

        // Player fires a stall effect at another player
        socket.on('use-effect', (data) => {
            if (!rooms[roomCode]) return;
            io.to(rooms[roomCode].hostSocketId).emit('player-use-effect', data);
            // Also relay the stall to all clients so the targeted player sees it
            io.to(roomCode).emit('stall-effect', { target: data.target, effect: data.effect });
        });

        socket.on('disconnect', () => {
            if (!rooms[roomCode]) return;
            const p = rooms[roomCode].players[socket.id];
            if (p) {
                console.log(`[Relay] Player ${p.username} left room ${roomCode}`);
                delete rooms[roomCode].players[socket.id];
                const playerList = Object.values(rooms[roomCode].players);
                io.to(roomCode).emit('active-players', playerList);
                io.to(rooms[roomCode].hostSocketId).emit('active-players-update', playerList);
                io.to(rooms[roomCode].hostSocketId).emit('player-left', { username: p.username });
            }
        });
    }
});

server.listen(PORT, () => console.log(`[Relay] Running on port ${PORT} — RELAY_URL: ${RELAY_URL}`));
