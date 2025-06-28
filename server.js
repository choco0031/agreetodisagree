const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    // Mobile optimization settings
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling'],
    allowEIO3: true,
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Game state storage
const lobbies = new Map();
const gameStates = new Map();
const disconnectedPlayers = new Map(); // Track disconnected players for reconnection

// Load topics from file
let debateTopics = [];
try {
    const topicsContent = fs.readFileSync('topics.txt', 'utf8');
    debateTopics = topicsContent.split('\n').map(topic => topic.trim()).filter(topic => topic.length > 0);
    console.log(`Loaded ${debateTopics.length} debate topics`);
} catch (error) {
    console.error('Error loading topics.txt:', error);
    debateTopics = [
        "Social media has done more harm than good to society",
        "Remote work is more productive than office work",
        "Climate change is primarily caused by human activity", 
        "Universal basic income should be implemented globally",
        "Artificial intelligence will eventually replace most human jobs",
        "Video games cause violence in children",
        "Private healthcare is better than public healthcare",
        "Space exploration is a waste of money",
        "Cryptocurrency will replace traditional currency",
        "Online education is as effective as traditional classroom learning"
    ];
}

// Helper function to generate lobby codes
function generateLobbyCode() {
    return Math.random().toString(36).substr(2, 6).toUpperCase();
}

// Helper function to sync game state to a player
function syncGameStateToPlayer(socketId, code) {
    const gameState = gameStates.get(code);
    const lobby = lobbies.get(code);
    
    if (!gameState || !lobby) return;
    
    const socket = io.sockets.sockets.get(socketId);
    if (!socket) return;
    
    // Send current game state
    socket.emit('sync-game-state', {
        gameState: {
            phase: gameState.phase,
            roundNumber: gameState.roundNumber,
            currentTopic: gameState.currentTopic,
            timer: gameState.timer,
            scores: gameState.scores,
            initialVoteResults: gameState.initialVoteResults,
            finalVoteResults: gameState.finalVoteResults,
            currentSpeaker: gameState.currentSpeaker,
            speakerPosition: gameState.speakerPosition
        },
        lobby: lobby,
        userVote: gameState.votes[socket.username],
        userRevote: gameState.revotes[socket.username]
    });
}

// API Routes
app.post('/api/lobby/create', (req, res) => {
    const { username } = req.body;
    
    if (!username || username.length < 2) {
        return res.status(400).json({ error: 'Username must be at least 2 characters' });
    }
    
    const code = generateLobbyCode();
    const lobby = {
        code,
        host: username,
        participants: [{ username, isHost: true, connected: true }],
        createdAt: new Date(),
        gameStarted: false
    };
    
    lobbies.set(code, lobby);
    
    res.json({ code, lobby });
});

