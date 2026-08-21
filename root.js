const statusWord = document.querySelector('#status-word');
const pollIntervalMs = 2_000;
let pollTimer;
let currentText = statusWord.textContent.trim();

const wait = (duration) => new Promise((resolve) => window.setTimeout(resolve, duration));

async function showStatus(text) {
  if (text === currentText) return;

  statusWord.classList.add('is-changing');
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    await wait(160);
  }

  currentText = text;
  statusWord.textContent = text;
  statusWord.classList.remove('is-changing');
}

async function refreshStatus() {
  try {
    const response = await fetch('/api/status', {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Status request failed: ${response.status}`);

    const status = await response.json();
    if (typeof status.text === 'string' && status.text.length > 0) {
      await showStatus(status.text);
    }
  } catch {
    // Keep the most recent known value when the network is temporarily unavailable.
  } finally {
    window.clearTimeout(pollTimer);
    if (!document.hidden) pollTimer = window.setTimeout(refreshStatus, pollIntervalMs);
  }
}

document.addEventListener('visibilitychange', () => {
  window.clearTimeout(pollTimer);
  if (!document.hidden) void refreshStatus();
});

void refreshStatus();
