import { getPlayer, setPlayerPosition, updatePeers, setMovementEnabled } from './world.js';
import { getGameStateRecord } from './database.js';

const POSITION_UPDATE_INTERVAL = 100; // 10 times per second
let isGameFrozen = false;

export function handlePlayerMessage(event, localUserId) {
    const { data } = event;

    // These messages are processed even when frozen
    if (data.type === 'position_correction') {
        console.log('Received position correction from host:', data.position);
        setPlayerPosition(data.position);
        return;
    }
    if (data.type === 'game_state_change') {
        isGameFrozen = data.frozen;
        setMovementEnabled(!isGameFrozen);
        console.log(`Game state changed. Frozen: ${isGameFrozen}`);
        
        const statusEl = document.getElementById('status');
        if (isGameFrozen) {
            statusEl.textContent = 'Game is frozen by host.';
        } else {
            statusEl.textContent = 'Connected to Retroverse.';
        }
        return;
    }

    // These messages are ignored when frozen
    if (isGameFrozen) return;

    if (data.type === 'players_state_update') {
        updatePeers(data.players, localUserId);
    }
}

export async function initPlayer(room, hostUsername) {
    console.log(`Initializing Player, host is ${hostUsername}...`);

    const currentUser = await window.websim.getCurrentUser();
    const userId = currentUser.id;

    // Wait for database to load and check for existing position
    const gameState = await getGameStateRecord(room);
    if (gameState && gameState.slot_1 && gameState.slot_1[userId]) {
        const savedPosition = gameState.slot_1[userId].position;
        if (savedPosition) {
            console.log('Found saved position, setting player to:', savedPosition);
            setPlayerPosition(savedPosition);
        }
    }

    // Listener is now set in app.js
    
    // Send position updates periodically
    setInterval(() => {
        if (isGameFrozen) return; // Don't send position updates if game is frozen

        const player = getPlayer();
        if (player) {
            room.send({
                type: 'player_position_update',
                userId: userId,
                position: {
                    x: player.position.x,
                    y: player.position.y,
                    z: player.position.z,
                }
            });
        }
    }, POSITION_UPDATE_INTERVAL);
}