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

    // Speaker colour palette
    const SPEAKER_COLORS = [
        "#e67700", "#2b8a3e", "#1864ab", "#862e9c",
        "#c92a2a", "#5c940d", "#0b7285", "#e8590c",
    ];
    const speakerColorMap = {};
    let nextColorIdx = 0;

    function speakerColor(name) {
        if (!name) return SPEAKER_COLORS[0];
        if (!speakerColorMap[name]) {
            speakerColorMap[name] = SPEAKER_COLORS[nextColorIdx % SPEAKER_COLORS.length];
            nextColorIdx++;
        }
        return speakerColorMap[name];
    }

    let segments = [];
    let originalSegments = []; // Store original transcript for comparison
    let showingOriginal = false;
    let jobData = null;
    let saveTimer = null;
    let speedIdx = 2; // 1.0x
    let aiAvailable = false;

    // --- Init ---
    init();

    async function init() {
        const res = await fetch(`/api/v1/jobs/${JOB_ID}`);
        if (!res.ok) {
            loadingEl.innerHTML = "<p>Job not found.</p>";
            return;
        }
        jobData = await res.json();

        if (jobData.status === "pending" || jobData.status === "processing") {
            loadingEl.classList.add("hidden");
            processingEl.classList.remove("hidden");
            updateProcessingUI(jobData);
            setupCancel();
            pollUntilReady();
            return;
        }

        if (jobData.status === "cancelled") {
            loadingEl.innerHTML = `<p style="color:var(--text-muted)">Transcription cancelled. <a href="/">Back</a></p>`;
            return;
        }

        if (jobData.status === "failed") {
            loadingEl.innerHTML = `<p style="color:var(--danger)">Transcription failed: ${jobData.error_message || "Unknown error"}</p>`;
            return;
        }

        await loadEditor();
    }

    let progressSamples = []; // {time, pct} pairs for rolling ETA

    function updateProcessingUI(data) {
        const pct = data.progress || 0;
        const duration = data.audio_duration;

        if (data.status === "pending") {
            processingStatus.textContent = "Queued...";
        } else {
            processingStatus.textContent = "Processing...";
        }

        // Progress bar
        const fillEl = document.getElementById("proc-progress-fill");
        const pctEl = document.getElementById("proc-progress-pct");
        const etaEl = document.getElementById("proc-eta");

        if (fillEl) fillEl.style.width = pct + "%";
        if (pctEl) pctEl.textContent = pct + "%";

        // Track progress samples for rolling ETA
        if (pct > 10) {
            const now = Date.now();
            progressSamples.push({ time: now, pct });
            // Keep last 20 samples (roughly last 60 seconds of data)
            if (progressSamples.length > 20) progressSamples.shift();
        }

        // ETA calculation using rolling average
        if (etaEl && progressSamples.length >= 2) {
            const oldest = progressSamples[0];
            const newest = progressSamples[progressSamples.length - 1];
            const elapsedSec = (newest.time - oldest.time) / 1000;
            const pctDone = newest.pct - oldest.pct;

            if (pctDone > 0 && elapsedSec > 3) {
                const secsPerPct = elapsedSec / pctDone;
                const remaining = Math.round(secsPerPct * (100 - pct));

                if (remaining > 3600) {
                    const h = Math.floor(remaining / 3600);
                    const m = Math.floor((remaining % 3600) / 60);
                    etaEl.textContent = `ETA: ${h}h ${m}min remaining`;
                } else if (remaining > 60) {
                    const m = Math.floor(remaining / 60);
                    const s = remaining % 60;
                    etaEl.textContent = `ETA: ${m}min ${s}s remaining`;
                } else {
                    etaEl.textContent = `ETA: ${remaining}s remaining`;
                }

                // Also show audio duration context
                if (duration) {
                    const dMins = Math.floor(duration / 60);
                    const dSecs = Math.floor(duration % 60);
                    etaEl.textContent += ` (audio: ${dMins}:${String(dSecs).padStart(2, "0")})`;
                }
            }
        } else if (etaEl && duration && pct <= 10) {
            const dMins = Math.floor(duration / 60);
            const dSecs = Math.floor(duration % 60);
            etaEl.textContent = `Audio duration: ${dMins}:${String(dSecs).padStart(2, "0")}`;
        }
    }

    function setupCancel() {
        const btn = document.getElementById("btn-cancel");
        if (btn) {
            btn.addEventListener("click", async () => {
                if (!confirm("Cancel this transcription?")) return;
                try {
                    await fetch(`/api/v1/jobs/${JOB_ID}/cancel`, { method: "POST" });
                    window.location.href = "/";
                } catch (err) {
                    alert("Could not cancel: " + err.message);
                }
            });
        }
    }

    function pollUntilReady() {
        let liveContainerShown = false;
        let lastSegmentCount = 0;

        const timer = setInterval(async () => {
            const res = await fetch(`/api/v1/jobs/${JOB_ID}`);
            if (!res.ok) return;
            jobData = await res.json();
            updateProcessingUI(jobData);

            // Fetch live transcript while processing
            if (jobData.status === "processing") {
                try {
                    const tRes = await fetch(`/api/v1/jobs/${JOB_ID}/transcript`);
                    if (tRes.ok) {
                        const tData = await tRes.json();
                        const liveSegs = tData.segments || [];
                        if (liveSegs.length > lastSegmentCount) {
                            lastSegmentCount = liveSegs.length;
                            showLiveTranscript(liveSegs);
                            liveContainerShown = true;
                        }
                    }
                } catch {}
            }

            if (jobData.status === "completed") {
                clearInterval(timer);
                // Remove live transcript container
                const liveEl = document.getElementById("live-transcript");
                if (liveEl) liveEl.remove();
                processingEl.classList.add("hidden");
                await loadEditor();
            } else if (jobData.status === "failed") {
                clearInterval(timer);
                processingEl.innerHTML = `<p style="color:var(--danger)">Failed: ${jobData.error_message || ""}</p>`;
            } else if (jobData.status === "cancelled") {
                clearInterval(timer);
                processingEl.innerHTML = `<p style="color:var(--text-muted)">Cancelled. <a href="/">Back</a></p>`;
            }
        }, POLL_INTERVAL);
    }

    function showLiveTranscript(liveSegments) {
        let liveEl = document.getElementById("live-transcript");
        if (!liveEl) {
            liveEl = document.createElement("div");
            liveEl.id = "live-transcript";
            liveEl.className = "live-transcript";
            // Insert after the processing card
            const procCard = document.querySelector(".processing-card");
            if (procCard && procCard.parentNode) {
                procCard.parentNode.appendChild(liveEl);
            }
        }

        liveEl.innerHTML = "";
        const heading = document.createElement("h3");
        heading.textContent = "Live transcription";
        heading.style.cssText = "font-size:0.9rem;color:var(--text-muted);margin-bottom:0.75rem;";
        liveEl.appendChild(heading);

        liveSegments.forEach(seg => {
            const div = document.createElement("div");
            div.className = "live-segment";

            const ts = document.createElement("span");
            ts.className = "live-ts";
            ts.textContent = formatTimestamp(seg.start);

            const txt = document.createElement("span");
            txt.className = "live-text";
            txt.textContent = seg.text;

            div.appendChild(ts);
            div.appendChild(txt);
            liveEl.appendChild(div);
        });

        // Scroll to bottom
        liveEl.scrollTop = liveEl.scrollHeight;
    }

    async function loadEditor() {
        // Load transcript JSON
        const res = await fetch(`/api/v1/jobs/${JOB_ID}/transcript`);
        if (!res.ok) {
            loadingEl.innerHTML = "<p>Could not load transcript.</p>";
            return;
        }
        const data = await res.json();
        segments = data.segments || [];

        // Store deep copy of original segments for diff tracking
        originalSegments = JSON.parse(JSON.stringify(segments));

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
        setupFindReplace();
        initWaveSurfer();
    }

    // --- Render Segments ---
    function renderSegments() {
        container.innerHTML = "";
        closeSpeakerDropdowns();

        // Collect unique speakers for dropdown
        const allSpeakers = [...new Set(segments.map(s => s.speaker || "Spreker 1"))];

        segments.forEach((seg, idx) => {
            const div = document.createElement("div");
            div.className = "segment";
            div.dataset.idx = idx;

            const sName = seg.speaker || "Spreker 1";
            div.style.borderLeftColor = speakerColor(sName);

            // Timestamp
            const ts = document.createElement("div");
            ts.className = "segment-timestamp";
            ts.textContent = formatTimestamp(seg.start);
            ts.addEventListener("click", () => seekTo(seg.start));
            div.appendChild(ts);

            // Body
            const body = document.createElement("div");
            body.className = "segment-body";

            // Speaker (with color dot + dropdown)
            const speakerWrap = document.createElement("div");
            speakerWrap.className = "segment-speaker";
            speakerWrap.style.position = "relative";

            const dot = document.createElement("span");
            dot.className = "speaker-dot";
            dot.style.backgroundColor = speakerColor(sName);
            speakerWrap.appendChild(dot);

            const speakerLabel = document.createElement("span");
            speakerLabel.textContent = sName;
            speakerWrap.appendChild(speakerLabel);

            speakerWrap.addEventListener("click", (e) => {
                e.stopPropagation();
                closeSpeakerDropdowns();
                showSpeakerDropdown(speakerWrap, idx, allSpeakers);
            });
            body.appendChild(speakerWrap);

            // Header row (speaker + warnings + AI button)
            const headerRow = document.createElement("div");
            headerRow.style.cssText = "display:flex;align-items:center;gap:0.25rem;flex-wrap:wrap;";
            headerRow.appendChild(speakerWrap);

            // Pattern warnings
            const warnings = detectPatterns(seg.text);
            if (warnings.length > 0) {
                const badge = document.createElement("span");
                badge.className = "pattern-warning";
                badge.textContent = "⚠ " + warnings.length;
                badge.title = warnings.join("\n");
                badge.addEventListener("click", (e) => {
                    e.stopPropagation();
                    toggleWarningList(badge, warnings);
                });
                headerRow.appendChild(badge);
            }

            // AI Smart Fix button
            if (aiAvailable) {
                const fixBtn = document.createElement("button");
                fixBtn.className = "btn-smart-fix";
                fixBtn.textContent = "✨ Fix";
                fixBtn.title = "AI-assisted correction";
                fixBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    requestAICorrection(idx, fixBtn, body);
                });
                headerRow.appendChild(fixBtn);
            }

            body.appendChild(headerRow);

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
                    span.addEventListener("click", () => {
                        playSnippet(w.start, 3);
                    });
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
                // Clear word-level data since it no longer matches edited text
                segments[idx].words = [];
                // Mark as edited if different from original
                const orig = originalSegments[idx];
                const isEdited = orig && segments[idx].text !== orig.text;
                div.classList.toggle("segment-edited", isEdited);
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

            // Mark as edited if different from original
            if (!showingOriginal && originalSegments[idx] && seg.text !== originalSegments[idx].text) {
                div.classList.add("segment-edited");
            }

            container.appendChild(div);
        });
    }

    function renderOriginalView() {
        container.innerHTML = "";
        const banner = document.createElement("div");
        banner.className = "original-banner";
        banner.textContent = "Viewing original transcript (read-only)";
        container.appendChild(banner);

        originalSegments.forEach((seg, idx) => {
            const div = document.createElement("div");
            div.className = "segment segment-original";

            const ts = document.createElement("div");
            ts.className = "segment-timestamp";
            ts.textContent = formatTimestamp(seg.start);
            ts.addEventListener("click", () => seekTo(seg.start));
            div.appendChild(ts);

            const body = document.createElement("div");
            body.className = "segment-body";

            const speaker = document.createElement("div");
            speaker.className = "segment-speaker";
            speaker.textContent = seg.speaker || "Speaker 1";
            body.appendChild(speaker);

            const text = document.createElement("div");
            text.className = "segment-text";
            text.textContent = seg.text;
            // Show diff: if edited version differs, show it below
            const edited = segments[idx];
            if (edited && edited.text !== seg.text) {
                div.classList.add("segment-has-diff");
                const diffEl = document.createElement("div");
                diffEl.className = "segment-diff";
                diffEl.innerHTML = `<span class="diff-label">Edited:</span> ${edited.text}`;
                body.appendChild(text);
                body.appendChild(diffEl);
            } else {
                body.appendChild(text);
            }

            div.appendChild(body);
            container.appendChild(div);
        });
    }

    // --- Speaker Dropdown ---
    function closeSpeakerDropdowns() {
        document.querySelectorAll(".speaker-dropdown").forEach(d => d.remove());
    }

    function showSpeakerDropdown(wrap, segIdx, allSpeakers) {
        const dd = document.createElement("div");
        dd.className = "speaker-dropdown";

        const current = segments[segIdx].speaker || "Spreker 1";

        allSpeakers.forEach(name => {
            const item = document.createElement("button");
            item.className = "speaker-dropdown-item" + (name === current ? " active" : "");
            const d = document.createElement("span");
            d.className = "speaker-dot";
            d.style.backgroundColor = speakerColor(name);
            item.appendChild(d);
            item.appendChild(document.createTextNode(name));
            item.addEventListener("click", (e) => {
                e.stopPropagation();
                assignSpeaker(segIdx, name);
                closeSpeakerDropdowns();
            });
            dd.appendChild(item);
        });

        // Divider + new speaker
        const divider = document.createElement("div");
        divider.className = "speaker-dropdown-divider";
        dd.appendChild(divider);

        const newBtn = document.createElement("button");
        newBtn.className = "speaker-dropdown-item";
        newBtn.textContent = "+ New speaker...";
        newBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            newBtn.remove();
            const input = document.createElement("input");
            input.className = "speaker-new-input";
            input.placeholder = "Speaker name...";
            input.addEventListener("keydown", (ev) => {
                if (ev.key === "Enter") {
                    const name = input.value.trim();
                    if (name) {
                        assignSpeaker(segIdx, name);
                    }
                    closeSpeakerDropdowns();
                } else if (ev.key === "Escape") {
                    closeSpeakerDropdowns();
                }
            });
            dd.appendChild(input);
            input.focus();
        });
        dd.appendChild(newBtn);

        wrap.appendChild(dd);
    }

    function assignSpeaker(segIdx, name) {
        segments[segIdx].speaker = name;
        scheduleSave();
        renderSegments();
    }

    // Close dropdowns on outside click
    document.addEventListener("click", () => closeSpeakerDropdowns());

    // --- Pattern Detection ---
    const AFRIKAANS_PATTERNS = [
        { regex: /Dankie vir die kyk/gi, msg: "Hallucinated YouTube outro" },
        { regex: /Ondertitels deur/gi, msg: "Hallucinated subtitle credit" },
        { regex: /Teken in op/gi, msg: "Hallucinated subscribe prompt" },
        { regex: /(\b\w+\b)\s+\1/gi, msg: "Repeated word" },
        { regex: /\b(um|uh|eh)\b/gi, msg: "Filler word" },
        { regex: /(?<!\w)'n\b/i, msg: "Check: 'n article usage" },
    ];

    function detectPatterns(text) {
        const found = [];
        AFRIKAANS_PATTERNS.forEach(p => {
            if (p.regex.test(text)) {
                found.push(p.msg);
                p.regex.lastIndex = 0; // reset regex state
            }
        });
        return found;
    }

    function toggleWarningList(badge, warnings) {
        // Remove existing
        const existing = badge.parentElement.querySelector(".pattern-warning-list");
        if (existing) { existing.remove(); return; }

        const list = document.createElement("div");
        list.className = "pattern-warning-list";
        warnings.forEach(w => {
            const item = document.createElement("div");
            item.className = "pattern-warning-item";
            item.textContent = w;
            list.appendChild(item);
        });
        badge.parentElement.style.position = "relative";
        badge.parentElement.appendChild(list);
        setTimeout(() => document.addEventListener("click", function handler() {
            list.remove();
            document.removeEventListener("click", handler);
        }, { once: true }), 0);
    }

    // --- AI Smart Fix ---
    async function checkAIAvailability() {
        try {
            const res = await fetch("/api/v1/ai/status");
            if (res.ok) {
                const data = await res.json();
                aiAvailable = data.available;
            }
        } catch { aiAvailable = false; }
    }

    async function requestAICorrection(segIdx, btn, bodyEl) {
        const origHTML = btn.innerHTML;
        btn.innerHTML = '<span class="correction-loading"></span>';
        btn.disabled = true;

        const seg = segments[segIdx];
        const ctxBefore = segments.slice(Math.max(0, segIdx - 2), segIdx).map(s => s.text);
        const ctxAfter = segments.slice(segIdx + 1, segIdx + 3).map(s => s.text);

        try {
            const res = await fetch("/api/v1/ai/correct-segment", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    segment_text: seg.text,
                    context_before: ctxBefore,
                    context_after: ctxAfter,
                    language: "af",
                }),
            });

            if (!res.ok) {
                const err = await res.json();
                alert("AI correction failed: " + (err.detail || "Unknown error"));
                return;
            }

            const data = await res.json();

            // If suggestion is the same, no changes needed
            if (data.suggestion === seg.text) {
                btn.textContent = "✓ OK";
                setTimeout(() => { btn.innerHTML = origHTML; btn.disabled = false; }, 2000);
                return;
            }

            // Show suggestion UI
            showCorrectionSuggestion(segIdx, data, bodyEl);
        } catch (err) {
            alert("AI correction failed: " + err.message);
        } finally {
            btn.innerHTML = origHTML;
            btn.disabled = false;
        }
    }

    function showCorrectionSuggestion(segIdx, data, bodyEl) {
        // Remove any existing suggestion
        bodyEl.querySelector(".correction-suggestion")?.remove();

        const box = document.createElement("div");
        box.className = "correction-suggestion";

        const textEl = document.createElement("div");
        textEl.className = "correction-suggestion-text";
        textEl.textContent = data.suggestion;
        box.appendChild(textEl);

        if (data.explanation) {
            const explEl = document.createElement("div");
            explEl.className = "correction-explanation";
            explEl.textContent = data.explanation;
            box.appendChild(explEl);
        }

        const actions = document.createElement("div");
        actions.className = "correction-actions";

        const acceptBtn = document.createElement("button");
        acceptBtn.className = "correction-accept";
        acceptBtn.textContent = "✓ Accept";
        acceptBtn.addEventListener("click", () => {
            segments[segIdx].text = data.suggestion;
            segments[segIdx].words = [];
            scheduleSave();
            renderSegments();
        });
        actions.appendChild(acceptBtn);

        const rejectBtn = document.createElement("button");
        rejectBtn.className = "correction-reject";
        rejectBtn.textContent = "✕ Dismiss";
        rejectBtn.addEventListener("click", () => box.remove());
        actions.appendChild(rejectBtn);

        box.appendChild(actions);
        bodyEl.appendChild(box);
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
            const active = document.activeElement;
            const isEditing = active && (active.contentEditable === "true" || active.tagName === "INPUT");

            // Ctrl+Space: play/pause (works even while editing)
            if (e.ctrlKey && e.key === " ") {
                e.preventDefault();
                togglePlayback();
                return;
            }

            // Space: play/pause (only when not editing)
            if (e.key === " " && !isEditing) {
                e.preventDefault();
                togglePlayback();
            }

            // Ctrl+S: save
            if (e.ctrlKey && e.key === "s") {
                e.preventDefault();
                saveNow();
            }

            // Ctrl+H: find & replace
            if (e.ctrlKey && e.key === "h") {
                e.preventDefault();
                toggleFindReplace();
            }

            // Escape: close find & replace
            if (e.key === "Escape") {
                const panel = document.getElementById("find-replace-panel");
                if (panel && !panel.classList.contains("hidden")) {
                    panel.classList.add("hidden");
                    clearFindHighlights();
                }
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

    let snippetTimer = null;

    function playSnippet(startTime, durationSecs) {
        // Clear any previous snippet timer
        if (snippetTimer) clearTimeout(snippetTimer);

        audioEl.currentTime = startTime;
        audioEl.play();
        iconPlay.classList.add("hidden");
        iconPause.classList.remove("hidden");

        // Auto-pause after durationSecs
        snippetTimer = setTimeout(() => {
            audioEl.pause();
            iconPlay.classList.remove("hidden");
            iconPause.classList.add("hidden");
            snippetTimer = null;
        }, durationSecs * 1000);
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
    // Save before navigating away
    window.addEventListener("beforeunload", (e) => {
        if (saveTimer) {
            // There are unsaved changes — save synchronously
            navigator.sendBeacon(
                `/api/v1/jobs/${JOB_ID}/transcript`,
                new Blob([JSON.stringify({ segments })], { type: "application/json" })
            );
        }
    });

    function setupToolbar() {
        // Publish training data
        document.getElementById("btn-publish").addEventListener("click", async () => {
            const btn = document.getElementById("btn-publish");
            const origText = btn.innerHTML;
            if (!confirm("Publish training data? This will split the audio into segments and store them for model training.")) return;

            btn.disabled = true;
            btn.innerHTML = '<div class="spinner" style="width:14px;height:14px;border-width:2px;display:inline-block;vertical-align:middle;"></div> Working...';

            try {
                // Save current edits first
                await saveNow();

                const res = await fetch(`/api/v1/jobs/${JOB_ID}/publish-training`, { method: "POST" });
                if (!res.ok) {
                    const err = await res.json();
                    throw new Error(err.detail || "Publish failed");
                }
                const data = await res.json();
                alert(`Training data published!\n\n${data.segments} segments stored in bucket "${data.bucket}/${data.prefix}"`);
            } catch (err) {
                alert("Could not publish: " + err.message);
            } finally {
                btn.disabled = false;
                btn.innerHTML = origText;
            }
        });

        // Export dropdown
        const exportMenuBtn = document.getElementById("btn-export-menu");
        const exportDD = document.getElementById("export-dropdown");
        if (exportMenuBtn && exportDD) {
            exportMenuBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                exportDD.classList.toggle("hidden");
            });
            document.addEventListener("click", () => exportDD.classList.add("hidden"));

            exportDD.querySelectorAll(".export-item").forEach(item => {
                item.addEventListener("click", async () => {
                    exportDD.classList.add("hidden");
                    await saveNow();
                    const fmt = item.dataset.format;
                    exportTranscript(fmt);
                });
            });
        }

        // Find & Replace button
        const frBtn = document.getElementById("btn-find-replace");
        if (frBtn) frBtn.addEventListener("click", toggleFindReplace);

        // Check AI availability
        checkAIAvailability();

        // Toggle original/edited view
        const toggleBtn = document.getElementById("btn-toggle-original");
        if (toggleBtn) {
            toggleBtn.addEventListener("click", () => {
                showingOriginal = !showingOriginal;
                if (showingOriginal) {
                    // Show original transcript (read-only)
                    toggleBtn.textContent = "Show Edited";
                    toggleBtn.classList.add("btn-toggle-active");
                    renderOriginalView();
                } else {
                    // Show editable transcript
                    toggleBtn.textContent = "Show Original";
                    toggleBtn.classList.remove("btn-toggle-active");
                    renderSegments();
                }
            });
        }

        document.getElementById("btn-delete").addEventListener("click", async () => {
            if (!confirm("Are you sure you want to delete this transcription? This cannot be undone.")) return;
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
                alert("Could not delete: " + err.message);
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

    // --- Export Formats ---
    function exportTranscript(format) {
        const slug = JOB_ID.substring(0, 8);
        switch (format) {
            case "srt": {
                const lines = segments.map((s, i) => {
                    const start = srtTime(s.start);
                    const end = srtTime(s.end);
                    return `${i + 1}\n${start} --> ${end}\n${s.text}\n`;
                });
                downloadBlob(new Blob([lines.join("\n")], { type: "text/srt" }), `transcript_${slug}.srt`);
                break;
            }
            case "dialogue": {
                const lines = segments.map(s => `${s.speaker || "Spreker 1"}: ${s.text}`);
                downloadBlob(new Blob([lines.join("\n\n")], { type: "text/plain;charset=utf-8" }), `dialogue_${slug}.txt`);
                break;
            }
            case "clean": {
                const text = segments.map(s => s.text).join(" ");
                downloadBlob(new Blob([text], { type: "text/plain;charset=utf-8" }), `clean_${slug}.txt`);
                break;
            }
            case "json": {
                (async () => {
                    try {
                        const res = await fetch(`/api/v1/jobs/${JOB_ID}/export-training`);
                        if (!res.ok) throw new Error("Export failed");
                        const data = await res.json();
                        downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }), `training_${slug}.json`);
                    } catch (err) { alert("Export failed: " + err.message); }
                })();
                break;
            }
            case "txt": {
                const text = segments.map(s => s.text).join("\n");
                downloadBlob(new Blob([text], { type: "text/plain;charset=utf-8" }), `transcript_${slug}.txt`);
                break;
            }
        }
    }

    function srtTime(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        const ms = Math.floor((seconds % 1) * 1000);
        return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")},${String(ms).padStart(3,"0")}`;
    }

    // --- Find & Replace ---
    let frMatches = [];
    let frCurrentIdx = -1;

    function toggleFindReplace() {
        const panel = document.getElementById("find-replace-panel");
        panel.classList.toggle("hidden");
        if (!panel.classList.contains("hidden")) {
            document.getElementById("fr-find-input").focus();
        } else {
            clearFindHighlights();
        }
    }

    function clearFindHighlights() {
        container.querySelectorAll(".find-highlight, .find-highlight-active").forEach(el => {
            const parent = el.parentNode;
            parent.replaceChild(document.createTextNode(el.textContent), el);
            parent.normalize();
        });
        frMatches = [];
        frCurrentIdx = -1;
    }

    function setupFindReplace() {
        const panel = document.getElementById("find-replace-panel");
        if (!panel) return;

        const findInput = document.getElementById("fr-find-input");
        const replInput = document.getElementById("fr-replace-input");
        const matchCount = document.getElementById("fr-match-count");
        const closeBtn = document.getElementById("fr-close");

        // Tab switching
        panel.querySelectorAll(".fr-tab").forEach(tab => {
            tab.addEventListener("click", () => {
                panel.querySelectorAll(".fr-tab").forEach(t => t.classList.remove("active"));
                tab.classList.add("active");
                document.getElementById("fr-find-tab").classList.toggle("hidden", tab.dataset.tab !== "find");
                document.getElementById("fr-common-tab").classList.toggle("hidden", tab.dataset.tab !== "common");
                if (tab.dataset.tab === "common") populateCommonFixes();
            });
        });

        closeBtn.addEventListener("click", () => {
            panel.classList.add("hidden");
            clearFindHighlights();
        });

        // Live search
        findInput.addEventListener("input", () => doFind(findInput.value));

        // Navigation
        document.getElementById("fr-prev").addEventListener("click", () => navigateMatch(-1));
        document.getElementById("fr-next").addEventListener("click", () => navigateMatch(1));

        findInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                navigateMatch(e.shiftKey ? -1 : 1);
            }
        });

        // Replace
        document.getElementById("fr-replace-one").addEventListener("click", () => {
            replaceCurrentMatch(replInput.value);
        });

        document.getElementById("fr-replace-all").addEventListener("click", () => {
            replaceAllMatches(findInput.value, replInput.value);
        });
    }

    function doFind(query) {
        clearFindHighlights();
        const matchCountEl = document.getElementById("fr-match-count");
        if (!query) { matchCountEl.textContent = ""; return; }

        const textEls = container.querySelectorAll(".segment-text");
        let total = 0;

        textEls.forEach(el => {
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            const textNodes = [];
            while (walker.nextNode()) textNodes.push(walker.currentNode);

            textNodes.forEach(node => {
                const text = node.textContent;
                const lower = text.toLowerCase();
                const qLower = query.toLowerCase();
                let idx = 0;
                const parts = [];
                let lastIdx = 0;

                while ((idx = lower.indexOf(qLower, idx)) !== -1) {
                    if (idx > lastIdx) parts.push(document.createTextNode(text.substring(lastIdx, idx)));
                    const mark = document.createElement("mark");
                    mark.className = "find-highlight";
                    mark.textContent = text.substring(idx, idx + query.length);
                    parts.push(mark);
                    total++;
                    lastIdx = idx + query.length;
                    idx = lastIdx;
                }

                if (parts.length > 0) {
                    if (lastIdx < text.length) parts.push(document.createTextNode(text.substring(lastIdx)));
                    const frag = document.createDocumentFragment();
                    parts.forEach(p => frag.appendChild(p));
                    node.parentNode.replaceChild(frag, node);
                }
            });
        });

        frMatches = [...container.querySelectorAll(".find-highlight")];
        frCurrentIdx = frMatches.length > 0 ? 0 : -1;
        matchCountEl.textContent = frMatches.length > 0 ? `1 / ${frMatches.length}` : "0 results";
        if (frCurrentIdx >= 0) {
            frMatches[0].classList.add("find-highlight-active");
            frMatches[0].scrollIntoView({ behavior: "smooth", block: "center" });
        }
    }

    function navigateMatch(dir) {
        if (frMatches.length === 0) return;
        frMatches[frCurrentIdx]?.classList.remove("find-highlight-active");
        frCurrentIdx = (frCurrentIdx + dir + frMatches.length) % frMatches.length;
        frMatches[frCurrentIdx].classList.add("find-highlight-active");
        frMatches[frCurrentIdx].scrollIntoView({ behavior: "smooth", block: "center" });
        document.getElementById("fr-match-count").textContent = `${frCurrentIdx + 1} / ${frMatches.length}`;
    }

    function replaceCurrentMatch(replacement) {
        if (frCurrentIdx < 0 || !frMatches[frCurrentIdx]) return;
        const mark = frMatches[frCurrentIdx];
        const textNode = document.createTextNode(replacement);
        mark.parentNode.replaceChild(textNode, mark);
        // Sync back to segments
        syncTextToSegments();
        const query = document.getElementById("fr-find-input").value;
        doFind(query);
    }

    function replaceAllMatches(query, replacement) {
        if (!query) return;
        segments.forEach(seg => {
            seg.text = seg.text.split(query).join(replacement);
            seg.words = [];
        });
        scheduleSave();
        renderSegments();
        doFind(query);
    }

    function syncTextToSegments() {
        container.querySelectorAll(".segment-text").forEach(el => {
            const idx = parseInt(el.dataset.segIdx, 10);
            if (!isNaN(idx) && segments[idx]) {
                segments[idx].text = el.innerText.trim();
                segments[idx].words = [];
            }
        });
        scheduleSave();
    }

    // --- Common Fixes ---
    const COMMON_FIXES = [
        { find: " ek is ", replace: " ek's " },
        { find: " dit is ", replace: " dis " },
        { find: " het nie ", replace: " het nie ... nie" },
        { find: "Dankie vir die kyk.", replace: "" },
        { find: "Ondertitels deur die Amara.org-gemeenskap", replace: "" },
    ];

    function populateCommonFixes() {
        const list = document.getElementById("fr-common-list");
        list.innerHTML = "";

        COMMON_FIXES.forEach((fix, i) => {
            // Count occurrences
            let count = 0;
            segments.forEach(s => {
                let idx = 0;
                while ((idx = s.text.indexOf(fix.find, idx)) !== -1) { count++; idx += fix.find.length; }
            });

            const item = document.createElement("div");
            item.className = "fr-common-item";
            item.innerHTML = `
                <span class="fr-common-find">${escapeHTML(fix.find)}</span>
                <span class="fr-common-arrow">→</span>
                <span class="fr-common-replace">${fix.replace ? escapeHTML(fix.replace) : "(remove)"}</span>
                <span class="fr-common-count">${count} found</span>
                <button class="fr-common-apply" ${count === 0 ? "disabled" : ""}>Apply</button>
            `;
            item.querySelector(".fr-common-apply").addEventListener("click", () => {
                segments.forEach(s => {
                    s.text = s.text.split(fix.find).join(fix.replace);
                    s.words = [];
                });
                scheduleSave();
                renderSegments();
                populateCommonFixes();
            });
            list.appendChild(item);
        });

        // Apply all button
        document.getElementById("fr-apply-all").addEventListener("click", () => {
            COMMON_FIXES.forEach(fix => {
                segments.forEach(s => {
                    s.text = s.text.split(fix.find).join(fix.replace);
                    s.words = [];
                });
            });
            scheduleSave();
            renderSegments();
            populateCommonFixes();
        });
    }

    function escapeHTML(str) {
        const d = document.createElement("div");
        d.textContent = str;
        return d.innerHTML;
    }

    // --- WaveSurfer Integration ---
    let wavesurfer = null;

    function initWaveSurfer() {
        if (typeof WaveSurfer === "undefined" || !audioEl.src) return;
        try {
            wavesurfer = WaveSurfer.create({
                container: "#waveform-container",
                waveColor: "#ffd8a8",
                progressColor: "#e67700",
                cursorColor: "#c92a2a",
                barWidth: 2,
                barGap: 1,
                barRadius: 2,
                height: 40,
                responsive: true,
                backend: "MediaElement",
                mediaControls: false,
                media: audioEl,
            });
        } catch (err) {
            console.warn("WaveSurfer init failed:", err);
        }
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
