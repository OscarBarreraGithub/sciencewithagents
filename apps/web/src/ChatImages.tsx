import { useEffect, useId, useRef, useState } from 'react';
import { FileUp, FileText, RefreshCw, X } from 'lucide-react';
import {
  chatAttachmentCount,
  chatAttachmentLimit,
  chatFileByteLimit,
  chatFileIds,
  chatFileReference,
  chatFileSchema,
  chatImageIds,
  chatImageReference,
  withoutChatAttachments,
  withChatAttachmentText,
  type ChatFile,
} from '@dock/shared';
import { api, apiScope, apiUrl } from './api';
import { ImagePreview } from './ImagePreview';
import './chatImages.css';

async function png(file: File) {
  if (file.size > 20 * 1024 * 1024) throw new Error('Choose an image smaller than 20 MB.');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('This image could not be opened. Try a PNG or JPEG.'));
      image.src = url;
    });
    const scale = Math.min(1, 4096 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('The image could not be prepared. Try again.');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const result = canvas.toDataURL('image/png').split(',')[1]!;
    canvas.width = canvas.height = 0;
    if (!result || result.length > 11_184_812)
      throw new Error('This image is too large. Crop it or choose a smaller image.');
    return result;
  } finally {
    URL.revokeObjectURL(url);
  }
}
async function data(file: File) {
  if (!file.size || file.size > chatFileByteLimit)
    throw new Error('Choose a nonempty file under 8 MB.');
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]!);
    reader.onerror = () => reject(new Error('This file could not be read. Choose it again.'));
    reader.readAsDataURL(file);
  });
}
/** XHR exposes real upload progress while keeping the existing typed JSON route
 * and selected-computer/device authentication. Same-key retries are server-idempotent. */
function uploadFile(
  input: { key: string; name: string; data: string },
  progress: (percent: number) => void,
  signal: AbortSignal,
) {
  return new Promise<ChatFile>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    xhr.open('POST', apiUrl('/chat-files'));
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.responseType = 'json';
    xhr.timeout = 60_000;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) progress(Math.round((event.loaded / event.total) * 100));
    };
    const fail = () =>
      reject(
        new Error(
          'Upload interrupted. Your draft is kept; retry this file when the computer reconnects.',
        ),
      );
    xhr.onerror = fail;
    xhr.ontimeout = fail;
    xhr.onabort = fail;
    xhr.onloadend = () => signal.removeEventListener('abort', abort);
    xhr.onload = () => {
      if (xhr.status === 401) window.dispatchEvent(new Event('dock:authentication-required'));
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(
          new Error(
            typeof xhr.response?.error === 'string'
              ? xhr.response.error
              : 'Upload could not be confirmed. Retry the same file.',
          ),
        );
        return;
      }
      const parsed = chatFileSchema.safeParse(xhr.response);
      if (parsed.success) resolve(parsed.data);
      else reject(new Error('Upload could not be confirmed. Retry the same file.'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      fail();
      return;
    }
    xhr.send(JSON.stringify(input));
  });
}

type PendingUpload = {
  file: File;
  key: string;
  name: string;
  data?: string;
  uploaded?: ChatFile;
};
const isImage = (file: File) => /^image\/(?:png|jpeg|webp|gif|avif|bmp)$/i.test(file.type);

/** The batch belongs to the composer, including its Notepad view. A failure
 * pauses at that file; retries retain keys and already confirmed uploads. */
