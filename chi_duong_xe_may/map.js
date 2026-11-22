/* Bản đồ dạng ô (tile) viết tay, không cần thư viện ngoài.
   Có chế độ dẫn đường kiểu Waze: nghiêng 3D và xoay theo hướng đi.
   Cú pháp giữ ở mức ES2017 để chạy tốt trên Safari iOS 15. */
(function () {
  'use strict';

  var TILE = 256;
  var MIN_Z = 3;
  var SUBS = ['a', 'b', 'c', 'd'];

  // Kiểu bản đồ: mỗi kiểu có một hoặc nhiều lớp ảnh chồng lên nhau.
  // Chỉ dùng nguồn không cần khóa API (CARTO đã bắt buộc khóa nên bỏ).
  var ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
  function esri(name) { return function (z, x, y) { return ESRI + name + '/MapServer/tile/' + z + '/' + y + '/' + x; }; }
  function osm(z, x, y) { return 'https://tile.openstreetmap.org/' + z + '/' + x + '/' + y + '.png'; }
  var STYLES = {
    waze: { maxZ: 19, layers: [esri('World_Street_Map')], attr: '© Esri © OpenStreetMap' },
    detail: { maxZ: 19, layers: [osm], attr: '© OpenStreetMap' },
    sat: { maxZ: 19, layers: [esri('World_Imagery'), esri('Reference/World_Transportation'),
      esri('Reference/World_Boundaries_and_Places')], attr: '© Esri' }
  };

  function project(lat, lon, z) {
    var size = TILE * Math.pow(2, z);
    var s = Math.sin(lat * Math.PI / 180);
    s = Math.max(Math.min(s, 0.9999), -0.9999);
    return { x: (lon + 180) / 360 * size, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size };
  }
  function unproject(x, y, z) {
    var size = TILE * Math.pow(2, z);
    var n = Math.PI - 2 * Math.PI * y / size;
    return { lat: 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))), lon: x / size * 360 - 180 };
  }

  function TileMap(el) {
    this.el = el;
    this.z = 6;
    this.center = { lat: 16.0, lon: 106.0 }; // giữa Việt Nam, sẽ thay bằng GPS
    this.style = 'waze';
    this.nav = false;        // true = nghiêng 3D, xoay theo hướng đi
    this.bearing = 0;        // độ, cộng dồn (không quấn 0–360) để xoay mượt
    this.tiles = {};
    this.route = null;
    this.markers = [];       // [{lat, lon, icon, color}]
    this.dest = null;
    this.user = null;        // {lat, lon, heading}
    this.onPan = null;
    this.onLongPress = null;

    this.stage = document.createElement('div');
    this.stage.className = 'stage';
    this.tileLayer = document.createElement('div');
    this.tileLayer.className = 'tiles';
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.stage.appendChild(this.tileLayer);
    this.stage.appendChild(this.canvas);
    this.attr = document.createElement('div');
    this.attr.className = 'attr';
    el.appendChild(this.stage);
    el.appendChild(this.attr);

    this._bind();
    this.setStyle('waze');
    var self = this;
    window.addEventListener('resize', function () { self.resize(); });
    window.addEventListener('orientationchange', function () { setTimeout(function () { self.resize(); }, 300); });
  }

  TileMap.prototype.setStyle = function (name) {
    if (!STYLES[name]) name = 'waze';
    this.style = name;
    this.attr.textContent = STYLES[name].attr;
    this.el.setAttribute('data-style', name);
    for (var k in this.tiles) this.tileLayer.removeChild(this.tiles[k]);
    this.tiles = {};
    this.z = Math.min(this.z, STYLES[name].maxZ);
    this.resize();
  };

  // Kích thước "sân khấu": ở chế độ 3D phải lớn hơn màn hình để khi xoay/nghiêng không lộ góc trống
  TileMap.prototype.resize = function () {
    this.w = this.el.clientWidth;
    this.h = this.el.clientHeight;
    if (this.nav) {
      var d = Math.ceil(Math.sqrt(this.w * this.w + this.h * this.h));
      this.sw = Math.ceil(d * 1.25); this.sh = Math.ceil(d * 1.7);
    } else { this.sw = this.w; this.sh = this.h; }
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = this.sw * dpr; this.canvas.height = this.sh * dpr;
    this.canvas.style.width = this.sw + 'px'; this.canvas.style.height = this.sh + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.stage.style.width = this.sw + 'px'; this.stage.style.height = this.sh + 'px';
    this.stage.style.left = Math.round((this.w - this.sw) / 2) + 'px';
    this.stage.style.top = Math.round((this.h - this.sh) / 2) + 'px';
    this._applyTransform();
    this.render();
  };

  TileMap.prototype._applyTransform = function () {
    if (this.nav) {
      // Đẩy vị trí người dùng xuống 1/4 dưới màn hình, nghiêng 50°, xoay ngược hướng đi
      var t = 'translateY(' + Math.round(this.h * 0.22) + 'px) rotateX(50deg) rotateZ(' + (-this.bearing) + 'deg)';
      this.stage.style.webkitTransform = t; this.stage.style.transform = t;
    } else {
      this.stage.style.webkitTransform = ''; this.stage.style.transform = '';
    }
  };

  TileMap.prototype.setNav = function (on) {
    if (this.nav === on) return;
    this.nav = on;
    this.el.classList.toggle('nav3d', on);
    if (!on) this.bearing = 0;
    for (var k in this.tiles) this.tileLayer.removeChild(this.tiles[k]);
    this.tiles = {};
    this.resize();
  };
  TileMap.prototype.setBearing = function (deg) {
    if (deg == null || isNaN(deg)) return;
    var cur = ((this.bearing % 360) + 360) % 360;
    var diff = ((deg - cur + 540) % 360) - 180; // quay theo đường ngắn nhất
    if (Math.abs(diff) < 3) return;
    this.bearing += diff;
    this._applyTransform();
  };

  TileMap.prototype.setView = function (lat, lon, z) {
    this.center = { lat: lat, lon: lon };
    if (z) this.z = Math.max(MIN_Z, Math.min(STYLES[this.style].maxZ, z));
    this.render();
  };
  // Di chuyển mượt tới vị trí mới (giữa 2 lần GPS cập nhật)
  TileMap.prototype.glideTo = function (lat, lon, ms) {
    var self = this, from = this.center, t0 = Date.now();
    cancelAnimationFrame(this._glide);
    if (Math.abs(from.lat - lat) > 0.01 || Math.abs(from.lon - lon) > 0.01) { this.setView(lat, lon); return; }
    function step() {
      var k = Math.min(1, (Date.now() - t0) / ms);
      self.center = { lat: from.lat + (lat - from.lat) * k, lon: from.lon + (lon - from.lon) * k };
      self._drawTiles(); self._drawOverlay();
      if (k < 1) self._glide = requestAnimationFrame(step);
    }
    this._glide = requestAnimationFrame(step);
  };
  TileMap.prototype.zoomBy = function (d) {
    this.z = Math.max(MIN_Z, Math.min(STYLES[this.style].maxZ, this.z + d));
    this.render();
  };

  TileMap.prototype.toStage = function (lat, lon) {
    var c = project(this.center.lat, this.center.lon, this.z), p = project(lat, lon, this.z);
    return { x: p.x - c.x + this.sw / 2, y: p.y - c.y + this.sh / 2 };
  };
  TileMap.prototype.fromScreen = function (sx, sy) { // chỉ đúng ở chế độ phẳng
    var c = project(this.center.lat, this.center.lon, this.z);
    return unproject(c.x + sx - this.w / 2, c.y + sy - this.h / 2, this.z);
  };

  TileMap.prototype.fitBounds = function (pts) {
    if (!pts.length) return;
    var minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    for (var i = 0; i < pts.length; i++) {
      minLat = Math.min(minLat, pts[i][0]); maxLat = Math.max(maxLat, pts[i][0]);
      minLon = Math.min(minLon, pts[i][1]); maxLon = Math.max(maxLon, pts[i][1]);
    }
    var z = STYLES[this.style].maxZ;
    for (; z > MIN_Z; z--) {
      var a = project(maxLat, minLon, z), b = project(minLat, maxLon, z);
      if (b.x - a.x < this.w * 0.8 && b.y - a.y < this.h * 0.5) break;
    }
    this.setView((minLat + maxLat) / 2, (minLon + maxLon) / 2, z);
  };

  TileMap.prototype.render = function () {
    var self = this;
    if (this._raf) return;
    this._raf = requestAnimationFrame(function () {
      self._raf = null; self._drawTiles(); self._drawOverlay();
    });
  };

  TileMap.prototype._drawTiles = function () {
    var z = this.z, st = STYLES[this.style];
    var c = project(this.center.lat, this.center.lon, z);
    var left = c.x - this.sw / 2, top = c.y - this.sh / 2;
    var n = Math.pow(2, z);
    var x0 = Math.floor(left / TILE), x1 = Math.floor((left + this.sw) / TILE);
    var y0 = Math.floor(top / TILE), y1 = Math.floor((top + this.sh) / TILE);
    var keep = {};
    for (var L = 0; L < st.layers.length; L++) {
      for (var tx = x0; tx <= x1; tx++) {
        for (var ty = y0; ty <= y1; ty++) {
          if (ty < 0 || ty >= n) continue;
          var key = L + '/' + z + '/' + tx + '/' + ty;
          keep[key] = true;
          var img = this.tiles[key];
          if (!img) {
            img = document.createElement('img');
            img.style.zIndex = L;
            img.src = st.layers[L](z, ((tx % n) + n) % n, ty);
            if (L === 0) img.onerror = (function (im, zz, xx, yy) { return function () { im.onerror = null; im.src = osm(zz, xx, yy); }; })(img, z, ((tx % n) + n) % n, ty);
            this.tileLayer.appendChild(img);
            this.tiles[key] = img;
          }
          img.style.left = Math.round(tx * TILE - left) + 'px';
          img.style.top = Math.round(ty * TILE - top) + 'px';
        }
      }
    }
    for (var k in this.tiles) {
      if (!keep[k]) { this.tileLayer.removeChild(this.tiles[k]); delete this.tiles[k]; }
    }
  };

  TileMap.prototype._drawOverlay = function () {
    var ctx = this.ctx, i, p, self = this;
    var upright = this.bearing * Math.PI / 180; // giữ biểu tượng đứng thẳng khi bản đồ xoay
    ctx.clearRect(0, 0, this.sw, this.sh);

    if (this.route && this.route.length > 1) {
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      var path = this.route.map(function (q) { return self.toStage(q[0], q[1]); });
      [[14, 'rgba(10,60,120,.35)'], [10, '#ffffff'], [6.5, '#1aa7ec']].forEach(function (s) {
        ctx.beginPath(); ctx.moveTo(path[0].x, path[0].y);
        for (var j = 1; j < path.length; j++) ctx.lineTo(path[j].x, path[j].y);
        ctx.lineWidth = s[0]; ctx.strokeStyle = s[1]; ctx.stroke();
      });
    }

    for (i = 0; i < this.markers.length; i++) {
      var m = this.markers[i];
      p = this.toStage(m.lat, m.lon);
      if (p.x < -30 || p.y < -30 || p.x > this.sw + 30 || p.y > this.sh + 30) continue;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(upright);
      ctx.beginPath(); ctx.arc(0, -16, 15, 0, Math.PI * 2);
      ctx.fillStyle = m.color || '#ff9f1a'; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-6, -4); ctx.lineTo(0, 4); ctx.lineTo(6, -4); ctx.fillStyle = m.color || '#ff9f1a'; ctx.fill();
      ctx.font = '16px -apple-system, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(m.icon, 0, -15);
      ctx.restore();
    }

    if (this.dest) {
      p = this.toStage(this.dest.lat, this.dest.lon);
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(upright);
      ctx.beginPath(); ctx.moveTo(0, 0);
      ctx.bezierCurveTo(-16, -20, -14, -38, 0, -38); ctx.bezierCurveTo(14, -38, 16, -20, 0, 0);
      ctx.fillStyle = '#ff5a5f'; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.beginPath(); ctx.arc(0, -25, 5.5, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
      ctx.restore();
    }

    if (this.user) {
      p = this.toStage(this.user.lat, this.user.lon);
      ctx.save(); ctx.translate(p.x, p.y);
      ctx.beginPath(); ctx.arc(0, 0, 26, 0, Math.PI * 2); ctx.fillStyle = 'rgba(26,167,236,.2)'; ctx.fill();
      var hd = this.user.heading;
      if (hd != null && !isNaN(hd)) {
        ctx.rotate(hd * Math.PI / 180);
        ctx.beginPath(); ctx.moveTo(0, -18); ctx.lineTo(13, 13); ctx.lineTo(0, 6); ctx.lineTo(-13, 13); ctx.closePath();
      } else { ctx.beginPath(); ctx.arc(0, 0, 10, 0, Math.PI * 2); }
      ctx.fillStyle = '#1aa7ec'; ctx.fill(); ctx.lineWidth = 3.5; ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.restore();
    }
  };

  // ---------- Cử chỉ: kéo, chụm 2 ngón, nhấn giữ ----------
  TileMap.prototype._bind = function () {
    var self = this, el = this.el;
    var drag = null, pinch = null, pressTimer = null;

    function startDrag(x, y) {
      drag = { x: x, y: y, c: null, moved: false };
      clearTimeout(pressTimer);
      pressTimer = setTimeout(function () {
        if (drag && !drag.moved && !self.nav && self.onLongPress) {
          var ll = self.fromScreen(x, y);
          self.onLongPress(ll.lat, ll.lon);
          drag = null;
        }
      }, 650);
    }
    function moveDrag(x, y) {
      if (!drag) return;
      var dx = x - drag.x, dy = y - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 8) {
        drag.moved = true; clearTimeout(pressTimer);
        if (self.onPan) self.onPan();  // thoát chế độ 3D trước khi kéo
        drag.c = project(self.center.lat, self.center.lon, self.z);
        drag.x = x; drag.y = y; dx = 0; dy = 0;
      }
      if (drag.moved) {
        self.center = unproject(drag.c.x - dx, drag.c.y - dy, self.z);
        self.render();
      }
    }
    function dist(t) {
      var dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY;
      return Math.sqrt(dx * dx + dy * dy);
    }

    el.addEventListener('touchstart', function (e) {
      e.preventDefault();
      if (e.touches.length === 1) startDrag(e.touches[0].clientX, e.touches[0].clientY);
      else if (e.touches.length === 2) { clearTimeout(pressTimer); drag = null; pinch = { d: dist(e.touches), ratio: 1 }; }
    }, { passive: false });
    el.addEventListener('touchmove', function (e) {
      e.preventDefault();
      if (pinch && e.touches.length === 2) {
        pinch.ratio = dist(e.touches) / pinch.d;
        self.tileLayer.style.transformOrigin = (self.sw / 2) + 'px ' + (self.sh / 2) + 'px';
        self.tileLayer.style.webkitTransform = 'scale(' + pinch.ratio + ')';
      } else if (e.touches.length === 1) moveDrag(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: false });
    el.addEventListener('touchend', function (e) {
      clearTimeout(pressTimer);
      if (pinch && e.touches.length < 2) {
        var dz = Math.round(Math.log(pinch.ratio) / Math.LN2);
        self.tileLayer.style.webkitTransform = '';
        pinch = null;
        if (dz) self.zoomBy(dz);
      }
      if (e.touches.length === 0) drag = null;
    });

    el.addEventListener('mousedown', function (e) { startDrag(e.clientX, e.clientY); });
    window.addEventListener('mousemove', function (e) { moveDrag(e.clientX, e.clientY); });
    window.addEventListener('mouseup', function () { clearTimeout(pressTimer); drag = null; });
    el.addEventListener('wheel', function (e) { e.preventDefault(); self.zoomBy(e.deltaY < 0 ? 1 : -1); }, { passive: false });
  };

  window.TileMap = TileMap;
})();
