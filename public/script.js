document.getElementById("roll-number-form").addEventListener("submit", async function (e) {
  e.preventDefault();
  document.getElementById("log-section").classList.remove("hidden");
  const startRoll = document.getElementById("start-roll").value.trim();
  const endRoll = document.getElementById("end-roll").value.trim();
  const academicYear = document.getElementById("academic-year").value;
  const examType = document.getElementById("exam-type").value;
  const semester = document.getElementById("semester").value;
  const branch = document.getElementById("branch").value;
  const semesterType = parseInt(semester) % 2 === 0 ? "Even" : "Odd";

  if (!academicYear || !examType || !semester || !branch || !startRoll || !endRoll) {
    alert("Please fill all fields.");
    return;
  }

  if (startRoll.length !== 10 || endRoll.length !== 10) {
    alert("Roll numbers must be exactly 10 characters long.");
    return;
  }

  if (startRoll === endRoll) {
    alert("Start and end roll numbers cannot be the same.");
    return;
  }

  const prefixStart = startRoll.slice(0, 6);
  const prefixEnd = endRoll.slice(0, 6);
  if (prefixStart !== prefixEnd) {
    alert("First 6 characters of start and end roll numbers must match.");
    return;
  }

  const rollStart = parseInt(startRoll.slice(-4));
  const rollEnd = parseInt(endRoll.slice(-4));
  const total = rollEnd - rollStart + 1;

  if (isNaN(rollStart) || isNaN(rollEnd) || total <= 0) {
    alert("Last 4 characters of roll numbers must be numeric and valid.");
    return;
  }

  if (total > 200) {
    alert("Roll number range cannot exceed 200.");
    return;
  }

  const log = (msg) => {
    const logSection = document.getElementById("log-section");
    const line = document.createElement("div");
    line.textContent = msg;
    logSection.appendChild(line);
    logSection.scrollTop = logSection.scrollHeight; 
  };

  const createStatusPanel = () => {
    const statusPanel = document.getElementById("status-panel") || document.createElement("div");
    statusPanel.id = "status-panel";
    statusPanel.className = "status-panel mb-4 p-3 border rounded";
    
    if (!document.getElementById("status-panel")) {
      const progressSection = document.getElementById("progress-section");
      progressSection.parentNode.insertBefore(statusPanel, progressSection);
    }
    
    statusPanel.innerHTML = `
      <div class="mb-2">
        <h5 class="fw-bold mb-1">Job Status</h5>
        <div class="job-id-badge" id="job-id-badge">Job ID: -</div>
      </div>
      <div class="status-grid">
        <div class="status-item">
          <span class="status-icon">⚡</span> 
          <span class="status-label">Current step:</span>
          <span class="status-value" id="current-step">Initializing</span>
        </div>
        <div class="status-item">
          <span class="status-icon">⏱️</span> 
          <span class="status-label">Elapsed time:</span>
          <span class="status-value" id="elapsed-time">00:00</span>
        </div>
        <div class="status-item">
          <span class="status-icon">📄</span> 
          <span class="status-label">Last processed:</span>
          <span class="status-value" id="last-processed">-</span>
        </div>
        <div class="status-item">
          <span class="status-icon">✅</span> 
          <span class="status-label">Success:</span>
          <span class="status-value" id="success-count">0</span>
        </div>
        <div class="status-item">
          <span class="status-icon">❌</span> 
          <span class="status-label">Not found:</span>
          <span class="status-value" id="not-found-count">0</span>
        </div>
      </div>
      <div class="mt-2" id="recently-processed-section">
        <div class="recently-label">Recently processed:</div>
        <div id="recent-rolls" class="recent-rolls"></div>
      </div>
    `;
    return statusPanel;
  };

  document.getElementById("progress-section").classList.remove("hidden");
  document.getElementById("log-section").innerHTML = "";
  document.getElementById("pdf-viewer-section").classList.add("hidden");
  
  const existingStatusPanel = document.getElementById("status-panel");
  if (existingStatusPanel) {
    existingStatusPanel.remove();
  }

  const progressBar = document.getElementById("progress-bar");
  const progressText = document.getElementById("progress-text");

  log(`➡️ Submitting job from ${startRoll} to ${endRoll}...`);

  try {
    const submitRes = await fetch("/result", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startRoll,
        endRoll,
        academicYear,
        examType,
        semester,
        semesterType,
        branch,
      }),
    });

    if (!submitRes.ok) throw new Error("Job submission failed.");

    const { jobId } = await submitRes.json();
    log(`📦 Job ID: ${jobId}. Polling for progress...`);

    createStatusPanel();
    document.getElementById("job-id-badge").textContent = `Job ID: ${jobId.substring(0, 8)}...`;

    const poll = setInterval(async () => {
      try {
        const statusRes = await fetch(`/status/${jobId}`);
        if (!statusRes.ok) {
          throw new Error(`Failed to get status: ${statusRes.status}`);
        }
        
        const statusData = await statusRes.json();
        
        document.getElementById("job-id-badge").textContent = `Job ID: ${jobId.substring(0, 8)}...`;
        
        document.getElementById("current-step").textContent = formatStep(statusData.currentStep || "Unknown");
        document.getElementById("elapsed-time").textContent = statusData.elapsedTime?.formatted || "00:00";
        document.getElementById("last-processed").textContent = statusData.lastProcessedRoll || "-";
        document.getElementById("success-count").textContent = statusData.successfulCount || 0;
        document.getElementById("not-found-count").textContent = statusData.notFoundCount || 0;

        const recentlyProcessedSection = document.getElementById("recently-processed-section");
        const recentRollsElement = document.getElementById("recent-rolls");
        recentRollsElement.innerHTML = "";

        if (
          (statusData.recentSuccessful && statusData.recentSuccessful.length > 0) || 
          (statusData.recentNotFound && statusData.recentNotFound.length > 0)
        ) {
          recentlyProcessedSection.style.display = "block";
          
          if (statusData.recentSuccessful && statusData.recentSuccessful.length > 0) {
            statusData.recentSuccessful.forEach(roll => {
              const rollElement = document.createElement("span");
              rollElement.className = "recent-roll success";
              rollElement.textContent = roll;
              recentRollsElement.appendChild(rollElement);
            });
          }
          
          if (statusData.recentNotFound && statusData.recentNotFound.length > 0) {
            statusData.recentNotFound.forEach(roll => {
              const rollElement = document.createElement("span");
              rollElement.className = "recent-roll failed";
              rollElement.textContent = roll;
              recentRollsElement.appendChild(rollElement);
            });
          }
        } else {
          recentlyProcessedSection.style.display = "none";
        }

        if (statusData.status === "pending") {
          progressText.textContent = statusData.progress || "Processing...";
          progressBar.style.width = statusData.progressPercent || "0%";
        } else {
          clearInterval(poll);

          if (statusData.status === "done") {
            const { downloadURL, notFoundCount, successfulCount } = statusData;

            progressBar.style.width = "100%";
            progressText.textContent = `✅ Done: ${successfulCount} found, ${notFoundCount} not found.`;

            if (statusData.notFound?.length > 0) {
              log("⚠️ Not Found Roll Numbers:");
              statusData.notFound.slice(0, 20).forEach((roll) => log(`❌ ${roll}`));
              if (statusData.notFound.length > 20) {
                log(`... and ${statusData.notFound.length - 20} more`);
              }
            }

            if (successfulCount > 0 && downloadURL) {
              document.getElementById("pdf-iframe").src = downloadURL;
              document.getElementById("download-btn").href = downloadURL;
              document.getElementById("pdf-viewer-section").classList.remove("hidden");
              log(`📄 Generated PDF with ${successfulCount} results. You can download it now.`);
            } else {
              log("❌ No valid roll numbers found. Preview not shown.");
            }
          } else {
            log(`❌ Error: ${statusData.error || "Unknown failure."}`);
          }
        }
      } catch (err) {
        console.error("Status polling error:", err);
        log(`❌ Error while polling for status: ${err.message}`);
      }
    }, 3000);
  } catch (err) {
    console.error(err);
    log("❌ Failed to submit job or poll. Try again.");
  }
});

