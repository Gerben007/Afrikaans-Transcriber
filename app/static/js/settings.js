(() => {
    "use strict";

    const POLL_INTERVAL = 5000;
    let pollTimer = null;

    init();

    async function init() {
        await Promise.all([loadStatus(), loadSettings()]);
    }

    async function loadStatus() {
        try {
            const res = await fetch("/api/v1/settings/training-status");
            if (!res.ok) return;
            const data = await res.json();

            document.getElementById("stat-completed").textContent = data.total_completed;
            document.getElementById("stat-edited").textContent = data.total_edited;
            document.getElementById("stat-published").textContent = data.published_count;

            const btn = document.getElementById("btn-train");
            const statusText = document.getElementById("train-status-text");
            const resultEl = document.getElementById("train-result");

            if (data.is_training) {
                btn.disabled = true;
                btn.innerHTML = '<div class="spinner" style="width:16px;height:16px;border-width:2px;"></div> Training...';
                statusText.textContent = "Training is in progress. This may take several hours on CPU.";
                // Poll for updates
                if (!pollTimer) {
                    pollTimer = setInterval(loadStatus, POLL_INTERVAL);
                }
            } else {
                btn.disabled = false;
                btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg> Start Training`;

                if (data.published_count === 0) {
                    statusText.textContent = "No published training data yet. Edit transcripts and click 'Publish Training' first.";
                    btn.disabled = true;
                } else {
                    statusText.textContent = `${data.published_count} published transcript(s) ready for training.`;
                }

                if (pollTimer) {
                    clearInterval(pollTimer);
                    pollTimer = null;
                }
            }

            if (data.last_trained) {
                resultEl.classList.remove("hidden");
                const date = new Date(data.last_trained).toLocaleString("en-ZA");
                const isSuccess = data.last_train_result && data.last_train_result.startsWith("Success");
                resultEl.className = `train-result ${isSuccess ? "result-success" : "result-error"}`;
                resultEl.innerHTML = `
                    <strong>Last trained:</strong> ${date}<br>
                    <strong>Result:</strong> ${data.last_train_result || "Unknown"}
                `;
            }
        } catch (err) {
            console.error("Failed to load training status:", err);
        }
    }

    async function loadSettings() {
        try {
            const res = await fetch("/api/v1/settings");
            if (!res.ok) return;
            const data = await res.json();
            const sched = data.training_schedule || {};

            document.getElementById("auto-train-toggle").checked = sched.auto_train_enabled || false;
            document.getElementById("train-schedule").value = sched.auto_train_cron || "weekly";
            document.getElementById("min-published").value = sched.min_published_before_train || 5;
        } catch (err) {
            console.error("Failed to load settings:", err);
        }
    }

    // Train Now button
    document.getElementById("btn-train").addEventListener("click", async () => {
        if (!confirm("Start model training? This may take several hours on CPU and will use all published training data.")) return;

        const btn = document.getElementById("btn-train");
        btn.disabled = true;
        btn.innerHTML = '<div class="spinner" style="width:16px;height:16px;border-width:2px;"></div> Starting...';

        try {
            const res = await fetch("/api/v1/settings/train-now", { method: "POST" });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.detail || "Failed to start training");
            }
            await loadStatus();
        } catch (err) {
            alert("Error: " + err.message);
            btn.disabled = false;
            btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg> Start Training`;
        }
    });

    // Save Schedule
    document.getElementById("btn-save-schedule").addEventListener("click", async () => {
        const btn = document.getElementById("btn-save-schedule");
        const settings = {
            training_schedule: {
                auto_train_enabled: document.getElementById("auto-train-toggle").checked,
                auto_train_cron: document.getElementById("train-schedule").value,
                min_published_before_train: parseInt(document.getElementById("min-published").value) || 5,
            }
        };

        btn.textContent = "Saving...";
        btn.disabled = true;

        try {
            const res = await fetch("/api/v1/settings", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(settings),
            });
            if (!res.ok) throw new Error("Save failed");
            btn.textContent = "Saved!";
            setTimeout(() => {
                btn.textContent = "Save Schedule";
                btn.disabled = false;
            }, 2000);
        } catch (err) {
            alert("Failed to save: " + err.message);
            btn.textContent = "Save Schedule";
            btn.disabled = false;
        }
    });
})();
