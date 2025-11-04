import * as THREE from 'three';
import nipplejs from 'nipplejs';
// import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

let camera, scene, renderer, composer;
let player, targetPosition, groundPlane, raycaster;
const clock = new THREE.Clock();
const mouse = new THREE.Vector2();
const peers = new Map();
let movementEnabled = true;
let joystickVector = new THREE.Vector2();

const CHUNK_SIZE = 32;
const RENDER_DISTANCE = 3; // Render distance in chunks (e.g., 3 = 7x7 grid)
const loadedChunks = new Map();
let worldSeed = 0; // Hardcoded seed for now

const grassMaterial = new THREE.MeshBasicMaterial({ color: 0x006400 }); // Dark green for grass
const sandMaterial = new THREE.MeshBasicMaterial({ color: 0xc2b280 }); // Sandy color
const peerMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 }); // Red for peers

export function getPlayer() {
    return player;
}

export function setPlayerPosition(position) {
    if (player) {
        player.position.set(position.x, position.y, position.z);
        targetPosition.copy(player.position);
        updateChunks(); // Force chunk reload on teleport/position set
    }
}

export function setMovementEnabled(enabled) {
    movementEnabled = enabled;
}

export function updatePeers(playersData, localUserId) {
    const receivedPeerIds = new Set();

    for (const userId in playersData) {
        if (userId === localUserId) continue; // Skip self

        receivedPeerIds.add(userId);
        const playerData = playersData[userId];
        const { position } = playerData;

        if (!position) continue;

        let peerMesh = peers.get(userId);

        if (peerMesh) {
            // Update existing peer's target position for smoothing
            peerMesh.userData.targetPosition.set(position.x, position.y, position.z);
        } else {
            // Create new peer
            console.log(`Creating mesh for new peer: ${playerData.username || userId}`);
            const peerGeo = new THREE.BoxGeometry(1, 1, 1);
            peerMesh = new THREE.Mesh(peerGeo, peerMaterial);
            peerMesh.position.set(position.x, position.y, position.z);
            // Initialize userData for smoothing
            peerMesh.userData.targetPosition = new THREE.Vector3(position.x, position.y, position.z);
            scene.add(peerMesh);
            peers.set(userId, peerMesh);
        }
    }

    // Remove peers that are no longer in the data
    for (const [userId, peerMesh] of peers.entries()) {
        if (!receivedPeerIds.has(userId)) {
            console.log(`Removing disconnected peer: ${userId}`);
            scene.remove(peerMesh);
            peerMesh.geometry.dispose();
            peers.delete(userId);
        }
    }
}

const RetroShader = {
    uniforms: {
        'tDiffuse': { value: null },
        'scanlineIntensity': { value: 0.04 },
        'vignetteFalloff': { value: 0.9 }
    },

    vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }`,

    fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform float scanlineIntensity;
        uniform float vignetteFalloff;
        varying vec2 vUv;

        void main() {
            vec4 color = texture2D( tDiffuse, vUv );

            // Scanlines
            float scanline = sin( vUv.y * 800.0 ) * scanlineIntensity;
            color.rgb -= scanline;

            // Vignette
            float vignette = length(vUv - vec2(0.5));
            color.rgb *= 1.0 - pow(vignette, vignetteFalloff);

            gl_FragColor = color;
        }`
};

function generateChunk(chunkX, chunkZ) {
    const key = `${chunkX},${chunkZ}`;
    if (loadedChunks.has(key)) return;

    const chunkGeometry = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE);
    
    // Simple deterministic pattern for terrain type using the seed
    const isGrass = (chunkX + chunkZ + worldSeed) % 2 === 0;
    const material = isGrass ? grassMaterial : sandMaterial;

    const chunk = new THREE.Mesh(chunkGeometry, material);
    chunk.position.set(chunkX * CHUNK_SIZE, 0, chunkZ * CHUNK_SIZE);
    chunk.rotation.x = -Math.PI / 2;
    chunk.name = key;

    scene.add(chunk);
    loadedChunks.set(key, chunk);
}

function updateChunks() {
    if (!player) return;

    const playerChunkX = Math.round(player.position.x / CHUNK_SIZE);
    const playerChunkZ = Math.round(player.position.z / CHUNK_SIZE);
    const chunksToKeep = new Set();

    // Load chunks in render distance
    for (let x = playerChunkX - RENDER_DISTANCE; x <= playerChunkX + RENDER_DISTANCE; x++) {
        for (let z = playerChunkZ - RENDER_DISTANCE; z <= playerChunkZ + RENDER_DISTANCE; z++) {
            generateChunk(x, z);
            chunksToKeep.add(`${x},${z}`);
        }
    }

    // Unload chunks outside render distance
    for (const [key, chunk] of loadedChunks.entries()) {
        if (!chunksToKeep.has(key)) {
            scene.remove(chunk);
            chunk.geometry.dispose();
            // material is shared, no need to dispose
            loadedChunks.delete(key);
        }
    }
}


