let audioCtx, bgOscillator, bgGainNode;
let breathState = 0; // 0=吸う, 1=止める, 2=吐く
let breathTimer = 4;

const voiceBreathe = new Audio('sounds/breathe.m4a');
const voicePenalty = new Audio('sounds/penalty.m4a');
const voiceStand = new Audio('sounds/gyro_stand.m4a');
const voicePosture = new Audio('sounds/posture.m4a');
const voiceCamera = new Audio('sounds/camera.m4a');
const voiceComplete = new Audio('sounds/complete.m4a');

// カメラ用色指定音声
const colorVoices = {
  red: new Audio('sounds/red.m4a'),
  blue: new Audio('sounds/blue.m4a'),
  green: new Audio('sounds/green.m4a')
};

const voiceBreakout = new Audio('sounds/breakout.m4a');
const voiceRhythm = new Audio('sounds/rhythm.m4a');
const voicePenaltyBreakout = new Audio('sounds/penalty_breakout.m4a');
const voicePenaltyRhythm = new Audio('sounds/penalty_rhythm.m4a');

const allVoices = [
  voiceBreathe,
  voicePenalty,
  voiceStand,
  voicePosture,
  voiceCamera,
  voiceComplete,
  voiceBreakout,
  voiceRhythm,
  colorVoices.red,
  colorVoices.blue,
  colorVoices.green
];

// タスク管理
const allTaskIds = ['hold', 'gyro', 'camera', 'breakout', 'rhythm', 'ai'];
let taskQueue = [];
let currentMode = 'normal';
let breakoutReqId = null;
let rhythmReqId = null;

// 状態管理
let currentPhase = 0; // 0: エントリー, 1: 長押し, 2: ジャイロ, 3: カメラ, 4: 完了
let timerInterval;

// フェーズ1変数
let leftTouched = false, rightTouched = false, isHoldActive = false;
let holdTimeRemaining = 30;

// フェーズ2変数
let gyroTimeRemaining = 10;
let isGyroLevel = false, isGyroActive = false;
let baseBeta = null, baseGamma = null;

// フェーズ3変数
let cameraStream = null;
let targetColorType = '';
let colorMatchFrames = 0;
const REQUIRED_MATCH_FRAMES = 150; // 約5秒の継続認識
let isCameraActive = false;

// イベントリスナー登録
document.getElementById('entry-button').addEventListener('click', () => initSystem('normal'));
document.getElementById('debug-menu-button').addEventListener('click', () => {
  const dialog = document.getElementById('debug-dialog');
  if (dialog && typeof dialog.showModal === 'function') dialog.showModal();
});
document.getElementById('debug-close-button').addEventListener('click', () => {
  const dialog = document.getElementById('debug-dialog');
  if (dialog && dialog.open) dialog.close();
});
document.getElementById('debug-start-button').addEventListener('click', () => {
  const select = document.getElementById('debug-select');
  const dialog = document.getElementById('debug-dialog');
  const selected = select ? select.value : 'hold';
  if (dialog && dialog.open) dialog.close();
  initSystem('debug', selected);
});

// リセットボタン（EXITおよび完了画面の静寂に戻る）のグローバルクリック監視
document.addEventListener('touchstart', (e) => {
  if (e.target.classList.contains('phase-reset-button') || e.target.id === 'restart-button') {
    location.reload();
  }
  if (e.target.classList.contains('phase-skip-button')) {
    if (typeof timerInterval !== 'undefined') clearInterval(timerInterval);
    if (typeof cameraStream !== 'undefined' && cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
    }
    runNextTask();
  }
}, { passive: false });

// AI / ブレイクアウトの待機（プレースホルダ）用
let pendingTaskTimeout = null;

