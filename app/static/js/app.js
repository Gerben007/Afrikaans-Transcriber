(() => {
    "use strict";

    const POLL_INTERVAL = 3000;
    const HISTORY_KEY = "transcriber_jobs";

    const dropZone = document.getElementById("drop-zone");
    const fileInput = document.getElementById("file-input");
    const fileSelected = document.getElementById("file-selected");
    const fileName = document.getElementById("file-name");
    const fileSize = document.getElementById("file-size");
    const clearFileBtn = document.getElementById("clear-file");
    const emailInput = document.getElementById("email");
    const form = document.getElementById("upload-form");
    const submitBtn = document.getElementById("submit-btn");
    const progressWrap = document.getElementById("progress-wrap");
    const progressFill = document.getElementById("progress-fill");
    const progressLabel = document.getElementById("progress-label");
    const jobsSection = document.getElementById("jobs-section");
    const jobsList = document.getElementById("jobs-list");

    let selectedFile = null;
    let pollTimers = {};

    // --- File Selection ---
    dropZone.addEventListener("click", () => fileInput.click());

    dropZone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropZone.classList.add("dragover");
    });

    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));

    dropZone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropZone.classList.remove("dragover");
        if (e.dataTransfer.files.length > 0) setFile(e.dataTransfer.files[0]);
    });

    fileInput.addEventListener("change", () => {
        if (fileInput.files.length > 0) setFile(fileInput.files[0]);
    });

    clearFileBtn.addEventListener("click", clearFile);
    emailInput.addEventListener("input", updateSubmitState);

    function setFile(file) {
        selectedFile = file;
        fileName.textContent = file.name;
        fileSize.textContent = formatSize(file.size);
        fileSelected.classList.remove("hidden");
        dropZone.classList.add("hidden");
        updateSubmitState();
    }

    function clearFile() {
        selectedFile = null;
        fileInput.value = "";
        fileSelected.classList.add("hidden");
        dropZone.classList.remove("hidden");
        updateSubmitState();
    }

    function updateSubmitState() {
        submitBtn.disabled = !(selectedFile && emailInput.value.includes("@"));
    }

    // --- Upload ---
    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (!selectedFile || !emailInput.value) return;

        const formData = new FormData();
        formData.append("file", selectedFile);
        formData.append("client_email", emailInput.value);

        submitBtn.disabled = true;
        submitBtn.innerHTML = '<div class="spinner" style="width:18px;height:18px;border-width:2px;"></div> Uploading...';
        progressWrap.classList.remove("hidden");

        try {
            const response = await uploadWithProgress("/api/v1/upload", formData, (pct) => {
                progressFill.style.width = pct + "%";
                progressLabel.textContent = pct + "%";
            });

            if (!response.ok) {
                let msg = "Upload failed";
                try {
                    const err = await response.json();
                    msg = err.detail || JSON.stringify(err);
                } catch { /* ignore parse errors */ }
                throw new Error(msg);
            }

            const data = await response.json();
            saveToHistory(data.job_id, emailInput.value, selectedFile.name);
            window.location.href = `/editor/${data.job_id}`;
        } catch (err) {
            alert("Error: " + err.message);
            resetForm();
        }
    });

    function resetForm() {
        submitBtn.disabled = false;
        submitBtn.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="17 8 12 3 7 8"/>
                <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            Upload & Transcribe`;
        progressWrap.classList.add("hidden");
        progressFill.style.width = "0%";
        progressLabel.textContent = "0%";
    }

    function uploadWithProgress(url, formData, onProgress) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("POST", url);
            xhr.upload.addEventListener("progress", (e) => {
                if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
            });
            xhr.addEventListener("load", () => {
                resolve({
                    ok: xhr.status >= 200 && xhr.status < 300,
                    status: xhr.status,
                    json: () => Promise.resolve(JSON.parse(xhr.responseText)),
                });
            });
            xhr.addEventListener("error", () => reject(new Error("Network error")));
            xhr.send(formData);
        });
    }

    // --- History ---
    function saveToHistory(jobId, email, filename) {
        const history = getHistory();
        history.unshift({
            job_id: jobId,
            email,
            filename: filename || "Recording",
            date: new Date().toISOString(),
            status: "pending",
            progress: 0,
        });
        if (history.length > 20) history.pop();
        localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    }

    function getHistory() {
        try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; }
        catch { return []; }
    }

    function renderHistory() {
        const history = getHistory();
        if (history.length === 0) {
            jobsSection.classList.add("hidden");
            return;
        }
        jobsSection.classList.remove("hidden");
        jobsList.innerHTML = "";

        history.forEach((item) => {
            const card = document.createElement("div");
            card.className = "job-card";

            const link = document.createElement("a");
            link.href = `/editor/${item.job_id}`;
            link.className = "job-card-left";

            const nameEl = document.createElement("span");
            nameEl.className = "job-filename";
            nameEl.textContent = item.filename || item.job_id.substring(0, 8) + "...";

            const dateEl = document.createElement("span");
            dateEl.className = "job-date";
            dateEl.textContent = formatDate(item.date);

            link.appendChild(nameEl);
            link.appendChild(dateEl);
            card.appendChild(link);

            // Right side: progress bar or badge + delete
            const right = document.createElement("div");
            right.className = "job-card-right";

            if (item.status === "processing" || item.status === "pending") {
                const progressWrap = document.createElement("div");
                progressWrap.className = "job-progress-wrap";

                const bar = document.createElement("div");
                bar.className = "job-progress-track";
                const fill = document.createElement("div");
                fill.className = "job-progress-fill";
                fill.style.width = (item.progress || 0) + "%";
                fill.dataset.jobId = item.job_id;
                bar.appendChild(fill);
                progressWrap.appendChild(bar);

                const pctLabel = document.createElement("span");
                pctLabel.className = "job-progress-label";
                pctLabel.textContent = (item.progress || 0) + "%";
                pctLabel.dataset.jobId = item.job_id;
                progressWrap.appendChild(pctLabel);

                right.appendChild(progressWrap);
            } else {
                const badge = document.createElement("span");
                badge.className = `badge badge-${item.status || "pending"}`;
                badge.textContent = item.status || "pending";
                right.appendChild(badge);
            }

            const delBtn = document.createElement("button");
            delBtn.className = "btn-icon";
            delBtn.title = "Delete";
            delBtn.innerHTML = "&times;";
            delBtn.style.cssText = "color:#dc2626;font-size:1.2rem;";
            delBtn.addEventListener("click", async (e) => {
                e.stopPropagation();
                if (!confirm("Delete this transcription?")) return;
                try {
                    await fetch(`/api/v1/jobs/${item.job_id}`, { method: "DELETE" });
                } catch {}
                const h = getHistory().filter(j => j.job_id !== item.job_id);
                localStorage.setItem(HISTORY_KEY, JSON.stringify(h));
                renderHistory();
            });
            right.appendChild(delBtn);

            card.appendChild(right);
            jobsList.appendChild(card);

            // Poll for status updates on active jobs
            if (item.status === "pending" || item.status === "processing") {
                pollJobStatus(item.job_id);
            }
        });
    }

    async function pollJobStatus(jobId) {
        if (pollTimers[jobId]) return;
        const check = async () => {
            try {
                const res = await fetch(`/api/v1/jobs/${jobId}`);
                if (!res.ok) return;
                const data = await res.json();
                updateHistoryStatus(jobId, data.status, data.progress, data.original_filename);

                // Update progress bar in the UI
                const fill = document.querySelector(`.job-progress-fill[data-job-id="${jobId}"]`);
                const label = document.querySelector(`.job-progress-label[data-job-id="${jobId}"]`);
                if (fill) fill.style.width = (data.progress || 0) + "%";
                if (label) label.textContent = (data.progress || 0) + "%";

                if (data.status === "completed" || data.status === "failed" || data.status === "cancelled") {
                    clearInterval(pollTimers[jobId]);
                    delete pollTimers[jobId];
                    renderHistory();
                }
            } catch { /* retry */ }
        };
        check();
        pollTimers[jobId] = setInterval(check, POLL_INTERVAL);
    }

    function updateHistoryStatus(jobId, status, progress, filename) {
        const history = getHistory();
        const item = history.find(h => h.job_id === jobId);
        if (item) {
            item.status = status;
            if (progress !== undefined) item.progress = progress;
            if (filename && !item.filename) item.filename = filename;
            localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
        }
    }

    function formatSize(bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
        return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    }

    function formatDate(iso) {
        return new Date(iso).toLocaleDateString("en-ZA", {
            day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
        });
    }

    // --- Microphone Recording ---
    const recordBtn = document.getElementById("record-btn");
    const recordLabel = document.getElementById("record-label");
    const recordingStatus = document.getElementById("recording-status");
    const recordingTime = document.getElementById("recording-time");

    let mediaRecorder = null;
    let audioChunks = [];
    let recordingStartTime = null;
    let recordingTimer = null;

    if (recordBtn) {
        recordBtn.addEventListener("click", async () => {
            if (mediaRecorder && mediaRecorder.state === "recording") {
                stopRecording();
            } else {
                await startRecording();
            }
        });
    }

    async function startRecording() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            audioChunks = [];

            const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
                ? "audio/webm;codecs=opus"
                : "audio/webm";

            mediaRecorder = new MediaRecorder(stream, { mimeType });

            mediaRecorder.addEventListener("dataavailable", (e) => {
                if (e.data.size > 0) audioChunks.push(e.data);
            });

            mediaRecorder.addEventListener("stop", () => {
                stream.getTracks().forEach(t => t.stop());

                const now = new Date();
                const dateStr = now.toISOString().slice(0, 10);
                const timeStr = now.toTimeString().slice(0, 5).replace(":", ".");
                const recName = `Recording ${dateStr} at ${timeStr}.webm`;

                const blob = new Blob(audioChunks, { type: mimeType });
                const file = new File([blob], recName, { type: mimeType });

                setFile(file);
                recordBtn.classList.remove("recording");
                recordLabel.textContent = "Record";
                recordingStatus.classList.add("hidden");
                clearInterval(recordingTimer);
            });

            mediaRecorder.start(1000);
            recordingStartTime = Date.now();
            recordBtn.classList.add("recording");
            recordLabel.textContent = "Stop";
            recordingStatus.classList.remove("hidden");

            recordingTimer = setInterval(() => {
                const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
                const m = Math.floor(elapsed / 60);
                const s = elapsed % 60;
                recordingTime.textContent = String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
            }, 500);

        } catch (err) {
            alert("Could not access microphone. Please grant permission in your browser.");
            console.error("Microphone error:", err);
        }
    }

    function stopRecording() {
        if (mediaRecorder && mediaRecorder.state === "recording") {
            mediaRecorder.stop();
        }
    }

    renderHistory();
})();
