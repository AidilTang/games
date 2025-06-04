const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.use(express.static(path.join(__dirname, 'public')));

class GameRoom {
    constructor(roomCode) {
        this.roomCode = roomCode;
        this.players = [];
        this.gameState = { players: [], currentPlayer: 0, treasury: 50, courtDeck: [], pendingAction: null, gamePhase: 'lobby', revealedCards: [], gameEnded: false };
        this.host = null;
        this.turnTimer = null;
        this.challengeTimer = null;
        this.CHARACTERS = ['Duke', 'Assassin', 'Captain', 'Ambassador', 'Contessa'];
        this.TURN_TIME_LIMIT = 60000;
        this.CHALLENGE_TIME_LIMIT = 30000;
        this.exchangeCards = null;
        this.pendingInfluenceLossCallback = null;
    }

    addPlayer(socket, playerName) {
        if (this.players.length >= 6) return { success: false, message: 'Room is full' };
        
        const player = { id: socket.id, name: playerName || `Player ${this.players.length + 1}`, socket: socket, isHost: this.players.length === 0, isAlive: true, coins: 2, influence: [], revealedCards: [] };
        this.players.push(player);
        
        if (player.isHost) this.host = player;
        this.broadcastPlayersUpdate();
        return { success: true, isHost: player.isHost };
    }

    removePlayer(socketId) {
        const playerIndex = this.players.findIndex(p => p.id === socketId);
        if (playerIndex === -1) return;

        const wasHost = this.players[playerIndex].isHost;
        this.players.splice(playerIndex, 1);

        if (wasHost && this.players.length > 0) {
            this.players[0].isHost = true;
            this.host = this.players[0];
        }

        if (this.players.length === 0) {
            this.cleanup();
        } else {
            this.broadcastPlayersUpdate();
            if (this.gameState.gamePhase === 'playing') this.handlePlayerDisconnect(socketId);
        }
    }