function initSystem(mode, startId) {
  currentMode = mode;
  document.getElementById('entry-button').disabled = true;
  const debugBtn = document.getElementById('debug-menu-button');
  if (debugBtn) debugBtn.disabled = true;

  // タスクキュー構築
  if (mode === 'normal') {
    const validTaskIds = ['hold', 'gyro', 'camera', 'breakout', 'rhythm'];
    const shuffled = [...validTaskIds];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    taskQueue = shuffled.slice(0, 3);
  } else if (mode === 'debug' && startId) {
    taskQueue = [startId];
  } else {
    taskQueue = [];
  }

  // 音声の事前ロード
  [voiceBreathe, voicePenalty, voiceStand, voicePosture, voiceCamera, voiceComplete, voiceBreakout, voiceRhythm].forEach(v => v.load());
  Object.values(colorVoices).forEach(v => v.load());

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  // ジャイロの権限要求
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    DeviceOrientationEvent.requestPermission().then(res => {
      if (res === 'granted') window.addEventListener('deviceorientation', handleOrientation);
    }).catch(console.error);
  } else {
    window.addEventListener('deviceorientation', handleOrientation);
  }

  document.getElementById('entry-screen').style.opacity = '0';
  setTimeout(() => {
    document.getElementById('entry-screen').style.display = 'none';
    document.getElementById('main-app').style.display = 'block';
    currentPhase = 1;
    setupTouchEvents();
    runNextTask();
  }, 500);
}

function runNextTask() {
  // 念のため古い処理を止める（SKIP / 自動遷移 / タスク切替の競合対策）
  if (typeof stopBackgroundAudio === 'function') stopBackgroundAudio();
  clearInterval(timerInterval);
  timerInterval = null;
  if (cameraStream) {
    cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
  }
  isCameraActive = false;
  isGyroActive = false;
  isHoldActive = false;
  if (pendingTaskTimeout) {
    clearTimeout(pendingTaskTimeout);
    pendingTaskTimeout = null;
  }
  if (breakoutReqId) {
    cancelAnimationFrame(breakoutReqId);
    breakoutReqId = null;
  }
  if (rhythmReqId) {
    cancelAnimationFrame(rhythmReqId);
    rhythmReqId = null;
  }

  const nextId = taskQueue.shift();

  // すべてのフェーズコンテナを非表示
  document.querySelectorAll('.phase-container').forEach(el => {
    el.style.display = 'none';
  });

  if (!nextId) {
    if (currentMode === 'normal') {
      finishSequence();
    } else {
      location.reload();
    }
    return;
  }

  if (nextId === 'hold') {
    document.getElementById('hold-phase').style.display = 'block';
    prepareHoldPhase();
  } else if (nextId === 'gyro') {
    document.getElementById('gyro-phase').style.display = 'flex';
    startGyroPhase();
  } else if (nextId === 'camera') {
    document.getElementById('camera-phase').style.display = 'block';
    startCameraPhase();
  } else if (nextId === 'ai') {
    document.getElementById('ai-phase').style.display = 'flex';
    startAiPhase();
  } else if (nextId === 'breakout') {
    document.getElementById('breakout-phase').style.display = 'flex';
    startBreakoutPhase();
  } else if (nextId === 'rhythm') {
    document.getElementById('rhythm-phase').style.display = 'flex';
    startRhythmPhase();
  }
}

// 音声再生関数を以下のように書き換えます
function playVoice(audioElement) {
  allVoices.forEach(voice => {
    voice.pause();
    voice.currentTime = 0;
  });
  audioElement.currentTime = 0;
  audioElement.play().catch(e => console.log("音声再生エラー:", e));
}

function updateTimerDisplay(elementId, seconds) {
  const m = String(Math.floor(seconds / 60)).padStart(2, '0');
  const s = String(seconds % 60).padStart(2, '0');
  document.getElementById(elementId).innerText = m + ':' + s;
}

function showPenalty(text, voice) {
  const overlay = document.getElementById('overlay-penalty');
  document.getElementById('penalty-text').innerHTML = text;
  overlay.style.display = 'flex';
  playVoice(voice);
  setTimeout(() => { overlay.style.display = 'none'; }, 3000);
}

