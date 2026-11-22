/* Điều khiển chính: GPS, tốc độ, giới hạn, camera, dẫn đường. */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  var map = new TileMap($('map'));

  var S = {
    pos: null, prev: null, heading: null, speed: 0,
    follow: true, beep: true,
    nav: null, cum: null, hint: 0, offCount: 0, lastReroute: 0, dest: null,
    limit: null, limitAt: null, limitTime: 0, limitBusy: false,
    osmCams: [], userCams: [], camAt: null, camBusy: false, camWarned: {},
    lastOverBeep: 0
  };

  try { S.userCams = JSON.parse(localStorage.getItem('userCams') || '[]'); } catch (e) { S.userCams = []; }
  try { S.beep = localStorage.getItem('beep') !== 'off'; } catch (e) {}
  setBeepLabel();

  // ---------- Hiệu chỉnh chênh lệch tốc độ (−15 đến +15 km/h) ----------
  S.offset = 0;
  try { S.offset = parseInt(localStorage.getItem('speedOffset') || '0', 10) || 0; } catch (e) {}
  function setOffset(v) {
    S.offset = Math.max(-15, Math.min(15, v));
    try { localStorage.setItem('speedOffset', String(S.offset)); } catch (e) {}
    var txt = (S.offset > 0 ? '+' : '') + S.offset;
    $('offVal').textContent = txt + ' km/h';
    $('offTag').textContent = txt;
    $('offTag').classList.toggle('hidden', S.offset === 0);
    showSpeed();
  }
  $('speedBox').addEventListener('click', function () { $('calib').classList.toggle('hidden'); });
  $('offPlus').addEventListener('click', function () { setOffset(S.offset + 1); });
  $('offMinus').addEventListener('click', function () { setOffset(S.offset - 1); });
  $('offReset').addEventListener('click', function () { setOffset(0); });
  $('offClose').addEventListener('click', function () { $('calib').classList.add('hidden'); });
  setOffset(S.offset);

  // ---------- Khóa API Vietmap (chỉ lưu trong máy, không nằm trong mã nguồn) ----------
  var savedKey = '';
  try { savedKey = localStorage.getItem('vmKey') || ''; } catch (e) {}
  Data.setKey(savedKey);
  $('vmKey').value = savedKey;
  function showKeyStatus() {
    $('vmStatus').textContent = Data.hasKey() ? 'Đang dùng: Vietmap (tìm đường xe máy)' : 'Đang dùng: OpenStreetMap';
  }
  showKeyStatus();
  $('btnSet').addEventListener('click', function () { $('settings').classList.toggle('hidden'); });
  $('setSave').addEventListener('click', function () {
    var k = $('vmKey').value.trim();
    try { localStorage.setItem('vmKey', k); } catch (e) {}
    Data.setKey(k); showKeyStatus(); $('vmKey').blur();
    $('settings').classList.add('hidden');
    toast(k ? 'Đã lưu khóa Vietmap' : 'Đã chuyển về OpenStreetMap');
  });
  $('setClear').addEventListener('click', function () { $('vmKey').value = ''; });

  // ---------- Âm báo (iOS chỉ cho phát sau khi người dùng chạm) ----------
  var audio = null;
  function unlockAudio() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audio = new AC();
    var o = audio.createOscillator(), g = audio.createGain();
    g.gain.value = 0; o.connect(g); g.connect(audio.destination);
    o.start(0); o.stop(audio.currentTime + 0.05);
  }
  function beep(times, freq) {
    if (!S.beep || !audio) return;
    if (audio.state === 'suspended') audio.resume();
    for (var i = 0; i < times; i++) {
      var t = audio.currentTime + i * 0.22;
      var o = audio.createOscillator(), g = audio.createGain();
      o.type = 'square'; o.frequency.value = freq || 1150;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.35, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      o.connect(g); g.connect(audio.destination);
      o.start(t); o.stop(t + 0.18);
    }
  }

  var toastTimer;
  function toast(msg, ms) {
    var el = $('toast');
    el.textContent = msg; el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add('hidden'); }, ms || 2200);
  }
  function fmtDist(m) {
    if (m < 1000) return (m < 100 ? Math.round(m / 10) * 10 : Math.round(m / 50) * 50) + ' m';
    return (m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',') + ' km';
  }
  function fmtTime(d) {
    var h = d.getHours(), m = d.getMinutes();
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  // ---------- Bắt đầu ----------
  $('btnStart').addEventListener('click', function () {
    unlockAudio();
    $('start').classList.add('hidden');
    if (!navigator.geolocation) { toast('Máy không hỗ trợ GPS'); return; }
    navigator.geolocation.watchPosition(onPos, function (err) {
      if (err.code === 1) toast('Chưa cho phép vị trí. Vào Cài đặt › Safari › Vị trí › Cho phép.', 5000);
      else toast('Đang chờ tín hiệu GPS…');
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  });

  // ---------- Mỗi lần GPS cập nhật ----------
  function onPos(p) {
    var c = p.coords, now = p.timestamp || Date.now();
    var pos = { lat: c.latitude, lon: c.longitude, t: now, acc: c.accuracy };

    // Tốc độ: ưu tiên số đo của GPS, nếu không có thì tự tính
    var v = (c.speed != null && c.speed >= 0) ? c.speed : null;
    if (v == null && S.prev) {
      var dt = (now - S.prev.t) / 1000;
      if (dt > 0.5) v = Geo.dist(S.prev, pos) / dt;
    }
    if (v != null) S.speed = S.speed * 0.35 + v * 0.65;

    // Hướng đi
    if (c.heading != null && !isNaN(c.heading) && c.heading >= 0 && S.speed > 1.5) S.heading = c.heading;
    else if (S.prev && Geo.dist(S.prev, pos) > 6) S.heading = Geo.bearing(S.prev, pos);

    if (!S.prev || Geo.dist(S.prev, pos) > 3 || now - S.prev.t > 3000) S.prev = pos;
    var first = !S.pos;
    S.pos = pos;

    map.user = { lat: pos.lat, lon: pos.lon, heading: S.speed > 1 ? S.heading : null };
    if (S.follow) map.setView(pos.lat, pos.lon, first ? 17 : null); else map.render();

    showSpeed();
    checkLimit();
    checkCameras();
    if (S.nav) updateNav();
  }

  // ---------- Tốc độ & giới hạn ----------
  function showSpeed() {
    var kmh = S.speed * 3.6;
    // Số hiển thị = tốc độ GPS + mức chênh lệch người dùng chỉnh
    var shown = kmh < 2 ? 0 : Math.max(0, Math.round(kmh + S.offset));
    $('speed').textContent = shown;
    $('rawSpeed').textContent = kmh < 2 ? '0' : Math.round(kmh);
    var over = S.limit && kmh > S.limit.limit + 3;
    $('dash').classList.toggle('over', !!over);
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
    }).catch(function () {
      S.limitTime = Date.now() - 15000; // thử lại sau ~10 giây
    }).then(function () { S.limitBusy = false; });
  }

  // ---------- Camera ----------
  function allCams() { return S.osmCams.concat(S.userCams); }
  function refreshCamLayer() { map.cameras = allCams(); map.render(); }
  refreshCamLayer();

  function checkCameras() {
    if (!S.pos) return;
    if (!S.camBusy && (!S.camAt || Geo.dist(S.camAt, S.pos) > 3000)) {
      S.camBusy = true;
      var at = { lat: S.pos.lat, lon: S.pos.lon };
      Data.cameras(at, 8000).then(function (list) {
        S.osmCams = list; S.camAt = at; refreshCamLayer();
      }).catch(function () {}).then(function () { S.camBusy = false; });
    }

    // Tìm camera gần nhất ở phía trước.
    // Khoảng cách cảnh báo tăng theo tốc độ để luôn có ~20 giây phản ứng (tối thiểu 400 m).
    var kmh = S.speed * 3.6;
    var warnFar = Math.max(400, Math.round(kmh / 3.6 * 20));
    var warnNear = Math.max(150, Math.round(kmh / 3.6 * 8));
    var best = null, cams = allCams();
    for (var i = 0; i < cams.length; i++) {
      var d = Geo.dist(S.pos, cams[i]);
      if (d > warnFar + 200) continue;
      var ahead = S.heading == null || S.speed < 1.5 ||
        Geo.angleDiff(Geo.bearing(S.pos, cams[i]), S.heading) < 50 || d < 40;
      if (ahead && (!best || d < best.d)) best = { d: d, cam: cams[i], key: cams[i].lat.toFixed(5) + ',' + cams[i].lon.toFixed(5) };
    }
    var box = $('camAlert');
    if (!best) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    $('camDist').textContent = fmtDist(best.d) + (best.cam.limit ? ' · ' + best.cam.limit : '');
    var w = S.camWarned[best.key] || 0;
    if (best.d < warnFar && w < 1) { beep(2, 1150); S.camWarned[best.key] = 1; }
    if (best.d < warnNear && w < 2) { beep(3, 1400); S.camWarned[best.key] = 2; }
    // Camera có ghi giới hạn mà đang chạy nhanh hơn: bíp nhắc giảm tốc
    if (best.cam.limit && kmh > best.cam.limit && best.d < warnFar && Date.now() - S.lastOverBeep > 3000) {
      S.lastOverBeep = Date.now(); beep(2, 880);
    }
  }

  $('btnCam').addEventListener('click', function () {
    if (!S.pos) { toast('Chưa có vị trí GPS'); return; }
    for (var i = 0; i < S.userCams.length; i++) {
      if (Geo.dist(S.pos, S.userCams[i]) < 60) {
        S.userCams.splice(i, 1); saveCams(); toast('Đã xóa camera bạn đánh dấu ở đây'); return;
      }
    }
    S.userCams.push({ lat: S.pos.lat, lon: S.pos.lon, user: true });
    saveCams(); toast('Đã đánh dấu camera tại vị trí này');
  });
  function saveCams() {
    try { localStorage.setItem('userCams', JSON.stringify(S.userCams)); } catch (e) {}
    refreshCamLayer();
  }

  // ---------- Tìm kiếm ----------
  function doSearch() {
    var q = $('q').value.trim();
    if (!q) return;
    $('q').blur();
    $('results').innerHTML = '<div class="r">Đang tìm…</div>';
    Data.search(q, S.pos).then(function (list) {
      if (!list.length) { $('results').innerHTML = '<div class="r">Không tìm thấy. Thử gõ cụ thể hơn.</div>'; return; }
      $('results').innerHTML = '';
      list.forEach(function (r) {
        var el = document.createElement('div');
        el.className = 'r';
        el.innerHTML = '<b></b><small></small>';
        el.firstChild.textContent = r.name;
        el.lastChild.textContent = r.addr + (S.pos && r.lat != null ? ' · ' + fmtDist(Geo.dist(S.pos, r)) : '');
        el.addEventListener('click', function () {
          $('results').innerHTML = ''; $('q').value = r.name;
          Data.resolve(r).then(goTo).catch(function () { toast('Không lấy được tọa độ địa điểm này'); });
        });
        $('results').appendChild(el);
      });
    }).catch(function () { $('results').innerHTML = '<div class="r">Lỗi mạng, thử lại.</div>'; });
  }
  $('btnSearch').addEventListener('click', doSearch);
  $('q').addEventListener('keydown', function (e) { if (e.keyCode === 13) doSearch(); });
  $('q').addEventListener('input', function () { if (!$('q').value) $('results').innerHTML = ''; });

  map.onLongPress = function (lat, lon) {
    if (confirm('Đi đến điểm này?')) goTo({ lat: lat, lon: lon, name: 'Điểm đã chọn' });
  };
  map.onPan = function () { S.follow = false; $('btnCenter').classList.add('on'); };

  // ---------- Dẫn đường ----------
  function goTo(dest) {
    if (!S.pos) { toast('Chưa có vị trí GPS, chờ một chút'); return; }
    S.dest = dest; map.dest = dest;
    toast('Đang tìm đường…', 8000);
    buildRoute(true);
  }
  function buildRoute(fit) {
    S.lastReroute = Date.now();
    Data.route(S.pos, S.dest, S.speed > 1.5 ? S.heading : null).then(function (nav) {
      S.nav = nav; S.hint = 0; S.offCount = 0;
      S.cum = [0];
      for (var i = 1; i < nav.line.length; i++) S.cum[i] = S.cum[i - 1] + Geo.dist(nav.line[i - 1], nav.line[i]);
      map.route = nav.line;
      $('turn').classList.remove('hidden');
      $('searchRow').classList.add('hidden');
      $('btnStop').classList.remove('hidden');
      $('toast').classList.add('hidden');
      if (fit) toast('Tuyến đường: ' + nav.src, 2500);
      if (fit) {
        map.fitBounds(nav.line); S.follow = false; $('btnCenter').classList.add('on');
        setTimeout(function () { S.follow = true; $('btnCenter').classList.remove('on'); map.setView(S.pos.lat, S.pos.lon, 17); }, 3500);
      }
      updateNav();
    }).catch(function () { toast('Không tìm được đường. Kiểm tra mạng rồi thử lại.', 3500); });
  }
  function stopNav() {
    S.nav = null; S.dest = null; map.route = null; map.dest = null; map.render();
    $('turn').classList.add('hidden');
    $('searchRow').classList.remove('hidden');
    $('btnStop').classList.add('hidden');
    $('eta').textContent = '--:--'; $('remain').textContent = 'Chưa có tuyến';
  }
  $('btnStop').addEventListener('click', stopNav);

  function updateNav() {
    var nav = S.nav, line = nav.line;
    var n = Geo.nearestOnLine(S.pos, line, S.hint);
    S.hint = n.i;

    // Đi lệch tuyến quá 50 m trong 3 lần liên tiếp thì tìm đường lại
    if (n.d > 50) {
      S.offCount++;
      if (S.offCount >= 3 && Date.now() - S.lastReroute > 10000) { toast('Đang tìm đường mới…'); buildRoute(false); return; }
    } else S.offCount = 0;

    var done = S.cum[n.i] + (S.cum[n.i + 1] - S.cum[n.i]) * n.t;
    var total = S.cum[S.cum.length - 1];
    var remain = Math.max(0, total - done);

    if (Geo.dist(S.pos, S.dest) < 30) {
      beep(1, 660); toast('Đã đến nơi!', 3000); stopNav(); return;
    }

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
    $('remain').textContent = fmtDist(remain) + ' · ' + Math.max(1, Math.round(secs / 60)) + ' phút';
  }

  // ---------- Nút khác ----------
  $('btnCenter').addEventListener('click', function () {
    S.follow = true; $('btnCenter').classList.remove('on');
    if (S.pos) map.setView(S.pos.lat, S.pos.lon, Math.max(map.z, 16));
  });
  $('zIn').addEventListener('click', function () { map.zoomBy(1); });
  $('zOut').addEventListener('click', function () { map.zoomBy(-1); });
  $('btnBeep').addEventListener('click', function () {
    S.beep = !S.beep; setBeepLabel();
    try { localStorage.setItem('beep', S.beep ? 'on' : 'off'); } catch (e) {}
    if (S.beep) beep(1);
  });
  function setBeepLabel() { $('btnBeep').textContent = S.beep ? '🔔 Bíp: Bật' : '🔕 Bíp: Tắt'; }
})();
