let audioCtx, oscillator, gainNode;

// 音声ファイルの定義
const voiceBreathe = new Audio('breathe.m4a');
const voicePenalty = new Audio('penalty.m4a');
const voiceStand = new Audio('stand.m4a');
const voicePosture = new Audio('posture.m4a');
const voiceCamera = new Audio('camera.m4a');
const voiceComplete = new Audio('complete.m4a');

// カメラ用色指定音声
const colorVoices = {
  red: new Audio('red.m4a'),
  blue: new Audio('blue.m4a'),
  green: new Audio('green.m4a')
};

const allVoices = [
  voiceBreathe,
  voicePenalty,
  voiceStand,
  voicePosture,
  voiceCamera,
  voiceComplete,
  colorVoices.red,
  colorVoices.blue,
  colorVoices.green
];

// 状態管理
let currentPhase = 0; // 0: エントリー, 1: 長押し, 2: ジャイロ, 3: カメラ, 4: 完了
let timerInterval;

// フェーズ1変数
let leftTouched = false, rightTouched = false, isHoldActive = false;
let holdTimeRemaining = 30;

// フェーズ2変数
let gyroTimeRemaining = 20;
let isGyroLevel = false, isGyroActive = false;

// フェーズ3変数
let cameraStream = null;
let targetColorType = '';
let colorMatchFrames = 0;
const REQUIRED_MATCH_FRAMES = 150; // 約5秒の継続認識
let isCameraActive = false;

// イベントリスナー登録
document.getElementById('entry-button').addEventListener('click', () => initSystem('normal'));
document.getElementById('debug-button-gyro').addEventListener('click', () => initSystem('gyro'));
document.getElementById('debug-button-camera').addEventListener('click', () => initSystem('camera'));

function initSystem(mode) {
  document.getElementById('entry-button').disabled = true;

  // 音声の事前ロード
  [voiceBreathe, voicePenalty, voiceStand, voicePosture, voiceCamera, voiceComplete].forEach(v => v.load());
  Object.values(colorVoices).forEach(v => v.load());

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  oscillator = audioCtx.createOscillator();
  gainNode = audioCtx.createGain();
  gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
  oscillator.connect(gainNode);
  gainNode.connect(audioCtx.destination);
  oscillator.start();

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
    
    if (mode === 'gyro') {
      document.getElementById('hold-phase').style.display = 'none';
      startGyroPhase();
    } else if (mode === 'camera') {
      document.getElementById('hold-phase').style.display = 'none';
      startCameraPhase();
    } else {
      currentPhase = 1;
      setupTouchEvents();
    }
  }, 500);
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

function startHoldPhase() {
  isHoldActive = true;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  gainNode.gain.setTargetAtTime(0.4, audioCtx.currentTime, 1.5);
  
  document.body.style.backgroundColor = 'var(--bg-active)';
  document.getElementById('status-text').innerHTML = '呼吸に意識を向け、<br>波が過ぎるのを待ちなさい';
  playVoice(voiceBreathe);

  document.getElementById('timer').style.opacity = '1';
  document.getElementById('breathing-circle').style.opacity = '1';
  document.getElementById('breathing-circle').classList.add('is-breathing');
  
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    holdTimeRemaining--;
    updateTimerDisplay('timer', holdTimeRemaining);
    if (holdTimeRemaining <= 0) {
      clearInterval(timerInterval);
      startGyroPhase();
    }
  }, 1000);
}

function failHoldPhase() {
  isHoldActive = false;
  gainNode.gain.setTargetAtTime(0, audioCtx.currentTime, 0.5);
  clearInterval(timerInterval);
  holdTimeRemaining = 30;

  document.getElementById('timer').style.opacity = '0';
  document.getElementById('breathing-circle').style.opacity = '0';
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
  document.getElementById('hold-phase').style.display = 'none';
  document.getElementById('gyro-phase').style.display = 'flex';
  document.body.style.backgroundColor = 'var(--bg-gyro)';
  
  document.getElementById('gyro-timer').style.opacity = '1';
  if (audioCtx.state === 'suspended') audioCtx.resume();
  gainNode.gain.setTargetAtTime(0.3, audioCtx.currentTime, 1.0);
  
  playVoice(voiceStand);
  isGyroActive = true;
  
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (isGyroLevel) {
      gyroTimeRemaining--;
      updateTimerDisplay('gyro-timer', gyroTimeRemaining);
      if (gyroTimeRemaining <= 0) {
        clearInterval(timerInterval);
        startCameraPhase();
      }
    }
  }, 1000);
}

