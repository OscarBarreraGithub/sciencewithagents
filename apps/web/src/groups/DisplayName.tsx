/** Escape only unsafe display controls; retained names and source evidence stay untouched.
 * ZWJ/ZWNJ, accents and ordinary RTL letters remain intact. */
export function displayNameText(value: string): string {
  return value.replace(
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu,
    (character) => `⟦U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟧`,
  );
}
export function DisplayName({ value }: { value: string }) {
  return (
    <bdi className="groups-name" dir="auto">
      {displayNameText(value)}
    </bdi>
  );
}
