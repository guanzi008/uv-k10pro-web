// SPDX-License-Identifier: MIT
import { pageBytesToPixels, pixelsToPageBytes } from '../core/settings-codec.mjs';

/** Local 128x64 monochrome editor. Source images never leave this browser. */
export function openBitmapEditor({ pageBytes, onSave }) {
  let pixels = pageBytesToPixels(pageBytes), painting = false, ink = 1, source = null;
  const el = (tag, text, className) => { const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; };
  const dialog = el('dialog', '', 'modal bitmap-modal');
  dialog.setAttribute('aria-label', '128 × 64 开机图像编辑器');
  const header = el('header', '', 'modal-header'); header.append(el('h2', '开机图像 · 128 × 64'));
  const close = el('button', '关闭', 'button button-quiet'); close.type = 'button'; close.onclick = () => dialog.close(); header.append(close);
  const body = el('div', '', 'modal-body'); body.append(el('p', '在网格上绘制黑白像素，或选择本地图像缩放转换。保存后先审阅工作区差分。'));
  const canvas = el('canvas'); canvas.width = 128; canvas.height = 64;
  canvas.style.cssText = 'display:block;width:100%;max-width:640px;aspect-ratio:2;image-rendering:pixelated;touch-action:none;border:1px solid #9eb5c7;background:#fff;cursor:crosshair';
  canvas.setAttribute('aria-label', '128 × 64 黑白图像预览与鼠标绘制区域');
  const context = canvas.getContext('2d'); if (!context) throw new Error('浏览器不支持 Canvas 图像编辑。');
  function render() {
    const image = context.createImageData(128, 64);
    pixels.forEach((black, index) => { const value = black ? 0 : 255; image.data.set([value, value, value, 255], index * 4); });
    context.putImageData(image, 0, 0);
  }
  function paint(event) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(127, Math.floor((event.clientX - rect.left) * 128 / rect.width)));
    const y = Math.max(0, Math.min(63, Math.floor((event.clientY - rect.top) * 64 / rect.height)));
    pixels[y * 128 + x] = ink; render();
  }
  canvas.onpointerdown = event => { painting = true; canvas.setPointerCapture(event.pointerId); paint(event); };
  canvas.onpointermove = event => { if (painting) paint(event); };
  canvas.onpointerup = canvas.onpointercancel = () => { painting = false; };
  const toolbar = el('div', '', 'toolbar');
  const inkButton = el('button', '画笔：黑色', 'button button-outline'); inkButton.type = 'button';
  inkButton.onclick = () => { ink = 1 - ink; inkButton.textContent = `画笔：${ink ? '黑色' : '白色'}`; };
  const invert = el('button', '反色', 'button button-outline'); invert.type = 'button'; invert.onclick = () => { pixels = pixels.map(p => 1 - p); render(); };
  const clear = el('button', '清空', 'button button-outline'); clear.type = 'button'; clear.onclick = () => { pixels.fill(0); render(); };
  toolbar.append(inkButton, invert, clear);
  const imageLabel = el('label', '导入本地图像（最大 8 MiB）');
  const file = el('input'); file.type = 'file'; file.accept = 'image/png,image/jpeg,image/bmp,image/webp';
  imageLabel.append(file);
  const thresholdLabel = el('label', '黑白阈值：128');
  const threshold = el('input'); threshold.type = 'range'; threshold.min = '0'; threshold.max = '255'; threshold.value = '128';
  threshold.setAttribute('aria-label', '黑白转换阈值'); thresholdLabel.append(threshold);
  const error = el('p', '', 'form-error'); error.setAttribute('role', 'alert');
  function convert() {
    if (!source) return;
    const offscreen = document.createElement('canvas'); offscreen.width = 128; offscreen.height = 64;
    const ctx = offscreen.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 128, 64); ctx.drawImage(source, 0, 0, 128, 64);
    const data = ctx.getImageData(0, 0, 128, 64).data, cutoff = Number(threshold.value);
    pixels = Uint8Array.from({ length: 8192 }, (_, i) => 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2] < cutoff ? 1 : 0);
    render();
  }
  file.onchange = async () => {
    try {
      const selected = file.files[0]; if (!selected) return;
      if (selected.size > 8 * 1024 * 1024) throw new Error('图像超过 8 MiB。');
      const image = await createImageBitmap(selected);
      source?.close(); source = image; error.textContent = ''; convert();
    } catch (e) { error.textContent = e.message; }
    finally { file.value = ''; }
  };
  threshold.oninput = () => { thresholdLabel.firstChild.textContent = `黑白阈值：${threshold.value}`; convert(); };
  body.append(canvas, toolbar, imageLabel, thresholdLabel, error);
  const footer = el('footer', '', 'modal-footer'), save = el('button', '应用到工作区', 'button button-primary'); save.type = 'button';
  save.onclick = async () => { try { await onSave(pixelsToPageBytes(pixels)); dialog.close(); } catch (e) { error.textContent = e.message; } };
  footer.append(save); dialog.append(header, body, footer);
  dialog.addEventListener('close', () => { source?.close(); dialog.remove(); }, { once: true });
  document.body.append(dialog); render(); dialog.showModal();
}