function completePhase() {
  const overlay = document.getElementById('overlay-clear');
  overlay.style.display = 'flex';
  
  if (audioCtx.state === 'suspended') audioCtx.resume();
  let gn = audioCtx.createGain();
  gn.connect(audioCtx.destination);
  gn.gain.setValueAtTime(0.05, audioCtx.currentTime);
  
  [880, 1108, 1318, 1760].forEach((freq, i) => { 
    let osc = audioCtx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    osc.connect(gn);
    osc.start(audioCtx.currentTime + i * 0.1);
    osc.stop(audioCtx.currentTime + i * 0.1 + 0.1);
  });
  
  // 花火エフェクト表示
  for(let i = 0; i < 30; i++) {
    const p = document.createElement('div');
    p.classList.add('firework-particle');
    p.style.left = '50%';
    p.style.top = '50%';
    let angle = Math.random() * Math.PI * 2;
    let dist = 50 + Math.random() * 100;
    p.style.setProperty('--tx', `${Math.cos(angle)*dist}px`);
    p.style.setProperty('--ty', `${Math.sin(angle)*dist}px`);
    overlay.appendChild(p);
    setTimeout(() => p.remove(), 800);
  }

  setTimeout(() => {
    overlay.style.display = 'none';
    runNextTask();
  }, 1500);
}

// ==========================================
// フェーズ1：長押し
// ==========================================
function setupTouchEvents() {
  window.addEventListener('touchstart', handleTouch, { passive: false });
  window.addEventListener('touchmove', handleTouch, { passive: false });
  window.addEventListener('touchend', handleTouch, { passive: false });
  window.addEventListener('touchcancel', handleTouch, { passive: false });
}

function handleTouch(e) {
  if (e.cancelable) e.preventDefault();
  if (currentPhase !== 1) return;

  leftTouched = false;
  rightTouched = false;
  for (let i = 0; i < e.touches.length; i++) {
    if (e.touches[i].clientX < window.innerWidth / 2) leftTouched = true;
    else rightTouched = true;
  }
  
  if (leftTouched && rightTouched) {
    if (!isHoldActive) startHoldPhase();
  } else {
    if (isHoldActive) failHoldPhase();
  }
}

function prepareHoldPhase() {
  currentPhase = 1;
  isHoldActive = false;
  holdTimeRemaining = 38;
  document.getElementById('timer').style.opacity = '0';
  document.getElementById('breathing-circle').style.opacity = '0';
  document.getElementById('breathing-circle').classList.remove('is-breathing');
  document.getElementById('breath-status').style.opacity = '0';
  document.body.style.backgroundColor = 'var(--bg-idle)';
  document.getElementById('status-text').innerHTML = '左右を長押しし、<br>静寂を維持しなさい';
  updateTimerDisplay('timer', holdTimeRemaining);
  setupTouchEvents();
}

function startHoldPhase() {
  isHoldActive = true;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  
  if(!bgOscillator) {
    bgOscillator = audioCtx.createOscillator();
    bgOscillator.type = 'sine';
    bgOscillator.frequency.value = 40;
    bgGainNode = audioCtx.createGain();
    bgGainNode.gain.setValueAtTime(0, audioCtx.currentTime);
    bgOscillator.connect(bgGainNode);
    bgGainNode.connect(audioCtx.destination);
    bgOscillator.start();
  }
  bgGainNode.gain.setTargetAtTime(0.4, audioCtx.currentTime, 1.5);
  
  document.body.style.backgroundColor = 'var(--bg-active)';
  document.getElementById('status-text').innerHTML = '呼吸に意識を向け、<br>波が過ぎるのを待ちなさい';
  playVoice(voiceBreathe);

  document.getElementById('timer').style.opacity = '1';
  document.getElementById('breathing-circle').style.opacity = '1';
  document.getElementById('breathing-circle').classList.add('is-breathing');
  document.getElementById('breath-status').style.opacity = '1';
  
  breathState = 0;
  breathTimer = 4;
  updateBreathStatus();
  
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    holdTimeRemaining--;
    updateTimerDisplay('timer', holdTimeRemaining);
    
    breathTimer--;
    if(breathTimer <= 0) {
      breathState = (breathState + 1) % 3;
      if(breathState === 0) breathTimer = 4;
      else if(breathState === 1) breathTimer = 7;
      else if(breathState === 2) breathTimer = 8;
    }
    updateBreathStatus();

    if (holdTimeRemaining <= 0) {
      clearInterval(timerInterval);
      stopBackgroundAudio();
      completePhase();
    }
  }, 1000);
}

