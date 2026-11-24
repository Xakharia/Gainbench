import JSZip from 'jszip';

export interface PickedAudioFile {
  file: File;
  fileHandle?: FileSystemFileHandle;
  parentDirHandle?: FileSystemDirectoryHandle;
}

export interface FileSystemCapabilities {
  hasFilePickerApi: boolean;
  isEmbeddedIframe: boolean;
  canReplaceOriginalsDirectly: boolean;
}

export function detectFileSystemCapabilities(): FileSystemCapabilities {
  const win = window as unknown as {
    showOpenFilePicker?: unknown;
    showDirectoryPicker?: unknown;
  };
  const hasFilePickerApi =
    typeof win.showOpenFilePicker === 'function' &&
    typeof win.showDirectoryPicker === 'function';

  let isEmbeddedIframe = false;
  try {
    isEmbeddedIframe = window.self !== window.top;
  } catch {
    isEmbeddedIframe = true;
  }

  return {
    hasFilePickerApi,
    isEmbeddedIframe,
    canReplaceOriginalsDirectly: hasFilePickerApi && !isEmbeddedIframe,
  };
}

export async function pickFilesWithHandles(): Promise<{
  files: PickedAudioFile[];
  blockedBySecurity: boolean;
}> {
  const win = window as unknown as {
    showOpenFilePicker?: (opts?: Record<string, unknown>) => Promise<FileSystemFileHandle[]>;
  };

  if (typeof win.showOpenFilePicker !== 'function') {
    return { files: [], blockedBySecurity: true };
  }

  try {
    const handles = await win.showOpenFilePicker({
      multiple: true,
      excludeAcceptAllOption: false,
      types: [
        {
          description: 'Audio files (MP3, M4A, AAC, WAV, FLAC, OGG)',
          accept: {
            'audio/*': ['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.flac'],
          },
        },
      ],
    });
    const out: PickedAudioFile[] = [];
    for (const handle of handles) {
      const file = await handle.getFile();
      out.push({ file, fileHandle: handle });
    }
    return { files: out, blockedBySecurity: false };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { files: [], blockedBySecurity: false };
    }
    if (err instanceof DOMException && err.name === 'SecurityError') {
      return { files: [], blockedBySecurity: true };
    }
    throw err;
  }
}

export async function pickFolderWithHandles(): Promise<{
  files: PickedAudioFile[];
  dirHandle?: FileSystemDirectoryHandle;
  blockedBySecurity: boolean;
}> {
  const win = window as unknown as {
    showDirectoryPicker?: (opts?: Record<string, unknown>) => Promise<FileSystemDirectoryHandle>;
  };

  if (typeof win.showDirectoryPicker !== 'function') {
    return { files: [], blockedBySecurity: true };
  }

  try {
    const dirHandle = await win.showDirectoryPicker({ mode: 'readwrite' });
    const files: PickedAudioFile[] = [];
    const entries = (
      dirHandle as unknown as {
        values: () => AsyncIterable<FileSystemHandle>;
      }
    ).values();

    for await (const entry of entries) {
      if (entry.kind === 'file') {
        const fileHandle = entry as FileSystemFileHandle;
        const lower = fileHandle.name.toLowerCase();
        if (
          lower.endsWith('.mp3') ||
          lower.endsWith('.m4a') ||
          lower.endsWith('.aac') ||
          lower.endsWith('.wav') ||
          lower.endsWith('.ogg') ||
          lower.endsWith('.flac')
        ) {
          const file = await fileHandle.getFile();
          files.push({ file, fileHandle, parentDirHandle: dirHandle });
        }
      }
    }
    return { files, dirHandle, blockedBySecurity: false };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { files: [], blockedBySecurity: false };
    }
    if (err instanceof DOMException && err.name === 'SecurityError') {
      return { files: [], blockedBySecurity: true };
    }
    throw err;
  }
}

export async function extractDroppedAudioFiles(
  dataTransfer: DataTransfer
): Promise<PickedAudioFile[]> {
  // CRITICAL: Snapshot both DataTransfer.files AND getAsFileSystemHandle promises
  // synchronously BEFORE any `await`, because Chromium clears DataTransfer after the first yield.
  const syncFiles = Array.from(dataTransfer.files || []);
  const items = Array.from(dataTransfer.items || []);

  const handlePromises: Array<Promise<FileSystemFileHandle | null> | null> = items.map(
    (item) => {
      if (item.kind !== 'file') return null;
      const maybeGetHandle = (
        item as unknown as {
          getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>;
        }
      ).getAsFileSystemHandle;
      if (typeof maybeGetHandle !== 'function') return null;
      try {
        return maybeGetHandle
          .call(item)
          .then((h) => (h && h.kind === 'file' ? (h as FileSystemFileHandle) : null))
          .catch(() => null);
      } catch {
        return null;
      }
    }
  );

  const syncItemFiles: Array<File | null> = items.map((item) =>
    item.kind === 'file' ? item.getAsFile() : null
  );

  const resolvedHandles = await Promise.all(
    handlePromises.map((p) => p ?? Promise.resolve(null))
  );

  const results: PickedAudioFile[] = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].kind !== 'file') continue;
    const handle = resolvedHandles[i];
    if (handle) {
      try {
        const file = await handle.getFile();
        results.push({ file, fileHandle: handle });
        continue;
      } catch {
        // Fall through to synchronous File snapshot
      }
    }
    const f = syncItemFiles[i] ?? syncFiles[i];
    if (f) results.push({ file: f });
  }

  // Fallback if DataTransfer.items was empty but DataTransfer.files had entries
  if (results.length === 0 && syncFiles.length > 0) {
    for (const file of syncFiles) {
      results.push({ file });
    }
  }

  return results;
}

