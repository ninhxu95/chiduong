/* Dữ liệu: tìm địa chỉ, tìm đường xe máy, giới hạn tốc độ, camera, địa điểm quanh đây.
   Tất cả là dịch vụ miễn phí dựa trên OpenStreetMap, không cần khóa API. */
(function () {
  'use strict';

  var NOMINATIM = 'https://nominatim.openstreetmap.org/search';
  var VALHALLA = 'https://valhalla1.openstreetmap.de/route';
  var OSRM = 'https://router.project-osrm.org/route/v1/driving/';
  var OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

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

  // Khoảng cách từ điểm p tới đoạn a-b (mét), phép chiếu phẳng cục bộ
  function segDist(p, a, b) {
    var k = Math.cos(rad(p.lat)) * 111320, m = 110540;
    var ax = (a[1] - p.lon) * k, ay = (a[0] - p.lat) * m;
    var bx = (b[1] - p.lon) * k, by = (b[0] - p.lat) * m;
    var dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    var t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
    var x = ax + t * dx, y = ay + t * dy;
    return { d: Math.sqrt(x * x + y * y), t: t };
  }
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
    var opts = { method: 'POST', body: 'data=' + encodeURIComponent(q),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } };
    return fetchJSON(OVERPASS[0], opts).catch(function () { return fetchJSON(OVERPASS[1], opts); });
  }

  // ---------- Tìm địa chỉ ----------
  // Hai nguồn chạy song song (Nominatim + Photon), ưu tiên trong ~60 km quanh vị trí,
  // gộp kết quả trùng và xếp theo khoảng cách. Nhận cả tọa độ và link Google Maps dạng đầy đủ.
  var PHOTON = 'https://photon.komoot.io/api/';
  var VN_BOX = '102.1,8.2,109.6,23.4';

  function parseCoords(q) {
    var m = q.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) ||          // link Google Maps có ghim
      q.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) ||                    // link Google Maps có @lat,lon
      q.match(/[?&](?:q|ll|query|destination)=(-?\d+\.\d+)(?:,|%2C)\s*(-?\d+\.\d+)/) ||
      q.match(/^\s*(-?\d{1,2}\.\d+)\s*[,; ]\s*(-?\d{2,3}\.\d+)\s*$/); // "21.0285, 105.8542"
    if (!m) return null;
    var lat = +m[1], lon = +m[2];
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return { lat: lat, lon: lon, name: 'Tọa độ ' + lat.toFixed(5) + ', ' + lon.toFixed(5), addr: 'Điểm đã dán' };
  }

  // Lấy tên địa điểm từ link Google Maps dạng dài: /maps/place/Tên/... hoặc ?q=Tên / ?query=Tên
  function nameFromLink(q) {
    var m = q.match(/\/maps\/place\/([^\/@?]+)/) || q.match(/[?&](?:q|query|destination)=([^&#]+)/);
    if (!m) return '';
    try { return decodeURIComponent(m[1].replace(/\+/g, ' ')).trim(); } catch (e) { return ''; }
  }

  function search(q, near) {
    var c = parseCoords(q);
    if (c) return Promise.resolve([c]);
    if (/https?:\/\/|goo\.gl|maps\.app/.test(q)) {
      // Link dài có tên địa điểm thì tìm theo tên
      var nm = nameFromLink(q);
      if (nm) return search(nm, near);
      // Đoạn chia sẻ từ app Google Maps thường có tên + địa chỉ + link rút gọn: bỏ link, tìm theo phần chữ
      var text = q.replace(/https?:\/\/\S+/g, ' ').replace(/\S*(goo\.gl|maps\.app)\S*/g, ' ').replace(/\s+/g, ' ').trim();
      if (text.length >= 3) return search(text, near);
      return Promise.reject(new Error('shortlink'));
    }

    var tasks = [
      searchNominatim(q, near, true).then(function (l) { return l.length || !near ? l : searchNominatim(q, near, false); }),
      searchPhoton(q, near)
    ].map(function (p) { return p.catch(function () { return []; }); });

    return Promise.all(tasks).then(function (res) {
      var all = res[0].concat(res[1]), out = [];
      all.forEach(function (r) {
        for (var i = 0; i < out.length; i++) if (dist(out[i], r) < 80) return; // bỏ kết quả trùng
        out.push(r);
      });
      if (near) out.sort(function (a, b) { return dist(near, a) - dist(near, b); });
      return out.slice(0, 10);
    });
  }

  function searchNominatim(q, near, bounded) {
    var url = NOMINATIM + '?format=jsonv2&limit=8&countrycodes=vn&accept-language=vi&q=' + encodeURIComponent(q);
    if (near && bounded) {
      var d = 0.55; // khoảng 60 km
      url += '&bounded=1&viewbox=' + (near.lon - d) + ',' + (near.lat + d) + ',' + (near.lon + d) + ',' + (near.lat - d);
    }
    return fetchJSON(url).then(function (list) {
      return list.map(function (r) {
        var parts = r.display_name.split(', ');
        return { lat: +r.lat, lon: +r.lon, name: r.name || parts[0], addr: parts.slice(1, 4).join(', ') };
      });
    });
  }

  function searchPhoton(q, near) {
    var url = PHOTON + '?limit=8&q=' + encodeURIComponent(q) + '&bbox=' + VN_BOX;
    if (near) url += '&lat=' + near.lat + '&lon=' + near.lon + '&location_bias_scale=0.1&zoom=12';
    return fetchJSON(url).then(function (j) {
      return (j.features || []).map(function (f) {
        var p = f.properties || {}, g = f.geometry.coordinates;
        var street = [p.housenumber, p.street].filter(Boolean).join(' ');
        var name = p.name || street || p.district || p.city || '';
        var addr = [p.name ? street : '', p.district, p.city || p.county, p.state]
          .filter(function (x, i, a) { return x && a.indexOf(x) === i && x !== name; }).join(', ');
        return { lat: g[1], lon: g[0], name: name, addr: addr };
      }).filter(function (r) { return r.name; });
    });
  }

  // ---------- Tìm nhanh quanh đây ----------
  var CATS = {
    fuel: ['nwr[amenity=fuel]'],
    repair: ['nwr[shop~"motorcycle"]', 'nwr[craft~"motorcycle"]'],
    atm: ['nwr[amenity=atm]', 'nwr[amenity=bank]'],
    cafe: ['nwr[amenity=cafe]'],
    food: ['nwr[amenity~"^(restaurant|fast_food)$"]'],
    parking: ['nwr[amenity~"^(motorcycle_parking|parking)$"]'],
    hospital: ['nwr[amenity~"^(hospital|clinic)$"]'],
    toilets: ['nwr[amenity=toilets]']
  };
  var CAT_NAME = { fuel: 'Cây xăng', repair: 'Tiệm sửa xe', atm: 'ATM', cafe: 'Quán cà phê', food: 'Quán ăn',
    parking: 'Bãi gửi xe', hospital: 'Bệnh viện', toilets: 'Nhà vệ sinh' };
  function nearby(cat, p) {
    var around = '(around:3000,' + p.lat + ',' + p.lon + ');';
    var q = '[out:json][timeout:12];(' + CATS[cat].join(around) + around + ');out center tags 60;';
    return overpass(q).then(function (j) {
      return (j.elements || []).map(function (e) {
        var lat = e.lat != null ? e.lat : e.center && e.center.lat;
        var lon = e.lon != null ? e.lon : e.center && e.center.lon;
        var t = e.tags || {};
        var addr = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ') || t.brand || t.operator || '';
        return { lat: lat, lon: lon, name: t.name || CAT_NAME[cat], addr: addr };
      }).filter(function (r) { return r.lat != null; })
        .sort(function (a, b) { return dist(p, a) - dist(p, b); })
        .slice(0, 12);
    });
  }

  // ---------- Tìm đường ----------
  // Ưu tiên Valhalla (có chế độ xe máy, tránh cao tốc), lỗi thì dùng OSRM (đường ô tô).
  function route(from, to, heading) {
    return routeValhalla(from, to, heading).catch(function () { return routeOSRM(from, to); });
  }

  function decode6(str) { // giải mã polyline độ chính xác 6 của Valhalla
    var i = 0, lat = 0, lon = 0, out = [];
    while (i < str.length) {
      var b, s = 0, r = 0;
      do { b = str.charCodeAt(i++) - 63; r |= (b & 31) << s; s += 5; } while (b >= 32);
      lat += (r & 1) ? ~(r >> 1) : (r >> 1);
      s = 0; r = 0;
      do { b = str.charCodeAt(i++) - 63; r |= (b & 31) << s; s += 5; } while (b >= 32);
      lon += (r & 1) ? ~(r >> 1) : (r >> 1);
      out.push([lat / 1e6, lon / 1e6]);
    }
    return out;
  }

  // Mã hướng rẽ của Valhalla
  var VT = {
    1: ['↑', 'Xuất phát'], 2: ['↑', 'Xuất phát'], 3: ['↑', 'Xuất phát'],
    4: ['⚑', 'Đến nơi'], 5: ['⚑', 'Đến nơi, bên phải'], 6: ['⚑', 'Đến nơi, bên trái'],
    7: ['↑', 'Đi tiếp'], 8: ['↑', 'Đi tiếp'],
    9: ['↗', 'Chếch phải'], 10: ['→', 'Rẽ phải'], 11: ['↘', 'Rẽ gắt phải'],
    12: ['⤻', 'Quay đầu'], 13: ['⤺', 'Quay đầu'],
    14: ['↙', 'Rẽ gắt trái'], 15: ['←', 'Rẽ trái'], 16: ['↖', 'Chếch trái'],
    17: ['↑', 'Đi thẳng lên đường dẫn'], 18: ['↗', 'Vào đường dẫn bên phải'], 19: ['↖', 'Vào đường dẫn bên trái'],
    20: ['↗', 'Ra lối bên phải'], 21: ['↖', 'Ra lối bên trái'],
    22: ['↑', 'Giữ thẳng'], 23: ['↗', 'Giữ bên phải'], 24: ['↖', 'Giữ bên trái'],
    25: ['↑', 'Nhập làn'], 26: ['⟳', 'Vào vòng xoay'], 27: ['⟳', 'Ra khỏi vòng xoay'],
    28: ['⛴', 'Lên phà'], 29: ['⛴', 'Xuống phà'],
    37: ['↗', 'Nhập làn bên phải'], 38: ['↖', 'Nhập làn bên trái']
  };
  function routeValhalla(from, to, heading) {
    var loc0 = { lat: from.lat, lon: from.lon };
    if (heading != null) { loc0.heading = Math.round(heading); loc0.heading_tolerance = 60; }
    var req = {
      locations: [loc0, { lat: to.lat, lon: to.lon }],
      costing: 'motor_scooter',
      costing_options: { motor_scooter: { top_speed: 60, use_primary: 0.6, use_hills: 0.5 } },
      units: 'kilometers', language: 'vi-VN', directions_type: 'maneuvers'
    };
    return fetchJSON(VALHALLA + '?json=' + encodeURIComponent(JSON.stringify(req))).then(function (j) {
      var leg = j.trip && j.trip.legs && j.trip.legs[0];
      if (!leg) throw new Error('Không có tuyến');
      var line = decode6(leg.shape);
      var steps = leg.maneuvers.map(function (m) {
        var v = VT[m.type] || ['↑', 'Đi tiếp'];
        var road = (m.street_names && m.street_names[0]) || '';
        var text = v[1];
        if (m.type === 26 && m.roundabout_exit_count) text += ', ra lối thứ ' + m.roundabout_exit_count;
        if (road && m.type !== 4 && m.type !== 5 && m.type !== 6) text += ' vào ' + road;
        var idx = Math.min(m.begin_shape_index || 0, line.length - 1);
        return { lat: line[idx][0], lon: line[idx][1], idx: idx, icon: v[0], text: text };
      });
      return { line: line, steps: steps, distance: j.trip.summary.length * 1000,
        duration: j.trip.summary.time, src: 'xe máy' };
    });
  }

  var MOD_ICON = { 'uturn': '⤺', 'sharp right': '↘', 'right': '→', 'slight right': '↗',
    'straight': '↑', 'slight left': '↖', 'left': '←', 'sharp left': '↙' };
  var MOD_TEXT = { 'uturn': 'Quay đầu', 'sharp right': 'Rẽ gắt phải', 'right': 'Rẽ phải', 'slight right': 'Chếch phải',
    'straight': 'Đi thẳng', 'slight left': 'Chếch trái', 'left': 'Rẽ trái', 'sharp left': 'Rẽ gắt trái' };
  function stepText(s) {
    var m = s.maneuver, mod = m.modifier || 'straight', road = s.name || s.ref || '', t;
    switch (m.type) {
      case 'depart': t = 'Xuất phát'; break;
      case 'arrive': return { icon: '⚑', text: 'Đến nơi' };
      case 'roundabout': case 'rotary':
        return { icon: '⟳', text: 'Vào vòng xoay' + (m.exit ? ', ra lối thứ ' + m.exit : '') + (road ? ' → ' + road : '') };
      case 'exit roundabout': case 'exit rotary': t = 'Ra khỏi vòng xoay'; break;
      case 'fork': t = mod.indexOf('left') >= 0 ? 'Đi nhánh trái' : 'Đi nhánh phải'; break;
      case 'merge': t = 'Nhập làn'; break;
      case 'end of road': t = MOD_TEXT[mod] + ' ở cuối đường'; break;
      case 'continue': case 'new name': t = mod === 'straight' ? 'Đi tiếp' : MOD_TEXT[mod]; break;
      default: t = MOD_TEXT[mod] || 'Đi tiếp';
    }
    return { icon: MOD_ICON[mod] || '↑', text: t + (road ? ' vào ' + road : '') };
  }
  function routeOSRM(from, to) {
    var url = OSRM + from.lon + ',' + from.lat + ';' + to.lon + ',' + to.lat + '?overview=full&geometries=geojson&steps=true';
    return fetchJSON(url).then(function (j) {
      if (!j.routes || !j.routes.length) throw new Error('Không tìm được đường');
      var r = j.routes[0];
      var line = r.geometry.coordinates.map(function (c) { return [c[1], c[0]]; });
      var hint = 0;
      var steps = r.legs[0].steps.map(function (s) {
        var tx = stepText(s), loc = s.maneuver.location;
        var n = nearestOnLine({ lat: loc[1], lon: loc[0] }, line, 0);
        hint = Math.max(n.i, hint);
        return { lat: loc[1], lon: loc[0], idx: hint, icon: tx.icon, text: tx.text };
      });
      return { line: line, steps: steps, distance: r.distance, duration: r.duration, src: 'ô tô (dự phòng)' };
    });
  }

  // ---------- Giới hạn tốc độ ----------
  // Như OsmAnd: ưu tiên biển ghi trên đường (maxspeed). Không có thì ước tính theo
  // Thông tư 38/2024/TT-BGTVT cho xe mô tô, có phân biệt trong/ngoài khu đông dân cư:
  //   trong khu dân cư:  đường đôi/một chiều ≥2 làn 60, đường hai chiều/một chiều 1 làn 50
  //   ngoài khu dân cư:  đường đôi/một chiều ≥2 làn 70, đường hai chiều/một chiều 1 làn 60
  // "Khu dân cư" được đoán theo vùng dân cư/thương mại và mật độ nhà trên OpenStreetMap.
  function parseSpeed(v) {
    if (!v) return null;
    var n = parseInt(v, 10);
    if (isNaN(n)) return null;
    return /mph/.test(v) ? Math.round(n * 1.609) : n;
  }
  function estimate(tags, urban) {
    var lanes = parseInt(tags.lanes || '0', 10);
    var divided = tags.oneway === 'yes' && (lanes >= 2 || /trunk|primary/.test(tags.highway));
    if (tags.dual_carriageway === 'yes') divided = true;
    if (/residential|living_street|service/.test(tags.highway)) urban = true; // đường trong khu dân cư
    if (urban) return divided ? 60 : 50;
    return divided ? 70 : 60;
  }
  var SKIP = /footway|path|cycleway|steps|pedestrian|service|track|construction|proposed|platform/;

  function speedLimit(p, heading) {
    var at = p.lat + ',' + p.lon;
    var q = '[out:json][timeout:10];way(around:30,' + at + ')[highway];out tags geom;' +
      'way(around:120,' + at + ')[building];out count;' +
      'way(around:150,' + at + ')[landuse~"^(residential|commercial|retail)$"];out count;' +
      'is_in(' + at + ')->.a;area.a[place~"^(city|town|suburb|quarter|neighbourhood)$"];out count;';
    return overpass(q).then(function (j) {
      var best = null, counts = [];
      (j.elements || []).forEach(function (w) {
        if (w.type === 'count') { counts.push(+(w.tags && w.tags.total) || 0); return; }
        if (!w.geometry || SKIP.test(w.tags.highway)) return;
        var g = w.geometry.map(function (n) { return [n.lat, n.lon]; });
        for (var i = 0; i < g.length - 1; i++) {
          var d = segDist(p, g[i], g[i + 1]).d;
          if (heading != null) { // ưu tiên đoạn đường cùng hướng đang đi
            var b = bearing({ lat: g[i][0], lon: g[i][1] }, { lat: g[i + 1][0], lon: g[i + 1][1] });
            d += Math.min(angleDiff(b, heading), angleDiff((b + 180) % 360, heading)) / 6;
          }
          if (!best || d < best.d) best = { d: d, tags: w.tags };
        }
      });
      if (!best) return null;
      // counts: [số nhà trong 120 m, số vùng dân cư/thương mại, số vùng đô thị chứa điểm]
      var urban = (counts[0] || 0) >= 12 || (counts[1] || 0) > 0 || (counts[2] || 0) > 0;
      var t = best.tags;
      if (t.highway === 'motorway') return { limit: 0, exact: true, road: t.name || t.ref || '', banned: true };
      var v = parseSpeed(t['maxspeed:motorcycle']) || parseSpeed(t.maxspeed);
      return { limit: v || estimate(t, urban), exact: !!v, urban: urban, road: t.name || t.ref || '' };
    });
  }

  // ---------- Camera và chướng ngại trên đường (như cảnh báo của OsmAnd) ----------
  function hazardQuery(area) {
    return '[out:json][timeout:20];(' +
      'node[highway=speed_camera]' + area + 'node["enforcement"="maxspeed"]' + area +
      'node[railway=level_crossing]' + area +
      'node[traffic_calming~"^(bump|hump|table|cushion)$"]' + area + ');out;';
  }
  function parseHazards(j) {
    return (j.elements || []).map(function (n) {
      var t = n.tags || {};
      var type = t.railway === 'level_crossing' ? 'rail' : t.traffic_calming ? 'bump' : 'camera';
      return { type: type, lat: n.lat, lon: n.lon, limit: parseSpeed(t.maxspeed) };
    });
  }
  function cameras(p, radius) {
    return overpass(hazardQuery('(around:' + radius + ',' + p.lat + ',' + p.lon + ');')).then(parseHazards);
  }
  // Quét dọc toàn tuyến (tuyến dưới ~150 km), giữ lại điểm nằm sát tuyến trong 40 m
  function alongRoute(line) {
    var minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    line.forEach(function (q) {
      minLat = Math.min(minLat, q[0]); maxLat = Math.max(maxLat, q[0]);
      minLon = Math.min(minLon, q[1]); maxLon = Math.max(maxLon, q[1]);
    });
    if ((maxLat - minLat) * (maxLon - minLon) > 1.5) return Promise.resolve(null);
    var box = '(' + (minLat - 0.005) + ',' + (minLon - 0.005) + ',' + (maxLat + 0.005) + ',' + (maxLon + 0.005) + ');';
    return overpass(hazardQuery(box)).then(function (j) {
      return parseHazards(j).filter(function (h) { return nearestOnLine(h, line, 0).d < 40; });
    });
  }

  window.Geo = { dist: dist, bearing: bearing, angleDiff: angleDiff, nearestOnLine: nearestOnLine };
  window.Data = { search: search, nearby: nearby, route: route, speedLimit: speedLimit, cameras: cameras, alongRoute: alongRoute };
})();