function updateBreathStatus() {
  const st = document.getElementById('breath-status');
  if(breathState === 0) st.innerText = `吸って：${breathTimer}`;
  else if(breathState === 1) st.innerText = `止めて：${breathTimer}`;
  else if(breathState === 2) st.innerText = `吐いて：${breathTimer}`;
}

function stopBackgroundAudio() {
  if (bgGainNode) bgGainNode.gain.setTargetAtTime(0, audioCtx.currentTime, 0.5);
}

function failHoldPhase() {
  isHoldActive = false;
  stopBackgroundAudio();
  clearInterval(timerInterval);
  holdTimeRemaining = 38;

  document.getElementById('timer').style.opacity = '0';
  document.getElementById('breathing-circle').style.opacity = '0';
  document.getElementById('breath-status').style.opacity = '0';
  document.getElementById('breathing-circle').classList.remove('is-breathing');
  updateTimerDisplay('timer', holdTimeRemaining);
  
  showPenalty('まだ波は去っていません。<br>もう一度、手を置きなさい', voicePenalty);
  setTimeout(() => {
    document.body.style.backgroundColor = 'var(--bg-idle)';
    document.getElementById('status-text').innerHTML = '左右を長押しし、<br>静寂を維持しなさい';
  }, 3000);
}

// ==========================================
// フェーズ2：ジャイロ
// ==========================================
function startGyroPhase() {
  currentPhase = 2;
  isHoldActive = false;
  baseBeta = null;
  baseGamma = null;
  document.getElementById('hold-phase').style.display = 'none';
  document.getElementById('gyro-phase').style.display = 'flex';
  document.body.style.backgroundColor = 'var(--bg-gyro)';
  
  document.getElementById('gyro-timer').style.opacity = '1';
  if (audioCtx.state === 'suspended') audioCtx.resume();
  
  playVoice(voiceStand);
  isGyroActive = true;
  
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (isGyroLevel) {
      gyroTimeRemaining--;
      updateTimerDisplay('gyro-timer', gyroTimeRemaining);
      if (gyroTimeRemaining <= 0) {
        clearInterval(timerInterval);
        completePhase();
      }
    }
  }, 1000);
}

function handleOrientation(event) {
  if (currentPhase !== 2 || !isGyroActive) return;

  let time = Date.now() / 1000;
  let targetX = Math.cos(time * 1.5) * 40; 
  let targetY = Math.sin(time * 1.5) * 40;

  let targetEl = document.getElementById('level-target');
  if (targetEl) targetEl.style.transform = `translate(calc(-50% + ${targetX}px), calc(-50% + ${targetY}px))`;

  let rawBeta = event.beta || 0;
  let rawGamma = event.gamma || 0;

  // Horizontal mapping
  let y = Math.min(Math.max(rawBeta, -45), 45);
  let x = Math.min(Math.max(rawGamma, -45), 45);
  
  // Make it move slightly less far for easier control
  let playerX = (x/45)*50;
  let playerY = (y/45)*50;
  document.getElementById('level-inner').style.transform = `translate(calc(-50% + ${playerX}px), calc(-50% + ${playerY}px))`;

  let dist = Math.hypot(targetX - playerX, targetY - playerY);

  if (dist < 25) {
    if (!isGyroLevel) isGyroLevel = true;
    document.getElementById('level-outer').style.borderColor = 'var(--success-color)';
  } else if (dist < 50) {
    document.getElementById('level-outer').style.borderColor = '#c0b030';
  } else {
    if (isGyroLevel) {
      isGyroLevel = false;
      document.getElementById('level-outer').style.borderColor = 'var(--alert-color)';
      failGyroPhase();
    }
  }
}

