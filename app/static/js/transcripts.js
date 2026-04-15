(() => {
    "use strict";

    const POLL_INTERVAL = 5000;
    const loadingEl = document.getElementById("transcripts-loading");
    const emptyEl = document.getElementById("transcripts-empty");
    const tableEl = document.getElementById("transcripts-table");
    const bodyEl = document.getElementById("transcripts-body");

    let pollTimer = null;
    let hasActiveJobs = false;

    init();

    async function init() {
        await loadJobs();
        // Poll if there are active jobs
        if (hasActiveJobs) {
            pollTimer = setInterval(loadJobs, POLL_INTERVAL);
        }
    }

    async function loadJobs() {
        try {
            const res = await fetch("/api/v1/jobs");
            if (!res.ok) throw new Error("Failed to load");
            const jobs = await res.json();

            loadingEl.classList.add("hidden");

            if (jobs.length === 0) {
                emptyEl.classList.remove("hidden");
                tableEl.classList.add("hidden");
                return;
            }

            emptyEl.classList.add("hidden");
            tableEl.classList.remove("hidden");

            hasActiveJobs = false;
            bodyEl.innerHTML = "";

            jobs.forEach(job => {
                if (job.status === "pending" || job.status === "processing") {
                    hasActiveJobs = true;
                }

                const tr = document.createElement("tr");
                tr.className = "transcript-row";
                if (job.status === "completed") tr.style.cursor = "pointer";

                // File name
                const tdFile = document.createElement("td");
                tdFile.className = "td-file";
                tdFile.textContent = job.original_filename || job.job_id.substring(0, 8) + "...";
                tr.appendChild(tdFile);

                // Date
                const tdDate = document.createElement("td");
                tdDate.className = "td-date";
                tdDate.textContent = formatDate(job.created_at);
                tr.appendChild(tdDate);

                // Duration
                const tdDur = document.createElement("td");
                tdDur.className = "td-duration";
                tdDur.textContent = job.audio_duration ? formatDuration(job.audio_duration) : "--";
                tr.appendChild(tdDur);

                // Status
                const tdStatus = document.createElement("td");
                if (job.status === "processing" || job.status === "pending") {
                    tdStatus.innerHTML = `
                        <div class="status-progress">
                            <div class="mini-progress-track">
                                <div class="mini-progress-fill" style="width:${job.progress || 0}%"></div>
                            </div>
                            <span class="mini-progress-label">${job.progress || 0}%</span>
                        </div>
                    `;
                } else {
                    const badge = document.createElement("span");
                    badge.className = `badge badge-${job.status}`;
                    badge.textContent = job.status;
                    tdStatus.appendChild(badge);
                }
                tr.appendChild(tdStatus);

                // Edited
                const tdEdited = document.createElement("td");
                tdEdited.className = "td-flag";
                tdEdited.innerHTML = job.is_edited ? checkmark() : dash();
                tr.appendChild(tdEdited);

                // Training published
                const tdTrain = document.createElement("td");
                tdTrain.className = "td-flag";
                tdTrain.innerHTML = job.training_published ? checkmark() : dash();
                tr.appendChild(tdTrain);

                // Exported
                const tdExport = document.createElement("td");
                tdExport.className = "td-flag";
                tdExport.innerHTML = job.is_exported ? checkmark() : dash();
                tr.appendChild(tdExport);

                // Actions
                const tdActions = document.createElement("td");
                tdActions.className = "td-actions";

                if (job.status === "completed") {
                    const openBtn = document.createElement("a");
                    openBtn.href = `/editor/${job.job_id}`;
                    openBtn.className = "btn-action";
                    openBtn.textContent = "Open";
                    tdActions.appendChild(openBtn);
                }

                const delBtn = document.createElement("button");
                delBtn.className = "btn-action btn-action-danger";
                delBtn.textContent = "Delete";
                delBtn.addEventListener("click", async (e) => {
                    e.stopPropagation();
                    if (!confirm("Delete this transcript and all its files?")) return;
                    await fetch(`/api/v1/jobs/${job.job_id}`, { method: "DELETE" });
                    await loadJobs();
                });
                tdActions.appendChild(delBtn);

                tr.appendChild(tdActions);

                // Click row to open editor
                if (job.status === "completed" || job.status === "processing" || job.status === "pending") {
                    tr.addEventListener("click", (e) => {
                        if (e.target.closest(".btn-action, .btn-action-danger")) return;
                        window.location.href = `/editor/${job.job_id}`;
                    });
                }

                bodyEl.appendChild(tr);
            });

            // Start or stop polling
            if (!hasActiveJobs && pollTimer) {
                clearInterval(pollTimer);
                pollTimer = null;
            } else if (hasActiveJobs && !pollTimer) {
                pollTimer = setInterval(loadJobs, POLL_INTERVAL);
            }

        } catch (err) {
            console.error("Failed to load jobs:", err);
            loadingEl.innerHTML = "<p>Failed to load transcripts.</p>";
        }
    }

    function checkmark() {
        return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>`;
    }

    function dash() {
        return `<span class="flag-dash">&mdash;</span>`;
    }

    function formatDate(iso) {
        const d = new Date(iso);
        return d.toLocaleDateString("en-ZA", {
            day: "numeric", month: "short", year: "numeric",
        }) + " " + d.toLocaleTimeString("en-ZA", {
            hour: "2-digit", minute: "2-digit",
        });
    }

    function formatDuration(secs) {
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        const s = Math.floor(secs % 60);
        if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
        return `${m}:${String(s).padStart(2, "0")}`;
    }
})();