export function useChatAttachmentUpload({
  currentText,
  setText,
  maxLength,
  onBusy,
}: {
  currentText: () => string;
  setText: (text: string) => void;
  maxLength: number;
  onBusy: (busy: boolean) => void;
}) {
  const mounted = useRef(true),
    busyRef = useRef(false);
  const scope = useRef(apiScope()).current;
  const pending = useRef<PendingUpload[]>([]);
  const controller = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [progress, setProgress] = useState('');
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
      pending.current = [];
    };
  }, []);
  async function upload(files?: File[]) {
    if (busyRef.current) {
      if (files?.length)
        setError(
          'Another batch already owns this upload. Nothing from the new selection was uploaded. Choose those files again after the current batch finishes.',
        );
      return;
    }
    if (files) {
      if (!files.length) return;
      if (pending.current.length) {
        setError('Retry or discard the remaining selected files before choosing more.');
        return;
      }
      const available = chatAttachmentLimit - chatAttachmentCount(currentText());
      if (files.length > available) {
        setError(
          `You selected ${files.length} files, but this message has room for ${available}. Nothing from this selection was uploaded. Choose up to ${available} files, or remove attached files first.`,
        );
        return;
      }
      // Reject the whole selection before starting when a size is known to be invalid.
      const invalid = files.find(
        (file) => !file.size || file.size > (isImage(file) ? 20 * 1024 * 1024 : chatFileByteLimit),
      );
      if (invalid) {
        setError(
          `${invalid.name}: ${isImage(invalid) && invalid.size ? 'Choose an image smaller than 20 MB.' : 'Choose a nonempty file under 8 MB.'} Nothing from this selection was uploaded. Choose the files again.`,
        );
        return;
      }
      pending.current = files.map((file) => ({
        file,
        key: crypto.randomUUID(),
        name: isImage(file) ? file.name.replace(/\.[^/.]+$/, '') + '.png' : file.name,
      }));
    }
    if (!pending.current.length) return;
    busyRef.current = true;
    setBusy(true);
    onBusy(true);
    setError('');
    try {
      while (pending.current.length && mounted.current) {
        if (apiScope() !== scope)
          throw new Error('The selected computer changed. Reopen the original computer to retry.');
        if (chatAttachmentCount(currentText()) >= chatAttachmentLimit)
          throw new Error('Remove an attached file before retrying (four per message).');
        const item = pending.current[0]!;
        if (!item.data && !item.uploaded) {
          setProgress(`Preparing ${item.file.name} · ${pending.current.length} remaining…`);
          item.data = isImage(item.file) ? await png(item.file) : await data(item.file);
        }
        if (!mounted.current) return;
        if (!item.uploaded) {
          controller.current = new AbortController();
          setProgress(`Uploading ${item.name} · 0% · ${pending.current.length} remaining`);
          item.uploaded = await uploadFile(
            { key: item.key, name: item.name, data: item.data! },
            (value) => {
              if (mounted.current)
                setProgress(
                  value === 100
                    ? `Saving ${item.name}…`
                    : `Uploading ${item.name} · ${value}% · ${pending.current.length} remaining`,
                );
            },
            controller.current.signal,
          );
        }
        if (!mounted.current) return;
        if (apiScope() !== scope)
          throw new Error('The selected computer changed. Reopen the original computer to retry.');
        // Read at the moment of attachment, never from the selection-time draft.
        const current = currentText();
        if (!chatFileIds(current).includes(item.uploaded.id)) {
          if (chatAttachmentCount(current) >= chatAttachmentLimit)
            throw new Error('Remove an attached file before retrying (four per message).');
          const next = current + (current ? '\n\n' : '') + chatFileReference(item.uploaded.id);
          if (next.length > maxLength)
            throw new Error('Shorten your message slightly, then retry adding this file.');
          setText(next);
        }
        pending.current.shift();
      }
    } catch (e) {
      if (mounted.current) {
        const name = pending.current[0]?.file.name;
        setError(
          `${name ? name + ': ' : ''}${(e as Error).message} Remaining: ${pending.current.map((item) => item.file.name).join(', ')}. Retry upload resumes these files.`,
        );
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) {
        setBusy(false);
        onBusy(pending.current.length > 0);
        setProgress('');
      }
    }
  }
  const discard = () => {
    if (busyRef.current) return;
    pending.current = [];
    onBusy(false);
    setError('');
  };
  return { busy, error, progress, canRetry: !!pending.current.length, upload, discard };
}
type UploadState = ReturnType<typeof useChatAttachmentUpload>;
const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.ceil(bytes / 1024)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const typeLabel = (file: ChatFile) =>
  ({
    'image/png': 'PNG image',
    'application/pdf': 'PDF',
    'text/plain': 'Text',
    'application/octet-stream': 'File',
  })[file.mimeType];