function failGyroPhase() {
  isGyroActive = false;
  gyroTimeRemaining = 10;
  updateTimerDisplay('gyro-timer', gyroTimeRemaining);
  showPenalty('同期が外れました。<br>姿勢を維持しなさい', voicePosture);
  setTimeout(() => {
    baseBeta = null;
    baseGamma = null;
    isGyroActive = true;
    document.getElementById('level-outer').style.borderColor = 'var(--accent-color)';
  }, 3000);
}

// ==========================================
// フェーズ3：カメラ（色彩検知）
// ==========================================
function startCameraPhase() {
  currentPhase = 3;
  isGyroActive = false;
  document.getElementById('gyro-phase').style.display = 'none';
  document.getElementById('camera-phase').style.display = 'block';
  
  playVoice(voiceCamera);

  // 背面カメラの要求
  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
    .then(stream => {
      cameraStream = stream;
      const video = document.getElementById('camera-stream');
      video.srcObject = stream;
      
      // ランダムに探す色を決定
      const colors = ['red', 'blue', 'green'];
      targetColorType = colors[Math.floor(Math.random() * colors.length)];
      
      const colorNames = { red: '赤色', blue: '青色', green: '緑色' };
      document.getElementById('camera-status').innerHTML = `${colorNames[targetColorType]}の物体を<br>枠内に捉えなさい`;
      
      // 数秒後に色指定の音声を再生
      setTimeout(() => { playVoice(colorVoices[targetColorType]); }, 3000);
      
      isCameraActive = true;
      colorMatchFrames = 0;
      requestAnimationFrame(processVideoFrame);
    })
    .catch(err => {
      alert('カメラの起動に失敗しました。権限を確認してください。');
      finishSequence(); // エラー時は強制完了させるフェイルセーフ
    });
}

function processVideoFrame() {
  if (!isCameraActive) return;

  const video = document.getElementById('camera-stream');
  const canvas = document.getElementById('camera-canvas');
  const ctx = canvas.getContext('2d');
  const reticle = document.getElementById('target-reticle');

  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const scanSize = 50;
    const imageData = ctx.getImageData(centerX - scanSize/2, centerY - scanSize/2, scanSize, scanSize);
    const data = imageData.data;

    let rTotal = 0, gTotal = 0, bTotal = 0;
    let pixelCount = data.length / 4;

    for (let i = 0; i < data.length; i += 4) {
      rTotal += data[i];
      gTotal += data[i + 1];
      bTotal += data[i + 2];
    }

    const rAvg = rTotal / pixelCount;
    const gAvg = gTotal / pixelCount;
    const bAvg = bTotal / pixelCount;

    let isMatch = false;
    const threshold = 40; 

    if (targetColorType === 'red') {
      isMatch = (rAvg > gAvg + threshold) && (rAvg > bAvg + threshold) && (rAvg > 100);
    } else if (targetColorType === 'blue') {
      isMatch = (bAvg > rAvg + threshold) && (bAvg > gAvg + threshold) && (bAvg > 80);
    } else if (targetColorType === 'green') {
      isMatch = (gAvg > rAvg + threshold) && (gAvg > bAvg + threshold) && (gAvg > 80);
    }

    if (isMatch) {
      colorMatchFrames++;
      reticle.style.borderColor = 'var(--success-color)';
      reticle.style.transform = 'translate(-50%, -50%) scale(1.1)';
    } else {
      colorMatchFrames = Math.max(0, colorMatchFrames - 5);
      reticle.style.borderColor = 'rgba(255, 255, 255, 0.4)';
      reticle.style.transform = 'translate(-50%, -50%) scale(1)';
    }

    const progressPercent = Math.min(100, (colorMatchFrames / REQUIRED_MATCH_FRAMES) * 100);
    const progressBar = document.getElementById('camera-progress-inner');
    if (progressBar) progressBar.style.width = `${progressPercent}%`;

    if (colorMatchFrames >= REQUIRED_MATCH_FRAMES) {
      isCameraActive = false;
      if (cameraStream) {
        cameraStream.getTracks().forEach(track => track.stop());
      }
      completePhase();
      return;
    }
  }
  requestAnimationFrame(processVideoFrame);
}

