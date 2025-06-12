# agreetodisagree
Agreetodisagree is a real-time multiplayer web game where players join lobbies to debate controversial topics.

Game was created over the thought of discord events, that encourages people to talk and speak about their opinion. 
Time limits are preset on the backend which is editable by code. 
Game is perfect for temporary events, with no database required, no sign up, no log in. 

1. Backend (Server-side)

Node.js - JavaScript runtime for the server
Express.js - Web framework for handling HTTP requests
Socket.io - Real-time bidirectional communication
File System (fs) - Reading topic files

2. Frontend (Client-side)

HTML - Structure and content
CSS - Styling and animations
Vanilla JavaScript - Game logic and interactions
Socket.io Client - Real-time communication with server

Why socket.io ? 
You ←→ Always Connected ←→ Server ←→ Other Players
Like being on a conference call

Game State Management
The server keeps track of everything in memory using Maps (like super-organized filing cabinets)

Event-Driven Programming
Instead of constantly asking "did something happen?", the code waits for events

Each phase:
  Voting (20s) - Players vote on topic
  Vote Results (5s) - Show initial vote breakdown
  Solo (60s) - One player shares opinion
  Discussion (3min) - Open group discussion
  Revoting (20s) - Final vote after discussion
  Round Results (8s) - Show vote changes and winners
  Scoreboard (5s) - Show current scores
  Waiting (3s) - Brief pause before next round

Architecture
  Advantages:
  Real-time - Instant updates for all players
  Scalable - Can handle multiple games simultaneously
  Stateful - Server remembers everything about each game
  Interactive - Rich user interface with animations
  
  Trade-offs:
  Memory-only - Data lost on server restart
  Single server - All games run on one machine
  No persistence - No database storage
