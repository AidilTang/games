// game.js - Coup Multiplayer Game Logic (Shortened)

class CoupGame {
    constructor() {
        this.socket = null;
        this.playerId = null;
        this.roomCode = null;
        this.isHost = false;
        this.gameState = {
            players: [], currentPlayer: 0, treasury: 50, courtDeck: [],
            pendingAction: null, gamePhase: 'lobby', revealedCards: [],
            gameEnded: false, turnTimer: null, challengeTimer: null
        };
        this.CHARACTERS = ['Duke', 'Assassin', 'Captain', 'Ambassador', 'Contessa'];
        this.TURN_TIME_LIMIT = 60000;
        this.CHALLENGE_TIME_LIMIT = 30000;
        this.challengeTimer = null;
        this.init();
    }

    init() {
        this.connectToServer();
        this.setupEventListeners();
    }

    connectToServer() {
        const isProduction = window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1';
        const serverUrl = isProduction ? window.location.origin : 'http://localhost:3000';
        
        console.log('Connecting to server:', serverUrl);

        this.socket = io(serverUrl, {
            transports: ['websocket', 'polling'], timeout: 20000,
            reconnection: true, reconnectionAttempts: 5, reconnectionDelay: 1000,
            forceNew: true,
            upgrade: true,
            rememberUpgrade: true
        });

        const events = {
            connect: () => { this.updateConnectionStatus('Connected', true); console.log('Connected to server at:',serverUrl); },
            disconnect: (reason) => { this.updateConnectionStatus('Disconnected', false); console.log('Disconnected from server:', reason); },
            connect_error: (error) => { console.error('Connection error:', error); this.updateConnectionStatus('Connection Error', false); },
            playerAssigned: (data) => { this.playerId = data.playerId; document.getElementById('playerId').textContent = `Player ID: ${this.playerId}`; },
            roomCreated: (data) => { this.roomCode = data.roomCode; this.isHost = true; this.showRoom(); },
            roomJoined: (data) => { this.roomCode = data.roomCode; this.isHost = data.isHost; this.showRoom(); },
            roomError: (data) => alert(data.message),
            playersUpdated: (data) => this.updatePlayersList(data.players),
            gameStarted: (data) => { this.gameState = data.gameState; this.showGameBoard(); this.updateDisplay(); },
            gameStateUpdated: (data) => { this.gameState = data.gameState; this.updateDisplay(); },
            actionRequired: (data) => this.handleActionRequired(data),
            challengePhase: (data) => this.showChallengeOptions(data),
            gameEnded: (data) => this.handleGameEnd(data),
            timerUpdate: (data) => this.updateTimer(data),
            logMessage: (data) => this.logMessage(data.message),
            waitingForResponse: (data) => this.showWaitingMessage(data),
            hideWaiting: () => {
                try {
                    this.hideAllWaitingMessages();
                } catch (error) {
                    console.error('Error handling hideWaiting:', error);
                }
            }
        };

        Object.entries(events).forEach(([event, handler]) => this.socket.on(event, handler));
    }

