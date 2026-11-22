/* Noder – frontend. Vanilla JS, no build step. Requires global ABCJS (abcjs 6.4.x). */
(function () {
  "use strict";

  // ------------------------------------------------------------------
  // Constants
  // ------------------------------------------------------------------
  var INSTRUMENTS = [
    { id: "altsax", name: "Altsax (Es)", semis: 9, featured: true, badge: "Til saxofonen",
      who: "altsax",
      desc: "Noderne skrives 9 halvtoner (en stor sekst) højere, så saxofonen klinger rigtigt sammen med klaveret." },
    { id: "klaver", name: "Klaver / koncerttone", semis: 0, who: "klaver",
      desc: "Som i sangbogen. Til klaver, guitar og sang." },
    { id: "tenorsax", name: "Tenorsax (B)", semis: 14, who: "tenorsax",
      desc: "Skrives en oktav og 2 halvtoner højere." },
    { id: "bflat", name: "Sopransax / klarinet / trompet (B)", semis: 2, who: "B-instrument",
      desc: "Skrives 2 halvtoner (et helt tonetrin) højere." },
    { id: "barisax", name: "Barytonsax (Es)", semis: 21, who: "barytonsax",
      desc: "Skrives en oktav og 9 halvtoner højere." },
    { id: "horn", name: "Horn (F)", semis: 7, who: "horn",
      desc: "Skrives 7 halvtoner (en kvint) højere." },
    { id: "floejte", name: "Fløjte / violin", semis: 0, who: "fløjte/violin",
      desc: "Spiller i koncerttone – samme noder som klaveret." },
    { id: "egen", name: "Egen indstilling", semis: null, who: "din egen indstilling",
      desc: "Vælg selv, hvor mange halvtoner noderne flyttes." }
  ];
  var ZOOMS = [0.6, 0.7, 0.8, 0.9, 1, 1.12, 1.25, 1.4, 1.6, 1.8, 2.1];
  var LIB_KEY = "noder.songs.v1";
  var PREF_KEY = "noder.prefs.v1";
  var THUMB_MAX_CHARS = 30000;      // ≈ 30 KB dataURL
  var UPLOAD_MAX_DIM = 2400;
  var READ_TIMEOUT_MS = 4 * 60 * 1000;
  var EDIT_TIMEOUT_MS = 3 * 60 * 1000;

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "text") n.textContent = attrs[k];
      else if (k === "html") n.innerHTML = attrs[k];
      else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function debounce(fn, ms) {
    var t;
    return function () { var a = arguments, me = this; clearTimeout(t); t = setTimeout(function () { fn.apply(me, a); }, ms); };
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function lsGet(key, fallback) {
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch (e) { return false; }
  }
  var toastTimer;
  function toast(msg, ms) {
    var t = $("toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ms || 3500);
  }
  function instrumentById(id) {
    for (var i = 0; i < INSTRUMENTS.length; i++) if (INSTRUMENTS[i].id === id) return INSTRUMENTS[i];
    return INSTRUMENTS[0];
  }
  function newId() { return "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  var prefs = Object.assign({ instrument: "altsax", custom: 0, chords: true, lyrics: true, zoom: null, lastSongId: null },
    lsGet(PREF_KEY, {}));
  function savePrefs() { lsSet(PREF_KEY, prefs); }

  var S = {
    song: null,          // { id, title, abc, thumb, instrument, octave, custom, warnings, savedAt }
    photoUrl: null,      // full-size object URL for this session (else thumb)
    undo: [],
    visualObj: null,
    lastFile: null,
    reading: null        // AbortController while reading
  };

  if (prefs.zoom === null || prefs.zoom === undefined) prefs.zoom = window.innerWidth < 600 ? 4 : 6;
  prefs.zoom = clamp(prefs.zoom, 0, ZOOMS.length - 1);

  // ------------------------------------------------------------------
  // View switching
  // ------------------------------------------------------------------
  function show(view) {
    $("upload").hidden = view !== "upload";
    $("progress").hidden = view !== "progress";
    $("error").hidden = view !== "error";
    $("song").hidden = view !== "song";
  }

  // ------------------------------------------------------------------
  // Config (mock notice)
  // ------------------------------------------------------------------
  fetch("/api/config").then(function (r) { return r.ok ? r.json() : null; }).then(function (cfg) {
    if (cfg && cfg.mock) $("mock-notice").hidden = false;
  }).catch(function () { /* ignore */ });

  // ------------------------------------------------------------------
  // Images: downscale for upload + small thumbnail
  // ------------------------------------------------------------------
  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { resolve({ img: img, url: url }); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("decode")); };
      img.src = url;
    });
  }
  function drawScaled(img, maxDim) {
    var w = img.naturalWidth, h = img.naturalHeight;
    var f = Math.min(1, maxDim / Math.max(w, h));
    var c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * f)); c.height = Math.max(1, Math.round(h * f));
    var ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  }
  function makeThumb(img) {
    var dims = [320, 260, 200, 160, 120], qs = [0.72, 0.6, 0.5];
    for (var i = 0; i < dims.length; i++) {
      var c = drawScaled(img, dims[i]);
      for (var j = 0; j < qs.length; j++) {
        var d = c.toDataURL("image/jpeg", qs[j]);
        if (d.length <= THUMB_MAX_CHARS) return d;
      }
    }
    return null;
  }
  function makeUploadBlob(file, img) {
    var big = Math.max(img.naturalWidth, img.naturalHeight) > UPLOAD_MAX_DIM;
    if (!big && file.size < 2.5e6 && /jpe?g|png|webp/i.test(file.type)) return Promise.resolve(file);
    return new Promise(function (resolve) {
      try {
        drawScaled(img, UPLOAD_MAX_DIM).toBlob(function (b) { resolve(b || file); }, "image/jpeg", 0.88);
      } catch (e) { resolve(file); }
    });
  }

  // ------------------------------------------------------------------
  // Reading a photo
  // ------------------------------------------------------------------
  var progressTimer = null;
  function startProgress(thumbSrc) {
    var t0 = Date.now();
    var thumb = $("progress-thumb");
    if (thumbSrc) thumb.src = thumbSrc; else thumb.removeAttribute("src");
    $("progress-elapsed").textContent = "0";
    $("progress-stage").textContent = "Sender billedet…";
    show("progress");
    window.scrollTo({ top: 0, behavior: "smooth" });
    clearInterval(progressTimer);
    progressTimer = setInterval(function () {
      var s = Math.round((Date.now() - t0) / 1000);
      $("progress-elapsed").textContent = String(s);
      var stage = s < 4 ? "Sender billedet…" : s < 30 ? "Kigger på noderne…" : s < 70 ? "Skriver tonerne ned…" :
        s < 120 ? "Næsten færdig – der er mange toner på siden…" : "Det tager lidt længere end normalt. Vent venligst…";
      $("progress-stage").textContent = stage;
    }, 1000);
  }
  function stopProgress() { clearInterval(progressTimer); progressTimer = null; }

  function showError(msg, canRetry) {
    stopProgress();
    $("error-text").textContent = msg;
    $("error-retry").hidden = !canRetry;
    show("error");
  }

  function handleFile(file) {
    if (!file) return;
    if (file.type && !/^image\//.test(file.type)) { toast("Det er vist ikke et billede. Vælg et foto af noderne."); return; }
    if (S.reading) S.reading.abort();
    S.lastFile = file;
    stopPlayback();
    startProgress(null);

    var photoUrl = null, thumb = null;
    loadImage(file).then(function (r) {
      photoUrl = r.url;
      $("progress-thumb").src = r.url;
      try { thumb = makeThumb(r.img); } catch (e) { thumb = null; }
      return makeUploadBlob(file, r.img);
    }, function () {
      return file; // could not decode locally (e.g. HEIC on some browsers) – send as-is
    }).then(function (blob) {
      var fd = new FormData();
      var name = (blob === file && file.name) ? file.name : "side.jpg";
      fd.append("image", blob, name);
      var ctrl = new AbortController();
      S.reading = ctrl;
      var timeout = setTimeout(function () { ctrl.abort(); }, READ_TIMEOUT_MS);
      return fetch("/api/read", { method: "POST", body: fd, signal: ctrl.signal })
        .then(readJson)
        .finally(function () { clearTimeout(timeout); if (S.reading === ctrl) S.reading = null; });
    }).then(function (data) {
      stopProgress();
      if (!data || typeof data.abc !== "string" || !data.abc.trim()) {
        throw new Error("Der kom ingen noder tilbage. Prøv et skarpere billede, hvor hele melodien er med.");
      }
      var song = {
        id: newId(),
        title: (data.title || titleFromAbc(data.abc) || "Uden titel").trim(),
        abc: data.abc,
        thumb: thumb,
        instrument: prefs.instrument || "altsax",
        octave: 0,
        custom: prefs.custom || 0,
        warnings: Array.isArray(data.warnings) ? data.warnings : [],
        savedAt: Date.now()
      };
      if (S.photoUrl && S.photoUrl !== photoUrl) { try { URL.revokeObjectURL(S.photoUrl); } catch (e) { /* */ } }
      S.photoUrl = photoUrl;
      if (!saveSong(song)) toast("Sangen kunne ikke gemmes på enheden (der er ikke plads), men du kan stadig bruge den nu.", 5000);
      openSong(song, { keepPhoto: true });
    }).catch(function (err) {
      if (err && (err.name === "AbortError" || err === "cancel")) {
        if (S.cancelled) { S.cancelled = false; stopProgress(); show(S.song ? "song" : "upload"); return; }
        showError("Det tog for lang tid at læse noderne. Prøv igen – eller tag et billede af en mindre del af siden.", true);
        return;
      }
      var msg = (err && err.message) || "";
      if (!msg || /Failed to fetch|NetworkError|Load failed/i.test(msg)) {
        msg = "Kunne ikke få forbindelse til serveren. Tjek internetforbindelsen og prøv igen.";
      }
      showError(msg, true);
    });
  }

  function readJson(r) {
    return r.text().then(function (txt) {
      var data = null;
      try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = null; }
      if (!r.ok || (data && data.error)) {
        var msg = data && data.error ? data.error :
          r.status === 413 ? "Billedet er for stort. Prøv et mindre billede." :
          "Der skete en fejl på serveren (" + r.status + "). Prøv igen om lidt.";
        throw new Error(msg);
      }
      if (!data) throw new Error("Serveren svarede ikke som forventet. Prøv igen om lidt.");
      return data;
    });
  }

  $("file-input").addEventListener("change", function (e) {
    var f = e.target.files && e.target.files[0];
    e.target.value = ""; // allow re-selecting the same file
    handleFile(f);
  });
  $("progress-cancel").addEventListener("click", function () {
    if (S.reading) { S.cancelled = true; S.reading.abort(); }
    else { stopProgress(); show(S.song ? "song" : "upload"); }
  });
  $("error-retry").addEventListener("click", function () { if (S.lastFile) handleFile(S.lastFile); });

  // Drag & drop anywhere on the page
  (function () {
    var depth = 0, overlay = $("drop-overlay");
    function hasFiles(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") >= 0; }
    window.addEventListener("dragenter", function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault(); depth++;
      if (!$("upload").hidden) overlay.hidden = false;
    });
    window.addEventListener("dragover", function (e) { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
    window.addEventListener("dragleave", function () { depth = Math.max(0, depth - 1); if (!depth) overlay.hidden = true; });
    window.addEventListener("drop", function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault(); depth = 0; overlay.hidden = true;
      var f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleFile(f);
    });
  })();

  // ------------------------------------------------------------------
  // ABC helpers
  // ------------------------------------------------------------------
  function titleFromAbc(abc) {
    var m = /^\s*T:\s*(.+)$/m.exec(abc || "");
    return m ? m[1].trim() : "";
  }
  function setAbcTitle(abc, title) {
    title = title.replace(/[\r\n]/g, " ").trim();
    if (/^\s*T:.*$/m.test(abc)) return abc.replace(/^(\s*)T:.*$/m, function (all, ws) { return title ? ws + "T:" + title : ""; });
    if (!title) return abc;
    if (/^\s*X:.*$/m.test(abc)) return abc.replace(/^(\s*X:.*)$/m, "$1\nT:" + title);
    return "T:" + title + "\n" + abc;
  }
  // Remove chord symbols / lyric lines for display.
  function displayAbc(abc, showChords, showLyrics) {
    if (showChords && showLyrics) return abc;
    var out = [], lastWasLyric = false;
    abc.split(/\r?\n/).forEach(function (line) {
      var isField = /^\s*[A-Za-z+]:/.test(line);
      var isLyric = /^\s*[wW]:/.test(line) || (lastWasLyric && /^\s*\+:/.test(line));
      if (isField) lastWasLyric = isLyric;
      if (!showLyrics && isLyric) return;
      if (!showChords && !isField && !/^\s*%/.test(line)) line = line.replace(/"[^"\n]*"/g, "");
      if (!showLyrics && !isField) line = line.replace(/\[w:[^\]]*\]/g, "");
      out.push(line);
    });
    return out.join("\n");
  }

  // Danish key names. B natural = H, Bb = B, Eb = Es, Ab = As, F# = Fis …
  var MODE_NAMES = { "": "dur", maj: "dur", ion: "dur", m: "mol", min: "mol", aeo: "mol",
    dor: "dorisk", phr: "frygisk", lyd: "lydisk", mix: "mixolydisk", loc: "lokrisk" };
  function danishKey(ks) {
    if (!ks || !ks.root || ks.root === "none" || ks.root === "HP" || ks.root === "Hp") return null;
    var root = ks.root.toUpperCase(), acc = ks.acc || "";
    var name;
    if (root === "B" && acc === "b") name = "B";
    else if (root === "B" && !acc) name = "H";
    else if (acc === "b") name = (root === "E" || root === "A") ? root + "s" : root + "es";
    else if (acc === "#") name = (root === "B" ? "H" : root) + "is";
    else name = root;
    var mode = MODE_NAMES[String(ks.mode || "").toLowerCase().slice(0, 3)];
    if (mode === undefined) mode = MODE_NAMES[String(ks.mode || "").toLowerCase()] || "dur";
    if (mode === "mol") return name.toLowerCase() + "-mol";
    if (mode === "dur") return name + "-dur";
    return name + " " + mode;
  }
  // Fallback: compute a transposed key by pitch class
  var PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  var MAJ_SPELL = [["C", ""], ["D", "b"], ["D", ""], ["E", "b"], ["E", ""], ["F", ""], ["F", "#"], ["G", ""], ["A", "b"], ["A", ""], ["B", "b"], ["B", ""]];
  var MIN_SPELL = [["C", ""], ["C", "#"], ["D", ""], ["E", "b"], ["E", ""], ["F", ""], ["F", "#"], ["G", ""], ["G", "#"], ["A", ""], ["B", "b"], ["B", ""]];
  function transposeKey(ks, semis) {
    if (!ks || PC[String(ks.root).toUpperCase()] === undefined) return ks;
    var pc = PC[ks.root.toUpperCase()] + (ks.acc === "#" ? 1 : ks.acc === "b" ? -1 : 0);
    pc = (((pc + semis) % 12) + 12) % 12;
    var minor = /^m/i.test(ks.mode || "") && !/^mix/i.test(ks.mode || "");
    var sp = (minor ? MIN_SPELL : MAJ_SPELL)[pc];
    return { root: sp[0], acc: sp[1], mode: ks.mode };
  }

  // ------------------------------------------------------------------
  // Transposition
  // ------------------------------------------------------------------
  function totalTranspose() {
    if (!S.song) return 0;
    var ins = instrumentById(S.song.instrument);
    var base = ins.semis === null ? (S.song.custom || 0) : ins.semis;
    return base + 12 * (S.song.octave || 0);
  }

  function buildInstrumentPicker() {
    var box = $("instruments");
    box.innerHTML = "";
    INSTRUMENTS.forEach(function (ins) {
      var nameEl = el("span", { "class": "instr-name" }, [ins.name]);
      if (ins.badge) nameEl.appendChild(el("span", { "class": "badge", text: ins.badge }));
      var b = el("button", {
        type: "button", role: "radio", "class": "instr" + (ins.featured ? " featured" : ""),
        "data-id": ins.id, "aria-checked": "false",
        onclick: function () { chooseInstrument(ins.id); }
      }, [nameEl, el("span", { "class": "instr-desc", text: ins.desc })]);
      box.appendChild(b);
    });
  }
  function syncInstrumentUi() {
    var id = S.song ? S.song.instrument : prefs.instrument;
    Array.prototype.forEach.call($("instruments").children, function (b) {
      b.setAttribute("aria-checked", b.getAttribute("data-id") === id ? "true" : "false");
      b.tabIndex = b.getAttribute("data-id") === id ? 0 : -1;
    });
    $("custom-steps").hidden = id !== "egen";
    var c = S.song ? (S.song.custom || 0) : 0;
    $("custom-value").textContent = (c > 0 ? "+" : "") + c;
    $("custom-minus").disabled = c <= -12;
    $("custom-plus").disabled = c >= 12;
    var o = S.song ? (S.song.octave || 0) : 0;
    $("oct-status").textContent = o === 0 ? "" : (o > 0 ? "+" : "−") + Math.abs(o) + " oktav" + (Math.abs(o) > 1 ? "er" : "");
    $("oct-down").disabled = o <= -2;
    $("oct-up").disabled = o >= 2;
  }
  function setPickerOpen(open) {
    $("instruments").classList.toggle("collapsed", !open);
    $("instr-more").setAttribute("aria-expanded", String(open));
    $("instr-more").textContent = open ? "Skjul listen" : "Skift instrument";
  }
  $("instr-more").addEventListener("click", function () {
    setPickerOpen($("instruments").classList.contains("collapsed"));
  });
  function chooseInstrument(id) {
    if (!S.song) return;
    if (window.innerWidth < 700) setPickerOpen(false);
    S.song.instrument = id;
    prefs.instrument = id; savePrefs();
    afterTransposeChange();
  }
  function afterTransposeChange() {
    syncInstrumentUi();
    render();
    saveCurrentSoon();
  }
  // Keyboard arrows within the radiogroup
  $("instruments").addEventListener("keydown", function (e) {
    var keys = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
    if (!keys[e.key]) return;
    e.preventDefault();
    var btns = Array.prototype.slice.call(this.children);
    var i = btns.indexOf(document.activeElement);
    var n = btns[(i + keys[e.key] + btns.length) % btns.length];
    n.focus(); n.click();
  });
  $("custom-minus").addEventListener("click", function () { if (!S.song) return; S.song.custom = clamp((S.song.custom || 0) - 1, -12, 12); prefs.custom = S.song.custom; savePrefs(); afterTransposeChange(); });
  $("custom-plus").addEventListener("click", function () { if (!S.song) return; S.song.custom = clamp((S.song.custom || 0) + 1, -12, 12); prefs.custom = S.song.custom; savePrefs(); afterTransposeChange(); });
  $("oct-down").addEventListener("click", function () { if (!S.song) return; S.song.octave = clamp((S.song.octave || 0) - 1, -2, 2); afterTransposeChange(); });
  $("oct-up").addEventListener("click", function () { if (!S.song) return; S.song.octave = clamp((S.song.octave || 0) + 1, -2, 2); afterTransposeChange(); });

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------
  var lastRenderWidth = 0;
  function render() {
    var paper = $("paper");
    if (!S.song) return;
    stopPlayback();
    synthDirty = true;
    var abc = displayAbc(S.song.abc || "", prefs.chords, prefs.lyrics);
    if (!abc.trim()) {
      paper.innerHTML = '<p class="paper-empty">Der er ingen noder endnu. Skriv eller indsæt nodekode under «Rediger noderne».</p>';
      S.visualObj = null; updateKeyInfo(); showAbcErrors([]);
      return;
    }
    var width = paper.clientWidth || 340;
    lastRenderWidth = width;
    var zoom = ZOOMS[prefs.zoom];
    var staffwidth = Math.max(220, Math.round(width / zoom));
    var tunes;
    try {
      tunes = ABCJS.renderAbc(paper, abc, {
        responsive: "resize",
        add_classes: true,
        visualTranspose: totalTranspose(),
        staffwidth: staffwidth,
        wrap: { minSpacing: 1.6, maxSpacing: 2.6, preferredMeasuresPerLine: staffwidth < 420 ? 2 : staffwidth < 640 ? 3 : 4 },
        paddingleft: 0, paddingright: 0, paddingtop: 4, paddingbottom: 12,
        foregroundColor: "#111111",
        format: {
          titlefont: '"Georgia" 20',
          gchordfont: '"Helvetica" 13 bold',
          vocalfont: '"Helvetica" 13',
          annotationfont: '"Helvetica" 12',
          composerfont: '"Helvetica" 11 italic',
          tempofont: '"Helvetica" 11',
          staffsep: 56,
          vocalspace: 8
        }
      });
    } catch (e) {
      paper.innerHTML = '<p class="paper-empty">Noderne kunne ikke vises. Tjek nodekoden under «Rediger noderne».</p>';
      S.visualObj = null; updateKeyInfo(); showAbcErrors([String(e && e.message || e)]);
      return;
    }
    S.visualObj = tunes && tunes[0] ? tunes[0] : null;
    updateKeyInfo();
    var warnings = (S.visualObj && S.visualObj.warnings) || [];
    if (S.visualObj && (!S.visualObj.lines || !S.visualObj.lines.length)) warnings = warnings.concat(["Ingen noder fundet i koden."]);
    showAbcErrors(warnings);
  }

  function updateKeyInfo() {
    var box = $("key-info");
    if (!S.song) { box.textContent = ""; return; }
    var ins = instrumentById(S.song.instrument);
    var total = totalTranspose();
    var origKs = null, shownKs = null;
    try {
      var parsed = ABCJS.parseOnly(S.song.abc || "")[0];
      origKs = parsed && parsed.getKeySignature ? parsed.getKeySignature() : null;
    } catch (e) { origKs = null; }
    try { shownKs = S.visualObj && S.visualObj.getKeySignature ? S.visualObj.getKeySignature() : null; } catch (e) { shownKs = null; }
    if (origKs && total % 12 !== 0 && (!shownKs || (shownKs.root === origKs.root && shownKs.acc === origKs.acc))) {
      shownKs = transposeKey(origKs, total);
    }
    var orig = danishKey(origKs), shown = danishKey(shownKs) || orig;
    var octTxt = "";
    var o = S.song.octave || 0;
    if (o) octTxt = " (flyttet " + (Math.abs(o) === 1 ? "en" : "to") + " oktav" + (Math.abs(o) > 1 ? "er" : "") + (o > 0 ? " op" : " ned") + ")";
    var who = ins.id === "egen" ? "med din egen indstilling" : "til " + ins.who;
    var html;
    if (!orig) {
      html = total === 0 ? "Noderne vises som i originalen" + octTxt + "." :
        "Noderne vises " + who + " – flyttet " + total + " halvtoner" + octTxt + ".";
    } else if (total === 0) {
      html = "Noderne vises som i originalen, i <strong>" + esc(orig) + "</strong>" +
        (ins.id === "klaver" ? " – koncerttone, til klaver og sang." : " " + esc(who) + ".");
    } else if (total % 12 === 0) {
      html = "Noderne vises i <strong>" + esc(shown) + "</strong> " + esc(who) + octTxt + " – samme toneart som originalen.";
    } else {
      html = "Noderne vises nu i <strong>" + esc(shown) + "</strong> " + esc(who) + octTxt +
        " — originalen står i <strong>" + esc(orig) + "</strong>.";
    }
    box.innerHTML = html;
    $("print-title").innerHTML = total === 0 ? "" : "<small>" + esc(ins.name) + " – " + esc(shown || "") + octTxt + "</small>";
  }

  function friendlyWarning(w) {
    var t = String(w).replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();
    var map = [
      [/Music Line:(\d+):(\d+):?/i, "Linje $1, tegn $2:"],
      [/Unknown character ignored/i, "ukendt tegn – ignoreret"],
      [/Unknown decoration/i, "ukendt pyntetegn"],
      [/Unknown directive/i, "ukendt kommando"],
      [/Expected a number/i, "der mangler et tal"],
      [/Unmatched/i, "mangler sin modpart"],
      [/Illegal accidental/i, "ugyldigt fortegn"],
      [/Unknown header/i, "ukendt felt i toppen"],
      [/Bad (key|meter|clef)/i, "ugyldig toneart/taktart/nøgle"]
    ];
    map.forEach(function (m) { t = t.replace(m[0], m[1]); });
    return t;
  }
  function showAbcErrors(warnings) {
    var box = $("abc-errors");
    if (!warnings || !warnings.length) { box.hidden = true; box.innerHTML = ""; return; }
    var n = warnings.length;
    box.innerHTML = "<strong>Noget i nodekoden kunne ikke forstås</strong> (" + n + " sted" + (n > 1 ? "er" : "") + "). " +
      "Det skyldes som regel en lille tastefejl, og noderne kan se lidt forkerte ud. Du kan rette det under «Rediger noderne»." +
      "<details><summary>Vis detaljer</summary><ul>" +
      warnings.slice(0, 12).map(function (w) { return "<li>" + esc(friendlyWarning(w)) + "</li>"; }).join("") +
      "</ul></details>";
    box.hidden = false;
  }

  // Re-render when the paper width changes noticeably (rotation, resize, stand mode)
  var rerenderOnResize = debounce(function () {
    var w = $("paper").clientWidth;
    if (S.song && !$("song").hidden && Math.abs(w - lastRenderWidth) > 24) render();
  }, 200);
  if (window.ResizeObserver) new ResizeObserver(rerenderOnResize).observe($("paper"));
  else window.addEventListener("resize", rerenderOnResize);

  // ------------------------------------------------------------------
  // Display toggles / zoom
  // ------------------------------------------------------------------
  function syncToggles() {
    $("tg-chords").setAttribute("aria-pressed", String(!!prefs.chords));
    $("tg-lyrics").setAttribute("aria-pressed", String(!!prefs.lyrics));
    var zo = prefs.zoom <= 0, zi = prefs.zoom >= ZOOMS.length - 1;
    $("zoom-out").disabled = zo; $("stand-zoom-out").disabled = zo;
    $("zoom-in").disabled = zi; $("stand-zoom-in").disabled = zi;
  }
  $("tg-chords").addEventListener("click", function () { prefs.chords = !prefs.chords; savePrefs(); syncToggles(); render(); });
  $("tg-lyrics").addEventListener("click", function () { prefs.lyrics = !prefs.lyrics; savePrefs(); syncToggles(); render(); });
  function zoomBy(d) {
    var z = clamp(prefs.zoom + d, 0, ZOOMS.length - 1);
    if (z === prefs.zoom) return;
    prefs.zoom = z; savePrefs(); syncToggles(); render();
  }
  $("zoom-in").addEventListener("click", function () { zoomBy(1); });
  $("zoom-out").addEventListener("click", function () { zoomBy(-1); });
  $("stand-zoom-in").addEventListener("click", function () { zoomBy(1); });
  $("stand-zoom-out").addEventListener("click", function () { zoomBy(-1); });

  // ------------------------------------------------------------------
  // Music stand (full screen) mode
  // ------------------------------------------------------------------
  var wakeLock = null;
  function enterStand() {
    document.body.classList.add("stand");
    var de = document.documentElement;
    try {
      var p = de.requestFullscreen ? de.requestFullscreen() : de.webkitRequestFullscreen ? de.webkitRequestFullscreen() : null;
      if (p && p.catch) p.catch(function () { /* not allowed – fine */ });
    } catch (e) { /* */ }
    try {
      if (navigator.wakeLock) navigator.wakeLock.request("screen").then(function (l) { wakeLock = l; }).catch(function () { /* */ });
    } catch (e) { /* */ }
    window.scrollTo(0, 0);
    setTimeout(render, 60);
  }
  function exitStand() {
    if (!document.body.classList.contains("stand")) return;
    document.body.classList.remove("stand");
    try {
      if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function () { /* */ });
      else if (document.webkitFullscreenElement && document.webkitExitFullscreen) document.webkitExitFullscreen();
    } catch (e) { /* */ }
    if (wakeLock) { try { wakeLock.release(); } catch (e) { /* */ } wakeLock = null; }
    setTimeout(function () { render(); $("sheet").scrollIntoView({ block: "start" }); }, 60);
  }
  $("stand").addEventListener("click", enterStand);
  $("stand-exit").addEventListener("click", exitStand);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") exitStand(); });
  document.addEventListener("fullscreenchange", function () { if (!document.fullscreenElement) exitStand(); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && document.body.classList.contains("stand") && navigator.wakeLock && !wakeLock) {
      navigator.wakeLock.request("screen").then(function (l) { wakeLock = l; }).catch(function () { /* */ });
    }
  });

  // ------------------------------------------------------------------
  // Playback (abcjs synth). Always concert pitch: abcjs' sequencer subtracts
  // the tune's visualTranspose, and we pass midiTranspose: 0 explicitly.
  // ------------------------------------------------------------------
  var synth = null, synthDirty = true, synthLoading = false;
  var cursorControl = {
    beatSubdivisions: 2,
    onStart: function () { clearHighlight(); },
    onFinished: function () { clearHighlight(); setPlayUi("stopped"); $("play-progress").style.width = "0"; },
    onBeat: function (beat, total) {
      if (total) $("play-progress").style.width = Math.min(100, (beat / total) * 100) + "%";
    },
    onEvent: function (ev) {
      if (!ev || (ev.measureStart && ev.left === null)) return;
      clearHighlight();
      var first = null;
      (ev.elements || []).forEach(function (group) {
        (group || []).forEach(function (n) { n.classList.add("playing"); if (!first) first = n; });
      });
      if (first) keepInView(first);
    }
  };
  function clearHighlight() {
    Array.prototype.forEach.call(document.querySelectorAll("#paper .playing"), function (n) { n.classList.remove("playing"); });
  }
  function keepInView(node) {
    var r = node.getBoundingClientRect();
    var vh = window.innerHeight;
    if (r.top < 70 || r.bottom > vh - 90) {
      window.scrollBy({ top: r.top - vh * 0.35, behavior: "smooth" });
    }
  }
  function setPlayUi(state) {
    var playing = state === "playing", loading = state === "loading";
    var icon = playing ? "#i-pause" : "#i-play";
    $("play").querySelector("use").setAttribute("href", icon);
    $("stand-play").querySelector("use").setAttribute("href", icon);
    $("play-label").textContent = loading ? "Henter lyd…" : playing ? "Pause" : "Afspil";
    $("play").setAttribute("aria-label", playing ? "Pause" : "Afspil");
    $("stand-play").setAttribute("aria-label", playing ? "Pause" : "Afspil");
    $("play").disabled = loading;
  }
  function stopPlayback() {
    if (synth) {
      try { if (synth.isStarted) synth.pause(); } catch (e) { /* */ }
      try { synth.destroy(); } catch (e) { /* */ }
      synth.isLoaded = false;
      synth.isStarted = false;
    }
    synthDirty = true;
    clearHighlight();
    setPlayUi("stopped");
    var pp = $("play-progress"); if (pp) pp.style.width = "0";
  }
  function togglePlay() {
    if (!S.visualObj) { toast("Der er ingen noder at spille."); return; }
    if (!window.ABCJS || !ABCJS.synth || !ABCJS.synth.supportsAudio()) {
      toast("Din browser kan desværre ikke afspille lyd.");
      return;
    }
    if (synthLoading) return;
    if (!synth) {
      synth = new ABCJS.synth.SynthController();
      synth.cursorControl = cursorControl; // we use our own buttons, so no .load()
    }
    var p;
    if (synthDirty) {
      synthLoading = true;
      setPlayUi("loading");
      synth.warp = parseInt($("tempo").value, 10) || 100;
      // userAction = true: we are inside a click handler (needed on iOS)
      p = synth.setTune(S.visualObj, true, { midiTranspose: 0, program: 0 }).then(function () {
        synthDirty = false;
        synthLoading = false;
      });
    } else {
      p = Promise.resolve();
    }
    p.then(function () { return synth.play(); })
      .then(function () { setPlayUi(synth.isStarted ? "playing" : "stopped"); })
      .catch(function (err) {
        synthLoading = false;
        setPlayUi("stopped");
        console.warn("Afspilning fejlede", err);
        toast("Lyden kunne ikke startes. Tjek internetforbindelsen og at telefonen ikke står på lydløs.", 5000);
      });
  }
  $("play").addEventListener("click", togglePlay);
  $("stand-play").addEventListener("click", togglePlay);
  $("restart").addEventListener("click", function () {
    if (synth && !synthDirty) { synth.restart(); $("play-progress").style.width = "0"; if (!synth.isStarted) togglePlay(); }
    else togglePlay();
  });
  $("tempo").addEventListener("input", function () { $("tempo-value").textContent = this.value + " %"; });
  $("tempo").addEventListener("change", function () {
    var v = parseInt(this.value, 10) || 100;
    if (synth && !synthDirty && !synthLoading) {
      synth.setWarp(v).then(function () { setPlayUi(synth.isStarted ? "playing" : "stopped"); }).catch(function () { /* */ });
    } else if (synth) synth.warp = v;
  });

  // ------------------------------------------------------------------
  // Editing: textarea + AI + undo
  // ------------------------------------------------------------------
  var editBurst = false, endBurst = debounce(function () { editBurst = false; }, 1500);
  function pushUndo(abc) {
    if (S.undo.length && S.undo[S.undo.length - 1] === abc) return;
    S.undo.push(abc);
    if (S.undo.length > 60) S.undo.shift();
    $("undo").disabled = false;
  }
  function setAbc(abc, opts) {
    S.song.abc = abc;
    if (!opts || !opts.fromTextarea) $("abc-text").value = abc;
    var t = titleFromAbc(abc);
    if (t && t !== S.song.title) { S.song.title = t; $("song-title").value = t; }
    render();
    saveCurrentSoon();
  }
  var renderFromTextarea = debounce(function () {
    if (!S.song) return;
    setAbc($("abc-text").value, { fromTextarea: true });
  }, 450);
  $("abc-text").addEventListener("input", function () {
    if (!S.song) return;
    if (!editBurst) { pushUndo(S.song.abc); editBurst = true; }
    endBurst();
    renderFromTextarea();
  });
  $("undo").addEventListener("click", undo);
  function undo() {
    if (!S.song || !S.undo.length) return;
    var prev = S.undo.pop();
    editBurst = false;
    setAbc(prev);
    $("undo").disabled = !S.undo.length;
    toast("Ændringen er fortrudt.");
  }

  Array.prototype.forEach.call(document.querySelectorAll("#ai-chips .chip"), function (c) {
    c.addEventListener("click", function () {
      $("ai-input").value = c.textContent;
      $("ai-input").focus();
    });
  });
  $("ai-input").addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("ai-form").requestSubmit ? $("ai-form").requestSubmit() : $("ai-submit").click(); }
  });
  $("ai-form").addEventListener("submit", function (e) {
    e.preventDefault();
    if (!S.song) return;
    var instruction = $("ai-input").value.trim();
    if (!instruction) { $("ai-input").focus(); toast("Skriv først, hvad der skal ændres."); return; }
    var btn = $("ai-submit"), res = $("ai-result");
    btn.disabled = true; btn.textContent = "Arbejder…";
    res.hidden = false;
    res.innerHTML = '<p class="muted">Et øjeblik – jeg kigger på noderne…</p>';
    var ctrl = new AbortController();
    var timeout = setTimeout(function () { ctrl.abort(); }, EDIT_TIMEOUT_MS);
    var before = S.song.abc, songId = S.song.id;
    fetch("/api/edit", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ abc: before, instruction: instruction }), signal: ctrl.signal
    }).then(readJson).then(function (data) {
      if (!S.song || S.song.id !== songId) return;
      var changed = typeof data.abc === "string" && data.abc.trim() && data.abc.trim() !== before.trim();
      res.innerHTML = "";
      res.appendChild(el("p", { text: data.explanation || (changed ? "Noderne er ændret." : "Der blev ikke ændret noget.") }));
      if (changed) {
        pushUndo(before);
        editBurst = false;
        setAbc(data.abc);
        res.appendChild(el("button", { type: "button", "class": "btn btn-small", onclick: function () { undo(); res.hidden = true; } },
          [el("span", { text: "Fortryd ændringen" })]));
        $("ai-input").value = "";
      }
    }).catch(function (err) {
      var msg = err && err.name === "AbortError" ? "Det tog for lang tid. Prøv igen." :
        (err && err.message && !/Failed to fetch|NetworkError|Load failed/i.test(err.message)) ? err.message :
        "Kunne ikke få forbindelse til serveren. Prøv igen.";
      res.innerHTML = "";
      res.appendChild(el("p", { text: msg }));
    }).finally(function () {
      clearTimeout(timeout);
      btn.disabled = false; btn.textContent = "Udfør";
    });
  });

  // Title
  $("song-title").addEventListener("change", function () {
    if (!S.song) return;
    var t = this.value.trim() || "Uden titel";
    S.song.title = t;
    var abc = setAbcTitle(S.song.abc, t);
    if (abc !== S.song.abc) { S.song.abc = abc; $("abc-text").value = abc; render(); }
    saveCurrentSoon();
    renderLibrary();
  });
  $("song-title").addEventListener("keydown", function (e) { if (e.key === "Enter") this.blur(); });

  // ------------------------------------------------------------------
  // Print / download
  // ------------------------------------------------------------------
  $("print").addEventListener("click", function () { window.print(); });
  $("dl-abc").addEventListener("click", function () {
    if (!S.song) return;
    var total = totalTranspose(), abc = S.song.abc, ins = instrumentById(S.song.instrument), suffix = "";
    if (total !== 0) {
      try {
        var tune = ABCJS.parseOnly(abc)[0];
        var t = ABCJS.strTranspose(abc, [tune], total);
        if (typeof t === "string" && t.trim()) {
          abc = "% Transponeret " + (total > 0 ? "+" : "") + total + " halvtoner (" + ins.name + "). Klinger i koncerttone som originalen.\n" + t;
          suffix = "-" + ins.id;
        }
      } catch (e) {
        toast("Kunne ikke transponere filen – du får originalen (koncerttone).");
      }
    }
    var name = (S.song.title || "noder").replace(/[\\/:*?"<>|]+/g, "").trim().slice(0, 60) || "noder";
    var blob = new Blob([abc], { type: "text/plain;charset=utf-8" });
    var a = el("a", { href: URL.createObjectURL(blob), download: name + suffix + ".abc" });
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  });

  // ------------------------------------------------------------------
  // Library (localStorage)
  // ------------------------------------------------------------------
  function loadLib() { var l = lsGet(LIB_KEY, []); return Array.isArray(l) ? l : []; }
  function saveSong(song) {
    var list = loadLib().filter(function (s) { return s && s.id !== song.id; });
    var rec = {
      id: song.id, title: song.title, abc: song.abc, thumb: song.thumb || null,
      instrument: song.instrument, octave: song.octave || 0, custom: song.custom || 0,
      warnings: song.warnings || [], savedAt: Date.now()
    };
    list.unshift(rec);
    var ok = lsSet(LIB_KEY, list);
    // Out of space: drop thumbnails of the oldest songs and try again.
    for (var i = list.length - 1; !ok && i > 0; i--) {
      if (list[i].thumb) { list[i].thumb = null; ok = lsSet(LIB_KEY, list); }
    }
    renderLibrary();
    return ok;
  }
  var saveCurrentSoon = debounce(function () {
    if (S.song && !S.song.deleted) saveSong(S.song);
  }, 600);
  function deleteSong(id) {
    var list = loadLib().filter(function (s) { return s.id !== id; });
    lsSet(LIB_KEY, list);
    if (S.song && S.song.id === id) { S.song.deleted = true; closeSong(); }
    renderLibrary();
  }
  function fmtDate(ts) {
    try { return new Date(ts).toLocaleDateString("da-DK", { day: "numeric", month: "short", year: "numeric" }); } catch (e) { return ""; }
  }
  function renderLibrary() {
    var list = loadLib(), ul = $("lib-list");
    ul.innerHTML = "";
    $("lib-empty").hidden = list.length > 0;
    list.forEach(function (s) {
      var ins = instrumentById(s.instrument);
      var thumb = s.thumb ? el("img", { "class": "lib-thumb", src: s.thumb, alt: "" }) : el("span", { "class": "lib-thumb", "aria-hidden": "true" });
      var open = el("button", { type: "button", "class": "lib-open", onclick: function () { openSong(s); window.scrollTo({ top: 0, behavior: "smooth" }); } }, [
        thumb,
        el("span", { "class": "lib-meta" }, [
          el("span", { "class": "lib-title", text: s.title || "Uden titel" }),
          el("span", { "class": "lib-sub", text: ins.name + " · " + fmtDate(s.savedAt) })
        ])
      ]);
      var del = el("button", {
        type: "button", "class": "btn btn-icon lib-del", "aria-label": "Slet " + (s.title || "sangen"), title: "Slet",
        onclick: function () { if (window.confirm("Vil du slette «" + (s.title || "Uden titel") + "»?")) deleteSong(s.id); }
      }, []);
      del.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-close"/></svg>';
      ul.appendChild(el("li", { "class": "lib-item" + (S.song && S.song.id === s.id ? " current" : "") }, [open, del]));
    });
  }

  // ------------------------------------------------------------------
  // Open / close song
  // ------------------------------------------------------------------
  function openSong(song, opts) {
    stopPlayback();
    S.song = Object.assign({ octave: 0, custom: 0, warnings: [] }, song);
    S.undo = []; editBurst = false;
    $("undo").disabled = true;
    if (!opts || !opts.keepPhoto) {
      if (S.photoUrl) { try { URL.revokeObjectURL(S.photoUrl); } catch (e) { /* */ } }
      S.photoUrl = null;
    }
    $("song-title").value = S.song.title || "";
    $("abc-text").value = S.song.abc || "";
    $("ai-result").hidden = true;
    var src = S.photoUrl || S.song.thumb;
    $("photo-box").hidden = !src;
    if (src) { $("photo").src = src; $("photo-link").href = src; }
    var w = S.song.warnings || [];
    var wb = $("server-warnings");
    if (w.length) {
      wb.innerHTML = "<strong>Bemærk fra nodelæseren:</strong><ul>" + w.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul>";
      wb.hidden = false;
    } else wb.hidden = true;
    prefs.lastSongId = S.song.id; savePrefs();
    show("song");
    syncInstrumentUi();
    syncToggles();
    render();
    renderLibrary();
    document.title = (S.song.title || "Noder") + " – Noder";
  }
  function closeSong() {
    stopPlayback();
    exitStand();
    S.song = null; S.visualObj = null;
    prefs.lastSongId = null; savePrefs();
    $("paper").innerHTML = "";
    show("upload");
    document.title = "Noder – fra sangbogen til saxofonen";
    renderLibrary();
  }
  document.querySelector(".brand").addEventListener("click", function (e) {
    e.preventDefault();
    if (S.reading) return;
    closeSong();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  // Photo link: object URLs / data URLs can't always be opened in a new tab – open an overlay-free new window instead.
  $("photo-link").addEventListener("click", function (e) {
    var src = $("photo").src;
    if (/^data:/.test(src)) {
      e.preventDefault();
      var w = window.open("", "_blank");
      if (w) w.document.write('<title>Billede</title><body style="margin:0;background:#222"><img src="' + src + '" style="width:100%">');
    }
  });

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  buildInstrumentPicker();
  syncToggles();
  renderLibrary();
  if (!window.ABCJS) {
    showError("Nodeprogrammet (abcjs) kunne ikke indlæses. Genindlæs siden.", false);
  } else if (prefs.lastSongId) {
    var last = loadLib().filter(function (s) { return s.id === prefs.lastSongId; })[0];
    if (last) openSong(last); else show("upload");
  } else {
    show("upload");
  }

  // Expose a tiny API for debugging/tests
  window.Noder = {
    state: S, prefs: prefs, render: render, totalTranspose: totalTranspose, danishKey: danishKey,
    chooseInstrument: chooseInstrument, displayAbc: displayAbc
  };
})();