export async function writeFileInPlace(
  handle: FileSystemFileHandle,
  bytes: Uint8Array
): Promise<void> {
  const permHandle = handle as unknown as {
    requestPermission?: (opts: { mode: 'readwrite' }) => Promise<PermissionState>;
    createWritable: () => Promise<FileSystemWritableFileStream>;
  };

  if (typeof permHandle.requestPermission === 'function') {
    const state = await permHandle.requestPermission({ mode: 'readwrite' });
    if (state !== 'granted') {
      throw new Error('Write permission denied for original file.');
    }
  }

  const writable = await permHandle.createWritable();
  await writable.write(new Blob([new Uint8Array(bytes)]));
  await writable.close();
}

export async function writeSiblingFileInDir(
  dirHandle: FileSystemDirectoryHandle,
  fileName: string,
  bytes: Uint8Array
): Promise<void> {
  const targetHandle = await dirHandle.getFileHandle(fileName, { create: true });
  await writeFileInPlace(targetHandle, bytes);
}

const DB_NAME = 'gainbench_fs_handles';
const STORE_NAME = 'handles';
const OUTPUT_DIR_KEY = 'preferred_output_dir';

function openHandlesDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB'));
  });
}

export async function saveOutputDirHandle(
  handle: FileSystemDirectoryHandle
): Promise<void> {
  try {
    const db = await openHandlesDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(handle, OUTPUT_DIR_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Failed to save folder'));
    });
    db.close();
  } catch {
    // Ignore storage errors in restricted environments
  }
}

export async function loadSavedOutputDirHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openHandlesDb();
    const handle = await new Promise<FileSystemDirectoryHandle | null>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(OUTPUT_DIR_KEY);
      req.onsuccess = () =>
        resolve((req.result as FileSystemDirectoryHandle | undefined) ?? null);
      req.onerror = () => resolve(null);
    });
    db.close();
    return handle;
  } catch {
    return null;
  }
}

export async function clearSavedOutputDirHandle(): Promise<void> {
  try {
    const db = await openHandlesDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(OUTPUT_DIR_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  } catch {
    // Ignore
  }
}

export async function pickOutputDirectoryHandle(): Promise<{
  dirHandle?: FileSystemDirectoryHandle;
  blockedBySecurity: boolean;
}> {
  const win = window as unknown as {
    showDirectoryPicker?: (opts?: Record<string, unknown>) => Promise<FileSystemDirectoryHandle>;
  };

  if (typeof win.showDirectoryPicker !== 'function') {
    return { blockedBySecurity: true };
  }

  try {
    let dirHandle: FileSystemDirectoryHandle;
    try {
      dirHandle = await win.showDirectoryPicker({
        id: 'gainbench-output',
        startIn: 'music',
        mode: 'readwrite',
      });
    } catch (innerErr) {
      // If startIn: 'music' is rejected by a specific browser build, retry without startIn
      if (
        innerErr instanceof DOMException &&
        (innerErr.name === 'AbortError' || innerErr.name === 'SecurityError')
      ) {
        throw innerErr;
      }
      dirHandle = await win.showDirectoryPicker({ mode: 'readwrite' });
    }
    await saveOutputDirHandle(dirHandle);
    return { dirHandle, blockedBySecurity: false };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { blockedBySecurity: false };
    }
    if (err instanceof DOMException && err.name === 'SecurityError') {
      return { blockedBySecurity: true };
    }
    throw err;
  }
}

export async function ensureDirectoryWritePermission(
  dirHandle: FileSystemDirectoryHandle
): Promise<boolean> {
  const permHandle = dirHandle as unknown as {
    queryPermission?: (opts: { mode: 'readwrite' }) => Promise<PermissionState>;
    requestPermission?: (opts: { mode: 'readwrite' }) => Promise<PermissionState>;
  };
  try {
    if (typeof permHandle.queryPermission === 'function') {
      const current = await permHandle.queryPermission({ mode: 'readwrite' });
      if (current === 'granted') return true;
    }
    if (typeof permHandle.requestPermission === 'function') {
      const requested = await permHandle.requestPermission({ mode: 'readwrite' });
      return requested === 'granted';
    }
    return true;
  } catch {
    return false;
  }
}

export async function getOrCreateMusicNormalizedDir(
  rootDirHandle: FileSystemDirectoryHandle
): Promise<FileSystemDirectoryHandle> {
  if (rootDirHandle.name === 'music_normalized') {
    return rootDirHandle;
  }
  return rootDirHandle.getDirectoryHandle('music_normalized', { create: true });
}

export function triggerBrowserDownload(fileName: string, bytes: Uint8Array, mime = 'audio/mpeg'): void {
  const blob = new Blob([new Uint8Array(bytes)], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function downloadBatchAsZip(
  items: { fileName: string; bytes: Uint8Array }[],
  zipName = 'normalized_tracks.zip'
): Promise<void> {
  const zip = new JSZip();
  for (const item of items) {
    zip.file(item.fileName, item.bytes);
  }
  const content = await zip.generateAsync({ type: 'uint8array' });
  triggerBrowserDownload(zipName, content, 'application/zip');
}