    broadcastPlayersUpdate() {
        const playerList = this.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost }));
        this.players.forEach(player => player.socket.emit('playersUpdated', { players: playerList }));
    }

    startGame() {
        if (this.players.length < 2 || this.players.length > 6) return { success: false, message: 'Need 2-6 players to start' };
        
        this.gameState.gamePhase = 'playing';
        this.initializeGame();
        this.players.forEach(player => player.socket.emit('gameStarted', { gameState: this.getPublicGameState(player.id) }));
        this.startTurnTimer();
        this.broadcastGameState();
        this.broadcastLog('Game started!');
        return { success: true };
    }

    initializeGame() {
        this.gameState.courtDeck = this.createDeck();
        this.gameState.players = this.players.map((player, index) => ({
            id: player.id, name: player.name, coins: index === 0 && this.players.length === 2 ? 1 : 2,
            influence: [this.gameState.courtDeck.pop(), this.gameState.courtDeck.pop()], revealedCards: [], isAlive: true
        }));
        this.gameState.treasury = 50 - (this.players.length * 2) + (this.players.length === 2 ? 1 : 0);
        this.gameState.currentPlayer = 0;
        this.gameState.gameEnded = false;
    }

    createDeck() {
        const deck = [];
        this.CHARACTERS.forEach(char => { for (let i = 0; i < 3; i++) deck.push(char); });
        return this.shuffleDeck(deck);
    }

    shuffleDeck(deck) {
        for (let i = deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [deck[i], deck[j]] = [deck[j], deck[i]];
        }
        return deck;
    }

    performAction(playerId, action) {
        if (this.gameState.gameEnded) return { success: false, message: 'Game has ended' };
        
        const currentPlayer = this.gameState.players[this.gameState.currentPlayer];
        if (!currentPlayer || currentPlayer.id !== playerId) return { success: false, message: 'Not your turn' };
        if (!currentPlayer.isAlive) return { success: false, message: 'Player is not alive' };

        if (action === 'coup' && currentPlayer.coins < 7) return { success: false, message: 'Not enough coins for coup' };
        if (action === 'assassinate' && currentPlayer.coins < 3) return { success: false, message: 'Not enough coins for assassination' };
        if (currentPlayer.coins >= 10 && action !== 'coup') return { success: false, message: 'Must coup with 10+ coins' };

        this.clearTurnTimer();
        this.gameState.pendingAction = { type: action, player: this.gameState.currentPlayer, challenged: false, blocked: false };
        this.broadcastLog(`${currentPlayer.name} attempts ${action}`);

        if (['coup', 'assassinate', 'steal'].includes(action)) {
            const validTargets = this.gameState.players.filter(p => p.id !== playerId && p.isAlive);
            if (validTargets.length === 0) {
                this.gameState.pendingAction = null;
                return { success: false, message: 'No valid targets' };
            }
            
            const playerSocket = this.getPlayerSocket(playerId);
            if (!playerSocket) {
                this.gameState.pendingAction = null;
                return { success: false, message: 'Connection error' };
            }
            
            playerSocket.emit('actionRequired', { type: 'selectTarget', validTargets: validTargets.map(p => ({ id: p.id, name: p.name })), action: action });
            return { success: true };
        }

        if (['foreignAid', 'tax', 'assassinate', 'steal', 'exchange'].includes(action)) {
            this.startChallengePhase();
        } else {
            this.resolveAction();
        }
        return { success: true };
    }

    selectTarget(playerId, targetId) {
        if (!this.gameState.pendingAction || this.gameState.pendingAction.player !== this.gameState.currentPlayer) return { success: false, message: 'Invalid state' };

        const targetIndex = this.gameState.players.findIndex(p => p.id === targetId);
        if (targetIndex === -1) return { success: false, message: 'Target not found' };

        const target = this.gameState.players[targetIndex];
        if (!target.isAlive) return { success: false, message: 'Target is not alive' };

        this.gameState.pendingAction.target = targetIndex;
        
        if (['assassinate', 'steal'].includes(this.gameState.pendingAction.type)) {
            this.startChallengePhase();
        } else {
            this.resolveAction();
        }
        return { success: true };
    }

    startChallengePhase() {
        const action = this.gameState.pendingAction.type;
        const characterActions = ['tax', 'assassinate', 'steal', 'exchange'];
        const currentPlayerId = this.gameState.players[this.gameState.currentPlayer].id;
        
        this.clearChallengeTimer();

        let challengeData = { action: action, canChallenge: characterActions.includes(action), canBlock: false, eligiblePlayers: [], blockingPlayer: null, blockOptions: [], challengePhase: 'action' };

        if (challengeData.canChallenge) {
            challengeData.eligiblePlayers = this.gameState.players.filter(p => p.id !== currentPlayerId && p.isAlive).map(p => p.id);
        }

        if (action === 'foreignAid') {
            challengeData.canBlock = true;
            challengeData.blockOptions = ['Duke'];
            challengeData.eligiblePlayers = this.gameState.players.filter(p => p.id !== currentPlayerId && p.isAlive).map(p => p.id);
        } else if (action === 'assassinate' && this.gameState.pendingAction.target !== undefined) {
            const targetPlayer = this.gameState.players[this.gameState.pendingAction.target];
            challengeData.canBlock = true;
            challengeData.blockingPlayer = targetPlayer.id;
            challengeData.blockOptions = ['Contessa'];
            challengeData.eligiblePlayers = challengeData.eligiblePlayers.filter(id => id === targetPlayer.id);
        } else if (action === 'steal' && this.gameState.pendingAction.target !== undefined) {
            const targetPlayer = this.gameState.players[this.gameState.pendingAction.target];
            challengeData.canBlock = true;
            challengeData.blockingPlayer = targetPlayer.id;
            challengeData.blockOptions = ['Ambassador', 'Captain'];
            challengeData.eligiblePlayers = challengeData.eligiblePlayers.filter(id => id === targetPlayer.id);
        }

        this.players.forEach(player => {
            if (player.isAlive && player.id !== currentPlayerId) {
                const playerCanAct = challengeData.eligiblePlayers.includes(player.id);
                player.socket.emit('challengePhase', {
                    ...challengeData,
                    canChallenge: challengeData.canChallenge && playerCanAct,
                    canBlock: challengeData.canBlock && (!challengeData.blockingPlayer || challengeData.blockingPlayer === player.id)
                });
            } else if (player.id === currentPlayerId) {
                player.socket.emit('waitingForResponse', { action: action, message: `Waiting for other players to respond to your ${action}...` });
            }
        });

        this.startChallengeTimer();
    }

    challengeAction(challengerId) {
        const challenger = this.gameState.players.find(p => p.id === challengerId);
        if (!challenger || !this.gameState.pendingAction) return;
        
        this.clearChallengeTimer();
        this.players.forEach(player => {
            try {
                player.socket.emit('hideWaiting');
            } catch (error) {
                console.error(`Error sending hideWaiting to player ${player.id}:`, error);
            }
        });
        
        if (this.gameState.pendingAction.blocker) {
            const blocker = this.gameState.players.find(p => p.id === this.gameState.pendingAction.blocker);
            const blockingCard = this.gameState.pendingAction.blockingCard;
            
            if (!blocker || !blockingCard) return;
            
            this.broadcastLog(`${challenger.name} challenges ${blocker.name}'s block (${blockingCard})`);
            
            const hasBlockingCard = blocker.influence.includes(blockingCard);
            
            if (hasBlockingCard) {
                this.broadcastLog(`${blocker.name} reveals ${blockingCard} and wins the challenge!`);
                this.handleInfluenceLoss(challengerId, () => {
                    const cardIndex = blocker.influence.indexOf(blockingCard);
                    if (cardIndex !== -1) {
                        blocker.influence.splice(cardIndex, 1);
                        this.gameState.courtDeck.push(blockingCard);
                        this.gameState.courtDeck = this.shuffleDeck(this.gameState.courtDeck);
                        if (this.gameState.courtDeck.length > 0) blocker.influence.push(this.gameState.courtDeck.pop());
                    }
                    this.broadcastLog(`Block successful! ${this.gameState.pendingAction.type} is blocked.`);
                    this.gameState.pendingAction = null;
                    this.nextTurn();
                });
            } else {
                this.broadcastLog(`${blocker.name} cannot show ${blockingCard} and loses the challenge!`);
                this.handleInfluenceLoss(this.gameState.pendingAction.blocker, () => {
                    this.gameState.pendingAction.blocker = null;
                    this.gameState.pendingAction.blocked = false;
                    this.resolveAction();
                });
            }
        } else {
            const actor = this.gameState.players[this.gameState.pendingAction.player];
            if (!actor) return;
            
            this.broadcastLog(`${challenger.name} challenges ${actor.name}'s ${this.gameState.pendingAction.type}`);
            
            const requiredCard = this.getRequiredCard(this.gameState.pendingAction.type);
            if (!requiredCard) return;
            
            const hasCard = actor.influence.includes(requiredCard);
            
            if (hasCard) {
                this.broadcastLog(`${actor.name} reveals ${requiredCard} and wins the challenge!`);
                this.handleInfluenceLoss(challengerId, () => {
                    const cardIndex = actor.influence.indexOf(requiredCard);
                    if (cardIndex !== -1) {
                        actor.influence.splice(cardIndex, 1);
                        this.gameState.courtDeck.push(requiredCard);
                        this.gameState.courtDeck = this.shuffleDeck(this.gameState.courtDeck);
                        if (this.gameState.courtDeck.length > 0) actor.influence.push(this.gameState.courtDeck.pop());
                    }
                    this.resolveAction();
                });
            } else {
                this.broadcastLog(`${actor.name} cannot show ${requiredCard} and loses the challenge!`);
                this.handleInfluenceLoss(actor.id, () => {
                    this.gameState.pendingAction = null;
                    this.nextTurn();
                });
            }
        }
    }

    blockAction(blockerId, blockingCard) {
        const blocker = this.gameState.players.find(p => p.id === blockerId);
        if (!blocker || !this.gameState.pendingAction || !blockingCard) return;
        
        const action = this.gameState.pendingAction.type;
        const validBlocks = { 'foreignAid': ['Duke'], 'assassinate': ['Contessa'], 'steal': ['Ambassador', 'Captain'] };
        
        if (!validBlocks[action] || !validBlocks[action].includes(blockingCard)) return;
        
        this.clearChallengeTimer();
        this.players.forEach(player => {
            try {
                player.socket.emit('hideWaiting');
            } catch (error) {
                console.error(`Error sending hideWaiting to player ${player.id}:`, error);
            }
        });
        this.broadcastLog(`${blocker.name} attempts to block with ${blockingCard}`);
        
        this.gameState.pendingAction.blocker = blockerId;
        this.gameState.pendingAction.blockingCard = blockingCard;
        this.gameState.pendingAction.blocked = true;
        
        this.startBlockChallengePhase();
    }

    startBlockChallengePhase() {
        const blockerId = this.gameState.pendingAction.blocker;
        const blockingCard = this.gameState.pendingAction.blockingCard;
        const actingPlayerId = this.gameState.players[this.gameState.pendingAction.player].id;
        
        this.clearChallengeTimer();

        const challengeData = {
            action: 'blockChallenge', canChallenge: true, canBlock: false,
            eligiblePlayers: this.gameState.players.filter(p => p.id !== blockerId && p.isAlive).map(p => p.id),
            blockingCard: blockingCard, blocker: this.gameState.players.find(p => p.id === blockerId).name, challengePhase: 'block'
        };

        this.players.forEach(player => {
            if (player.isAlive) {
                if (player.id === actingPlayerId) {
                    player.socket.emit('challengePhase', { ...challengeData, canChallenge: true, canBlock: false });
                } else if (player.id === blockerId) {
                    player.socket.emit('waitingForResponse', { action: 'blockChallenge', message: `Waiting for response to your ${blockingCard} block...` });
                } else {
                    player.socket.emit('challengePhase', { ...challengeData, canChallenge: true, canBlock: false });
                }
            }
        });

        this.startChallengeTimer();
    }

    allowAction() {
        if (!this.gameState.pendingAction) return;

        this.clearChallengeTimer();
        this.players.forEach(player => {
            try {
                player.socket.emit('hideWaiting');
            } catch (error) {
                console.error(`Error sending hideWaiting to player ${player.id}:`, error);
            }
        });
        
        if (this.gameState.pendingAction && this.gameState.pendingAction.blocker) {
            this.broadcastLog(`Block successful! ${this.gameState.pendingAction.type} is blocked.`);
            this.gameState.pendingAction = null;
            this.nextTurn();
        } else {
            this.resolveAction();
        }
    }

    resolveAction() {
        if (!this.gameState.pendingAction || this.gameState.gameEnded) return;

        const action = this.gameState.pendingAction;
        const actor = this.gameState.players[action.player];
        if (!actor) { this.gameState.pendingAction = null; return; }

        switch (action.type) {
            case 'income':
                actor.coins += 1;
                this.gameState.treasury = Math.max(0, this.gameState.treasury - 1);
                this.broadcastLog(`${actor.name} takes 1 coin (Income)`);
                break;

            case 'foreignAid':
                actor.coins += 2;
                this.gameState.treasury = Math.max(0, this.gameState.treasury - 2);
                this.broadcastLog(`${actor.name} takes 2 coins (Foreign Aid)`);
                break;

            case 'coup': {
                actor.coins -= 7;
                this.gameState.treasury += 7;
                const coupTarget = this.gameState.players[action.target];
                if (!coupTarget) { this.gameState.pendingAction = null; return; }
                this.broadcastLog(`${actor.name} launches coup against ${coupTarget.name}`);
                this.handleInfluenceLoss(coupTarget.id, () => { this.gameState.pendingAction = null; this.nextTurn(); });
                return;
            }

            case 'tax':
                actor.coins += 3;
                this.gameState.treasury = Math.max(0, this.gameState.treasury - 3);
                this.broadcastLog(`${actor.name} takes 3 coins (Tax - Duke)`);
                break;

            case 'assassinate': {
                actor.coins -= 3;
                this.gameState.treasury += 3;
                const assassinTarget = this.gameState.players[action.target];
                if (!assassinTarget) { this.gameState.pendingAction = null; return; }
                this.broadcastLog(`${actor.name} assassinates ${assassinTarget.name}`);
                this.handleInfluenceLoss(assassinTarget.id, () => { this.gameState.pendingAction = null; this.nextTurn(); });
                return;
            }

            case 'steal': {
                const stealTarget = this.gameState.players[action.target];
                if (!stealTarget) break;
                const coinsToSteal = Math.min(2, stealTarget.coins);
                actor.coins += coinsToSteal;
                stealTarget.coins -= coinsToSteal;
                this.broadcastLog(`${actor.name} steals ${coinsToSteal} coins from ${stealTarget.name}`);
                break;
            }

            case 'exchange':
                if (this.gameState.courtDeck.length < 2) { this.broadcastLog(`Not enough cards in deck for exchange`); break; }
                const drawnCards = [this.gameState.courtDeck.pop(), this.gameState.courtDeck.pop()];
                const allCards = [...actor.influence, ...drawnCards];
                this.exchangeCards = allCards;
                this.getPlayerSocket(actor.id).emit('actionRequired', { type: 'selectCards', cards: allCards, keepCount: actor.influence.length });
                return;
        }

        this.gameState.pendingAction = null;
        this.nextTurn();
    }

    selectCards(playerId, selectedIndices) {
        const player = this.gameState.players.find(p => p.id === playerId);
        if (!player || !this.gameState.pendingAction || this.gameState.pendingAction.type !== 'exchange') return;

        if (!this.exchangeCards) return;

        const allCards = this.exchangeCards;
        player.influence = selectedIndices.map(i => allCards[i]);        
        const returnedCards = allCards.filter((card, i) => !selectedIndices.includes(i));
        this.gameState.courtDeck.push(...returnedCards);
        this.gameState.courtDeck = this.shuffleDeck(this.gameState.courtDeck);
        
        delete this.exchangeCards;
        
        this.broadcastLog(`${player.name} exchanges cards with the Court`);
        this.gameState.pendingAction = null;
        this.nextTurn();
    }

    handleInfluenceLoss(playerId, callback = null) {
        const player = this.gameState.players.find(p => p.id === playerId);
        if (!player) { if (callback) callback(); return; }
        if (!player.isAlive || player.influence.length === 0) { if (callback) callback(); return; }
        
        if (player.influence.length === 1) {
            const lostCard = player.influence.pop();
            player.revealedCards.push(lostCard);
            this.gameState.revealedCards.push(lostCard);
            this.broadcastLog(`${player.name} loses ${lostCard} and is exiled!`);
            player.isAlive = false;
            this.gameState.treasury += player.coins;
            player.coins = 0;
            
            this.broadcastGameState();
            if (this.checkGameEnd()) { if (callback) callback(); return; }
            if (callback) callback();
        } else {
            const playerSocket = this.getPlayerSocket(playerId);
            if (!playerSocket) { if (callback) callback(); return; }
            
            playerSocket.emit('actionRequired', { type: 'loseInfluence', playerCards: player.influence });
            this.pendingInfluenceLossCallback = callback;
        }
    }

    loseInfluence(playerId, cardIndex) {
        const player = this.gameState.players.find(p => p.id === playerId);
        if (!player || cardIndex >= player.influence.length) return;

        const lostCard = player.influence.splice(cardIndex, 1)[0];
        player.revealedCards.push(lostCard);
        this.gameState.revealedCards.push(lostCard);
        
        this.broadcastLog(`${player.name} loses ${lostCard}`);
        
        if (player.influence.length === 0) {
            player.isAlive = false;
            this.gameState.treasury += player.coins;
            player.coins = 0;
            this.broadcastLog(`${player.name} is exiled!`);
        }
        
        if (this.checkGameEnd()) { if (this.pendingInfluenceLossCallback) { this.pendingInfluenceLossCallback(); this.pendingInfluenceLossCallback = null; } return; }
        
        this.broadcastGameState();
        
        if (this.pendingInfluenceLossCallback) {
            this.pendingInfluenceLossCallback();
            this.pendingInfluenceLossCallback = null;
        }
    }

    checkGameEnd() {
        const alivePlayers = this.gameState.players.filter(p => p.isAlive);
        if (alivePlayers.length <= 1) {
            this.gameState.gameEnded = true;
            const winner = alivePlayers.length === 1 ? alivePlayers[0] : null;
            this.players.forEach(player => player.socket.emit('gameEnded', { winner }));
            
            if (winner) {
                this.broadcastLog(`${winner.name} wins the game!`);
            } else {
                this.broadcastLog(`Game ended with no survivors!`);
            }
            
            this.cleanup();
            return true;
        }
        return false;
    }

    nextTurn() {
        if (this.gameState.gameEnded) return;
        do { this.gameState.currentPlayer = (this.gameState.currentPlayer + 1) % this.gameState.players.length; } 
        while (!this.gameState.players[this.gameState.currentPlayer].isAlive);
        
        this.startTurnTimer();
        this.broadcastGameState();
    }

    startTurnTimer() {
        this.clearTurnTimer();
        let timeLeft = this.TURN_TIME_LIMIT;
        this.turnTimer = setInterval(() => {
            timeLeft -= 1000;
            this.players.forEach(player => player.socket.emit('timerUpdate', { timeLeft }));
            if (timeLeft <= 0) {
                this.clearTurnTimer();
                this.performAction(this.gameState.players[this.gameState.currentPlayer].id, 'income');
            }
        }, 1000);
    }

    startChallengeTimer() {
        this.clearChallengeTimer();
        this.challengeTimer = setTimeout(() => this.allowAction(), this.CHALLENGE_TIME_LIMIT);
    }

    clearTurnTimer() { if (this.turnTimer) { clearInterval(this.turnTimer); this.turnTimer = null; } }
    clearChallengeTimer() { if (this.challengeTimer) { clearTimeout(this.challengeTimer); this.challengeTimer = null; } }

    getRequiredCard(action) {
        const cardMap = { 'tax': 'Duke', 'assassinate': 'Assassin', 'steal': 'Captain', 'exchange': 'Ambassador' };
        return cardMap[action];
    }

    getPlayerSocket(playerId) {
        const player = this.players.find(p => p.id === playerId);
        return player?.socket || null;
    }

    getPublicGameState(forPlayerId) {
        const publicState = { ...this.gameState };
        publicState.players = this.gameState.players.map(p => ({
            ...p, influence: p.id === forPlayerId ? p.influence : Array(p.influence.length).fill('Hidden')
        }));
        return publicState;
    }

    broadcastGameState() {
        this.players.forEach(player => player.socket.emit('gameStateUpdated', { gameState: this.getPublicGameState(player.id) }));
    }

    broadcastLog(message) { this.players.forEach(player => player.socket.emit('logMessage', { message })); }

    handlePlayerDisconnect(socketId) {
        const playerIndex = this.gameState.players.findIndex(p => p.id === socketId);
        if (playerIndex !== -1) {
            const player = this.gameState.players[playerIndex];
            player.isAlive = false;
            this.broadcastLog(`${player.name} disconnected and is eliminated`);
            if (this.checkGameEnd()) return;
            if (this.gameState.currentPlayer === playerIndex) this.nextTurn();
        }
    }

    cleanup() {
        this.clearTurnTimer();
        this.clearChallengeTimer();
        this.pendingInfluenceLossCallback = null;
        this.exchangeCards = null;
        this.players.forEach(player => { if (player.socket) player.socket.emit('gameCleanup'); });
    }
}