export function ChatFileCard({
  id,
  remove,
  disabled,
}: {
  id: string;
  remove?: () => void;
  disabled?: boolean;
}) {
  const [file, setFile] = useState<ChatFile | null>(null),
    [error, setError] = useState(''),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void api(`/chat-files/${id}/info`, undefined, controller.signal)
      .then((raw) => {
        if (!controller.signal.aborted) setFile(chatFileSchema.parse(raw));
      })
      .catch(() => {
        if (!controller.signal.aborted) setError('File details unavailable.');
      });
    return () => controller.abort();
  }, [id, retry]);
  return (
    <span className="chat-file-card">
      {file?.image ? (
        <ImagePreview
          src={apiUrl(`/chat-files/${id}/preview`)}
          alt={`Attached image ${file.name}`}
          label={`Open image ${file.name}`}
        />
      ) : (
        <FileText size={28} aria-hidden="true" />
      )}
      <span className="chat-file-details">
        <a href={apiUrl(`/chat-files/${id}`)} download={file?.name} title={file?.name}>
          {file?.name ?? 'Attached file'}
        </a>
        <small>
          {file
            ? `${typeLabel(file)} · ${size(file.size)}`
            : error
              ? 'Details unavailable'
              : 'Loading file details…'}
        </small>
        {error && (
          <span role="alert">
            {error}{' '}
            <button type="button" onClick={() => setRetry((value) => value + 1)}>
              Retry details
            </button>
          </span>
        )}
      </span>
      {remove && (
        <button
          type="button"
          aria-label={`Remove ${file?.name ?? 'file'}`}
          disabled={disabled}
          onClick={remove}
        >
          <X size={16} />
        </button>
      )}
    </span>
  );
}

export function ChatAttachmentPicker({
  text,
  currentText,
  setText,
  disabled,
  uploadDisabled,
  uploader,
}: {
  text: string;
  currentText: () => string;
  setText: (text: string) => void;
  disabled?: boolean;
  uploadDisabled?: boolean;
  uploader: UploadState;
}) {
  const input = useRef<HTMLInputElement>(null);
  const limitId = useId();
  const files = chatFileIds(text),
    images = chatImageIds(text);
  const attached = files.length + images.length;
  const remove = (id: string) => {
    const current = currentText();
    const refs = [
      ...chatImageIds(current)
        .filter((value) => value !== id)
        .map(chatImageReference),
      ...chatFileIds(current)
        .filter((value) => value !== id)
        .map(chatFileReference),
    ].join('\n\n');
    setText(withChatAttachmentText(refs, withoutChatAttachments(current)));
  };
  return (
    <div className="chat-image-picker">
      <button
        type="button"
        className="chat-image-button"
        aria-label="Attach files"
        aria-describedby={limitId}
        title="Up to four files, 8 MB each"
        disabled={
          disabled ||
          uploadDisabled ||
          uploader.busy ||
          uploader.canRetry ||
          attached >= chatAttachmentLimit
        }
        onClick={() => input.current?.click()}
      >
        {uploader.busy ? (
          <RefreshCw className="spin" size={18} aria-hidden="true" />
        ) : (
          <FileUp size={18} aria-hidden="true" />
        )}
        <span>Attach files</span>
      </button>
      {/* Read with the button and chooser; shown beside attached files instead of always. */}
      <span id={limitId} hidden>
        Up to four files per message, 8 MB each.
      </span>
      <input
        ref={input}
        type="file"
        multiple
        aria-label="Choose files"
        aria-describedby={limitId}
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (files.length && !disabled && !uploadDisabled) void uploader.upload(files);
        }}
      />
      {!!attached && (
        <div className="chat-image-previews" aria-label="Attached files" tabIndex={0}>
          <small className="chat-upload-limit">
            {attached} {attached === 1 ? 'file' : 'files'} attached · up to {chatAttachmentLimit}, 8
            MB each
          </small>
          {files.map((id) => (
            <ChatFileCard
              key={id}
              id={id}
              remove={() => remove(id)}
              disabled={disabled || uploader.busy}
            />
          ))}
          {images.map((id, index) => (
            <div key={id} className="chat-legacy-image">
              <ImagePreview
                src={apiUrl(`/chat-images/${id}`)}
                alt={`Attached screenshot ${index + 1}`}
              />
              <button
                type="button"
                aria-label={`Remove screenshot ${index + 1}`}
                disabled={disabled || uploader.busy}
                onClick={() => remove(id)}
              >
                <X size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
      {uploader.busy && (
        <div className="chat-image-error" role="status">
          {uploader.progress}
        </div>
      )}
      {uploader.error && (
        <div role="alert" className="chat-image-error">
          {uploader.error}
          {uploader.canRetry && (
            <span className="chat-upload-actions">
              <button
                type="button"
                className="chat-image-button"
                disabled={disabled || uploadDisabled || uploader.busy}
                onClick={() => void uploader.upload()}
              >
                Retry upload
              </button>
              <button
                type="button"
                className="chat-image-button"
                disabled={uploader.busy}
                onClick={uploader.discard}
              >
                Discard remaining uploads
              </button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