app.post('/api/lobby/join', (req, res) => {
    const { code, username } = req.body;
    
    if (!code || !username) {
        return res.status(400).json({ error: 'Code and username are required' });
    }
    
    const lobby = lobbies.get(code);
    if (!lobby) {
        return res.status(404).json({ error: 'Lobby not found' });
    }
    
    // Check if this is a reconnection
    const existingParticipant = lobby.participants.find(p => p.username === username);
    if (existingParticipant) {
        // Allow reconnection
        existingParticipant.connected = true;
        return res.json({ lobby, reconnection: true });
    }
    
    // Add new participant
    lobby.participants.push({ username, isHost: false, connected: true });
    
    // If game is active, initialize score for new player
    const gameState = gameStates.get(code);
    if (gameState) {
        gameState.scores[username] = 0;
        
        // If in voting or revoting phase, allow immediate participation
        if (gameState.phase === 'voting' || gameState.phase === 'revoting') {
            // New player can vote immediately
        }
    }
    
    res.json({ lobby });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    
    socket.on('join-lobby', (data) => {
        const { code, username } = data;
        socket.join(code);
        socket.username = username;
        socket.lobbyCode = code;
        
        const lobby = lobbies.get(code);
        if (lobby) {
            // Update connection status
            const participant = lobby.participants.find(p => p.username === username);
            if (participant) {
                participant.connected = true;
            }
            
            // Check if this is a reconnection during a game
            const gameState = gameStates.get(code);
            if (gameState && gameState.phase !== 'waiting') {
                // Sync current game state to reconnected player
                setTimeout(() => {
                    syncGameStateToPlayer(socket.id, code);
                }, 1000);
            }
            
            io.to(code).emit('lobby-updated', lobby);
            
            // Welcome message for late joiners
            if (gameState && !participant) {
                socket.emit('late-join-welcome', {
                    roundNumber: gameState.roundNumber,
                    currentPhase: gameState.phase,
                    currentTopic: gameState.currentTopic
                });
            }
        }
    });
    
    socket.on('leave-lobby', (data) => {
        const { code, username } = data;
        const lobby = lobbies.get(code);
        const gameState = gameStates.get(code);
        
        if (lobby) {
            // If game is active, just mark as disconnected instead of removing
            if (gameState && gameState.phase !== 'waiting') {
                const participant = lobby.participants.find(p => p.username === username);
                if (participant) {
                    participant.connected = false;
                    disconnectedPlayers.set(username, { code, timestamp: Date.now() });
                }
                io.to(code).emit('lobby-updated', lobby);
            } else {
                // Remove from lobby if game hasn't started
                lobby.participants = lobby.participants.filter(p => p.username !== username);
                
                if (lobby.participants.length === 0 || username === lobby.host) {
                    lobbies.delete(code);
                    gameStates.delete(code);
                    io.to(code).emit('lobby-closed');
                } else {
                    io.to(code).emit('lobby-updated', lobby);
                }
            }
        }
        
        socket.leave(code);
    });
    
    socket.on('start-game', (data) => {
        const { code, username } = data;
        const lobby = lobbies.get(code);
        
        if (lobby && lobby.host === username && lobby.participants.length >= 2) {
            lobby.gameStarted = true;
            
            // Initialize game state
            const gameState = {
                phase: 'voting',
                roundNumber: 1,
                currentTopic: '',
                votes: {},
                revotes: {},
                scores: {},
                usedTopics: [],
                usedSpeakers: [],
                timer: 20,
                timerInterval: null,
                initialVoteResults: { agree: 0, disagree: 0, abstain: 0 },
                finalVoteResults: { agree: 0, disagree: 0, abstain: 0 },
                currentSpeaker: null,
                speakerPosition: null
            };
            
            // Initialize scores
            lobby.participants.forEach(participant => {
                gameState.scores[participant.username] = 0;
            });
            
            gameStates.set(code, gameState);
            
            // Start the game
            io.to(code).emit('game-started', { lobby, gameState });
            
            // Start first voting phase
            setTimeout(() => {
                startVotingPhase(code);
            }, 2000);
        }
    });
    
    socket.on('cast-vote', (data) => {
        const { code, username, vote } = data;
        const gameState = gameStates.get(code);
        
        if (gameState && gameState.phase === 'voting') {
            gameState.votes[username] = vote;
            
            // Check if all connected players have voted
            const lobby = lobbies.get(code);
            const connectedPlayers = lobby.participants.filter(p => p.connected);
            const votedPlayers = Object.keys(gameState.votes);
            
            if (votedPlayers.length >= connectedPlayers.length) {
                // All connected players voted, move to next phase
                if (gameState.timerInterval) {
                    clearInterval(gameState.timerInterval);
                }
                setTimeout(() => {
                    processVoteResults(code);
                }, 1000);
            }
        }
    });
    
    socket.on('cast-revote', (data) => {
        const { code, username, vote } = data;
        const gameState = gameStates.get(code);
        
        if (gameState && gameState.phase === 'revoting') {
            gameState.revotes[username] = vote;
            
            // Check if all connected players have revoted
            const lobby = lobbies.get(code);
            const connectedPlayers = lobby.participants.filter(p => p.connected);
            const revotedPlayers = Object.keys(gameState.revotes);
            
            if (revotedPlayers.length >= connectedPlayers.length) {
                // All connected players revoted, move to results
                if (gameState.timerInterval) {
                    clearInterval(gameState.timerInterval);
                }
                setTimeout(() => {
                    calculateResults(code);
                }, 1000);
            }
        }
    });
    
    socket.on('request-sync', (data) => {
        const { code } = data;
        syncGameStateToPlayer(socket.id, code);
    });
    
    socket.on('restart-game', (data) => {
        const { code } = data;
        const lobby = lobbies.get(code);
        const gameState = gameStates.get(code);
        
        if (lobby && gameState && socket.username === lobby.host) {
            // Reset game state
            gameState.phase = 'voting';
            gameState.roundNumber = 1;
            gameState.currentTopic = '';
            gameState.votes = {};
            gameState.revotes = {};
            gameState.usedTopics = [];
            gameState.usedSpeakers = [];
            gameState.timer = 20;
            gameState.initialVoteResults = { agree: 0, disagree: 0, abstain: 0 };
            gameState.finalVoteResults = { agree: 0, disagree: 0, abstain: 0 };
            gameState.currentSpeaker = null;
            gameState.speakerPosition = null;
            
            // Reset scores
            lobby.participants.forEach(participant => {
                gameState.scores[participant.username] = 0;
            });
            
            if (gameState.timerInterval) {
                clearInterval(gameState.timerInterval);
            }
            
            // Restart the game
            io.to(code).emit('game-started', { lobby, gameState });
            
            setTimeout(() => {
                startVotingPhase(code);
            }, 2000);
        }
    });
    
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        
        if (socket.lobbyCode && socket.username) {
            const lobby = lobbies.get(socket.lobbyCode);
            const gameState = gameStates.get(socket.lobbyCode);
            
            if (lobby) {
                const participant = lobby.participants.find(p => p.username === socket.username);
                
                if (participant) {
                    // Mark as disconnected if game is active
                    if (gameState && gameState.phase !== 'waiting') {
                        participant.connected = false;
                        disconnectedPlayers.set(socket.username, { 
                            code: socket.lobbyCode, 
                            timestamp: Date.now() 
                        });
                        io.to(socket.lobbyCode).emit('lobby-updated', lobby);
                    } else {
                        // Remove if game hasn't started
                        lobby.participants = lobby.participants.filter(p => p.username !== socket.username);
                        
                        if (lobby.participants.length === 0 || socket.username === lobby.host) {
                            if (gameState && gameState.timerInterval) {
                                clearInterval(gameState.timerInterval);
                            }
                            
                            lobbies.delete(socket.lobbyCode);
                            gameStates.delete(socket.lobbyCode);
                            io.to(socket.lobbyCode).emit('lobby-closed');
                        } else {
                            io.to(socket.lobbyCode).emit('lobby-updated', lobby);
                        }
                    }
                }
            }
        }
    });
});