    setupEventListeners() {
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && document.getElementById('roomCode') === document.activeElement) {
                this.joinRoom();
            }
        });
    }

    updateConnectionStatus(status, isConnected) {
        const indicator = document.getElementById('connectionIndicator');
        indicator.textContent = status;
        indicator.className = isConnected ? 'connected' : '';
    }

    createRoom() {
        if (!this.socket?.connected) { alert('Not connected to server'); return; }
        this.socket.emit('createRoom');
    }

    joinRoom() {
        const roomCode = document.getElementById('roomCode').value.trim().toUpperCase();
        if (!roomCode) { alert('Please enter a room code'); return; }
        if (!this.socket?.connected) { alert('Not connected to server'); return; }
        this.socket.emit('joinRoom', { roomCode });
    }

    showRoom() {
        document.getElementById('lobby').style.display = 'block';
        document.getElementById('currentRoomCode').textContent = this.roomCode;
        document.getElementById('roomInfo').style.display = 'block';
        if (this.isHost) document.getElementById('hostControls').style.display = 'block';
    }

    updatePlayersList(players) {
        const playersList = document.getElementById('playersList');
        playersList.innerHTML = '<h4>Players in Room:</h4>';
        
        players.forEach(player => {
            const div = document.createElement('div');
            div.className = 'player-item';
            div.innerHTML = `<p>${player.name} ${player.isHost ? '(Host)' : ''}</p>`;
            playersList.appendChild(div);
        });

        if (this.isHost) {
            document.getElementById('startGameBtn').disabled = players.length < 2 || players.length > 6;
        }
    }

    startMultiplayerGame() {
        if (!this.isHost) return;
        this.socket.emit('startGame');
    }

    showGameBoard() {
        document.getElementById('lobby').style.display = 'none';
        document.getElementById('gameBoard').style.display = 'block';
        this.gameState.gamePhase = 'playing';
    }

    updateDisplay() {
        if (!this.gameState?.players || this.gameState.gameEnded) return;

        try {
            const currentPlayerName = this.gameState.players[this.gameState.currentPlayer]?.name || 'Unknown';
            const currentPlayerEl = document.getElementById('currentPlayer');
            const treasuryEl = document.getElementById('treasury');
            
            if (currentPlayerEl) currentPlayerEl.textContent = `Current Player: ${currentPlayerName}`;
            if (treasuryEl) treasuryEl.textContent = `Treasury: ${this.gameState.treasury} coins`;

            this.updatePlayersDisplay();
            this.updateActionButtons();
            this.playSound('actionSound');
        } catch (error) {
            console.error('Error updating display:', error);
        }
    }

    updatePlayersDisplay() {
        const playersDiv = document.getElementById('players');
        playersDiv.innerHTML = '';

        this.gameState.players.forEach((player, index) => {
            const div = document.createElement('div');
            div.className = `player-card ${index === this.gameState.currentPlayer ? 'current-player' : ''} ${!player.isAlive ? 'exiled' : ''}`;
            
            const showCards = player.id === this.playerId && player.isAlive;
            div.innerHTML = `
                <h4>${player.name} ${!player.isAlive ? '(EXILED)' : ''}</h4>
                <p class="player-coins">Coins: ${player.coins}</p>
                <p class="player-influence">Influence: ${player.influence.length} cards</p>
                <p>Revealed: ${player.revealedCards.join(', ') || 'None'}</p>
                ${showCards ? `<div class="player-cards">Your cards: ${player.influence.join(', ')}</div>` : ''}
            `;
            playersDiv.appendChild(div);
        });
    }

    updateActionButtons() {
        try {
            if (!this.gameState.players?.length) return;
            
            const currentPlayer = this.gameState.players[this.gameState.currentPlayer];
            if (!currentPlayer) return;
            
            const isMyTurn = currentPlayer.id === this.playerId;
            const actionsDiv = document.getElementById('actions');
            if (actionsDiv) actionsDiv.style.display = isMyTurn ? 'block' : 'none';
            if (!isMyTurn) return;

            document.querySelectorAll('#actions button').forEach(btn => {
                try {
                    const action = btn.onclick?.toString().match(/performAction\(['"](.+?)['"]\)/)?.[1];
                    if (!action) return;

                    btn.style.display = 'inline-flex';
                    btn.disabled = false;

                    if (action === 'coup') {
                        if (currentPlayer.coins >= 10) {
                            btn.textContent = 'Coup (REQUIRED - 7 coins)';
                            btn.classList.add('pulse');
                            document.querySelectorAll('#actions button').forEach(otherBtn => {
                                if (otherBtn !== btn) otherBtn.style.display = 'none';
                            });
                        } else {
                            btn.innerHTML = 'Coup<br><small>(7 coins)</small>';
                            btn.classList.remove('pulse');
                            btn.disabled = currentPlayer.coins < 7;
                        }
                    }
                    if (action === 'assassinate') btn.disabled = currentPlayer.coins < 3;
                } catch (btnError) {
                    console.error('Error updating button:', btn, btnError);
                }
            });
        } catch (error) {
            console.error('Error in updateActionButtons:', error);
        }
    }

    performAction(action) {
        if (this.gameState.gameEnded || !this.gameState.players?.length) return;
        
        const currentPlayer = this.gameState.players[this.gameState.currentPlayer];
        if (!currentPlayer || currentPlayer.id !== this.playerId) {
            alert('It\'s not your turn!'); return;
        }
        if (!this.socket?.connected) { alert('Not connected to server'); return; }

        console.log('Performing action:', action, 'for player:', this.playerId);
        this.socket.emit('performAction', { action, playerId: this.playerId });
    }

    handleActionRequired(data) {
        const actions = {
            selectTarget: () => this.showTargetSelection(data.validTargets, data.action),
            selectCards: () => this.showCardSelection(data.cards, data.keepCount),
            loseInfluence: () => this.showInfluenceSelection(data.playerCards)
        };
        actions[data.type]?.();
    }

    showTargetSelection(validTargets, action) {
        if (!validTargets?.length) return;
        
        const targetDiv = document.getElementById('targetSelection');
        const buttonsDiv = document.getElementById('targetButtons');
        if (!targetDiv || !buttonsDiv) return;
        
        buttonsDiv.innerHTML = '';
        validTargets.forEach(target => {
            if (!target?.id || !target?.name) return;
            const button = document.createElement('button');
            button.textContent = target.name;
            button.onclick = () => this.selectTarget(target.id);
            buttonsDiv.appendChild(button);
        });
        targetDiv.style.display = 'flex';
    }

    selectTarget(targetId) {
        if (!this.socket?.connected) { alert('Not connected to server'); return; }
        
        console.log('Selecting target:', targetId);
        this.socket.emit('selectTarget', { targetId, playerId: this.playerId });
        
        const targetDiv = document.getElementById('targetSelection');
        if (targetDiv) targetDiv.style.display = 'none';
    }

    showChallengeOptions(data) {
        try {
            // Clear any existing challenge timer
            this.clearChallengeTimer();
            
            const waitingDiv = document.getElementById('waitingMessage');
            if (waitingDiv) waitingDiv.style.display = 'none';
            
            const challengeDiv = document.getElementById('challenges');
            const optionsDiv = document.getElementById('challengeOptions');
            
            if (!challengeDiv || !optionsDiv) {
                console.error('Challenge UI elements not found');
                return;
            }
            
            optionsDiv.innerHTML = '';
            
            const actionText = data.challengePhase === 'block' 
                ? `${data.blocker} is attempting to block with ${data.blockingCard}`
                : `Action: ${data.action}`;
            
            const infoP = document.createElement('p');
            infoP.textContent = actionText;
            infoP.style.fontWeight = 'bold';
            optionsDiv.appendChild(infoP);
            
            if (data.canChallenge) {
                const challengeBtn = document.createElement('button');
                challengeBtn.textContent = data.challengePhase === 'block' 
                    ? `Challenge ${data.blocker}'s ${data.blockingCard}`
                    : 'Challenge Action';
                challengeBtn.onclick = () => this.challengeAction();
                optionsDiv.appendChild(challengeBtn);
            }

            if (data.canBlock) {
                data.blockOptions.forEach(blockOption => {
                    const blockBtn = document.createElement('button');
                    blockBtn.textContent = `Block with ${blockOption}`;
                    blockBtn.onclick = () => this.blockAction(blockOption);
                    optionsDiv.appendChild(blockBtn);
                });
            }

            const allowBtn = document.createElement('button');
            allowBtn.textContent = data.challengePhase === 'block' ? 'Allow Block' : 'Allow Action';
            allowBtn.onclick = () => this.allowAction();
            optionsDiv.appendChild(allowBtn);
            
            challengeDiv.style.display = 'flex';
            this.startChallengeTimer();
        } catch (error) {
            console.error('Error in showChallengeOptions:', error);
            // Fallback: hide waiting messages
            this.hideAllWaitingMessages();
        }
    }

    challengeAction() {
        try {
            if (!this.socket?.connected) {
                alert('Not connected to server');
                return;
            }
            
            this.socket.emit('challengeAction', { playerId: this.playerId });
            
            // Clear timer and hide UI immediately
            this.clearChallengeTimer();
            this.hideAllWaitingMessages();
        } catch (error) {
            console.error('Error in challengeAction:', error);
            this.hideAllWaitingMessages();
        }
    }

    blockAction(blockingCard) {
        try {
            if (!this.socket?.connected) {
                alert('Not connected to server');
                return;
            }
            
            this.socket.emit('blockAction', { playerId: this.playerId, blockingCard });
            
            // Clear timer and hide UI immediately
            this.clearChallengeTimer();
            this.hideAllWaitingMessages();
        } catch (error) {
            console.error('Error in blockAction:', error);
            this.hideAllWaitingMessages();
        }
    }

    allowAction() {
        try {
            if (!this.socket?.connected) {
                alert('Not connected to server');
                return;
            }
            
            this.socket.emit('allowAction', { playerId: this.playerId });
            
            // Clear timer and hide UI immediately
            this.clearChallengeTimer();
            this.hideAllWaitingMessages();
        } catch (error) {
            console.error('Error in allowAction:', error);
            this.hideAllWaitingMessages();
        }
    }
    showCardSelection(cards, keepCount) {
        const cardDiv = document.getElementById('cardSelection');
        const optionsDiv = document.getElementById('cardOptions');
        optionsDiv.innerHTML = `<p>Select ${keepCount} cards to keep:</p>`;
        
        const selectedCards = [];
        cards.forEach((card, index) => {
            const label = document.createElement('label');
            label.className = 'card-option';
            
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = index;
            checkbox.onchange = () => {
                if (checkbox.checked) {
                    if (selectedCards.length < keepCount) {
                        selectedCards.push(index);
                    } else {
                        checkbox.checked = false;
                        alert(`You can only select ${keepCount} cards`);
                    }
                } else {
                    const idx = selectedCards.indexOf(index);
                    if (idx > -1) selectedCards.splice(idx, 1);
                }
            };
            
            label.appendChild(checkbox);
            label.appendChild(document.createTextNode(card));
            optionsDiv.appendChild(label);
        });
        
        const confirmBtn = document.createElement('button');
        confirmBtn.textContent = 'Confirm Selection';
        confirmBtn.onclick = () => {
            if (selectedCards.length === keepCount) {
                this.socket.emit('selectCards', { playerId: this.playerId, selectedIndices: selectedCards });
                cardDiv.style.display = 'none';
            } else {
                alert(`Please select exactly ${keepCount} cards.`);
            }
        };
        optionsDiv.appendChild(confirmBtn);
        cardDiv.style.display = 'flex';
    }

    showInfluenceSelection(playerCards) {
        const influenceDiv = document.getElementById('loseInfluence');
        const optionsDiv = document.getElementById('influenceOptions');
        optionsDiv.innerHTML = '<p>Choose a card to lose:</p>';
        
        playerCards.forEach((card, index) => {
            const button = document.createElement('button');
            button.textContent = card;
            button.onclick = () => this.loseInfluenceCard(index);
            optionsDiv.appendChild(button);
        });
        influenceDiv.style.display = 'flex';
    }

    loseInfluenceCard(cardIndex) {
        this.socket.emit('loseInfluence', { playerId: this.playerId, cardIndex });
        document.getElementById('loseInfluence').style.display = 'none';
    }

    startChallengeTimer() {
        try {
            // Clear any existing timer first
            this.clearChallengeTimer();
            
            let timeLeft = this.CHALLENGE_TIME_LIMIT / 1000;
            const timerElement = document.getElementById('challengeTimer');
            
            if (!timerElement) {
                console.warn('Challenge timer element not found');
                return;
            }
            
            this.challengeTimer = setInterval(() => {
                try {
                    timerElement.textContent = `Time remaining: ${timeLeft}s`;
                    timeLeft--;
                    if (timeLeft < 0) {
                        this.clearChallengeTimer();
                        this.allowAction();
                    }
                } catch (error) {
                    console.error('Error in challenge timer:', error);
                    this.clearChallengeTimer();
                }
            }, 1000);
        } catch (error) {
            console.error('Error starting challenge timer:', error);
        }
    }

    updateTimer(data) {
        const timerElement = document.getElementById('turnTimer');
        if (data.timeLeft > 0) {
            timerElement.textContent = `Turn timer: ${Math.ceil(data.timeLeft / 1000)}s`;
            timerElement.style.display = 'block';
        } else {
            timerElement.style.display = 'none';
        }
    }

    clearChallengeTimer() {
        if (this.challengeTimer) {
            clearInterval(this.challengeTimer);
            this.challengeTimer = null;
        }
        
        // Clear timer display
        const timerElement = document.getElementById('challengeTimer');
        if (timerElement) {
            timerElement.textContent = '';
        }
    }

    handleGameEnd(data) {
        this.gameState.gameEnded = true;
        document.getElementById('gameBoard').style.display = 'none';
        document.getElementById('gameEnd').style.display = 'block';
        
        const resultDiv = document.getElementById('gameResult');
        resultDiv.innerHTML = data.winner 
            ? `<h3>🎉 ${data.winner.name} Wins! 🎉</h3><p>Congratulations on your victory!</p>`
            : `<h3>Game Over</h3><p>No survivors remain...</p>`;
    }

    returnToLobby() {
        document.getElementById('gameEnd').style.display = 'none';
        document.getElementById('lobby').style.display = 'block';
        this.gameState.gameEnded = false;
        this.socket.emit('returnToLobby');
    }

    logMessage(message) {
        const logDiv = document.getElementById('logMessages');
        const messageP = document.createElement('p');
        messageP.textContent = message;
        messageP.className = 'fade-in';
        logDiv.appendChild(messageP);
        logDiv.scrollTop = logDiv.scrollHeight;
        
        if (logDiv.children.length > 50) {
            logDiv.removeChild(logDiv.firstChild);
        }
    }

    playSound(soundId) {
        try {
            const audio = document.getElementById(soundId);
            if (audio) {
                audio.currentTime = 0;
                audio.play().catch(() => {});
            }
        } catch (e) {}
    }

    getRequiredCard(action) {
        const cardMap = { tax: 'Duke', assassinate: 'Assassin', steal: 'Captain', exchange: 'Ambassador' };
        return cardMap[action];
    }

    canBlock(action, card) {
        const blockMap = {
            foreignAid: ['Duke'],
            assassinate: ['Contessa'],
            steal: ['Ambassador', 'Captain']
        };
        return blockMap[action]?.includes(card) || false;
    }

    makeAIDecision(options) {
        return options[Math.floor(Math.random() * options.length)];
    }

    showWaitingMessage(data) {
        try {
            let waitingDiv = document.getElementById('waitingMessage');
            if (!waitingDiv) {
                waitingDiv = document.createElement('div');
                waitingDiv.id = 'waitingMessage';
                waitingDiv.className = 'waiting-overlay';
                waitingDiv.innerHTML = `
                    <div class="waiting-content">
                        <h3>Waiting...</h3>
                        <p id="waitingText"></p>
                    </div>
                `;
                document.body.appendChild(waitingDiv);
            }
            
            const waitingText = document.getElementById('waitingText');
            if (waitingText) {
                waitingText.textContent = data.message || 'Please wait...';
            }
            
            waitingDiv.style.display = 'flex';
        } catch (error) {
            console.error('Error showing waiting message:', error);
        }
    }
    hideAllWaitingMessages() {
        try {
            const waitingDiv = document.getElementById('waitingMessage');
            const challengeDiv = document.getElementById('challenges');
            
            if (waitingDiv) waitingDiv.style.display = 'none';
            if (challengeDiv) challengeDiv.style.display = 'none';
            
            this.clearChallengeTimer();
        } catch (error) {
            console.error('Error hiding waiting messages:', error);
        }
    }
}

// Global functions
let game;
const createRoom = () => game.createRoom();
const joinRoom = () => game.joinRoom();
const startMultiplayerGame = () => game.startMultiplayerGame();
const performAction = (action) => game.performAction(action);
const returnToLobby = () => game.returnToLobby();

// Initialize
document.addEventListener('DOMContentLoaded', () => { game = new CoupGame(); });

document.addEventListener('visibilitychange', () => {
    if (!document.hidden && game?.socket && !game.socket.connected) {
        game.connectToServer();
    }
});

window.addEventListener('beforeunload', () => {
    if (game?.socket) game.socket.disconnect();
});