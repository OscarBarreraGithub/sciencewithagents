/** Keep the blob alive while the browser starts its asynchronous download. */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    // Match retained browser exports: finite retention, without same-click revocation.
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}