// Clean up old disconnected players periodically
setInterval(() => {
    const now = Date.now();
    const timeout = 5 * 60 * 1000; // 5 minutes
    
    disconnectedPlayers.forEach((data, username) => {
        if (now - data.timestamp > timeout) {
            const lobby = lobbies.get(data.code);
            if (lobby) {
                lobby.participants = lobby.participants.filter(p => p.username !== username);
                io.to(data.code).emit('lobby-updated', lobby);
            }
            disconnectedPlayers.delete(username);
        }
    });
}, 60000); // Check every minute

// Game logic functions
function startVotingPhase(code) {
    const gameState = gameStates.get(code);
    const lobby = lobbies.get(code);
    
    if (!gameState || !lobby) return;
    
    // Select a random topic that hasn't been used
    const availableTopics = debateTopics.filter(topic => !gameState.usedTopics.includes(topic));
    
    if (availableTopics.length === 0) {
        // All topics used, end game
        endGame(code);
        return;
    }
    
    const selectedTopic = availableTopics[Math.floor(Math.random() * availableTopics.length)];
    gameState.currentTopic = selectedTopic;
    gameState.usedTopics.push(selectedTopic);
    
    gameState.phase = 'voting';
    gameState.votes = {};
    gameState.timer = 20;
    
    // Clear any existing timer
    if (gameState.timerInterval) {
        clearInterval(gameState.timerInterval);
    }
    
    io.to(code).emit('topic-selected', { topic: selectedTopic });
    io.to(code).emit('game-phase-update', {
        phase: 'voting',
        roundNumber: gameState.roundNumber
    });
    
    startTimer(code, 20, () => {
        processVoteResults(code);
    });
}

