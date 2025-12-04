// DOM Elements
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const fileList = document.getElementById('file-list');
const selectedFiles = document.getElementById('selected-files');
const clearBtn = document.getElementById('clear-btn');
const transcodeBtn = document.getElementById('transcode-btn');
const uploadSection = document.getElementById('upload-section');
const progressSection = document.getElementById('progress-section');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');
const fileProgress = document.getElementById('file-progress');
const resultSection = document.getElementById('result-section');
const successResult = document.getElementById('success-result');
const errorResult = document.getElementById('error-result');
const resultSummary = document.getElementById('result-summary');
const errorMessage = document.getElementById('error-message');
const downloadBtn = document.getElementById('download-btn');
const newJobBtn = document.getElementById('new-job-btn');
const retryBtn = document.getElementById('retry-btn');

// State
let files = [];
let currentJobId = null;
let pollInterval = null;

// Utility functions
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function showSection(section) {
  uploadSection.classList.add('hidden');
  progressSection.classList.add('hidden');
  resultSection.classList.add('hidden');
  successResult.classList.add('hidden');
  errorResult.classList.add('hidden');
  
  section.classList.remove('hidden');
}

// File handling
function handleFiles(newFiles) {
  const mp3Files = Array.from(newFiles).filter(f => 
    f.type === 'audio/mpeg' || f.name.toLowerCase().endsWith('.mp3')
  );
  
  if (mp3Files.length === 0) {
    alert('Please select MP3 files only.');
    return;
  }
  
  files = [...files, ...mp3Files];
  renderFileList();
}

function renderFileList() {
  if (files.length === 0) {
    fileList.classList.add('hidden');
    return;
  }
  
  fileList.classList.remove('hidden');
  selectedFiles.innerHTML = files.map((file, index) => `
    <li>
      <span class="file-name">
        <span>🎵</span>
        <span>${file.name}</span>
      </span>
      <span class="file-size">${formatFileSize(file.size)}</span>
    </li>
  `).join('');
}

function clearFiles() {
  files = [];
  fileInput.value = '';
  renderFileList();
}

// Drag and drop
dropZone.addEventListener('click', () => fileInput.click());

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  handleFiles(e.dataTransfer.files);
});

fileInput.addEventListener('change', (e) => {
  handleFiles(e.target.files);
});

clearBtn.addEventListener('click', clearFiles);

// Transcoding
async function startTranscode() {
  if (files.length === 0) return;
  
  showSection(progressSection);
  progressFill.style.width = '0%';
  progressText.textContent = 'Uploading files...';
  fileProgress.innerHTML = '';
  
  // Create form data
  const formData = new FormData();
  files.forEach(file => formData.append('files', file));
  
  try {
    // Start transcode job
    const response = await fetch('/transcode', {
      method: 'POST',
      body: formData
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Upload failed');
    }
    
    const data = await response.json();
    currentJobId = data.jobId;
    
    progressText.textContent = 'Transcoding...';
    
    // Start polling for status
    pollJobStatus();
    
  } catch (error) {
    console.error('Transcode error:', error);
    showError(error.message);
  }
}

async function pollJobStatus() {
  if (!currentJobId) return;
  
  try {
    const response = await fetch(`/status/${currentJobId}`);
    const status = await response.json();
    
    if (response.status === 404) {
      showError('Job not found');
      return;
    }
    
    // Update progress UI
    updateProgress(status);
    
    // Check if complete
    if (status.status === 'completed' || status.status === 'completed_with_errors') {
      showSuccess(status);
    } else if (status.status === 'failed') {
      showError(status.error || 'Transcoding failed');
    } else {
      // Continue polling
      setTimeout(pollJobStatus, 1000);
    }
    
  } catch (error) {
    console.error('Poll error:', error);
    setTimeout(pollJobStatus, 2000);
  }
}

function updateProgress(status) {
  const total = status.files.length;
  const completed = status.completedFiles + status.failedFiles;
  const percent = Math.round((completed / total) * 100);
  
  progressFill.style.width = `${percent}%`;
  progressText.textContent = `Transcoding: ${completed} of ${total} files (${percent}%)`;
  
  // Update file progress
  fileProgress.innerHTML = status.files.map(file => {
    let icon = '⏳';
    let detail = 'Waiting...';
    
    if (file.status === 'processing') {
      icon = '🔄';
      detail = 'Transcoding...';
    } else if (file.status === 'completed') {
      icon = '✅';
      detail = `${file.segmentCount} segments`;
    } else if (file.status === 'failed') {
      icon = '❌';
      detail = file.error || 'Failed';
    }
    
    return `
      <div class="file-progress-item">
        <span class="status-icon">${icon}</span>
        <div class="file-info">
          <div class="file-name">${file.name}</div>
          <div class="file-detail">${detail}</div>
        </div>
      </div>
    `;
  }).join('');
}

function showSuccess(status) {
  showSection(resultSection);
  successResult.classList.remove('hidden');
  
  const successCount = status.completedFiles;
  const failedCount = status.failedFiles;
  
  if (failedCount > 0) {
    resultSummary.textContent = `${successCount} file(s) transcoded successfully, ${failedCount} failed.`;
  } else {
    resultSummary.textContent = `All ${successCount} file(s) transcoded successfully!`;
  }
}

function showError(message) {
  showSection(resultSection);
  errorResult.classList.remove('hidden');
  errorMessage.textContent = message;
}

function downloadResult() {
  if (!currentJobId) return;
  window.location.href = `/download/${currentJobId}`;
}

function resetUI() {
  currentJobId = null;
  files = [];
  fileInput.value = '';
  renderFileList();
  showSection(uploadSection);
}

// Event listeners
transcodeBtn.addEventListener('click', startTranscode);
downloadBtn.addEventListener('click', downloadResult);
newJobBtn.addEventListener('click', resetUI);
retryBtn.addEventListener('click', resetUI);

// Initialize
showSection(uploadSection);
