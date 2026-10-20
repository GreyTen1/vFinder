document.addEventListener("DOMContentLoaded", () => {
  const statusDot = document.getElementById("statusDot");
  const statusBanner = document.getElementById("statusBanner");
  const statusText = document.getElementById("statusText");
  const toggle = document.getElementById("interceptToggle");
  const testBtn = document.getElementById("testBtn");
  const refreshBtn = document.getElementById("refreshBtn");

  function updateUI(status) {
    toggle.checked = status.enabled;
    if (status.alive) {
      statusDot.className = "status-dot online";
      statusDot.title = "Connected to vFinder";
      statusBanner.className = "status-banner online";
      statusText.textContent = `Connected to vFinder (Port ${status.port})`;
    } else {
      statusDot.className = "status-dot offline";
      statusDot.title = "vFinder Standby";
      statusBanner.className = "status-banner";
      statusText.textContent = "Standby (vFinder will automatically pop up on download)";
    }
  }

  function checkStatus() {
    statusText.textContent = "Checking connection...";
    chrome.runtime.sendMessage({ type: "CHECK_STATUS" }, (response) => {
      if (chrome.runtime.lastError || !response) {
        updateUI({ enabled: true, port: 45456, alive: false });
      } else {
        updateUI(response);
      }
    });
  }

  toggle.addEventListener("change", () => {
    chrome.runtime.sendMessage(
      { type: "SET_ENABLED", enabled: toggle.checked },
      () => {
        checkStatus();
      }
    );
  });

  refreshBtn.addEventListener("click", () => {
    checkStatus();
  });

  testBtn.addEventListener("click", () => {
    testBtn.disabled = true;
    const oldText = testBtn.innerHTML;
    testBtn.textContent = "Sending...";
    chrome.runtime.sendMessage({ type: "SEND_TEST_DOWNLOAD" }, (res) => {
      testBtn.disabled = false;
      testBtn.innerHTML = oldText;
      if (res && res.success) {
        statusText.textContent = "Test download sent to vFinder!";
      } else {
        alert("Failed to pop up vFinder. Make sure vFinder is running or installed.");
      }
    });
  });

  checkStatus();
});
