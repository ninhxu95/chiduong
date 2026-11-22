/* Dữ liệu: tìm địa chỉ, tìm đường, giới hạn tốc độ, camera.
   Tất cả là dịch vụ miễn phí dựa trên OpenStreetMap. */
(function () {
  'use strict';

  var NOMINATIM = 'https://nominatim.openstreetmap.org/search';
  var OSRM = 'https://router.project-osrm.org/route/v1/driving/';
  var OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  var VM = 'https://maps.vietmap.vn/api/';
  var vmKey = '';
  function setKey(k) { vmKey = (k || '').trim(); }
  function hasKey() { return !!vmKey; }

  // ---------- Hình học ----------
  var R = 6371000;
  function rad(d) { return d * Math.PI / 180; }
  function dist(a, b) { // a,b: {lat,lon} hoặc [lat,lon]
    var la1 = a.lat != null ? a.lat : a[0], lo1 = a.lon != null ? a.lon : a[1];
    var la2 = b.lat != null ? b.lat : b[0], lo2 = b.lon != null ? b.lon : b[1];
    var dLa = rad(la2 - la1), dLo = rad(lo2 - lo1);
    var h = Math.sin(dLa / 2) * Math.sin(dLa / 2) +
      Math.cos(rad(la1)) * Math.cos(rad(la2)) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function bearing(a, b) {
    var la1 = rad(a.lat), la2 = rad(b.lat), dLo = rad(b.lon - a.lon);
    var y = Math.sin(dLo) * Math.cos(la2);
    var x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLo);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  function angleDiff(a, b) { var d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }

  // Khoảng cách từ điểm p tới đoạn a-b (mét), dùng phép chiếu phẳng cục bộ
  function segDist(p, a, b) {
    var k = Math.cos(rad(p.lat)) * 111320, m = 110540;
    var ax = (a[1] - p.lon) * k, ay = (a[0] - p.lat) * m;
    var bx = (b[1] - p.lon) * k, by = (b[0] - p.lat) * m;
    var dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    var t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
    var x = ax + t * dx, y = ay + t * dy;
    return { d: Math.sqrt(x * x + y * y), t: t };
  }
  // Điểm gần nhất trên tuyến, tìm quanh vị trí cũ để nhanh hơn
  function nearestOnLine(p, line, hint) {
    var best = { d: Infinity, i: 0, t: 0 };
    var from = hint ? Math.max(0, hint - 30) : 0;
    var to = hint ? Math.min(line.length - 1, hint + 200) : line.length - 1;
    for (var i = from; i < to; i++) {
      var s = segDist(p, line[i], line[i + 1]);
      if (s.d < best.d) best = { d: s.d, i: i, t: s.t };
    }
    if (hint && best.d > 80) return nearestOnLine(p, line, 0);
    return best;
  }

  function fetchJSON(url, opts) {
    return fetch(url, opts).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }
  function overpass(q) {
    var body = 'data=' + encodeURIComponent(q);
    var opts = { method: 'POST', body: body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } };
    return fetchJSON(OVERPASS[0], opts).catch(function () { return fetchJSON(OVERPASS[1], opts); });
  }

  // ---------- Tìm địa chỉ ----------
  // Có khóa Vietmap thì dùng Vietmap (địa chỉ Việt Nam đầy đủ hơn, hiểu cả địa chỉ cũ và mới),
  // lỗi hoặc không có khóa thì dùng OpenStreetMap.
  function search(q, near) {
    if (!vmKey) return searchOSM(q, near);
    var url = VM + 'autocomplete/v4?apikey=' + encodeURIComponent(vmKey) + '&display_type=1&text=' + encodeURIComponent(q);
    if (near) url += '&focus=' + near.lat + ',' + near.lon;
    return fetchJSON(url).then(function (list) {
      return (list || []).map(function (r) {
        return { ref: r.ref_id, name: r.name || r.display, addr: r.address || '', src: 'vm' };
      });
    }).catch(function () { return searchOSM(q, near); });
  }
  // Kết quả Vietmap chưa có tọa độ, phải hỏi thêm theo ref_id
  function resolve(r) {
    if (r.lat != null) return Promise.resolve(r);
    return fetchJSON(VM + 'place/v4?apikey=' + encodeURIComponent(vmKey) + '&refid=' + encodeURIComponent(r.ref))
      .then(function (p) { return { lat: p.lat, lon: p.lng, name: r.name }; });
  }
  function searchOSM(q, near) {
    var url = NOMINATIM + '?format=jsonv2&limit=6&countrycodes=vn&accept-language=vi&q=' + encodeURIComponent(q);
    if (near) {
      var d = 0.4; // ưu tiên kết quả gần vị trí hiện tại
      url += '&viewbox=' + (near.lon - d) + ',' + (near.lat + d) + ',' + (near.lon + d) + ',' + (near.lat - d);
    }
    return fetchJSON(url).then(function (list) {
      return list.map(function (r) {
        var parts = r.display_name.split(', ');
        return { lat: +r.lat, lon: +r.lon, name: r.name || parts[0], addr: parts.slice(1, 4).join(', ') };
      });
    });
  }

  // ---------- Tìm đường ----------
  var MOD_ICON = {
    'uturn': '⤺', 'sharp right': '↘', 'right': '→', 'slight right': '↗',
    'straight': '↑', 'slight left': '↖', 'left': '←', 'sharp left': '↙'
  };
  var MOD_TEXT = {
    'uturn': 'Quay đầu', 'sharp right': 'Rẽ gắt phải', 'right': 'Rẽ phải', 'slight right': 'Chếch phải',
    'straight': 'Đi thẳng', 'slight left': 'Chếch trái', 'left': 'Rẽ trái', 'sharp left': 'Rẽ gắt trái'
  };
  function stepText(s) {
    var m = s.maneuver, mod = m.modifier || 'straight', road = s.name || s.ref || '';
    var t;
    switch (m.type) {
      case 'depart': t = 'Xuất phát'; break;
      case 'arrive': return { icon: '⚑', text: 'Đến nơi' };
      case 'roundabout': case 'rotary':
        t = 'Vào vòng xoay' + (m.exit ? ', ra lối thứ ' + m.exit : ''); return { icon: '⟳', text: t + (road ? ' → ' + road : '') };
      case 'exit roundabout': case 'exit rotary': t = 'Ra khỏi vòng xoay'; break;
      case 'fork': t = mod.indexOf('left') >= 0 ? 'Đi nhánh trái' : 'Đi nhánh phải'; break;
      case 'merge': t = 'Nhập làn'; break;
      case 'on ramp': t = 'Lên cầu/đường dẫn'; break;
      case 'off ramp': t = 'Xuống đường dẫn'; break;
      case 'end of road': t = MOD_TEXT[mod] + ' ở cuối đường'; break;
      case 'continue': case 'new name': t = mod === 'straight' ? 'Đi tiếp' : MOD_TEXT[mod]; break;
      default: t = MOD_TEXT[mod] || 'Đi tiếp';
    }
    return { icon: MOD_ICON[mod] || '↑', text: t + (road ? ' vào ' + road : '') };
  }

  function route(from, to, heading) {
    if (!vmKey) return routeOSRM(from, to);
    return routeVM(from, to, heading).catch(function () { return routeOSRM(from, to); });
  }

  // Mã hướng rẽ của Vietmap (theo chuẩn GraphHopper mà Vietmap dùng)
  var VM_SIGN = {
    '-98': ['⤺', 'Quay đầu'], '-8': ['⤺', 'Quay đầu'], '8': ['⤻', 'Quay đầu'],
    '-7': ['↖', 'Giữ làn trái'], '7': ['↗', 'Giữ làn phải'],
    '-3': ['↙', 'Rẽ gắt trái'], '-2': ['←', 'Rẽ trái'], '-1': ['↖', 'Chếch trái'],
    '0': ['↑', 'Đi tiếp'], '1': ['↗', 'Chếch phải'], '2': ['→', 'Rẽ phải'], '3': ['↘', 'Rẽ gắt phải'],
    '4': ['⚑', 'Đến nơi'], '5': ['•', 'Qua điểm dừng'],
    '6': ['⟳', 'Vào vòng xoay'], '-6': ['⟳', 'Ra khỏi vòng xoay']
  };
  function routeVM(from, to, heading) {
    var url = VM + 'route/v4?apikey=' + encodeURIComponent(vmKey) +
      '&point=' + from.lat + ',' + from.lon + '&point=' + to.lat + ',' + to.lon +
      '&vehicle=motorcycle&points_encoded=false' +
      (heading != null ? '&heading=' + Math.round(heading) : '');
    return fetchJSON(url).then(function (j) {
      if (j.code !== 'OK' || !j.paths || !j.paths.length) throw new Error(j.code || 'Không có tuyến');
      var p = j.paths[0];
      // Tài liệu ghi lẫn [lat,lng] và [lng,lat], nên tự nhận biết: ở Việt Nam vĩ độ < 25, kinh độ > 100
      var flip = p.points.coordinates ? true : null;
      var raw = p.points.coordinates || p.points;
      if (flip === null) flip = raw.length && raw[0][0] > 90;
      var line = raw.map(function (c) { return flip ? [c[1], c[0]] : [c[0], c[1]]; });
      var steps = p.instructions.map(function (s, i) {
        var sg = VM_SIGN[String(s.sign)] || ['↑', 'Đi tiếp'];
        var road = s.street_name || s.text || '';
        var idx = Math.min(s.interval ? s.interval[0] : 0, line.length - 1);
        var text = i === 0 ? 'Xuất phát' : sg[1];
        if (road && s.sign !== 4) text += ' vào ' + road;
        return { lat: line[idx][0], lon: line[idx][1], idx: idx, icon: i === 0 ? '↑' : sg[0], text: text };
      });
      return { line: line, steps: steps, distance: p.distance, duration: p.time / 1000, src: 'Vietmap · xe máy' };
    });
  }

  function routeOSRM(from, to) {
    var url = OSRM + from.lon + ',' + from.lat + ';' + to.lon + ',' + to.lat +
      '?overview=full&geometries=geojson&steps=true';
    return fetchJSON(url).then(function (j) {
      if (!j.routes || !j.routes.length) throw new Error('Không tìm được đường');
      var r = j.routes[0];
      var line = r.geometry.coordinates.map(function (c) { return [c[1], c[0]]; });
      var steps = [];
      r.legs[0].steps.forEach(function (s) {
        var tx = stepText(s), loc = s.maneuver.location;
        steps.push({ lat: loc[1], lon: loc[0], icon: tx.icon, text: tx.text, type: s.maneuver.type });
      });
      // Gắn mỗi bước với vị trí trên tuyến để biết bước nào sắp tới
      var hint = 0;
      steps.forEach(function (s) {
        var n = nearestOnLine({ lat: s.lat, lon: s.lon }, line, 0);
        s.idx = Math.max(n.i, hint); hint = s.idx;
      });
      return { line: line, steps: steps, distance: r.distance, duration: r.duration, src: 'OSM' };
    });
  }

  // ---------- Giới hạn tốc độ ----------
  // Ước tính theo Thông tư 38/2024/TT-BGTVT cho xe mô tô khi OSM không có dữ liệu:
  // trong khu dân cư, đường đôi/một chiều ≥2 làn: 60; đường hai chiều/một chiều 1 làn: 50.
  function parseSpeed(v) {
    if (!v) return null;
    var n = parseInt(v, 10);
    if (isNaN(n)) return null;
    return /mph/.test(v) ? Math.round(n * 1.609) : n;
  }
  function estimate(tags) {
    var lanes = parseInt(tags.lanes || '0', 10);
    var divided = tags.oneway === 'yes' && (lanes >= 2 || /trunk|primary/.test(tags.highway));
    if (tags.dual_carriageway === 'yes') divided = true;
    return divided ? 60 : 50;
  }
  var SKIP = /footway|path|cycleway|steps|pedestrian|service|track|construction|proposed|platform/;

  function speedLimit(p, heading) {
    var q = '[out:json][timeout:8];way(around:30,' + p.lat + ',' + p.lon + ')[highway];out tags geom;';
    return overpass(q).then(function (j) {
      var best = null;
      (j.elements || []).forEach(function (w) {
        if (!w.geometry || SKIP.test(w.tags.highway)) return;
        var g = w.geometry.map(function (n) { return [n.lat, n.lon]; });
        for (var i = 0; i < g.length - 1; i++) {
          var d = segDist(p, g[i], g[i + 1]).d;
          // Ưu tiên đoạn đường cùng hướng đang đi
          if (heading != null) {
            var b = bearing({ lat: g[i][0], lon: g[i][1] }, { lat: g[i + 1][0], lon: g[i + 1][1] });
            var ad = Math.min(angleDiff(b, heading), angleDiff((b + 180) % 360, heading));
            d += ad / 6;
          }
          if (!best || d < best.d) best = { d: d, tags: w.tags };
        }
      });
      if (!best) return null;
      var t = best.tags;
      var v = parseSpeed(t['maxspeed:motorcycle']) || parseSpeed(t.maxspeed);
      return { limit: v || estimate(t), exact: !!v, road: t.name || t.ref || '' };
    });
  }

  // ---------- Camera bắn tốc độ ----------
  function cameras(p, radius) {
    var q = '[out:json][timeout:15];(node[highway=speed_camera](around:' + radius + ',' + p.lat + ',' + p.lon + ');' +
      'node["enforcement"="maxspeed"](around:' + radius + ',' + p.lat + ',' + p.lon + '););out;';
    return overpass(q).then(function (j) {
      return (j.elements || []).map(function (n) {
        return { lat: n.lat, lon: n.lon, limit: parseSpeed(n.tags && n.tags.maxspeed), user: false };
      });
    });
  }

  window.Geo = { dist: dist, bearing: bearing, angleDiff: angleDiff, nearestOnLine: nearestOnLine };
  window.Data = { search: search, resolve: resolve, route: route, speedLimit: speedLimit, cameras: cameras, setKey: setKey, hasKey: hasKey };
})();
