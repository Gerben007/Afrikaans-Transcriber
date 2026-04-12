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
        submitBtn.innerHTML = '<div class="spinner" style="width:18px;height:18px;border-width:2px;"></div> Laai op...';
        progressWrap.classList.remove("hidden");

        try {
            const response = await uploadWithProgress("/api/v1/upload", formData, (pct) => {
                progressFill.style.width = pct + "%";
                progressLabel.textContent = pct + "%";
            });

            if (!response.ok) {
                let msg = "Upload het misluk";
                try {
                    const err = await response.json();
                    msg = err.detail || JSON.stringify(err);
                } catch { /* ignore parse errors */ }
                throw new Error(msg);
            }

            const data = await response.json();
            saveToHistory(data.job_id, emailInput.value);
            // Redirect to editor
            window.location.href = `/editor/${data.job_id}`;
        } catch (err) {
            alert("Fout: " + err.message);
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
            Laai op & Transkribeer`;
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
            xhr.addEventListener("error", () => reject(new Error("Netwerk fout")));
            xhr.send(formData);
        });
    }

    // --- History ---
    function saveToHistory(jobId, email) {
        const history = getHistory();
        history.unshift({ job_id: jobId, email, date: new Date().toISOString(), status: "pending" });
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
            link.innerHTML = `
                <code>${item.job_id.substring(0, 8)}...</code>
                <span>${formatDate(item.date)}</span>
            `;
            card.appendChild(link);

            const right = document.createElement("div");
            right.style.cssText = "display:flex;align-items:center;gap:0.5rem;";

            const badge = document.createElement("span");
            badge.className = `badge badge-${item.status || "pending"}`;
            badge.textContent = item.status || "pending";
            right.appendChild(badge);

            const delBtn = document.createElement("button");
            delBtn.className = "btn-icon";
            delBtn.title = "Verwyder";
            delBtn.innerHTML = "&times;";
            delBtn.style.cssText = "color:#dc2626;font-size:1.2rem;";
            delBtn.addEventListener("click", async (e) => {
                e.stopPropagation();
                if (!confirm("Verwyder hierdie transkripsie?")) return;
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

            // Poll for status updates
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
                updateHistoryStatus(jobId, data.status);
                if (data.status === "completed" || data.status === "failed") {
                    clearInterval(pollTimers[jobId]);
                    delete pollTimers[jobId];
                    renderHistory();
                }
            } catch { /* retry */ }
        };
        check();
        pollTimers[jobId] = setInterval(check, POLL_INTERVAL);
    }

    function updateHistoryStatus(jobId, status) {
        const history = getHistory();
        const item = history.find(h => h.job_id === jobId);
        if (item) {
            item.status = status;
            localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
        }
    }

    function formatSize(bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
        return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    }

    function formatDate(iso) {
        return new Date(iso).toLocaleDateString("af-ZA", {
            day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
        });
    }

    renderHistory();
})();
