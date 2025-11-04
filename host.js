import { initializeDatabase, subscribeToGameState, updatePlayersData, updateWorldData } from './database.js';
import { getPlayer, setPlayerPosition, updatePeers, setMovementEnabled } from './world.js';

const UPDATE_INTERVAL = 200; // 5 times per second
const DATABASE_UPDATE_INTERVAL = 500; // 2 times per second
const POSITION_TOLERANCE = 5; // Max distance before auto-correct

let isDatabaseFrozen = false; // Moved to module scope to be accessible by message handler

// A map to link a client's temporary connection ID to their persistent user ID.
const clientIdToUserId = new Map();
let playersData = {}; // Moved to module scope for access in handler
const COLLECTION_NAME = 'retroverse_state_v1';

export function handleHostMessage(event, room) {
    if (isDatabaseFrozen) return; // Halt message processing when frozen

    const { data, clientId } = event; // Removed 'username' from destructuring, it's not on the event.
    const { type, position, userId } = data;
    
    switch (type) {
        case 'client_chat_message':
            if (data.message && data.userId) {
                let senderUsername = 'Unknown';

                // Priority 1: Use username from the message payload itself.
                if (data.username) {
                    senderUsername = data.username;
                } 
                // Priority 2 (Fallback): Use the live peers object.
                else if (room.peers[clientId] && room.peers[clientId].username) {
                    senderUsername = room.peers[clientId].username;
                }

                // Host validates the message and relays it in a structured object
                room.send({
                    type: 'validated_chat_message',
                    payload: {
                        senderId: data.userId,
                        senderName: senderUsername,
                        message: data.message,
                        timestamp: new Date().toISOString()
                    }
                });
            }
            break;

        case 'player_position_update':
            // Ignore position updates from self
            if (clientId === room.clientId) return;
            if (!userId) return;

            // Map clientId to userId when we first hear from them
            if (!clientIdToUserId.has(clientId)) {
                console.log(`Mapping new connection: clientId ${clientId} to userId ${userId}`);
                clientIdToUserId.set(clientId, userId);
            }

            // Validate position against stored position
            const storedData = playersData[userId];
            if (storedData && storedData.position) {
                const dx = position.x - storedData.position.x;
                const dy = position.y - storedData.position.y;
                const dz = position.z - storedData.position.z;
                const distance = Math.sqrt(dx*dx + dy*dy + dz*dz);

                if (distance > POSITION_TOLERANCE) {
                    console.log(`Position mismatch for ${room.peers[clientId]?.username}. Distance: ${distance}. Auto-correcting...`);
                    // Send correction back to client
                    room.send({
                        type: 'position_correction',
                        position: storedData.position
                    }, clientId);
                    return; // Don't update with the incorrect position
                }
            }

            playersData[userId] = {
                username: room.peers[clientId]?.username,
                position,
                timestamp: new Date().toISOString()
            };
            break;
    }
}

