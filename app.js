  let audioCtx, oscillator, gainNode;
  
  const voiceBreathe = new Audio('breathe.m4a');
  const voicePenalty = new Audio('penalty.m4a');
  const voiceStand = new Audio('stand.m4a');
  const voicePosture = new Audio('posture.m4a');
  const voiceComplete = new Audio('complete.m4a');

  let currentPhase = 0;
  let leftTouched = false, rightTouched = false, isHoldActive = false;
  let holdTimeRemaining = 30, gyroTimeRemaining = 20;
  let timerInterval;
  let isGyroLevel = false, isGyroActive = false;

  // ボタンイベントの登録（通常とデバッグ）
  document.getElementById('entry-button').addEventListener('click', () => initSystem(false));
  document.getElementById('debug-button').addEventListener('click', () => initSystem(true));

  function initSystem(skipToGyro) {
    document.getElementById('entry-button').disabled = true;
    document.getElementById('debug-button').disabled = true;

    [voiceBreathe, voicePenalty, voiceStand, voicePosture, voiceComplete].forEach(v => v.load());

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    oscillator = audioCtx.createOscillator();
    gainNode = audioCtx.createGain();
    gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    oscillator.start();

    // 権限要求は通常通り行う
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      DeviceOrientationEvent.requestPermission()
        .then(response => {
          if (response === 'granted') {
            window.addEventListener('deviceorientation', handleOrientation);
          } else {
            alert('ジャイロセンサーへのアクセスが拒否されました。設定を確認してください。');
          }
        })
        .catch(console.error);
    } else {
      window.addEventListener('deviceorientation', handleOrientation);
    }

    document.getElementById('entry-screen').style.opacity = '0';
    setTimeout(() => {
      document.getElementById('entry-screen').style.display = 'none';
      document.getElementById('main-app').style.display = 'block';
      
      if (skipToGyro) {
        // デバッグモード：フェーズ1を非表示にしてフェーズ2を直起動
        document.getElementById('hold-phase').style.display = 'none';
        startGyroPhase();
      } else {
        // 通常モード：フェーズ1へ
        currentPhase = 1;
        setupTouchEvents();
      }
    }, 500);
  }

  function playVoice(audioElement) {
    audioElement.currentTime = 0;
    audioElement.play().catch(e => console.log(e));
  }

  // --- フェーズ1 ---
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

  // --- フェーズ2 ---
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
          finishSequence();
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
    let moveY = (y / 45) * 80;
    let moveX = (x / 45) * 80;
    document.getElementById('level-inner').style.transform = `translate(calc(-50% + ${moveX}px), calc(-50% + ${moveY}px))`;

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

  // --- 完了・ユーティリティ ---
  function finishSequence() {
    currentPhase = 3;
    isGyroActive = false;
    gainNode.gain.setTargetAtTime(0, audioCtx.currentTime, 2.0);
    document.getElementById('gyro-status').innerHTML = '平静を取り戻しました。<br>本来の軌道へ戻りなさい';
    document.getElementById('level-outer').style.display = 'none';
    playVoice(voiceComplete);
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
