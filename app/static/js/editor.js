(() => {
    "use strict";

    const JOB_ID = window.__JOB_ID__;
    const POLL_INTERVAL = 3000;
    const SAVE_DEBOUNCE = 2000;
    const CONFIDENCE_THRESHOLD = 0.7;
    const SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

    // DOM
    const loadingEl = document.getElementById("editor-loading");
    const processingEl = document.getElementById("editor-processing");
    const processingStatus = document.getElementById("processing-status");
    const contentEl = document.getElementById("editor-content");
    const playerBar = document.getElementById("player-bar");
    const container = document.getElementById("transcript-container");
    const audioEl = document.getElementById("audio-el");
    const btnPlay = document.getElementById("btn-play");
    const iconPlay = document.getElementById("icon-play");
    const iconPause = document.getElementById("icon-pause");
    const btnRw = document.getElementById("btn-rw");
    const btnFf = document.getElementById("btn-ff");
    const seekBar = document.getElementById("seek-bar");
    const timeCurrent = document.getElementById("time-current");
    const btnSpeed = document.getElementById("btn-speed");
    const saveIndicator = document.getElementById("save-indicator");
    const btnExport = document.getElementById("btn-export");
    const btnDownloadTxt = document.getElementById("btn-download-txt");

    let segments = [];
    let jobData = null;
    let saveTimer = null;
    let speedIdx = 2; // 1.0x

    // --- Init ---
    init();

    async function init() {
        const res = await fetch(`/api/v1/jobs/${JOB_ID}`);
        if (!res.ok) {
            loadingEl.innerHTML = "<p>Werk nie gevind nie.</p>";
            return;
        }
        jobData = await res.json();

        if (jobData.status === "pending" || jobData.status === "processing") {
            loadingEl.classList.add("hidden");
            processingEl.classList.remove("hidden");
            processingStatus.textContent = jobData.status === "pending" ? "In die tou..." : "Word verwerk...";
            pollUntilReady();
            return;
        }

        if (jobData.status === "failed") {
            loadingEl.innerHTML = `<p style="color:var(--danger)">Transkripsie het misluk: ${jobData.error_message || "Onbekende fout"}</p>`;
            return;
        }

        await loadEditor();
    }

    function pollUntilReady() {
        const timer = setInterval(async () => {
            const res = await fetch(`/api/v1/jobs/${JOB_ID}`);
            if (!res.ok) return;
            jobData = await res.json();
            processingStatus.textContent = jobData.status === "pending" ? "In die tou..." : "Word verwerk...";

            if (jobData.status === "completed") {
                clearInterval(timer);
                processingEl.classList.add("hidden");
                await loadEditor();
            } else if (jobData.status === "failed") {
                clearInterval(timer);
                processingEl.innerHTML = `<p style="color:var(--danger)">Misluk: ${jobData.error_message || ""}</p>`;
            }
        }, POLL_INTERVAL);
    }

    async function loadEditor() {
        // Load transcript JSON
        const res = await fetch(`/api/v1/jobs/${JOB_ID}/transcript`);
        if (!res.ok) {
            loadingEl.innerHTML = "<p>Kon nie transkripsie laai nie.</p>";
            return;
        }
        const data = await res.json();
        segments = data.segments || [];

        // Set up audio
        if (jobData.audio_url) {
            audioEl.src = jobData.audio_url;
            playerBar.classList.remove("hidden");
        }

        renderSegments();
        loadingEl.classList.add("hidden");
        contentEl.classList.remove("hidden");
        setupAudioEvents();
        setupToolbar();
    }

    // --- Render Segments ---
    function renderSegments() {
        container.innerHTML = "";

        segments.forEach((seg, idx) => {
            const div = document.createElement("div");
            div.className = "segment";
            div.dataset.idx = idx;

            // Timestamp
            const ts = document.createElement("div");
            ts.className = "segment-timestamp";
            ts.textContent = formatTimestamp(seg.start);
            ts.addEventListener("click", () => seekTo(seg.start));
            div.appendChild(ts);

            // Body
            const body = document.createElement("div");
            body.className = "segment-body";

            // Speaker
            const speaker = document.createElement("div");
            speaker.className = "segment-speaker";
            speaker.contentEditable = "true";
            speaker.spellcheck = false;
            speaker.textContent = seg.speaker || "Spreker 1";
            speaker.addEventListener("blur", () => {
                segments[idx].speaker = speaker.textContent.trim() || "Spreker 1";
                scheduleSave();
            });
            body.appendChild(speaker);

            // Text
            const text = document.createElement("div");
            text.className = "segment-text";
            text.dataset.segIdx = idx;

            if (seg.words && seg.words.length > 0) {
                seg.words.forEach((w, wIdx) => {
                    const span = document.createElement("span");
                    span.className = "word";
                    span.dataset.segIdx = idx;
                    span.dataset.wordIdx = wIdx;
                    span.dataset.start = w.start;
                    span.dataset.end = w.end;
                    span.textContent = w.word;
                    if (w.probability < CONFIDENCE_THRESHOLD) {
                        span.classList.add("low-confidence");
                    }
                    text.appendChild(span);
                });
            } else {
                text.textContent = seg.text;
            }

            text.contentEditable = "true";
            text.spellcheck = true;
            text.setAttribute("lang", "af");

            text.addEventListener("input", () => {
                segments[idx].text = text.innerText.trim();
                scheduleSave();
            });

            text.addEventListener("keydown", (e) => {
                if (e.key === "Tab") {
                    e.preventDefault();
                    // Toggle playback on Tab
                    togglePlayback();
                }
            });

            body.appendChild(text);
            div.appendChild(body);
            container.appendChild(div);
        });
    }

    // --- Audio Player ---
    function setupAudioEvents() {
        btnPlay.addEventListener("click", togglePlayback);
        btnRw.addEventListener("click", () => { audioEl.currentTime = Math.max(0, audioEl.currentTime - 5); });
        btnFf.addEventListener("click", () => { audioEl.currentTime = Math.min(audioEl.duration || 0, audioEl.currentTime + 5); });

        audioEl.addEventListener("timeupdate", () => {
            timeCurrent.textContent = formatTimestamp(audioEl.currentTime);
            if (audioEl.duration) {
                seekBar.value = (audioEl.currentTime / audioEl.duration) * 100;
            }
            highlightActiveWord(audioEl.currentTime);
        });

        audioEl.addEventListener("loadedmetadata", () => {
            seekBar.max = 100;
        });

        seekBar.addEventListener("input", () => {
            if (audioEl.duration) {
                audioEl.currentTime = (seekBar.value / 100) * audioEl.duration;
            }
        });

        btnSpeed.addEventListener("click", () => {
            speedIdx = (speedIdx + 1) % SPEEDS.length;
            audioEl.playbackRate = SPEEDS[speedIdx];
            btnSpeed.textContent = SPEEDS[speedIdx] + "x";
        });

        // Keyboard shortcuts
        document.addEventListener("keydown", (e) => {
            // Only handle shortcuts when not editing text
            const active = document.activeElement;
            const isEditing = active && (active.contentEditable === "true" || active.tagName === "INPUT");

            if (e.key === " " && !isEditing) {
                e.preventDefault();
                togglePlayback();
            }
            if (e.ctrlKey && e.key === "s") {
                e.preventDefault();
                saveNow();
            }
        });
    }

    function togglePlayback() {
        if (audioEl.paused) {
            audioEl.play();
            iconPlay.classList.add("hidden");
            iconPause.classList.remove("hidden");
        } else {
            audioEl.pause();
            iconPlay.classList.remove("hidden");
            iconPause.classList.add("hidden");
        }
    }

    function seekTo(time) {
        audioEl.currentTime = time;
        if (audioEl.paused) {
            audioEl.play();
            iconPlay.classList.add("hidden");
            iconPause.classList.remove("hidden");
        }
    }

    // --- Word Highlighting ---
    let lastActiveWord = null;

    function highlightActiveWord(time) {
        // Remove previous highlight
        if (lastActiveWord) {
            lastActiveWord.classList.remove("active");
            lastActiveWord = null;
        }

        // Find the word at current time
        const words = container.querySelectorAll(".word");
        for (const span of words) {
            const start = parseFloat(span.dataset.start);
            const end = parseFloat(span.dataset.end);
            if (time >= start && time < end) {
                span.classList.add("active");
                lastActiveWord = span;

                // Scroll into view if needed
                const rect = span.getBoundingClientRect();
                const editorBody = document.querySelector(".editor-body");
                if (editorBody) {
                    const bodyRect = editorBody.getBoundingClientRect();
                    if (rect.top < bodyRect.top + 50 || rect.bottom > bodyRect.bottom - 80) {
                        span.scrollIntoView({ behavior: "smooth", block: "center" });
                    }
                }
                break;
            }
        }
    }

    // --- Save ---
    function scheduleSave() {
        if (saveTimer) clearTimeout(saveTimer);
        saveIndicator.classList.remove("visible");
        saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE);
    }

    async function saveNow() {
        if (saveTimer) clearTimeout(saveTimer);
        try {
            const res = await fetch(`/api/v1/jobs/${JOB_ID}/transcript`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ segments }),
            });
            if (res.ok) {
                saveIndicator.classList.add("visible");
                setTimeout(() => saveIndicator.classList.remove("visible"), 3000);
            }
        } catch (err) {
            console.error("Save failed:", err);
        }
    }

    // --- Toolbar ---
    function setupToolbar() {
        btnExport.addEventListener("click", async () => {
            try {
                const res = await fetch(`/api/v1/jobs/${JOB_ID}/export-training`);
                if (!res.ok) throw new Error("Export failed");
                const data = await res.json();
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
                downloadBlob(blob, `training_${JOB_ID.substring(0, 8)}.json`);
            } catch (err) {
                alert("Eksport het misluk: " + err.message);
            }
        });

        btnDownloadTxt.addEventListener("click", () => {
            const text = segments.map(s => s.text).join("\n");
            const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
            downloadBlob(blob, `transkripsie_${JOB_ID.substring(0, 8)}.txt`);
        });

        document.getElementById("btn-delete").addEventListener("click", async () => {
            if (!confirm("Is jy seker jy wil hierdie transkripsie verwyder? Dit kan nie ongedaan gemaak word nie.")) return;
            try {
                const res = await fetch(`/api/v1/jobs/${JOB_ID}`, { method: "DELETE" });
                if (!res.ok) throw new Error("Delete failed");
                // Remove from localStorage history
                const key = "transcriber_jobs";
                try {
                    const history = JSON.parse(localStorage.getItem(key) || "[]");
                    localStorage.setItem(key, JSON.stringify(history.filter(h => h.job_id !== JOB_ID)));
                } catch {}
                window.location.href = "/";
            } catch (err) {
                alert("Kon nie verwyder nie: " + err.message);
            }
        });
    }

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    // --- Utilities ---
    function formatTimestamp(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        const ms = Math.floor((seconds % 1) * 1000);
        return String(h).padStart(2, "0") + ":" +
               String(m).padStart(2, "0") + ":" +
               String(s).padStart(2, "0") + "." +
               String(ms).padStart(3, "0");
    }
})();