function processVoteResults(code) {
    const gameState = gameStates.get(code);
    const lobby = lobbies.get(code);
    
    if (!gameState || !lobby) return;
    
    // Count votes (only from connected players)
    const voteResults = { agree: 0, disagree: 0, abstain: 0 };
    
    lobby.participants.forEach(participant => {
        if (participant.connected) {
            const vote = gameState.votes[participant.username] || 'abstain';
            voteResults[vote]++;
        }
    });
    
    gameState.initialVoteResults = { ...voteResults };
    
    // Check if either agree OR disagree has 0 votes
    if (voteResults.agree === 0 || voteResults.disagree === 0) {
        // Skip the round immediately
        gameState.phase = 'round-skipped';
        
        io.to(code).emit('game-phase-update', { phase: 'vote-results' });
        io.to(code).emit('vote-results', voteResults);
        
        setTimeout(() => {
            io.to(code).emit('game-phase-update', { phase: 'round-skipped' });
            io.to(code).emit('round-skipped', {
                message: 'Round skipped - everyone voted the same way!',
                initialVotes: voteResults,
                finalVotes: null
            });
            
            setTimeout(() => {
                showScoreboard(code);
            }, 5000);
        }, 3000); // Show vote results for 3 seconds before showing skip message
        
        return;
    }
    
    gameState.phase = 'vote-results';
    io.to(code).emit('game-phase-update', { phase: 'vote-results' });
    io.to(code).emit('vote-results', voteResults);
    
    setTimeout(() => {
        startSoloPhase(code);
    }, 5000);
}

function startSoloPhase(code) {
    const gameState = gameStates.get(code);
    const lobby = lobbies.get(code);
    
    if (!gameState || !lobby) return;
    
    gameState.phase = 'solo';
    gameState.timer = 60;
    
    // Only select from connected players who were present at game start
    const gameStartParticipants = Object.keys(gameState.scores);
    const connectedPlayers = lobby.participants.filter(p => p.connected).map(p => p.username);
    const availableSpeakers = gameStartParticipants
        .filter(username => connectedPlayers.includes(username))
        .filter(username => !gameState.usedSpeakers.includes(username));
    
    if (availableSpeakers.length === 0) {
        // Reset speakers if all have spoken
        gameState.usedSpeakers = [];
    }
    
    const speakers = availableSpeakers.length > 0 ? availableSpeakers : 
                    gameStartParticipants.filter(username => connectedPlayers.includes(username));
    
    if (speakers.length === 0) {
        // No connected players, skip to discussion
        startDiscussionPhase(code);
        return;
    }
    
    const selectedSpeaker = speakers[Math.floor(Math.random() * speakers.length)];
    gameState.usedSpeakers.push(selectedSpeaker);
    gameState.currentSpeaker = selectedSpeaker;
    
    // Get speaker's vote position
    const speakerVote = gameState.votes[selectedSpeaker] || 'abstain';
    gameState.speakerPosition = speakerVote;
    
    io.to(code).emit('game-phase-update', {
        phase: 'solo',
        speaker: selectedSpeaker
    });
    
    io.to(code).emit('speaker-selected', { 
        speaker: selectedSpeaker,
        position: speakerVote
    });
    
    startTimer(code, 60, () => {
        startDiscussionPhase(code);
    });
}

function startDiscussionPhase(code) {
    const gameState = gameStates.get(code);
    
    if (!gameState) return;
    
    gameState.phase = 'discussion';
    gameState.timer = 180; // 3 minutes
    
    io.to(code).emit('game-phase-update', { phase: 'discussion' });
    
    startTimer(code, 180, () => {
        startRevotingPhase(code);
    });
}

function startRevotingPhase(code) {
    const gameState = gameStates.get(code);
    
    if (!gameState) return;
    
    gameState.phase = 'revoting';
    gameState.revotes = {};
    gameState.timer = 20;
    
    io.to(code).emit('game-phase-update', { phase: 'revoting' });
    
    startTimer(code, 20, () => {
        calculateResults(code);
    });
}

