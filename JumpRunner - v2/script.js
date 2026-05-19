import {
  PoseLandmarker,
  FilesetResolver
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

const video = document.getElementById("webcam");
const overlayCanvas = document.getElementById("overlayCanvas");
const overlayCtx = overlayCanvas.getContext("2d");

const gameCanvas = document.getElementById("gameCanvas");
const ctx = gameCanvas.getContext("2d");

const aiStatus = document.getElementById("aiStatus");
const commandText = document.getElementById("commandText");
const scoreText = document.getElementById("scoreText");
const coinText = document.getElementById("coinText");

const calibrateBtn = document.getElementById("calibrateBtn");
const startBtn = document.getElementById("startBtn");
const characterSelect = document.getElementById("characterSelect");
const themeSelect = document.getElementById("themeSelect");

const crouchImages = {
  lucas:  { canvas: null, width: 0, height: 0 },
  tech:   { canvas: null, width: 0, height: 0 },
  ana:    { canvas: null, width: 0, height: 0 },
  junino: { canvas: null, width: 0, height: 0 }
};
// ... O resto do seu código original de carregamento continua abaixo ...

// === FUNÇÃO PARA PROCESSAR SPRITE ÚNICO (REMOVER FUNDO BRANCO) ===
function processSingleSpriteWhiteBackground(img) {
  // Cria um canvas temporário do tamanho da imagem
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  canvas.width = img.width;
  canvas.height = img.height;
  
  // Desenha a imagem original nele
  ctx.drawImage(img, 0, 0);

  // Pega os dados de cada pixel (Red, Green, Blue, Alpha)
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  // LÓGICA DE FUNDO: Loop por todos os pixels
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];     // Red
    const g = data[i + 1]; // Green
    const b = data[i + 2]; // Blue
    const a = data[i + 3]; // Alpha (Transparência)

    const isNearWhite = r > 220 && g > 220 && b > 220;
    const isLightGray =
      r > 200 && g > 200 && b > 200 &&
      Math.abs(r - g) < 20 &&
      Math.abs(g - b) < 20 &&
      Math.abs(r - b) < 20;

    if (isNearWhite || isLightGray) {
      data[i + 3] = 0;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

const difficultySelect = document.getElementById("difficultySelect");
let currentDifficulty = difficultySelect.value;

// Aqui está a magia! O "dicionário" de dificuldades
const difficultySettings = {
  easy: { speedMultiplier: 0.8, gap: 600, aiJumpRequired: 0.015 },
  normal: { speedMultiplier: 1.0, gap: 450, aiJumpRequired: 0.032 },
  hard: { speedMultiplier: 1.4, gap: 320, aiJumpRequired: 0.055 }
};

// Quando o usuário trocar a dificuldade no menu
difficultySelect.addEventListener("change", (event) => {
  currentDifficulty = event.target.value;
});

let poseLandmarker;
let lastVideoTime = -1;
let lastAiRun = 0;
const AI_INTERVAL = 120;

let latestHipY = null;
let baselineHipY = null;
let smoothedHipY = null;
let previousHipY = null;
let hipVelocity = 0;

let baselineAnkleY = null;
let latestAnkleY = null;

let bodyDetected = false;
let calibrationSamples = [];
let isCalibrating = false;

let gameStarted = false;
let gameOver = false;
let score = 0;
let currentLevel = 1;
let distanceTravelled = 0;
let levelComplete = false;
const LEVEL_GOAL = 3000; // Distância para terminar a fase
let coinsCollected = 0;
let jumpCooldown = false;
let crouchRecoveryCooldown = false; // Impede pular sem querer ao levantar

let worldOffset = 0;
let currentTheme = themeSelect.value;
let currentCharacter = characterSelect.value;
let cameraCrouchLocked = false;

let lastFrameTime = performance.now();
let lastStatusText = "";

const groundY = 370;

const player = {
  x: 110,
  y: groundY - 118,

  width: 90,
  height: 118,

  standHeight: 118,
  crouchHeight: 68,

  isCrouching: false,

  velocityY: 0,

  gravity: 1.12,
  jumpForce: -22.5,

  grounded: true
};


const characterConfigs = {
  lucas: {
    imagePaths: ["./assets/lucas.png", "assets/lucas.png"]
  },
  ana: {
    imagePaths: ["./assets/ana.png", "assets/ana.png"]
  },
  junino: {
    imagePaths: ["./assets/junino.png", "assets/junino.png"]
  },
  tech: {
    imagePaths: ["./assets/tech.png", "assets/tech.png"]
  }
};

const spriteSettings = {
  frameCols: 4,
  frameRows: 2,
  totalFrames: 7,  // ← era 6, agora 7
  frameDuration: 0.085
};

const processedSprites = {};

let currentAnimationFrame = 0;
let animationTimer = 0;

const obstacleBlueprints = {
  crate: { width: 42, height: 42 },
  slime: { width: 50, height: 34 },
  robot: { width: 46, height: 56 },
  barrel: { width: 42, height: 48 }
};

let obstacles = [];
let coins = [];

function setStatus(text) {
  if (lastStatusText === text) return;
  lastStatusText = text;
  aiStatus.textContent = text;
}

function playTone(frequency, duration, type = "sine", volume = 0.06) {
  try {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();

    oscillator.type = type;
    oscillator.frequency.value = frequency;
    gain.gain.value = volume;

    oscillator.connect(gain);
    gain.connect(audioContext.destination);

    oscillator.start();

    setTimeout(() => {
      oscillator.stop();
      audioContext.close();
    }, duration);
  } catch (error) {
    console.warn(error);
  }
}

function playJumpSound() {
  playTone(520, 90, "square", 0.04);
}

function playCoinSound() {
  playTone(880, 80, "sine", 0.06);
  setTimeout(() => playTone(1180, 70, "sine", 0.04), 75);
}

function playHitSound() {
  playTone(170, 180, "sawtooth", 0.05);
}

// === FUNÇÃO CREATE OBSTACLE ATUALIZADA ===
function createObstacle(x) {
  // Define os tipos com base no nível atual
  const groundTypes = ["crate", "slime", "robot"];
  const isHard = currentDifficulty === "hard";
  const canFly = currentLevel >= 2;
  const rand = Math.random();

  let type;
  if (isHard && rand < 0.3) {
    type = "ufo";
  } else if (canFly && rand < (isHard ? 0.7 : 0.45)) {
    type = "flying_drone";
  } else {
    type = groundTypes[Math.floor(Math.random() * groundTypes.length)];
  }

  let y, width, height, speedMultiplier;

  switch (type) {
    case "crate":
      y = groundY - 62; width = 60; height = 62; speedMultiplier = 1.0;
      break;
    case "slime":
      y = groundY - 32; width = 55; height = 32; speedMultiplier = 0.9;
      break;
    case "robot":
      y = groundY - 80; width = 50; height = 80; speedMultiplier = 1.1;
      break;
    // --- NOVO OBSTÁCULO VOADOR ---
    case "flying_drone":
      // Física 16-bit: Voa em altura fixa que exige agachar.
      // O Y é calculado para ficar na altura do peito do personagem em pé.
      y = groundY - 120; // Voando alto
      width = 60;
      height = 40;
      speedMultiplier = 1.3; // Drones são um pouco mais rápidos
      break;
    case "ufo":
      y = groundY - 160;
      width = 104;
      height = 52;
      speedMultiplier = 1.35;
      break;
  }

  return { type, x, y, width, height, speed: 7.4 * speedMultiplier, animationFrame: 0, hoverPhase: Math.random() * Math.PI * 2 };
}

function createCoin(startX = 1100) {
  return {
    x: startX,
    y: 220 + Math.random() * 60,
    radius: 12,
    speed: 7.4,
    collected: false,
    spin: Math.random() * Math.PI * 2
  };
}

function resetGameObjects() {
  obstacles = [
    createObstacle(1050),
    createObstacle(1450)
  ];

  coins = [
    createCoin(1200),
    createCoin(1620),
    createCoin(1980)
  ];
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();

    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Erro ao carregar imagem: ${src}`));

    img.src = src;
  });
}

async function loadImageFromPossiblePaths(paths) {
  let lastError = null;

  for (const path of paths) {
    try {
      const image = await loadImage(path);
      return image;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

async function preloadSprites() {
  setStatus("Carregando sprites...");

  for (const key of Object.keys(characterConfigs)) {
    const img = await loadImageFromPossiblePaths(characterConfigs[key].imagePaths);
    processedSprites[key] = processSpriteSheet(img, key); // agachado extraído aqui dentro
  }

  setStatus("Sprites carregados");
}

function processSpriteSheet(image, characterKey) {
  const COLS = 4;
  const ROWS = 2;
  const frameWidth  = Math.floor(image.width / COLS);
  const frameHeight = Math.floor(image.height / ROWS);

  const frames = [];

  // Linha 0: cols 0,1,2,3 — todos são frames de corrida/pulo
  // Linha 1: cols 0,1,2 — corrida, col 3 — agachado
  const runningIndices = [0, 1, 2, 3, 4, 5, 6]; // 7 frames de animação

  for (const i of runningIndices) {
    const col = i % COLS;
    const row = Math.floor(i / COLS);

    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = frameWidth;
    tempCanvas.height = frameHeight;
    const tempCtx = tempCanvas.getContext("2d", { willReadFrequently: true });

    tempCtx.drawImage(
      image,
      col * frameWidth, row * frameHeight,
      frameWidth, frameHeight,
      0, 0,
      frameWidth, frameHeight
    );

    removeLightBackground(tempCanvas, tempCtx);

    // Apaga uma faixa de segurança nas bordas para evitar vazamento do sprite vizinho
   
    frames.push(cropTransparentFrame(tempCanvas, 2));
  }

  // Agachado: col 3, linha 1
  const crouchCanvas = document.createElement("canvas");
  crouchCanvas.width = frameWidth;
  crouchCanvas.height = frameHeight;
  const crouchCtx = crouchCanvas.getContext("2d", { willReadFrequently: true });

  const crouchOffsetX = 12; // ajusta pra direita
const crouchCropWidth = frameWidth - 18;

const sx = (3 * frameWidth) + 25; // anda pra direita
const sy = frameHeight;

const sw = frameWidth - 5; // corta sobra da esquerda
const sh = frameHeight;

crouchCtx.drawImage(
  image,
  sx,
  sy,
  sw,
  sh,
  0,
  0,
  sw,
  sh
);

  removeLightBackground(crouchCanvas, crouchCtx);

  // Mesma faixa de segurança
  crouchCtx.clearRect(0, 0, 8, frameHeight);
  crouchCtx.clearRect(frameWidth - 8, 0, 8, frameHeight);
  crouchCtx.clearRect(0, 0, frameWidth, 8);
  crouchCtx.clearRect(0, frameHeight - 8, frameWidth, 8);

  const crouchCropped = cropTransparentFrame(crouchCanvas, 2);
  crouchImages[characterKey].canvas = crouchCropped.canvas;
  crouchImages[characterKey].width  = crouchCropped.width;
  crouchImages[characterKey].height = crouchCropped.height;

  return frames;
}

function removeLightBackground(canvas, context) {
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    // Só remove branco puro — threshold muito mais conservador
    const isWhite = r > 250 && g > 250 && b > 250;

    // Remove cinza MUITO claro (quase branco), com diferença mínima entre canais
    const isNearWhite =
      r > 235 && g > 235 && b > 235 &&
      Math.abs(r - g) < 8 &&   // ERA 18 — agora muito mais restrito
      Math.abs(g - b) < 8 &&
      Math.abs(r - b) < 8;

    if (isWhite || isNearWhite) {
      data[i + 3] = 0;
    }
  }

  context.putImageData(imageData, 0, 0);
}

function cropTransparentFrame(sourceCanvas, padding = 0) {

  const sourceCtx = sourceCanvas.getContext("2d", {
    willReadFrequently: true
  });

  const imageData = sourceCtx.getImageData(
    0,
    0,
    sourceCanvas.width,
    sourceCanvas.height
  );

  const data = imageData.data;

  let minX = sourceCanvas.width;
  let minY = sourceCanvas.height;
  let maxX = 0;
  let maxY = 0;

  for (let y = 0; y < sourceCanvas.height; y++) {

    for (let x = 0; x < sourceCanvas.width; x++) {

      const index = (y * sourceCanvas.width + x) * 4;

      const alpha = data[index + 3];

      if (alpha > 20) {

        minX = Math.min(minX, x);
        minY = Math.min(minY, y);

        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);

      }

    }

  }

  if (maxX <= minX || maxY <= minY) {

    return {
      canvas: sourceCanvas,
      width: sourceCanvas.width,
      height: sourceCanvas.height
    };

  }

  minX = Math.max(0, minX - padding);
  minY = Math.max(0, minY - padding);

  maxX = Math.min(sourceCanvas.width, maxX + padding);
  maxY = Math.min(sourceCanvas.height, maxY + padding);

  const cropWidth = maxX - minX;
  const cropHeight = maxY - minY;

  const cropCanvas = document.createElement("canvas");

  cropCanvas.width = cropWidth;
  cropCanvas.height = cropHeight;

  const cropCtx = cropCanvas.getContext("2d");

  cropCtx.drawImage(
    sourceCanvas,
    minX,
    minY,
    cropWidth,
    cropHeight,
    0,
    0,
    cropWidth,
    cropHeight
  );

  return {
    canvas: cropCanvas,
    width: cropWidth,
    height: cropHeight
  };
}


async function setupCamera() {
  setStatus("Pedindo câmera...");

  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: 640 },
      height: { ideal: 480 },
      facingMode: "user"
    },
    audio: false
  });

  video.srcObject = stream;

  return new Promise((resolve) => {
    video.onloadedmetadata = () => {
      video.play();
      setStatus("Câmera aberta");
      resolve();
    };
  });
}

async function setupPoseAI() {
  setStatus("Baixando IA...");

  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );

  setStatus("Carregando modelo IA...");

  poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task",
      delegate: "CPU"
    },
    runningMode: "VIDEO",
    numPoses: 1
  });

  setStatus("IA pronta");
}

function drawPoseLine(landmarks, a, b) {
  const pointA = landmarks[a];
  const pointB = landmarks[b];

  if (!pointA || !pointB) return;

  overlayCtx.beginPath();
  overlayCtx.moveTo(pointA.x * overlayCanvas.width, pointA.y * overlayCanvas.height);
  overlayCtx.lineTo(pointB.x * overlayCanvas.width, pointB.y * overlayCanvas.height);
  overlayCtx.stroke();
}

function drawCameraOverlay(results) {
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

  if (!results.landmarks || results.landmarks.length === 0) {
    bodyDetected = false;
    setStatus("Corpo não detectado");
    return;
  }

  bodyDetected = true;
  setStatus("Corpo detectado");

  const landmarks = results.landmarks[0];

  overlayCtx.fillStyle = "#ffd166";
  overlayCtx.strokeStyle = "#6ee7d8";
  overlayCtx.lineWidth = 2;

  const pointsToDraw = [11, 12, 23, 24, 25, 26, 27, 28];

  for (const index of pointsToDraw) {
    const point = landmarks[index];
    if (!point) continue;

    overlayCtx.beginPath();
    overlayCtx.arc(
      point.x * overlayCanvas.width,
      point.y * overlayCanvas.height,
      4,
      0,
      Math.PI * 2
    );
    overlayCtx.fill();
  }

  drawPoseLine(landmarks, 11, 12);
  drawPoseLine(landmarks, 11, 23);
  drawPoseLine(landmarks, 12, 24);
  drawPoseLine(landmarks, 23, 24);
  drawPoseLine(landmarks, 23, 25);
  drawPoseLine(landmarks, 24, 26);
  drawPoseLine(landmarks, 25, 27);
  drawPoseLine(landmarks, 26, 28);
}

function hasIncomingUfo() {
  return obstacles.some((obstacle) => {
    return (
      obstacle.type === "ufo" &&
      obstacle.x + obstacle.width > player.x - 20 &&
      obstacle.x < player.x + player.width + 110
    );
  });
}

function updateBodyMovement(results) {
  if (!results.landmarks || results.landmarks.length === 0) {
    latestHipY = null;
    latestAnkleY = null;
    commandText.textContent = "Sem corpo";
    return;
  }

  const landmarks = results.landmarks[0];
  const leftHip = landmarks[23];
  const rightHip = landmarks[24];
  const leftAnkle = landmarks[27];
  const rightAnkle = landmarks[28];

  if (!leftHip || !rightHip || !leftAnkle || !rightAnkle) return;

  const rawHipY = (leftHip.y + rightHip.y) / 2;
  const rawAnkleY = (leftAnkle.y + rightAnkle.y) / 2;

  // Suavização do movimento
  if (smoothedHipY === null) {
    smoothedHipY = rawHipY;
  } else {
    smoothedHipY = smoothedHipY * 0.62 + rawHipY * 0.38;
  }

  if (previousHipY !== null) {
    hipVelocity = previousHipY - smoothedHipY;
  }

  previousHipY = smoothedHipY;
  latestHipY = smoothedHipY;
  latestAnkleY = rawAnkleY;

  // Se estiver contando os 3 segundos, a IA ignora os pulos/agachamentos
  if (isCalibrating) {
    return;
  }

  if (!baselineHipY || !baselineAnkleY) {
    commandText.textContent = "Calibre";
    return;
  }

  // Diferença do corpo em relação à posição inicial calibrada
  const hipRise = baselineHipY - latestHipY;
  const ankleRise = baselineAnkleY - latestAnkleY;

  // --- LÓGICA DE PULO ---
  const requiredHipRise = difficultySettings[currentDifficulty].aiJumpRequired;
  const requiredAnkleRise = 0.018;
  const requiredVelocity = 0.006;

  const bodyWentUpEnough = hipRise > requiredHipRise;
  const feetWentUpEnough = ankleRise > requiredAnkleRise;
  const bodyMovedUpFast = hipVelocity > requiredVelocity;

  const jumped = bodyWentUpEnough && feetWentUpEnough && bodyMovedUpFast;

  // --- LÓGICA DE AGACHAR ---
  const crouchStartThreshold = -0.02;
  const crouchKeepThreshold = -0.006;
  const bodyWentDownEnough = hipRise < crouchStartThreshold;
  const bodyStillDown = hipRise < crouchKeepThreshold;

  if (bodyWentDownEnough && player.grounded && !isCalibrating) {
    crouchPlayer();
    cameraCrouchLocked = hasIncomingUfo();
    commandText.textContent = "AGACHOU!";
    commandText.style.color = "#6ee7d8";
  } else if (player.isCrouching && !bodyStillDown && !cameraCrouchLocked) {
    standPlayer();
    crouchRecoveryCooldown = true;

    setTimeout(() => {
      crouchRecoveryCooldown = false;
    }, 600);
  }

  if (cameraCrouchLocked && !hasIncomingUfo()) {
    cameraCrouchLocked = false;
  }

  if (player.isCrouching && cameraCrouchLocked) {
    commandText.textContent = "AGACHADO";
    commandText.style.color = "#6ee7d8";
  }

  // Verifica se pulou (Mas SÓ PULA se não estiver no cooldown de recuperação do agachamento)
  if (jumped && !jumpCooldown && !crouchRecoveryCooldown && player.grounded && gameStarted && !gameOver) {
    commandText.textContent = "PULO";
    commandText.style.color = "#ffffff";
    jumpPlayer();

    jumpCooldown = true;
    setTimeout(() => {
      jumpCooldown = false;
    }, 520);
  } else if (gameStarted && !gameOver && !bodyWentUpEnough && !player.isCrouching) {
    commandText.textContent = "Pronto";
    commandText.style.color = "#ffffff";
  }
}

function predictWebcam() {
  const now = performance.now();

  if (
    poseLandmarker &&
    video.readyState >= 2 &&
    video.currentTime !== lastVideoTime &&
    now - lastAiRun >= AI_INTERVAL
  ) {
    lastAiRun = now;
    lastVideoTime = video.currentTime;

    const results = poseLandmarker.detectForVideo(video, now);
    drawCameraOverlay(results);
    updateBodyMovement(results);
  }

  requestAnimationFrame(predictWebcam);
}

function calibratePosition() {
  document.activeElement.blur(); // Tira o foco do botão

  if (!bodyDetected || latestHipY === null || latestAnkleY === null) {
    alert("Fique de corpo inteiro na frente da câmera antes de calibrar.");
    return;
  }

  isCalibrating = true;
  let countdown = 3; // 3 segundos para você ir para trás e se posicionar
  
  setStatus(`Posicione-se! Calibrando em ${countdown}...`);
  commandText.textContent = countdown;
  commandText.style.color = "#ff9f43"; // Fica laranja durante a contagem
  
  const countdownInterval = setInterval(() => {
    countdown--;
    
    if (countdown > 0) {
      setStatus(`Posicione-se! Calibrando em ${countdown}...`);
      commandText.textContent = countdown;
    } else {
      // Quando chega no zero, faz a calibração de verdade!
      clearInterval(countdownInterval);
      
      // Define a linha de base com você já posicionado no fundo
      baselineHipY = latestHipY;
      baselineAnkleY = latestAnkleY;
      
      // "Limpa" qualquer movimento que tenha acontecido enquanto andava para trás
      smoothedHipY = latestHipY;
      previousHipY = latestHipY;
      hipVelocity = 0;
      
      setStatus("Calibrado e pronto!");
      commandText.textContent = "PRONTO!";
      commandText.style.color = "#60df8b"; // Fica verde
      
      isCalibrating = false;
      
      // Limpa o texto de "PRONTO!" depois de 1 segundo
      setTimeout(() => {
        if (commandText.textContent === "PRONTO!") {
          commandText.textContent = "";
          commandText.style.color = "#ffffff";
        }
      }, 1000);
    }
  }, 1000); // Roda a cada 1 segundo
}
function startGame() {
  document.activeElement.blur();
  playTone(1, 1, "sine", 0.001);

  gameStarted = true;
  gameOver = false;
  score = 0;
  coinsCollected = 0;
  worldOffset = 0;
  distanceTravelled = 0;
  currentLevel = 1;     
  levelComplete = false;
  currentAnimationFrame = 0;
  animationTimer = 0;

  player.y = groundY - player.height;
  player.velocityY = 0;
  player.grounded = true;
  player.isCrouching = false;
  player.height = player.standHeight;

  resetGameObjects();

  scoreText.textContent = score;
  coinText.textContent = coinsCollected;
  commandText.textContent = "Jogo iniciado";
}

function setPlayerHeight(newHeight) {
  const bottomY = player.y + player.height;
  player.height = newHeight;
  player.y = bottomY - player.height;
}

function crouchPlayer() {
  if (!player.isCrouching && player.grounded) {
    player.isCrouching = true;
    setPlayerHeight(player.crouchHeight);
  }
}

function standPlayer() {
  if (player.isCrouching) {
    player.isCrouching = false;
    setPlayerHeight(player.standHeight);
  }
}

function jumpPlayer() {
  if (!gameStarted || gameOver) return;

  if (player.grounded) {
    player.velocityY = player.jumpForce;
    player.grounded = false;
    playJumpSound();
  }
}

function updatePlayerAnimation(deltaSeconds) {
  if (!gameStarted || gameOver) return;

  animationTimer += deltaSeconds;

  const duration = player.grounded ? spriteSettings.frameDuration : 0.11;

  if (animationTimer >= duration) {
    animationTimer = 0;

    if (player.grounded) {
      currentAnimationFrame = (currentAnimationFrame + 1) % spriteSettings.totalFrames;
    } else {
      currentAnimationFrame = 2;
    }
  }
}

function updateGame(timeScale, deltaSeconds) {
  updatePlayerAnimation(deltaSeconds);

  if (!gameStarted || gameOver || levelComplete) return;

  // VELOCIDADE BASEADA NA DIFICULDADE
  const diffSpeed = difficultySettings[currentDifficulty].speedMultiplier;

  worldOffset += (3.4 * diffSpeed) * timeScale;
  distanceTravelled += (3.4 * diffSpeed) * timeScale;

  // GRAVIDADE
  player.velocityY += player.gravity * timeScale;
  player.y += player.velocityY * timeScale;

  if (player.velocityY > 22) {
    player.velocityY = 22;
  }

  const floorY = groundY - player.height;

  // COLISÃO COM O CHÃO
  if (player.y >= floorY) {
    player.y = floorY;
    player.velocityY = 0;
    player.grounded = true;
  } else {
    player.grounded = false;
  }

  updateObstacles(timeScale);
  updateCoins(timeScale);

  // SCORE
  score += Math.round(1 * diffSpeed * timeScale);
  scoreText.textContent = score;
}

function updateObstacles(timeScale) {
  for (const obstacle of obstacles) {
    obstacle.x -= obstacle.speed * timeScale;
    if (obstacle.type === "ufo") {
      obstacle.hoverPhase += 0.07 * timeScale;
    }

    // Quando o obstáculo sai da tela pela esquerda:
    if (obstacle.x + obstacle.width < 0) {
      
      // 1. Descobre onde está o obstáculo mais longe à direita
      let ultimoX = 1100;
      for (const outroObs of obstacles) {
        if (outroObs.x > ultimoX) {
          ultimoX = outroObs.x;
        }
      }
      
      // 2. O novo obstáculo vai nascer APÓS o último obstáculo, com um respiro.
      // O '450' é a distância mínima segura para você conseguir pular, cair e pular de novo.
      // O '+ Math.random() * 350' adiciona uma distância extra aleatória para não ficar previsível.
      const novoX = ultimoX + 450 + (Math.random() * 350);
      
      Object.assign(obstacle, createObstacle(novoX));
      
      score += 100;
      scoreText.textContent = score;
    }

    if (checkCollision(player, obstacle)) {
      gameOver = true;
      commandText.textContent = "Game Over";
      playHitSound();
    }
  }
}

function updateCoins(timeScale) {
  for (const coin of coins) {
    coin.x -= coin.speed * timeScale;
    coin.spin += 0.18 * timeScale;

    if (coin.x + coin.radius < 0 || coin.collected) {
      Object.assign(coin, createCoin(1100 + Math.random() * 700));
      coin.collected = false;
    }

    if (checkCircleRectCollision(coin, player)) {
      coin.collected = true;
      coinsCollected += 1;
      score += 250;

      coinText.textContent = coinsCollected;
      scoreText.textContent = score;

      playCoinSound();
    }
  }
}

function checkCollision(a, b) {
  const paddingX = 18;
  const paddingY = a === player && a.isCrouching ? 6 : 12;

  return (
    a.x + paddingX < b.x + b.width &&
    a.x + a.width - paddingX > b.x &&
    a.y + paddingY < b.y + b.height &&
    a.y + a.height - paddingY > b.y
  );
}

function checkCircleRectCollision(circle, rect) {
  const closestX = Math.max(rect.x, Math.min(circle.x, rect.x + rect.width));
  const closestY = Math.max(rect.y, Math.min(circle.y, rect.y + rect.height));

  const distanceX = circle.x - closestX;
  const distanceY = circle.y - closestY;

  return distanceX * distanceX + distanceY * distanceY < circle.radius * circle.radius;
}

function drawGame(now = performance.now()) {
  const deltaMs = now - lastFrameTime;
  lastFrameTime = now;

  const deltaSeconds = deltaMs / 1000;
  const timeScale = Math.min(deltaMs / 16.67, 2);

  updateGame(timeScale, deltaSeconds);

  ctx.clearRect(0, 0, gameCanvas.width, gameCanvas.height);

  drawBackground();
  drawCoins();
  drawPlayerSprite();
  drawObstacles();
  drawHud();

  requestAnimationFrame(drawGame);
}

function getThemeColors() {
  if (currentTheme === "night") {
    // Dentro da function getThemeColors(), mude o return padrão para:
  return {
    skyTop: "#5c94fc",    // Azul céu do Mario
    skyBottom: "#5c94fc", // Azul céu do Mario
    horizon: "#5c94fc",   // Azul céu do Mario
    hill: "#00a800",      // Verde das montanhas/canos
    grass: "#00a800",     // Verde da grama
    ground: "#c84c0c",    // Marrom/Laranja dos blocos do chão
    sun: "#facc15",
    cloud: "rgba(255,255,255,1)" // Nuvens sólidas (sem transparência)
  };
  }

  if (currentTheme === "junina") {
    return {
      skyTop: "#4b86c6",
      skyBottom: "#ffd6a5",
      horizon: "#6bbf8a",
      hill: "#69b765",
      grass: "#4caf50",
      ground: "#8a5a2b",
      sun: "#ffd166",
      cloud: "rgba(255,255,255,0.95)"
    };
  }

  return {
    skyTop: "#7fd3ff",
    skyBottom: "#d8f1ff",
    horizon: "#7ab0d4",
    hill: "#83c85d",
    grass: "#5cbc52",
    ground: "#8a5a2b",
    sun: "#ffd166",
    cloud: "rgba(255,255,255,0.95)"
  };
}

function drawBackground() {
  const colors = getThemeColors();

  const sky = ctx.createLinearGradient(0, 0, 0, gameCanvas.height);
  sky.addColorStop(0, colors.skyTop);
  sky.addColorStop(0.58, colors.skyBottom);
  sky.addColorStop(0.59, "#9be06e");
  sky.addColorStop(1, "#5fa84d");

  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, gameCanvas.width, gameCanvas.height);

  drawSunOrMoon(colors);
  drawCloudLoop(colors);
  drawMountains(colors);
  drawHills(colors);
  drawThemeDecoration();
  drawGround(colors);
}

function drawSunOrMoon(colors) {
  ctx.fillStyle = colors.sun;
  ctx.beginPath();
  ctx.arc(840, 90, 38, 0, Math.PI * 2);
  ctx.fill();

  if (currentTheme === "night") {
    ctx.fillStyle = "rgba(16,24,61,0.9)";
    ctx.beginPath();
    ctx.arc(855, 78, 31, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#ffffff";
    for (let i = 0; i < 18; i++) {
      const x = (i * 73 + 40) % 1000;
      const y = 35 + ((i * 41) % 140);
      ctx.fillRect(x, y, 2, 2);
    }
  }
}

function drawCloudLoop(colors) {
  drawCloud(120 - (worldOffset * 0.18 % 1100), 75, 1, colors.cloud);
  drawCloud(430 - (worldOffset * 0.12 % 1100), 112, 0.9, colors.cloud);
  drawCloud(780 - (worldOffset * 0.2 % 1200), 70, 1.1, colors.cloud);
  drawCloud(1120 - (worldOffset * 0.18 % 1100), 82, 1, colors.cloud);
}

function drawCloud(x, y, scale = 1, color = "rgba(255,255,255,0.95)") {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, 18 * scale, 0, Math.PI * 2);
  ctx.arc(x + 22 * scale, y - 8 * scale, 22 * scale, 0, Math.PI * 2);
  ctx.arc(x + 48 * scale, y, 18 * scale, 0, Math.PI * 2);
  ctx.arc(x + 24 * scale, y + 8 * scale, 20 * scale, 0, Math.PI * 2);
  ctx.fill();
}

function drawMountains(colors) {
  ctx.fillStyle = colors.horizon;

  drawMountain(50 - (worldOffset * 0.08 % 1100), 250, 190, 150);
  drawMountain(220 - (worldOffset * 0.08 % 1100), 250, 240, 160);
  drawMountain(440 - (worldOffset * 0.08 % 1100), 250, 210, 140);
  drawMountain(640 - (worldOffset * 0.08 % 1100), 250, 220, 150);
  drawMountain(830 - (worldOffset * 0.08 % 1100), 250, 190, 140);
  drawMountain(1100 - (worldOffset * 0.08 % 1100), 250, 240, 160);
}

function drawMountain(x, y, width, height) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + width / 2, y - height);
  ctx.lineTo(x + width, y);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "rgba(255,255,255,0.28)";
  ctx.beginPath();
  ctx.moveTo(x + width / 2, y - height);
  ctx.lineTo(x + width / 2 + 26, y - height + 45);
  ctx.lineTo(x + width / 2 - 24, y - height + 45);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = getThemeColors().horizon;
}

function drawHills(colors) {
  ctx.fillStyle = colors.hill;

  for (let i = 0; i < 7; i++) {
    const x = i * 240 - (worldOffset * 0.45 % 240);
    ctx.beginPath();
    ctx.arc(x, 335, 135, Math.PI, 0);
    ctx.fill();
  }

  drawBush(120 - (worldOffset * 1.3 % 1100), 337);
  drawBush(310 - (worldOffset * 1.3 % 1100), 337);
  drawBush(540 - (worldOffset * 1.3 % 1100), 337);
  drawBush(790 - (worldOffset * 1.3 % 1100), 337);
  drawBush(1000 - (worldOffset * 1.3 % 1100), 337);
}

function drawBush(x, y) {
  ctx.fillStyle = "#48a145";
  ctx.beginPath();
  ctx.arc(x, y, 18, Math.PI, 0);
  ctx.arc(x + 18, y - 5, 20, Math.PI, 0);
  ctx.arc(x + 40, y, 18, Math.PI, 0);
  ctx.fill();

  ctx.fillStyle = "#6ed164";
  ctx.fillRect(x + 10, y - 10, 6, 6);
  ctx.fillRect(x + 28, y - 16, 6, 6);
}

function drawThemeDecoration() {
  if (currentTheme !== "junina") return;

  const y = 44;

  ctx.strokeStyle = "rgba(255,255,255,0.75)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(gameCanvas.width, y + 22);
  ctx.stroke();

  const colors = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7"];

  for (let i = 0; i < 26; i++) {
    const x = i * 42 - (worldOffset * 0.25 % 42);
    ctx.fillStyle = colors[i % colors.length];

    ctx.beginPath();
    ctx.moveTo(x, y + 5);
    ctx.lineTo(x + 16, y + 5);
    ctx.lineTo(x + 8, y + 25);
    ctx.closePath();
    ctx.fill();
  }
}

function drawGround(colors) {
  ctx.fillStyle = colors.ground;
  ctx.fillRect(0, groundY, gameCanvas.width, 90);

  ctx.fillStyle = colors.grass;
  ctx.fillRect(0, groundY - 10, gameCanvas.width, 12);

  for (let i = 0; i < 32; i++) {
    const tileX = i * 38 - (worldOffset % 38);

    ctx.fillStyle = i % 2 === 0 ? "#a66a36" : "#9a6232";
    ctx.fillRect(tileX, groundY + 8, 36, 24);

    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.fillRect(tileX + 4, groundY + 12, 10, 4);
  }
}

// === FUNÇÃO PARA DESENHAR O DRONE VOADOR ===
function drawFlyingDrone(obstacle) {

  obstacle.animationFrame += 0.2;

  const pulse =
    Math.sin(obstacle.animationFrame) * 2;

  ctx.save();

  ctx.shadowBlur = 18;
  ctx.shadowColor = "#00f2ff";

  // CORPO
  ctx.fillStyle = "#222";

  ctx.fillRect(
    obstacle.x,
    obstacle.y,
    obstacle.width,
    obstacle.height
  );

  // BORDA
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 2;

  ctx.strokeRect(
    obstacle.x,
    obstacle.y,
    obstacle.width,
    obstacle.height
  );

  // OLHO
  ctx.fillStyle = "#00f2ff";

  ctx.fillRect(
    obstacle.x + 16,
    obstacle.y + 10,
    16 + pulse,
    16
  );

  // HÉLICE ESQUERDA
  ctx.fillStyle = "#ff2d55";

  ctx.fillRect(
    obstacle.x - 8,
    obstacle.y + 8,
    8,
    24
  );

  // HÉLICE DIREITA
  ctx.fillRect(
    obstacle.x + obstacle.width,
    obstacle.y + 8,
    8,
    24
  );

  ctx.restore();
}

function drawPlayerSprite() {
  let frameCanvas = null;
  let frameWidth = 0;
  let frameHeight = 0;
  let isCrouchSprite = false;

  if (player.isCrouching) {
    const crouchData = crouchImages[currentCharacter];
    if (crouchData && crouchData.canvas) {
      frameCanvas = crouchData.canvas;
      frameWidth = crouchData.width;
      frameHeight = crouchData.height;
      isCrouchSprite = true;
    }
  }

  if (!frameCanvas) {
    const frames = processedSprites[currentCharacter];
    if (!frames || !frames[currentAnimationFrame]) return;
    const frame = frames[currentAnimationFrame];
    frameCanvas = frame.canvas;
    frameWidth = frame.width;
    frameHeight = frame.height;
  }

  const drawHeight = isCrouchSprite ? player.crouchHeight : player.standHeight;
  const scale = drawHeight / frameHeight;
  const drawWidth = frameWidth * scale;

  const drawX = player.x + (player.width / 2) - (drawWidth / 2);
  const drawY = player.y + player.height - drawHeight;

  ctx.fillStyle = "rgba(0,0,0,0.22)";
  ctx.beginPath();
  ctx.ellipse(player.x + player.width / 2, groundY + 5, player.grounded ? 42 : 28, 8, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.drawImage(frameCanvas, drawX, drawY, drawWidth, drawHeight);
}

function drawUfo(obstacle) {
  const floatY = obstacle.y + Math.sin(obstacle.hoverPhase) * 6;
  const centerX = obstacle.x + obstacle.width / 2;
  const centerY = floatY + obstacle.height / 2;

  ctx.save();
  ctx.shadowBlur = 10;
  ctx.shadowColor = "rgba(255,255,255,0.4)";

  // Corpo metálico
  ctx.fillStyle = "#9ca3af";
  ctx.beginPath();
  ctx.ellipse(centerX, floatY + 18, obstacle.width * 0.9, obstacle.height * 0.75, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#d1d5db";
  ctx.beginPath();
  ctx.ellipse(centerX, floatY + 8, obstacle.width * 0.7, obstacle.height * 0.55, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#111827";
  ctx.beginPath();
  ctx.ellipse(centerX, floatY + 8, obstacle.width * 0.22, obstacle.height * 0.18, 0, 0, Math.PI * 2);
  ctx.fill();

  // Lâmpada central e olhos
  ctx.fillStyle = "#facc15";
  ctx.beginPath();
  ctx.arc(centerX - 22, floatY + 6, 6, 0, Math.PI * 2);
  ctx.arc(centerX + 22, floatY + 6, 6, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#38bdf8";
  ctx.beginPath();
  ctx.arc(centerX, floatY + 20, 12, 0, Math.PI, true);
  ctx.fill();

  ctx.fillStyle = "rgba(255,255,255,0.42)";
  for (let i = 0; i < 5; i++) {
    ctx.beginPath();
    ctx.arc(obstacle.x + 14 + i * 12, floatY + 30, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

function drawObstacles() {
  for (const obstacle of obstacles) {
    if (obstacle.type === "crate") drawCrate(obstacle);
    if (obstacle.type === "slime") drawSlime(obstacle);
    if (obstacle.type === "robot") drawRobot(obstacle);
    if (obstacle.type === "barrel") drawBarrel(obstacle);
    if (obstacle.type === "flying_drone") drawFlyingDrone(obstacle);
    if (obstacle.type === "ufo") drawUfo(obstacle);
    
    // Adicione a Bandeira/Escada
    if (obstacle.type === "bandeira") {
       // Desenha a escadinha (base)
       ctx.fillStyle = "#8a5a2b";
       ctx.fillRect(obstacle.x - 60, groundY - 40, 100, 40); // Degrau 1
       ctx.fillRect(obstacle.x - 20, groundY - 80, 60, 40);  // Degrau 2
       ctx.fillRect(obstacle.x + 20, groundY - 120, 20, 40); // Degrau 3
       
       // Mastro
       ctx.fillStyle = "#fff";
       ctx.fillRect(obstacle.x + 30, groundY - 220, 6, 100); 
       
       // Bandeira
       ctx.fillStyle = "#22c55e"; // Verde
       ctx.beginPath();
       ctx.moveTo(obstacle.x + 36, groundY - 220);
       ctx.lineTo(obstacle.x + 70, groundY - 200);
       ctx.lineTo(obstacle.x + 36, groundY - 180);
       ctx.fill();
    }
  }
}

function drawCrate(obstacle) {
  ctx.fillStyle = "#b7793f";
  ctx.fillRect(obstacle.x, obstacle.y, obstacle.width, obstacle.height);

  ctx.strokeStyle = "#7c4a21";
  ctx.lineWidth = 3;
  ctx.strokeRect(obstacle.x, obstacle.y, obstacle.width, obstacle.height);

  ctx.beginPath();
  ctx.moveTo(obstacle.x + 6, obstacle.y + 6);
  ctx.lineTo(obstacle.x + obstacle.width - 6, obstacle.y + obstacle.height - 6);
  ctx.moveTo(obstacle.x + obstacle.width - 6, obstacle.y + 6);
  ctx.lineTo(obstacle.x + 6, obstacle.y + obstacle.height - 6);
  ctx.stroke();
}

function drawSlime(obstacle) {
  ctx.fillStyle = "#00a8ff"; // <-- Mudou de verde para Azul Neon
  ctx.beginPath();
  ctx.moveTo(obstacle.x, obstacle.y + obstacle.height);
  // ... o resto da função continua exatamente igual ...
  ctx.quadraticCurveTo(
    obstacle.x + obstacle.width / 2,
    obstacle.y - 8,
    obstacle.x + obstacle.width,
    obstacle.y + obstacle.height
  );
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "rgba(255,255,255,0.25)";
  ctx.beginPath();
  ctx.arc(obstacle.x + 16, obstacle.y + 8, 8, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#111827";
  ctx.fillRect(obstacle.x + 13, obstacle.y + 13, 4, 4);
  ctx.fillRect(obstacle.x + 29, obstacle.y + 13, 4, 4);
}

function drawRobot(obstacle) {
  ctx.fillStyle = "#cbd5e1";
  ctx.fillRect(obstacle.x + 4, obstacle.y + 10, obstacle.width - 8, obstacle.height - 10);

  ctx.fillStyle = "#94a3b8";
  ctx.fillRect(obstacle.x + 10, obstacle.y, obstacle.width - 20, 10);

  ctx.fillStyle = "#111827";
  ctx.fillRect(obstacle.x + 12, obstacle.y + 18, 5, 5);
  ctx.fillRect(obstacle.x + 26, obstacle.y + 18, 5, 5);

  ctx.strokeStyle = "#64748b";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(obstacle.x + obstacle.width / 2, obstacle.y);
  ctx.lineTo(obstacle.x + obstacle.width / 2, obstacle.y - 8);
  ctx.stroke();

  ctx.fillStyle = "#ef4444";
  ctx.beginPath();
  ctx.arc(obstacle.x + obstacle.width / 2, obstacle.y - 10, 3, 0, Math.PI * 2);
  ctx.fill();
}

function drawBarrel(obstacle) {
  ctx.fillStyle = "#8b5a2b";
  ctx.fillRect(obstacle.x + 4, obstacle.y, obstacle.width - 8, obstacle.height);

  ctx.fillStyle = "#5b3717";
  ctx.fillRect(obstacle.x + 4, obstacle.y + 8, obstacle.width - 8, 5);
  ctx.fillRect(obstacle.x + 4, obstacle.y + 22, obstacle.width - 8, 5);
  ctx.fillRect(obstacle.x + 4, obstacle.y + 36, obstacle.width - 8, 5);

  ctx.strokeStyle = "#c28b50";
  ctx.lineWidth = 2;
  ctx.strokeRect(obstacle.x + 4, obstacle.y, obstacle.width - 8, obstacle.height);
}

function drawCoins() {
  for (const coin of coins) {
    if (coin.collected) continue;

    const width = Math.abs(Math.cos(coin.spin)) * 16 + 4;

    ctx.fillStyle = "#facc15";
    ctx.beginPath();
    ctx.ellipse(coin.x, coin.y, width / 2, coin.radius, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "#ca8a04";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillRect(coin.x - 3, coin.y - 7, 3, 7);
  }
}

function drawHud() {
  ctx.fillStyle = "rgba(0,0,0,0.28)";
  ctx.fillRect(18, 18, 320, 70);

  ctx.fillStyle = "#ffffff";
  ctx.font = "22px Arial";
  ctx.fillText("JUMPER RUNNER", 34, 50);

  ctx.fillStyle = "#ffd166";
  ctx.font = "14px Arial";
  ctx.fillText("Câmera como controle • Pule para jogar", 34, 70);

  drawCharacterMiniatures();

  if (!gameStarted) {
    drawStartOverlay();
  }

  if (gameOver) {
    drawGameOverOverlay();
  }
}

function drawCharacterMiniatures() {
  const startX = 760;
  const y = 22;
  const keys = Object.keys(characterConfigs);

  ctx.fillStyle = "rgba(0,0,0,0.24)";
  ctx.fillRect(startX - 12, 14, 220, 56);

  keys.forEach((key, index) => {
    const x = startX + index * 48;
    const frames = processedSprites[key];

    ctx.fillStyle = key === currentCharacter ? "#ffd166" : "rgba(255,255,255,0.32)";
    ctx.fillRect(x - 4, y - 4, 38, 38);

    if (!frames || !frames[0]) return;

    ctx.drawImage(frames[0].canvas, x, y, 30, 30);
  });
}

function drawStartOverlay() {
  ctx.fillStyle = "rgba(6, 12, 28, 0.56)";
  ctx.fillRect(0, 0, gameCanvas.width, gameCanvas.height);

  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 46px Arial";
  ctx.fillText("JUMPER RUNNER", 265, 160);

  ctx.fillStyle = "#ffd166";
  ctx.font = "bold 24px Arial";
  ctx.fillText("Pule na frente da câmera para controlar o personagem", 205, 205);

  ctx.fillStyle = "#e5edff";
  ctx.font = "19px Arial";
  ctx.fillText("1. Calibre sua posição  •  2. Inicie o jogo  •  3. Pule para desviar", 190, 250);

  ctx.fillStyle = "rgba(255,255,255,0.14)";
  ctx.fillRect(290, 285, 420, 58);

  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 22px Arial";
  ctx.fillText("Plano B: pressione ESPAÇO", 360, 322);
}

function drawGameOverOverlay() {
  ctx.fillStyle = "rgba(6, 12, 28, 0.70)";
  ctx.fillRect(0, 0, gameCanvas.width, gameCanvas.height);

  ctx.fillStyle = "#ff5f6d";
  ctx.font = "bold 56px Arial";
  ctx.fillText("GAME OVER", 318, 175);

  ctx.fillStyle = "#ffffff";
  ctx.font = "22px Arial";
  ctx.fillText(`Pontuação: ${score}  •  Moedas: ${coinsCollected}`, 330, 220);

  ctx.fillStyle = "#ffd166";
  ctx.font = "18px Arial";
  ctx.fillText("Clique em Iniciar jogo para tentar novamente", 300, 258);
}


characterSelect.addEventListener("change", (event) => {
  currentCharacter = event.target.value;
});

themeSelect.addEventListener("change", (event) => {
  currentTheme = event.target.value;
});

calibrateBtn.addEventListener("click", calibratePosition);
startBtn.addEventListener("click", startGame);

async function main() {
  try {
    resetGameObjects();
    drawGame();

    await preloadSprites();
    await setupCamera();
    await setupPoseAI();

    predictWebcam();
  } catch (error) {
    console.error("Erro no projeto:", error);
    setStatus("Erro no projeto");

    alert(
      "Erro no projeto:\n\n" +
      error.message +
      "\n\nVeja se as imagens estão na pasta /assets e se o Live Server está rodando na pasta correta."
    );
  }
}

main();

// QUANDO APERTA A TECLA
document.addEventListener("keydown", (event) => {
  // PULAR: Espaço ou Seta para Cima
  if (event.code === "Space" || event.code === "ArrowUp") {
    event.preventDefault();
    if (!player.isCrouching) jumpPlayer(); // Só pula se NÃO estiver agachado
  }

  // INICIAR JOGO: Enter
  if (event.code === "Enter") {
    event.preventDefault();
    startGame();
  }

  // AGACHAR: Seta para Baixo ou Letra C
  if (event.code === "ArrowDown" || event.code === "KeyC") {
    event.preventDefault();
    crouchPlayer();
  }
});

// QUANDO SOLTA A TECLA (Para ele levantar)
document.addEventListener("keyup", (event) => {
  // LEVANTAR: Seta para Baixo ou Letra C
  if (event.code === "ArrowDown" || event.code === "KeyC") {
    event.preventDefault();
    standPlayer();
  }
});

// === SISTEMA DE DOIS MONITORES ===
const popOutBtn = document.getElementById('popOutCamBtn');

if (popOutBtn) {
  popOutBtn.addEventListener('click', () => {
    // Abre uma janela nova de 800x600
    const camWindow = window.open("", "CameraWindow", "width=800,height=600");
    
    // Configura o visual escuro e em tela cheia da nova janela
    camWindow.document.write(`
      <html lang="pt-BR">
      <head>
        <title>Câmera AI - Jumper Runner</title>
        <style>
          body { margin: 0; background: #000; display: flex; justify-content: center; align-items: center; height: 100vh; overflow: hidden; }
          .cam-container { position: relative; width: 100%; height: 100%; display: flex; justify-content: center; align-items: center; }
          video, canvas { position: absolute; max-width: 100%; max-height: 100%; object-fit: contain; transform: scaleX(-1); }
        </style>
      </head>
      <body>
        <div class="cam-container" id="newCamBox"></div>
      </body>
      </html>
    `);

    // Move os elementos de vídeo e IA (canvas) para a nova tela
    const newBox = camWindow.document.getElementById('newCamBox');
    const oldBox = document.querySelector('.camera-box');
    const videoEl = document.getElementById('webcam');
    const overlayEl = document.getElementById('overlayCanvas');
    
    newBox.appendChild(videoEl);
    newBox.appendChild(overlayEl);
    
    // Esconde a caixinha preta que ficou vazia na tela principal
    oldBox.style.display = 'none';
    popOutBtn.textContent = 'Câmera aberta em outra tela';
    popOutBtn.disabled = true;

    // Se você fechar o 2º monitor, a câmera volta automaticamente pro jogo principal!
    camWindow.addEventListener('beforeunload', () => {
      oldBox.appendChild(videoEl);
      oldBox.appendChild(overlayEl);
      oldBox.style.display = 'block';
      popOutBtn.textContent = 'Separar Câmera (2º Monitor)';
      popOutBtn.disabled = false;
    });
  });
}