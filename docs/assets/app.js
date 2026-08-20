(function(){
  "use strict";
  var STORAGE_KEY = "sdsm_progress";

  function loadProgress(){
    try{ return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
    catch(e){ return {}; }
  }
  function saveProgress(data){
    try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }catch(e){}
  }
  function setModuleResult(moduleId, score, total){
    var data = loadProgress();
    data[moduleId] = {score: score, total: total, ts: Date.now()};
    saveProgress(data);
    renderProgress();
  }

  function renderProgress(){
    var data = loadProgress();
    var ids = Object.keys(data);
    var done = ids.filter(function(id){ return data[id].score === data[id].total; }).length;
    var attempted = ids.length;

    var badges = document.querySelectorAll("[data-progress-id]");
    var total = new Set(Array.prototype.map.call(badges, function(el){
      return el.getAttribute("data-progress-id");
    })).size;
    badges.forEach(function(el){
      var id = el.getAttribute("data-progress-id");
      var entry = data[id];
      var badgeEls = el.querySelectorAll(".tab-check, .module-card-badge");
      badgeEls.forEach(function(b){
        b.classList.remove("done", "partial");
        if (entry){
          if (entry.score === entry.total) b.classList.add("done");
          else b.classList.add("partial");
        }
      });
    });

    var pillLabel = document.querySelector(".topnav-progress-pill .val");
    if (pillLabel && total) pillLabel.textContent = done + "/" + total;

    var ring = document.querySelector(".home-progress-ring .fill");
    var ringLabel = document.querySelector(".home-progress-ring-label");
    var progressText = document.querySelector(".home-progress-text");
    if (ring && total){
      var r = 26, c = 2 * Math.PI * r;
      var pct2 = done / total;
      ring.style.strokeDasharray = c;
      ring.style.strokeDashoffset = c * (1 - pct2);
      if (ringLabel) ringLabel.textContent = Math.round(pct2 * 100) + "%";
    }
    if (progressText){
      progressText.innerHTML = "Пройдено <b>" + done + " / " + total + "</b> модулей" +
        (attempted > done ? ", ещё " + (attempted - done) + " начато" : "");
    }
  }

  function initQuiz(quizEl){
    var correct = quizEl.dataset.correct.split(",").map(Number);
    var checkBtn = quizEl.querySelector(".quiz-check");
    var resetBtn = quizEl.querySelector(".quiz-reset");
    var scoreText = quizEl.querySelector(".quiz-score");
    var qName = quizEl.dataset.quiz;
    var moduleId = quizEl.dataset.module;

    checkBtn.addEventListener("click", function(){
      var score = 0, answered = 0;
      correct.forEach(function(correctIdx, qIdx){
        var group = quizEl.querySelector('.quiz-options[data-q="' + qIdx + '"]');
        var options = group.querySelectorAll(".quiz-opt");
        var selected = group.querySelector('input[name="' + qName + "-q" + qIdx + '"]:checked');
        if (selected) answered++;
        options.forEach(function(opt, optIdx){
          opt.classList.remove("correct", "incorrect", "selected");
          if (selected && parseInt(selected.value, 10) === optIdx) {
            opt.classList.add(optIdx === correctIdx ? "correct" : "incorrect");
          } else if (optIdx === correctIdx && selected) {
            opt.classList.add("correct");
          }
        });
        if (selected && parseInt(selected.value, 10) === correctIdx) score++;
      });
      if (answered < correct.length){
        scoreText.innerHTML = "Ответьте на все вопросы (" + answered + "/" + correct.length + ")";
        return;
      }
      scoreText.innerHTML = "Результат: <b>" + score + "/" + correct.length + "</b>";
      if (moduleId) setModuleResult(moduleId, score, correct.length);
    });

    resetBtn.addEventListener("click", function(){
      quizEl.querySelectorAll("input[type=radio]").forEach(function(i){ i.checked = false; });
      quizEl.querySelectorAll(".quiz-opt").forEach(function(o){ o.classList.remove("correct", "incorrect", "selected"); });
      scoreText.innerHTML = "";
    });

    quizEl.querySelectorAll(".quiz-opt input").forEach(function(input){
      input.addEventListener("change", function(){
        var group = input.closest(".quiz-options");
        group.querySelectorAll(".quiz-opt").forEach(function(o){ o.classList.remove("selected"); });
        input.closest(".quiz-opt").classList.add("selected");
      });
    });
  }

  function initNavGroups(){
    var groups = document.querySelectorAll(".nav-group");
    if (!groups.length) return;

    function closeAll(except){
      groups.forEach(function(g){ if (g !== except) g.classList.remove("open"); });
    }

    groups.forEach(function(g){
      var trigger = g.querySelector(".nav-group-trigger");
      trigger.addEventListener("click", function(e){
        e.stopPropagation();
        var willOpen = !g.classList.contains("open");
        closeAll();
        if (willOpen) g.classList.add("open");
      });
    });

    document.addEventListener("click", function(){ closeAll(); });
    document.addEventListener("keydown", function(e){
      if (e.key === "Escape") closeAll();
    });
  }

  var TYPE_LABEL = {module: "Модуль", term: "Термин", theory: "Теория", misconception: "Заблуждение", cli: "CLI"};
  var TYPE_RANK = {module: 0, term: 1, theory: 2, misconception: 3, cli: 4};

  function initSearch(){
    var trigger = document.querySelector(".search-trigger");
    var overlay = document.querySelector(".search-overlay");
    if (!trigger || !overlay) return;

    var panel = overlay.querySelector(".search-panel");
    var input = overlay.querySelector(".search-input");
    var closeBtn = overlay.querySelector(".search-close");
    var results = overlay.querySelector(".search-results");
    var depth = document.body.dataset.depth || "";
    var index = null;
    var indexPromise = null;

    function loadIndex(){
      if (!indexPromise){
        indexPromise = fetch(depth + "assets/search-index.json", {cache: "no-cache"})
          .then(function(r){ return r.json(); })
          .then(function(data){ index = data; return data; })
          .catch(function(){ index = []; return []; });
      }
      return indexPromise;
    }

    function render(query){
      var q = query.trim().toLowerCase();
      if (!q){ results.innerHTML = ""; return; }
      if (!index){ results.innerHTML = '<div class="search-empty">Загрузка…</div>'; return; }

      var matches = index.filter(function(e){
        return e.title.toLowerCase().indexOf(q) !== -1 ||
               e.snippet.toLowerCase().indexOf(q) !== -1 ||
               e.module.toLowerCase().indexOf(q) !== -1;
      });
      matches.sort(function(a, b){
        var ra = TYPE_RANK[a.type], rb = TYPE_RANK[b.type];
        if (ra !== rb) return ra - rb;
        var aStarts = a.title.toLowerCase().indexOf(q) === 0 ? 0 : 1;
        var bStarts = b.title.toLowerCase().indexOf(q) === 0 ? 0 : 1;
        return aStarts - bStarts;
      });
      matches = matches.slice(0, 25);

      if (!matches.length){
        results.innerHTML = '<div class="search-empty">Ничего не найдено по «' + query + '»</div>';
        return;
      }
      results.innerHTML = matches.map(function(e){
        return '<a class="search-result" href="' + depth + e.url + '">' +
          '<span class="search-result-type">' + TYPE_LABEL[e.type] + '</span>' +
          '<span class="search-result-body"><span class="search-result-title">' + e.title + '</span>' +
          '<span class="search-result-module">' + e.module + '</span></span></a>';
      }).join("");
    }

    function open(){
      overlay.classList.add("open");
      loadIndex().then(function(){ render(input.value); });
      setTimeout(function(){ input.focus(); }, 0);
    }
    function close(){
      overlay.classList.remove("open");
    }

    trigger.addEventListener("click", function(e){ e.stopPropagation(); open(); });
    closeBtn.addEventListener("click", close);
    overlay.addEventListener("click", function(e){ if (e.target === overlay) close(); });
    panel.addEventListener("click", function(e){ e.stopPropagation(); });
    results.addEventListener("click", function(e){
      var link = e.target.closest(".search-result");
      if (!link) return;
      close();
      var hash = link.getAttribute("href").split("#")[1];
      if (hash){
        setTimeout(function(){
          var el = document.getElementById(hash);
          if (el) el.scrollIntoView({behavior: "smooth", block: "start"});
        }, 50);
      }
    });
    input.addEventListener("input", function(){ render(input.value); });
    document.addEventListener("keydown", function(e){
      if (e.key === "Escape") close();
      if ((e.metaKey || e.ctrlKey) && e.key === "k"){ e.preventDefault(); open(); }
    });
  }

  function initGlossaryFilter(){
    var filterInput = document.querySelector(".gloss-page-filter");
    if (!filterInput) return;
    var items = document.querySelectorAll(".gloss-page-item");
    var empty = document.querySelector(".gloss-page-empty");
    var countEl = document.querySelector(".gloss-page-count");

    filterInput.addEventListener("input", function(){
      var q = filterInput.value.trim().toLowerCase();
      var visible = 0;
      items.forEach(function(item){
        var match = !q || item.dataset.term.indexOf(q) !== -1 || item.dataset.def.indexOf(q) !== -1;
        item.hidden = !match;
        if (match) visible++;
      });
      if (empty) empty.hidden = visible !== 0;
      if (countEl) countEl.textContent = visible + " терминов";
    });
  }

  function initCliCopy(){
    document.querySelectorAll(".cli-copy").forEach(function(btn){
      btn.addEventListener("click", function(){
        var target = document.getElementById(btn.dataset.copyTarget);
        if (!target) return;
        var text = target.textContent;
        var done = function(){
          var original = btn.textContent;
          btn.textContent = "Скопировано ✓";
          btn.classList.add("copied");
          setTimeout(function(){
            btn.textContent = original;
            btn.classList.remove("copied");
          }, 1600);
        };
        if (navigator.clipboard && navigator.clipboard.writeText){
          navigator.clipboard.writeText(text).then(done, function(){
            fallbackCopy(text); done();
          });
        } else {
          fallbackCopy(text); done();
        }
      });
    });
  }

  function fallbackCopy(text){
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try{ document.execCommand("copy"); }catch(e){}
    document.body.removeChild(ta);
  }

  document.addEventListener("DOMContentLoaded", function(){
    document.querySelectorAll(".quiz").forEach(initQuiz);
    initNavGroups();
    initSearch();
    initGlossaryFilter();
    initCliCopy();
    renderProgress();
  });
})();