function handleOrientation(event) {
  if (currentPhase !== 2 || !isGyroActive) return;

  let beta = event.beta || 0;
  let gamma = event.gamma || 0;

  let y = Math.min(Math.max(beta, -45), 45);
  let x = Math.min(Math.max(gamma, -45), 45);
  document.getElementById('level-inner').style.transform = `translate(calc(-50% + ${(x/45)*80}px), calc(-50% + ${(y/45)*80}px))`;

  if (Math.abs(beta) < 15 && Math.abs(gamma) < 15) {
    if (!isGyroLevel) {
      isGyroLevel = true;
      document.getElementById('level-outer').style.borderColor = '#88c0d0';
    }
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
  gyroTimeRemaining = 20;
  updateTimerDisplay('gyro-timer', gyroTimeRemaining);
  showPenalty('姿勢が崩れました。<br>水平を維持しなさい', voicePosture);
  setTimeout(() => {
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
      requestAnimationFrame(processVideoFrame);
    })
    .catch(err => {
      alert('カメラの起動に失敗しました。権限を確認してください。');
      finishSequence(); // エラー時は強制完了させるフェイルセーフ
    });
}

function processVideoFrame() {
  if (currentPhase !== 3 || !isCameraActive) return;

  const video = document.getElementById('camera-stream');
  const canvas = document.getElementById('camera-canvas');
  const ctx = canvas.getContext('2d');
  const reticle = document.getElementById('target-reticle');

  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // 中央領域のピクセルデータを取得（中央の50x50ピクセル）
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

    // 色判定ロジック
    let isMatch = false;
    const threshold = 60; // 色の優位性のしきい値

    if (targetColorType === 'red') {
      isMatch = (rAvg > gAvg + threshold) && (rAvg > bAvg + threshold) && (rAvg > 130);
    } else if (targetColorType === 'blue') {
      isMatch = (bAvg > rAvg + threshold) && (bAvg > gAvg + threshold) && (bAvg > 120);
    } else if (targetColorType === 'green') {
      isMatch = (gAvg > rAvg + threshold) && (gAvg > bAvg + threshold) && (gAvg > 120);
    }

    if (isMatch) {
      colorMatchFrames++;
      reticle.style.borderColor = 'var(--success-color)';
      reticle.style.transform = 'translate(-50%, -50%) scale(1.1)';
    } else {
      colorMatchFrames = Math.max(0, colorMatchFrames - 5); // 外れたらゲージ減少
      reticle.style.borderColor = 'rgba(255, 255, 255, 0.5)';
      reticle.style.transform = 'translate(-50%, -50%) scale(1)';
    }

    // プログレスバーの更新
    const progressPercent = Math.min(100, (colorMatchFrames / REQUIRED_MATCH_FRAMES) * 100);
    document.getElementById('camera-progress-inner').style.width = `${progressPercent}%`;

    if (colorMatchFrames >= REQUIRED_MATCH_FRAMES) {
      finishSequence();
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

  document.getElementById('main-app').innerHTML = `
    <div style="display:flex; flex-direction:column; justify-content:center; align-items:center; height:100%; width:100%;">
      <div class="status-text" style="color:var(--success-color);">防衛シーケンス完了</div>
      <div class="status-text" style="margin-top:20px; font-size:0.9rem;">平静を取り戻しました。<br>本来の軌道へ戻りなさい</div>
    </div>
  `;
  
  gainNode.gain.setTargetAtTime(0, audioCtx.currentTime, 2.0);
  playVoice(voiceComplete);
}