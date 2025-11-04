import { initHost, handleHostMessage } from './host.js';
import { initPlayer, handlePlayerMessage } from './player.js';
import { initWorld } from './world.js';

const statusEl = document.getElementById('status');
const roleEl = document.getElementById('role');
const hostViewEl = document.getElementById('host-view');
const playerViewEl = document.getElementById('player-view');
const dataDisplayEl = document.getElementById('data-display');
const uiContainerEl = document.getElementById('ui-container');
const uiToggleBtn = document.getElementById('ui-toggle-btn');
const chatMessagesEl = document.getElementById('chat-messages');
const chatFormEl = document.getElementById('chat-form');
const chatInputEl = document.getElementById('chat-input');
const chatContainerEl = document.getElementById('chat-container');
const chatToggleBtn = document.getElementById('chat-toggle-btn');
const chatBarEl = document.getElementById('chat-bar');

function toggleUI() {
    if (uiContainerEl.style.display === 'block') {
        uiContainerEl.style.display = 'none';
    } else {
        uiContainerEl.style.display = 'block';
    }
}

function toggleChat() {
    if (chatContainerEl.style.display === 'flex') {
        chatContainerEl.style.display = 'none';
        chatBarEl.style.borderRadius = '5px'; // Restore border radius when closed
    } else {
        chatContainerEl.style.display = 'flex';
        chatBarEl.style.borderRadius = '0 0 5px 5px'; // Adjust border radius when open
    }
}

function displayChatMessage(username, message, isValidated) {
    const messageEl = document.createElement('div');
    messageEl.classList.add('message');

    const usernameEl = document.createElement('span');
    usernameEl.classList.add('username');
    usernameEl.textContent = `${username}: `;
    
    const messageContentEl = document.createElement('span');
    messageContentEl.textContent = message;

    messageEl.appendChild(usernameEl);
    messageEl.appendChild(messageContentEl);
    
    if (isValidated) {
        const checkmarkEl = document.createElement('span');
        checkmarkEl.classList.add('checkmark');
        checkmarkEl.textContent = ' ✓';
        messageEl.appendChild(checkmarkEl);
    }

    // Prepend to show new messages at the top, which becomes the bottom due to flex-direction: column-reverse
    chatMessagesEl.prepend(messageEl);

    // Keep scroll at bottom (visually)
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}


async function main() {
    initWorld(document.getElementById('bg'));

    try {
        const room = new WebsimSocket();
        await room.initialize();
        statusEl.textContent = 'Connected to Retroverse.';

        const [creator, currentUser] = await Promise.all([
            window.websim.getCreatedBy(),
            window.websim.getCurrentUser()
        ]);

        const isHost = creator.username === currentUser.username;

        // Central message handler
        room.onmessage = (event) => {
            const { data, username } = event;
            // The new payload contains senderName and message
            if (data.type === 'validated_chat_message') {
                if (data.payload) {
                    displayChatMessage(data.payload.senderName, data.payload.message, true);
                }
                return; // Early exit for chat messages
            }

            // Route other messages to role-specific handlers
            if (isHost) {
                handleHostMessage(event, room);
            } else {
                handlePlayerMessage(event, currentUser.id);
            }
        };

        // Chat form submission
        chatFormEl.addEventListener('submit', (e) => {
            e.preventDefault();
            const message = chatInputEl.value.trim();
            if (message) {
                room.send({
                    type: 'client_chat_message',
                    message: message,
                    userId: currentUser.id,
                    username: currentUser.username // Add username directly to the payload
                });
                chatInputEl.value = '';
            }
        });

        if (isHost) {
            roleEl.textContent = `Role: HOST (${currentUser.username})`;
            // uiContainerEl.style.display = 'block'; // Show for host - now controlled by toggle
            hostViewEl.style.display = 'block';
            playerViewEl.style.display = 'none'; // Hide player view for host
            initHost(room, dataDisplayEl);
        } else {
            roleEl.textContent = `Role: PLAYER (${currentUser.username})`;
            hostViewEl.style.display = 'none'; // Hide host view for player
            playerViewEl.style.display = 'block';
            // uiContainerEl.style.display = 'block'; // Also show UI for players - now controlled by toggle
            initPlayer(room, creator.username);
        }

        uiToggleBtn.addEventListener('click', toggleUI);
        chatToggleBtn.addEventListener('click', toggleChat);
        window.addEventListener('keydown', (event) => {
            if (event.key === '`' || event.key === '~') {
                toggleUI();
            }
        });

    } catch (error) {
        console.error("Initialization failed:", error);
        statusEl.textContent = 'Error connecting to Retroverse.';
    }
}

main();