// ==========================================
// 完了
// ==========================================
function finishSequence() {
  currentPhase = 4;
  isCameraActive = false;
  
  if (cameraStream) {
    cameraStream.getTracks().forEach(track => track.stop());
  }
  document.getElementById('hold-phase').style.display = 'none';
  document.getElementById('gyro-phase').style.display = 'none';
  document.getElementById('camera-phase').style.display = 'none';
  const aiPhase = document.getElementById('ai-phase');
  if (aiPhase) aiPhase.style.display = 'none';
  const breakoutPhase = document.getElementById('breakout-phase');
  if (breakoutPhase) breakoutPhase.style.display = 'none';

  const rhythmPhase = document.getElementById('rhythm-phase');
  if (rhythmPhase) rhythmPhase.style.display = 'none';

  if (typeof stopBackgroundAudio === 'function') stopBackgroundAudio();

  const finalOverlay = document.getElementById('overlay-final-clear');
  finalOverlay.style.display = 'flex';

  if (audioCtx.state === 'suspended') audioCtx.resume();
  let gn = audioCtx.createGain();
  gn.connect(audioCtx.destination);
  gn.gain.setValueAtTime(0.1, audioCtx.currentTime);
  
  // Grand majestic chord
  [523.25, 659.25, 783.99, 1046.50].forEach((freq, i) => { // C major 7
    let osc = audioCtx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    osc.connect(gn);
    osc.start(audioCtx.currentTime + i * 0.1);
    gn.gain.setTargetAtTime(0, audioCtx.currentTime + 3.0, 1.0);
    osc.stop(audioCtx.currentTime + 4.0);
  });

  // Massive fireworks
  for(let i = 0; i < 80; i++) {
    const p = document.createElement('div');
    p.classList.add('big-firework-particle');
    p.style.left = '50%';
    p.style.top = '50%';
    let angle = Math.random() * Math.PI * 2;
    let dist = 100 + Math.random() * 300;
    p.style.setProperty('--tx', `${Math.cos(angle)*dist}px`);
    p.style.setProperty('--ty', `${Math.sin(angle)*dist}px`);
    finalOverlay.appendChild(p);
    setTimeout(() => p.remove(), 2000);
  }

  // After animation
  setTimeout(() => {
    finalOverlay.style.display = 'none';
    const completePhase = document.getElementById('complete-phase');
    completePhase.innerHTML = `
      <div class="status-text" style="color:var(--success-color);">防衛シーケンス完了</div>
      <div class="status-text" style="margin-top:20px; font-size:0.9rem;">平静を取り戻しました。<br>本来の軌道へ戻りなさい</div>
      <button id="restart-button">静寂に戻る</button>
    `;
    completePhase.style.display = 'flex';
    playVoice(voiceComplete);
    
    // Add listener safely just in case
    const restartBtn = document.getElementById('restart-button');
    if (restartBtn) {
      restartBtn.addEventListener('click', () => { location.reload(); });
    }
  }, 4000);
}

function startAiPhase() {
  pendingTaskTimeout = setTimeout(() => {
    runNextTask();
  }, 3000);
}

