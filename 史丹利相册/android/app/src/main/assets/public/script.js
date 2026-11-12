(function () {
  'use strict';

  // ==================== DOM 引用 ====================
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => [...(el || document).querySelectorAll(s)];

  // ==================== IndexedDB ====================
  const DB_NAME = 'StanlyAlbumDB';
  const DB_VERSION = 2;
  let db = null;

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('categories')) {
          const catStore = d.createObjectStore('categories', { keyPath: 'id', autoIncrement: true });
          catStore.createIndex('name', 'name', { unique: false });
          catStore.createIndex('sortOrder', 'sortOrder', { unique: false });
        }
        if (!d.objectStoreNames.contains('photos')) {
          const photoStore = d.createObjectStore('photos', { keyPath: 'id', autoIncrement: true });
          photoStore.createIndex('categoryId', 'categoryId', { unique: false });
          photoStore.createIndex('uploadTime', 'uploadTime', { unique: false });
          photoStore.createIndex('fileName', 'fileName', { unique: false });
          photoStore.createIndex('note', 'note', { unique: false });
        }
        if (!d.objectStoreNames.contains('blobs')) {
          d.createObjectStore('blobs', { keyPath: 'photoId' });
        }
        if (!d.objectStoreNames.contains('metadata')) {
          d.createObjectStore('metadata', { keyPath: 'key' });
        }
      };
      req.onsuccess = (e) => { db = e.target.result; resolve(db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(storeName, mode) {
    if (!db) throw new Error('Database not initialized');
    const t = db.transaction(storeName, mode);
    return t.objectStore(storeName);
  }

  function dbPut(storeName, data) {
    return new Promise((res, rej) => {
      const store = tx(storeName, 'readwrite');
      const req = store.put(data);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }

  function dbGetAll(storeName) {
    return new Promise((res, rej) => {
      const req = tx(storeName, 'readonly').getAll();
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }

  function dbGet(storeName, id) {
    return new Promise((res, rej) => {
      const req = tx(storeName, 'readonly').get(id);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }

  function dbDelete(storeName, id) {
    return new Promise((res, rej) => {
      const req = tx(storeName, 'readwrite').delete(id);
      req.onsuccess = () => res();
      req.onerror = () => rej(req.error);
    });
  }

  function dbClear(storeName) {
    return new Promise((res, rej) => {
      const req = tx(storeName, 'readwrite').clear();
      req.onsuccess = () => res();
      req.onerror = () => rej(req.error);
    });
  }

  function dbGetByIndex(storeName, indexName, value) {
    return new Promise((res, rej) => {
      const results = [];
      const idx = tx(storeName, 'readonly').index(indexName);
      const keyRange = value !== undefined ? IDBKeyRange.only(value) : undefined;
      const req = idx.openCursor(keyRange);
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) { results.push(cursor.value); cursor.continue(); }
        else res(results);
      };
      req.onerror = () => rej(req.error);
    });
  }

  // ==================== 状态管理 ====================
  const state = {
    currentTab: 'album',
    activeCategoryId: 'all',
    searchQuery: '',
    sortBy: 'time-desc',
    isSelectMode: false,
    selectedPhotos: new Set(),
    viewerPhotos: [],
    viewerIndex: 0,
    categories: [],
    photos: [],
    compressQuality: 0.8,
    compressMaxWidth: 1080
  };

  // ==================== 工具函数 ====================
  function formatDate(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
  }

  function showToast(msg, duration = 2000) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(el._timeout);
    el._timeout = setTimeout(() => el.classList.add('hidden'), duration);
  }

  function showConfirm(msg) {
    return new Promise((resolve) => {
      $('#confirm-message').textContent = msg;
      $('#confirm-dialog').classList.remove('hidden');
      const cleanup = () => {
        $('#confirm-dialog').classList.add('hidden');
        $('#confirm-ok').removeEventListener('click', onOk);
        $('#confirm-cancel').removeEventListener('click', onCancel);
      };
      const onOk = () => { cleanup(); resolve(true); };
      const onCancel = () => { cleanup(); resolve(false); };
      $('#confirm-ok').addEventListener('click', onOk);
      $('#confirm-cancel').addEventListener('click', onCancel);
    });
  }

  function showInput(title, placeholder = '', currentValue = '') {
    return new Promise((resolve) => {
      $('#input-dialog-title').textContent = title;
      $('#input-dialog-field').placeholder = placeholder;
      $('#input-dialog-field').value = currentValue;
      $('#input-dialog').classList.remove('hidden');
      const cleanup = () => {
        $('#input-dialog').classList.add('hidden');
        $('#input-ok').removeEventListener('click', onOk);
        $('#input-cancel').removeEventListener('click', onCancel);
      };
      const onOk = () => { const v = $('#input-dialog-field').value.trim(); cleanup(); resolve(v || null); };
      const onCancel = () => { cleanup(); resolve(null); };
      $('#input-ok').addEventListener('click', onOk);
      $('#input-cancel').addEventListener('click', onCancel);
    });
  }

  // ==================== 图片压缩 ====================
  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        let w = img.width, h = img.height;
        if (w > state.compressMaxWidth) {
          h = Math.round(h * state.compressMaxWidth / w);
          w = state.compressMaxWidth;
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);

        // 缩略图 200x200
        const thumbCanvas = document.createElement('canvas');
        thumbCanvas.width = 200; thumbCanvas.height = 200;
        const thumbCtx = thumbCanvas.getContext('2d');
        const minDim = Math.min(img.width, img.height);
        thumbCtx.drawImage(img,
          (img.width - minDim) / 2, (img.height - minDim) / 2, minDim, minDim,
          0, 0, 200, 200
        );

        // 优先 WebP，不支持则降级 JPEG
        const tryMimes = ['image/webp', 'image/jpeg'];
        let mainIdx = 0;

        function tryMainBlob() {
          if (mainIdx >= tryMimes.length) {
            // 极端情况：用原文件
            resolve({ blob: file, thumbBlob: file, width: w, height: h });
            return;
          }
          canvas.toBlob((blob) => {
            if (blob) {
              let thumbIdx = 0;
              function tryThumbBlob() {
                if (thumbIdx >= tryMimes.length) {
                  resolve({ blob, thumbBlob: blob, width: w, height: h });
                  return;
                }
                thumbCanvas.toBlob((tb) => {
                  if (tb) resolve({ blob, thumbBlob: tb, width: w, height: h });
                  else { thumbIdx++; tryThumbBlob(); }
                }, tryMimes[thumbIdx], state.compressQuality);
              }
              tryThumbBlob();
            } else {
              mainIdx++;
              tryMainBlob();
            }
          }, tryMimes[mainIdx], state.compressQuality);
        }
        tryMainBlob();
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
      img.src = url;
    });
  }

  // ==================== 分类管理 ====================
  async function loadCategories() {
    state.categories = await dbGetAll('categories');
    state.categories.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  }

  async function addCategory(name) {
    const existing = await dbGetByIndex('categories', 'name', name);
    if (existing.length > 0) { showToast('分类名称已存在'); return null; }
    const id = await dbPut('categories', {
      name,
      sortOrder: state.categories.length,
      createdAt: Date.now(),
      coverPhotoId: null
    });
    await loadCategories();
    return id;
  }

  async function updateCategory(id, updates) {
    const cat = await dbGet('categories', id);
    if (!cat) return;
    Object.assign(cat, updates);
    await dbPut('categories', cat);
    await loadCategories();
  }

  async function deleteCategory(id) {
    const items = await dbGetByIndex('photos', 'categoryId', id);
    if (items.length > 0) {
      const imgCount = items.filter(p => p.mediaType !== 'video').length;
      const vidCount = items.length - imgCount;
      const parts = [];
      if (imgCount) parts.push(`${imgCount} 张图片`);
      if (vidCount) parts.push(`${vidCount} 个视频`);
      const confirmed = await showConfirm(`该分类下有 ${parts.join(' + ')}，是否同时删除？`);
      if (!confirmed) return;
      for (const p of items) { await dbDelete('photos', p.id); await dbDelete('blobs', p.id); }
    }
    await dbDelete('categories', id);
    await loadCategories();
    if (state.activeCategoryId === id) state.activeCategoryId = 'all';
    renderAll();
  }

  // ==================== 照片管理 ====================
  async function loadPhotos() {
    state.photos = await dbGetAll('photos');
  }

  async function addMedia(file, categoryId, note = '') {
    const isVideo = file.type.startsWith('video/');
    let fullBlob, thumbBlob, width, height, compressedSize;

    if (isVideo) {
      fullBlob = file;
      thumbBlob = await generateVideoThumb(file);
      width = 0;
      height = 0;
      compressedSize = file.size;
    } else {
      const compressed = await compressImage(file);
      fullBlob = compressed.blob;
      thumbBlob = compressed.thumbBlob;
      width = compressed.width;
      height = compressed.height;
      compressedSize = compressed.blob.size;
    }

    const photoId = await dbPut('photos', {
      categoryId: categoryId,
      thumbBlob: thumbBlob,
      fileName: file.name,
      fileSize: file.size,
      compressedSize: compressedSize,
      width: width,
      height: height,
      uploadTime: Date.now(),
      note: note,
      mediaType: isVideo ? 'video' : 'image'
    });

    // 原图存到独立 store，仅按需加载
    await dbPut('blobs', { photoId: photoId, blob: fullBlob });
  }

  function getPhotoBlob(id) {
    return dbGet('blobs', id).then(r => {
      if (r && r.blob) return r.blob;
      // 兼容 v1：原图可能还在 photos 中
      return dbGet('photos', id).then(p => (p && p.blob) ? p.blob : null);
    });
  }

  function generateVideoThumb(file) {
    return new Promise((resolve) => {
      let resolved = false;
      const done = (blob) => {
        if (resolved) return;
        resolved = true;
        resolve(blob || new Blob([], { type: 'image/jpeg' }));
      };

      // 超时保护：8秒内未取到帧则用空白缩略图
      const timer = setTimeout(() => { URL.revokeObjectURL(url); done(null); }, 8000);

      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      const url = URL.createObjectURL(file);

      const capture = () => {
        clearTimeout(timer);
        const canvas = document.createElement('canvas');
        canvas.width = 200; canvas.height = 200;
        const ctx = canvas.getContext('2d');
        const minDim = Math.min(video.videoWidth || 200, video.videoHeight || 200);
        if (minDim > 0) {
          try {
            ctx.drawImage(video,
              ((video.videoWidth || 200) - minDim) / 2, ((video.videoHeight || 200) - minDim) / 2, minDim, minDim,
              0, 0, 200, 200);
          } catch (e) { /* ignore draw error */ }
        }
        canvas.toBlob((b) => { URL.revokeObjectURL(url); done(b); }, 'image/webp', 0.7);
        // 若 toBlob 不支持或异步失败，500ms 后降级
        setTimeout(() => { if (!resolved) { URL.revokeObjectURL(url); done(null); } }, 500);
      };

      video.onloadedmetadata = () => {
        // 有些浏览器 loadeddata 不够可靠，用 loadedmetadata + seeked 组合
        if (video.duration > 0) {
          video.currentTime = Math.min(0.5, video.duration * 0.1);
        } else {
          capture();
        }
      };
      video.onseeked = () => { capture(); };
      video.onerror = () => { clearTimeout(timer); URL.revokeObjectURL(url); done(null); };
      video.src = url;

      // 某些格式可能无法 seek，超时后直接尝试截图
      setTimeout(() => {
        if (!resolved && video.duration > 0) {
          try { capture(); } catch (e) { done(null); }
        }
      }, 3000);
    });
  }

  function getFilteredPhotos() {
    let list = [...state.photos];

    // 分类筛选
    if (state.activeCategoryId !== 'all') {
      list = list.filter(p => p.categoryId === state.activeCategoryId);
    }

    // 搜索
    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      list = list.filter(p => {
        const cat = state.categories.find(c => c.id === p.categoryId);
        return (p.note && p.note.toLowerCase().includes(q)) ||
               (p.fileName && p.fileName.toLowerCase().includes(q)) ||
               (cat && cat.name.toLowerCase().includes(q));
      });
    }

    // 排序
    switch (state.sortBy) {
      case 'time-asc': list.sort((a, b) => a.uploadTime - b.uploadTime); break;
      case 'name-asc': list.sort((a, b) => (a.fileName || '').localeCompare(b.fileName || '')); break;
      case 'name-desc': list.sort((a, b) => (b.fileName || '').localeCompare(a.fileName || '')); break;
      default: list.sort((a, b) => b.uploadTime - a.uploadTime); break;
    }

    return list;
  }

  // ==================== UI 渲染 ====================
  function renderCategoryFilter() {
    const list = $('#category-filter-list');
    list.innerHTML = '';
    const allChip = document.createElement('li');
    allChip.className = 'filter-chip';
    allChip.dataset.category = 'all';
    allChip.textContent = '全部';
    if (state.activeCategoryId === 'all') allChip.classList.add('active');
    list.appendChild(allChip);
    state.categories.forEach(c => {
      const chip = document.createElement('li');
      chip.className = 'filter-chip';
      chip.dataset.category = c.id;
      chip.textContent = c.name;
      if (c.id === state.activeCategoryId) chip.classList.add('active');
      list.appendChild(chip);
    });

    // 点击切换
    $$('.filter-chip', list).forEach(chip => {
      chip.addEventListener('click', () => {
        $$('.filter-chip', list).forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        state.activeCategoryId = chip.dataset.category === 'all' ? 'all' : Number(chip.dataset.category);
        renderPhotoGrid();
      });
    });
  }

  function renderPhotoGrid() {
    const grid = $('#photo-grid');
    const emptyState = $('#empty-state');
    const filtered = getFilteredPhotos();
    const vCount = filtered.filter(p => p.mediaType === 'video').length;
    const iCount = filtered.length - vCount;
    const parts = [];
    if (iCount) parts.push(`${iCount} 张图片`);
    if (vCount) parts.push(`${vCount} 个视频`);
    $('#photo-count').textContent = parts.join(' + ') || '0 张图片';

    // 清理旧的 blob URLs，防止内存泄漏
    $$('img', grid).forEach(img => {
      if (img.src && img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
    });

    if (filtered.length === 0) {
      grid.innerHTML = '';
      emptyState.classList.remove('hidden');
    } else {
      emptyState.classList.add('hidden');
      grid.innerHTML = '';
      filtered.forEach(photo => {
        const card = document.createElement('div');
        card.className = 'photo-card';
        card.dataset.photoId = photo.id;
        if (state.isSelectMode) {
          card.classList.add('selectable');
          if (state.selectedPhotos.has(photo.id)) card.classList.add('selected');
        }

        const img = document.createElement('img');
        img.src = URL.createObjectURL(photo.thumbBlob);
        img.loading = 'lazy';

        const overlay = document.createElement('div');
        overlay.className = 'card-overlay';

        const cat = state.categories.find(c => c.id === photo.categoryId);
        const catDot = document.createElement('span');
        catDot.className = 'card-cat';
        catDot.title = cat ? cat.name : '';

        const date = document.createElement('span');
        date.className = 'card-date';
        date.textContent = formatDate(photo.uploadTime);

        overlay.appendChild(catDot);
        overlay.appendChild(date);

        // 选中模式
        if (state.isSelectMode) {
          const check = document.createElement('span');
          check.className = 'select-check';
          check.textContent = state.selectedPhotos.has(photo.id) ? '✓' : '';
          card.appendChild(check);
        }

        card.appendChild(img);

        // 视频播放标记
        if (photo.mediaType === 'video') {
          const badge = document.createElement('div');
          badge.className = 'video-badge';
          card.appendChild(badge);
        }

        card.appendChild(overlay);
        grid.appendChild(card);
      });

      // 事件绑定
      $$('.photo-card', grid).forEach(card => {
        const pid = Number(card.dataset.photoId);
        card.addEventListener('click', () => {
          if (state.isSelectMode) {
            toggleSelect(pid, card);
          } else {
            openViewer(pid);
          }
        });

        let longPressTimer;
        card.addEventListener('pointerdown', () => {
          longPressTimer = setTimeout(() => enterSelectMode(pid), 500);
        });
        card.addEventListener('pointerup', () => clearTimeout(longPressTimer));
        card.addEventListener('pointerleave', () => clearTimeout(longPressTimer));
        card.addEventListener('pointermove', () => clearTimeout(longPressTimer));
      });
    }
  }

  function renderCategoryList() {
    const list = $('#category-list');
    const empty = $('#category-empty');
    if (state.categories.length === 0) {
      list.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    list.innerHTML = '';
    state.categories.forEach(cat => {
      const photoCount = state.photos.filter(p => p.categoryId === cat.id).length;

      const item = document.createElement('li');
      item.className = 'category-item';
      item.draggable = true;
      item.dataset.catId = cat.id;

      const iconDiv = document.createElement('div');
      iconDiv.className = 'cat-icon';
      iconDiv.textContent = cat.coverPhotoId ? '🖼' : '📁';

      const infoDiv = document.createElement('div');
      infoDiv.className = 'cat-info';
      const nameDiv = document.createElement('div');
      nameDiv.className = 'cat-name';
      nameDiv.textContent = cat.name;
      const countDiv = document.createElement('div');
      countDiv.className = 'cat-count';
      const imgCount = state.photos.filter(p => p.categoryId === cat.id && p.mediaType !== 'video').length;
      const vidCount = photoCount - imgCount;
      const descParts = [];
      if (imgCount) descParts.push(`${imgCount} 张图片`);
      if (vidCount) descParts.push(`${vidCount} 个视频`);
      countDiv.textContent = descParts.join(' + ') || '0 张图片';

      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'cat-actions';
      const editBtn = document.createElement('button');
      editBtn.className = 'btn-sm edit-cat';
      editBtn.dataset.id = cat.id;
      editBtn.title = '编辑';
      editBtn.textContent = '✎';
      const delBtn = document.createElement('button');
      delBtn.className = 'btn-sm del-cat';
      delBtn.dataset.id = cat.id;
      delBtn.title = '删除';
      delBtn.textContent = '✕';

      infoDiv.appendChild(nameDiv);
      infoDiv.appendChild(countDiv);
      actionsDiv.appendChild(editBtn);
      actionsDiv.appendChild(delBtn);
      item.appendChild(iconDiv);
      item.appendChild(infoDiv);
      item.appendChild(actionsDiv);
      list.appendChild(item);
    });

    // 点击编辑
    $$('.edit-cat', list).forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = Number(btn.dataset.id);
        const cat = state.categories.find(c => c.id === id);
        const newName = await showInput('编辑分类名称', '输入新名称', cat.name);
        if (newName) {
          await updateCategory(id, { name: newName });
          renderAll();
        }
      });
    });

    // 点击删除
    $$('.del-cat', list).forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = Number(btn.dataset.id);
        const cat = state.categories.find(c => c.id === id);
        const confirmed = await showConfirm(`确定删除分类「${cat.name}」？`);
        if (confirmed) {
          await deleteCategory(id);
          renderAll();
        }
      });
    });

    // 拖动排序
    let dragSrcId = null;
    $$('.category-item', list).forEach(item => {
      item.addEventListener('dragstart', (e) => {
        dragSrcId = Number(item.dataset.catId);
        item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      item.addEventListener('dragend', (e) => {
        item.classList.remove('dragging');
        $$('.category-item', list).forEach(i => i.classList.remove('dragging'));
      });
      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      });
      item.addEventListener('drop', async (e) => {
        e.preventDefault();
        const targetId = Number(item.dataset.catId);
        if (dragSrcId !== null && dragSrcId !== targetId) {
          const cats = [...state.categories];
          const srcIdx = cats.findIndex(c => c.id === dragSrcId);
          const tgtIdx = cats.findIndex(c => c.id === targetId);
          const [moved] = cats.splice(srcIdx, 1);
          cats.splice(tgtIdx, 0, moved);
          for (let i = 0; i < cats.length; i++) {
            cats[i].sortOrder = i;
            await dbPut('categories', cats[i]);
          }
          await loadCategories();
          renderAll();
        }
        dragSrcId = null;
      });
    });
  }

  function renderStorageInfo() {
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(est => {
        const used = est.usage || 0;
        const quota = est.quota || 0;
        const pct = quota > 0 ? (used / quota * 100).toFixed(1) : 0;
        $('#storage-used-text').textContent = `${formatSize(used)} / ${formatSize(quota)}`;
        $('#storage-left-text').textContent = `已用 ${pct}%`;
        const bar = $('#storage-bar-fill');
        bar.style.width = pct + '%';
        bar.classList.remove('warning', 'danger');
        if (pct > 90) bar.classList.add('danger');
        else if (pct > 80) bar.classList.add('warning');
      });
    } else {
      let total = 0;
      state.photos.forEach(p => total += p.compressedSize || p.fileSize || 0);
      $('#storage-used-text').textContent = '已用: ' + formatSize(total);
    }
  }

  async function renderLastBackupTime() {
    const meta = await dbGet('metadata', 'lastBackupTime');
    if (meta) {
      $('#last-backup-time').textContent = '上次备份: ' + formatDate(meta.value);
    } else {
      $('#last-backup-time').textContent = '';
    }
  }

  function renderAll() {
    renderCategoryFilter();
    renderPhotoGrid();
    renderCategoryList();
    renderStorageInfo();
    renderLastBackupTime();
  }

  // ==================== 选择模式 ====================
  function enterSelectMode(initialId) {
    state.isSelectMode = true;
    state.selectedPhotos.clear();
    if (initialId) state.selectedPhotos.add(initialId);
    $('#batch-bar').classList.remove('hidden');
    $('#btn-upload').classList.add('hidden');
    updateBatchCount();
    renderPhotoGrid();
  }

  function exitSelectMode() {
    state.isSelectMode = false;
    state.selectedPhotos.clear();
    $('#batch-bar').classList.add('hidden');
    $('#btn-upload').classList.remove('hidden');
    renderPhotoGrid();
  }

  function toggleSelect(photoId, card) {
    if (state.selectedPhotos.has(photoId)) {
      state.selectedPhotos.delete(photoId);
      card.classList.remove('selected');
    } else {
      state.selectedPhotos.add(photoId);
      card.classList.add('selected');
    }
    updateBatchCount();
  }

  function updateBatchCount() {
    $('#batch-count').textContent = `已选 ${state.selectedPhotos.size} 张`;
  }

  // ==================== 大图查看 ====================
  function openViewer(photoId) {
    const filtered = getFilteredPhotos();
    state.viewerPhotos = filtered;
    state.viewerIndex = filtered.findIndex(p => p.id === photoId);
    if (state.viewerIndex === -1) state.viewerIndex = 0;
    showViewer();
  }

  // 查看器的全局触摸状态（每次 showViewer 重建 track，但状态引用通过闭包实时获取）
  let _viewerStartX = 0, _viewerStartY = 0;
  let _viewerDragging = false;
  let _viewerPinchStartDist = 0;
  let _viewerPinchStartScale = 1;
  let _viewerCurrentScale = 1;
  let _viewerZoomImg = null; // 当前被缩放的 img 元素

  async function showViewer() {
    const viewer = $('#viewer');
    const swiper = $('#viewer-swiper');
    viewer.classList.remove('hidden');

    // 清理旧的 blob URLs 防止内存泄漏
    $$('img, video', swiper).forEach(el => {
      if (el.src && el.src.startsWith('blob:')) URL.revokeObjectURL(el.src);
    });
    swiper.innerHTML = '';

    const total = state.viewerPhotos.length;
    if (total === 0) { closeViewer(); return; }

    const track = document.createElement('div');
    track.className = 'swiper-track';
    track.style.width = (total * 100) + '%';
    const offsetPer = 100 / total;

    const getOffset = (idx) => -(idx * offsetPer);
    track.style.transform = `translateX(${getOffset(state.viewerIndex)}%)`;

    // 重置缩放
    _viewerCurrentScale = 1;
    _viewerZoomImg = null;

    // 只加载当前页的原图（await），其余先显示缩略图
    const curPhoto = state.viewerPhotos[state.viewerIndex];
    if (!curPhoto) { closeViewer(); return; }
    let curFullBlob = null;
    try { curFullBlob = await getPhotoBlob(curPhoto.id); } catch (e) { /* ignore */ }

    for (let idx = 0; idx < total; idx++) {
      const photo = state.viewerPhotos[idx];
      const slide = document.createElement('div');
      slide.className = 'viewer-slide';
      slide.style.width = offsetPer + '%';

      const isCurrent = (idx === state.viewerIndex);

      if (isCurrent && curFullBlob && photo.mediaType === 'video') {
        const video = document.createElement('video');
        video.src = URL.createObjectURL(curFullBlob);
        video.controls = true;
        video.playsInline = true;
        video.setAttribute('playsinline', '');
        video.preload = 'metadata';
        video.style.width = '100%';
        video.style.maxHeight = '70vh';
        slide.appendChild(video);
      } else {
        const img = document.createElement('img');
        const srcBlob = (isCurrent && curFullBlob && photo.mediaType !== 'video')
          ? curFullBlob
          : photo.thumbBlob;
        const blobUrl = URL.createObjectURL(srcBlob);
        img.src = blobUrl;
        img.draggable = false;
        img.style.maxWidth = '100%';
        img.style.maxHeight = '70vh';
        img.style.objectFit = 'contain';
        img.style.borderRadius = '4px';
        img.style.transformOrigin = 'center center';
        img.style.willChange = 'transform';
        img.onerror = () => {
          if (img.src !== blobUrl) return;
          if (isCurrent && curFullBlob && photo.thumbBlob) {
            URL.revokeObjectURL(blobUrl);
            img.src = URL.createObjectURL(photo.thumbBlob);
          }
        };
        slide._img = img;
        slide.appendChild(img);

        // 当前图片标记为可缩放目标
        if (isCurrent && photo.mediaType !== 'video') {
          _viewerZoomImg = img;
        }
      }

      track.appendChild(slide);
    }
    swiper.appendChild(track);

    // 后台预加载相邻原图（±2）
    for (let d = -2; d <= 2; d++) {
      if (d === 0) continue;
      const ni = state.viewerIndex + d;
      if (ni < 0 || ni >= total) continue;
      const p = state.viewerPhotos[ni];
      getPhotoBlob(p.id).then(blob => {
        if (!blob || p.mediaType === 'video') return;
        const s = track.children[ni];
        if (s && s._img) {
          s._img.onerror = null;
          const oldUrl = s._img.src;
          s._img.src = URL.createObjectURL(blob);
          if (oldUrl && oldUrl.startsWith('blob:')) URL.revokeObjectURL(oldUrl);
        }
      }).catch(() => {});
    }

    updateViewerInfo();
  }

  // ---- 触摸事件：统一绑定到 swiper，每次都实时查询 DOM ----
  function _getViewerTrack() {
    return $('#viewer-swiper').querySelector('.swiper-track');
  }

  function _viewerHandleTouchStart(e) {
    const touches = e.touches;
    if (touches.length === 1) {
      // 单指：滑动
      if (e.target.closest('video')) return;
      _viewerStartX = touches[0].clientX;
      _viewerStartY = touches[0].clientY;
      _viewerDragging = false;
      const track = _getViewerTrack();
      if (track) track.style.transition = 'none';
    } else if (touches.length === 2) {
      // 双指：缩放
      _viewerDragging = false;
      const dx = touches[0].clientX - touches[1].clientX;
      const dy = touches[0].clientY - touches[1].clientY;
      _viewerPinchStartDist = Math.hypot(dx, dy);
      _viewerPinchStartScale = _viewerCurrentScale;
    }
  }

  function _viewerHandleTouchMove(e) {
    const touches = e.touches;

    if (touches.length === 2 && _viewerZoomImg) {
      // 双指缩放
      const dx = touches[0].clientX - touches[1].clientX;
      const dy = touches[0].clientY - touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      if (_viewerPinchStartDist > 0) {
        const rawScale = _viewerPinchStartScale * (dist / _viewerPinchStartDist);
        _viewerCurrentScale = Math.max(1, Math.min(rawScale, 5));
        _viewerZoomImg.style.transform = `scale(${_viewerCurrentScale})`;
      }
      return;
    }

    if (touches.length !== 1) return;
    if (e.target.closest('video')) return;
    // 如果当前在缩放状态，单指不滑动，让用户先恢复
    if (_viewerCurrentScale > 1) return;

    const dx = touches[0].clientX - _viewerStartX;
    const dy = Math.abs(touches[0].clientY - _viewerStartY);
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 5) {
      _viewerDragging = true;
      const track = _getViewerTrack();
      if (!track) return;
      const swiperW = $('#viewer-swiper').clientWidth;
      const totalPics = state.viewerPhotos.length;
      const offsetSingle = 100 / totalPics;
      const deltaPct = (dx / swiperW) * offsetSingle;
      const baseOff = -(state.viewerIndex * offsetSingle);
      const raw = baseOff + deltaPct;
      // 限制弹性范围：只能看到相邻一张，不能无限滑动
      const upperBound = (state.viewerIndex > 0) ? baseOff + offsetSingle + 8 : 0 + 8;
      const lowerBound = (state.viewerIndex < totalPics - 1) ? baseOff - offsetSingle - 8 : baseOff - 8;
      track.style.transform = `translateX(${Math.max(lowerBound, Math.min(upperBound, raw))}%)`;
    }
  }

  function _viewerHandleTouchEnd(e) {
    if (_viewerCurrentScale > 1 && !_viewerDragging) return; // 缩放中不处理滑动
    if (!e.changedTouches || e.changedTouches.length === 0) return;

    const dx = e.changedTouches[0].clientX - _viewerStartX;
    const swiperW = $('#viewer-swiper').clientWidth;
    const totalPics = state.viewerPhotos.length;
    const threshold = swiperW * 0.2;
    const track = _getViewerTrack();
    if (track) track.style.transition = 'transform 0.3s ease-out';

    if (_viewerDragging && Math.abs(dx) > threshold) {
      const prevIdx = state.viewerIndex;
      if (dx < 0 && state.viewerIndex < totalPics - 1) state.viewerIndex++;
      else if (dx > 0 && state.viewerIndex > 0) state.viewerIndex--;

      if (state.viewerIndex !== prevIdx) {
        // 暂停视频，重置缩放
        if (track) $$('video', track).forEach(v => v.pause());
        _viewerCurrentScale = 1;
        _viewerZoomImg = null;

        updateViewerInfo();
        // 加载新位置原图
        const cur = state.viewerPhotos[state.viewerIndex];
        const curSlide = track ? track.children[state.viewerIndex] : null;
        if (curSlide && curSlide._img && cur.mediaType !== 'video') {
          _viewerZoomImg = curSlide._img;
          _viewerZoomImg.style.transform = 'scale(1)';
        }
        getPhotoBlob(cur.id).then(blob => {
          if (blob && curSlide && curSlide._img && cur.mediaType !== 'video') {
            const oldUrl = curSlide._img.src;
            curSlide._img.src = URL.createObjectURL(blob);
            if (oldUrl && oldUrl.startsWith('blob:')) URL.revokeObjectURL(oldUrl);
          }
        }).catch(() => {});
      }
    }

    if (track) {
      const offsetPer = 100 / totalPics;
      track.style.transform = `translateX(-${state.viewerIndex * offsetPer}%)`;
    }
  }

  function updateViewerInfo() {
    if (state.viewerPhotos.length === 0) return;
    const photo = state.viewerPhotos[state.viewerIndex];
    if (!photo) return;
    $('#viewer-counter').textContent = `${state.viewerIndex + 1} / ${state.viewerPhotos.length}`;
    $('#viewer-note').textContent = photo.note || '无备注';
    $('#viewer-date').textContent = formatDate(photo.uploadTime);
    const cat = state.categories.find(c => c.id === photo.categoryId);
    $('#viewer-category').textContent = cat ? `分类: ${cat.name}` : '';
  }

  function closeViewer() {
    const swiper = $('#viewer-swiper');
    $$('img, video', swiper).forEach(el => {
      if (el.src && el.src.startsWith('blob:')) URL.revokeObjectURL(el.src);
    });
    $$('video', swiper).forEach(v => v.pause());
    $('#viewer').classList.add('hidden');
    swiper.innerHTML = '';
    _viewerCurrentScale = 1;
    _viewerZoomImg = null;
  }

  // 触摸事件只绑定一次，但每次都实时查询 DOM 中的 track
  (function _bindViewerEvents() {
    const swiper = $('#viewer-swiper');
    swiper.addEventListener('touchstart', _viewerHandleTouchStart, { passive: true });
    swiper.addEventListener('touchmove', _viewerHandleTouchMove, { passive: true });
    swiper.addEventListener('touchend', _viewerHandleTouchEnd, { passive: true });
  })();

  // ==================== 导出导入 ====================
  async function exportBackup() {
    if (typeof JSZip === 'undefined') {
      showToast('正在加载压缩库，请稍后再试');
      return;
    }
    showToast('正在导出备份...', 3000);
    const zip = new JSZip();
    const cats = await dbGetAll('categories');
    const photos = await dbGetAll('photos');

    zip.file('categories.json', JSON.stringify(cats));

    const blobs = await dbGetAll('blobs');
    const blobMap = {};
    blobs.forEach(b => { blobMap[b.photoId] = b.blob; });

    const photosMeta = photos.map(p => {
      let fileExt;
      if (p.mediaType === 'video') {
        fileExt = (p.fileName && p.fileName.includes('.')) ? p.fileName.split('.').pop() : 'mp4';
      } else {
        fileExt = 'jpg';
      }
      return {
        id: p.id, categoryId: p.categoryId, fileName: p.fileName,
        uploadTime: p.uploadTime, note: p.note, width: p.width, height: p.height,
        fileSize: p.fileSize, compressedSize: p.compressedSize,
        mediaType: p.mediaType || 'image', fileExt: fileExt
      };
    });
    zip.file('photos.json', JSON.stringify(photosMeta));

    const imgFolder = zip.folder('images');
    for (const p of photos) {
      const meta = photosMeta.find(m => m.id === p.id);
      const blob = blobMap[p.id];
      if (blob) imgFolder.file(`${p.id}.${meta.fileExt}`, blob);
    }

    const content = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(content);
    const a = document.createElement('a');
    a.href = url;
    a.download = `stanly-album-backup-${formatDate(Date.now())}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    await dbPut('metadata', { key: 'lastBackupTime', value: Date.now() });
    renderLastBackupTime();
    showToast('导出完成');
  }

  async function importBackup(file) {
    if (typeof JSZip === 'undefined') {
      showToast('正在加载压缩库，请稍后再试');
      return;
    }
    showToast('正在导入备份...', 5000);
    try {
      const zip = await JSZip.loadAsync(file);

      const catsJson = await zip.file('categories.json')?.async('string');
      const photosJson = await zip.file('photos.json')?.async('string');
      if (!catsJson || !photosJson) { showToast('备份文件格式无效'); return; }

      const cats = JSON.parse(catsJson);
      const photosMeta = JSON.parse(photosJson);

      // 清空现有数据
      await dbClear('categories');
      await dbClear('photos');
      await dbClear('blobs');

      // 恢复分类
      const catIdMap = {};
      for (const c of cats) {
        const oldId = c.id;
        delete c.id;
        const newId = await dbPut('categories', c);
        catIdMap[oldId] = newId;
      }

      // 恢复媒体文件
      for (const p of photosMeta) {
        const ext = p.fileExt || 'jpg';
        const mediaFile = zip.file(`images/${p.id}.${ext}`);
        let fullBlob = null;
        if (mediaFile) {
          fullBlob = await mediaFile.async('blob');
        }

        // 生成缩略图
        let thumbBlob = null;
        if (fullBlob) {
          if (p.mediaType === 'video') {
            thumbBlob = await generateVideoThumbFromBlob(fullBlob, ext);
          } else {
            thumbBlob = await generateThumb(fullBlob);
          }
        }

        const photoId = await dbPut('photos', {
          categoryId: catIdMap[p.categoryId] || p.categoryId,
          thumbBlob: thumbBlob,
          fileName: p.fileName || '',
          fileSize: p.fileSize || 0,
          compressedSize: p.compressedSize || 0,
          width: p.width || 0,
          height: p.height || 0,
          uploadTime: p.uploadTime || Date.now(),
          note: p.note || '',
          mediaType: p.mediaType || 'image'
        });

        if (fullBlob) {
          await dbPut('blobs', { photoId: photoId, blob: fullBlob });
        }
      }

      await loadCategories();
      await loadPhotos();
      renderAll();
      showToast('导入完成');
    } catch (err) {
      showToast('导入失败: ' + err.message);
    }
  }

  function generateThumb(blob) {
    return new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(blob);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const canvas = document.createElement('canvas');
        canvas.width = 200; canvas.height = 200;
        const ctx = canvas.getContext('2d');
        const minDim = Math.min(img.width, img.height);
        ctx.drawImage(img,
          (img.width - minDim) / 2, (img.height - minDim) / 2, minDim, minDim,
          0, 0, 200, 200
        );
        canvas.toBlob(resolve, 'image/webp', 0.7);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(new Blob([], { type: 'image/webp' })); };
      img.src = url;
    });
  }

  function generateVideoThumbFromBlob(blob, ext) {
    const mime = ext === 'webm' ? 'video/webm' : ext === 'mov' ? 'video/quicktime' : 'video/mp4';
    const file = new File([blob], 'temp.' + ext, { type: mime });
    return generateVideoThumb(file);
  }

  // ==================== 事件绑定 ====================
  function bindEvents() {
    // Tab 切换
    $$('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        state.currentTab = btn.dataset.tab;
        $$('.nav-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        $$('.tab-page').forEach(p => p.classList.remove('active'));
        $(`#tab-${state.currentTab}`).classList.add('active');
        if (state.currentTab === 'settings') renderStorageInfo();
      });
    });

    // 上传按钮
    $('#btn-upload').addEventListener('click', () => {
      $('#upload-sheet').classList.remove('hidden');
    });

    // 上传弹窗
    $('#upload-cancel').addEventListener('click', () => $('#upload-sheet').classList.add('hidden'));
    $('.sheet-backdrop').addEventListener('click', () => $('#upload-sheet').classList.add('hidden'));
    $('#upload-gallery').addEventListener('click', () => {
      $('#upload-sheet').classList.add('hidden');
      $('#file-input').click();
    });
    $('#upload-photo').addEventListener('click', () => {
      $('#upload-sheet').classList.add('hidden');
      $('#photo-input').click();
    });
    $('#upload-video').addEventListener('click', () => {
      $('#upload-sheet').classList.add('hidden');
      $('#video-input').click();
    });

    // 文件选择处理
    $('#file-input').addEventListener('change', () => handleFiles($('#file-input').files));
    $('#photo-input').addEventListener('change', () => handleFiles($('#photo-input').files));
    $('#video-input').addEventListener('change', () => handleFiles($('#video-input').files));

    // 搜索
    $('#search-input').addEventListener('input', () => {
      state.searchQuery = $('#search-input').value;
      $('#btn-search-clear').classList.toggle('hidden', !state.searchQuery);
      renderPhotoGrid();
    });
    $('#btn-search-clear').addEventListener('click', () => {
      $('#search-input').value = '';
      state.searchQuery = '';
      $('#btn-search-clear').classList.add('hidden');
      renderPhotoGrid();
    });

    // 排序
    $('#sort-select').addEventListener('change', () => {
      state.sortBy = $('#sort-select').value;
      renderPhotoGrid();
    });

    // 批量选择
    $('#btn-select-mode').addEventListener('click', () => {
      if (state.isSelectMode) exitSelectMode();
      else enterSelectMode();
    });
    $('#btn-batch-cancel').addEventListener('click', exitSelectMode);
    $('#btn-batch-delete').addEventListener('click', async () => {
      if (state.selectedPhotos.size === 0) return;
      const confirmed = await showConfirm(`确定删除选中的 ${state.selectedPhotos.size} 张图片？`);
      if (confirmed) {
        for (const id of state.selectedPhotos) { await dbDelete('photos', id); await dbDelete('blobs', id); }
        await loadPhotos();
        exitSelectMode();
        renderAll();
        showToast('删除完成');
      }
    });

    // 新增分类
    $('#btn-add-category').addEventListener('click', async () => {
      const name = await showInput('新增分类', '输入分类名称');
      if (name) {
        await addCategory(name);
        renderAll();
        showToast('分类已创建');
      }
    });

    // 查看器关闭
    $('#btn-viewer-back').addEventListener('click', closeViewer);

    // 查看器删除
    $('#btn-viewer-delete').addEventListener('click', async () => {
      const photo = state.viewerPhotos[state.viewerIndex];
      if (!photo) return;
      const confirmed = await showConfirm('确定删除此图片？');
      if (confirmed) {
        await dbDelete('photos', photo.id); await dbDelete('blobs', photo.id);
        state.viewerPhotos.splice(state.viewerIndex, 1);
        await loadPhotos();
        if (state.viewerPhotos.length === 0) {
          closeViewer();
          renderAll();
        } else {
          if (state.viewerIndex >= state.viewerPhotos.length) state.viewerIndex = state.viewerPhotos.length - 1;
          showViewer();
        }
        renderAll();
      }
    });

    // 查看器编辑备注
    $('#btn-viewer-edit').addEventListener('click', async () => {
      const photo = state.viewerPhotos[state.viewerIndex];
      if (!photo) return;
      const note = await showInput('编辑备注', '输入图片备注', photo.note || '');
      if (note !== null) {
        photo.note = note;
        await dbPut('photos', photo);
        await loadPhotos();
        updateViewerInfo();
        renderPhotoGrid();
      }
    });

    // 查看器分享
    $('#btn-viewer-share').addEventListener('click', async () => {
      const photo = state.viewerPhotos[state.viewerIndex];
      if (!photo) return;
      const blob = await getPhotoBlob(photo.id);
      if (blob && navigator.share && navigator.canShare) {
        const file = new File([blob], photo.fileName || 'photo.webp', { type: blob.type || 'image/webp' });
        const data = { files: [file], title: '史丹利相册分享', text: photo.note || '' };
        if (navigator.canShare(data)) {
          navigator.share(data).catch(() => {});
          return;
        }
      }
      if (navigator.clipboard) {
        navigator.clipboard.writeText(photo.note || '').then(() => showToast('备注已复制'));
      }
    });

    // 导出
    $('#btn-export').addEventListener('click', exportBackup);

    // 导入
    $('#btn-import').addEventListener('click', () => $('#import-input').click());
    $('#import-input').addEventListener('change', async () => {
      const file = $('#import-input').files[0];
      if (file) {
        const confirmed = await showConfirm('导入备份将覆盖当前所有数据，确定继续？');
        if (confirmed) await importBackup(file);
      }
      $('#import-input').value = '';
    });

    // 清空
    $('#btn-clear-all').addEventListener('click', async () => {
      const confirmed = await showConfirm('此操作将删除所有图片和分类，且不可恢复！建议先导出备份。确定继续？');
      if (confirmed) {
        await dbClear('photos');
        await dbClear('blobs');
        await dbClear('categories');
        state.categories = [];
        state.photos = [];
        state.activeCategoryId = 'all';
        renderAll();
        showToast('所有数据已清空');
      }
    });

    // 压缩设置
    $('#compress-quality').addEventListener('input', () => {
      state.compressQuality = Number($('#compress-quality').value) / 100;
      $('#quality-label').textContent = $('#compress-quality').value + '%';
      dbPut('metadata', { key: 'compressQuality', value: state.compressQuality });
    });
    $('#compress-max-width').addEventListener('input', () => {
      state.compressMaxWidth = Number($('#compress-max-width').value);
      $('#max-width-label').textContent = $('#compress-max-width').value + 'px';
      dbPut('metadata', { key: 'compressMaxWidth', value: state.compressMaxWidth });
    });

    // 键盘/手势关闭查看器
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('#viewer').classList.contains('hidden')) closeViewer();
    });
  }

  // ==================== 分类选择器 ====================
  function pickCategory() {
    return new Promise((resolve) => {
      const sheet = $('#category-picker');
      const list = $('#category-picker-list');

      // 渲染分类列表
      list.innerHTML = '';
      state.categories.forEach(cat => {
        const imgCount = state.photos.filter(p => p.categoryId === cat.id && p.mediaType !== 'video').length;
        const vidCount = state.photos.filter(p => p.categoryId === cat.id && p.mediaType === 'video').length;
        const descParts = [];
        if (imgCount) descParts.push(`${imgCount} 张图片`);
        if (vidCount) descParts.push(`${vidCount} 个视频`);
        const countText = descParts.join(' + ') || '0 张图片';

        const btn = document.createElement('button');
        btn.className = 'cat-picker-item';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'cat-picker-name';
        nameSpan.textContent = cat.name;
        const countSpan = document.createElement('span');
        countSpan.className = 'cat-picker-count';
        countSpan.textContent = countText;
        btn.appendChild(nameSpan);
        btn.appendChild(countSpan);
        btn.addEventListener('click', () => {
          sheet.classList.add('hidden');
          resolve(cat.id);
        });
        list.appendChild(btn);
      });

      // 新建分类
      const newBtn = $('#category-picker-new');
      const newHandler = async () => {
        sheet.classList.add('hidden');
        const name = await showInput('新建分类', '输入分类名称（如：现代简约）');
        if (!name) { resolve(null); return; }
        const id = await addCategory(name);
        await loadPhotos();
        renderAll();
        resolve(id);
      };

      // 取消
      const cancelHandler = () => { sheet.classList.add('hidden'); resolve(null); };

      // 如果没有任何分类，直接弹出新建对话框
      if (state.categories.length === 0) {
        showInput('创建第一个分类', '输入分类名称（如：现代简约）').then(async (name) => {
          if (!name) { resolve(null); return; }
          const id = await addCategory(name);
          await loadPhotos();
          renderAll();
          resolve(id);
        });
        return;
      }

      // 显示弹窗
      sheet.classList.remove('hidden');

      // 绑定事件（once 避免重复绑定）
      newBtn.addEventListener('click', newHandler, { once: true });
      $('#category-picker-cancel').addEventListener('click', cancelHandler, { once: true });
      $('.sheet-backdrop', sheet).addEventListener('click', cancelHandler, { once: true });
    });
  }

  // ==================== 上传处理 ====================
  async function handleFiles(files) {
    if (!files || files.length === 0) return;
    const fileArr = [...files].filter(f => f.type.startsWith('image/') || f.type.startsWith('video/'));

    if (fileArr.length === 0) { showToast('请选择图片或视频文件'); return; }

    // 选择分类
    const categoryId = await pickCategory();
    if (!categoryId) return; // 用户取消

    const mediaCount = fileArr.filter(f => f.type.startsWith('video/')).length;
    const imgCount = fileArr.length - mediaCount;
    const parts = [];
    if (imgCount) parts.push(`${imgCount} 张图片`);
    if (mediaCount) parts.push(`${mediaCount} 个视频`);
    showToast(`正在处理 ${parts.join(' + ')}...`, 120000);

    let successCount = 0;
    const failedNames = [];

    for (let i = 0; i < fileArr.length; i++) {
      const f = fileArr[i];
      try {
        await addMedia(f, categoryId, '');
        successCount++;
      } catch (err) {
        console.error('Upload error:', f.name, err);
        failedNames.push(f.name);
      }
    }

    // 全部完成后再加载一次
    await loadPhotos();

    // 设置当前分类为上传的分类
    state.activeCategoryId = categoryId;

    // 切回相册 tab
    state.currentTab = 'album';
    $$('.nav-btn').forEach(b => b.classList.remove('active'));
    $('[data-tab="album"]').classList.add('active');
    $$('.tab-page').forEach(p => p.classList.remove('active'));
    $('#tab-album').classList.add('active');

    renderAll();

    // 结果提示
    if (successCount === 0) {
      showToast('上传失败，请重试');
    } else if (failedNames.length > 0) {
      showToast(`已添加 ${successCount}/${fileArr.length} 个（${failedNames.length} 个失败）`);
    } else {
      if (mediaCount && !imgCount) showToast(`已添加 ${fileArr.length} 个视频`);
      else if (!mediaCount) showToast(`已添加 ${fileArr.length} 张图片`);
      else showToast(`已添加 ${imgCount} 张图片 + ${mediaCount} 个视频`);
    }

    // 重置 input
    $('#file-input').value = '';
    $('#photo-input').value = '';
    $('#video-input').value = '';
  }

  // ==================== 初始化 ====================
  async function loadSettings() {
    const q = await dbGet('metadata', 'compressQuality');
    if (q) {
      state.compressQuality = q.value;
      $('#compress-quality').value = Math.round(q.value * 100);
      $('#quality-label').textContent = Math.round(q.value * 100) + '%';
    }
    const w = await dbGet('metadata', 'compressMaxWidth');
    if (w) {
      state.compressMaxWidth = w.value;
      $('#compress-max-width').value = w.value;
      $('#max-width-label').textContent = w.value + 'px';
    }
  }

  async function init() {
    const loading = document.getElementById('loading-screen');

    try {
      await openDB();
      await loadCategories();
      await loadPhotos();
      await loadSettings();
      renderAll();
      bindEvents();

      // 隐藏启动画面
      if (loading) { loading.style.opacity = '0'; loading.style.transition = 'opacity 0.3s'; setTimeout(() => loading.remove(), 350); }

      // 注册 Service Worker
      if ('serviceWorker' in navigator) {
        try {
          await navigator.serviceWorker.register('sw.js');
        } catch (e) {
          // 开发环境可能无 SW
        }
      }
    } catch (e) {
      // 初始化失败也要隐藏加载画面，显示错误提示
      console.error('Init failed:', e);
      if (loading) {
        loading.innerHTML = `<div style="text-align:center;padding:20px;">
          <p style="color:#c00;font-size:16px;">加载失败</p>
          <p style="color:#999;font-size:12px;margin-top:8px;">${e.message || '未知错误'}</p>
          <button onclick="location.reload()" style="margin-top:16px;padding:8px 24px;background:#8B6914;color:#fff;border:none;border-radius:4px;">重试</button>
        </div>`;
      }
    }
  }

  // DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