function onDocumentMouseDown(event) {
    // This function can be called by both mouse and touch events.
    // We need to prevent default behavior like text selection or page scrolling.
    if (event.preventDefault) {
        event.preventDefault();
    }

    if (!movementEnabled) return;

    // Determine the correct coordinates from either a mouse or touch event.
    let clientX, clientY;
    if (event.clientX !== undefined) {
        // Mouse event
        clientX = event.clientX;
        clientY = event.clientY;
    } else if (event.changedTouches && event.changedTouches.length > 0) {
        // Touch event
        clientX = event.changedTouches[0].clientX;
        clientY = event.changedTouches[0].clientY;
    } else {
        // Not a valid event for our purposes
        return;
    }

    mouse.x = (clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(clientY / window.innerHeight) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);

    const intersects = raycaster.intersectObject(groundPlane);

    if (intersects.length > 0) {
        targetPosition.copy(intersects[0].point);
        targetPosition.y = 0.5; // Keep target y-position same as player height
    }
}

function initMobileControls() {
    const joystickContainer = document.getElementById('joystick-container');
    if (joystickContainer) {
        // This static container is no longer used for the dynamic joystick.
        joystickContainer.style.display = 'none';
    }

    let longPressTimer;
    let joystickActive = false;
    let joystickBase = null;
    let joystickNub = null;
    let touchStartPosition = { x: 0, y: 0 };
    let currentTouch = null;
    const LONG_PRESS_DURATION = 200; // ms
    const JOYSTICK_SIZE = 150; // pixels
    const NUB_SIZE = 60; // pixels

    const onTouchMove = (event) => {
        if (!currentTouch) return;

        // Find the touch that we are tracking
        let movedTouch = null;
        for (let i = 0; i < event.touches.length; i++) {
            if (event.touches[i].identifier === currentTouch.identifier) {
                movedTouch = event.touches[i];
                break;
            }
        }
        if (!movedTouch) return;
        currentTouch = movedTouch;

        if (joystickActive && joystickBase) {
            event.preventDefault(); // Prevent screen scrolling while using joystick

            const deltaX = currentTouch.clientX - touchStartPosition.x;
            const deltaY = currentTouch.clientY - touchStartPosition.y;
            const distance = Math.hypot(deltaX, deltaY);
            const angle = Math.atan2(deltaY, deltaX);

            const maxDistance = (JOYSTICK_SIZE - NUB_SIZE) / 2;
            const clampedDistance = Math.min(distance, maxDistance);

            // Move the nub
            const nubX = clampedDistance * Math.cos(angle);
            const nubY = clampedDistance * Math.sin(angle);
            joystickNub.style.transform = `translate(${nubX}px, ${nubY}px)`;
            
            // Update movement vector
            if (movementEnabled) {
                const force = clampedDistance / maxDistance;
                // We use atan2's angle directly for movement vector.
                // Note: angle for atan2 is different from nipplejs's radian.
                // We need to adjust for the coordinate system.
                joystickVector.x = force * Math.cos(angle);
                joystickVector.y = force * Math.sin(angle);
            }
        }
    };

    const createJoystickUI = () => {
        joystickBase = document.createElement('div');
        joystickBase.style.position = 'absolute';
        joystickBase.style.left = `${touchStartPosition.x - JOYSTICK_SIZE / 2}px`;
        joystickBase.style.top = `${touchStartPosition.y - JOYSTICK_SIZE / 2}px`;
        joystickBase.style.width = `${JOYSTICK_SIZE}px`;
        joystickBase.style.height = `${JOYSTICK_SIZE}px`;
        joystickBase.style.background = 'rgba(0, 255, 0, 0.2)';
        joystickBase.style.borderRadius = '50%';
        joystickBase.style.zIndex = '1000';
        
        joystickNub = document.createElement('div');
        joystickNub.style.position = 'absolute';
        joystickNub.style.left = `${(JOYSTICK_SIZE - NUB_SIZE) / 2}px`;
        joystickNub.style.top = `${(JOYSTICK_SIZE - NUB_SIZE) / 2}px`;
        joystickNub.style.width = `${NUB_SIZE}px`;
        joystickNub.style.height = `${NUB_SIZE}px`;
        joystickNub.style.background = 'rgba(0, 255, 0, 0.5)';
        joystickNub.style.borderRadius = '50%';

        joystickBase.appendChild(joystickNub);
        document.body.appendChild(joystickBase);
    };
    
    const destroyJoystickUI = () => {
        if (joystickBase && document.body.contains(joystickBase)) {
            document.body.removeChild(joystickBase);
        }
        joystickBase = null;
        joystickNub = null;
    };

    renderer.domElement.addEventListener('touchstart', (event) => {
        // Only respond to the first touch
        if (event.touches.length > 1 || joystickActive) return;

        currentTouch = event.touches[0];
        touchStartPosition.x = currentTouch.clientX;
        touchStartPosition.y = currentTouch.clientY;

        renderer.domElement.addEventListener('touchmove', onTouchMove, { passive: false });
        
        longPressTimer = setTimeout(() => {
            longPressTimer = null; // Timer has fired
            joystickActive = true;
            createJoystickUI();

            // Manually trigger the first move event to make it responsive immediately
            onTouchMove({ touches: [currentTouch], preventDefault: () => {} });
        }, LONG_PRESS_DURATION);
    }, { passive: true });

    const endTouch = (event) => {
        // Stop listening to move events for this touch session
        renderer.domElement.removeEventListener('touchmove', onTouchMove);

        if (longPressTimer) {
            // This was a short tap
            clearTimeout(longPressTimer);
            longPressTimer = null;
            
            const touch = event.changedTouches[0];
            const dist = Math.hypot(touch.clientX - touchStartPosition.x, touch.clientY - touchStartPosition.y);
            
            if (dist < 10) { // Only count as a tap if finger hasn't moved much
                onDocumentMouseDown(event);
            }
        }

        // Cleanup joystick if it was active
        if (joystickActive) {
            joystickActive = false;
            joystickVector.set(0, 0);
            destroyJoystickUI();
        }
        currentTouch = null; // Reset the active touch
    };

    renderer.domElement.addEventListener('touchend', endTouch);
    renderer.domElement.addEventListener('touchcancel', endTouch);
}


