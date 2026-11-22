/* Bản đồ dạng ô (tile) viết tay, không cần thư viện ngoài.
   Cú pháp giữ ở mức ES2017 để chạy tốt trên Safari iOS 15. */
(function () {
  'use strict';

  var TILE = 256;
  var MIN_Z = 3, MAX_Z = 19;
  var SUBS = ['a', 'b', 'c', 'd'];
  function tileUrl(z, x, y) {
    var s = SUBS[(x + y) % 4];
    return 'https://' + s + '.basemaps.cartocdn.com/rastertiles/voyager/' + z + '/' + x + '/' + y + '@2x.png';
  }

  function project(lat, lon, z) {
    var size = TILE * Math.pow(2, z);
    var s = Math.sin(lat * Math.PI / 180);
    s = Math.max(Math.min(s, 0.9999), -0.9999);
    return {
      x: (lon + 180) / 360 * size,
      y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size
    };
  }
  function unproject(x, y, z) {
    var size = TILE * Math.pow(2, z);
    var lon = x / size * 360 - 180;
    var n = Math.PI - 2 * Math.PI * y / size;
    var lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return { lat: lat, lon: lon };
  }

  function TileMap(el) {
    this.el = el;
    this.z = 16;
    this.center = { lat: 10.7769, lon: 106.7009 }; // TP.HCM, sẽ thay bằng GPS
    this.tiles = {};
    this.route = null;      // [[lat,lon],...]
    this.cameras = [];      // [{lat,lon,user}]
    this.dest = null;
    this.user = null;       // {lat,lon,heading}
    this.onPan = null;
    this.onLongPress = null;

    this.tileLayer = document.createElement('div');
    this.tileLayer.className = 'tiles';
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    var attr = document.createElement('div');
    attr.style.cssText = 'position:absolute;right:4px;bottom:2px;font-size:9px;color:#6f685c;z-index:2';
    attr.textContent = '© OpenStreetMap © CARTO';
    el.appendChild(this.tileLayer);
    el.appendChild(this.canvas);
    el.appendChild(attr);

    this._bind();
    this.resize();
    var self = this;
    window.addEventListener('resize', function () { self.resize(); });
  }

  TileMap.prototype.resize = function () {
    var dpr = window.devicePixelRatio || 1;
    this.w = this.el.clientWidth;
    this.h = this.el.clientHeight;
    this.canvas.width = this.w * dpr;
    this.canvas.height = this.h * dpr;
    this.canvas.style.width = this.w + 'px';
    this.canvas.style.height = this.h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.render();
  };

  TileMap.prototype.setView = function (lat, lon, z) {
    this.center = { lat: lat, lon: lon };
    if (z) this.z = Math.max(MIN_Z, Math.min(MAX_Z, z));
    this.render();
  };
  TileMap.prototype.zoomBy = function (d) {
    this.z = Math.max(MIN_Z, Math.min(MAX_Z, this.z + d));
    this.render();
  };

  // Tọa độ màn hình của một điểm
  TileMap.prototype.toScreen = function (lat, lon) {
    var c = project(this.center.lat, this.center.lon, this.z);
    var p = project(lat, lon, this.z);
    return { x: p.x - c.x + this.w / 2, y: p.y - c.y + this.h / 2 };
  };
  TileMap.prototype.fromScreen = function (sx, sy) {
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
    var z = MAX_Z;
    for (; z > MIN_Z; z--) {
      var a = project(maxLat, minLon, z), b = project(minLat, maxLon, z);
      if (b.x - a.x < this.w * 0.8 && b.y - a.y < this.h * 0.55) break;
    }
    this.setView((minLat + maxLat) / 2, (minLon + maxLon) / 2, z);
  };

  TileMap.prototype.render = function () {
    var self = this;
    if (this._raf) return;
    this._raf = requestAnimationFrame(function () {
      self._raf = null;
      self._drawTiles();
      self._drawOverlay();
    });
  };

  TileMap.prototype._drawTiles = function () {
    var z = this.z;
    var c = project(this.center.lat, this.center.lon, z);
    var left = c.x - this.w / 2, top = c.y - this.h / 2;
    var n = Math.pow(2, z);
    var x0 = Math.floor(left / TILE), x1 = Math.floor((left + this.w) / TILE);
    var y0 = Math.floor(top / TILE), y1 = Math.floor((top + this.h) / TILE);
    var keep = {};
    for (var tx = x0; tx <= x1; tx++) {
      for (var ty = y0; ty <= y1; ty++) {
        if (ty < 0 || ty >= n) continue;
        var wx = ((tx % n) + n) % n;
        var key = z + '/' + tx + '/' + ty;
        keep[key] = true;
        var img = this.tiles[key];
        if (!img) {
          img = document.createElement('img');
          img.src = tileUrl(z, wx, ty);
          this.tileLayer.appendChild(img);
          this.tiles[key] = img;
        }
        img.style.left = Math.round(tx * TILE - left) + 'px';
        img.style.top = Math.round(ty * TILE - top) + 'px';
      }
    }
    for (var k in this.tiles) {
      if (!keep[k]) {
        this.tileLayer.removeChild(this.tiles[k]);
        delete this.tiles[k];
      }
    }
  };

  TileMap.prototype._drawOverlay = function () {
    var ctx = this.ctx, i, p;
    ctx.clearRect(0, 0, this.w, this.h);

    if (this.route && this.route.length > 1) {
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      var path = [];
      for (i = 0; i < this.route.length; i++) path.push(this.toScreen(this.route[i][0], this.route[i][1]));
      [[11, '#1d1b18'], [7, '#2b59c3']].forEach(function (st) {
        ctx.beginPath();
        ctx.moveTo(path[0].x, path[0].y);
        for (var j = 1; j < path.length; j++) ctx.lineTo(path[j].x, path[j].y);
        ctx.lineWidth = st[0]; ctx.strokeStyle = st[1]; ctx.stroke();
      });
    }

    for (i = 0; i < this.cameras.length; i++) {
      p = this.toScreen(this.cameras[i].lat, this.cameras[i].lon);
      if (p.x < -20 || p.y < -20 || p.x > this.w + 20 || p.y > this.h + 20) continue;
      ctx.beginPath(); ctx.arc(p.x, p.y, 11, 0, Math.PI * 2);
      ctx.fillStyle = this.cameras[i].user ? '#e8452c' : '#f2b33d'; ctx.fill();
      ctx.lineWidth = 2.5; ctx.strokeStyle = '#1d1b18'; ctx.stroke();
      ctx.fillStyle = '#1d1b18'; ctx.fillRect(p.x - 5, p.y - 3.5, 10, 7);
      ctx.beginPath(); ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
    }

    if (this.dest) {
      p = this.toScreen(this.dest.lat, this.dest.lon);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.bezierCurveTo(p.x - 14, p.y - 18, p.x - 12, p.y - 34, p.x, p.y - 34);
      ctx.bezierCurveTo(p.x + 12, p.y - 34, p.x + 14, p.y - 18, p.x, p.y);
      ctx.fillStyle = '#e8452c'; ctx.fill();
      ctx.lineWidth = 2.5; ctx.strokeStyle = '#1d1b18'; ctx.stroke();
      ctx.beginPath(); ctx.arc(p.x, p.y - 23, 4.5, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
    }

    if (this.user) {
      p = this.toScreen(this.user.lat, this.user.lon);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.beginPath(); ctx.arc(0, 0, 22, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(43,89,195,.18)'; ctx.fill();
      if (this.user.heading != null && !isNaN(this.user.heading)) {
        ctx.rotate(this.user.heading * Math.PI / 180);
        ctx.beginPath();
        ctx.moveTo(0, -15); ctx.lineTo(11, 11); ctx.lineTo(0, 5); ctx.lineTo(-11, 11); ctx.closePath();
      } else {
        ctx.beginPath(); ctx.arc(0, 0, 9, 0, Math.PI * 2);
      }
      ctx.fillStyle = '#2b59c3'; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.restore();
    }
  };

  // ---------- Cử chỉ: kéo, chụm 2 ngón để zoom, nhấn giữ để chọn điểm đến ----------
  TileMap.prototype._bind = function () {
    var self = this, el = this.el;
    var drag = null, pinch = null, pressTimer = null;

    function startDrag(x, y) {
      drag = { x: x, y: y, c: project(self.center.lat, self.center.lon, self.z), moved: false };
      clearTimeout(pressTimer);
      pressTimer = setTimeout(function () {
        if (drag && !drag.moved && self.onLongPress) {
          var ll = self.fromScreen(x, y);
          self.onLongPress(ll.lat, ll.lon);
          drag = null;
        }
      }, 650);
    }
    function moveDrag(x, y) {
      if (!drag) return;
      var dx = x - drag.x, dy = y - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 6) {
        if (!drag.moved && self.onPan) self.onPan();
        drag.moved = true;
        clearTimeout(pressTimer);
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
      else if (e.touches.length === 2) {
        clearTimeout(pressTimer); drag = null;
        pinch = { d: dist(e.touches), ratio: 1 };
      }
    }, { passive: false });
    el.addEventListener('touchmove', function (e) {
      e.preventDefault();
      if (pinch && e.touches.length === 2) {
        pinch.ratio = dist(e.touches) / pinch.d;
        self.tileLayer.style.transformOrigin = '50% 50%';
        self.tileLayer.style.transform = 'scale(' + pinch.ratio + ')';
      } else if (e.touches.length === 1) moveDrag(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: false });
    el.addEventListener('touchend', function (e) {
      clearTimeout(pressTimer);
      if (pinch && e.touches.length < 2) {
        var dz = Math.round(Math.log(pinch.ratio) / Math.LN2);
        self.tileLayer.style.transform = '';
        pinch = null;
        if (dz) { if (self.onPan) self.onPan(); self.zoomBy(dz); }
      }
      if (e.touches.length === 0) drag = null;
    });

    // Chuột (để thử trên máy tính)
    el.addEventListener('mousedown', function (e) { startDrag(e.clientX, e.clientY); });
    window.addEventListener('mousemove', function (e) { moveDrag(e.clientX, e.clientY); });
    window.addEventListener('mouseup', function () { clearTimeout(pressTimer); drag = null; });
    el.addEventListener('wheel', function (e) {
      e.preventDefault();
      if (self.onPan) self.onPan();
      self.zoomBy(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
  };

  window.TileMap = TileMap;
})();
