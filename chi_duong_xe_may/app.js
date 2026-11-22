/* Điều khiển chính: GPS, tốc độ, giới hạn, cảnh báo, báo cáo, tìm kiếm, dẫn đường. */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function load(k, def) { try { var v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch (e) { return def; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  var map = new TileMap($('map'));

  var S = {
    pos: null, prev: null, heading: null, speed: 0,
    follow: true, threeD: false,
    nav: null, cum: null, hint: 0, offCount: 0, lastReroute: 0, dest: null,
    limit: null, limitAt: null, limitTime: 0, limitBusy: false,
    osmCams: [], camAt: null, camBusy: false, warned: {}, lastOverBeep: 0,
    offset: load('speedOffset', 0) | 0,
    beep: load('beepOn', true),
    use3d: load('use3d', true),
    style: load('mapStyle', 'waze'),
    reports: load('reports', [])
  };
  // Chuyển camera tự đánh dấu ở bản trước sang dạng báo cáo
  load('userCams', []).forEach(function (c) { S.reports.push({ type: 'camera', lat: c.lat, lon: c.lon, ts: Date.now() }); });
  try { localStorage.removeItem('userCams'); } catch (e) {}

  // ---------- Loại báo cáo ----------
  var H = 3600 * 1000;
  var TYPES = {
    camera:   { icon: '📷', color: '#ff9f1a', text: 'Camera tốc độ', ttl: 0 },
    police:   { icon: '👮', color: '#4a7dff', text: 'Cảnh sát phía trước', ttl: 2 * H },
    accident: { icon: '💥', color: '#ff5a5f', text: 'Tai nạn phía trước', ttl: 2 * H },
    jam:      { icon: '🚗', color: '#ff5a5f', text: 'Kẹt xe phía trước', ttl: 1 * H },
    flood:    { icon: '🌊', color: '#1aa7ec', text: 'Đường ngập nước', ttl: 6 * H },
    hazard:   { icon: '⚠️', color: '#ffb31a', text: 'Nguy hiểm trên đường', ttl: 6 * H }
  };
  function liveReports() {
    var now = Date.now();
    S.reports = S.reports.filter(function (r) { var t = TYPES[r.type]; return t && (!t.ttl || now - r.ts < t.ttl); });
    return S.reports;
  }
  function alertables() {
    var list = S.osmCams.map(function (c) { return { type: 'camera', lat: c.lat, lon: c.lon, limit: c.limit }; });
    return list.concat(liveReports());
  }
  function refreshMarkers() {
    map.markers = alertables().map(function (a) { var t = TYPES[a.type]; return { lat: a.lat, lon: a.lon, icon: t.icon, color: t.color }; });
    map.render();
  }

  // ---------- Âm báo ----------
  var audio = null;
  function unlockAudio() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audio = new AC();
    var o = audio.createOscillator(), g = audio.createGain();
    g.gain.value = 0; o.connect(g); g.connect(audio.destination); o.start(0); o.stop(audio.currentTime + 0.05);
  }
  function beep(times, freq) {
    if (!S.beep || !audio) return;
    if (audio.state === 'suspended') audio.resume();
    for (var i = 0; i < times; i++) {
      var t = audio.currentTime + i * 0.22, o = audio.createOscillator(), g = audio.createGain();
      o.type = 'square'; o.frequency.value = freq || 1150;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.35, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      o.connect(g); g.connect(audio.destination); o.start(t); o.stop(t + 0.18);
    }
  }

  var toastTimer;
  function toast(msg, ms) {
    var el = $('toast'); el.textContent = msg; el.classList.remove('hidden');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.classList.add('hidden'); }, ms || 2200);
  }
  function fmtDist(m) {
    if (m < 1000) return (m < 100 ? Math.round(m / 10) * 10 : Math.round(m / 50) * 50) + ' m';
    return (m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',') + ' km';
  }
  function fmtTime(d) { var h = d.getHours(), m = d.getMinutes(); return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m; }

  // ---------- Bảng trượt ----------
  var SHEETS = ['sheetReport', 'sheetLayers', 'sheetSet'];
  function openSheet(id) { SHEETS.forEach(function (s) { $(s).classList.toggle('hidden', s !== id || !$(s).classList.contains('hidden')); }); }
  function closeSheets() { SHEETS.forEach(function (s) { $(s).classList.add('hidden'); }); }
  Array.prototype.forEach.call(document.querySelectorAll('[data-close]'), function (b) { b.addEventListener('click', closeSheets); });

  // ---------- Bắt đầu ----------
  map.setStyle(S.style);
  refreshMarkers();
  $('btnStart').addEventListener('click', function () {
    unlockAudio();
    $('start').classList.add('hidden');
    if (!navigator.geolocation) { toast('Máy không hỗ trợ GPS'); return; }
    navigator.geolocation.watchPosition(onPos, function (err) {
      if (err.code === 1) toast('Chưa cho phép vị trí. Vào Cài đặt › Quyền riêng tư › Dịch vụ định vị › Safari.', 5000);
      else toast('Đang chờ tín hiệu GPS…');
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  });

  // ---------- Mỗi lần GPS cập nhật ----------
  function onPos(p) {
    var c = p.coords, now = p.timestamp || Date.now();
    var pos = { lat: c.latitude, lon: c.longitude, t: now };
    var v = (c.speed != null && c.speed >= 0) ? c.speed : null;
    if (v == null && S.prev) { var dt = (now - S.prev.t) / 1000; if (dt > 0.5) v = Geo.dist(S.prev, pos) / dt; }
    if (v != null) S.speed = S.speed * 0.35 + v * 0.65;
    if (c.heading != null && !isNaN(c.heading) && c.heading >= 0 && S.speed > 1.5) S.heading = c.heading;
    else if (S.prev && Geo.dist(S.prev, pos) > 6) S.heading = Geo.bearing(S.prev, pos);
    if (!S.prev || Geo.dist(S.prev, pos) > 3 || now - S.prev.t > 3000) S.prev = pos;
    var first = !S.pos;
    S.pos = pos;

    map.user = { lat: pos.lat, lon: pos.lon, heading: S.speed > 1 ? S.heading : null };
    updateView(first);
    showSpeed();
    checkLimit();
    checkAlerts();
    if (S.nav) updateNav();
  }

  // Chế độ xem: 3D xoay theo hướng khi đang đi/dẫn đường, phẳng khi đứng yên hoặc tự kéo bản đồ
  function updateView(first) {
    if (!S.pos) return;
    if (!S.follow) { map.render(); return; }
    var kmh = S.speed * 3.6;
    if (S.use3d && (S.nav || kmh > 8)) S.threeD = true;
    else if (!S.nav && kmh < 3) S.threeD = false;
    if (!S.use3d) S.threeD = false;
    if (S.threeD !== map.nav) { map.setNav(S.threeD); if (S.threeD) map.z = 17; }
    if (S.threeD && S.heading != null) map.setBearing(S.heading);
    if (first) map.setView(S.pos.lat, S.pos.lon, 17);
    else map.glideTo(S.pos.lat, S.pos.lon, 900);
  }

  // ---------- Tốc độ & giới hạn ----------
  function showSpeed() {
    var kmh = S.speed * 3.6;
    $('speed').textContent = kmh < 2 ? 0 : Math.max(0, Math.round(kmh + S.offset));
    $('rawSpeed').textContent = kmh < 2 ? 0 : Math.round(kmh);
    var over = S.limit && kmh > S.limit.limit + 3;
    $('gauges').classList.toggle('over', !!over);
    if (over && Date.now() - S.lastOverBeep > 4000) { S.lastOverBeep = Date.now(); beep(2, 880); }
  }
  function checkLimit() {
    if (S.limitBusy || !S.pos) return;
    var moved = S.limitAt ? Geo.dist(S.limitAt, S.pos) : Infinity;
    if (moved < 100 && Date.now() - S.limitTime < 25000) return;
    S.limitBusy = true;
    var at = { lat: S.pos.lat, lon: S.pos.lon };
    Data.speedLimit(at, S.speed > 1.5 ? S.heading : null).then(function (r) {
      S.limit = r; S.limitAt = at; S.limitTime = Date.now();
      $('limit').textContent = r ? r.limit : '--';
      $('limitNote').textContent = r ? (r.exact ? 'giới hạn' : 'ước tính') : 'không rõ';
      showSpeed();
    }).catch(function () { S.limitTime = Date.now() - 15000; })
      .then(function () { S.limitBusy = false; });
  }

  // ---------- Cảnh báo phía trước (camera + báo cáo) ----------
  function checkAlerts() {
    if (!S.pos) return;
    if (!S.camBusy && (!S.camAt || Geo.dist(S.camAt, S.pos) > 3000)) {
      S.camBusy = true;
      var at = { lat: S.pos.lat, lon: S.pos.lon };
      Data.cameras(at, 8000).then(function (list) { S.osmCams = list; S.camAt = at; refreshMarkers(); })
        .catch(function () {}).then(function () { S.camBusy = false; });
    }
    // Khoảng cách cảnh báo tăng theo tốc độ: luôn có ~20 giây phản ứng (tối thiểu 400 m)
    var kmh = S.speed * 3.6, ms = S.speed;
    var warnFar = Math.max(400, Math.round(ms * 20)), warnNear = Math.max(150, Math.round(ms * 8));
    var best = null, all = alertables();
    for (var i = 0; i < all.length; i++) {
      var d = Geo.dist(S.pos, all[i]);
      if (d > warnFar) continue;
      var ahead = S.heading == null || S.speed < 1.5 || d < 40 ||
        Geo.angleDiff(Geo.bearing(S.pos, all[i]), S.heading) < 50;
      if (ahead && (!best || d < best.d)) best = { d: d, a: all[i], key: all[i].type + all[i].lat.toFixed(5) + all[i].lon.toFixed(5) };
    }
    if (!best) { $('alert').classList.add('hidden'); return; }
    var t = TYPES[best.a.type];
    $('alert').classList.remove('hidden');
    $('alertIcon').textContent = t.icon;
    $('alertIcon').style.background = t.color;
    $('alert').style.borderColor = t.color;
    $('alertText').textContent = t.text + (best.a.limit ? ' · ' + best.a.limit : '');
    $('alertDist').textContent = fmtDist(best.d);
    var w = S.warned[best.key] || 0;
    if (w < 1) { beep(2, 1150); S.warned[best.key] = 1; }
    if (best.d < warnNear && w < 2) { beep(3, 1400); S.warned[best.key] = 2; }
    if (best.a.limit && kmh > best.a.limit && Date.now() - S.lastOverBeep > 3000) { S.lastOverBeep = Date.now(); beep(2, 880); }
  }

  // ---------- Báo cáo ----------
  $('btnReport').addEventListener('click', function () { openSheet('sheetReport'); });
  Array.prototype.forEach.call(document.querySelectorAll('.rep'), function (b) {
    b.addEventListener('click', function () {
      var type = b.getAttribute('data-type');
      if (!S.pos) { toast('Chưa có vị trí GPS'); return; }
      closeSheets();
      var list = liveReports();
      for (var i = 0; i < list.length; i++) {
        if (list[i].type === type && Geo.dist(S.pos, list[i]) < 60) {
          list.splice(i, 1); save('reports', S.reports); refreshMarkers();
          toast('Đã xóa báo cáo ' + TYPES[type].icon + ' ở đây'); return;
        }
      }
      S.reports.push({ type: type, lat: S.pos.lat, lon: S.pos.lon, ts: Date.now() });
      save('reports', S.reports); refreshMarkers();
      toast('Đã báo cáo ' + TYPES[type].icon + ' tại vị trí này');
    });
  });

  // ---------- Kiểu bản đồ ----------
  function markStyle() {
    Array.prototype.forEach.call(document.querySelectorAll('.sty'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-style') === S.style);
    });
  }
  markStyle();
  $('opt3d').checked = S.use3d;
  $('btnLayers').addEventListener('click', function () { openSheet('sheetLayers'); });
  Array.prototype.forEach.call(document.querySelectorAll('.sty'), function (b) {
    b.addEventListener('click', function () {
      S.style = b.getAttribute('data-style'); save('mapStyle', S.style);
      map.setStyle(S.style); markStyle();
    });
  });
  $('opt3d').addEventListener('change', function () { S.use3d = this.checked; save('use3d', S.use3d); updateView(); });

  // ---------- Cài đặt ----------
  function setOffset(v) {
    S.offset = Math.max(-15, Math.min(15, v)); save('speedOffset', S.offset);
    var txt = (S.offset > 0 ? '+' : '') + S.offset;
    $('offVal').textContent = txt + ' km/h'; $('offTag').textContent = txt;
    $('offTag').classList.toggle('hidden', S.offset === 0);
    showSpeed();
  }
  setOffset(S.offset);
  $('optBeep').checked = S.beep;
  $('btnSet').addEventListener('click', function () { openSheet('sheetSet'); });
  $('speedBox').addEventListener('click', function () { openSheet('sheetSet'); });
  $('offPlus').addEventListener('click', function () { setOffset(S.offset + 1); });
  $('offMinus').addEventListener('click', function () { setOffset(S.offset - 1); });
  $('offReset').addEventListener('click', function () { setOffset(0); });
  $('optBeep').addEventListener('change', function () { S.beep = this.checked; save('beepOn', S.beep); if (S.beep) beep(1); });

  // ---------- Tìm kiếm ----------
  var recents = load('recent', []), seq = 0;
  function norm(s) { return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd'); }
  function renderList(list, head, icon, clearable) {
    var box = $('results'); box.innerHTML = '';
    if (head) {
      var h = document.createElement('div'); h.className = 'head'; h.textContent = head;
      if (clearable) {
        var a = document.createElement('a'); a.textContent = 'Xóa lịch sử';
        a.addEventListener('click', function () { recents = []; save('recent', recents); box.innerHTML = ''; });
        h.appendChild(a);
      }
      box.appendChild(h);
    }
    list.forEach(function (r) {
      var el = document.createElement('div'); el.className = 'r';
      el.innerHTML = '<span class="ic"></span><span class="tx"><b></b><small></small></span><span class="km"></span>';
      el.querySelector('.ic').textContent = r.recent ? '🕘' : (icon || '📍');
      el.querySelector('b').textContent = r.name;
      el.querySelector('small').textContent = r.addr || '';
      el.querySelector('.km').textContent = S.pos ? fmtDist(Geo.dist(S.pos, r)) : '';
      el.addEventListener('click', function () { pick(r); });
      box.appendChild(el);
    });
  }
  function message(txt) {
    $('results').innerHTML = '<div class="r"><span class="tx"></span></div>';
    $('results').querySelector('.tx').textContent = txt;
  }
  function pick(r) {
    $('results').innerHTML = ''; $('q').value = r.name; $('q').blur(); syncClear();
    recents = recents.filter(function (x) { return !(x.name === r.name && Math.abs(x.lat - r.lat) < 1e-4); });
    recents.unshift({ lat: r.lat, lon: r.lon, name: r.name, addr: r.addr || '' });
    recents = recents.slice(0, 8); save('recent', recents);
    goTo(r);
  }
  function recentMatches(q) {
    var n = norm(q);
    return recents.filter(function (r) { return !n || norm(r.name + ' ' + r.addr).indexOf(n) >= 0; })
      .map(function (r) { return { lat: r.lat, lon: r.lon, name: r.name, addr: r.addr, recent: true }; });
  }
  function showRecents() { var l = recentMatches(''); if (l.length) renderList(l, 'Tìm gần đây', null, true); else $('results').innerHTML = ''; }
  function doSearch() {
    var q = $('q').value.trim();
    if (!q) return;
    $('q').blur();
    var my = ++seq;
    message('Đang tìm…');
    // Chưa có GPS thì lấy tâm bản đồ đang xem để ưu tiên khu vực
    var near = S.pos || (S.panned ? map.center : null);
    Data.search(q, near).then(function (list) {
      if (my !== seq) return;
      var all = recentMatches(q).slice(0, 2).concat(list);
      if (!all.length) { message('Không tìm thấy. Thử thêm tên phường/quận, hoặc dán tọa độ từ Google Maps.'); return; }
      renderList(all, S.pos ? 'Gần bạn nhất ở trên' : 'Chưa có GPS: kết quả trên toàn quốc');
    }).catch(function (e) {
      if (my !== seq) return;
      if (e && e.message === 'shortlink') {
        message('Link rút gọn chưa đọc được. Trong Google Maps, nhấn giữ vào điểm đến, chép dãy tọa độ (vd: 21.0285, 105.8542) rồi dán vào đây.');
      } else message('Lỗi mạng, thử lại.');
    });
  }
  function syncClear() { $('qClear').classList.toggle('hidden', !$('q').value); }
  $('q').addEventListener('keydown', function (e) { if (e.keyCode === 13) doSearch(); });
  $('q').addEventListener('input', function () {
    syncClear();
    var q = $('q').value.trim();
    if (!q) { seq++; showRecents(); return; }
    var local = recentMatches(q).slice(0, 4);
    if (local.length) renderList(local); else message('Bấm "Tìm" trên bàn phím để tìm "' + q + '"');
  });
  $('q').addEventListener('focus', function () { closeSheets(); if (!$('q').value.trim()) showRecents(); });
  $('qClear').addEventListener('click', function () { $('q').value = ''; syncClear(); seq++; $('q').focus(); showRecents(); });
  $('map').addEventListener('touchstart', function () { $('results').innerHTML = ''; $('q').blur(); closeSheets(); });

  Array.prototype.forEach.call(document.querySelectorAll('.chip'), function (b) {
    b.addEventListener('click', function () {
      if (!S.pos) { toast('Chưa có vị trí GPS'); return; }
      var cat = b.getAttribute('data-cat'), label = b.textContent, icon = label.split(' ')[0];
      var my = ++seq;
      $('q').blur();
      message('Đang tìm quanh đây…');
      Data.nearby(cat, S.pos).then(function (list) {
        if (my !== seq) return;
        if (!list.length) { message('Không thấy trong bán kính 3 km.'); return; }
        renderList(list, label + ' gần bạn', icon);
      }).catch(function () { if (my === seq) message('Lỗi mạng, thử lại.'); });
    });
  });

  map.onLongPress = function (lat, lon) {
    if (confirm('Đi đến điểm này?')) goTo({ lat: lat, lon: lon, name: 'Điểm đã chọn' });
  };
  map.onPan = function () {
    S.follow = false; S.panned = true; S.threeD = false; map.setNav(false);
    $('btnCenter').classList.add('off');
  };

  // ---------- Dẫn đường ----------
  function goTo(dest) {
    if (!S.pos) { toast('Chưa có vị trí GPS, chờ một chút'); return; }
    S.dest = dest; map.dest = dest;
    toast('Đang tìm đường…', 10000);
    buildRoute(true);
  }
  function buildRoute(preview) {
    S.lastReroute = Date.now();
    Data.route(S.pos, S.dest, S.speed > 1.5 ? S.heading : null).then(function (nav) {
      S.nav = nav; S.hint = 0; S.offCount = 0;
      S.cum = [0];
      for (var i = 1; i < nav.line.length; i++) S.cum[i] = S.cum[i - 1] + Geo.dist(nav.line[i - 1], nav.line[i]);
      map.route = nav.line;
      $('turn').classList.remove('hidden');
      $('searchRow').classList.add('hidden'); $('chips').classList.add('hidden');
      $('btnStop').classList.remove('hidden'); $('btnSet').classList.add('hidden');
      $('toast').classList.add('hidden');
      if (preview) {
        toast('Tuyến đường cho ' + nav.src, 2500);
        S.follow = false; map.setNav(false); map.fitBounds(nav.line);
        setTimeout(function () { S.follow = true; map.z = Math.max(map.z, 16); $('btnCenter').classList.remove('off'); updateView(); }, 3000);
      }
      updateNav();
    }).catch(function () { toast('Không tìm được đường. Kiểm tra mạng rồi thử lại.', 3500); });
  }
  function stopNav() {
    S.nav = null; S.dest = null; map.route = null; map.dest = null; map.render();
    $('turn').classList.add('hidden');
    $('searchRow').classList.remove('hidden'); $('chips').classList.remove('hidden');
    $('btnStop').classList.add('hidden'); $('btnSet').classList.remove('hidden');
    $('eta').textContent = '--:--'; $('remain').textContent = 'Chạm ô tìm kiếm để chọn nơi đến';
    updateView();
  }
  $('btnStop').addEventListener('click', stopNav);

  function updateNav() {
    var nav = S.nav, line = nav.line;
    var n = Geo.nearestOnLine(S.pos, line, S.hint);
    S.hint = n.i;
    if (n.d > 50) {
      S.offCount++;
      if (S.offCount >= 3 && Date.now() - S.lastReroute > 10000) { toast('Đang tìm đường mới…'); buildRoute(false); return; }
    } else S.offCount = 0;

    var done = S.cum[n.i] + (S.cum[n.i + 1] - S.cum[n.i]) * n.t;
    var total = S.cum[S.cum.length - 1], remain = Math.max(0, total - done);
    if (Geo.dist(S.pos, S.dest) < 30) { beep(1, 660); toast('Đã đến nơi!', 3000); stopNav(); return; }

    var next = null;
    for (var i = 1; i < nav.steps.length; i++) {
      if (nav.steps[i].idx > n.i || (nav.steps[i].idx === n.i && n.t < 0.9)) { next = nav.steps[i]; break; }
    }
    if (!next) next = nav.steps[nav.steps.length - 1];
    var dNext = S.cum[next.idx] - done;
    if (dNext < 0) dNext = Geo.dist(S.pos, next);
    $('turnIcon').textContent = next.icon;
    $('turnDist').textContent = fmtDist(dNext);
    $('turnName').textContent = next.text;
    var secs = nav.duration * (remain / total);
    $('eta').textContent = fmtTime(new Date(Date.now() + secs * 1000));
    $('remain').textContent = Math.max(1, Math.round(secs / 60)) + ' phút · ' + fmtDist(remain);
  }

  // ---------- Nút khác ----------
  $('btnCenter').addEventListener('click', function () {
    S.follow = true; $('btnCenter').classList.remove('off');
    if (S.pos) { map.setView(S.pos.lat, S.pos.lon, Math.max(map.z, 16)); updateView(); }
  });
  $('zIn').addEventListener('click', function () { map.zoomBy(1); });
  $('zOut').addEventListener('click', function () { map.zoomBy(-1); });
})();