const rooms = new Map();
const generateRoomCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();

io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);
    socket.emit('playerAssigned', { playerId: socket.id });

    socket.on('createRoom', () => {
        let roomCode;
        do { roomCode = generateRoomCode(); } while (rooms.has(roomCode));

        const room = new GameRoom(roomCode);
        const result = room.addPlayer(socket, `Player 1`);
        
        if (result.success) {
            rooms.set(roomCode, room);
            socket.join(roomCode);
            socket.emit('roomCreated', { roomCode, isHost: result.isHost });
        } else {
            socket.emit('roomError', { message: result.message });
        }
    });

    socket.on('joinRoom', (data) => {
        const { roomCode, playerName } = data;
        const room = rooms.get(roomCode);
        if (!room) { socket.emit('roomError', { message: 'Room not found' }); return; }

        const result = room.addPlayer(socket, playerName);
        if (result.success) {
            socket.join(roomCode);
            socket.emit('roomJoined', { roomCode, isHost: result.isHost });
        } else {
            socket.emit('roomError', { message: result.message });
        }
    });

    socket.on('startGame', () => {
        const room = findPlayerRoom(socket.id);
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player || !player.isHost) { socket.emit('roomError', { message: 'Only host can start the game' }); return; }

        const result = room.startGame();
        if (!result.success) socket.emit('roomError', { message: result.message });
    });

    socket.on('performAction', (data) => {
        const room = findPlayerRoom(socket.id);
        if (!room) return;
        room.performAction(socket.id, data.action);
    });

    socket.on('selectTarget', (data) => {
        const room = findPlayerRoom(socket.id);
        if (!room) return;
        room.selectTarget(socket.id, data.targetId);
    });

    socket.on('challengeAction', () => {
        const room = findPlayerRoom(socket.id);
        if (!room) return;
        room.challengeAction(socket.id);
    });

    socket.on('blockAction', (data) => {
        const room = findPlayerRoom(socket.id);
        if (!room) return;
        room.blockAction(socket.id, data.blockingCard);
    });

    socket.on('allowAction', () => {
        const room = findPlayerRoom(socket.id);
        if (!room) return;

        room.allowAction();
    });

    socket.on('selectCards', (data) => {
        const room = findPlayerRoom(socket.id);
        if (!room) return;

        const { selectedIndices } = data;
        room.selectCards(socket.id, selectedIndices);
    });

    socket.on('loseInfluence', (data) => {
        const room = findPlayerRoom(socket.id);
        if (!room) return;

        const { cardIndex } = data;
        room.loseInfluence(socket.id, cardIndex);
    });

    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
        
        const room = findPlayerRoom(socket.id);
        if (room) {
            room.removePlayer(socket.id);
            
            // Remove empty room
            if (room.players.length === 0) {
                rooms.delete(room.roomCode);
            }
        }
    });
});

function findPlayerRoom(playerId) {
    for (const room of rooms.values()) {
        if (room.players.find(p => p.id === playerId)) {
            return room;
        }
    }
    return null;
}

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Visit http://localhost:${PORT} to play the game`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('Shutting down server...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('Shutting down server...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});