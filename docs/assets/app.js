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

  var TYPE_LABEL = {module: "Модуль", term: "Термин", theory: "Теория", misconception: "Заблуждение", cli: "CLI", lab: "Практика", tool: "Инструмент"};
  var TYPE_RANK = {module: 0, term: 1, theory: 2, misconception: 3, cli: 4, lab: 5, tool: 6};

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


  /* ================= Engineer toolkit (tools.html) ================= */

  function esc(s){
    return String(s).replace(/[&<>"]/g, function(c){
      return {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c];
    });
  }
  function fmtNum(n){ return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " "); }
  // Russian plural: plural(5, "адрес", "адреса", "адресов") -> "адресов"
  function plural(n, one, few, many){
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  function ipToInt(s){
    var p = s.trim().split(".");
    if (p.length !== 4) return null;
    var n = 0;
    for (var i = 0; i < 4; i++){
      if (!/^\d{1,3}$/.test(p[i])) return null;
      var o = parseInt(p[i], 10);
      if (o > 255) return null;
      n = n * 256 + o;
    }
    return n;
  }
  function intToIp(n){
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
  }
  function prefixToMask(p){ return p === 0 ? 0 : (0xFFFFFFFF << (32 - p)) >>> 0; }
  function maskToPrefix(m){
    var p = 0;
    while (p < 32 && ((m >>> (31 - p)) & 1)) p++;
    return prefixToMask(p) === m ? p : -1;
  }
  function blockSize(p){ return Math.pow(2, 32 - p); }

  // "a.b.c.d/nn", "a.b.c.d m.m.m.m", "a.b.c.d" (=/32)
  function parseCidr(str){
    var s = str.trim().replace(/\s+/g, " ");
    if (!s) return null;
    var ipPart, pfx;
    if (s.indexOf("/") !== -1){
      var sp = s.split("/");
      if (sp.length !== 2) return null;
      ipPart = sp[0].trim();
      var right = sp[1].trim();
      if (/^\d{1,2}$/.test(right)) pfx = parseInt(right, 10);
      else { var mm = ipToInt(right); if (mm === null) return null; pfx = maskToPrefix(mm); }
    } else if (s.indexOf(" ") !== -1){
      var sp2 = s.split(" ");
      ipPart = sp2[0];
      var m2 = ipToInt(sp2[1]);
      if (m2 === null) return null;
      pfx = maskToPrefix(m2);
    } else {
      ipPart = s; pfx = 32;
    }
    var ip = ipToInt(ipPart);
    if (ip === null || pfx < 0 || pfx > 32) return null;
    var mask = prefixToMask(pfx);
    var net = (ip & mask) >>> 0;
    return {ip: ip, prefix: pfx, mask: mask, net: net, bcast: (net + blockSize(pfx) - 1)};
  }

  function inRange(n, cidr){
    var c = parseCidr(cidr);
    return n >= c.net && n <= c.bcast;
  }
  function addrType(n){
    var t = [
      ["10.0.0.0/8", "частный (RFC 1918)"], ["172.16.0.0/12", "частный (RFC 1918)"],
      ["192.168.0.0/16", "частный (RFC 1918)"], ["100.64.0.0/10", "CGNAT (RFC 6598)"],
      ["127.0.0.0/8", "loopback"], ["169.254.0.0/16", "link-local (APIPA)"],
      ["192.0.2.0/24", "документация"], ["198.51.100.0/24", "документация"], ["203.0.113.0/24", "документация"],
      ["198.18.0.0/15", "бенчмаркинг"], ["224.0.0.0/4", "multicast"], ["240.0.0.0/4", "зарезервирован"],
      ["0.0.0.0/8", "«этот» сеть / не маршрутизируется"]
    ];
    for (var i = 0; i < t.length; i++) if (inRange(n, t[i][0])) return t[i][1];
    return "публичный";
  }

  function bitsHtml(ip, prefix){
    var out = "";
    for (var i = 31; i >= 0; i--){
      var bit = (ip >>> i) & 1;
      var pos = 31 - i;
      out += '<span class="' + (pos < prefix ? "bit-net" : "bit-host") + '">' + bit + "</span>";
      if (i % 8 === 0 && i !== 0) out += '<span class="bit-dot">.</span>';
    }
    return out;
  }

  function kv(rows){
    return '<div class="kv-grid">' + rows.map(function(r){
      return '<div class="kv-k">' + r[0] + '</div><div class="kv-v">' + r[1] + "</div>";
    }).join("") + "</div>";
  }
  function errHtml(msg){ return '<div class="tool-error">' + msg + "</div>"; }

  function initSubnetCalc(){
    var input = document.getElementById("subnet-input");
    if (!input) return;
    var out = document.getElementById("subnet-result");
    var splitIn = document.getElementById("split-prefix");
    var splitOut = document.getElementById("split-result");

    function run(){
      var c = parseCidr(input.value);
      if (!c){
        out.innerHTML = errHtml("Не удалось разобрать адрес. Пример: <code>192.168.10.37/27</code>");
        splitOut.innerHTML = "";
        return;
      }
      var total = blockSize(c.prefix);
      var first, last, usable;
      if (c.prefix === 32){ first = last = c.net; usable = 1; }
      else if (c.prefix === 31){ first = c.net; last = c.bcast; usable = 2; }
      else { first = c.net + 1; last = c.bcast - 1; usable = total - 2; }
      var wc = (~c.mask) >>> 0;
      var note = "";
      if (c.ip === c.net && c.prefix < 31) note = ' <span class="tool-warn">это адрес сети, а не хоста</span>';
      else if (c.ip === c.bcast && c.prefix < 31) note = ' <span class="tool-warn">это broadcast, а не хост</span>';
      out.innerHTML = kv([
        ["Адрес", "<code>" + intToIp(c.ip) + "</code>" + note],
        ["Сеть", "<code>" + intToIp(c.net) + "/" + c.prefix + "</code>"],
        ["Маска", "<code>" + intToIp(c.mask) + "</code>"],
        ["Wildcard", "<code>" + intToIp(wc) + "</code>"],
        ["Broadcast", "<code>" + (c.prefix >= 31 ? "—" : intToIp(c.bcast)) + "</code>"],
        ["Диапазон хостов", "<code>" + intToIp(first) + " — " + intToIp(last) + "</code>"],
        ["Хостов", fmtNum(usable) + ' <span class="kv-dim">из ' + fmtNum(total) + " " + plural(total, "адреса", "адресов", "адресов") + "</span>"],
        ["Тип", addrType(c.ip)],
        ["Двоичный вид", '<span class="bits">' + bitsHtml(c.ip, c.prefix) + "</span>"],
        ["Cisco", "<code>ip address " + intToIp(first) + " " + intToIp(c.mask) + "</code><br>" +
                  "<code>network " + intToIp(c.net) + " " + intToIp(wc) + " area 0</code>"]
      ]);
      runSplit(c);
    }

    function runSplit(c){
      var np = parseInt(splitIn.value, 10);
      if (isNaN(np) || np < c.prefix || np > 32){
        splitOut.innerHTML = errHtml("Новый префикс должен быть от /" + c.prefix + " до /32.");
        return;
      }
      var count = Math.pow(2, np - c.prefix);
      var size = blockSize(np);
      var shown = Math.min(count, 64);
      var rows = [];
      for (var i = 0; i < shown; i++){
        var n = c.net + i * size;
        var b = n + size - 1;
        var range = np >= 31 ? intToIp(n) + " — " + intToIp(b) : intToIp(n + 1) + " — " + intToIp(b - 1);
        rows.push("<tr><td>" + (i + 1) + "</td><td>" + intToIp(n) + "/" + np + "</td><td>" + range +
                  "</td><td>" + (np >= 31 ? "—" : intToIp(b)) + "</td></tr>");
      }
      splitOut.innerHTML = '<p class="tool-summary">' + fmtNum(count) + " " + plural(count, "подсеть", "подсети", "подсетей") +
        " по " + fmtNum(size) + " " + plural(size, "адресу", "адреса", "адресов") + (count > shown ? " — показаны первые " + shown : "") + "</p>" +
        '<div class="table-scroll"><table class="ref-table mono-table"><thead><tr><th>#</th><th>Сеть</th><th>Хосты</th><th>Broadcast</th></tr></thead><tbody>' +
        rows.join("") + "</tbody></table></div>";
    }

    input.addEventListener("input", run);
    splitIn.addEventListener("input", run);
    run();
  }

  function initSummaryCalc(){
    var input = document.getElementById("summary-input");
    if (!input) return;
    var out = document.getElementById("summary-result");
    function run(){
      var lines = input.value.split(/[\n,;]+/).map(function(l){ return l.trim(); }).filter(Boolean);
      if (!lines.length){ out.innerHTML = ""; return; }
      var nets = [];
      for (var i = 0; i < lines.length; i++){
        var c = parseCidr(lines[i]);
        if (!c){ out.innerHTML = errHtml("Строка «" + esc(lines[i]) + "» — не сеть. Формат: <code>10.1.0.0/24</code>"); return; }
        nets.push(c);
      }
      var lo = Math.min.apply(null, nets.map(function(n){ return n.net; }));
      var hi = Math.max.apply(null, nets.map(function(n){ return n.bcast; }));
      var p = 32;
      while (p > 0 && !(((lo & prefixToMask(p)) >>> 0) === ((hi & prefixToMask(p)) >>> 0))) p--;
      var sumNet = (lo & prefixToMask(p)) >>> 0;
      var sumSize = blockSize(p);

      // merge input ranges to count how much of the summary they actually cover
      var ranges = nets.map(function(n){ return [n.net, n.bcast]; }).sort(function(a, b){ return a[0] - b[0]; });
      var covered = 0, cur = null;
      ranges.forEach(function(r){
        if (!cur){ cur = r.slice(); return; }
        if (r[0] <= cur[1] + 1){ cur[1] = Math.max(cur[1], r[1]); }
        else { covered += cur[1] - cur[0] + 1; cur = r.slice(); }
      });
      covered += cur[1] - cur[0] + 1;
      var extra = sumSize - covered;
      var wc = (~prefixToMask(p)) >>> 0;
      var status = extra === 0
        ? '<span class="tool-ok">точная суммаризация — лишних адресов нет</span>'
        : '<span class="tool-warn">захватывает ' + fmtNum(extra) + " " + plural(extra, "лишний адрес", "лишних адреса", "лишних адресов") +
          " — убедитесь, что они не используются в другом месте, или разбейте на несколько суммарных</span>";
      out.innerHTML = kv([
        ["Суммарный маршрут", "<code>" + intToIp(sumNet) + "/" + p + "</code>"],
        ["Маска", "<code>" + intToIp(prefixToMask(p)) + "</code>"],
        ["Покрытие", status],
        ["OSPF (ABR)", "<code>area 1 range " + intToIp(sumNet) + " " + intToIp(prefixToMask(p)) + "</code>"],
        ["BGP", "<code>aggregate-address " + intToIp(sumNet) + " " + intToIp(prefixToMask(p)) + " summary-only</code>"],
        ["ACL", "<code>permit ip " + intToIp(sumNet) + " " + intToIp(wc) + " any</code>"]
      ]);
    }
    input.addEventListener("input", run);
    run();
  }

  function initMtuCalc(){
    var base = document.getElementById("mtu-base");
    if (!base) return;
    var ver = document.getElementById("mtu-ipver");
    var labels = document.getElementById("mtu-labels");
    var out = document.getElementById("mtu-result");
    var boxes = document.querySelectorAll("[data-overhead]");
    function run(){
      var b = parseInt(base.value, 10);
      if (isNaN(b) || b < 68){ out.innerHTML = errHtml("Укажите MTU линка, например 1500."); return; }
      var parts = [], sum = 0;
      boxes.forEach(function(cb){
        if (cb.checked){
          var v = parseInt(cb.dataset.overhead, 10);
          sum += v; parts.push(cb.dataset.name + " " + v);
        }
      });
      var nl = Math.max(0, parseInt(labels.value, 10) || 0);
      if (nl){ sum += nl * 4; parts.push("MPLS " + nl + "×4"); }
      var ipMtu = b - sum;
      var hdr = ver.value === "6" ? 60 : 40;
      var mss = ipMtu - hdr;
      if (mss <= 0){ out.innerHTML = errHtml("Накладные расходы больше MTU."); return; }
      var pingSize = ipMtu - (ver.value === "6" ? 48 : 28);
      out.innerHTML = kv([
        ["Накладные расходы", sum + " " + plural(sum, "байт", "байта", "байт") + (parts.length ? ' <span class="kv-dim">(' + esc(parts.join(" + ")) + ")</span>" : "")],
        ["IP MTU внутри", "<b>" + ipMtu + "</b> байт"],
        ["TCP MSS", "<b>" + mss + "</b> байт <span class=\"kv-dim\">(MTU − " + hdr + ": IPv" + ver.value + " + TCP)</span>"],
        ["На туннеле", "<code>ip mtu " + ipMtu + "</code><br><code>ip tcp adjust-mss " + mss + "</code>"],
        ["Проверка", "<code>ping &lt;адрес&gt; size " + ipMtu + " df-bit</code><br><code>ping -M do -s " + pingSize + " &lt;адрес&gt;</code> <span class=\"kv-dim\">(Linux: размер без IP/ICMP-заголовков)</span>"]
      ]);
    }
    [base, ver, labels].forEach(function(el){ el.addEventListener("input", run); });
    boxes.forEach(function(cb){ cb.addEventListener("change", run); });
    run();
  }

  function fmtDuration(sec){
    if (!isFinite(sec)) return "—";
    if (sec < 1) return (sec * 1000).toFixed(sec < 0.01 ? 2 : 0) + " мс";
    var d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600),
        m = Math.floor(sec % 3600 / 60), s = Math.round(sec % 60);
    var out = [];
    if (d) out.push(d + " д");
    if (h) out.push(h + " ч");
    if (m) out.push(m + " мин");
    if (s || !out.length) out.push(s + " с");
    return out.join(" ");
  }
  function fmtBytes(b){
    if (b >= 1e9) return (b / 1e9).toFixed(2) + " ГБ";
    if (b >= 1e6) return (b / 1e6).toFixed(2) + " МБ";
    if (b >= 1e3) return (b / 1e3).toFixed(1) + " КБ";
    return Math.round(b) + " Б";
  }
  function fmtRate(bps){
    if (bps >= 1e9) return (bps / 1e9).toFixed(2) + " Гбит/с";
    if (bps >= 1e6) return (bps / 1e6).toFixed(1) + " Мбит/с";
    return (bps / 1e3).toFixed(0) + " Кбит/с";
  }

  function initSpeedCalc(){
    var size = document.getElementById("speed-size");
    if (!size) return;
    var sizeU = document.getElementById("speed-size-unit"), rate = document.getElementById("speed-rate"),
        rateU = document.getElementById("speed-rate-unit"), eff = document.getElementById("speed-eff"),
        out = document.getElementById("speed-result");
    function run(){
      var bytes = parseFloat(size.value) * parseFloat(sizeU.value);
      var bps = parseFloat(rate.value) * parseFloat(rateU.value) * (parseFloat(eff.value) / 100);
      if (!(bytes >= 0) || !(bps > 0)){ out.innerHTML = errHtml("Укажите объём и скорость больше нуля."); return; }
      var sec = bytes * 8 / bps;
      out.innerHTML = kv([
        ["Время", "<b>" + fmtDuration(sec) + "</b>"],
        ["Полезная скорость", fmtRate(bps) + ' <span class="kv-dim">≈ ' + fmtBytes(bps / 8) + "/с</span>"],
        ["Помните", '<span class="kv-dim">провайдеры считают в битах и десятичных единицах: 100 Мбит/с ≈ 12,5 МБ/с, а не 100</span>']
      ]);
    }
    [size, sizeU, rate, rateU, eff].forEach(function(el){ el.addEventListener("input", run); });
    run();

    var bRate = document.getElementById("bdp-rate"), bRtt = document.getElementById("bdp-rtt"),
        bWin = document.getElementById("bdp-win"), bOut = document.getElementById("bdp-result");
    function runBdp(){
      var bps = parseFloat(bRate.value) * 1e6, rtt = parseFloat(bRtt.value) / 1000, win = parseFloat(bWin.value) * 1024;
      if (!(bps > 0) || !(rtt > 0) || !(win > 0)){ bOut.innerHTML = errHtml("Все значения должны быть больше нуля."); return; }
      var bdp = bps * rtt / 8;
      var maxTp = win * 8 / rtt;
      var limited = maxTp < bps;
      bOut.innerHTML = kv([
        ["BDP", "<b>" + fmtBytes(bdp) + "</b> <span class=\"kv-dim\">— столько данных «в полёте» нужно, чтобы заполнить канал</span>"],
        ["Предел одной TCP-сессии", "<b>" + fmtRate(Math.min(maxTp, bps)) + "</b>" +
          (limited ? ' <span class="tool-warn">окно ' + esc(bWin.value) + " КБ ограничивает скорость — нужен window scaling или несколько потоков</span>"
                   : ' <span class="tool-ok">окна достаточно</span>')]
      ]);
    }
    [bRate, bRtt, bWin].forEach(function(el){ el.addEventListener("input", runBdp); });
    runBdp();
  }

  function initMacCalc(){
    var input = document.getElementById("mac-input");
    if (!input) return;
    var out = document.getElementById("mac-result");
    function run(){
      var hex = input.value.replace(/[\s:.\-]/g, "").toLowerCase();
      if (!/^[0-9a-f]{12}$/.test(hex)){
        out.innerHTML = errHtml("Нужно 12 шестнадцатеричных цифр. Пример: <code>00:1A:2B:3C:4D:5E</code>");
        return;
      }
      var o = hex.match(/../g);
      var first = parseInt(o[0], 16);
      var isMcast = first & 1, isLocal = first & 2;
      var isBcast = hex === "ffffffffffff";
      var eui = [(first ^ 2).toString(16).padStart(2, "0") + o[1], o[2] + "ff", "fe" + o[3], o[4] + o[5]];
      var euiShort = eui.map(function(g){ return g.replace(/^0+(?=.)/, ""); }).join(":");
      out.innerHTML = kv([
        ["Cisco", "<code>" + hex.slice(0, 4) + "." + hex.slice(4, 8) + "." + hex.slice(8) + "</code>"],
        ["Linux / IEEE", "<code>" + o.join(":") + "</code>"],
        ["Windows", "<code>" + o.join("-").toUpperCase() + "</code>"],
        ["Без разделителей", "<code>" + hex + "</code>"],
        ["OUI (производитель)", "<code>" + o.slice(0, 3).join(":").toUpperCase() + "</code> <span class=\"kv-dim\">— первые 3 байта; поиск по базе IEEE</span>"],
        ["Тип", isBcast ? "broadcast" : (isMcast ? "multicast (I/G = 1)" : "unicast") + ", " +
                (isLocal ? "локально администрируемый (U/L = 1) — часто ВМ, контейнер или рандомизация MAC" : "глобально уникальный (выдан производителем)")],
        ["EUI-64 Interface ID", "<code>" + euiShort + "</code> <span class=\"kv-dim\">(вставлен ff:fe, инвертирован 7-й бит)</span>"],
        ["IPv6 link-local", "<code>fe80::" + euiShort.replace(/^(0:)+/, "") + "</code>"]
      ]);
    }
    input.addEventListener("input", run);
    run();
  }

  function initCmdFilter(){
    var f = document.querySelector(".cmd-filter");
    if (!f) return;
    var rows = document.querySelectorAll(".cmd-row");
    var empty = document.querySelector(".cmd-empty");
    f.addEventListener("input", function(){
      var q = f.value.trim().toLowerCase(), vis = 0;
      rows.forEach(function(r){
        var ok = !q || r.dataset.search.indexOf(q) !== -1;
        r.hidden = !ok;
        if (ok) vis++;
      });
      empty.hidden = vis !== 0;
    });
  }

  var CHECK_KEY = "sdsm_checklist";
  function initChecklist(){
    var boxes = document.querySelectorAll("[data-check-id]");
    if (!boxes.length) return;
    var progress = document.querySelector(".check-progress");
    var state = {};
    try{ state = JSON.parse(localStorage.getItem(CHECK_KEY)) || {}; }catch(e){ state = {}; }
    function save(){ try{ localStorage.setItem(CHECK_KEY, JSON.stringify(state)); }catch(e){} }
    function render(){
      var done = 0;
      boxes.forEach(function(b){
        b.checked = !!state[b.dataset.checkId];
        b.closest(".check-item").classList.toggle("done", b.checked);
        if (b.checked) done++;
      });
      if (progress) progress.innerHTML = "Проверено <b>" + done + "/" + boxes.length + "</b>";
    }
    boxes.forEach(function(b){
      b.addEventListener("change", function(){
        if (b.checked) state[b.dataset.checkId] = 1; else delete state[b.dataset.checkId];
        save(); render();
      });
    });
    var reset = document.querySelector(".check-reset");
    if (reset) reset.addEventListener("click", function(){ state = {}; save(); render(); });
    render();
  }

  function initTools(){
    initSubnetCalc();
    initSummaryCalc();
    initMtuCalc();
    initSpeedCalc();
    initMacCalc();
    initCmdFilter();
    initChecklist();
  }

  document.addEventListener("DOMContentLoaded", function(){
    document.querySelectorAll(".quiz").forEach(initQuiz);
    initNavGroups();
    initSearch();
    initGlossaryFilter();
    initCliCopy();
    initTools();
    renderProgress();
  });
})();