export async function initHost(room, dataDisplayEl) {
    console.log("Initializing Host...");
    const freezeBtn = document.getElementById('freeze-btn');
    const saveBtn = document.getElementById('save-btn');
    // let isDatabaseFrozen = false; // Now in module scope

    const gameStateRecord = await initializeDatabase(room);
    if (!gameStateRecord) {
        dataDisplayEl.value = "Error: Could not initialize or find game state record.";
        return;
    }

    const recordId = gameStateRecord.id;
    playersData = gameStateRecord.slot_1 || {}; // Assign to module-scoped variable
    let lastSavedPlayersData = JSON.parse(JSON.stringify(playersData)); // Deep copy for comparison
    
    // Initialize world data if it doesn't exist
    if (!gameStateRecord.slot_0 || gameStateRecord.slot_0.seed === undefined) {
        await updateWorldData(room, recordId, { seed: 0 });
    }

    const currentUser = await window.websim.getCurrentUser();
    const hostUserId = currentUser.id;

    // Load host's own position if it exists
    if (playersData[hostUserId]) {
        const savedPosition = playersData[hostUserId].position;
        if (savedPosition) {
            console.log('Host loading saved position:', savedPosition);
            setPlayerPosition(savedPosition);
        }
    }
    
    freezeBtn.addEventListener('click', () => {
        isDatabaseFrozen = !isDatabaseFrozen;
        setMovementEnabled(!isDatabaseFrozen); // Freeze host's movement

        // Broadcast the new game state to all clients
        room.send({
            type: 'game_state_change',
            frozen: isDatabaseFrozen
        });

        if (isDatabaseFrozen) {
            freezeBtn.textContent = 'Unlock';
            saveBtn.disabled = false;
            dataDisplayEl.readOnly = false;
            dataDisplayEl.style.boxShadow = 'inset 0 0 10px #ff0000'; // Indicate editing mode
        } else {
            freezeBtn.textContent = 'Freeze & Edit';
            saveBtn.disabled = true;
            dataDisplayEl.readOnly = true;
            dataDisplayEl.style.boxShadow = 'inset 0 0 10px #00ff00'; // Back to normal
        }
    });

    saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';
        try {
            const updatedState = JSON.parse(dataDisplayEl.value);
            // The payload should not contain read-only fields like id, created_at
            const payload = { ...updatedState };
            delete payload.id;
            delete payload.created_at;
            delete payload.username;

            await room.collection(COLLECTION_NAME).update(recordId, payload);
            alert('Game state saved successfully!');
            
            // --- Post-Save State Synchronization ---
            // The saved state is now the absolute source of truth.

            // 1. Update the local in-memory player data completely.
            if (payload.slot_1) {
                playersData = { ...payload.slot_1 }; 
                lastSavedPlayersData = JSON.parse(JSON.stringify(playersData)); 
            }

            // 2. Reflect the saved state back into the textarea immediately.
            // This prevents any "flicker" from a latent subscription update.
            // We'll re-add the read-only fields for display purposes.
            const displayState = {
                ...gameStateRecord, // carries over id, created_at, etc.
                ...payload // overwrites with the new data
            };
            dataDisplayEl.value = JSON.stringify(displayState, null, 2);

            // 3. Auto-correction logic based on this new truth
            if (payload.slot_1) {
                console.log("Applying saved state and sending position corrections...");
                const newPlayersData = payload.slot_1;
                
                const userIdToClientId = new Map();
                for (const [clientId, userId] of clientIdToUserId.entries()) {
                    userIdToClientId.set(userId, clientId);
                }
                
                for(const userId in newPlayersData) {
                    const clientId = userIdToClientId.get(userId);

                    // Correction for the HOST player
                    if (userId === hostUserId) {
                        const newPosition = newPlayersData[userId].position;
                        if(newPosition) {
                            console.log(`Correcting host's own position to:`, newPosition);
                            setPlayerPosition(newPosition);
                        }
                        continue; // Host is handled, move to next player
                    }
                    
                    if (clientId && room.peers[clientId]) {
                        const newPosition = newPlayersData[userId].position;
                        if(newPosition) {
                            console.log(`Sending position correction to ${room.peers[clientId].username} (User ID: ${userId})`);
                            room.send({
                                type: 'position_correction',
                                position: newPosition
                            }, clientId);
                        }
                    }
                }
            }


            // 4. Finally, re-lock and unfreeze the game
            isDatabaseFrozen = false;
            setMovementEnabled(true); // Unfreeze host's movement
            freezeBtn.textContent = 'Freeze & Edit';
            dataDisplayEl.readOnly = true;
            dataDisplayEl.style.boxShadow = 'inset 0 0 10px #00ff00';

            // Also notify clients that the game is unfrozen
            room.send({
                type: 'game_state_change',
                frozen: false
            });
            
        } catch (error) {
            console.error("Error saving game state:", error);
            alert("Invalid JSON. Could not save changes. Check console for details.");
        } finally {
             saveBtn.textContent = 'Save Changes';
             if(isDatabaseFrozen) { // Only re-enable if still in frozen mode
                 saveBtn.disabled = false;
             } else {
                 saveBtn.disabled = true; // Ensure it's disabled if we've unfrozen
             }
        }
    });


    subscribeToGameState(room, (state) => {
        if (!state) {
            dataDisplayEl.value = "Waiting for game state...";
            return;
        }
        
        // If the database is frozen for editing, do not accept any updates from the subscription.
        // This gives the host full control over the textarea content.
        if (isDatabaseFrozen) {
            return; 
        }

        // When not frozen, the textarea and local state should always reflect the latest from the database.
        dataDisplayEl.value = JSON.stringify(state, null, 2);
        
        if(state.slot_1) {
            // COMPLETE OVERWRITE: The database is the source of truth when not editing.
            playersData = { ...state.slot_1 };
            // Also update the last-saved reference to prevent an immediate re-save by the interval.
            lastSavedPlayersData = JSON.parse(JSON.stringify(playersData));
        }
    });

    // Main real-time update loop for host (sends data to players)
    setInterval(() => {
        if (isDatabaseFrozen) return; // Don't send updates when frozen

        // 1. Update host's own data in memory
        const hostPlayer = getPlayer();
        if (hostPlayer) {
            playersData[hostUserId] = {
                username: currentUser.username,
                position: {
                    x: hostPlayer.position.x,
                    y: hostPlayer.position.y,
                    z: hostPlayer.position.z,
                },
                timestamp: new Date().toISOString()
            };
        }

        // 2. Build the list of players to render and broadcast.
        // We will show all players from the database (`playersData`),
        // and later filter what we broadcast to only those connected.
        const allKnownPlayers = { ...playersData };

        const connectedPlayersForBroadcast = {};
        const connectedClientIds = new Set(Object.keys(room.peers));
        
        // Ensure host is always included in broadcast
        if (playersData[hostUserId]) {
            connectedPlayersForBroadcast[hostUserId] = playersData[hostUserId];
        }

        // Add other connected peers to the broadcast list
        for (const clientId of connectedClientIds) {
            if (clientId === room.clientId) continue; // Skip self (host)
            const userId = clientIdToUserId.get(clientId);
            if (userId && playersData[userId]) {
                 connectedPlayersForBroadcast[userId] = playersData[userId];
            }
        }
        
        // 3. Broadcast the connected player state and update the host's local view
        // The broadcast only contains currently connected players.
        room.send({
            type: 'players_state_update',
            players: connectedPlayersForBroadcast
        });
        
        // The host's renderer gets the data for ALL known players.
        updatePeers(allKnownPlayers, hostUserId);

    }, UPDATE_INTERVAL);

    // Separate, less frequent loop for database persistence
    setInterval(() => {
        if (isDatabaseFrozen) return;

        // Compare current data with the last saved state
        if (JSON.stringify(playersData) !== JSON.stringify(lastSavedPlayersData)) {
            console.log("Player data has changed, updating database...");
            updatePlayersData(room, recordId, playersData);
            lastSavedPlayersData = JSON.parse(JSON.stringify(playersData)); // Update last saved state
        }
    }, DATABASE_UPDATE_INTERVAL);

    // Handle disconnections to clean up the map
    room.subscribePresence((presence) => {
        const connectedClientIds = new Set(Object.keys(presence));
        for (const [clientId, userId] of clientIdToUserId.entries()) {
            if (!connectedClientIds.has(clientId)) {
                console.log(`Peer disconnected. Removing mapping for client ${clientId} (user ${userId})`);
                clientIdToUserId.delete(clientId);
            }
        }
    });
}