function formatStep(step) {
  switch(step) {
    case 'initializing': return 'Initializing';
    case 'processing_rolls': return 'Processing Roll Numbers';
    case 'merging_pdfs': return 'Merging PDF Files';
    case 'complete': return 'Complete';
    case 'error': return 'Error';
    default: return step.charAt(0).toUpperCase() + step.slice(1).replace(/_/g, ' ');
  }
}

const addStyles = () => {
  if (document.getElementById('status-panel-styles')) return;
  
  const style = document.createElement('style');
  style.id = 'status-panel-styles';
  style.textContent = `
    .status-panel {
      background-color: #f8f9fa;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    .job-id-badge {
      display: inline-block;
      background-color: #17a2b8;
      color: white;
      font-size: 0.8rem;
      padding: 3px 8px;
      border-radius: 4px;
      font-family: monospace;
      margin-bottom: 8px;
    }
    .status-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 8px;
    }
    .status-item {
      display: flex;
      align-items: center;
      margin-bottom: 4px;
    }
    .status-icon {
      margin-right: 8px;
      font-size: 1.1rem;
      width: 24px;
      text-align: center;
    }
    .status-label {
      font-weight: 500;
      margin-right: 6px;
      color: #495057;
    }
    .status-value {
      font-family: monospace;
    }
    .recently-label {
      font-weight: 500;
      margin-bottom: 6px;
    }
    .recent-rolls {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .recent-roll {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 0.75rem;
      font-family: monospace;
    }
    .recent-roll.success {
      background-color: #d4edda;
      color: #155724;
    }
    .recent-roll.failed {
      background-color: #f8d7da;
      color: #721c24;
    }
    #progress-section {
      margin-top: 15px;
    }
    #progress-bar {
      transition: width 1s ease-in-out;
    }
    #log-section {
      background-color: #212529;
      color: #f8f9fa;
      padding: 10px;
      border-radius: 5px;
      font-family: monospace;
      height: 150px;
      overflow-y: auto;
    }
  `;
  document.head.appendChild(style);
};

document.addEventListener('DOMContentLoaded', addStyles);
