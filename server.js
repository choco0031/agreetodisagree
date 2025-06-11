const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Middleware
app.use(express.json());
app.use(express.static('public')); // Serve your HTML file from public folder

// Game state storage
const lobbies = new Map();
const gameStates = new Map();

// Load topics from file
let debateTopics = [];
try {
    const topicsContent = fs.readFileSync('topics.txt', 'utf8');
    debateTopics = topicsContent.split('\n').map(topic => topic.trim()).filter(topic => topic.length > 0);
    console.log(`Loaded ${debateTopics.length} debate topics`);
} catch (error) {
    console.error('Error loading topics.txt:', error);
    // Fallback topics if file doesn't exist
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
        participants: [{ username, isHost: true }],
        createdAt: new Date()
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
    
    // Check if username already exists
    if (lobby.participants.some(p => p.username === username)) {
        return res.status(400).json({ error: 'Username already taken in this lobby' });
    }
    
    lobby.participants.push({ username, isHost: false });
    
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
            io.to(code).emit('lobby-updated', lobby);
        }
    });
    
    socket.on('leave-lobby', (data) => {
        const { code, username } = data;
        const lobby = lobbies.get(code);
        
        if (lobby) {
            lobby.participants = lobby.participants.filter(p => p.username !== username);
            
            if (lobby.participants.length === 0 || username === lobby.host) {
                // Close lobby if empty or host leaves
                lobbies.delete(code);
                gameStates.delete(code);
                io.to(code).emit('lobby-closed');
            } else {
                io.to(code).emit('lobby-updated', lobby);
            }
        }
        
        socket.leave(code);
    });
    
    socket.on('start-game', (data) => {
        const { code, username } = data;
        const lobby = lobbies.get(code);
        
        if (lobby && lobby.host === username && lobby.participants.length >= 2) {
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
                finalVoteResults: { agree: 0, disagree: 0, abstain: 0 }
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
            
            // Check if all players have voted
            const lobby = lobbies.get(code);
            if (lobby && Object.keys(gameState.votes).length === lobby.participants.length) {
                // All voted, move to next phase faster
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
            
            // Check if all players have revoted
            const lobby = lobbies.get(code);
            if (lobby && Object.keys(gameState.revotes).length === lobby.participants.length) {
                // All revoted, move to results faster
                if (gameState.timerInterval) {
                    clearInterval(gameState.timerInterval);
                }
                setTimeout(() => {
                    calculateResults(code);
                }, 1000);
            }
        }
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
            
            if (lobby) {
                lobby.participants = lobby.participants.filter(p => p.username !== socket.username);
                
                if (lobby.participants.length === 0 || socket.username === lobby.host) {
                    // Clean up game state
                    const gameState = gameStates.get(socket.lobbyCode);
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
    });
});

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
    
    // Count votes
    const voteResults = { agree: 0, disagree: 0, abstain: 0 };
    
    lobby.participants.forEach(participant => {
        const vote = gameState.votes[participant.username] || 'abstain';
        voteResults[vote]++;
    });
    
    gameState.initialVoteResults = { ...voteResults };
    
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
    gameState.timer = 120; // 2 minutes
    
    // Select random speaker who hasn't spoken yet
    const availableSpeakers = lobby.participants
        .map(p => p.username)
        .filter(username => !gameState.usedSpeakers.includes(username));
    
    if (availableSpeakers.length === 0) {
        // Reset speakers if all have spoken
        gameState.usedSpeakers = [];
    }
    
    const speakers = availableSpeakers.length > 0 ? availableSpeakers : lobby.participants.map(p => p.username);
    const selectedSpeaker = speakers[Math.floor(Math.random() * speakers.length)];
    gameState.usedSpeakers.push(selectedSpeaker);
    
    // Get speaker's vote position
    const speakerVote = gameState.votes[selectedSpeaker] || 'abstain';
    
    io.to(code).emit('game-phase-update', {
        phase: 'solo',
        speaker: selectedSpeaker
    });
    
    io.to(code).emit('speaker-selected', { 
        speaker: selectedSpeaker,
        position: speakerVote
    });
    
    startTimer(code, 120, () => {
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
    
    // Count final votes
    const finalVoteResults = { agree: 0, disagree: 0, abstain: 0 };
    
    lobby.participants.forEach(participant => {
        const vote = gameState.revotes[participant.username] || 'abstain';
        finalVoteResults[vote]++;
    });
    
    gameState.finalVoteResults = { ...finalVoteResults };
    
    // Calculate vote changes
    const agreeChange = finalVoteResults.agree - gameState.initialVoteResults.agree;
    const disagreeChange = finalVoteResults.disagree - gameState.initialVoteResults.disagree;
    
    // Determine winning team
    let winningTeam = '';
    let winningPlayers = [];
    
    if (agreeChange > disagreeChange) {
        winningTeam = 'agree';
        winningPlayers = lobby.participants
            .filter(p => gameState.revotes[p.username] === 'agree')
            .map(p => p.username);
    } else if (disagreeChange > agreeChange) {
        winningTeam = 'disagree';
        winningPlayers = lobby.participants
            .filter(p => gameState.revotes[p.username] === 'disagree')
            .map(p => p.username);
    }
    
    // Award points
    const pointsAwarded = Math.abs(agreeChange - disagreeChange);
    
    if (winningPlayers.length > 0) {
        winningPlayers.forEach(username => {
            gameState.scores[username] += pointsAwarded;
        });
    }
    
    // Penalize players who didn't vote in final round
    lobby.participants.forEach(participant => {
        if (!gameState.revotes[participant.username]) {
            gameState.scores[participant.username] -= 1;
        }
    });
    
    gameState.phase = 'round-results';
    
    io.to(code).emit('game-phase-update', { phase: 'round-results' });
    io.to(code).emit('round-results', {
        initialVotes: gameState.initialVoteResults,
        finalVotes: finalVoteResults,
        winningTeam: winningPlayers,
        pointsAwarded,
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