export function initWorld(canvas) {
    // Scene
    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x000000, 1, 150);

    // Camera
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 50, 0);
    camera.lookAt(0, 0, 0);

    // Renderer
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0x000000);

    // Controls removed for fixed camera

    // Player Character
    const playerGeo = new THREE.BoxGeometry(1, 1, 1);
    const playerMat = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
    player = new THREE.Mesh(playerGeo, playerMat);
    player.position.y = 0.5;
    scene.add(player);
    targetPosition = player.position.clone();

    // Raycasting for movement
    raycaster = new THREE.Raycaster();
    const planeGeo = new THREE.PlaneGeometry(2000, 2000);
    planeGeo.rotateX(- Math.PI / 2);
    const planeMat = new THREE.MeshBasicMaterial({ visible: false });
    groundPlane = new THREE.Mesh(planeGeo, planeMat);
    scene.add(groundPlane);

    // Conditionally add controls based on device type
    const isMobile = 'ontouchstart' in window;
    if (isMobile) {
        initMobileControls();
    } else {
        // Use mousedown for click-to-move, not mousemove.
        renderer.domElement.addEventListener('mousedown', onDocumentMouseDown, false);
    }

    // Post-processing
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const retroPass = new ShaderPass(RetroShader);
    composer.addPass(retroPass);

    // Handle window resize
    window.addEventListener('resize', onWindowResize, false);
    
    updateChunks(); // Initial chunk load
    animate();
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
    requestAnimationFrame(animate);
    
    const delta = clock.getDelta();
    const moveSpeed = 10;

    if (movementEnabled) {
        // Handle joystick movement
        if (joystickVector.length() > 0.01) { // Use a smaller threshold
            // Invert Y for world Z, and since Y from touch is downwards, we need to adjust
            player.position.x += joystickVector.x * moveSpeed * delta;
            player.position.z += joystickVector.y * moveSpeed * delta; 
            targetPosition.copy(player.position); // Sync target to prevent click-move interference
            updateChunks();
        }
        // Handle mouse click-to-move
        else if (player.position.distanceTo(targetPosition) > 0.1) {
            const direction = targetPosition.clone().sub(player.position).normalize();
            player.position.add(direction.multiplyScalar(moveSpeed * delta));
            updateChunks();
        }
    }
    
    // Smoothly move peers towards their target positions
    for (const peer of peers.values()) {
        if (peer.userData.targetPosition) {
            if (peer.position.distanceTo(peer.userData.targetPosition) > 0.01) {
                // Use lerp for smooth movement. The '5 * delta' factor makes it frame-rate independent.
                peer.position.lerp(peer.userData.targetPosition, 5 * delta);
            } else {
                // Snap to final position to avoid tiny movements
                peer.position.copy(peer.userData.targetPosition);
            }
        }
    }
    
    // Update camera to follow player from a fixed top-down perspective
    const cameraOffset = new THREE.Vector3(0, 30, 0.1); // Slight z-offset to ensure lookAt works correctly
    camera.position.copy(player.position).add(cameraOffset);
    camera.lookAt(player.position);

    composer.render();
}