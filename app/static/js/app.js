(() => {
    "use strict";

    const POLL_INTERVAL = 3000;
    const HISTORY_KEY = "transcriber_jobs";

    // DOM elements
    const dropZone = document.getElementById("drop-zone");
    const fileInput = document.getElementById("file-input");
    const fileInfo = document.getElementById("file-info");
    const fileName = document.getElementById("file-name");
    const clearFileBtn = document.getElementById("clear-file");
    const emailInput = document.getElementById("email");
    const form = document.getElementById("upload-form");
    const submitBtn = document.getElementById("submit-btn");
    const progressContainer = document.getElementById("progress-bar-container");
    const progressBar = document.getElementById("progress-bar");
    const progressText = document.getElementById("progress-text");
    const uploadSection = document.getElementById("upload-section");
    const statusSection = document.getElementById("status-section");
    const jobIdDisplay = document.getElementById("job-id-display");
    const jobStatusBadge = document.getElementById("job-status-badge");
    const errorRow = document.getElementById("error-row");
    const jobError = document.getElementById("job-error");
    const transcriptSection = document.getElementById("transcript-section");
    const transcriptText = document.getElementById("transcript-text");
    const downloadLink = document.getElementById("download-link");
    const newUploadBtn = document.getElementById("new-upload-btn");
    const historySection = document.getElementById("history-section");
    const historyList = document.getElementById("history-list");

    let selectedFile = null;
    let pollTimer = null;

    // --- File Selection ---

    dropZone.addEventListener("click", () => fileInput.click());

    dropZone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropZone.classList.add("dragover");
    });

    dropZone.addEventListener("dragleave", () => {
        dropZone.classList.remove("dragover");
    });

    dropZone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropZone.classList.remove("dragover");
        if (e.dataTransfer.files.length > 0) {
            setFile(e.dataTransfer.files[0]);
        }
    });

    fileInput.addEventListener("change", () => {
        if (fileInput.files.length > 0) {
            setFile(fileInput.files[0]);
        }
    });

    clearFileBtn.addEventListener("click", () => {
        clearFile();
    });

    function setFile(file) {
        selectedFile = file;
        fileName.textContent = `${file.name} (${formatSize(file.size)})`;
        fileInfo.classList.remove("hidden");
        dropZone.classList.add("hidden");
        updateSubmitState();
    }

    function clearFile() {
        selectedFile = null;
        fileInput.value = "";
        fileInfo.classList.add("hidden");
        dropZone.classList.remove("hidden");
        updateSubmitState();
    }

    function updateSubmitState() {
        submitBtn.disabled = !(selectedFile && emailInput.value.includes("@"));
    }

    emailInput.addEventListener("input", updateSubmitState);

    // --- Upload ---

    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (!selectedFile || !emailInput.value) return;

        const formData = new FormData();
        formData.append("file", selectedFile);
        formData.append("client_email", emailInput.value);

        submitBtn.disabled = true;
        submitBtn.textContent = "Laai op...";
        progressContainer.classList.remove("hidden");

        try {
            const response = await uploadWithProgress(
                "/api/v1/upload",
                formData,
                (pct) => {
                    progressBar.style.setProperty("--progress", pct + "%");
                    progressText.textContent = pct + "%";
                }
            );

            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.detail || "Upload failed");
            }

            const data = await response.json();
            saveToHistory(data.job_id, emailInput.value);
            showStatus(data.job_id);
        } catch (err) {
            alert("Fout: " + err.message);
            submitBtn.disabled = false;
            submitBtn.textContent = "Laai op & Transkribeer";
            progressContainer.classList.add("hidden");
        }
    });

    function uploadWithProgress(url, formData, onProgress) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("POST", url);

            xhr.upload.addEventListener("progress", (e) => {
                if (e.lengthComputable) {
                    const pct = Math.round((e.loaded / e.total) * 100);
                    onProgress(pct);
                }
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

    // --- Job Status ---

    function showStatus(jobId) {
        uploadSection.classList.add("hidden");
        statusSection.classList.remove("hidden");
        transcriptSection.classList.add("hidden");
        errorRow.classList.add("hidden");
        jobIdDisplay.textContent = jobId;
        jobStatusBadge.textContent = "pending";
        jobStatusBadge.className = "badge pending";
        pollJob(jobId);
    }

    function pollJob(jobId) {
        if (pollTimer) clearInterval(pollTimer);

        const check = async () => {
            try {
                const res = await fetch(`/api/v1/jobs/${jobId}`);
                if (!res.ok) return;
                const data = await res.json();

                jobStatusBadge.textContent = data.status;
                jobStatusBadge.className = `badge ${data.status}`;

                if (data.status === "failed") {
                    clearInterval(pollTimer);
                    errorRow.classList.remove("hidden");
                    jobError.textContent = data.error_message || "Unknown error";
                }

                if (data.status === "completed") {
                    clearInterval(pollTimer);
                    if (data.transcript_url) {
                        downloadLink.href = data.transcript_url;
                        // Fetch and display transcript text
                        try {
                            const txtRes = await fetch(data.transcript_url);
                            if (txtRes.ok) {
                                transcriptText.textContent = await txtRes.text();
                            }
                        } catch {
                            transcriptText.textContent = "(Could not load transcript preview)";
                        }
                        transcriptSection.classList.remove("hidden");
                    }
                }
            } catch {
                // Silently retry on network errors
            }
        };

        check();
        pollTimer = setInterval(check, POLL_INTERVAL);
    }

    // --- New Upload ---

    newUploadBtn.addEventListener("click", () => {
        if (pollTimer) clearInterval(pollTimer);
        statusSection.classList.add("hidden");
        uploadSection.classList.remove("hidden");
        clearFile();
        submitBtn.textContent = "Laai op & Transkribeer";
        submitBtn.disabled = true;
        progressContainer.classList.add("hidden");
        progressBar.style.setProperty("--progress", "0%");
        progressText.textContent = "0%";
        renderHistory();
    });

    // --- History (localStorage) ---

    function saveToHistory(jobId, email) {
        const history = getHistory();
        history.unshift({ job_id: jobId, email: email, date: new Date().toISOString() });
        if (history.length > 20) history.pop();
        localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    }

    function getHistory() {
        try {
            return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
        } catch {
            return [];
        }
    }

    function renderHistory() {
        const history = getHistory();
        if (history.length === 0) {
            historySection.classList.add("hidden");
            return;
        }
        historySection.classList.remove("hidden");
        historyList.innerHTML = "";
        history.forEach((item) => {
            const li = document.createElement("li");
            li.innerHTML = `
                <code>${item.job_id.substring(0, 8)}...</code>
                <span>${formatDate(item.date)}</span>
            `;
            li.addEventListener("click", () => showStatus(item.job_id));
            historyList.appendChild(li);
        });
    }

    // --- Utilities ---

    function formatSize(bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
        return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    }

    function formatDate(iso) {
        const d = new Date(iso);
        return d.toLocaleDateString("af-ZA", {
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
        });
    }

    // Init
    renderHistory();
})();