// ==========================================
// フェーズ4：ブロック崩し
// ==========================================
function startBreakoutPhase() {
  currentPhase = 4;
  const phase = document.getElementById('breakout-phase');
  phase.style.display = 'flex';
  const canvas = document.getElementById('breakout-canvas');
  // Match CSS size dynamically
  canvas.width = canvas.offsetWidth || 300;
  canvas.height = canvas.offsetHeight || 400;

  const ctx = canvas.getContext('2d');
  
  let paddle = { w: 80, h: 10, x: canvas.width/2 - 40, y: canvas.height - 30 };
  let ball = { x: canvas.width/2, y: canvas.height - 80, r: 5, dx: 3.5, dy: -3.5 };
  if(Math.random() > 0.5) ball.dx *= -1;

  let blocks = [];
  const rows = 3, cols = 4;
  const blockW = (canvas.width - 40) / cols - 10;
  const blockH = 20;

  for(let r=0; r<rows; r++) {
    for(let c=0; c<cols; c++) {
      blocks.push({
        x: 25 + c * (blockW + 10),
        y: 40 + r * (blockH + 10),
        w: blockW, h: blockH, active: true
      });
    }
  }

  playVoice(voiceBreakout);

  const touchMoveHandler = (e) => {
    if(currentPhase !== 4) return;
    if(e.cancelable) e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    let touchX = e.touches[0].clientX - rect.left;
    paddle.x = Math.max(0, Math.min(canvas.width - paddle.w, touchX - paddle.w/2));
  };
  window.addEventListener('touchmove', touchMoveHandler, {passive: false});

  function draw() {
    if(currentPhase !== 4) {
      window.removeEventListener('touchmove', touchMoveHandler);
      return;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Draw paddle
    ctx.fillStyle = 'rgba(200, 209, 224, 0.8)';
    ctx.fillRect(paddle.x, paddle.y, paddle.w, paddle.h);

    // Draw ball
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, ball.r, 0, Math.PI*2);
    ctx.fillStyle = 'var(--accent-color)';
    ctx.fill();
    ctx.closePath();

    // Draw blocks
    let activeBreakCnt = 0;
    ctx.fillStyle = 'rgba(92, 132, 196, 0.6)';
    blocks.forEach(b => {
      if(!b.active) return;
      activeBreakCnt++;
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.strokeRect(b.x, b.y, b.w, b.h);

      // Collision Check
      let closestX = Math.max(b.x, Math.min(ball.x, b.x + b.w));
      let closestY = Math.max(b.y, Math.min(ball.y, b.y + b.h));
      let distanceX = ball.x - closestX;
      let distanceY = ball.y - closestY;
      let distanceSquared = (distanceX * distanceX) + (distanceY * distanceY);

      if (distanceSquared < (ball.r * ball.r)) {
        ball.dy *= -1; // シンプル実装
        b.active = false;
        if (audioCtx.state === 'suspended') audioCtx.resume();
        let osc = audioCtx.createOscillator();
        let gn = audioCtx.createGain();
        osc.connect(gn); gn.connect(audioCtx.destination);
        osc.frequency.value = 400; gn.gain.setValueAtTime(0.05, audioCtx.currentTime);
        gn.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.05);
        osc.start(); osc.stop(audioCtx.currentTime + 0.05);
      }
    });

    const breakTarget = 5;
    if((blocks.length - activeBreakCnt) >= breakTarget) {
      finishBreakout(true);
      return;
    }

    // Wall collision
    if(ball.x + ball.dx > canvas.width - ball.r || ball.x + ball.dx < ball.r) ball.dx *= -1;
    if(ball.y + ball.dy < ball.r) ball.dy *= -1;
    else {
      // Paddle check
      if (ball.dy > 0 && ball.y + ball.r <= paddle.y && ball.y + ball.dy + ball.r >= paddle.y) {
        if(ball.x + ball.r > paddle.x && ball.x - ball.r < paddle.x + paddle.w) {
          ball.dy = -Math.abs(ball.dy); // Bounce up
          let hitPoint = ball.x - (paddle.x + paddle.w/2);
          ball.dx = hitPoint * 0.15;
          if (audioCtx.state === 'suspended') audioCtx.resume();
          let osc = audioCtx.createOscillator(); let gn = audioCtx.createGain();
          osc.connect(gn); gn.connect(audioCtx.destination);
          osc.frequency.value = 200; gn.gain.setValueAtTime(0.05, audioCtx.currentTime);
          gn.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.05);
          osc.start(); osc.stop(audioCtx.currentTime + 0.05);
        }
      }
      if(ball.y > canvas.height + 10) {
        // Drop
        finishBreakout(false);
        return;
      }
    }

    ball.x += ball.dx;
    ball.y += ball.dy;

    breakoutReqId = requestAnimationFrame(draw);
  }

  function finishBreakout(success) {
    cancelAnimationFrame(breakoutReqId);
    window.removeEventListener('touchmove', touchMoveHandler);
    if(success) {
      completePhase();
    } else {
      showPenalty('隔壁制御に失敗しました。<br>再構築します', voicePenaltyBreakout);
      setTimeout(() => {
        if(currentPhase === 4) startBreakoutPhase(); // Retry
      }, 3000);
    }
  }

  draw();
}