function calculateResults(code) {
    const gameState = gameStates.get(code);
    const lobby = lobbies.get(code);
    
    if (!gameState || !lobby) return;
    
    // Count final votes (only from connected players)
    const finalVoteResults = { agree: 0, disagree: 0, abstain: 0 };
    
    lobby.participants.forEach(participant => {
        if (participant.connected) {
            const vote = gameState.revotes[participant.username] || 'abstain';
            finalVoteResults[vote]++;
        }
    });
    
    gameState.finalVoteResults = { ...finalVoteResults };
    
    // Calculate vote changes
    const agreeChange = finalVoteResults.agree - gameState.initialVoteResults.agree;
    const disagreeChange = finalVoteResults.disagree - gameState.initialVoteResults.disagree;
    
    console.log(`Vote changes - Agree: ${agreeChange}, Disagree: ${disagreeChange}`);
    
    // Determine winning team based on which side gained more votes
    let winningTeam = [];
    let pointsPerWinner = 0;
    
    if (agreeChange > disagreeChange) {
        // Agree team wins
        winningTeam = ['agree'];
        pointsPerWinner = agreeChange; // Points = number of votes gained
    } else if (disagreeChange > agreeChange) {
        // Disagree team wins
        winningTeam = ['disagree'];
        pointsPerWinner = disagreeChange; // Points = number of votes gained
    }
    // If agreeChange === disagreeChange, no one wins (including if both are 0)
    
    console.log(`Winning team: ${winningTeam}, Points per winner: ${pointsPerWinner}`);
    
    // Award points to winning team members
    if (winningTeam.length > 0 && pointsPerWinner > 0) {
        lobby.participants.forEach(participant => {
            if (gameState.revotes[participant.username] === winningTeam[0]) {
                gameState.scores[participant.username] += pointsPerWinner;
            }
        });
    }
    
    // Penalize connected players who didn't vote
    lobby.participants.forEach(participant => {
        if (participant.connected && !gameState.revotes[participant.username]) {
            gameState.scores[participant.username] -= 1;
        }
    });
    
    gameState.phase = 'round-results';
    
    io.to(code).emit('game-phase-update', { phase: 'round-results' });
    io.to(code).emit('round-results', {
        initialVotes: gameState.initialVoteResults,
        finalVotes: finalVoteResults,
        winningTeam: winningTeam,
        pointsPerWinner: pointsPerWinner,
        agreeChange,
        disagreeChange
    });
    
    setTimeout(() => {
        showScoreboard(code);
    }, 8000);
}

function showScoreboard(code) {
    const gameState = gameStates.get(code);
    
    if (!gameState) return;
    
    gameState.phase = 'scoreboard';
    
    io.to(code).emit('game-phase-update', { phase: 'scoreboard' });
    io.to(code).emit('scoreboard-update', { scores: gameState.scores });
    
    setTimeout(() => {
        gameState.roundNumber++;
        
        // Check if we should continue or end game
        if (gameState.roundNumber > 5 || gameState.usedTopics.length >= debateTopics.length) {
            endGame(code);
        } else {
            gameState.phase = 'waiting';
            io.to(code).emit('game-phase-update', { phase: 'waiting' });
            
            setTimeout(() => {
                startVotingPhase(code);
            }, 3000);
        }
    }, 5000);
}

function endGame(code) {
    const gameState = gameStates.get(code);
    
    if (!gameState) return;
    
    // Clear timer
    if (gameState.timerInterval) {
        clearInterval(gameState.timerInterval);
    }
    
    io.to(code).emit('game-ended', {
        finalScores: gameState.scores
    });
}

function startTimer(code, seconds, callback) {
    const gameState = gameStates.get(code);
    if (!gameState) return;
    
    gameState.timer = seconds;
    
    // Clear any existing timer
    if (gameState.timerInterval) {
        clearInterval(gameState.timerInterval);
    }
    
    gameState.timerInterval = setInterval(() => {
        gameState.timer--;
        io.to(code).emit('game-timer', { timeRemaining: gameState.timer });
        
        if (gameState.timer <= 0) {
            clearInterval(gameState.timerInterval);
            gameState.timerInterval = null;
            callback();
        }
    }, 1000);
}

// Serve the main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('Make sure to create a topics.txt file with debate topics (one per line)');
});
