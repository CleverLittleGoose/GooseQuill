/**
 * GooseQuill - Notification & Audio Service
 */

let notificationsEnabled = ("Notification" in window && Notification.permission === "granted");

export function updateNotificationUI() {
  const toggleBtn = document.getElementById("toggleNotificationsBtn");
  const notifText = document.getElementById("notifBtnText");
  if (!toggleBtn || !notifText) return;

  if (notificationsEnabled) {
    toggleBtn.classList.add("active");
    toggleBtn.style.color = "#34d399";
    toggleBtn.style.borderColor = "rgba(16, 185, 129, 0.4)";
    notifText.textContent = "Alerts On";
  } else {
    toggleBtn.classList.remove("active");
    toggleBtn.style.color = "";
    toggleBtn.style.borderColor = "";
    notifText.textContent = "Alerts";
  }
}

export async function requestNotificationPermission() {
  if (!("Notification" in window)) {
    showToast("Notifications Unsupported", "Browser does not support desktop notifications.", true);
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm === "granted") {
    notificationsEnabled = true;
    updateNotificationUI();
    showToast("Notifications Enabled", "You'll hear a chime and see an alert when a queue completes.");
    playCompletionChime();
  } else {
    notificationsEnabled = false;
    updateNotificationUI();
    showToast("Notifications Blocked", "Enable notifications in your browser settings to receive alerts.", true);
  }
}

export function playCompletionChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;

    // Note 1: E5 (659.25 Hz)
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = "sine";
    osc1.frequency.setValueAtTime(659.25, now);
    gain1.gain.setValueAtTime(0.18, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.35);

    // Note 2: B5 (987.77 Hz)
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = "sine";
    osc2.frequency.setValueAtTime(987.77, now + 0.15);
    gain2.gain.setValueAtTime(0.18, now + 0.15);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.65);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.15);
    osc2.stop(now + 0.65);
  } catch (e) {
    console.log("Audio playback not allowed yet:", e);
  }
}

export function showToast(title, message, isError = false) {
  const container = document.getElementById("toastContainer");
  if (!container) return;

  const card = document.createElement("div");
  card.className = `toast-card ${isError ? "error" : ""}`;
  card.innerHTML = `
    <div class="toast-icon">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        ${isError 
          ? '<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line>'
          : '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline>'
        }
      </svg>
    </div>
    <div class="toast-content">
      <strong>${title}</strong>
      <p>${message}</p>
    </div>
  `;

  container.appendChild(card);
  setTimeout(() => {
    card.classList.add("fadeOut");
    setTimeout(() => card.remove(), 300);
  }, 4500);
}

export function notifyCompletion(title, message) {
  playCompletionChime();
  showToast(title, message);

  if ("Notification" in window && Notification.permission === "granted") {
    try {
      new Notification(title, {
        body: message,
        icon: "/favicon.ico"
      });
    } catch (e) {
      console.log("Notification trigger error:", e);
    }
  }
}