// ==========================================
// フェーズ5：リズム同期
// ==========================================
function startRhythmPhase() {
  currentPhase = 5;
  const phase = document.getElementById('rhythm-phase');
  phase.style.display = 'flex';
  const canvas = document.getElementById('rhythm-canvas');
  canvas.width = canvas.offsetWidth || 300;
  canvas.height = canvas.offsetHeight || 400;
  const ctx = canvas.getContext('2d');

  let notes = [];
  let noteSpeed = canvas.height * 0.01; // dynamically adapt to height
  let successCount = 0;
  const targetCount = 5;
  let frameCount = 0;
  const hitY = canvas.height - 60;
  const noteRadius = 15;

  playVoice(voiceRhythm);

  const touchHandler = (e) => {
    if(currentPhase !== 5) return;
    if(e.cancelable) e.preventDefault();
    
    // Find matching note
    let tapProcessed = false;
    if(notes.length > 0) {
      // Check oldest note
      let n = notes[0];
      let dist = Math.abs(n.y - hitY);
      if(dist < 40) {
       notes.shift(); // remove note
       successCount++;
       tapProcessed = true;
       // Play hit sound
       if (audioCtx.state === 'suspended') audioCtx.resume();
       let osc = audioCtx.createOscillator();
       let gn = audioCtx.createGain();
       osc.connect(gn); gn.connect(audioCtx.destination);
       osc.frequency.value = 600; gn.gain.setValueAtTime(0.1, audioCtx.currentTime);
       gn.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.1);
       osc.start(); osc.stop(audioCtx.currentTime + 0.1);

       if(successCount >= targetCount) {
         finishRhythm(true, '');
       }
      } else if (dist < 100) {
        // Bad timing
        finishRhythm(false, '同調が乱れました。<br>同期をやり直します');
        tapProcessed = true;
      }
    } 
    
    // Tap with no note near
    if(!tapProcessed) {
      finishRhythm(false, '不必要なノイズです。<br>同期をやり直します');
    }
  };
  window.addEventListener('touchstart', touchHandler, {passive: false});

  function draw() {
    if(currentPhase !== 5) {
      window.removeEventListener('touchstart', touchHandler);
      return;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw Hit Zone
    ctx.beginPath();
    ctx.moveTo(0, hitY);
    ctx.lineTo(canvas.width, hitY);
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = 'rgba(92, 132, 196, 0.2)';
    ctx.fillRect(0, hitY - 20, canvas.width, 40);

    // Spawn Notes
    if(frameCount % 60 === 0 && (successCount + notes.length) < targetCount) {
      notes.push({ y: -20 });
    }

    // Move & Draw Notes
    ctx.fillStyle = 'rgba(200, 209, 224, 0.9)';
    for(let i=0; i<notes.length; i++) {
        let n = notes[i];
        n.y += noteSpeed;
        ctx.beginPath();
        ctx.arc(canvas.width/2, n.y, noteRadius, 0, Math.PI*2);
        ctx.fill();

        if(n.y > canvas.height + 20) {
            finishRhythm(false, '同期シグナルを喪失しました。<br>初めからやり直しなさい');
            return;
        }
    }

    // Score Info
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = '16px "SF Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${successCount} / ${targetCount}`, canvas.width/2, 30);

    frameCount++;
    rhythmReqId = requestAnimationFrame(draw);
  }

  function finishRhythm(success, errorMsg) {
    cancelAnimationFrame(rhythmReqId);
    window.removeEventListener('touchstart', touchHandler);
    if(success) {
      completePhase();
    } else {
      showPenalty(errorMsg, voicePenaltyRhythm);
      setTimeout(() => {
        if(currentPhase === 5) {
          window.removeEventListener('touchstart', touchHandler); // remove old listener before retry
          startRhythmPhase();
        }
      }, 3000);
    }
  }

  draw();
}