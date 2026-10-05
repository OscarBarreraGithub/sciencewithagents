import { useEffect, useRef, useState } from 'react';
import { ImagePlus, X } from 'lucide-react';
import {
  chatImageIds,
  chatImageReference,
  chatImageSchema,
  withoutChatImages,
  withChatImageText,
} from '@dock/shared';
import { api, apiUrl } from './api';
import './chatImages.css';

async function png(file: File) {
  if (file.size > 20 * 1024 * 1024) throw new Error('Choose an image smaller than 20 MB.');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () =>
        reject(new Error('This image could not be opened. Try a PNG or JPEG screenshot.'));
      image.src = url;
    });
    const scale = Math.min(1, 4096 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('The image could not be prepared. Try again.');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    // Browser decoding handles orientation and strips photo metadata. Store one portable format.
    const result = canvas.toDataURL('image/png').split(',')[1]!;
    canvas.width = canvas.height = 0;
    if (!result || result.length > 11_184_812)
      throw new Error('This image is too large. Crop it or choose a smaller screenshot.');
    return result;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function ChatImagePicker({
  text,
  currentText,
  setText,
  disabled,
  maxLength,
  onBusy,
}: {
  text: string;
  currentText: () => string;
  setText: (text: string) => void;
  disabled?: boolean;
  maxLength: number;
  onBusy: (busy: boolean) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const pending = useRef<{ key: string; png: string } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const ids = chatImageIds(text);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function upload(file?: File) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    onBusy(true);
    setError('');
    try {
      if (chatImageIds(currentText()).length >= 4)
        throw new Error('Send these screenshots before attaching more (four per message).');
      if (file) {
        pending.current = null;
        pending.current = { key: crypto.randomUUID(), png: await png(file) };
      }
      if (!pending.current || !mounted.current) return;
      const uploaded = chatImageSchema.parse(
        await api('/chat-images', pending.current, undefined, 60_000),
      );
      if (!mounted.current) return;
      const value = currentText();
      const next = value + (value ? '\n\n' : '') + chatImageReference(uploaded.id);
      if (next.length > maxLength)
        throw new Error('Shorten your message slightly, then retry adding this screenshot.');
      setText(next);
      pending.current = null;
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      busyRef.current = false;
      if (mounted.current) {
        setBusy(false);
        onBusy(false);
      }
    }
  }
  return (
    <div className="chat-image-picker">
      <button
        type="button"
        className="chat-image-button"
        disabled={disabled || busy || ids.length >= 4}
        onClick={() => fileInput.current?.click()}
      >
        <ImagePlus size={18} />
        <span>{busy ? 'Uploading…' : 'Attach screenshot'}</span>
      </button>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        aria-label="Choose screenshot"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void upload(file);
        }}
      />
      {!!ids.length && (
        <div className="chat-image-previews" aria-label="Attached screenshots">
          {ids.map((id, index) => (
            <div key={id}>
              <a href={apiUrl(`/chat-images/${id}`)} target="_blank" rel="noreferrer">
                <img src={apiUrl(`/chat-images/${id}`)} alt={`Attached screenshot ${index + 1}`} />
              </a>
              <button
                type="button"
                aria-label={`Remove screenshot ${index + 1}`}
                disabled={disabled || busy}
                onClick={() => {
                  const current = currentText();
                  setText(
                    withChatImageText(
                      chatImageIds(current)
                        .filter((image) => image !== id)
                        .map(chatImageReference)
                        .join('\n\n'),
                      withoutChatImages(current),
                    ),
                  );
                }}
              >
                <X size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
      {error && (
        <div role="alert" className="chat-image-error">
          {error}
          {pending.current && (
            <button type="button" disabled={disabled || busy} onClick={() => void upload()}>
              Retry upload
            </button>
          )}
        </div>
      )}
    </div>
  );
}
